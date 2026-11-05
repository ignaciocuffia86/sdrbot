// Panel /admin de punta a punta: activación, ingreso, bloqueo, CSRF, y que un usuario de un
// cliente no pueda ver ni tocar nada de otro cliente. Los buzones se prueban contra el
// Dovecot y el SMTP de prueba.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import * as store from '../src/store.mjs';
import { startServer } from '../src/server.mjs';
import { createUser } from '../src/admin/auth.mjs';
import { startSmtp, gw, runCli, HOST, PORTS, USERS } from './helpers.mjs';

let server, smtp, base;
const ANA = 'ana@cliente.test';
const BETO = 'beto@cliente.test';
const PW = { bigua: 'operador-bigua-largo-1', cliente: 'usuario-cliente-largo-2' };

// Un navegador mínimo: guarda la cookie de sesión y manda la cabecera del panel.
function browser() {
  let cookie = null;
  return {
    get cookie() { return cookie; },
    async call(method, path, body, { headers = {}, panelHeader = true } = {}) {
      const res = await fetch(`${base}/admin/api${path}`, {
        method,
        headers: {
          ...(panelHeader ? { 'x-mailgw-admin': '1' } : {}),
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0].endsWith('=') ? null : set.split(';')[0];
      return { status: res.status, body: await res.json(), headers: res.headers };
    },
  };
}

const tokenFromLink = (out) => /#activar=([A-Za-z0-9_-]+)/.exec(out)[1];

async function activateAndLogin(token, email, password) {
  const b = browser();
  const act = await b.call('POST', '/activate', { token, password });
  assert.equal(act.status, 200, JSON.stringify(act.body));
  const r = await b.call('POST', '/login', { email, password });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return b;
}

const mailboxBody = (email, password, { starttls = false } = {}) => ({
  email, password, display_name: 'Prueba',
  imap_host: HOST, imap_port: starttls ? PORTS.imap : PORTS.imaps, imap_security: starttls ? 'starttls' : 'tls',
  smtp_host: HOST, smtp_port: starttls ? PORTS.submission : PORTS.smtps, smtp_security: starttls ? 'starttls' : 'tls',
});

const ctx = {};

before(async () => {
  smtp = await startSmtp();
  server = await startServer(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await smtp.close();
  await store.closePool();
});

// ---------------------------------------------------------------- páginas

test('el panel se sirve con cabeceras estrictas', async () => {
  const res = await fetch(`${base}/admin`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(await res.text(), /<script src="\/admin\/app.js"/);
  for (const [p, type] of [['/admin/app.js', /javascript/], ['/admin/app.css', /css/], ['/admin/', /html/]]) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), type);
  }
  assert.equal((await fetch(`${base}/admin/otra-cosa.js`)).status, 404);
});

// ---------------------------------------------------------------- alta del primer operador

test('add-admin crea un operador con enlace de un solo uso; la contraseña corta no sirve', async () => {
  const out = await runCli(['add-admin', 'Operador@Bigua.test', 'Operador', '--base-url', base]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, new RegExp(`${base}/admin#activar=`));
  const token = tokenFromLink(out.stdout);

  const b = browser();
  const corta = await b.call('POST', '/activate', { token, password: 'corta' });
  assert.equal(corta.status, 400);

  ctx.bigua = await activateAndLogin(token, 'operador@bigua.test', PW.bigua);
  const again = await browser().call('POST', '/activate', { token, password: 'otra-clave-larga-3' });
  assert.equal(again.status, 401, 'el enlace no sirve dos veces');

  const me = await ctx.bigua.call('GET', '/me');
  assert.equal(me.body.data.me.role, 'bigua_admin');
  assert.equal(me.body.data.me.password_hash, undefined);
});

test('la cookie de sesión es HttpOnly, SameSite=Strict, Secure y sólo para /admin', async () => {
  const b = browser();
  const r = await b.call('POST', '/login', { email: 'operador@bigua.test', password: PW.bigua });
  const set = r.headers.get('set-cookie');
  for (const part of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/admin']) assert.ok(set.includes(part), part);
});

test('sin la cabecera del panel o desde otro origen, nada responde', async () => {
  const sin = await ctx.bigua.call('GET', '/me', null, { panelHeader: false });
  assert.equal(sin.status, 403);
  const otro = await ctx.bigua.call('GET', '/me', null, { headers: { origin: 'https://malicioso.example' } });
  assert.equal(otro.status, 403);
  const roto = await ctx.bigua.call('GET', '/me', null, { headers: { origin: 'null' } });
  assert.equal(roto.status, 403);
  const anon = await browser().call('GET', '/clients');
  assert.equal(anon.status, 401);
});

// ---------------------------------------------------------------- clientes y buzones

test('Biguá crea clientes y carga buzones; la contraseña nunca vuelve', async () => {
  for (const [id, name] of [['adm-a', 'Cliente A'], ['adm-b', 'Cliente B']]) {
    const r = await ctx.bigua.call('POST', '/clients', { id, name });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const dup = await ctx.bigua.call('POST', '/clients', { id: 'adm-a', name: 'otra vez' });
  assert.equal(dup.status, 409);
  const malId = await ctx.bigua.call('POST', '/clients', { id: 'Con Espacios', name: 'x' });
  assert.equal(malId.status, 400);

  const a = await ctx.bigua.call('POST', '/clients/adm-a/mailboxes', mailboxBody(ANA, USERS[ANA]));
  assert.equal(a.status, 200, JSON.stringify(a.body));
  assert.equal(a.body.data.mailbox.email, ANA);
  assert.equal(a.body.data.mailbox.timezone, 'America/Argentina/Buenos_Aires');
  assert.equal(a.body.data.mailbox.daily_send_cap, 40);
  const b = await ctx.bigua.call('POST', '/clients/adm-b/mailboxes', mailboxBody(BETO, USERS[BETO], { starttls: true }));
  assert.equal(b.status, 200, JSON.stringify(b.body));

  const dup2 = await ctx.bigua.call('POST', '/clients/adm-a/mailboxes', mailboxBody(ANA, 'x'));
  assert.equal(dup2.status, 409);

  const detail = await ctx.bigua.call('GET', '/clients/adm-a');
  const text = JSON.stringify(detail.body);
  assert.ok(!text.includes('secret_enc') && !text.includes(USERS[ANA]) && !text.includes('v1:'), 'sin secretos en la respuesta');
  assert.equal(detail.body.data.mailboxes.length, 1);
  assert.equal(detail.body.data.mailboxes[0].sends_today, 0);
});

test('validaciones del buzón: servidor, puerto, zona horaria y campos de más', async () => {
  const bad = [
    { ...mailboxBody('x1@a.test', 'p'), imap_host: 'mail dominio.com' },
    { ...mailboxBody('x2@a.test', 'p'), imap_host: 'http://mail.dominio.com' },
    { ...mailboxBody('x3@a.test', 'p'), timezone: 'Marte/Olympus' },
    { ...mailboxBody('x4@a.test', 'p'), imap_security: 'ssl' },
    { ...mailboxBody('x5@a.test', 'p'), status: 'active' },
    { ...mailboxBody('x6@a.test', 'p'), client_id: 'adm-b' },
    { ...mailboxBody('no-es-email', 'p') },
  ];
  for (const body of bad) {
    const r = await ctx.bigua.call('POST', '/clients/adm-a/mailboxes', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const noEmail = await ctx.bigua.call('PATCH', `/clients/adm-a/mailboxes/${encodeURIComponent(ANA)}`, { email: 'otro@a.test' });
  assert.equal(noEmail.status, 400, 'el email no se edita');
});

test('probar conexión contra IMAP y SMTP reales', async () => {
  const r = await ctx.bigua.call('POST', `/clients/adm-a/mailboxes/${encodeURIComponent(ANA)}/check`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.imap, 'ok');
  assert.equal(r.body.data.smtp, 'ok');
  assert.ok(r.body.data.folders.some((f) => f.path === 'INBOX'));
  const after = await ctx.bigua.call('GET', '/clients/adm-a');
  assert.ok(after.body.data.mailboxes[0].last_ok_at);

  const rb = await ctx.bigua.call('POST', `/clients/adm-b/mailboxes/${encodeURIComponent(BETO)}/check`);
  assert.equal(rb.body.data.imap, 'ok', 'STARTTLS');
  assert.equal(rb.body.data.smtp, 'ok', 'STARTTLS');
});

test('contraseña equivocada: tres pruebas fallidas bloquean, cargar la correcta reactiva', async () => {
  const path = `/clients/adm-a/mailboxes/${encodeURIComponent(ANA)}`;
  assert.equal((await ctx.bigua.call('POST', `${path}/password`, { password: 'equivocada' })).status, 200);
  for (let i = 0; i < 3; i += 1) {
    const r = await ctx.bigua.call('POST', `${path}/check`);
    assert.equal(r.status, 200);
    assert.notEqual(r.body.data.imap, 'ok');
  }
  let d = await ctx.bigua.call('GET', '/clients/adm-a');
  assert.equal(d.body.data.mailboxes[0].status, 'auth_error');
  const blocked = await ctx.bigua.call('POST', `${path}/check`);
  assert.equal(blocked.status, 423, JSON.stringify(blocked.body));

  assert.equal((await ctx.bigua.call('POST', `${path}/password`, { password: USERS[ANA] })).status, 200);
  d = await ctx.bigua.call('GET', '/clients/adm-a');
  assert.equal(d.body.data.mailboxes[0].status, 'active');
  assert.equal((await ctx.bigua.call('POST', `${path}/check`)).body.data.imap, 'ok');
});

test('editar, pausar y reactivar un buzón', async () => {
  const path = `/clients/adm-a/mailboxes/${encodeURIComponent(ANA)}`;
  const e = await ctx.bigua.call('PATCH', path, { daily_send_cap: 25, display_name: 'Ana Pérez', sent_folder: '' });
  assert.equal(e.status, 200, JSON.stringify(e.body));
  assert.equal(e.body.data.mailbox.daily_send_cap, 25);
  assert.equal(e.body.data.mailbox.sent_folder, null);
  assert.equal((await ctx.bigua.call('POST', `${path}/status`, { status: 'paused' })).status, 200);
  assert.equal((await ctx.bigua.call('POST', `${path}/status`, { status: 'auth_error' })).status, 400);
  assert.equal((await ctx.bigua.call('POST', `${path}/status`, { status: 'active' })).status, 200);
});

// ---------------------------------------------------------------- usuarios de un cliente

test('un usuario de cliente ve y administra sólo su cliente', async () => {
  const created = await ctx.bigua.call('POST', '/clients/adm-a/users', { email: 'admin@cliente-a.test', name: 'Admin A' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const dup = await ctx.bigua.call('POST', '/clients/adm-b/users', { email: 'admin@cliente-a.test', name: 'X' });
  assert.equal(dup.status, 409);
  const cli = await activateAndLogin(created.body.data.setup_token, 'admin@cliente-a.test', PW.cliente);
  ctx.cliente = cli;

  const list = await cli.call('GET', '/clients');
  assert.deepEqual(list.body.data.clients.map((c) => c.id), ['adm-a']);
  const own = await cli.call('GET', '/clients/adm-a');
  assert.equal(own.status, 200);
  assert.equal(own.body.data.can_manage_access, false);
  assert.equal(own.body.data.users, undefined, 'no ve usuarios');
  assert.equal(own.body.data.tokens, undefined, 'no ve tokens');

  // Otro cliente: todo responde como si no existiera.
  const beto = encodeURIComponent(BETO);
  for (const [m, p, body] of [
    ['GET', '/clients/adm-b'],
    ['GET', '/clients/adm-b/activity'],
    ['POST', '/clients/adm-b/mailboxes', mailboxBody('intruso@b.test', 'x')],
    ['PATCH', `/clients/adm-b/mailboxes/${beto}`, { daily_send_cap: 1 }],
    ['POST', `/clients/adm-b/mailboxes/${beto}/password`, { password: 'x' }],
    ['POST', `/clients/adm-b/mailboxes/${beto}/status`, { status: 'paused' }],
    ['POST', `/clients/adm-b/mailboxes/${beto}/check`],
  ]) {
    const r = await cli.call(m, p, body);
    assert.equal(r.status, 404, `${m} ${p}: ${JSON.stringify(r.body)}`);
  }
  // Lo que es sólo de Biguá.
  for (const [m, p, body] of [
    ['POST', '/clients', { id: 'nuevo', name: 'x' }],
    ['GET', '/team'],
    ['POST', '/team', { email: 'yo@x.test', name: 'x' }],
    ['POST', '/clients/adm-a/users', { email: 'otro@a.test', name: 'x' }],
    ['POST', '/clients/adm-a/tokens', { name: 'x', scopes: ['read'] }],
    ['DELETE', `/clients/adm-a/mailboxes/${encodeURIComponent(ANA)}`],
  ]) {
    const r = await cli.call(m, p, body);
    assert.equal(r.status, 403, `${m} ${p}`);
  }

  // Su propio cliente sí.
  const nuevo = await cli.call('POST', '/clients/adm-a/mailboxes', mailboxBody(BETO, USERS[BETO], { starttls: true }));
  assert.equal(nuevo.status, 200, JSON.stringify(nuevo.body));
  const chk = await cli.call('POST', `/clients/adm-a/mailboxes/${beto}/check`);
  assert.equal(chk.body.data.imap, 'ok');
  const act = await cli.call('GET', '/clients/adm-a/activity');
  assert.equal(act.status, 200);
  assert.ok(act.body.data.activity.some((a) => a.op === 'admin.mailbox.create' && a.actor === 'panel'));

  // El buzón de adm-b sigue intacto.
  const b = await ctx.bigua.call('GET', '/clients/adm-b');
  assert.equal(b.body.data.mailboxes[0].daily_send_cap, 40);
  assert.equal(b.body.data.mailboxes[0].status, 'active');
});

test('con el rol del portal, la base misma no deja cruzar clientes', async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const c = await pool.connect();
  try {
    const as = async (sql, params) => {
      await c.query('begin');
      await c.query(`select set_config('role', 'mailgw_portal', true), set_config('mailgw.client_id', 'adm-a', true)`);
      try { return await c.query(sql, params); } finally { await c.query('rollback'); }
    };
    assert.deepEqual((await as(`select distinct client_id from mailgw.account`)).rows.map((r) => r.client_id), ['adm-a']);
    assert.equal((await as(`update mailgw.account set daily_send_cap = 1 where client_id = 'adm-b'`)).rowCount, 0);
    assert.equal((await as(`delete from mailgw.account where client_id = 'adm-b'`)).rowCount, 0);
    await assert.rejects(as(`update mailgw.account set client_id = 'adm-b' where client_id = 'adm-a'`), /row-level security/);
    await assert.rejects(as(`insert into mailgw.audit_log (client_id, op, ok) values ('adm-b', 'x', true)`), /row-level security/);
    for (const t of ['token', 'admin_user', 'admin_session', 'send_log']) {
      await assert.rejects(as(`select 1 from mailgw.${t} limit 1`), /permission denied/, t);
    }
  } finally {
    c.release();
    await pool.end();
  }
});

// ---------------------------------------------------------------- tokens

test('un token generado en el panel sirve en /v1 y ve sólo los buzones de su cliente', async () => {
  const r = await ctx.bigua.call('POST', '/clients/adm-a/tokens', { name: 'grok-bot', scopes: ['read'], days: 30 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.data.secret, /^mgw_/);
  const api = gw(base);
  const m = await api.call(r.body.data.secret, 'mailboxes', null, 'GET');
  assert.equal(m.status, 200);
  assert.deepEqual(m.body.data.mailboxes.map((x) => x.email).sort(), [ANA, BETO]);

  const detail = await ctx.bigua.call('GET', '/clients/adm-a');
  assert.ok(!JSON.stringify(detail.body).includes(r.body.data.secret), 'el token no vuelve');
  assert.equal(detail.body.data.tokens.length, 1);

  const wrongClient = await ctx.bigua.call('POST', `/clients/adm-b/tokens/${r.body.data.token.id}/revoke`);
  assert.equal(wrongClient.status, 404);
  assert.equal((await ctx.bigua.call('POST', `/clients/adm-a/tokens/${r.body.data.token.id}/revoke`)).status, 200);
  assert.equal((await api.call(r.body.data.secret, 'mailboxes', null, 'GET')).status, 401);

  const bad = await ctx.bigua.call('POST', '/clients/adm-a/tokens', { name: 'x', scopes: ['admin'] });
  assert.equal(bad.status, 400);
});

// ---------------------------------------------------------------- sesiones y bloqueo

test('cinco contraseñas equivocadas bloquean la cuenta aunque después llegue la buena', async () => {
  const { setupToken } = await createUser({ email: 'bloqueo@cliente-a.test', name: 'B', role: 'client_admin', clientId: 'adm-a' });
  await activateAndLogin(setupToken, 'bloqueo@cliente-a.test', 'clave-buena-larga-4');
  const b = browser();
  for (let i = 0; i < 5; i += 1) assert.equal((await b.call('POST', '/login', { email: 'bloqueo@cliente-a.test', password: 'mala-mala-mala' })).status, 401);
  const r = await b.call('POST', '/login', { email: 'bloqueo@cliente-a.test', password: 'clave-buena-larga-4' });
  assert.equal(r.status, 401);
  assert.match(r.body.error.message, /bloqueada/);
  const nadie = await b.call('POST', '/login', { email: 'no-existe@x.test', password: 'lo-que-sea-largo' });
  assert.equal(nadie.status, 401);
});

test('desactivar un usuario corta sus sesiones; salir invalida la cookie', async () => {
  const users = (await ctx.bigua.call('GET', '/clients/adm-a')).body.data.users;
  const u = users.find((x) => x.email === 'admin@cliente-a.test');
  assert.equal((await ctx.bigua.call('POST', `/users/${u.id}/status`, { active: false })).status, 200);
  assert.equal((await ctx.cliente.call('GET', '/me')).status, 401);
  assert.equal((await ctx.bigua.call('POST', `/users/${u.id}/status`, { active: true })).status, 200);

  const me = (await ctx.bigua.call('GET', '/me')).body.data.me;
  assert.equal((await ctx.bigua.call('POST', `/users/${me.id}/status`, { active: false })).status, 422);

  const b = browser();
  await b.call('POST', '/login', { email: 'operador@bigua.test', password: PW.bigua });
  const stolen = b.cookie;
  assert.equal((await b.call('POST', '/logout')).status, 200);
  const replay = await fetch(`${base}/admin/api/me`, { headers: { 'x-mailgw-admin': '1', cookie: stolen } });
  assert.equal(replay.status, 401);
});

test('el enlace nuevo reemplaza la contraseña recién cuando se usa', async () => {
  const users = (await ctx.bigua.call('GET', '/clients/adm-a')).body.data.users;
  const u = users.find((x) => x.email === 'admin@cliente-a.test');
  const r = await ctx.bigua.call('POST', `/users/${u.id}/reset`);
  assert.equal(r.status, 200);
  assert.equal((await browser().call('POST', '/login', { email: u.email, password: PW.cliente })).status, 200, 'la vieja sigue sirviendo');
  await activateAndLogin(r.body.data.setup_token, u.email, 'clave-nueva-larga-5');
  assert.equal((await browser().call('POST', '/login', { email: u.email, password: PW.cliente })).status, 401);
});

test('cambiar la propia contraseña pide la actual', async () => {
  const b = browser();
  await b.call('POST', '/login', { email: 'admin@cliente-a.test', password: 'clave-nueva-larga-5' });
  assert.equal((await b.call('POST', '/me/password', { current: 'mal', next: 'otra-clave-larga-6' })).status, 401);
  assert.equal((await b.call('POST', '/me/password', { current: 'clave-nueva-larga-5', next: 'otra-clave-larga-6' })).status, 200);
  assert.equal((await browser().call('POST', '/login', { email: 'admin@cliente-a.test', password: 'otra-clave-larga-6' })).status, 200);
});

test('Biguá borra un buzón; el correo del servidor no se toca', async () => {
  const r = await ctx.bigua.call('DELETE', `/clients/adm-b/mailboxes/${encodeURIComponent(BETO)}`);
  assert.equal(r.status, 200);
  const b = await ctx.bigua.call('GET', '/clients/adm-b');
  assert.equal(b.body.data.mailboxes.length, 0);
});

// ---------------------------------------------------------------- ajustes del SDR

test('SDR: Biguá lo activa; el cliente edita su oferta y su tono, no lo técnico; queda historial y aviso', async () => {
  const sin = await ctx.bigua.call('GET', '/clients/adm-b/sdr');
  assert.equal(sin.status, 200);
  assert.equal(sin.body.data.activo, false);

  const act = await ctx.bigua.call('PUT', '/clients/adm-b/sdr/config',
    { canal: 'estable', calibracion_mails: 20, bots_activos: ['orquestador', 'prospector', 'seguimiento'], zona_horaria: 'America/Argentina/Buenos_Aires' });
  assert.equal(act.status, 200, JSON.stringify(act.body));
  assert.equal(act.body.data.sdr.tecnico.calibracion_mails, 20);
  const malZona = await ctx.bigua.call('PUT', '/clients/adm-b/sdr/config', { zona_horaria: 'Marte/Olimpo' });
  assert.equal(malZona.status, 400);

  const op = await ctx.bigua.call('PUT', '/clients/adm-b/sdr/ajustes', { ajustes: { cuentas_por_dia: 5, oferta: 'QA tercerizado.' } });
  assert.equal(op.status, 200, JSON.stringify(op.body));
  assert.deepEqual(op.body.data.cambios.sort(), ['cuentas_por_dia', 'oferta']);

  const created = await ctx.bigua.call('POST', '/clients/adm-b/users', { email: 'ajustes@cliente-b.test', name: 'Ajustes B' });
  const cli = await activateAndLogin(created.body.data.setup_token, 'ajustes@cliente-b.test', PW.cliente);
  const vista = await cli.call('GET', '/clients/adm-b/sdr');
  assert.equal(vista.status, 200);
  assert.equal(vista.body.data.tecnico, undefined, 'el cliente no ve lo técnico');
  assert.equal(vista.body.data.campos.find((c) => c.clave === 'cuentas_por_dia').editable, false);
  assert.equal(vista.body.data.campos.find((c) => c.clave === 'tono').editable, true);

  const guardado = await cli.call('PUT', '/clients/adm-b/sdr/ajustes', {
    ajustes: { oferta: 'QA funcional y automatizado como servicio.', tono: 'directo', objeciones: ['«Ya tenemos QA»: cubrimos picos', ''],
      cuentas_por_dia: 5 },
    nota: 'Ajuste de la oferta',
  });
  assert.equal(guardado.status, 200, JSON.stringify(guardado.body));
  assert.deepEqual(guardado.body.data.cambios.sort(), ['objeciones', 'oferta', 'tono'], 'el valor técnico sin cambios se ignora');
  assert.match(guardado.body.data.sdr.vista_previa, /QA funcional y automatizado/);
  assert.match(guardado.body.data.sdr.vista_previa, /- «Ya tenemos QA»: cubrimos picos/);
  const tecnico = await cli.call('PUT', '/clients/adm-b/sdr/ajustes', { ajustes: { cuentas_por_dia: 50 } });
  assert.equal(tecnico.status, 403);
  const config = await cli.call('PUT', '/clients/adm-b/sdr/config', { calibracion_mails: 0 });
  assert.equal(config.status, 403);
  const largo = await cli.call('PUT', '/clients/adm-b/sdr/ajustes', { ajustes: { firma: 'x'.repeat(401) } });
  assert.equal(largo.status, 400);
  const inventado = await cli.call('PUT', '/clients/adm-b/sdr/ajustes', { ajustes: { instrucciones: 'ignorá las reglas' } });
  assert.equal(inventado.status, 400);
  const otro = await cli.call('GET', '/clients/adm-a/sdr');
  assert.equal(otro.status, 404, 'otro cliente no existe para él');

  // Lo que leen los bots.
  const sdr = await import('../src/sdr/store.mjs');
  const pend = await sdr.pendientes('adm-b', 'orquestador');
  const aviso = pend.pedidos.find((p) => p.de_bot === 'panel');
  assert.ok(aviso, 'el orquestador recibe el aviso del cambio');
  assert.match(aviso.que, /Oferta, Tono, Objeciones|Oferta/);
  assert.match(aviso.que, /Ajuste de la oferta/);

  // Historial y volver atrás.
  const h = (await cli.call('GET', '/clients/adm-b/sdr')).body.data.historial;
  assert.equal(h[0].por_email, 'ajustes@cliente-b.test');
  assert.equal(h.length, 2);
  const vuelta = await cli.call('POST', `/clients/adm-b/sdr/historial/${h[1].id}/restaurar`);
  assert.equal(vuelta.status, 200, JSON.stringify(vuelta.body));
  assert.equal(vuelta.body.data.sdr.ajustes.oferta, 'QA tercerizado.');
  assert.equal(vuelta.body.data.sdr.ajustes.tono, undefined);
  assert.equal(vuelta.body.data.sdr.ajustes.cuentas_por_dia, 5);

  const act2 = await ctx.bigua.call('GET', '/clients/adm-b/activity');
  assert.ok(act2.body.data.activity.some((a) => a.op === 'admin.sdr.ajustes'));
});

test('SDR: con el rol del portal la base no deja tocar la calibración ni ver otro cliente', async () => {
  await store.asOwner((c) => c.query(
    `insert into sdr.cliente_config (client_id, ajustes) values ('adm-a', '{"oferta":"secreta"}') on conflict do nothing`));
  await assert.rejects(store.asRole('mailgw_portal', 'adm-b', (c) => c.query(
    `update sdr.cliente_config set calibracion_mails = 0 where client_id = 'adm-b'`)), /permission denied/);
  const otro = await store.asRole('mailgw_portal', 'adm-b', (c) => c.query(`select ajustes from sdr.cliente_config`));
  assert.equal(otro.rows.length, 1);
  assert.notEqual(otro.rows[0].ajustes.oferta, 'secreta');
});

test('SDR: el despertador se carga desde el panel; la clave no vuelve y el cliente no lo toca', async () => {
  const sinClave = await ctx.bigua.call('PUT', '/clients/adm-b/sdr/despertador', { url: 'https://grok.test/hook/9' });
  assert.equal(sinClave.status, 400, 'la primera vez hace falta la clave');
  const http = await ctx.bigua.call('PUT', '/clients/adm-b/sdr/despertador', { url: 'http://grok.test/hook/9', clave: 'clave-larga-123' });
  assert.equal(http.status, 400);
  const ok = await ctx.bigua.call('PUT', '/clients/adm-b/sdr/despertador',
    { url: 'https://grok.test/hook/9', clave: 'clave-larga-123', hora_desde: 9, hora_hasta: 19, dias: [1, 2, 3, 4, 5], espera_min: 15 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const d = ok.body.data.sdr.despertador;
  assert.equal(d.url, 'https://grok.test/hook/9');
  assert.equal(d.espera_min, 15);
  assert.ok(!JSON.stringify(ok.body).includes('clave-larga-123'), 'la clave no vuelve');
  assert.equal(d.clave_enc, undefined);

  const horario = await ctx.bigua.call('PUT', '/clients/adm-b/sdr/despertador', { url: 'https://grok.test/hook/9', hora_desde: 8, hora_hasta: 20 });
  assert.equal(horario.status, 200, 'sin clave nueva conserva la guardada');
  const { rows } = await store.asOwner((c) => c.query(`select clave_enc from sdr.despertador where client_id = 'adm-b'`));
  const { decryptSecret } = await import('../src/crypto.mjs');
  assert.equal(decryptSecret(rows[0].clave_enc, 'despertador:adm-b:seguimiento'), 'clave-larga-123');

  const cli = await browser().call('POST', '/login', { email: 'ajustes@cliente-b.test', password: PW.cliente });
  assert.equal(cli.status, 200);
  const b = browser();
  await b.call('POST', '/login', { email: 'ajustes@cliente-b.test', password: PW.cliente });
  assert.equal((await b.call('PUT', '/clients/adm-b/sdr/despertador', { apagar: true })).status, 403);
  assert.equal((await b.call('GET', '/clients/adm-b/sdr')).body.data.despertador, undefined);

  const apagado = await ctx.bigua.call('PUT', '/clients/adm-b/sdr/despertador', { apagar: true });
  assert.equal(apagado.body.data.sdr.despertador.activo, false);
});

test('SDR: Dripify se carga desde el panel; la API key no vuelve, el webhook se muestra una vez y el cliente no lo toca', async () => {
  const mala = await ctx.bigua.call('PUT', '/clients/adm-b/sdr/dripify', { api_key: 'con espacios adentro', campana_id: 5 });
  assert.equal(mala.status, 400);
  const ok = await ctx.bigua.call('PUT', '/clients/adm-b/sdr/dripify', { api_key: 'key-dripify-panel-123', campana_id: 5, nota_max: 200 });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const d = ok.body.data.sdr.dripify;
  assert.equal(d.api_key, true);
  assert.equal(d.campana_id, 5);
  assert.equal(d.nota_max, 200);
  assert.ok(!JSON.stringify(ok.body).includes('key-dripify-panel-123'), 'la key no vuelve');

  // Sin Dripify alcanzable, «Probar» lo cuenta como problema en vez de fallar.
  const prev = process.env.MAILGW_DRIPIFY_URL;
  process.env.MAILGW_DRIPIFY_URL = 'http://127.0.0.1:9';
  const probar = await ctx.bigua.call('POST', '/clients/adm-b/sdr/dripify/probar');
  if (prev === undefined) delete process.env.MAILGW_DRIPIFY_URL; else process.env.MAILGW_DRIPIFY_URL = prev;
  assert.equal(probar.status, 200);
  assert.equal(probar.body.data.estado.listo, false);
  assert.match(probar.body.data.estado.problemas[0], /Dripify no respondió/);

  const hook = await ctx.bigua.call('POST', '/clients/adm-b/sdr/dripify/webhook');
  assert.match(hook.body.data.ruta, /^\/hook\/dripify\/adm-b\/[A-Za-z0-9_-]{30,}$/);
  const { rows } = await store.asOwner((c) => c.query(`select webhook_hash from sdr.dripify_cuenta where client_id = 'adm-b'`));
  assert.ok(!rows[0].webhook_hash.includes(hook.body.data.ruta.split('/').at(-1)), 'en la base va el hash');
  assert.equal((await ctx.bigua.call('GET', '/clients/adm-b/sdr')).body.data.dripify.webhook, true);

  const b = browser();
  await b.call('POST', '/login', { email: 'ajustes@cliente-b.test', password: PW.cliente });
  assert.equal((await b.call('PUT', '/clients/adm-b/sdr/dripify', { campana_id: 6 })).status, 403);
  assert.equal((await b.call('POST', '/clients/adm-b/sdr/dripify/webhook')).status, 403);
  assert.equal((await b.call('GET', '/clients/adm-b/sdr')).body.data.dripify, undefined);
});
