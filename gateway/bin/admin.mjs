#!/usr/bin/env node
// Administración del gateway. Corre en la máquina de un operador de Biguá con DATABASE_URL
// y MAILGW_ENC_KEYS en el entorno (las mismas que en Vercel). No hay endpoints HTTP de
// administración propios: el panel web /admin (src/admin) hace lo mismo con usuarios y roles;
// esta herramienta queda para migrar, rotar claves y crear el primer operador.
//
// La contraseña de un buzón se lee de la entrada estándar, nunca de un argumento ni de una
// variable de entorno: así no queda en el historial de la terminal ni en la lista de
// procesos.
//
//   node bin/admin.mjs migrate
//   node bin/admin.mjs add-client <cliente> "<nombre>"
//   node bin/admin.mjs add-token <cliente> "<nombre>" [--scopes read,draft,send,manage] [--days 365]
//   node bin/admin.mjs list-tokens <cliente>
//   node bin/admin.mjs revoke-token <token_id>
//   node bin/admin.mjs add-account <cliente> <email> --imap-host H [--imap-port 993] [--imap-security tls]
//        --smtp-host H [--smtp-port 465] [--smtp-security tls] [--username U] [--display-name "N"]
//        [--daily-cap 40] [--timezone America/Argentina/Buenos_Aires] [--no-append-sent]
//        [--sent-folder F] [--drafts-folder F]                         (contraseña por stdin)
//   node bin/admin.mjs set-password <cliente> <email>                  (contraseña por stdin)
//   node bin/admin.mjs check <cliente> <email>
//   node bin/admin.mjs list <cliente>
//   node bin/admin.mjs pause|reactivate <cliente> <email>
//   node bin/admin.mjs clear-send <cliente> <email> <clave_de_idempotencia>
//   node bin/admin.mjs rekey
//   node bin/admin.mjs playbooks-publicar --version <v> [--canal canario|estable] [--notas "…"]
//        publica playbooks/ (en la raíz del repo) como una versión nueva e inmutable
//   node bin/admin.mjs playbooks-sql --version <v> [--canal …] [--notas "…"]
//        lo mismo, pero imprime el SQL (para aplicarlo en producción por el MCP de Supabase)
//   node bin/admin.mjs playbooks-canal <canario|estable> <version>
//   node bin/admin.mjs sdr-config <cliente>                 (JSON por stdin: ajustes, canal, bots_activos,
//        zona_horaria, calibracion_mails, version_fija)
//   node bin/admin.mjs sdr-despertador <cliente> <bot> --url https://… [--desde 8] [--hasta 20]
//        [--dias 1,2,3,4,5] [--espera 10]                     (clave del webhook de la routine por stdin)
//   node bin/admin.mjs sdr-despertador <cliente> <bot> --apagar
//   node bin/admin.mjs reloj-secreto        genera el secreto de POST /cron/correo, guarda su hash e imprime
//        el secreto UNA vez (en producción se genera en Supabase: docs/14)
//   node bin/admin.mjs reloj-tick           una vuelta del reloj desde la terminal (lee buzones y despierta)
//   node bin/admin.mjs add-admin <email> "<nombre>" [--client <cliente>] [--base-url https://sdrbot.bigua.lat]
//        sin --client crea un operador de Biguá; con --client, un usuario de ese cliente.
//        Imprime un enlace de activación de un solo uso (24 h) para elegir la contraseña.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as store from '../src/store.mjs';
import { aadFor, decryptSecret, encryptSecret, keyIdOf, newToken } from '../src/crypto.mjs';
import { keys } from '../src/config.mjs';
import { withImap, listFolders } from '../src/mail/imap.mjs';
import { verifySmtp } from '../src/mail/smtp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCOPES = ['read', 'draft', 'send', 'manage', 'sdr'];

function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

async function readPassword() {
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const pw = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
    if (!pw) die('La contraseña llegó vacía por stdin.');
    return pw;
  }
  // Terminal interactiva: se pide sin mostrarla.
  process.stdout.write('Contraseña del buzón: ');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  rl._writeToOutput = () => {};
  const pw = await new Promise((resolve) => rl.question('', resolve));
  rl.close();
  process.stdout.write('\n');
  if (!pw) die('Contraseña vacía.');
  return pw;
}

const DEFAULT_PORTS = { tls: { imap: 993, smtp: 465 }, starttls: { imap: 143, smtp: 587 } };

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values: o, positionals: p } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      scopes: { type: 'string' }, days: { type: 'string' },
      'imap-host': { type: 'string' }, 'imap-port': { type: 'string' }, 'imap-security': { type: 'string' },
      'smtp-host': { type: 'string' }, 'smtp-port': { type: 'string' }, 'smtp-security': { type: 'string' },
      username: { type: 'string' }, 'display-name': { type: 'string' }, 'daily-cap': { type: 'string' },
      timezone: { type: 'string' }, 'no-append-sent': { type: 'boolean' },
      'sent-folder': { type: 'string' }, 'drafts-folder': { type: 'string' },
      client: { type: 'string' }, 'base-url': { type: 'string' },
      version: { type: 'string' }, canal: { type: 'string' }, notas: { type: 'string' },
      url: { type: 'string' }, desde: { type: 'string' }, hasta: { type: 'string' }, dias: { type: 'string' },
      espera: { type: 'string' }, apagar: { type: 'boolean' },
    },
  });

  switch (cmd) {
    case 'migrate': {
      const dir = path.join(here, '..', 'db', 'migrations');
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
        .map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name), 'utf8') }));
      const applied = await store.migrate(files);
      console.log(applied.length ? `Aplicadas: ${applied.join(', ')}` : 'Nada para aplicar.');
      break;
    }
    case 'add-client': {
      const [id, name] = p;
      if (!id || !name) die('Uso: add-client <cliente> "<nombre>"');
      await store.upsertClient(id, name);
      console.log(`Cliente ${id} listo.`);
      break;
    }
    case 'add-token': {
      const [clientId, name] = p;
      if (!clientId || !name) die('Uso: add-token <cliente> "<nombre>" [--scopes read,send] [--days 365]');
      const scopes = (o.scopes ?? 'read').split(',').map((s) => s.trim()).filter(Boolean);
      for (const s of scopes) if (!SCOPES.includes(s)) die(`Permiso desconocido: ${s}. Válidos: ${SCOPES.join(', ')}`);
      const days = Number(o.days ?? 365);
      const expires = days > 0 ? new Date(Date.now() + days * 86_400_000) : null;
      const { token, hash } = newToken();
      const id = await store.createToken(clientId, name, hash, scopes, expires);
      console.log(`Token ${id} (${scopes.join(', ')}), vence ${expires ? expires.toISOString().slice(0, 10) : 'nunca'}.`);
      console.log('Se muestra UNA sola vez; la base guarda sólo el hash. Cargarlo como secreto de la cuenta de Grok Bot:');
      console.log(token);
      break;
    }
    case 'list-tokens': {
      if (!p[0]) die('Uso: list-tokens <cliente>');
      console.table(await store.listTokens(p[0]));
      break;
    }
    case 'revoke-token': {
      if (!p[0]) die('Uso: revoke-token <token_id>');
      console.log((await store.revokeToken(p[0])) ? 'Revocado.' : 'No había un token activo con ese id.');
      break;
    }
    case 'add-account': {
      const [clientId, emailRaw] = p;
      if (!clientId || !emailRaw) die('Uso: add-account <cliente> <email> --imap-host H --smtp-host H ...');
      const email = emailRaw.toLowerCase();
      const imapSec = o['imap-security'] ?? 'tls';
      const smtpSec = o['smtp-security'] ?? 'tls';
      for (const s of [imapSec, smtpSec]) if (!['tls', 'starttls'].includes(s)) die(`Seguridad inválida: ${s} (tls o starttls).`);
      if (!o['imap-host'] || !o['smtp-host']) die('Faltan --imap-host y --smtp-host.');
      const password = await readPassword();
      const id = await store.upsertAccount({
        client_id: clientId, email, display_name: o['display-name'], username: o.username ?? email,
        secret_enc: encryptSecret(password, aadFor(clientId, email)),
        imap_host: o['imap-host'], imap_port: Number(o['imap-port'] ?? DEFAULT_PORTS[imapSec].imap), imap_security: imapSec,
        smtp_host: o['smtp-host'], smtp_port: Number(o['smtp-port'] ?? DEFAULT_PORTS[smtpSec].smtp), smtp_security: smtpSec,
        timezone: o.timezone ?? 'America/Argentina/Buenos_Aires', daily_send_cap: Number(o['daily-cap'] ?? 40),
        append_sent: !o['no-append-sent'], sent_folder: o['sent-folder'], drafts_folder: o['drafts-folder'],
      });
      console.log(`Buzón ${email} guardado (${id}). Probarlo con: check ${clientId} ${email}`);
      break;
    }
    case 'set-password': {
      const [clientId, email] = p;
      if (!clientId || !email) die('Uso: set-password <cliente> <email>');
      const password = await readPassword();
      const ok = await store.setSecret(clientId, email, encryptSecret(password, aadFor(clientId, email.toLowerCase())));
      console.log(ok ? 'Contraseña actualizada y buzón reactivado.' : 'No existe ese buzón.');
      break;
    }
    case 'check': {
      const [clientId, email] = p;
      if (!clientId || !email) die('Uso: check <cliente> <email>');
      const a = await store.getAccount(clientId, email);
      if (!a) die('No existe ese buzón.');
      const pw = decryptSecret(a.secret_enc, aadFor(a.client_id, a.email));
      const folders = await withImap(a, pw, (c) => listFolders(c));
      console.log(`IMAP ok: ${folders.length} carpetas.`);
      console.table(folders.map((f) => ({ path: f.path, uso: f.special_use, mensajes: f.messages, no_leidos: f.unseen })));
      await verifySmtp(a, pw);
      console.log('SMTP ok: usuario y contraseña aceptados.');
      await store.recordAuth(a, true);
      break;
    }
    case 'list': {
      if (!p[0]) die('Uso: list <cliente>');
      const rows = await store.listAccounts(p[0]);
      console.table(rows.map((a) => ({ email: a.email, estado: a.status, fallas: a.auth_failures, cupo: a.daily_send_cap,
        imap: `${a.imap_host}:${a.imap_port}`, smtp: `${a.smtp_host}:${a.smtp_port}`, ultimo_ok: a.last_ok_at, error: a.last_error })));
      break;
    }
    case 'pause':
    case 'reactivate': {
      const [clientId, email] = p;
      if (!clientId || !email) die(`Uso: ${cmd} <cliente> <email>`);
      const ok = await store.setStatus(clientId, email, cmd === 'pause' ? 'paused' : 'active');
      console.log(ok ? (cmd === 'pause' ? 'Pausado.' : 'Reactivado.') : 'No existe ese buzón.');
      break;
    }
    case 'clear-send': {
      const [clientId, email, key] = p;
      if (!clientId || !email || !key) die('Uso: clear-send <cliente> <email> <clave_de_idempotencia>');
      const ok = await store.clearReservation(clientId, email, key);
      console.log(ok ? 'Reserva liberada: un reintento con esa clave vuelve a enviar.' : 'No había un envío cortado con esa clave.');
      break;
    }
    case 'rekey': {
      // Recifra con la clave actual (la primera de MAILGW_ENC_KEYS) todo lo cifrado con otra.
      const current = keys().current[0];
      let n = 0;
      for (const r of await store.allSecrets()) {
        if (keyIdOf(r.secret_enc) === current) continue;
        const aad = aadFor(r.client_id, r.email);
        await store.setSecretById(r.id, encryptSecret(decryptSecret(r.secret_enc, aad), aad));
        n += 1;
      }
      const correo = await import('../src/sdr/correo.mjs');
      for (const d of await correo.clavesDespertador()) {
        if (keyIdOf(d.clave_enc) === current) continue;
        const aad = correo.aadDespertador(d.client_id, d.bot);
        await correo.setClaveDespertador(d.client_id, d.bot, encryptSecret(decryptSecret(d.clave_enc, aad), aad));
        n += 1;
      }
      const dripify = await import('../src/sdr/dripify.mjs');
      for (const d of await dripify.claves()) {
        if (keyIdOf(d.api_key_enc) === current) continue;
        const aad = dripify.aadDripify(d.client_id);
        await dripify.setClave(d.client_id, encryptSecret(decryptSecret(d.api_key_enc, aad), aad));
        n += 1;
      }
      const crm = await import('../src/sdr/crm.mjs');
      for (const d of await crm.claves()) {
        if (keyIdOf(d.token_enc) === current) continue;
        const aad = crm.aadCrm(d.client_id);
        await crm.setClave(d.client_id, encryptSecret(decryptSecret(d.token_enc, aad), aad));
        n += 1;
      }
      console.log(`Recifrados: ${n}. Ya se puede sacar la clave vieja de MAILGW_ENC_KEYS.`);
      break;
    }
    case 'playbooks-publicar':
    case 'playbooks-sql': {
      if (!o.version) die('Falta --version (por ejemplo 2026.11.04-1).');
      if (o.canal && !['canario', 'estable'].includes(o.canal)) die('--canal es canario o estable.');
      const { cargarPlaybooks, sqlPublicacion } = await import('../src/sdr/playbooks.mjs');
      const pb = cargarPlaybooks(path.join(here, '..', '..', 'playbooks'));
      if (cmd === 'playbooks-sql') {
        console.log(sqlPublicacion({ version: o.version, notas: o.notas, canal: o.canal }, pb));
        break;
      }
      const sdr = await import('../src/sdr/store.mjs');
      const r = await sdr.publicar({ version: o.version, notas: o.notas, ...pb });
      console.log(`Versión ${r.version} publicada: ${r.secciones} secciones, ${r.rutinas} routines.`);
      if (o.canal) {
        await sdr.moverCanal(o.canal, o.version);
        console.log(`Canal ${o.canal} → ${o.version}.`);
      }
      break;
    }
    case 'playbooks-canal': {
      const [canal, version] = p;
      if (!['canario', 'estable'].includes(canal) || !version) die('Uso: playbooks-canal <canario|estable> <version>');
      const sdr = await import('../src/sdr/store.mjs');
      await sdr.moverCanal(canal, version);
      console.log(`Canal ${canal} → ${version}.`);
      break;
    }
    case 'sdr-despertador': {
      const [clientId, bot] = p;
      if (!clientId || !bot) die('Uso: sdr-despertador <cliente> <bot> --url https://… (clave por stdin) | --apagar');
      const correo = await import('../src/sdr/correo.mjs');
      if (o.apagar) {
        const r = await correo.configurarDespertador(clientId, bot, { apagar: true });
        console.log(r.apagado ? `Despertador de ${clientId}/${bot} apagado.` : 'No había despertador.');
        break;
      }
      const num = (v) => (v === undefined ? undefined : Number(v));
      const clave = await readPassword();
      const r = await correo.configurarDespertador(clientId, bot, {
        url: o.url, clave, hora_desde: num(o.desde), hora_hasta: num(o.hasta), espera_min: num(o.espera),
        dias: o.dias ? o.dias.split(',').map(Number) : undefined,
      });
      console.log(`Despertador de ${r.client_id}/${r.bot} → ${r.url}.`);
      break;
    }
    case 'reloj-secreto': {
      const correo = await import('../src/sdr/correo.mjs');
      const { token, hash } = newToken();
      await correo.setSecretoReloj(hash);
      console.log('Secreto del reloj (se muestra UNA vez; la base guarda sólo el hash):');
      console.log(token);
      break;
    }
    case 'reloj-tick': {
      const correo = await import('../src/sdr/correo.mjs');
      console.log(JSON.stringify(await correo.tick(), null, 2));
      break;
    }
    case 'sdr-config': {
      const [clientId] = p;
      if (!clientId) die('Uso: sdr-config <cliente> < config.json');
      const raw = await new Promise((resolve) => {
        let d = '';
        process.stdin.on('data', (c) => { d += c; });
        process.stdin.on('end', () => resolve(d));
      });
      let cfg;
      try { cfg = JSON.parse(raw); } catch { die('El stdin no es JSON válido.'); }
      const sdr = await import('../src/sdr/store.mjs');
      const r = await sdr.setConfig(clientId, cfg);
      console.log(`Configuración de ${clientId}: canal ${r.canal}, bots ${r.bots_activos.join(', ')}, calibración ${r.calibracion_mails}.`);
      break;
    }
    case 'add-admin': {
      const [email, name] = p;
      if (!email || !name) die('Uso: add-admin <email> "<nombre>" [--client <cliente>]');
      const { createUser } = await import('../src/admin/auth.mjs');
      const { user, setupToken } = await createUser({
        email, name, role: o.client ? 'client_admin' : 'bigua_admin', clientId: o.client ?? null,
      });
      const base = (o['base-url'] ?? 'https://sdrbot.bigua.lat').replace(/\/+$/, '');
      console.log(`Usuario ${user.email} (${user.role}${user.client_id ? ` de ${user.client_id}` : ''}) creado.`);
      console.log('Enlace de activación (una sola vez, vence en 24 h; mandarlo por un canal seguro):');
      console.log(`${base}/admin#activar=${setupToken}`);
      break;
    }
    default:
      console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n'));
      process.exitCode = cmd ? 1 : 0;
  }
}

main()
  .catch((e) => { console.error(`Error: ${e.code ? `[${e.code}] ` : ''}${e.message}`); process.exitCode = 1; })
  .finally(() => store.closePool());
