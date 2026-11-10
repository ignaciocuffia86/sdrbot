// Adaptador de Google Sheets para la carga en el CRM (docs/23 §14): para el cliente que no tiene
// CRM y lleva su gestión en una planilla. Sólo HTTP: qué escribir y cuándo lo decide
// src/sdr/crm.mjs. Agrega filas; nunca borra ni pisa una fila que ya estaba.
//
// Entra con una cuenta de servicio de Biguá (MAILGW_GOOGLE_SA: el JSON de la clave, cargado en
// Vercel, nunca en el repo). El cliente comparte su planilla con el mail de esa cuenta como
// editor. El token de acceso se pide a Google con un JWT firmado (RS256) y se reusa hasta que vence.
//
// Lo que se escribe viene de lo que respondió el prospecto y de lo que redactó un bot: va siempre
// con valueInputOption=RAW, así un «=IMPORTXML(…)» queda como texto y no como fórmula.
//
// Los errores vuelven como CrmError (el mismo de hubspot.mjs), con el tipo que dice qué hacer:
//   credencial  401 o la cuenta de servicio no sirve: se pausa la conexión.
//   permisos    403 o 404: la planilla no está compartida con la cuenta o no existe. Ídem.
//   limite      429.   caido  5xx o sin respuesta.   rechazo  400.   tiempo  fin de la vuelta.

import crypto from 'node:crypto';
import { CrmError } from './hubspot.mjs';

const base = () => (process.env.MAILGW_SHEETS_URL || 'https://sheets.googleapis.com').replace(/\/+$/, '');
const urlToken = () => process.env.MAILGW_GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
// Lo que entra en una celda: Sheets acepta 50.000 caracteres; con esto la fila se lee.
const MAX_CELDA = 5000;

// ---------------------------------------------------------------- la planilla

// Acepta la URL que se copia del navegador: https://docs.google.com/spreadsheets/d/<id>/edit#gid=<n>
export function parsearUrl(url) {
  let u;
  try { u = new URL(String(url ?? '').trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'docs.google.com') return null;
  const id = /^\/spreadsheets\/d\/([A-Za-z0-9_-]{20,100})(\/|$)/.exec(u.pathname)?.[1];
  if (!id) return null;
  const gid = /(?:^|[#&?])gid=(\d{1,12})/.exec(`${u.search}${u.hash}`)?.[1];
  return { id, gid: gid === undefined ? null : Number(gid) };
}

export const urlFila = (id, gid, fila) =>
  (id ? `https://docs.google.com/spreadsheets/d/${id}/edit#gid=${gid ?? 0}${fila ? `&range=A${fila}` : ''}` : null);

// ---------------------------------------------------------------- la cuenta de servicio

let cuentaCache = null;

// { email, clave } o null si el gateway no tiene la cuenta cargada. Nunca devuelve la clave al panel.
export function cuentaServicio() {
  const raw = process.env.MAILGW_GOOGLE_SA;
  if (!raw) return null;
  if (cuentaCache?.raw === raw) return cuentaCache.cuenta;
  let cuenta = null;
  try {
    const j = JSON.parse(raw);
    if (j.client_email && j.private_key) cuenta = { email: j.client_email, clave: j.private_key.replace(/\\n/g, '\n') };
  } catch { cuenta = null; }
  cuentaCache = { raw, cuenta };
  return cuenta;
}

export const emailCuenta = () => cuentaServicio()?.email ?? null;

const b64url = (x) => Buffer.from(x).toString('base64url');
let tokenCache = null; // { email, token, vence }

async function tokenDeAcceso(fetchImpl, plazo) {
  const cuenta = cuentaServicio();
  if (!cuenta) {
    throw new CrmError('credencial', 'El gateway no tiene la cuenta de servicio de Google (MAILGW_GOOGLE_SA en Vercel). La carga Biguá.');
  }
  if (tokenCache?.email === cuenta.email && tokenCache.vence > Date.now() + 60_000) return tokenCache.token;
  const ahora = Math.floor(Date.now() / 1000);
  const cuerpo = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: cuenta.email, scope: SCOPE, aud: urlToken(), iat: ahora, exp: ahora + 3600,
  }))}`;
  let firma;
  try {
    firma = crypto.createSign('RSA-SHA256').update(cuerpo).sign(cuenta.clave).toString('base64url');
  } catch {
    throw new CrmError('credencial', 'La clave de la cuenta de servicio de Google (MAILGW_GOOGLE_SA) no es válida.');
  }
  let res;
  try {
    res = await fetchImpl(urlToken(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${cuerpo}.${firma}` }).toString(),
      signal: AbortSignal.timeout(plazo),
    });
  } catch (e) {
    throw new CrmError('caido', `No se pudo llegar a Google: ${e.message}`);
  }
  const j = await res.json().catch(() => null);
  if (!res.ok || !j?.access_token) {
    if (res.status >= 500) throw new CrmError('caido', `Google no respondió bien al pedir el acceso (HTTP ${res.status}).`);
    throw new CrmError('credencial', `Google rechazó la cuenta de servicio: ${j?.error_description ?? j?.error ?? `HTTP ${res.status}`}.`);
  }
  tokenCache = { email: cuenta.email, token: j.access_token, vence: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
  return tokenCache.token;
}

export function olvidarToken() { tokenCache = null; }

// ---------------------------------------------------------------- HTTP

function errorDe(status, json, texto) {
  const msg = String(json?.error?.message ?? texto ?? '').replace(/\s+/g, ' ').slice(0, 400) || `HTTP ${status}`;
  const quien = emailCuenta() ?? 'la cuenta de servicio de Biguá';
  if (status === 401) { olvidarToken(); return new CrmError('credencial', `Google rechazó el acceso: ${msg}`); }
  if (status === 403) {
    return new CrmError('permisos', `La planilla no está compartida con ${quien} como editor. Compartila desde Google Sheets ` +
      '(Compartir → agregar ese mail como Editor) y probá la conexión otra vez.');
  }
  if (status === 404) return new CrmError('permisos', `Google no encuentra la planilla (${msg}). Revisá la URL y que esté compartida con ${quien}.`);
  if (status === 429) return new CrmError('limite', 'Google pidió bajar el ritmo (límite de pedidos).');
  if (status >= 500) return new CrmError('caido', `Google Sheets no respondió bien (HTTP ${status}): ${msg}`);
  return new CrmError('rechazo', `Google Sheets rechazó el dato (HTTP ${status}): ${msg}`);
}

// Un rango A1 con el nombre de la pestaña entre comillas simples (las de adentro, dobladas).
export const rango = (hoja, a1) => `'${String(hoja).replace(/'/g, "''")}'!${a1}`;

// La letra de la columna n (1 → A, 27 → AA).
export function letra(n) {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

export function cliente(spreadsheetId, { fetchImpl = fetch, hasta = Infinity } = {}) {
  async function api(method, path, body) {
    const queda = hasta - Date.now();
    if (queda < 1_000) throw new CrmError('tiempo', 'Se terminó el tiempo de esta vuelta: la carga sigue en la próxima.');
    const plazo = Math.min(20_000, queda);
    const token = await tokenDeAcceso(fetchImpl, plazo);
    let res;
    try {
      res = await fetchImpl(`${base()}/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(plazo),
      });
    } catch (e) {
      if (e.name === 'TimeoutError' && plazo < 20_000) {
        throw new CrmError('tiempo', 'Se terminó el tiempo de esta vuelta esperando a Google: la carga sigue en la próxima.');
      }
      throw new CrmError('caido', e.name === 'TimeoutError' ? 'Google Sheets no contestó en 20 segundos.' : `No se pudo llegar a Google Sheets: ${e.message}`);
    }
    const texto = await res.text();
    let json = null;
    try { json = texto ? JSON.parse(texto) : null; } catch { json = null; }
    if (!res.ok) throw errorDe(res.status, json, texto);
    return json;
  }
  const valores = (r) => `/values/${encodeURIComponent(r)}`;
  return {
    // El título y las pestañas.
    meta: () => api('GET', '?fields=properties.title,sheets.properties(sheetId,title,gridProperties.columnCount)'),
    // Suma columnas al final de una pestaña: escribir fuera de la grilla da 400.
    agrandar: (sheetId, columnas) => api('POST', ':batchUpdate',
      { requests: [{ appendDimension: { sheetId, dimension: 'COLUMNS', length: columnas } }] }),
    leer: async (r) => (await api('GET', `${valores(r)}?majorDimension=ROWS`))?.values ?? [],
    escribir: (r, filas) => api('PUT', `${valores(r)}?valueInputOption=RAW`, { range: r, majorDimension: 'ROWS', values: filas }),
    // Devuelve el rango donde quedó la fila (updates.updatedRange).
    agregar: (r, filas) => api('POST', `${valores(r)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { range: r, majorDimension: 'ROWS', values: filas }),
  };
}

// ---------------------------------------------------------------- las columnas

// Lo que se escribe por positivo. Si la planilla ya tiene encabezados, cada dato va a la columna
// que se llame como alguno de sus nombres (sin importar mayúsculas ni acentos); los que no tienen
// columna se agregan al final. ID registro es lo que evita cargar dos veces a la misma persona.
export const COLUMNAS = [
  { clave: 'fecha', titulo: 'Fecha', otros: ['fecha de carga', 'fecha positivo', 'alta'] },
  { clave: 'nombre', titulo: 'Nombre', otros: ['nombre y apellido', 'contacto', 'persona', 'lead'] },
  { clave: 'email', titulo: 'Email', otros: ['mail', 'e-mail', 'correo', 'correo electronico'] },
  { clave: 'cargo', titulo: 'Cargo', otros: ['puesto', 'rol', 'posicion'] },
  { clave: 'empresa', titulo: 'Empresa', otros: ['compania', 'cuenta', 'organizacion', 'cliente'] },
  { clave: 'dominio', titulo: 'Dominio', otros: ['web', 'sitio', 'sitio web', 'website'] },
  { clave: 'canal', titulo: 'Canal', otros: ['medio', 'via'] },
  { clave: 'que_pide', titulo: 'Qué pide', otros: ['resumen', 'interes', 'pedido'] },
  { clave: 'respuesta', titulo: 'Lo que respondió', otros: ['respuesta', 'respuesta del prospecto', 'mensaje'] },
  { clave: 'aprobada', titulo: 'Respuesta aprobada', otros: ['respuesta enviada', 'nuestra respuesta'] },
  { clave: 'tesis', titulo: 'Por qué lo contactamos', otros: ['motivo', 'tesis'] },
  { clave: 'origen', titulo: 'Origen', otros: ['fuente', 'origen del lead'] },
  { clave: 'registro', titulo: 'ID registro', otros: ['id registro sdr', 'registro'] },
];

const normal = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Encabezados actuales → { indices: { clave: columna (0..) }, encabezados: los que quedan, nuevas: títulos agregados }.
export function mapear(encabezados) {
  const fila = (encabezados ?? []).map((x) => String(x ?? ''));
  // Una planilla sin encabezados: se escriben los nuestros en la fila 1.
  const ultima = fila.reduce((n, x, i) => (x.trim() ? i + 1 : n), 0);
  const quedan = fila.slice(0, ultima);
  const indices = {};
  const usados = new Set();
  for (const col of COLUMNAS) {
    const nombres = [col.titulo, ...col.otros].map(normal);
    const i = quedan.findIndex((x, j) => !usados.has(j) && nombres.includes(normal(x)));
    if (i >= 0) { indices[col.clave] = i; usados.add(i); }
  }
  const nuevas = [];
  for (const col of COLUMNAS) {
    if (indices[col.clave] !== undefined) continue;
    indices[col.clave] = quedan.length;
    quedan.push(col.titulo);
    nuevas.push(col.titulo);
  }
  // Dónde empieza la tabla: Google ubica una fila agregada a partir de la primera columna con datos.
  const inicio = Math.max(0, quedan.findIndex((x) => String(x).trim()));
  return { indices, encabezados: quedan, nuevas, vacia: ultima === 0, inicio };
}

// Texto plano y acotado: sin caracteres de control (salvo el salto de línea) y con un largo máximo.
export function celda(v) {
  if (v === null || v === undefined) return '';
  // eslint-disable-next-line no-control-regex
  const s = String(v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim();
  return s.length > MAX_CELDA ? `${s.slice(0, MAX_CELDA - 1)}…` : s;
}

// La fila, en el orden de los encabezados de la planilla.
export function fila(valores, indices, ancho) {
  const out = new Array(ancho).fill('');
  for (const [k, i] of Object.entries(indices)) out[i] = celda(valores[k]);
  return out;
}

// El número de fila de un rango A1 como 'Hoja 1'!A12:M12.
export const filaDe = (r) => Number(/![A-Z]+(\d+)/.exec(String(r ?? ''))?.[1]) || null;
