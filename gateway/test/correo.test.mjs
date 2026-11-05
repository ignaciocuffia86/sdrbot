// Memoria del correo (etapa 2 de docs/09): lectura de los buzones con cursor, respuestas atadas
// a su envío, rebotes, respuestas automáticas, bajas, supresión exigida al enviar, «sin
// respuesta», despertador del bot seguimiento y el reloj (/cron/correo). Contra el Dovecot y el
// SMTP de prueba, con un buzón propio (dario) para no pisar los UID de otras pruebas.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/store.mjs';
import * as sdr from '../src/sdr/store.mjs';
import * as correo from '../src/sdr/correo.mjs';
import { bounceInfo } from '../src/mail/parse.mjs';
import { newToken, aadFor, encryptSecret } from '../src/crypto.mjs';
import { startServer } from '../src/server.mjs';
import { startSmtp, gw, runCli, appendTo, rfc822, HOST, PORTS, USERS } from './helpers.mjs';

const C = 'correo-c';
const D = 'correo-d';
const BUZON = 'dario@cliente.test';
let server, smtp, api, base;
const tok = {};
const P = {};
const enviados = {};

async function token(client, scopes) {
  const { token: t, hash } = newToken();
  await store.createToken(client, `correo ${scopes.join('+')}`, hash, scopes, null);
  return t;
}
async function call(t, op, body = {}) {
  const r = await api.call(t, op, body);
  return { status: r.status, data: r.body.data, error: r.body.error };
}
const ok = async (t, op, body) => {
  const r = await call(t, op, body);
  assert.equal(r.status, 200, `${op}: ${JSON.stringify(r.error)}`);
  return r.data;
};
const META = { bot: 'seguimiento', tarea: 'respuestas' };

function dsn({ to, originalId, status = '5.1.1', action = 'failed' }) {
  return [
    'From: Mail Delivery System <mailer-daemon@mx.empresa.test>',
    `To: ${BUZON}`,
    'Subject: Undelivered Mail Returned to Sender',
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <dsn-${Math.random().toString(36).slice(2)}@mx.empresa.test>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/report; report-type=delivery-status; boundary="B"',
    '',
    '--B',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'No se pudo entregar el mensaje.',
    '--B',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx.empresa.test',
    '',
    `Final-Recipient: rfc822; ${to}`,
    `Action: ${action}`,
    `Status: ${status}`,
    'Diagnostic-Code: smtp; 550 5.1.1 User unknown',
    '--B',
    'Content-Type: text/rfc822-headers',
    '',
    `From: ${BUZON}`,
    `To: ${to}`,
    'Subject: Una idea para Empresa',
    `Message-ID: ${originalId}`,
    '--B--',
    '',
  ].join('\r\n');
}

before(async () => {
  smtp = await startSmtp();
  server = await startServer(0);
  base = `http://127.0.0.1:${server.address().port}`;
  api = gw(base);
  await store.upsertClient(C, 'Cliente Correo C');
  await store.upsertClient(D, 'Cliente Correo D');
  await store.upsertAccount({
    client_id: C, email: BUZON, display_name: 'Darío', username: BUZON,
    secret_enc: encryptSecret(USERS[BUZON], aadFor(C, BUZON)),
    imap_host: HOST, imap_port: PORTS.imaps, imap_security: 'tls',
    smtp_host: HOST, smtp_port: PORTS.smtps, smtp_security: 'tls',
    timezone: 'America/Argentina/Buenos_Aires', daily_send_cap: 40, append_sent: false,
  });
  await sdr.setConfig(C, { calibracion_mails: 0, bots_activos: ['orquestador', 'prospector', 'seguimiento'] });
  tok.c = await token(C, ['read', 'send', 'sdr']);
  tok.d = await token(D, ['read', 'send', 'sdr']);

  const cuenta = (await ok(tok.c, 'registro_guardar_cuenta', { nombre: 'Empresa', dominio: 'empresa.test', bot: 'prospector' })).cuenta;
  for (const [k, nombre] of [['uno', 'Uno'], ['dos', 'Dos'], ['tres', 'Tres'], ['cuatro', 'Cuatro']]) {
    P[k] = (await ok(tok.c, 'registro_guardar_prospecto', {
      nombre, email: `${k}@empresa.test`, cuenta_id: cuenta.id, linkedin_url: `https://www.linkedin.com/in/${k}-empresa`, bot: 'prospector',
    })).prospecto;
    enviados[k] = await ok(tok.c, 'send', {
      mailbox: BUZON, to: `${k}@empresa.test`, subject: 'Una idea para Empresa', text: `Hola ${nombre}, una idea.`,
      idempotency_key: `${P[k].id}:mail-1`, prospecto_id: P[k].id, bot: 'prospector', tarea: 'diaria',
    });
  }
});

after(async () => {
  await new Promise((r) => server.close(r));
  await smtp.close();
  await store.closePool();
});

test('bounceInfo: destinatario, estado, original y si es definitivo', () => {
  const b = bounceInfo(Buffer.from(dsn({ to: 'x@empresa.test', originalId: '<orig-1@cliente.test>' })), '<dsn@mx>');
  assert.deepEqual(b.recipients, ['x@empresa.test']);
  assert.equal(b.status, '5.1.1');
  assert.equal(b.original_message_id, '<orig-1@cliente.test>');
  assert.equal(b.permanent, true);
  const t = bounceInfo(dsn({ to: 'x@empresa.test', originalId: '<o@c>', status: '4.4.1', action: 'delayed' }), null);
  assert.equal(t.permanent, false);
});

test('correo_revisar: respuesta en el hilo, rebote, fuera de oficina, baja y alguien de la cuenta; lo ajeno no se guarda', async () => {
  const fecha = new Date();
  await appendTo(BUZON, 'INBOX', rfc822({
    from: 'Uno <uno@empresa.test>', to: BUZON, subject: 'Re: Una idea para Empresa', date: fecha,
    messageId: '<r1@empresa.test>', inReplyTo: enviados.uno.message_id, references: enviados.uno.message_id,
    body: 'Me interesa, ¿hablamos el jueves?\r\n\r\nEl lun, 3 nov 2026, Darío escribió:\r\n> Hola Uno, una idea.',
  }));
  await appendTo(BUZON, 'INBOX', dsn({ to: 'dos@empresa.test', originalId: enviados.dos.message_id }));
  await appendTo(BUZON, 'INBOX', rfc822({
    from: 'tres@empresa.test', to: BUZON, subject: 'Fuera de la oficina', date: fecha, messageId: '<a3@empresa.test>',
    headers: { 'Auto-Submitted': 'auto-replied' }, body: 'Estoy de vacaciones hasta el 20/11.',
  }));
  await appendTo(BUZON, 'INBOX', rfc822({
    from: 'alguien@otra.test', to: BUZON, subject: 'BAJA', date: fecha, messageId: '<b1@otra.test>', body: '',
  }));
  await appendTo(BUZON, 'INBOX', rfc822({
    from: 'newsletter@diario.test', to: BUZON, subject: 'Las noticias de hoy', date: fecha, messageId: '<n1@diario.test>', body: 'Hola.',
  }));
  await appendTo(BUZON, 'INBOX', rfc822({
    from: 'Jefa <jefa@empresa.test>', to: BUZON, subject: 'Consulta', date: fecha, messageId: '<j1@empresa.test>', body: 'Me pasaron tu mail.',
  }));

  const r = await ok(tok.c, 'correo_revisar', META);
  assert.equal(r.revisados.length, 1);
  assert.equal(r.revisados[0].leidos, 6);
  assert.equal(r.revisados[0].guardados, 5, 'el newsletter no se guarda');
  assert.equal(r.total, 5);
  const por = Object.fromEntries(r.pendientes.map((x) => [x.tipo, x]));
  assert.equal(r.pendientes[0].tipo, 'respuesta', 'primero las respuestas');

  assert.equal(por.respuesta.prospecto.id, P.uno.id);
  assert.equal(por.respuesta.como, 'hilo');
  assert.equal(por.respuesta.enviado_message_id, enviados.uno.message_id);
  assert.equal(por.respuesta.texto, 'Me interesa, ¿hablamos el jueves?', 'sin la cita');
  assert.equal(por.respuesta.buzon, BUZON);
  assert.ok(por.respuesta.uid > 0);

  assert.equal(por.rebote.prospecto.id, P.dos.id);
  assert.equal(por.rebote.como, 'hilo');
  assert.equal(por.rebote.datos.status, '5.1.1');
  assert.equal(por.automatica.prospecto.id, P.tres.id);
  assert.equal(por.automatica.como, 'remitente');
  assert.equal(por.baja.prospecto, null);
  assert.equal(por.de_cuenta.cuenta.nombre, 'Empresa');
  assert.equal(por.de_cuenta.como, 'dominio');

  const h1 = await ok(tok.c, 'registro_historia', { prospecto_id: P.uno.id });
  assert.equal(h1.prospecto.estado, 'respondio');
  assert.equal(h1.prospecto.proximo_paso, 'seguimiento: leer la respuesta');
  assert.ok(h1.eventos.some((e) => e.tipo === 'respuesta' && e.bot === 'gateway'));
  const h2 = await ok(tok.c, 'registro_historia', { prospecto_id: P.dos.id });
  assert.ok(h2.eventos.some((e) => e.tipo === 'mail.rebotado'));

  // Una segunda lectura no duplica nada.
  const r2 = await ok(tok.c, 'correo_revisar', META);
  assert.equal(r2.revisados[0].leidos, 0);
  assert.equal(r2.total, 5);
  const agenda = await ok(tok.c, 'registro_agenda', { bot: 'orquestador' });
  assert.equal(agenda.correo_sin_atender, 5);
});

test('al enviar: supresión, respuesta sin atender y prospecto que ya respondió', async () => {
  const mail = (k, extra = {}) => ({
    mailbox: BUZON, to: `${k}@empresa.test`, subject: 'Seguimiento', text: 'Hola de nuevo.',
    idempotency_key: `${P[k]?.id ?? k}:mail-2`, ...extra,
  });
  const rebotado = await call(tok.c, 'send', mail('dos', { prospecto_id: P.dos.id }));
  assert.equal(rebotado.status, 409);
  assert.equal(rebotado.error.code, 'destinatario_suprimido');
  const baja = await call(tok.c, 'send', { mailbox: BUZON, to: 'alguien@otra.test', subject: 'Hola', text: 'Hola', idempotency_key: 'baja-0001' });
  assert.equal(baja.error.code, 'destinatario_suprimido', 'la baja vale aunque no sea prospecto');

  const sinLeer = await call(tok.c, 'send', mail('uno'));
  assert.equal(sinLeer.error.code, 'respuesta_sin_atender', 'sin prospecto_id se lo encuentra por el destinatario');
  const pend = await ok(tok.c, 'correo_revisar', { sincronizar: false, ...META });
  const resp = pend.pendientes.find((x) => x.tipo === 'respuesta');
  const at = await ok(tok.c, 'correo_atendido', { ids: [resp.id, 999999], resultado: 'positivo: respuesta para aprobar', ...META });
  assert.deepEqual(at.atendidos, [resp.id]);
  assert.deepEqual(at.ya_atendidos_o_inexistentes, [999999]);
  const respondio = await call(tok.c, 'send', mail('uno', { prospecto_id: P.uno.id }));
  assert.equal(respondio.error.code, 'prospecto_respondio');

  // El cupo no se gastó en los rechazados.
  const buzones = await ok(tok.c, 'mailboxes');
  assert.equal(buzones.mailboxes[0].sends_today, 4);

  // Contestar en el hilo sí se puede.
  const r = await ok(tok.c, 'reply', {
    mailbox: BUZON, folder: 'INBOX', uid: resp.uid, text: '¡Genial! ¿El jueves a las 11?',
    idempotency_key: `${P.uno.id}:respuesta-1`, prospecto_id: P.uno.id, ...META,
  });
  assert.equal(r.duplicate, false);
  const h = await ok(tok.c, 'registro_historia', { prospecto_id: P.uno.id });
  assert.ok(h.eventos.some((e) => e.tipo === 'mail.enviado' && e.datos.respuesta === true));
});

test('correo_sin_respuesta: en contacto, último mail viejo y nada después', async () => {
  await store.asOwner((c) => c.query(
    `update sdr.evento set at = now() - interval '6 days' where client_id = $1 and tipo = 'mail.enviado' and prospecto_id = any($2)`,
    [C, [P.cuatro.id, P.uno.id, P.dos.id]]));
  const r = await ok(tok.c, 'correo_sin_respuesta', { dias: 4, ...META });
  const ids = r.prospectos.map((p) => p.id);
  assert.ok(ids.includes(P.cuatro.id));
  assert.ok(!ids.includes(P.uno.id), 'respondió');
  assert.ok(!ids.includes(P.dos.id), 'rebotó');
  assert.ok(!ids.includes(P.tres.id), 'su mail es de hoy');
  assert.equal(r.prospectos.find((p) => p.id === P.cuatro.id).ultimo_message_id, enviados.cuatro.message_id);
});

test('aislamiento: otro cliente no ve el correo ni la supresión', async () => {
  const r = await ok(tok.d, 'correo_revisar', META);
  assert.equal(r.total, 0);
  assert.deepEqual(r.revisados, []);
  const n = await store.asRole('mailgw_app', D, (c) => c.query(`select count(*)::int as n from sdr.supresion`));
  assert.equal(n.rows[0].n, 0);
});

test('despertador: agrupa, avisa con la clave, reintenta con espera y no se repite', async () => {
  const out = await runCli(['sdr-despertador', C, 'seguimiento', '--url', 'https://grok.test/hook/1', '--desde', '0', '--hasta', '24',
    '--dias', '1,2,3,4,5,6,7', '--espera', '10'], 'clave-del-webhook\n');
  assert.equal(out.status, 0, out.stderr);

  const llamadas = [];
  let responder = 200;
  const fetchImpl = async (url, init) => {
    llamadas.push({ url, init });
    return { ok: responder < 300, status: responder };
  };
  responder = 503;
  const f = await correo.despertar(C, 'seguimiento', { fetchImpl });
  assert.equal(f.despertado, false);
  assert.equal(f.estado, 503);
  const espera = await correo.despertar(C, 'seguimiento', { fetchImpl });
  assert.equal(espera.motivo, 'esperando para agrupar', 'después de una falla espera antes de reintentar');

  responder = 200;
  const dentroDe3 = new Date(Date.now() + 3 * 60_000);
  const d = await correo.despertar(C, 'seguimiento', { fetchImpl, ahora: dentroDe3 });
  assert.equal(d.despertado, true);
  assert.equal(d.correos, 4);
  const ultima = llamadas.at(-1);
  assert.equal(ultima.url, 'https://grok.test/hook/1');
  assert.equal(ultima.init.headers.authorization, 'Bearer clave-del-webhook');
  const cuerpo = JSON.parse(ultima.init.body);
  assert.equal(cuerpo.correos_nuevos, 4);
  assert.match(cuerpo.instruccion, /correo_revisar/);

  const luego = await correo.despertar(C, 'seguimiento', { fetchImpl, ahora: new Date(Date.now() + 30 * 60_000) });
  assert.equal(luego.motivo, 'nada nuevo', 'lo avisado no se vuelve a avisar enseguida');

  const off = await runCli(['sdr-despertador', C, 'seguimiento', '--apagar']);
  assert.equal(off.status, 0, off.stderr);
  assert.equal((await correo.despertar(C, 'seguimiento', { fetchImpl })).motivo, 'sin despertador');
});

test('reloj: /cron/correo exige su secreto y lee los buzones de los clientes con seguimiento', async () => {
  const post = (auth) => fetch(`${base}/cron/correo`, { method: 'POST', headers: auth ? { authorization: `Bearer ${auth}` } : {} });
  assert.equal((await post()).status, 401);
  const out = await runCli(['reloj-secreto']);
  assert.equal(out.status, 0, out.stderr);
  const secreto = out.stdout.trim().split('\n').at(-1);
  assert.equal((await post('otro')).status, 401);

  await appendTo(BUZON, 'INBOX', rfc822({
    from: 'cuatro@empresa.test', to: BUZON, subject: 'Re: Una idea para Empresa', date: new Date(),
    messageId: '<r4@empresa.test>', inReplyTo: enviados.cuatro.message_id, body: 'No, gracias.',
  }));
  const res = await post(secreto);
  assert.equal(res.status, 200);
  const body = await res.json();
  const mio = body.data.buzones.find((b) => b.buzon === BUZON);
  assert.equal(mio.guardados, 1);
  assert.ok(!body.data.buzones.some((b) => b.cliente === D), 'sólo clientes con seguimiento activo');
  const h = await ok(tok.c, 'registro_historia', { prospecto_id: P.cuatro.id });
  assert.equal(h.prospecto.estado, 'respondio');
});
