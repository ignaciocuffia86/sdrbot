// Servidor de autorización OAuth del MCP del panel (docs/23 §3). La persona conecta Claude con su
// usuario y su contraseña del panel; el token que sale de acá sólo sirve en /mcp/panel.
//
//   GET  /.well-known/oauth-protected-resource[/mcp/panel]   metadata del recurso (RFC 9728)
//   GET  /.well-known/oauth-authorization-server             metadata del servidor (RFC 8414)
//   POST /oauth/register     registro dinámico (RFC 7591), sin guardar nada
//   GET  /oauth/authorize    valida el pedido y muestra la página de ingreso
//   POST /oauth/login        los pasos de la página: ingresar, autorizar o cancelar
//   POST /oauth/token        canje del código y renovación
//   POST /oauth/revoke       revocar (RFC 7009)
//
// Sigue al OAuth de ASCI (repo locasci, api/oauth.mjs y docs/32): CIMD y DCR, `iss` en toda
// respuesta de /authorize, el estado de la página firmado en el formulario (sin cookies ni
// sesión). Lo distinto: se entra con la contraseña del panel, y el código y los tokens van a la
// base (015), para que el código sea de uso único y una conexión se pueda ver y desconectar.

import crypto from 'node:crypto';
import { getPool } from '../store.mjs';
import { verificarCredenciales } from '../admin/auth.mjs';
import {
  clienteCimd, clienteRegistrado, credencialesBasic, emisor, escapar, esClienteCimd, firmar, nombreLimpio,
  pkceCoincide, redirectDeclarado, redirectPermitido, secretoCliente, sha256, verificar,
} from './oauth_util.mjs';

export const RUTA_MCP = '/mcp/panel';
const VIDA_PEDIDO_S = 900;      // de abrir la página a autorizar
const VIDA_LOGIN_S = 600;       // del ingreso a apretar «Autorizar»
const VIDA_CODIGO_S = 300;
const VIDA_ACCESO_S = 3600;     // 1 hora: un token puede aprobar mensajes desde M2 (docs/23 §3.4)
const VIDA_RENOVACION_S = 30 * 86400;

const q = (text, params) => getPool().query(text, params);
const ahora = () => Math.floor(Date.now() / 1000);
const agenteDe = (req) => String(req.headers?.['user-agent'] ?? '').slice(0, 80);
const log = (que, datos) => console.log(`[oauth] ${que}`, JSON.stringify(datos));

// No hay cookies, así que una página cualquiera no tiene nada que mandar en nombre del usuario.
// Hay clientes que leen la metadata y canjean desde el navegador.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, accept, mcp-protocol-version',
  'Access-Control-Max-Age': '86400',
};

function json(res, codigo, cuerpo, cabeceras = {}) {
  res.statusCode = codigo;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(cabeceras)) res.setHeader(k, v);
  res.end(JSON.stringify(cuerpo));
}
const errorOauth = (res, codigo, error, descripcion, cabeceras) => json(res, codigo, { error, error_description: descripcion }, cabeceras);

function redirigir(res, uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, v);
  res.statusCode = 302;
  res.setHeader('Location', u.toString());
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

async function leerCuerpo(req) {
  const b = req.body;
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  if (typeof b === 'string' || Buffer.isBuffer(b)) return String(b);
  const trozos = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > 16384) throw Object.assign(new Error('Cuerpo demasiado grande.'), { status: 413 });
    trozos.push(c);
  }
  return Buffer.concat(trozos).toString('utf8');
}
const leerFormulario = async (req) => {
  const b = await leerCuerpo(req);
  return new URLSearchParams(typeof b === 'string' ? b : Object.entries(b).map(([k, v]) => [k, String(v)]));
};
const leerJson = async (req) => {
  const b = await leerCuerpo(req);
  return typeof b === 'string' ? JSON.parse(b || '{}') : b;
};

// ---------------------------------------------------------------- metadata

// `resource` tiene que coincidir con la URL que cargó el usuario: los clientes piden la metadata
// con el mismo sufijo. El recurso es /mcp/panel; el MCP de los bots (/mcp) no pasa por OAuth.
export const urlMetadataRecurso = (req) => `${emisor(req)}/.well-known/oauth-protected-resource${RUTA_MCP}`;

function metadataRecurso(req) {
  const base = emisor(req);
  return {
    resource: `${base}${RUTA_MCP}`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: ['panel'],
  };
}

// Sin /.well-known/openid-configuration, a propósito: esto no es OpenID (en ASCI, publicarlo hizo
// que ChatGPT ofreciera «OIDC habilitado»). `offline_access` en la lista: Claude lo pide sólo si
// el servidor lo publica, y es lo que le dice que va a recibir un token de renovación.
function metadataServidor(req) {
  const base = emisor(req);
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    client_id_metadata_document_supported: true,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    authorization_response_iss_parameter_supported: true,
    scopes_supported: ['panel', 'offline_access'],
  };
}

// ---------------------------------------------------------------- registro (DCR)

// No guarda nada: el client_id ES el registro, firmado. Los redirect_uri pasan por la lista.
async function registrar(req, res) {
  let m;
  try { m = await leerJson(req); } catch { return errorOauth(res, 400, 'invalid_client_metadata', 'El cuerpo tiene que ser JSON.'); }
  const uris = m?.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => typeof u === 'string' && u.length <= 500)) {
    return errorOauth(res, 400, 'invalid_redirect_uri', 'Hacen falta entre 1 y 10 redirect_uris.');
  }
  const fuera = uris.find((u) => !redirectPermitido(u));
  if (fuera) {
    // Del lado del cliente un rechazo acá sólo se ve como «No se pudo conectar»: sin este log no
    // hay forma de saber por qué.
    log('registro rechazado', { cliente: nombreLimpio(m.client_name), redirect_uris: uris.map((u) => u.slice(0, 200)), agente: agenteDe(req) });
    return errorOauth(res, 400, 'invalid_redirect_uri', `Este servidor no admite ${fuera.slice(0, 200)}.`);
  }
  if (m.grant_types && (!Array.isArray(m.grant_types) || !m.grant_types.includes('authorization_code'))) {
    return errorOauth(res, 400, 'invalid_client_metadata', 'Sólo authorization_code (y refresh_token).');
  }
  const nombre = nombreLimpio(m.client_name);
  const metodo = ['client_secret_post', 'client_secret_basic'].includes(m.token_endpoint_auth_method) ? m.token_endpoint_auth_method : 'none';
  let clientId;
  try {
    clientId = firmar({ t: 'cliente', n: nombre, ru: uris, ...(metodo !== 'none' ? { m: metodo } : {}), iat: ahora() });
  } catch (e) {
    console.error('[oauth]', e.message);
    return errorOauth(res, 503, 'server_error', 'Servicio no disponible.');
  }
  log('registro', { cliente: nombre, destinos: [...new Set(uris.map((u) => new URL(u).host))], metodo, agente: agenteDe(req) });
  const cuerpo = {
    client_id: clientId, client_id_issued_at: ahora(), client_name: nombre, redirect_uris: uris,
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: metodo,
  };
  if (typeof m.scope === 'string') cuerpo.scope = m.scope;
  if (metodo !== 'none') Object.assign(cuerpo, { client_secret: secretoCliente(clientId), client_secret_expires_at: 0 });
  return json(res, 201, cuerpo);
}

// ---------------------------------------------------------------- páginas

// Sin JavaScript, sin recursos externos y sin marcos (frame-ancestors 'none' impide montar la
// página adentro de otra y hacer apretar «Autorizar» a ciegas). form-action deja salir hacia el
// redirect_uri: Chrome la aplica también a la redirección que sigue al POST.
const CSP = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; "
  + "form-action 'self' https: http://localhost:* http://127.0.0.1:* http://[::1]:*";

function pagina(res, codigo, titulo, cuerpo) {
  res.statusCode = codigo;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(`<!doctype html><html lang="es"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapar(titulo)} · SDR Biguá</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#f5f5f4;color:#1c1917;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{background:#fff;border:1px solid #e7e5e4;border-radius:12px;padding:32px;max-width:400px;width:100%;box-sizing:border-box;margin:16px}
h1{font-size:20px;margin:0 0 8px}p,li{line-height:1.5;margin:8px 0}.suave{color:#57534e;font-size:14px}
.error{background:#fef2f2;color:#991b1b;border-radius:8px;padding:8px 12px;font-size:14px}
label{display:block;font-size:14px;margin:16px 0 6px}
input[type=email],input[type=password]{width:100%;box-sizing:border-box;font-size:16px;padding:10px 12px;border:1px solid #d6d3d1;border-radius:8px}
button{font-size:15px;padding:10px 16px;border-radius:8px;border:1px solid #1c1917;cursor:pointer}
.primario{background:#1c1917;color:#fff;width:100%;margin-top:16px}
.secundario{background:none;border:none;color:#57534e;text-decoration:underline;padding:8px 0;font-size:14px}
</style>
<main><h1>${escapar(titulo)}</h1>${cuerpo}</main></html>`);
}

const destinoDe = (ru) => { try { return new URL(ru).host; } catch { return ''; } };
const oculto = (k, v) => `<input type="hidden" name="${k}" value="${escapar(v)}">`;
const cancelar = '<button class="secundario" name="paso" value="cancelar" formnovalidate>Cancelar</button>';

function paginaIngreso(res, { pedido, cliente, ru, error, email }) {
  return pagina(res, error ? 400 : 200, 'Conectar con el SDR', `
<p><b>${escapar(cliente)}</b> quiere gestionar tu SDR de Biguá con tu usuario del panel.</p>
${error ? `<p class="error">${escapar(error)}</p>` : ''}
<form method="post" action="/oauth/login">
${oculto('pedido', pedido)}
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" required autofocus value="${escapar(email ?? '')}">
<label for="password">Contraseña</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button class="primario" name="paso" value="ingresar">Ingresar</button>
${cancelar}
</form>
<p class="suave">Es tu usuario de sdrbot.bigua.lat/admin. Después de autorizar volvés a ${escapar(destinoDe(ru))}.</p>`);
}

function paginaConsentimiento(res, { pedido, login, cliente, ru, user, alcance }) {
  return pagina(res, 200, 'Autorizar la conexión', `
<p><b>${escapar(cliente)}</b> va a poder ver y gestionar <b>${escapar(alcance)}</b> en nombre de <b>${escapar(user.email)}</b>:</p>
<ul class="suave"><li>el resumen, la actividad y las campañas;</li><li>las aprobaciones que esperan;</li>
<li>los ajustes, los buzones y los dominios (sin ver contraseñas).</li></ul>
<p class="suave">Ves la conexión y la podés desconectar en el panel, en «Conexiones». Vence si no se usa en 30 días.</p>
<form method="post" action="/oauth/login">
${oculto('pedido', pedido)}${oculto('login', login)}
<button class="primario" name="paso" value="autorizar">Autorizar</button>
${cancelar}
</form>
<p class="suave">Después volvés a ${escapar(destinoDe(ru))}.</p>`);
}

// ---------------------------------------------------------------- authorize

async function autorizar(req, res, p) {
  const ru = p.get('redirect_uri');
  // A un redirect_uri fuera de la lista no se lo redirige ni con el error.
  if (!ru || !redirectPermitido(ru)) {
    return pagina(res, 400, 'No se puede conectar', '<p>El pedido trae una dirección de retorno que este servidor no admite.</p>');
  }
  const iss = emisor(req);
  const state = p.get('state');
  const rechazar = (error, descripcion) => redirigir(res, ru, { error, error_description: descripcion, state, iss });
  if (p.get('response_type') !== 'code') return rechazar('unsupported_response_type', 'Sólo response_type=code.');
  const clientId = (p.get('client_id') ?? '').trim();
  if (!clientId) return rechazar('invalid_request', 'Falta client_id.');

  let cliente;
  try { cliente = clienteRegistrado(clientId); } catch (e) {
    console.error('[oauth]', e.message);
    return rechazar('server_error', 'El servidor no está configurado para autorizar.');
  }
  const cimd = !cliente && esClienteCimd(clientId);
  if (cimd) cliente = await clienteCimd(clientId);
  log('authorize', { cimd: cimd || undefined, cliente: cliente?.n, destino: destinoDe(ru), agente: agenteDe(req) });
  if (!cliente) {
    return pagina(res, 400, 'No se puede conectar', cimd
      ? '<p>No se pudo leer el documento que identifica al cliente, o no declara esta dirección de retorno.</p>'
      : '<p>Este servidor no conoce ese cliente. Volvé a conectar desde Claude.</p>');
  }
  if (!redirectDeclarado(cliente.ru, ru)) {
    return pagina(res, 400, 'No se puede conectar', '<p>El cliente pidió volver a una dirección con la que no se registró.</p>');
  }
  const challenge = p.get('code_challenge');
  if (!challenge || p.get('code_challenge_method') !== 'S256') return rechazar('invalid_request', 'PKCE con S256 es obligatorio.');

  const pedido = firmar({ t: 'pedido', cid: clientId, n: cliente.n, ru, cc: challenge, st: state ?? null, exp: ahora() + VIDA_PEDIDO_S });
  return paginaIngreso(res, { pedido, cliente: cliente.n, ru });
}

// ---------------------------------------------------------------- login (los pasos de la página)

// El pedido y el ingreso viajan firmados en el formulario. El ingreso está atado al pedido (ph):
// la contraseña puesta para un pedido no autoriza otro.
async function entrar(req, res) {
  let f;
  try { f = await leerFormulario(req); } catch { return pagina(res, 400, 'No se puede conectar', '<p>No se pudo leer el formulario.</p>'); }
  let pedido, datos;
  try {
    pedido = f.get('pedido') ?? '';
    datos = verificar(pedido, 'pedido');
  } catch (e) {
    console.error('[oauth]', e.message);
    return pagina(res, 503, 'No se puede conectar', '<p>El servidor no está configurado para autorizar.</p>');
  }
  if (!datos || !redirectPermitido(datos.ru)) {
    return pagina(res, 400, 'El pedido venció', '<p>Pasaron más de 15 minutos desde que se abrió esta página. Volvé a conectar desde Claude.</p>');
  }
  const iss = emisor(req);
  const ctx = { pedido, cliente: datos.n, ru: datos.ru };
  const ph = sha256(pedido).slice(0, 32);
  const paso = f.get('paso');

  if (paso === 'cancelar') {
    return redirigir(res, datos.ru, { error: 'access_denied', error_description: 'La persona canceló la autorización.', state: datos.st, iss });
  }

  if (paso === 'ingresar') {
    const email = String(f.get('email') ?? '').trim().toLowerCase().slice(0, 254);
    let user;
    try {
      user = await verificarCredenciales(email, String(f.get('password') ?? '').slice(0, 200));
    } catch (e) {
      if (e.status === 401) return paginaIngreso(res, { ...ctx, email, error: e.message });
      console.error('[oauth]', e.message);
      return paginaIngreso(res, { ...ctx, email, error: 'No pudimos verificar el ingreso. Probá de nuevo en un rato.' });
    }
    const alcance = user.role === 'bigua_admin'
      ? 'todos los clientes'
      : (await q(`select name from mailgw.client where id = $1`, [user.client_id])).rows[0]?.name ?? user.client_id;
    const login = firmar({ t: 'login', uid: user.id, ph, exp: ahora() + VIDA_LOGIN_S });
    log('ingreso', { cliente: datos.n, rol: user.role });
    return paginaConsentimiento(res, { ...ctx, login, user, alcance });
  }

  if (paso === 'autorizar') {
    const l = verificar(f.get('login') ?? '', 'login');
    if (!l || l.ph !== ph) return paginaIngreso(res, { ...ctx, error: 'Pasaron más de 10 minutos. Ingresá de nuevo.' });
    const code = crypto.randomBytes(32).toString('base64url');
    const { rowCount } = await q(
      `insert into mailgw.oauth_code (code_hash, client_id, cliente_nombre, user_id, redirect_uri, code_challenge, expires_at)
       select $1, $2, $3, u.id, $5, $6, now() + make_interval(secs => $7)
         from mailgw.admin_user u where u.id = $4 and u.active`,
      [sha256(code), datos.cid, datos.n, l.uid, datos.ru, datos.cc, VIDA_CODIGO_S]);
    if (!rowCount) return paginaIngreso(res, { ...ctx, error: 'El usuario ya no está activo.' });
    log('autorizado', { cliente: datos.n });
    return redirigir(res, datos.ru, { code, state: datos.st, iss });
  }

  return paginaIngreso(res, ctx);
}

// ---------------------------------------------------------------- token

const nuevo = (prefijo) => { const token = prefijo + crypto.randomBytes(32).toString('base64url'); return { token, hash: sha256(token) }; };

async function emitir(c, { familia, clientId, nombre, userId }) {
  const acceso = nuevo('mgp_');
  const renovacion = nuevo('mgr_');
  await c.query(
    `insert into mailgw.oauth_token (token_hash, tipo, familia, client_id, cliente_nombre, user_id, expires_at)
     values ($1, 'acceso', $3, $4, $5, $6, now() + make_interval(secs => $7)),
            ($2, 'renovacion', $3, $4, $5, $6, now() + make_interval(secs => $8))`,
    [acceso.hash, renovacion.hash, familia, clientId, nombre, userId, VIDA_ACCESO_S, VIDA_RENOVACION_S]);
  return {
    access_token: acceso.token, token_type: 'Bearer', expires_in: VIDA_ACCESO_S,
    refresh_token: renovacion.token, scope: 'panel',
  };
}

async function transaccion(fn) {
  const c = await getPool().connect();
  try {
    await c.query('begin');
    const r = await fn(c);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// Las credenciales del cliente. Uno registrado con secreto lo tiene que mandar siempre; uno
// público (DCR con «none», o CIMD) no tiene, y si manda uno no es quien dice ser.
function clienteDelPedido(req, f) {
  const basic = credencialesBasic(req.headers?.authorization);
  const clientId = (basic?.id ?? f.get('client_id') ?? '').trim();
  const secreto = (basic?.secreto ?? f.get('client_secret') ?? '').trim();
  const registrado = clienteRegistrado(clientId);
  if (!registrado && !esClienteCimd(clientId)) return { ok: false, basic };
  const confidencial = Boolean(registrado?.m);
  const ok = confidencial ? secreto === secretoCliente(clientId) : !secreto;
  return { ok, basic, clientId, nombre: registrado?.n };
}

async function canjear(req, res) {
  let f;
  try { f = await leerFormulario(req); } catch { return errorOauth(res, 400, 'invalid_request', 'No se pudo leer el cuerpo.'); }
  const grant = f.get('grant_type');
  if (!grant) return errorOauth(res, 400, 'invalid_request', 'Falta grant_type.');
  if (grant !== 'authorization_code' && grant !== 'refresh_token') {
    return errorOauth(res, 400, 'unsupported_grant_type', 'Sólo authorization_code y refresh_token.');
  }
  let cl;
  try { cl = clienteDelPedido(req, f); } catch (e) {
    console.error('[oauth]', e.message);
    return errorOauth(res, 503, 'server_error', 'Servicio no disponible.');
  }
  if (!cl.ok) {
    return errorOauth(res, 401, 'invalid_client', 'Credenciales de cliente inválidas.',
      cl.basic ? { 'WWW-Authenticate': 'Basic realm="sdrbot-panel"' } : {});
  }
  const invalido = (d) => errorOauth(res, 400, 'invalid_grant', d);

  try {
    if (grant === 'authorization_code') {
      const code = f.get('code');
      const verifier = f.get('code_verifier');
      if (!code || !verifier) return errorOauth(res, 400, 'invalid_request', 'Faltan code o code_verifier.');
      const r = await transaccion(async (c) => {
        // Uso único: el update marca el código, y un segundo canje no encuentra la fila.
        const { rows } = await c.query(
          `update mailgw.oauth_code o set used_at = now()
             from mailgw.admin_user u
            where o.code_hash = $1 and o.used_at is null and o.expires_at > now() and u.id = o.user_id and u.active
            returning o.*`, [sha256(code)]);
        const k = rows[0];
        const ru = f.get('redirect_uri');
        // El redirect_uri se compara si viene: OAuth 2.1 lo sacó del canje.
        if (!k || k.client_id !== cl.clientId || (ru != null && ru !== k.redirect_uri) || !pkceCoincide(verifier, k.code_challenge)) return null;
        return emitir(c, { familia: crypto.randomUUID(), clientId: k.client_id, nombre: k.cliente_nombre, userId: k.user_id });
      });
      if (!r) return invalido('El código no es válido, ya se usó o venció.');
      log('token', { grant, cliente: cl.nombre ?? cl.clientId.slice(0, 80) });
      return json(res, 200, r, { Pragma: 'no-cache' });
    }

    const rt = f.get('refresh_token');
    if (!rt) return errorOauth(res, 400, 'invalid_request', 'Falta refresh_token.');
    const r = await transaccion(async (c) => {
      const { rows } = await c.query(
        `select t.*, u.active from mailgw.oauth_token t join mailgw.admin_user u on u.id = t.user_id
          where t.token_hash = $1 and t.tipo = 'renovacion' for update of t`, [sha256(rt)]);
      const t = rows[0];
      if (!t || t.client_id !== cl.clientId) return { error: 'El token de renovación no es válido.' };
      if (t.used_at && !t.revoked_at) {
        // Alguien presentó una renovación ya rotada: la copió. Se corta la conexión entera.
        await c.query(`update mailgw.oauth_token set revoked_at = now() where familia = $1 and revoked_at is null`, [t.familia]);
        log('renovación reusada: conexión revocada', { cliente: t.cliente_nombre });
        return { error: 'El token de renovación ya se usó. La conexión quedó revocada: volvé a conectar.' };
      }
      if (t.revoked_at || new Date(t.expires_at) <= new Date() || !t.active) {
        return { error: 'La conexión se revocó o venció. Volvé a conectar.' };
      }
      await c.query(`update mailgw.oauth_token set used_at = now() where id = $1`, [t.id]);
      // Los accesos anteriores de la conexión dejan de servir: vale sólo el último par.
      await c.query(`update mailgw.oauth_token set revoked_at = now() where familia = $1 and tipo = 'acceso' and revoked_at is null`, [t.familia]);
      return { ok: await emitir(c, { familia: t.familia, clientId: t.client_id, nombre: t.cliente_nombre, userId: t.user_id }) };
    });
    if (r.error) return invalido(r.error);
    log('token', { grant, cliente: cl.nombre ?? cl.clientId.slice(0, 80) });
    return json(res, 200, r.ok, { Pragma: 'no-cache' });
  } catch (e) {
    console.error('[oauth]', e.message);
    return errorOauth(res, 503, 'server_error', 'Servicio no disponible.');
  }
}

// RFC 7009: revocar un token (de acceso o de renovación) corta la conexión entera. Responde 200
// aunque el token no exista, para no confirmar nada.
async function revocar(req, res) {
  let f;
  try { f = await leerFormulario(req); } catch { return errorOauth(res, 400, 'invalid_request', 'No se pudo leer el cuerpo.'); }
  const token = f.get('token');
  if (!token) return errorOauth(res, 400, 'invalid_request', 'Falta token.');
  try {
    await q(`update mailgw.oauth_token set revoked_at = now()
              where familia = (select familia from mailgw.oauth_token where token_hash = $1) and revoked_at is null`, [sha256(token)]);
  } catch (e) {
    console.error('[oauth]', e.message);
    return errorOauth(res, 503, 'server_error', 'Servicio no disponible.');
  }
  return json(res, 200, {});
}

// ---------------------------------------------------------------- el token en /mcp/panel

// El usuario de un token de acceso vigente, o null. Un usuario desactivado no entra aunque su
// token no haya vencido.
export async function usuarioDeToken(token) {
  if (!token || !token.startsWith('mgp_') || token.length > 200) return null;
  const { rows } = await q(
    `update mailgw.oauth_token t set last_used_at = now()
       from mailgw.admin_user u
      where t.token_hash = $1 and t.tipo = 'acceso' and t.revoked_at is null and t.expires_at > now()
        and u.id = t.user_id and u.active
      returning u.id, u.email, u.name, u.role, u.client_id, t.familia, t.cliente_nombre`, [sha256(token)]);
  if (!rows.length) return null;
  const { familia, cliente_nombre: clienteOauth, ...user } = rows[0];
  return { user, familia, clienteOauth };
}

// ---------------------------------------------------------------- despacho

// Devuelve true si atendió el pedido.
export async function handleOauth(req, res, path) {
  const rutas = {
    [`/.well-known/oauth-protected-resource${RUTA_MCP}`]: 'prm',
    '/.well-known/oauth-protected-resource': 'prm',
    '/.well-known/oauth-authorization-server': 'as',
    '/oauth/register': 'register',
    '/oauth/authorize': 'authorize',
    '/oauth/login': 'login',
    '/oauth/token': 'token',
    '/oauth/revoke': 'revoke',
  };
  const que = rutas[path];
  if (!que) return false;
  for (const [k, v] of Object.entries(CORS)) res.setHeader(k, v);
  // Cada pedido con método, ruta y agente (sin la query: en /authorize lleva el state). Es lo que
  // permite ver en qué paso abandona un cliente que sólo dice «No se pudo conectar».
  log('pedido', { metodo: req.method, ruta: path, agente: agenteDe(req) });
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return true; }

  const post = ['register', 'login', 'token', 'revoke'].includes(que);
  if (post && req.method !== 'POST') { errorOauth(res, 405, 'invalid_request', 'Sólo POST.', { Allow: 'POST' }); return true; }
  if (!post && req.method !== 'GET' && req.method !== 'HEAD') { errorOauth(res, 405, 'invalid_request', 'Sólo GET.', { Allow: 'GET' }); return true; }

  const params = new URL(req.url ?? '/', 'http://local').searchParams;
  if (que === 'prm') json(res, 200, metadataRecurso(req));
  else if (que === 'as') json(res, 200, metadataServidor(req));
  else if (que === 'register') await registrar(req, res);
  else if (que === 'authorize') await autorizar(req, res, params);
  else if (que === 'login') await entrar(req, res);
  else if (que === 'token') await canjear(req, res);
  else await revocar(req, res);
  return true;
}
