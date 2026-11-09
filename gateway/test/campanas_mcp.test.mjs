// La campaña en las herramientas MCP (docs/21 §4.3 y §7.2, etapa C1): a qué campaña va cada cosa
// del registro, una persona en una sola campaña, y lo que el gateway hace cumplir al enviar
// (campaña activa, buzones de la campaña, links permitidos, calibración por campaña).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/store.mjs';
import { newToken, aadFor, encryptSecret } from '../src/crypto.mjs';
import { startServer } from '../src/server.mjs';
import { startSmtp, gw, HOST, PORTS, USERS } from './helpers.mjs';

const C = 'cmc-a';
const DARIO = 'dario@cliente.test';
const BETO = 'beto@cliente.test';
let server, smtp, api, tok;
const k = {};

const q = (sql, params) => store.asOwner((c) => c.query(sql, params));

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

const buzon = (email) => store.upsertAccount({
  client_id: C, email, display_name: email, username: email,
  secret_enc: encryptSecret(USERS[email], aadFor(C, email)),
  imap_host: HOST, imap_port: PORTS.imaps, imap_security: 'tls',
  smtp_host: HOST, smtp_port: PORTS.smtps, smtp_security: 'tls',
  timezone: 'America/Argentina/Buenos_Aires', daily_send_cap: 40, append_sent: false,
});

before(async () => {
  smtp = await startSmtp();
  server = await startServer(0);
  api = gw(`http://127.0.0.1:${server.address().port}`);
  await store.upsertClient(C, 'Campañas MCP');
  await buzon(DARIO);
  await q(`insert into sdr.cliente_config (client_id, calibracion_mails, ajustes, tope_cuentas_dia) values ($1, 0, $2, 20)`, [C, {
    nombre_comercial: 'Cliente C', firma: 'Equipo C · https://www.cliente-c.test',
    link_agenda: 'https://agenda.test/cliente-c',
  }]);
  k.principal = (await q(`select * from sdr.campana where client_id = $1 and clave = 'principal'`, [C])).rows[0];
  // Un buzón que llega después de la «principal» entra en ella solo (migración 013).
  await buzon(BETO);
  k.webinar = (await q(
    `insert into sdr.campana (client_id, clave, nombre, tipo, estado, cuentas_por_dia, calibracion_mails, ajustes)
     values ($1, 'webinar', 'Webinar', 'evento', 'activa', 5, 1, $2) returning *`,
    [C, { propuesta: 'Webinar', links_permitidos: ['https://cliente-c.test/webinar'] }])).rows[0];
  await q(`insert into sdr.campana_buzon (client_id, campana_id, account_id)
           select $1, $2, id from mailgw.account where client_id = $1 and email = $3`, [C, k.webinar.id, BETO]);
  k.otra = (await q(
    `insert into sdr.campana (client_id, clave, nombre, tipo, estado, cuentas_por_dia) values ($1, 'otra', 'Otra', 'prospeccion', 'activa', 3) returning *`,
    [C])).rows[0];
  const t = newToken();
  await store.createToken(C, 'mcp', t.hash, ['read', 'send', 'sdr'], null);
  tok = t.token;
});

after(async () => {
  await q(`delete from mailgw.client where id = $1`, [C]);
  await new Promise((r) => server.close(r));
  await smtp.close();
  await store.closePool();
});

const ids = {};

test('campañas MCP: un buzón nuevo entra solo en la «principal»', async () => {
  const bz = (await q(
    `select a.email from sdr.campana_buzon b join mailgw.account a on a.id = b.account_id where b.campana_id = $1 order by a.email`,
    [k.principal.id])).rows.map((r) => r.email);
  assert.deepEqual(bz, [BETO, DARIO]);
});

test('campañas MCP: cuentas y personas van a su campaña; sin campaña, a la de la cuenta o la «principal»', async () => {
  const sin = await ok('registro_guardar_cuenta', { nombre: 'Acme', dominio: 'acme.test', ...META });
  assert.equal(sin.cuenta.campana_id, k.principal.id);
  const web = await ok('registro_guardar_cuenta', { nombre: 'Beta', dominio: 'beta.test', campana: 'webinar', ...META });
  assert.equal(web.cuenta.campana_id, k.webinar.id);
  assert.equal((await call('registro_guardar_cuenta', { nombre: 'X', dominio: 'x.test', campana: 'no-existe', ...META })).status, 404);
  ids.acme = sin.cuenta.id;
  ids.beta = web.cuenta.id;

  // Una persona nueva sin campaña va a la de su cuenta.
  const ana = await ok('registro_guardar_prospecto', { cuenta_id: ids.beta, nombre: 'Ana', email: 'ana@beta.test', ...META });
  assert.equal(ana.prospecto.campana_id, k.webinar.id);
  ids.ana = ana.prospecto.id;
  const juan = await ok('registro_guardar_prospecto', { cuenta_id: ids.acme, nombre: 'Juan', email: 'juan@acme.test', ...META });
  assert.equal(juan.prospecto.campana_id, k.principal.id);
  ids.juan = juan.prospecto.id;

  // Las aprobaciones y los pedidos quedan en la campaña de la persona (o la que se pasa).
  const ap = await ok('registro_pedir_aprobacion', { tipo: 'otro', prospecto_id: ids.ana, contenido: { contexto: 'x' }, ...META });
  assert.equal(ap.aprobacion.campana_id, k.webinar.id);
  const ped = await ok('registro_pedir', { para_bot: 'seguimiento', que: 'mirá a Ana', prospecto_id: ids.ana, ...META });
  assert.equal(ped.pedido.campana_id, k.webinar.id);
  const ped2 = await ok('registro_pedir', { para_bot: 'prospector', que: '3 cuentas', campana: 'otra', bot: 'orquestador' });
  assert.equal(ped2.pedido.campana_id, k.otra.id);
  const mal = await call('registro_pedir', { para_bot: 'seguimiento', que: 'mirá a Ana', prospecto_id: ids.ana, campana: 'otra', ...META });
  assert.equal(mal.status, 409);
  assert.equal(mal.error.code, 'en_otra_campana');
});

test('campañas MCP: una persona en una sola campaña activa; una cuenta en contacto no entra en otra de prospección', async () => {
  // Investigada todavía: se la puede pasar de campaña.
  const movida = await ok('registro_guardar_prospecto', { id: ids.juan, campana: 'otra', ...META });
  assert.equal(movida.prospecto.campana_id, k.otra.id);
  await ok('registro_guardar_prospecto', { id: ids.juan, campana: 'principal', ...META });
  // En contacto por una campaña activa: no.
  await ok('registro_guardar_prospecto', { id: ids.juan, estado: 'en_contacto', ...META });
  const en = await call('registro_guardar_prospecto', { id: ids.juan, campana: 'otra', ...META });
  assert.equal(en.status, 409);
  assert.equal(en.error.code, 'en_otra_campana');
  assert.match(en.error.message, /Principal/);

  await ok('registro_guardar_cuenta', { id: ids.acme, estado: 'en_contacto', ...META });
  const cuenta = await call('registro_guardar_cuenta', { id: ids.acme, campana: 'otra', ...META });
  assert.equal(cuenta.error.code, 'en_otra_campana');
  // Otra persona de esa cuenta en otra campaña de prospección, tampoco; en una de evento, sí.
  const otraPersona = await call('registro_guardar_prospecto', { cuenta_id: ids.acme, nombre: 'Eva', email: 'eva@acme.test', campana: 'otra', ...META });
  assert.equal(otraPersona.error.code, 'en_otra_campana');
  const evento = await ok('registro_guardar_prospecto', { cuenta_id: ids.acme, nombre: 'Eva', email: 'eva@acme.test', campana: 'webinar', ...META });
  assert.equal(evento.prospecto.campana_id, k.webinar.id);
});

const MAIL = (extra = {}) => ({
  mailbox: BETO, to: 'ana@beta.test', subject: 'Webinar de QA', text: 'Hola Ana,\n¿te sumás al webinar?',
  prospecto_id: ids.ana, ...META, ...extra,
});

test('campañas MCP: al enviar, buzón de la campaña, links permitidos y calibración de la campaña', async () => {
  // Buzón que no es de la campaña.
  const fuera = await call('send', MAIL({ mailbox: DARIO, idempotency_key: 'ana:mail-0' }));
  assert.equal(fuera.status, 422);
  assert.equal(fuera.error.code, 'buzon_fuera_de_campana');

  // Links: uno que no está permitido se rechaza; el permitido, la agenda y el dominio de la firma, no.
  const link = await call('send', MAIL({ text: 'Mirá https://otro-sitio.test/promo y www.otro.test', idempotency_key: 'ana:mail-1' }));
  assert.equal(link.error.code, 'link_no_permitido');
  assert.match(link.error.message, /otro-sitio\.test\/promo/);
  assert.match(link.error.message, /www\.otro\.test/);

  // La campaña calibra su primer mail (calibracion_mails 1), aunque el cliente ya no calibre.
  const texto = 'Hola Ana,\nInscribite en https://cliente-c.test/webinar?utm=sdr.\nAgenda: https://agenda.test/cliente-c\nhttps://www.cliente-c.test/equipo';
  const sinAp = await call('send', MAIL({ text: texto, idempotency_key: 'ana:mail-1' }));
  assert.equal(sinAp.error.code, 'aprobacion_requerida');
  assert.match(sinAp.error.message, /La campaña «Webinar» está en calibración \(0 de 1/);
  const ap = (await ok('registro_pedir_aprobacion', {
    tipo: 'calibracion_mail', prospecto_id: ids.ana, contenido: { buzon: BETO, destinatario: 'ana@beta.test', asunto: 'Webinar de QA', texto }, ...META,
  })).aprobacion;
  assert.equal(ap.campana_id, k.webinar.id);
  await ok('registro_aprobar', { id: ap.id, decision: 'aprobada', operador: 'Ignacio', bot: 'orquestador' });
  const env = await ok('send', MAIL({ text: texto, idempotency_key: 'ana:mail-1', aprobacion_id: ap.id }));
  assert.ok(env.message_id);

  // Calibrada la campaña, el segundo sale sin aprobación. Juan, de la «principal», nunca la necesitó.
  await ok('send', MAIL({ text: 'Hola Ana, ¿pudiste verlo?', subject: 'Re: Webinar de QA', idempotency_key: 'ana:mail-2' }));
  await ok('send', { mailbox: DARIO, to: 'juan@acme.test', subject: 'QA', text: 'Hola Juan', prospecto_id: ids.juan, idempotency_key: 'juan:mail-1', ...META });
});

test('campañas MCP: una campaña en pausa no manda mails nuevos ni toma personas nuevas', async () => {
  await q(`update sdr.campana set estado = 'pausada' where id = $1`, [k.webinar.id]);
  const mail = await call('send', MAIL({ text: 'Hola Ana, un recordatorio', idempotency_key: 'ana:mail-3' }));
  assert.equal(mail.status, 409);
  assert.equal(mail.error.code, 'campana_inactiva');
  assert.match(mail.error.message, /Webinar.*pausada/);
  const nueva = await call('registro_guardar_prospecto', { cuenta_id: ids.beta, nombre: 'Bruno', email: 'bruno@beta.test', ...META });
  assert.equal(nueva.error.code, 'campana_inactiva');
  // Una persona de una campaña en pausa se puede pasar a otra (ya no está en contacto activo por ella).
  const movida = await ok('registro_guardar_prospecto', { id: ids.ana, campana: 'otra', ...META });
  assert.equal(movida.prospecto.campana_id, k.otra.id);
  await q(`update sdr.campana set estado = 'activa' where id = $1`, [k.webinar.id]);
});

test('campañas MCP: un cliente sin el SDR no tiene campañas ni calibración', async () => {
  const D = 'cmc-sin-sdr';
  await store.upsertClient(D, 'Sólo correo');
  try {
    await store.upsertAccount({
      client_id: D, email: DARIO, display_name: null, username: DARIO, secret_enc: encryptSecret(USERS[DARIO], aadFor(D, DARIO)),
      imap_host: HOST, imap_port: PORTS.imaps, imap_security: 'tls', smtp_host: HOST, smtp_port: PORTS.smtps, smtp_security: 'tls',
      timezone: 'America/Argentina/Buenos_Aires', daily_send_cap: 40, append_sent: false,
    });
    const t = newToken();
    await store.createToken(D, 'correo', t.hash, ['read', 'send'], null);
    const r = await api.call(t.token, 'send', { mailbox: DARIO, to: 'x@otro.test', subject: 'Hola', text: 'Ver https://lo-que-sea.test', idempotency_key: 'sin-sdr-1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await q(`select count(*)::int n from sdr.campana where client_id = $1`, [D])).rows[0].n, 0);
  } finally {
    await q(`delete from mailgw.client where id = $1`, [D]);
  }
});
