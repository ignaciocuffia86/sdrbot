// Derivación de un interesado al cliente (migración 018, docs/16 §7): la respuesta a un positivo
// sale desde la casilla secundaria con quien toma a los interesados en copia; el prospecto queda
// derivado, el SDR no le vuelve a escribir solo y el «responder a todos» del responsable no se toma
// como una respuesta del prospecto. Contra la base local, el SMTP de prueba y el Dovecot.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/store.mjs';
import * as sdr from '../src/sdr/store.mjs';
import { replyFields } from '../src/mail/compose.mjs';
import { aplicarCambiosEmpresa } from '../src/sdr/ajustes.mjs';
import { newToken, aadFor, encryptSecret } from '../src/crypto.mjs';
import { startServer } from '../src/server.mjs';
import { startSmtp, gw, appendTo, rfc822, HOST, PORTS, USERS } from './helpers.mjs';

const C = 'deriv-c';
const BUZON = 'beto@cliente.test';
const RESPONSABLE = 'augusto@principal.test';
const AJUSTES = { responsable_positivos: 'Augusto Pérez', responsable_email: RESPONSABLE };
const ASUNTO = 'Una idea para Lead SA';
let server, smtp, api;
const tok = {};
let juan, primero;

async function token(client, scopes) {
  const { token: t, hash } = newToken();
  await store.createToken(client, `deriv ${scopes.join('+')}`, hash, scopes, null);
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
const SEG = { bot: 'seguimiento', tarea: 'respuestas' };
const uidDe = async (messageId) => {
  const found = await ok(tok.c, 'search', { mailbox: BUZON, subject: ASUNTO });
  const m = found.messages.find((x) => x.message_id === messageId);
  assert.ok(m, `no está ${messageId}`);
  return m.uid;
};

before(async () => {
  smtp = await startSmtp();
  server = await startServer(0);
  api = gw(`http://127.0.0.1:${server.address().port}`);
  await store.upsertClient(C, 'Cliente Derivación');
  await store.upsertAccount({
    client_id: C, email: BUZON, display_name: 'Beto', username: BUZON,
    secret_enc: encryptSecret(USERS[BUZON], aadFor(C, BUZON)),
    imap_host: HOST, imap_port: PORTS.imaps, imap_security: 'tls',
    smtp_host: HOST, smtp_port: PORTS.smtps, smtp_security: 'tls',
    timezone: 'America/Argentina/Buenos_Aires', daily_send_cap: 40, append_sent: false,
  });
  await sdr.setConfig(C, { calibracion_mails: 0, bots_activos: ['orquestador', 'prospector', 'seguimiento'], ajustes: AJUSTES });
  tok.c = await token(C, ['read', 'send', 'sdr']);

  juan = (await ok(tok.c, 'registro_guardar_prospecto', { nombre: 'Juan Lead', email: 'juan@lead.test', bot: 'prospector' })).prospecto;
  primero = await ok(tok.c, 'send', {
    mailbox: BUZON, to: 'juan@lead.test', subject: ASUNTO, text: 'Hola Juan, una idea.',
    idempotency_key: `${juan.id}:mail-1`, prospecto_id: juan.id, bot: 'prospector', tarea: 'diaria',
  });
  await appendTo(BUZON, 'INBOX', rfc822({
    from: 'Juan Lead <juan@lead.test>', to: BUZON, subject: `Re: ${ASUNTO}`, messageId: '<juan-1@lead.test>',
    inReplyTo: primero.message_id, references: primero.message_id, date: new Date(), body: 'Me interesa, ¿hablamos?',
  }));
  const r = await ok(tok.c, 'correo_revisar', SEG);
  assert.equal(r.pendientes.find((x) => x.prospecto?.id === juan.id)?.tipo, 'respuesta');
  await ok(tok.c, 'registro_evento', { tipo: 'positivo', canal: 'mail', prospecto_id: juan.id, ...SEG });
});

after(async () => {
  await new Promise((r) => server.close(r));
  await smtp.close();
  await store.closePool();
});

// ---------------------------------------------------------------- sin base

test('quién puede ir en copia: el responsable o su dominio, nunca un dominio público', () => {
  assert.ok(sdr.esDelResponsable('augusto@principal.test', RESPONSABLE));
  assert.ok(sdr.esDelResponsable('Ventas@Principal.test', RESPONSABLE), 'otra persona del mismo dominio');
  assert.ok(!sdr.esDelResponsable('augusto@principal.test.evil', RESPONSABLE));
  assert.ok(!sdr.esDelResponsable('x@otro.test', RESPONSABLE));
  assert.ok(sdr.esDelResponsable('ana@gmail.com', 'ana@gmail.com'));
  assert.ok(!sdr.esDelResponsable('cualquiera@gmail.com', 'ana@gmail.com'), 'gmail.com no es «el dominio del cliente»');
  assert.ok(!sdr.esDelResponsable('x@principal.test', null));
  assert.deepEqual(sdr.listaCopia(['Augusto <AUGUSTO@principal.test>', 'augusto@principal.test', ' ventas@principal.test ']),
    ['augusto@principal.test', 'ventas@principal.test']);
});

test('el mail de quien toma a los interesados: ajuste propio, o el que estaba escrito en el nombre', () => {
  const k = { tipo: 'prospeccion', clave: 'principal', ajustes: {} };
  assert.deepEqual(sdr.responsable({ ajustes: AJUSTES }, k), { nombre: 'Augusto Pérez', email: RESPONSABLE });
  assert.deepEqual(sdr.responsable({ ajustes: { responsable_positivos: 'Ana Pérez, Ana@Empresa.test' } }, k),
    { nombre: 'Ana Pérez, Ana@Empresa.test', email: 'ana@empresa.test' });
  assert.equal(sdr.responsable({ ajustes: { responsable_positivos: 'Ana Pérez' } }, k).email, null);
  // La campaña puede tener su propio responsable.
  const kAna = { ...k, ajustes: { responsable_email: 'ana@principal.test' } };
  assert.equal(sdr.responsable({ ajustes: AJUSTES }, kAna).email, 'ana@principal.test');

  const BIGUA = { esBigua: true };
  assert.equal(aplicarCambiosEmpresa({}, { responsable_email: ' Ana@Empresa.test ' }, BIGUA).responsable_email, 'ana@empresa.test');
  assert.throws(() => aplicarCambiosEmpresa({}, { responsable_email: 'ana arroba empresa' }, BIGUA), /tiene que ser un mail/);
});

test('replyFields: la copia pedida se suma sin repetir al destinatario ni al buzón', () => {
  const original = { from: { address: 'juan@lead.test', name: 'Juan' }, to: [{ address: BUZON }], cc: [], subject: 'Hola', message_id: '<m@x>' };
  const f = replyFields({ email: BUZON }, original, { text: 'ok', quote: false, cc: [RESPONSABLE, 'juan@lead.test', BUZON] });
  assert.deepEqual(f.cc, [RESPONSABLE]);
  assert.equal(f.to.length, 1);
});

// ---------------------------------------------------------------- de punta a punta

test('derivar: la copia se controla, se aprueba y sale tal cual; el prospecto queda derivado', async () => {
  const uid = await uidDe('<juan-1@lead.test>');
  const texto = 'Genial, Juan. Te sumo a Augusto (en copia), que lleva esto de nuestro lado.';
  const base = { mailbox: BUZON, uid, text: texto, prospecto_id: juan.id, ...SEG };

  // Fuera del dominio del responsable, ni con aprobación ni sin ella.
  const afuera = await call(tok.c, 'reply', { ...base, cc: ['otro@afuera.test'], idempotency_key: `${juan.id}:respuesta-x` });
  assert.equal(afuera.error.code, 'copia_no_permitida');
  const pedirMal = await call(tok.c, 'registro_pedir_aprobacion', { ...SEG, tipo: 'respuesta_positivo', prospecto_id: juan.id,
    contenido: { buzon: BUZON, texto, cc: ['augusto@gmail.com'] } });
  assert.equal(pedirMal.error.code, 'copia_no_permitida');
  const enPrimerMail = await call(tok.c, 'registro_pedir_aprobacion', { bot: 'prospector', tipo: 'calibracion_mail', prospecto_id: juan.id,
    contenido: { buzon: BUZON, destinatario: 'juan@lead.test', asunto: 'Hola', texto: 'Uno', cc: [RESPONSABLE] } });
  assert.equal(enPrimerMail.error.code, 'invalid_request', 'la copia va sólo en la respuesta a un positivo');
  const alProspecto = await call(tok.c, 'registro_pedir_aprobacion', { ...SEG, tipo: 'respuesta_positivo', prospecto_id: juan.id,
    contenido: { buzon: BUZON, texto, cc: [RESPONSABLE, 'juan@lead.test'] } });
  assert.equal(alProspecto.error.code, 'copia_no_permitida');

  const ap = await ok(tok.c, 'registro_pedir_aprobacion', { ...SEG, tipo: 'respuesta_positivo', prospecto_id: juan.id,
    contenido: { buzon: BUZON, texto, cc: ['Augusto Pérez <AUGUSTO@principal.test>'] } });
  assert.deepEqual(ap.aprobacion.contenido.cc, [RESPONSABLE], 'la copia queda limpia en la aprobación');
  await ok(tok.c, 'registro_aprobar', { id: ap.aprobacion.id, decision: 'aprobada', operador: 'Ignacio' });

  const sinCopia = await call(tok.c, 'reply', { ...base, aprobacion_id: ap.aprobacion.id, idempotency_key: `${juan.id}:respuesta-1` });
  assert.equal(sinCopia.error.code, 'aprobacion_no_coincide');
  assert.match(sinCopia.error.message, /copia/);
  const otraCopia = await call(tok.c, 'reply', { ...base, cc: ['ventas@principal.test'], aprobacion_id: ap.aprobacion.id, idempotency_key: `${juan.id}:respuesta-1` });
  assert.equal(otraCopia.error.code, 'aprobacion_no_coincide', 'del dominio, pero no la aprobada');

  const antes = smtp.received.length;
  const r = await ok(tok.c, 'reply', { ...base, cc: [RESPONSABLE], aprobacion_id: ap.aprobacion.id, idempotency_key: `${juan.id}:respuesta-1` });
  assert.deepEqual(r.warnings, []);
  assert.equal(smtp.received.length, antes + 1);
  const enviado = smtp.received.at(-1);
  assert.deepEqual([...enviado.to].sort(), ['augusto@principal.test', 'juan@lead.test']);
  assert.match(enviado.raw, /^Cc: augusto@principal\.test/mi);

  const h = await ok(tok.c, 'registro_historia', { prospecto_id: juan.id });
  assert.equal(h.prospecto.derivado_a, RESPONSABLE);
  assert.ok(h.prospecto.derivado_at);
  assert.equal(h.prospecto.proximo_paso, `derivado: lo sigue ${RESPONSABLE}`);
  const ev = h.eventos.find((e) => e.tipo === 'derivado');
  assert.deepEqual(ev.datos.a, [RESPONSABLE]);
  assert.equal(ev.ref, r.message_id);
  assert.equal(ev.datos.aprobacion, ap.aprobacion.id);

  // Ningún mail nuevo del SDR a un derivado.
  const nuevo = await call(tok.c, 'send', { mailbox: BUZON, to: 'juan@lead.test', subject: 'Otra idea', text: 'Hola otra vez.',
    prospecto_id: juan.id, idempotency_key: `${juan.id}:mail-2`, bot: 'prospector', tarea: 'diaria' });
  assert.equal(nuevo.error.code, 'prospecto_derivado');

  primero.respuesta = r;
});

test('lo que escribe el responsable en el hilo no es una respuesta del prospecto; lo del prospecto sí, marcado', async () => {
  const resp = primero.respuesta;
  assert.ok(resp, 'corre después de derivar');
  await appendTo(BUZON, 'INBOX', rfc822({
    from: 'Augusto Pérez <augusto@principal.test>', to: 'juan@lead.test', subject: `Re: ${ASUNTO}`, messageId: '<aug-1@principal.test>',
    inReplyTo: resp.message_id, references: `${primero.message_id} ${resp.message_id}`, date: new Date(),
    body: 'Juan, un gusto. ¿Te va el jueves a las 11?',
  }));
  const r = await ok(tok.c, 'correo_revisar', SEG);
  assert.ok(!r.pendientes.some((x) => x.de === RESPONSABLE), 'no despierta a seguimiento');
  const { rows } = await store.asOwner((c) => c.query(
    `select tipo, estado, prospecto_id, atendido_por from sdr.correo where client_id = $1 and message_id = '<aug-1@principal.test>'`, [C]));
  assert.deepEqual(rows[0], { tipo: 'del_responsable', estado: 'atendido', prospecto_id: juan.id, atendido_por: 'gateway' });
  const h = await ok(tok.c, 'registro_historia', { prospecto_id: juan.id });
  assert.equal(h.prospecto.estado, 'positivo', 'no cambia el estado');
  assert.ok(h.eventos.some((e) => e.tipo === 'nota' && e.datos.del_responsable === true));
  assert.ok(!h.eventos.some((e) => e.tipo === 'respuesta' && e.ref === '<aug-1@principal.test>'));

  // Si el prospecto le vuelve a escribir a la casilla secundaria, se lee, con la derivación a la vista.
  await appendTo(BUZON, 'INBOX', rfc822({
    from: 'Juan Lead <juan@lead.test>', to: BUZON, subject: `Re: ${ASUNTO}`, messageId: '<juan-2@lead.test>',
    inReplyTo: resp.message_id, references: resp.message_id, date: new Date(), body: '¿Y el precio?',
  }));
  const r2 = await ok(tok.c, 'correo_revisar', SEG);
  const delProspecto = r2.pendientes.find((x) => x.message_id === '<juan-2@lead.test>');
  assert.equal(delProspecto.tipo, 'respuesta');
  assert.equal(delProspecto.datos.derivado_a, RESPONSABLE);

  // Contestarle a un derivado pide aprobación aunque ya no figure como positivo.
  await store.asOwner((c) => c.query(`update sdr.prospecto set estado = 'respondio' where id = $1`, [juan.id]));
  const uid = await uidDe('<juan-2@lead.test>');
  const sin = await call(tok.c, 'reply', { mailbox: BUZON, uid, text: 'Lo ve Augusto, que está en copia.', prospecto_id: juan.id,
    idempotency_key: `${juan.id}:respuesta-2`, ...SEG });
  assert.equal(sin.error.code, 'aprobacion_requerida');
  await ok(tok.c, 'correo_atendido', { ids: [delProspecto.id], resultado: 'derivado: se lo pasamos a Augusto', ...SEG });
});

test('sin el mail del responsable no hay copia; el mail escrito en el nombre sirve', async () => {
  const otra = (await ok(tok.c, 'registro_guardar_prospecto', { nombre: 'Otra', email: 'otra@lead.test', bot: 'prospector' })).prospecto;
  await ok(tok.c, 'registro_evento', { tipo: 'positivo', canal: 'mail', prospecto_id: otra.id, ...SEG });
  const pedir = (cc) => call(tok.c, 'registro_pedir_aprobacion', { ...SEG, tipo: 'respuesta_positivo', prospecto_id: otra.id,
    contenido: { buzon: BUZON, texto: 'Te sumo a Augusto.', cc } });
  try {
    await sdr.setConfig(C, { ajustes: { responsable_positivos: 'Augusto Pérez' } });
    const sin = await pedir([RESPONSABLE]);
    assert.equal(sin.error.code, 'sin_responsable');
    await sdr.setConfig(C, { ajustes: { responsable_positivos: 'Augusto Pérez, augusto@principal.test' } });
    assert.equal((await pedir([RESPONSABLE])).status, 200);
  } finally {
    await sdr.setConfig(C, { ajustes: AJUSTES });
  }
});
