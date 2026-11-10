// Etapa M2 del MCP del panel (docs/24 §5): el cliente aprueba sus mensajes, desde el panel o desde
// Claude. Quién decide por cliente (aprueba), lo que puede cada uno, primero gana, el destinatario
// que no se cambia, la vista previa antes de confirmar, lo que ven los bots, el envío real con lo
// aprobado por el cliente, y los límites de uso del MCP y del OAuth.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as store from '../src/store.mjs';
import * as sdr from '../src/sdr/store.mjs';
import * as S from '../src/admin/servicio.mjs';
import { activate, createUser } from '../src/admin/auth.mjs';
import { newToken, aadFor, encryptSecret } from '../src/crypto.mjs';
import { startServer } from '../src/server.mjs';
import { startSmtp, gw, HOST, PORTS, USERS } from './helpers.mjs';

process.env.OAUTH_FIRMA ??= crypto.randomBytes(32).toString('base64');

const C = 'apr-a';
const OTRO = 'apr-b';
const BUZON = 'dario@cliente.test';
const PW = 'contrasena-larga-del-panel';
let server, smtp, api, base, tok;
const u = {};
const ids = {};

async function usuario(email, role, clientId) {
  const { user, setupToken } = await createUser({ email, name: email, role, clientId });
  await activate(setupToken, PW);
  return user;
}

before(async () => {
  smtp = await startSmtp();
  server = await startServer(0);
  base = `http://127.0.0.1:${server.address().port}`;
  api = gw(base);
  await store.upsertClient(C, 'Cliente Aprobaciones');
  await store.upsertClient(OTRO, 'Otro cliente');
  await store.upsertAccount({
    client_id: C, email: BUZON, display_name: 'Darío', username: BUZON,
    secret_enc: encryptSecret(USERS[BUZON], aadFor(C, BUZON)),
    imap_host: HOST, imap_port: PORTS.imaps, imap_security: 'tls',
    smtp_host: HOST, smtp_port: PORTS.smtps, smtp_security: 'tls',
    timezone: 'America/Argentina/Buenos_Aires', daily_send_cap: 40, append_sent: false,
  });
  await sdr.setConfig(C, { bots_activos: ['orquestador', 'prospector'], calibracion_mails: 3 });
  const { token: t, hash } = newToken();
  await store.createToken(C, 'bots', hash, ['read', 'send', 'sdr'], null);
  tok = t;
  u.cli = await usuario('ana@apr-a.test', 'client_admin', C);
  u.otro = await usuario('beto@apr-b.test', 'client_admin', OTRO);
  u.op = await usuario('op@apr-bigua.test', 'bigua_admin', null);
});

after(async () => {
  await new Promise((r) => server.close(r));
  await smtp.close();
});

async function ok(op, body) {
  const r = await api.call(tok, op, body);
  assert.equal(r.status, 200, `${op}: ${JSON.stringify(r.body.error)}`);
  return r.body.data;
}
const call = async (op, body) => { const r = await api.call(tok, op, body); return { status: r.status, error: r.body.error, data: r.body.data }; };

let n = 0;
async function pedir(tipo = 'calibracion_mail', extra = {}) {
  n += 1;
  const email = `persona${n}@prospecto.test`;
  const p = await ok('registro_guardar_prospecto', { bot: 'prospector', nombre: `Persona ${n}`, email });
  const contenido = tipo === 'crm_mapeo'
    ? { contexto: 'mapeo de campos', datos: { a: 1 } }
    : { buzon: BUZON, destinatario: email, asunto: `Asunto ${n}`, texto: `Hola, persona ${n}.\nTexto original.` };
  const ap = await ok('registro_pedir_aprobacion', { bot: 'prospector', tipo, prospecto_id: p.prospecto.id, contenido, ...extra });
  return { id: ap.aprobacion.id, prospecto: p.prospecto.id, email, contenido };
}
const aprueba = (valor) => sdr.setConfig(C, { aprueba: valor });
const decidir = (user, id, body, via) => S.aprobacionDecidir({ user, params: { client: C, id }, body, via });

test('los clientes de antes quedan en «bigua»; un cliente nuevo arranca en «cliente_y_bigua»', async () => {
  const { rows } = await store.asOwner((c) => c.query(`select aprueba from sdr.cliente_config where client_id = $1`, [C]));
  assert.equal(rows[0].aprueba, 'cliente_y_bigua', 'setConfig crea la configuración con el valor por defecto nuevo');
  const def = (await store.asOwner((c) => c.query(
    `select column_default from information_schema.columns where table_schema = 'sdr' and table_name = 'cliente_config' and column_name = 'aprueba'`))).rows[0];
  assert.match(def.column_default, /cliente_y_bigua/);
});

test('con aprueba = bigua el cliente ve, pero no decide; los bots ven todo como hasta hoy', async () => {
  await aprueba('bigua');
  const a = await pedir();
  const lista = await S.aprobacionesListar({ user: u.cli, params: { client: C } });
  const x = lista.aprobaciones.find((y) => y.id === a.id);
  assert.equal(lista.aprueba, 'bigua');
  assert.deepEqual([x.puede.aprobar, x.puede.rechazar], [false, false]);
  await assert.rejects(decidir(u.cli, a.id, { decision: 'aprobada', confirmar: true }), (e) => e.code === 'no_permitido');
  assert.ok((await ok('registro_aprobaciones', {})).aprobaciones.some((y) => y.id === a.id));
  // Biguá desde el panel sí decide, y queda quién y por dónde.
  const r = await decidir(u.op, a.id, { decision: 'rechazada', nota: 'no', confirmar: true });
  assert.equal(r.aprobacion.decidida_por_rol, 'bigua');
  assert.equal(r.aprobacion.decidida_via, 'panel');
  assert.equal(r.aprobacion.decidida_por, u.op.email);
  ids.decididaPorBigua = a.id;
});

test('con aprueba = cliente_y_bigua el cliente aprueba con correcciones; primero gana', async () => {
  await aprueba('cliente_y_bigua');
  const a = await pedir();
  ids.delCliente = a;
  // Vista previa: no decide nada.
  const previa = await decidir(u.cli, a.id, { decision: 'aprobada', texto: 'Hola.\nTexto corregido por el cliente.' });
  assert.equal(previa.simulada, true);
  assert.equal(previa.contenido_final.texto, 'Hola.\nTexto corregido por el cliente.');
  assert.equal(previa.contenido_final.destinatario, a.email);
  assert.equal((await sdr.aprobaciones(C, { estado: 'pendiente', limite: 100 })).aprobaciones.some((y) => y.id === a.id), true);
  // El destinatario no se cambia.
  await assert.rejects(decidir(u.cli, a.id, { decision: 'aprobada', destinatario: 'otra@prospecto.test', confirmar: true }),
    (e) => e.code === 'no_permitido' && /destinatario/.test(e.message));
  // Decide de verdad.
  const r = await decidir(u.cli, a.id, { decision: 'aprobada', texto: 'Hola.\nTexto corregido por el cliente.', confirmar: true }, 'mcp_panel');
  assert.equal(r.aprobacion.estado, 'aprobada');
  assert.equal(r.aprobacion.decidida_por_rol, 'cliente');
  assert.equal(r.aprobacion.decidida_via, 'mcp_panel');
  assert.equal(r.aprobacion.decidida_por_usuario, u.cli.id);
  // Primero gana: el orquestador llega tarde y ve quién se le adelantó.
  const tarde = await call('registro_aprobar', { id: a.id, decision: 'rechazada', operador: 'Ignacio', bot: 'orquestador' });
  assert.equal(tarde.error.code, 'ya_decidida');
  assert.match(tarde.error.message, /ana@apr-a\.test, del cliente/);
  // El orquestador recibe el pedido para contárselo al operador; el evento dice rol y vía.
  const orq = await ok('registro_pendientes', { bot: 'orquestador' });
  assert.ok(orq.pedidos.some((p) => /El cliente aprobó desde el panel/.test(p.que) && p.que.includes(a.id)));
  const h = await ok('registro_historia', { prospecto_id: a.prospecto });
  const ev = h.eventos.find((e) => e.tipo === 'aprobacion.decidida');
  assert.equal(ev.datos.rol, 'cliente');
  assert.equal(ev.datos.via, 'mcp_panel');
  // El prospector la tiene para ejecutar.
  assert.ok((await ok('registro_pendientes', { bot: 'prospector' })).aprobaciones_para_ejecutar.some((y) => y.id === a.id));
});

test('lo que aprobó el cliente es lo único que sale: el gateway hace cumplir el texto corregido', async () => {
  const a = ids.delCliente;
  const mail = (text) => ({ mailbox: BUZON, to: a.email, subject: a.contenido.asunto, text, prospecto_id: a.prospecto,
    bot: 'prospector', tarea: 'diaria', idempotency_key: `${a.prospecto}:mail-1`, aprobacion_id: a.id });
  const original = await call('send', mail(a.contenido.texto));
  assert.equal(original.error.code, 'aprobacion_no_coincide');
  const antes = smtp.received.length;
  await ok('send', mail('Hola.\nTexto corregido por el cliente.'));
  assert.equal(smtp.received.length, antes + 1);
  assert.match(smtp.received.at(-1).raw, /Texto corregido por el cliente/);
});

test('con aprueba = cliente, Biguá sólo rechaza y el orquestador no las presenta', async () => {
  await aprueba('cliente');
  const a = await pedir();
  const b = await pedir();
  const orq = await ok('registro_pendientes', { bot: 'orquestador' });
  assert.ok(!orq.aprobaciones_por_decidir.some((y) => y.id === a.id));
  assert.ok(orq.aprobaciones_del_cliente.n >= 2);
  assert.ok(!(await ok('registro_aprobaciones', {})).aprobaciones.some((y) => y.id === a.id));
  const chat = await call('registro_aprobar', { id: a.id, decision: 'aprobada', operador: 'Ignacio', bot: 'orquestador' });
  assert.equal(chat.error.code, 'no_permitido');
  await assert.rejects(decidir(u.op, a.id, { decision: 'aprobada', confirmar: true }), (e) => e.code === 'no_permitido');
  // Biguá puede frenar.
  const frenada = await ok('registro_aprobar', { id: a.id, decision: 'rechazada', operador: 'Ignacio', nota: 'no a esta persona', bot: 'orquestador' });
  assert.equal(frenada.aprobacion.decidida_por_rol, 'bigua');
  assert.equal(frenada.aprobacion.decidida_via, 'chat');
  // El cliente decide la otra.
  assert.equal((await decidir(u.cli, b.id, { decision: 'rechazada', nota: 'mal tono', confirmar: true })).aprobacion.estado, 'rechazada');
});

test('lo que no es un mensaje es siempre de Biguá', async () => {
  await aprueba('cliente');
  const m = await pedir('crm_mapeo');
  const lista = await S.aprobacionesListar({ user: u.cli, params: { client: C } });
  assert.equal(lista.aprobaciones.find((y) => y.id === m.id).puede.aprobar, false);
  await assert.rejects(decidir(u.cli, m.id, { decision: 'aprobada', confirmar: true }), (e) => e.code === 'no_permitido');
  assert.ok((await ok('registro_aprobaciones', {})).aprobaciones.some((y) => y.id === m.id), 'el orquestador la presenta');
  assert.equal((await decidir(u.op, m.id, { decision: 'aprobada', confirmar: true })).aprobacion.estado, 'aprobada');
});

test('un usuario de otro cliente no ve ni decide', async () => {
  await aprueba('cliente_y_bigua');
  const a = await pedir();
  await assert.rejects(S.aprobacionesListar({ user: u.otro, params: { client: C } }), (e) => e.code === 'not_found');
  await assert.rejects(S.aprobacionDecidir({ user: u.otro, params: { client: C, id: a.id }, body: { decision: 'aprobada', confirmar: true } }),
    (e) => e.code === 'not_found');
  // Ni pasando su propio cliente con una aprobación ajena: no existe ahí.
  await sdr.setConfig(OTRO, { bots_activos: ['orquestador'] });
  await assert.rejects(S.aprobacionDecidir({ user: u.otro, params: { client: OTRO, id: a.id }, body: { decision: 'aprobada', confirmar: true } }),
    (e) => e.code === 'no_existe' || e.code === 'not_found');
});

test('Biguá fija quién aprueba desde el panel', async () => {
  const r = await S.sdrConfig({ user: u.op, params: { client: C }, body: { aprueba: 'cliente' } });
  assert.equal(r.sdr.tecnico.aprueba, 'cliente');
  await assert.rejects(S.sdrConfig({ user: u.cli, params: { client: C }, body: { aprueba: 'cliente' } }), (e) => e.code === 'forbidden');
  await assert.rejects(S.sdrConfig({ user: u.op, params: { client: C }, body: { aprueba: 'todos' } }), (e) => e.code === 'invalid_request');
  await aprueba('cliente_y_bigua');
});

// ---------------------------------------------------------------- por el MCP y la web

const form = (o) => new URLSearchParams(o).toString();
const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
  method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: form(body),
});
const oculto = (html, nombre) => new RegExp(`name="${nombre}" value="([^"]+)"`).exec(html)?.[1]?.replace(/&amp;/g, '&');

async function conectar(email) {
  const RU = 'http://127.0.0.1:33419/cb';
  const reg = await (await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: `Claude ${crypto.randomUUID()}`, redirect_uris: [RU] }) })).json();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: RU, code_challenge: challenge, code_challenge_method: 'S256' });
  const pedido = oculto(await (await fetch(`${base}/oauth/authorize?${q}`)).text(), 'pedido');
  const login = oculto(await (await post('/oauth/login', { pedido, paso: 'ingresar', email, password: PW })).text(), 'login');
  const fin = await post('/oauth/login', { pedido, login, paso: 'autorizar' });
  const code = new URL(fin.headers.get('location')).searchParams.get('code');
  return (await (await post('/oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id })).json()).access_token;
}

async function mcp(token, method, params = {}, headers = {}) {
  const res = await fetch(`${base}/mcp/panel`, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
const tool = async (token, name, args) => {
  const r = await mcp(token, 'tools/call', { name, arguments: args });
  return { status: r.status, isError: Boolean(r.body?.result?.isError), data: r.body?.result ? JSON.parse(r.body.result.content[0].text) : r.body };
};

test('MCP: aprobacion_decidir pide confirmar, es destructiveHint y decide como el cliente', async () => {
  const at = await conectar(u.cli.email);
  const herramienta = (await mcp(at, 'tools/list')).body.result.tools.find((t) => t.name === 'aprobacion_decidir');
  assert.equal(herramienta.annotations.destructiveHint, true);
  assert.equal(herramienta.annotations.readOnlyHint, false);
  assert.ok(!('destinatario' in herramienta.inputSchema.properties), 'el destinatario no se ofrece');
  const a = await pedir();
  const lista = await tool(at, 'aprobaciones_listar', {});
  assert.equal(lista.data.aprueba, 'cliente_y_bigua');
  assert.ok(lista.data.datos_externos.aprobaciones.find((y) => y.id === a.id).puede.aprobar);
  const previa = await tool(at, 'aprobacion_decidir', { id: a.id, decision: 'aprobada' });
  assert.equal(previa.data.simulada, true);
  assert.match(previa.data.confirmar, /confirmar: true/);
  const r = await tool(at, 'aprobacion_decidir', { id: a.id, decision: 'aprobada', confirmar: true });
  assert.equal(r.data.decidida, 'aprobada');
  const fila = (await sdr.aprobaciones(C, { estado: 'aprobada', limite: 100 })).aprobaciones.find((y) => y.id === a.id);
  assert.equal(fila.decidida_via, 'mcp_panel');
});

test('web: la pestaña Aprobaciones lista y decide con la cookie del panel', async () => {
  const a = await pedir();
  const login = await fetch(`${base}/admin/api/login`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mailgw-admin': '1' }, body: JSON.stringify({ email: u.cli.email, password: PW }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const h = { 'x-mailgw-admin': '1', cookie, 'content-type': 'application/json' };
  const lista = await (await fetch(`${base}/admin/api/clients/${C}/aprobaciones`, { headers: h })).json();
  assert.ok(lista.data.aprobaciones.some((y) => y.id === a.id));
  const r = await (await fetch(`${base}/admin/api/clients/${C}/aprobaciones/${a.id}/decidir`, { method: 'POST', headers: h,
    body: JSON.stringify({ decision: 'rechazada', nota: 'no', confirmar: true }) })).json();
  assert.equal(r.data.aprobacion.decidida_via, 'panel');
  const ajena = await fetch(`${base}/admin/api/clients/${OTRO}/aprobaciones`, { headers: h });
  assert.equal(ajena.status, 404);
});

test('límites: por usuario en /mcp/panel, por cambios y por IP en /oauth', async () => {
  const at = await conectar(u.op.email);
  process.env.MAILGW_LIMITE_USUARIO = '3';
  try {
    const estados = [];
    for (let i = 0; i < 5; i++) estados.push((await mcp(at, 'tools/list')).status);
    assert.ok(estados.slice(0, 3).every((s) => s === 200) && estados.at(-1) === 429, estados.join(','));
  } finally { delete process.env.MAILGW_LIMITE_USUARIO; }

  // Un usuario nuevo: los cambios de las pruebas anteriores cuentan en el mismo minuto.
  const nuevo = await usuario('carla@apr-a.test', 'client_admin', C);
  const atCli = await conectar(nuevo.email);
  process.env.MAILGW_LIMITE_CAMBIOS = '1';
  try {
    const a = await pedir();
    const b = await pedir();
    assert.equal((await tool(atCli, 'aprobacion_decidir', { id: a.id, decision: 'rechazada' })).isError, false);
    const segundo = await tool(atCli, 'aprobacion_decidir', { id: b.id, decision: 'rechazada' });
    assert.equal(segundo.data.error.code, 'rate_limited');
  } finally { delete process.env.MAILGW_LIMITE_CAMBIOS; }

  process.env.MAILGW_LIMITE_IP = '2';
  try {
    const ip = { 'x-forwarded-for': `203.0.113.${Math.floor(Math.random() * 200) + 1}` };
    const estados = [];
    for (let i = 0; i < 3; i++) estados.push((await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: 'x', client_id: 'x' }, ip)).status);
    assert.equal(estados.at(-1), 429);
  } finally { delete process.env.MAILGW_LIMITE_IP; }
});

test('Origin: uno desconocido se rechaza; los de Claude y loopback pasan', async () => {
  const at = await conectar(u.op.email);
  assert.equal((await mcp(at, 'tools/list', {}, { origin: 'https://atacante.test' })).status, 403);
  assert.equal((await mcp(at, 'tools/list', {}, { origin: 'https://claude.ai' })).status, 200);
  assert.equal((await mcp(at, 'tools/list', {}, { origin: 'http://localhost:6274' })).status, 200);
  assert.equal((await mcp(at, 'tools/list')).status, 200);
});
