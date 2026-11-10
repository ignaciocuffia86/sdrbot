// OAuth y MCP del panel (docs/24 §3 y §4, etapa M1), de punta a punta contra el servidor local:
// el 401 con la metadata, DCR y CIMD, la página de ingreso con la contraseña del panel, el código
// de uso único, la renovación que rota (y que revoca todo si se reusa), el aislamiento entre
// clientes por las herramientas y las conexiones en el panel.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as store from '../src/store.mjs';
import { startServer } from '../src/server.mjs';
import { activate, createUser } from '../src/admin/auth.mjs';
import * as S from '../src/admin/servicio.mjs';
import { newToken } from '../src/crypto.mjs';
import { redirectPermitido, vaciarCacheCimd } from '../src/panel/oauth_util.mjs';

process.env.OAUTH_FIRMA ??= crypto.randomBytes(32).toString('base64');
// Los topes de uso los prueba test/aprobaciones_panel.test.mjs; acá van altos.
process.env.MAILGW_LIMITE_IP ??= '100000';
process.env.MAILGW_LIMITE_USUARIO ??= '100000';

const A = 'mcpp-a';
const B = 'mcpp-b';
const PW = 'contrasena-larga-del-panel';
const RU = 'http://127.0.0.1:33418/callback';
let server, base;
const u = {};

async function usuario(email, role, clientId) {
  const { user, setupToken } = await createUser({ email, name: email, role, clientId });
  await activate(setupToken, PW);
  return user;
}

before(async () => {
  await store.asOwner(async (c) => {
    for (const id of [A, B]) await c.query(`insert into mailgw.client (id, name) values ($1, $2) on conflict do nothing`, [id, `Cliente ${id}`]);
  });
  u.a = await usuario('ana@mcpp-a.test', 'client_admin', A);
  u.b = await usuario('beto@mcpp-b.test', 'client_admin', B);
  u.op = await usuario('op@mcpp-bigua.test', 'bigua_admin', null);
  server = await startServer(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const form = (o) => new URLSearchParams(o).toString();
const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: form(body),
});
const oculto = (html, nombre) => new RegExp(`name="${nombre}" value="([^"]+)"`).exec(html)?.[1]?.replace(/&amp;/g, '&');

async function mcp(token, method, params = {}, id = 1) {
  const res = await fetch(`${base}/mcp/panel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18',
      ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}
const tool = async (token, name, args = {}) => {
  const r = await mcp(token, 'tools/call', { name, arguments: args });
  assert.equal(r.status, 200);
  const res = r.body.result;
  return { isError: Boolean(res.isError), data: JSON.parse(res.content[0].text) };
};

async function registrar(extra = {}) {
  const r = await fetch(`${base}/oauth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [RU], ...extra }),
  });
  return { status: r.status, body: await r.json() };
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

// El flujo entero hasta el código: authorize → ingresar → autorizar.
async function autorizar(clientId, email, { challenge, state = 'st-1' } = {}) {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: RU, state,
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'panel offline_access' });
  const pag = await fetch(`${base}/oauth/authorize?${q}`);
  assert.equal(pag.status, 200);
  const pedido = oculto(await pag.text(), 'pedido');
  const ing = await post('/oauth/login', { pedido, paso: 'ingresar', email, password: PW });
  assert.equal(ing.status, 200);
  const html = await ing.text();
  const login = oculto(html, 'login');
  assert.ok(login, 'la página de consentimiento trae el ingreso firmado');
  const fin = await post('/oauth/login', { pedido, login, paso: 'autorizar' });
  assert.equal(fin.status, 302);
  return { location: new URL(fin.headers.get('location')), html };
}

async function conectar(email, extraRegistro) {
  const { body: cli } = await registrar(extraRegistro);
  const { verifier, challenge } = pkce();
  const { location } = await autorizar(cli.client_id, email, { challenge });
  const tok = await post('/oauth/token', { grant_type: 'authorization_code', code: location.searchParams.get('code'),
    code_verifier: verifier, client_id: cli.client_id, redirect_uri: RU,
    ...(cli.client_secret ? { client_secret: cli.client_secret } : {}) });
  assert.equal(tok.status, 200);
  return { cli, ...(await tok.json()) };
}

test('sin token: 401 también en el saludo, con la metadata del recurso', async () => {
  const r = await mcp(null, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(r.status, 401);
  const h = r.headers.get('www-authenticate');
  assert.match(h, /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource\/mcp\/panel"/);
  assert.doesNotMatch(h, /invalid_token/);
  const malo = await mcp('mgp_inventado', 'tools/list');
  assert.equal(malo.status, 401);
  assert.match(malo.headers.get('www-authenticate'), /invalid_token/);
});

test('metadata: el recurso es /mcp/panel y el servidor anuncia CIMD, DCR, iss y offline_access', async () => {
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp/panel`)).json();
  assert.equal(prm.resource, `${base}/mcp/panel`);
  assert.deepEqual(prm.authorization_servers, [base]);
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.issuer, base);
  assert.equal(as.registration_endpoint, `${base}/oauth/register`);
  assert.equal(as.client_id_metadata_document_supported, true);
  assert.equal(as.authorization_response_iss_parameter_supported, true);
  assert.ok(as.scopes_supported.includes('offline_access'));
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.equal((await fetch(`${base}/.well-known/openid-configuration`)).status, 404);
});

test('los redirect_uri: lista cerrada, sin trepar fuera del prefijo, loopback siempre', async () => {
  assert.equal(redirectPermitido('https://claude.ai/api/mcp/auth_callback'), true);
  assert.equal(redirectPermitido('https://claude.com/api/mcp/auth_callback'), true);
  assert.equal(redirectPermitido('https://chatgpt.com/connector/oauth/abc'), true);
  assert.equal(redirectPermitido('https://chatgpt.com/connector/oauth/'), false);
  assert.equal(redirectPermitido('https://chatgpt.com/connector/oauth/../../robo'), false);
  assert.equal(redirectPermitido('https://atacante.test/callback'), false);
  assert.equal(redirectPermitido('http://claude.ai/api/mcp/auth_callback'), false);
  assert.equal(redirectPermitido('http://localhost:5555/cb'), true);
  const r = await registrar({ redirect_uris: ['https://atacante.test/cb'] });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, 'invalid_redirect_uri');
  // Un authorize con un redirect_uri fuera de la lista no redirige a ningún lado.
  const { body: cli } = await registrar();
  const q = new URLSearchParams({ response_type: 'code', client_id: cli.client_id, redirect_uri: 'https://atacante.test/cb',
    code_challenge: pkce().challenge, code_challenge_method: 'S256' });
  const pag = await fetch(`${base}/oauth/authorize?${q}`, { redirect: 'manual' });
  assert.equal(pag.status, 400);
  assert.equal(pag.headers.get('location'), null);
});

test('la página de ingreso usa la contraseña del panel y el consentimiento dice el alcance', async () => {
  const { body: cli } = await registrar();
  const q = new URLSearchParams({ response_type: 'code', client_id: cli.client_id, redirect_uri: RU, state: 'x',
    code_challenge: pkce().challenge, code_challenge_method: 'S256' });
  const pag = await fetch(`${base}/oauth/authorize?${q}`);
  assert.match(pag.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const pedido = oculto(await pag.text(), 'pedido');
  const mal = await post('/oauth/login', { pedido, paso: 'ingresar', email: u.a.email, password: 'otra-contrasena-cualquiera' });
  assert.equal(mal.status, 400);
  assert.match(await mal.text(), /Email o contraseña incorrectos/);
  const ok = await post('/oauth/login', { pedido, paso: 'ingresar', email: u.a.email, password: PW });
  assert.match(await ok.text(), /Cliente mcpp-a/);
  // El ingreso de un pedido no autoriza otro.
  const q2 = new URLSearchParams(q);
  q2.set('state', 'otro-pedido');
  const otro = oculto(await (await fetch(`${base}/oauth/authorize?${q2}`)).text(), 'pedido');
  assert.notEqual(otro, pedido);
  const html = await (await post('/oauth/login', { pedido, paso: 'ingresar', email: u.a.email, password: PW })).text();
  const cruzado = await post('/oauth/login', { pedido: otro, login: oculto(html, 'login'), paso: 'autorizar' });
  assert.equal(cruzado.status, 400);
  // Cancelar vuelve al cliente con access_denied, el state y el iss.
  const can = await post('/oauth/login', { pedido, paso: 'cancelar' });
  const loc = new URL(can.headers.get('location'));
  assert.equal(loc.searchParams.get('error'), 'access_denied');
  assert.equal(loc.searchParams.get('state'), 'x');
  assert.equal(loc.searchParams.get('iss'), base);
  // El operador de Biguá ve «todos los clientes».
  const op = await post('/oauth/login', { pedido, paso: 'ingresar', email: u.op.email, password: PW });
  assert.match(await op.text(), /todos los clientes/);
});

test('el código: con iss y state, PKCE obligatorio y de un solo uso', async () => {
  const { body: cli } = await registrar();
  const { verifier, challenge } = pkce();
  const { location } = await autorizar(cli.client_id, u.a.email, { challenge, state: 'st-9' });
  assert.equal(location.origin + location.pathname, RU);
  assert.equal(location.searchParams.get('state'), 'st-9');
  assert.equal(location.searchParams.get('iss'), base);
  const code = location.searchParams.get('code');
  const canje = (v) => post('/oauth/token', { grant_type: 'authorization_code', code, code_verifier: v, client_id: cli.client_id });
  const ok = await canje(verifier);
  assert.equal(ok.status, 200);
  const t = await ok.json();
  assert.match(t.access_token, /^mgp_/);
  assert.match(t.refresh_token, /^mgr_/);
  assert.equal(t.expires_in, 3600);
  const otraVez = await canje(verifier);
  assert.equal(otraVez.status, 400);
  assert.equal((await otraVez.json()).error, 'invalid_grant');
  // Verifier equivocado, en un código nuevo.
  const p2 = pkce();
  const { location: l2 } = await autorizar(cli.client_id, u.a.email, { challenge: p2.challenge });
  const malo = await post('/oauth/token', { grant_type: 'authorization_code', code: l2.searchParams.get('code'),
    code_verifier: pkce().verifier, client_id: cli.client_id });
  assert.equal(malo.status, 400);
  // Un código de un cliente no lo canjea otro.
  const { body: otro } = await registrar({ client_name: 'Otro cliente' });
  assert.notEqual(otro.client_id, cli.client_id);
  const p3 = pkce();
  const { location: l3 } = await autorizar(cli.client_id, u.a.email, { challenge: p3.challenge });
  const ajeno = await post('/oauth/token', { grant_type: 'authorization_code', code: l3.searchParams.get('code'),
    code_verifier: p3.verifier, client_id: otro.client_id });
  assert.equal(ajeno.status, 400);
});

test('un cliente registrado con secreto tiene que mandarlo', async () => {
  const { cli, access_token: at, refresh_token: rt } = await conectar(u.a.email, { token_endpoint_auth_method: 'client_secret_post' });
  assert.match(cli.client_secret, /^mgc_/);
  assert.equal((await mcp(at, 'tools/list')).status, 200);
  const sin = await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: rt, client_id: cli.client_id });
  assert.equal(sin.status, 401);
  const basic = Buffer.from(`${encodeURIComponent(cli.client_id)}:${encodeURIComponent(cli.client_secret)}`).toString('base64');
  const con = await post('/oauth/token', { grant_type: 'refresh_token', refresh_token: rt }, { authorization: `Basic ${basic}` });
  assert.equal(con.status, 200);
});

test('herramientas: el cliente ve sólo su cliente; Biguá, todos', async () => {
  const { access_token: ta } = await conectar(u.a.email);
  const { access_token: top } = await conectar(u.op.email);
  const listaA = (await mcp(ta, 'tools/list')).body.result.tools;
  const nombres = listaA.map((t) => t.name);
  assert.ok(nombres.includes('resumen') && nombres.includes('aprobaciones_listar') && nombres.includes('campanas_listar'));
  assert.ok(!nombres.includes('clientes_listar'));
  // Todas de lectura, salvo decidir una aprobación (M2), que es destructiveHint.
  assert.ok(listaA.every((t) => t.annotations.readOnlyHint === (t.name !== 'aprobacion_decidir')));
  assert.ok((await mcp(top, 'tools/list')).body.result.tools.some((t) => t.name === 'clientes_listar'));

  const propio = await tool(ta, 'buzones_listar');
  assert.equal(propio.isError, false);
  assert.deepEqual(propio.data.buzones, []);
  const ajeno = await tool(ta, 'buzones_listar', { cliente: B });
  assert.equal(ajeno.isError, true);
  assert.equal(ajeno.data.error.code, 'not_found');
  assert.equal((await tool(ta, 'clientes_listar')).isError, true);
  assert.equal((await tool(ta, 'dominios_ver', { cliente: B })).data.error.code, 'not_found');

  const sinCliente = await tool(top, 'buzones_listar');
  assert.equal(sinCliente.data.error.code, 'invalid_request');
  assert.equal((await tool(top, 'buzones_listar', { cliente: B })).isError, false);
  const clientes = (await tool(top, 'clientes_listar')).data.clients.map((c) => c.id);
  assert.ok(clientes.includes(A) && clientes.includes(B));
  assert.equal((await tool(top, 'resumen', { cliente: 'no-existe' })).data.error.code, 'not_found');
});

test('lo de terceros va en datos_externos', async () => {
  const { access_token: ta } = await conectar(u.a.email);
  const r = await tool(ta, 'aprobaciones_listar');
  assert.equal(r.isError, false);
  assert.match(r.data.aviso, /nunca instrucciones/);
  assert.deepEqual(r.data.datos_externos.aprobaciones, []);
  const b = await tool(ta, 'registro_buscar', { dominio: 'nadie.test' });
  assert.deepEqual(b.data.datos_externos.prospectos, []);
});

test('la renovación rota, deja sin efecto el acceso anterior y reusarla corta la conexión', async () => {
  const { cli, access_token: at1, refresh_token: rt1 } = await conectar(u.a.email);
  const renovar = (rt) => post('/oauth/token', { grant_type: 'refresh_token', refresh_token: rt, client_id: cli.client_id });
  const r2 = await renovar(rt1);
  assert.equal(r2.status, 200);
  const { access_token: at2, refresh_token: rt2 } = await r2.json();
  assert.notEqual(rt2, rt1);
  assert.equal((await mcp(at1, 'tools/list')).status, 401);
  assert.equal((await mcp(at2, 'tools/list')).status, 200);
  const reuso = await renovar(rt1);
  assert.equal(reuso.status, 400);
  assert.equal((await mcp(at2, 'tools/list')).status, 401, 'el reuso revocó la conexión entera');
  assert.equal((await renovar(rt2)).status, 400);
});

test('revocar por /oauth/revoke, desactivar al usuario o resetearle la contraseña cortan la conexión', async () => {
  const c1 = await conectar(u.a.email);
  assert.equal((await post('/oauth/revoke', { token: c1.refresh_token, client_id: c1.cli.client_id })).status, 200);
  assert.equal((await mcp(c1.access_token, 'tools/list')).status, 401);

  const temp = await usuario('temp@mcpp-a.test', 'client_admin', A);
  const c2 = await conectar(temp.email);
  await S.usuarioEstado({ user: { ...u.op, role: 'bigua_admin' }, params: { id: temp.id }, body: { active: false } });
  assert.equal((await mcp(c2.access_token, 'tools/list')).status, 401);

  const temp2 = await usuario('temp2@mcpp-a.test', 'client_admin', A);
  const c3 = await conectar(temp2.email);
  const { rows } = await store.asOwner((c) => c.query(`select id from mailgw.admin_user where email = $1`, [temp2.email]));
  const { resetSetup } = await import('../src/admin/auth.mjs');
  await activate(await resetSetup(rows[0].id), 'otra-contrasena-larga-1');
  assert.equal((await mcp(c3.access_token, 'tools/list')).status, 401);
});

test('después de un reset no sirven ni el ingreso firmado ni el código de antes (Vercel #18)', async () => {
  const temp = await usuario('temp3@mcpp-a.test', 'client_admin', A);
  const { body: cli } = await registrar();
  const { resetSetup } = await import('../src/admin/auth.mjs');

  // Un código pedido con la contraseña vieja y todavía sin canjear.
  const p1 = pkce();
  const { location } = await autorizar(cli.client_id, temp.email, { challenge: p1.challenge });
  // Y un ingreso firmado con la contraseña vieja, sin autorizar todavía.
  const q = new URLSearchParams({ response_type: 'code', client_id: cli.client_id, redirect_uri: RU, state: 's',
    code_challenge: pkce().challenge, code_challenge_method: 'S256', scope: 'panel offline_access' });
  const pedido = oculto(await (await fetch(`${base}/oauth/authorize?${q}`)).text(), 'pedido');
  const login = oculto(await (await post('/oauth/login', { pedido, paso: 'ingresar', email: temp.email, password: PW })).text(), 'login');
  assert.ok(login);

  await activate(await resetSetup(temp.id), 'otra-contrasena-larga-2');

  const canje = await post('/oauth/token', { grant_type: 'authorization_code', code: location.searchParams.get('code'),
    code_verifier: p1.verifier, client_id: cli.client_id });
  assert.equal(canje.status, 400, 'el código de antes del reset quedó sin efecto');
  const fin = await post('/oauth/login', { pedido, login, paso: 'autorizar' });
  assert.notEqual(fin.status, 302, 'no redirige con un código');
  assert.equal(fin.headers.get('location'), null);
  assert.match(await fin.text(), /La contraseña cambió/);
  assert.equal((await store.asOwner((c) => c.query(
    `select count(*)::int as n from mailgw.oauth_code where user_id = $1 and used_at is null`, [temp.id]))).rows[0].n, 0);
});

test('desconectar mientras se renueva revoca también el par que se está emitiendo (Vercel #19)', async () => {
  const c0 = await conectar(u.a.email);
  const fam = (await store.asOwner((c) => c.query(`select familia from mailgw.oauth_token where token_hash = $1`,
    [crypto.createHash('sha256').update(c0.refresh_token).digest('hex')]))).rows[0].familia;
  // Una renovación a medio hacer: tomó el usuario (como /oauth/token) y ya insertó un par nuevo.
  const pool = store.getPool();
  const ren = await pool.connect();
  const nuevo = crypto.randomBytes(16).toString('hex');
  await ren.query('begin');
  await ren.query(`select 1 from mailgw.admin_user where id = (select user_id from mailgw.oauth_token where familia = $1 limit 1) for no key update`, [fam]);
  await ren.query(`insert into mailgw.oauth_token (token_hash, tipo, familia, client_id, cliente_nombre, user_id, expires_at)
    select $1, 'renovacion', familia, client_id, cliente_nombre, user_id, now() + interval '1 day'
      from mailgw.oauth_token where familia = $2 limit 1`, [nuevo, fam]);
  // La desconexión llega en el medio: tiene que esperar a la renovación.
  let termino = false;
  const desconectar = S.conexionRevocar({ user: { ...u.a }, params: { id: fam } }).then((r) => { termino = true; return r; });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(termino, false, 'la desconexión espera a la renovación en curso');
  await ren.query('commit');
  ren.release();
  await desconectar;
  const { rows } = await store.asOwner((c) => c.query(`select revoked_at from mailgw.oauth_token where token_hash = $1`, [nuevo]));
  assert.ok(rows[0].revoked_at, 'el par emitido durante la desconexión también quedó revocado');
});

test('un token de un MCP no sirve en el otro', async () => {
  const { access_token: at } = await conectar(u.a.email);
  const r = await fetch(`${base}/mcp`, { method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${at}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  assert.equal(r.status, 401);
  const { token, hash } = newToken();
  await store.asOwner((c) => c.query(`insert into mailgw.token (client_id, name, token_hash, scopes, expires_at)
    values ($1, 'bot', $2, '{read,sdr}', now() + interval '1 day')`, [A, hash]));
  assert.equal((await mcp(token, 'tools/list')).status, 401);
});

test('conexiones en el panel: cada uno ve y desconecta las suyas; Biguá, todas', async () => {
  const c = await conectar(u.b.email);
  const deB = { ...u.b };
  const lista = (await S.conexionesListar({ user: deB })).conexiones;
  assert.ok(lista.length >= 1 && lista.every((x) => x.email === u.b.email));
  assert.equal(lista[0].cliente_oauth, 'Claude');
  const deA = (await S.conexionesListar({ user: { ...u.a } })).conexiones;
  assert.ok(deA.every((x) => x.email === u.a.email));
  // A no puede desconectar la de B.
  await assert.rejects(S.conexionRevocar({ user: { ...u.a }, params: { id: lista[0].id } }), (e) => e.code === 'not_found');
  const todas = (await S.conexionesListar({ user: { ...u.op } })).conexiones;
  assert.ok(todas.some((x) => x.email === u.b.email) && todas.some((x) => x.email === u.a.email));
  for (const x of lista) await S.conexionRevocar({ user: deB, params: { id: x.id } });
  assert.equal((await mcp(c.access_token, 'tools/list')).status, 401);
  assert.equal((await S.conexionesListar({ user: deB })).conexiones.length, 0);
});

test('CIMD: el documento tiene que decir su propia URL y declarar el retorno', async () => {
  const URL_DOC = 'https://claude.ai/oauth/claude-code-client-metadata';
  const real = globalThis.fetch;
  let doc = { client_id: URL_DOC, client_name: 'Claude Code', redirect_uris: ['http://localhost/callback'] };
  globalThis.fetch = async (url, opts) => (String(url) === URL_DOC
    ? new Response(JSON.stringify(doc), { headers: { 'content-type': 'application/json' } })
    : real(url, opts));
  try {
    vaciarCacheCimd();
    const { verifier, challenge } = pkce();
    const q = new URLSearchParams({ response_type: 'code', client_id: URL_DOC, redirect_uri: 'http://localhost:40123/callback',
      code_challenge: challenge, code_challenge_method: 'S256', state: 's' });
    const pag = await real(`${base}/oauth/authorize?${q}`);
    assert.equal(pag.status, 200);
    const html = await pag.text();
    assert.match(html, /Claude Code/);
    const pedido = oculto(html, 'pedido');
    const ing = await (await post('/oauth/login', { pedido, paso: 'ingresar', email: u.a.email, password: PW })).text();
    const fin = await post('/oauth/login', { pedido, login: oculto(ing, 'login'), paso: 'autorizar' });
    const code = new URL(fin.headers.get('location')).searchParams.get('code');
    const tok = await post('/oauth/token', { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: URL_DOC });
    assert.equal(tok.status, 200);
    // Un documento que dice ser de otra URL no vale.
    vaciarCacheCimd();
    doc = { ...doc, client_id: 'https://claude.ai/otro' };
    assert.equal((await real(`${base}/oauth/authorize?${q}`)).status, 400);
    // Un host que no está en la lista no se lee.
    const q2 = new URLSearchParams({ response_type: 'code', client_id: 'https://atacante.test/doc', redirect_uri: RU,
      code_challenge: challenge, code_challenge_method: 'S256' });
    assert.equal((await real(`${base}/oauth/authorize?${q2}`)).status, 400);
  } finally {
    globalThis.fetch = real;
    vaciarCacheCimd();
  }
});
