// Las piezas del OAuth del MCP del panel que no necesitan HTTP ni base (docs/23 §3). Vienen del
// OAuth de ASCI (repo locasci, mcp/oauth.mjs, docs/32), que ya anda con Claude, ChatGPT y Cursor;
// cada regla lleva el porqué que se aprendió allá.

import crypto from 'node:crypto';

const b64u = (x) => Buffer.from(x).toString('base64url');
export const sha256 = (x) => crypto.createHash('sha256').update(String(x), 'utf8').digest('hex');

// El origen de la metadata y del `iss`. Tiene que ser EXACTAMENTE el mismo texto en los dos
// lugares: los clientes comparan sin normalizar barra final, puerto ni mayúsculas (RFC 9207).
// Sale de OAUTH_ISSUER o del pedido, para que una preview o una prueba local se anuncien a sí mismas.
export function emisor(req) {
  const fijo = process.env.OAUTH_ISSUER?.trim();
  if (fijo) return fijo.replace(/\/+$/, '');
  const host = req?.headers?.['x-forwarded-host'] ?? req?.headers?.host;
  if (!host) return 'https://sdrbot.bigua.lat';
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim()
    || (/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

// Sin OAUTH_FIRMA no se firma nada: una clave por defecto la conocería cualquiera que lea el repo.
function claveFirma() {
  const k = process.env.OAUTH_FIRMA;
  if (!k || k.length < 32) throw Object.assign(new Error('Falta OAUTH_FIRMA, o es demasiado corta.'), { sinFirma: true });
  return k;
}
const hmac = (cuerpo) => crypto.createHmac('sha256', claveFirma()).update(cuerpo).digest();

// base64url(JSON) + '.' + base64url(HMAC). El tipo `t` va adentro de lo firmado: sin él, un
// sobre de un tipo serviría como otro, porque los firma la misma clave.
export function firmar(datos) {
  const cuerpo = b64u(JSON.stringify(datos));
  return `${cuerpo}.${b64u(hmac(cuerpo))}`;
}

// Los datos o null: firma mala, vencido o de otro tipo son lo mismo para quien llama.
export function verificar(sobre, tipo) {
  const [cuerpo, firma, ...resto] = String(sobre ?? '').split('.');
  if (!cuerpo || !firma || resto.length) return null;
  const esperada = hmac(cuerpo);
  const recibida = Buffer.from(firma, 'base64url');
  if (recibida.length !== esperada.length || !crypto.timingSafeEqual(recibida, esperada)) return null;
  let datos;
  try { datos = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8')); } catch { return null; }
  if (datos?.t !== tipo) return null;
  if (datos.exp != null && datos.exp < Math.floor(Date.now() / 1000)) return null;
  return datos;
}

export function pkceCoincide(verifier, challenge) {
  if (!verifier || !challenge) return false;
  const a = Buffer.from(b64u(crypto.createHash('sha256').update(String(verifier)).digest()));
  const b = Buffer.from(String(challenge));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Los callbacks de los clientes que conocemos. Claude se registra con los de claude.ai y
// claude.com: sin el segundo, ASCI rechazaba el registro entero (ASCI #114). Los de ChatGPT y
// Cursor, como en ASCI. Una entrada que termina en "/" es un prefijo y exige algo después.
const REDIRECTS_DEFECTO = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
  'https://chatgpt.com/connector/oauth/',
  'https://chatgpt.com/connector_platform_oauth_redirect',
  'https://www.cursor.com/agents/mcp/oauth/callback',
].join(',');

// Esta lista es lo que impide el robo de cuentas: con login, alguien que registrara su propio
// sitio podría mandarle el enlace a un usuario real, que entraría con su contraseña, y el código
// le llegaría al que lo pidió. Se compara la URL ya normalizada (sin "..").
//
// Loopback (localhost, 127.0.0.1, [::1], cualquier puerto) vale siempre (RFC 8252 §7.3): así
// reciben el código Claude Code y los clientes de escritorio, en la máquina de quien autoriza.
export function redirectPermitido(uri) {
  let u;
  try { u = new URL(String(uri)); } catch { return false; }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return true;
  if (u.protocol !== 'https:') return false;
  const normal = u.origin + u.pathname;
  return (process.env.OAUTH_REDIRECTS || REDIRECTS_DEFECTO).split(',').map((s) => s.trim()).filter(Boolean)
    .some((p) => (p.endsWith('/') ? normal.startsWith(p) && normal.length > p.length : normal === p));
}

// ¿El redirect_uri pedido es uno de los declarados? Exacto, salvo loopback, donde el puerto no
// cuenta: el documento de Claude Code declara http://localhost/callback y abre un puerto al azar.
export function redirectDeclarado(declarados, uri) {
  if (declarados.includes(uri)) return true;
  let u;
  try { u = new URL(uri); } catch { return false; }
  if (u.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) return false;
  const sinPuerto = (x) => { const v = new URL(x); v.port = ''; return v.href; };
  return declarados.some((d) => { try { return sinPuerto(d) === sinPuerto(uri); } catch { return false; } });
}

// client_secret_basic, con id y secreto en percent-encoding (RFC 6749 §2.3.1).
export function credencialesBasic(cabecera) {
  const m = /^Basic\s+(.+)$/i.exec(String(cabecera ?? '').trim());
  if (!m) return null;
  const par = Buffer.from(m[1], 'base64').toString('utf8');
  const i = par.indexOf(':');
  if (i < 0) return null;
  const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  return { id: dec(par.slice(0, i)), secreto: dec(par.slice(i + 1)) };
}

export function escapar(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const nombreLimpio = (s, defecto = 'Cliente MCP') =>
  String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80) || defecto;

// El cliente registrado por DCR (RFC 7591), sin tabla: el client_id es un sobre firmado con el
// nombre, los redirect_uri y, si pidió uno, el método con secreto.
export function clienteRegistrado(clientId) {
  const d = verificar(clientId, 'cliente');
  return d && Array.isArray(d.ru) ? d : null;
}

// El secreto de un cliente DCR que pidió client_secret_post o _basic: se deriva del client_id, no
// se guarda. Un cliente que pidió un secreto y recibe «none» puede abandonar sin decir por qué
// (claude.ai con ASCI, 05/11).
export const secretoCliente = (clientId) => 'mgc_' + hmac(`secreto:${clientId}`).toString('base64url');

// ---------------------------------------------------------------- CIMD
//
// El client_id es la URL https de un documento que publica el cliente (Claude lo prefiere si el
// servidor anuncia client_id_metadata_document_supported; con sólo DCR, claude.ai no se
// registraba). Sólo de hosts conocidos: leer el documento es salir a buscar una URL que eligió
// quien llama, y filtrar IPs no alcanza porque un nombre puede resolver a una dirección interna.

const HOSTS_CIMD_DEFECTO = 'claude.ai,claude.com,chatgpt.com,openai.com';
const hostsCimd = () => (process.env.OAUTH_CIMD_HOSTS || HOSTS_CIMD_DEFECTO).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

export function esClienteCimd(clientId) {
  let u;
  try { u = new URL(String(clientId)); } catch { return false; }
  return u.protocol === 'https:' && !u.username && !u.password && !u.hash && !u.port
    && u.pathname.length > 1 && hostsCimd().includes(u.hostname.toLowerCase());
}

// El cuerpo se lee por partes y se corta al pasar el tope, para que un documento enorme no
// llene la memoria.
async function leerConTope(r, tope) {
  if (Number(r.headers.get('content-length') ?? 0) > tope) return null;
  const lector = r.body?.getReader();
  if (!lector) return null;
  const trozos = [];
  let total = 0;
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    total += value.length;
    if (total > tope) { await lector.cancel().catch(() => {}); return null; }
    trozos.push(value);
  }
  return Buffer.concat(trozos).toString('utf8');
}

const cacheCimd = new Map();
const VIDA_CACHE_CIMD_MS = 5 * 60_000;
export const vaciarCacheCimd = () => cacheCimd.clear();

// { n, ru } como clienteRegistrado, o null. El documento tiene que decir que su client_id es la
// URL de donde vino, y sólo cuentan los redirect_uri que además están en la lista.
export async function clienteCimd(clientId) {
  if (!esClienteCimd(clientId)) return null;
  const guardado = cacheCimd.get(clientId);
  if (guardado && guardado.hasta > Date.now()) return guardado.cliente;
  let doc;
  try {
    const r = await fetch(clientId, { redirect: 'error', signal: AbortSignal.timeout(4000), headers: { Accept: 'application/json' } });
    if (!r.ok) return null;
    const texto = await leerConTope(r, 16384);
    if (texto == null) return null;
    doc = JSON.parse(texto);
  } catch { return null; }
  if (doc?.client_id !== clientId || !Array.isArray(doc.redirect_uris)) return null;
  const ru = doc.redirect_uris.filter((u) => typeof u === 'string' && redirectPermitido(u));
  if (!ru.length) return null;
  const cliente = { n: nombreLimpio(doc.client_name, new URL(clientId).hostname), ru };
  cacheCimd.set(clientId, { cliente, hasta: Date.now() + VIDA_CACHE_CIMD_MS });
  return cliente;
}
