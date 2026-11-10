// Buzones por conector de Grok (docs/08 §7, etapa F1): el bot manda y lee por el conector, y el
// gateway reserva antes, confirma después, guarda lo recibido y concilia lo enviado.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/store.mjs';
import { newToken } from '../src/crypto.mjs';
import { startServer } from '../src/server.mjs';
import { gw } from './helpers.mjs';
import * as S from '../src/admin/servicio.mjs';

const C = 'cnx-a';
const BUZON = 'ventas@cnx-a.test';
const TZ = 'America/Argentina/Buenos_Aires';
let server, api, tok;
const ids = {};

const q = (sql, params) => store.asOwner((c) => c.query(sql, params));
const hoy = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
async function call(op, body = {}) {
  const r = await api.call(tok, op, body);
  return { status: r.status, data: r.body.data, error: r.body.error };
}
const ok = async (op, body) => {
  const r = await call(op, body);
  assert.equal(r.status, 200, `${op}: ${JSON.stringify(r.error)}`);
  return r.data;
};
const META = { bot: 'prospector', tarea: 'diaria' };

before(async () => {
  server = await startServer(0);
  api = gw(`http://127.0.0.1:${server.address().port}`);
  await store.upsertClient(C, 'Conector A');
  await q(`insert into sdr.cliente_config (client_id, calibracion_mails, ajustes) values ($1, 0, $2)`, [C, { nombre_comercial: 'A' }]);
  // Después de la configuración: el buzón entra solo en la «principal» (migración 013).
  // Sin calibración propia: la calibración del buzón tiene su prueba.
  await q(`insert into mailgw.account (client_id, email, auth, provider, timezone, daily_send_cap, append_sent, calibracion, conector_modo)
           values ($1, $2, 'conector', 'microsoft', $3, 3, false, 0, 'envio')`, [C, BUZON, TZ]);
  const t = newToken();
  await store.createToken(C, 'mcp', t.hash, ['read', 'send', 'sdr'], null);
  tok = t.token;
  ids.ana = (await ok('registro_guardar_prospecto', { ...META, nombre: 'Ana', email: 'ana@prospecto-cnx.test' })).prospecto.id;
  ids.beto = (await ok('registro_guardar_prospecto', { ...META, nombre: 'Beto', email: 'beto@prospecto-cnx.test' })).prospecto.id;
});

after(async () => {
  await q(`delete from mailgw.client where id = $1`, [C]);
  await new Promise((r) => server.close(r));
  await store.closePool();
});

test('conector: el buzón figura como conector y no se manda ni se lee por IMAP', async () => {
  const b = (await ok('mailboxes')).mailboxes.find((x) => x.email === BUZON);
  assert.equal(b.via, 'conector');
  assert.equal(b.proveedor, 'microsoft');
  assert.equal(b.imap, null);
  const env = await call('send', { mailbox: BUZON, to: 'ana@prospecto-cnx.test', subject: 'Hola', text: 'x', idempotency_key: 'cnx-enviar-1' });
  assert.equal(env.status, 409);
  assert.equal(env.error.code, 'buzon_por_conector');
  assert.equal((await call('correo_conector_reservar', { mailbox: 'otro@cnx-a.test', text: 'x', to: 'a@b.test', idempotency_key: 'cnx-otro-1' })).status, 404);
});

test('conector: reservar corre los controles de enviar y devuelve el mail exacto; confirmar lo registra', async () => {
  const r = await ok('correo_conector_reservar', { ...META, mailbox: BUZON, to: 'Ana <ana@prospecto-cnx.test>', subject: 'Una pregunta',
    text: 'Hola Ana.\nUna línea.', prospecto_id: ids.ana, idempotency_key: `${ids.ana}:mail-1` });
  assert.match(r.permiso, /^\d+$/);
  assert.deepEqual(r.enviar.para, ['ana@prospecto-cnx.test']);
  assert.equal(r.enviar.asunto, 'Una pregunta');
  assert.equal(r.sends_today, 1);
  ids.permisoAna = r.permiso;
  // Pedirla dos veces con el mismo mail devuelve la misma reserva; con otro texto, no.
  const otra = await ok('correo_conector_reservar', { ...META, mailbox: BUZON, to: 'ana@prospecto-cnx.test', subject: 'Una pregunta',
    text: 'Hola Ana.\nUna línea.  ', prospecto_id: ids.ana, idempotency_key: `${ids.ana}:mail-1` });
  assert.equal(otra.permiso, r.permiso);
  assert.equal((await call('correo_conector_reservar', { ...META, mailbox: BUZON, to: 'ana@prospecto-cnx.test', subject: 'Una pregunta',
    text: 'Otro texto', prospecto_id: ids.ana, idempotency_key: `${ids.ana}:mail-1` })).error.code, 'send_in_progress');
  // Los controles de enviar: con prospecto_id, su mail tiene que estar entre los destinatarios.
  assert.equal((await call('correo_conector_reservar', { ...META, mailbox: BUZON, to: 'beto@prospecto-cnx.test', subject: 'x',
    text: 'x', prospecto_id: ids.ana, idempotency_key: 'cnx-cruzado-1' })).error.code, 'destinatario_no_coincide');

  const c = await ok('correo_conector_confirmar', { permiso: r.permiso, message_id: '<m1@cnx-a.test>' });
  assert.equal(c.confirmado, true);
  assert.equal((await ok('correo_conector_confirmar', { permiso: r.permiso })).duplicate, true);
  const h = await ok('registro_historia', { prospecto_id: ids.ana });
  const ev = h.eventos.find((e) => e.tipo === 'mail.enviado');
  assert.equal(ev.ref, '<m1@cnx-a.test>');
  assert.equal(ev.datos.via, 'conector');
  // Ya salió: la misma clave devuelve el envío anterior.
  assert.equal((await ok('correo_conector_reservar', { ...META, mailbox: BUZON, to: 'ana@prospecto-cnx.test', subject: 'Una pregunta',
    text: 'Hola Ana.\nUna línea.', prospecto_id: ids.ana, idempotency_key: `${ids.ana}:mail-1` })).duplicate, true);
});

test('conector: lo leído por el conector entra a la memoria del correo y se responde con una reserva', async () => {
  const r = await ok('correo_conector_recibido', { mailbox: BUZON, mensajes: [
    { conector_id: 'AAMk-1', message_id: '<resp1@prospecto-cnx.test>', de: 'ana@prospecto-cnx.test', de_nombre: 'Ana',
      asunto: 'Re: Una pregunta', texto: 'Sí, contame más.\n\nEl lunes, ventas escribió:\n> Hola Ana.', in_reply_to: '<m1@cnx-a.test>' },
    { conector_id: 'AAMk-2', de: 'nadie@otro-lado.test', asunto: 'Promo', texto: 'Compre ya' },
  ] });
  assert.equal(r.recibidos, 2);
  assert.equal(r.guardados, 1, 'lo que no tiene que ver con la prospección no se guarda');
  assert.equal(r.correos[0].tipo, 'respuesta');
  // Dos veces lo mismo no entra dos veces.
  assert.equal((await ok('correo_conector_recibido', { mailbox: BUZON, mensajes: [{ conector_id: 'AAMk-1', de: 'ana@prospecto-cnx.test' }] })).guardados, 0);
  const pend = await ok('correo_revisar', {});
  const item = pend.pendientes.find((x) => x.id === r.correos[0].id);
  assert.ok(item, JSON.stringify(pend));
  assert.equal(item.datos.conector_id, 'AAMk-1');
  assert.equal(item.prospecto.id, ids.ana);
  assert.equal(item.enviado_message_id, '<m1@cnx-a.test>');

  const resp = await ok('correo_conector_reservar', { bot: 'seguimiento', tarea: 'respuestas', mailbox: BUZON, correo: r.correos[0].id,
    prospecto_id: ids.ana, text: 'Genial, te paso más info.', idempotency_key: `${ids.ana}:respuesta-1` });
  assert.equal(resp.enviar.asunto, 'Re: Una pregunta');
  assert.equal(resp.enviar.responder_a, 'AAMk-1');
  assert.equal(resp.enviar.in_reply_to, '<resp1@prospecto-cnx.test>');
  ids.permisoRespuesta = resp.permiso;
});

test('conector: el cupo del buzón vale igual que por SMTP', async () => {
  // Cupo 3: ya van 2 (el mail a Ana y la respuesta).
  await ok('correo_conector_reservar', { ...META, mailbox: BUZON, to: 'beto@prospecto-cnx.test', subject: 'Hola Beto',
    text: 'Hola Beto.', prospecto_id: ids.beto, idempotency_key: `${ids.beto}:mail-1` });
  const lleno = await call('correo_conector_reservar', { ...META, mailbox: BUZON, to: 'carla@otra-cnx.test', subject: 'x',
    text: 'x', idempotency_key: 'cnx-cupo-4' });
  assert.equal(lleno.error.code, 'cap_reached');
});

test('conector: la conciliación confirma lo reservado que salió y pausa el buzón si algo salió sin reserva', async () => {
  const c = await ok('correo_conector_conciliar', { mailbox: BUZON, dia: hoy(), enviados: [
    { message_id: '<m1@cnx-a.test>', para: ['ana@prospecto-cnx.test'], asunto: 'Una pregunta' },
    // Salió y el bot no lo confirmó: se confirma acá por destinatarios y asunto.
    { conector_id: 'AAMk-9', para: ['beto@prospecto-cnx.test'], asunto: 'Hola Beto', texto: 'Hola Beto.' },
    // La respuesta a Ana, con otro texto: se avisa pero no pausa.
    { para: ['ana@prospecto-cnx.test'], asunto: 'Re: Una pregunta', texto: 'Otra cosa' },
  ] });
  assert.equal(c.conciliados, 3);
  assert.equal(c.confirmados_ahora, 2);
  assert.equal(c.texto_distinto.length, 1);
  assert.equal(c.pausado, false);
  const beto = await ok('registro_historia', { prospecto_id: ids.beto });
  assert.ok(beto.eventos.some((e) => e.tipo === 'mail.enviado' && e.ref === '<conector:AAMk-9>'));

  const mal = await ok('correo_conector_conciliar', { mailbox: BUZON, dia: hoy(), enviados: [
    { para: ['alguien@sin-reserva.test'], asunto: 'Sin permiso' },
  ] });
  assert.equal(mal.sin_reserva.length, 1);
  assert.equal(mal.pausado, true);
  const cuenta = (await q(`select status, last_error from mailgw.account where client_id = $1 and email = $2`, [C, BUZON])).rows[0];
  assert.equal(cuenta.status, 'paused');
  assert.match(cuenta.last_error, /sin reserva/);
  const pedidos = (await ok('registro_pendientes', { bot: 'orquestador' })).pedidos;
  assert.ok(pedidos.some((p) => /sin reserva del gateway/.test(p.que)));
  assert.equal((await call('correo_conector_reservar', { ...META, mailbox: BUZON, to: 'x@y-cnx.test', subject: 'x', text: 'x',
    idempotency_key: 'cnx-pausado-1' })).error.code, 'mailbox_paused');
});

test('conector: una reserva de un día pasado que no salió se libera y devuelve el cupo', async () => {
  await q(`update mailgw.account set status = 'active' where client_id = $1 and email = $2`, [C, BUZON]);
  const ayer = new Date(Date.now() - 86_400_000);
  const dia = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ayer);
  const { rows } = await q(`select id from mailgw.account where client_id = $1 and email = $2`, [C, BUZON]);
  await q(`insert into mailgw.send_counter (client_id, account_id, day, count) values ($1, $2, $3, 1)
           on conflict (account_id, day) do update set count = 1`, [C, rows[0].id, dia]);
  await q(`insert into mailgw.send_log (client_id, account_id, idempotency_key, day, kind, status, via, recipients, subject, conector)
           values ($1, $2, 'cnx-ayer-0001', $3, 'send', 'reserved', 'conector', '{zoe@ayer-cnx.test}', 'Ayer', '{"destinatarios":["zoe@ayer-cnx.test"]}')`,
  [C, rows[0].id, dia]);
  const c = await ok('correo_conector_conciliar', { mailbox: BUZON, dia, enviados: [] });
  assert.equal(c.liberados, 1);
  assert.equal((await q(`select count from mailgw.send_counter where account_id = $1 and day = $2`, [rows[0].id, dia])).rows[0].count, 0);
});

test('conector: el panel da de alta el buzón (sólo Biguá) y no le edita servidores', async () => {
  const bigua = { id: null, email: 'op@bigua.test', role: 'bigua_admin', client_id: null };
  const cliente = { id: null, email: 'ana@cnx-a.test', role: 'client_admin', client_id: C };
  const params = { client: C };
  await assert.rejects(S.buzonConectorCrear({ user: cliente, params, body: { email: 'g@cnx-a.test', provider: 'google' } }),
    (e) => e.code === 'forbidden');
  await assert.rejects(S.buzonConectorCrear({ user: bigua, params, body: { email: 'g@cnx-a.test', provider: 'google', daily_send_cap: 100 } }),
    (e) => e.code === 'invalid_request');
  const { mailbox } = await S.buzonConectorCrear({ user: bigua, params, body: { email: 'G@cnx-a.test', provider: 'google' } });
  assert.equal(mailbox.email, 'g@cnx-a.test');
  assert.equal(mailbox.auth, 'conector');
  assert.equal(mailbox.daily_send_cap, 10);
  assert.equal(mailbox.calibracion, 5);
  assert.equal(mailbox.conector_modo, 'borradores');
  const p2 = { client: C, email: 'g@cnx-a.test' };
  await assert.rejects(S.buzonEditar({ user: cliente, params: p2, body: { imap_host: 'mail.cnx-a.test' } }), (e) => e.code === 'not_allowed');
  await assert.rejects(S.buzonEditar({ user: cliente, params: p2, body: { daily_send_cap: 200 } }), (e) => e.code === 'not_allowed');
  await assert.rejects(S.buzonContrasena({ user: cliente, params: p2, body: { password: 'x' } }), (e) => e.code === 'not_allowed');
  await assert.rejects(S.buzonEditar({ user: cliente, params: p2, body: { calibracion: 0 } }), (e) => e.code === 'forbidden');
  const r = await S.buzonEditar({ user: cliente, params: p2, body: { daily_send_cap: 20, display_name: 'Gabi' } });
  assert.equal(r.mailbox.daily_send_cap, 20);
  await q(`delete from mailgw.account where client_id = $1 and email = 'g@cnx-a.test'`, [C]);
});

test('conector: un buzón en calibración pide aprobación hasta completar la suya', async () => {
  const CAL = 'cal@cnx-a.test';
  await q(`insert into mailgw.account (client_id, email, auth, provider, timezone, daily_send_cap, append_sent, calibracion, conector_modo)
           values ($1, $2, 'conector', 'google', $3, 5, false, 1, 'envio')`, [C, CAL, TZ]);
  const carla = (await ok('registro_guardar_prospecto', { ...META, nombre: 'Carla', email: 'carla@prospecto-cnx.test' })).prospecto.id;
  const mail = { ...META, mailbox: CAL, to: 'carla@prospecto-cnx.test', subject: 'Hola Carla', text: 'Hola Carla, ¿hablamos?', prospecto_id: carla };
  const sin = await call('correo_conector_reservar', { ...mail, idempotency_key: `${carla}:mail-1` });
  assert.equal(sin.error?.code, 'aprobacion_requerida');
  assert.match(sin.error.message, /por el conector y está en calibración \(0 de 1/);
  const ap = await ok('registro_pedir_aprobacion', { bot: 'prospector', tipo: 'calibracion_mail', prospecto_id: carla,
    contenido: { buzon: CAL, destinatario: 'carla@prospecto-cnx.test', asunto: 'Hola Carla', texto: 'Hola Carla, ¿hablamos?' } });
  await ok('registro_aprobar', { id: ap.aprobacion.id, decision: 'aprobada', operador: 'Op', bot: 'orquestador' });
  const r = await ok('correo_conector_reservar', { ...mail, idempotency_key: `${carla}:mail-1`, aprobacion_id: ap.aprobacion.id });
  await ok('correo_conector_confirmar', { permiso: r.permiso, message_id: '<cal-1@cnx-a.test>' });
  // Calibrado: el próximo sale sin aprobación.
  const dami = (await ok('registro_guardar_prospecto', { ...META, nombre: 'Dami', email: 'dami@prospecto-cnx.test' })).prospecto.id;
  const r2 = await ok('correo_conector_reservar', { ...mail, to: 'dami@prospecto-cnx.test', prospecto_id: dami, idempotency_key: `${dami}:mail-1` });
  assert.ok(r2.permiso);
});

test('conector: en modo borradores el bot no confirma y la conciliación espera al que lo manda', async () => {
  const BOR = 'bor@cnx-a.test';
  await q(`insert into mailgw.account (client_id, email, auth, provider, timezone, daily_send_cap, append_sent, calibracion)
           values ($1, $2, 'conector', 'google', $3, 5, false, 0)`, [C, BOR, TZ]);
  const eva = (await ok('registro_guardar_prospecto', { ...META, nombre: 'Eva', email: 'eva@prospecto-cnx.test' })).prospecto.id;
  const r = await ok('correo_conector_reservar', { ...META, mailbox: BOR, to: 'eva@prospecto-cnx.test', subject: 'Hola Eva',
    text: 'Hola Eva, ¿hablamos?', prospecto_id: eva, idempotency_key: `${eva}:mail-1` });
  assert.equal(r.modo, 'borradores');
  assert.match(r.instruccion, /NO lo mandes/);
  const conf = await call('correo_conector_confirmar', { permiso: r.permiso, message_id: '<bor-1@cnx-a.test>' });
  assert.equal(conf.error?.code, 'buzon_en_borradores');
  // La reserva es de hace tres días; la persona lo manda hoy.
  await q(`update mailgw.send_log set day = day - 3 where id = $1`, [r.permiso]);
  const ayer = await ok('correo_conector_conciliar', { mailbox: BOR, dia: new Date(Date.now() - 86400000).toISOString().slice(0, 10), enviados: [] });
  assert.equal(ayer.liberados, 0, 'un borrador espera unos días');
  const c = await ok('correo_conector_conciliar', { mailbox: BOR, dia: hoy(),
    enviados: [{ para: ['eva@prospecto-cnx.test'], asunto: 'Hola Eva', texto: 'Hola Eva, ¿hablamos?', message_id: '<bor-1@cnx-a.test>' }] });
  assert.equal(c.confirmados_ahora, 1);
  assert.equal(c.pausado, false);
});
