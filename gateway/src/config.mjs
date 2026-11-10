import { errors } from './errors.mjs';

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

// MAILGW_ENC_KEYS = "k2:<32 bytes en base64 o hex>,k1:<...>". La primera cifra; todas descifran.
// Rotar es anteponer una clave nueva, correr `admin rekey` y después sacar la vieja.
export function parseKeys(raw) {
  // Comillas o espacios alrededor son un error común al pegar el valor en Vercel: se toleran.
  const value = String(raw ?? '').trim().replace(/^(['"])(.*)\1$/s, '$2').trim();
  if (!value) throw errors.config('Falta MAILGW_ENC_KEYS. Formato: k1:<base64 de 32 bytes>.');
  const entries = value.split(',').map((s) => s.trim()).filter(Boolean).map((part, n) => {
    const i = part.indexOf(':');
    // Los mensajes nunca muestran la clave: sólo qué parte está mal.
    if (i < 1) {
      throw errors.config(`MAILGW_ENC_KEYS: a la clave ${n + 1} le falta el identificador. `
        + 'El valor tiene que ser k1:<base64>, con "k1:" adelante (no sólo el base64).');
    }
    const id = part.slice(0, i);
    const b64 = part.slice(i + 1).trim();
    if (!/^[a-z0-9]{1,16}$/i.test(id)) {
      throw errors.config(`MAILGW_ENC_KEYS: identificador inválido en la clave ${n + 1} (letras y números, hasta 16; por ejemplo k1).`);
    }
    const key = decodeKey(b64);
    if (!key) {
      throw errors.config(`MAILGW_ENC_KEYS: la clave "${id}" no es de 32 bytes: después de "${id}:" hay ${b64.length} caracteres. `
        + 'Tiene que ser la salida de openssl rand -base64 32 (44 caracteres, termina en =) '
        + 'o de openssl rand -hex 32 (64 caracteres).');
    }
    return [id, key];
  });
  if (!entries.length) throw errors.config('MAILGW_ENC_KEYS está vacía.');
  return { current: entries[0], byId: new Map(entries) };
}

// 32 bytes en base64 (estándar o URL-safe, con o sin relleno) o en hexadecimal (64 caracteres).
// Las dos formas no se pisan: 32 bytes en base64 son 43 o 44 caracteres.
function decodeKey(text) {
  let key = null;
  if (/^[0-9a-f]{64}$/i.test(text)) key = Buffer.from(text, 'hex');
  else if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) key = Buffer.from(text, 'base64');
  return key?.length === 32 ? key : null;
}

let keysCache;
export function keys() {
  keysCache ??= parseKeys(process.env.MAILGW_ENC_KEYS);
  return keysCache;
}

export const limits = {
  // Un mensaje más grande que esto se lista con sus cabeceras pero sin cuerpo.
  maxMessageBytes: int(process.env.MAILGW_MAX_MESSAGE_BYTES, 10 * 1024 * 1024),
  // Texto que vuelve por mensaje. El resto se corta y se marca text_truncated.
  maxTextChars: int(process.env.MAILGW_MAX_TEXT_CHARS, 50_000),
  // Destinatarios por envío: el SDR escribe uno a uno. Más que esto es un error de uso.
  maxRecipients: int(process.env.MAILGW_MAX_RECIPIENTS, 10),
  // Fallas de autenticación seguidas que bloquean el buzón.
  maxAuthFailures: 3,
  connectionTimeoutMs: int(process.env.MAILGW_CONNECT_TIMEOUT_MS, 15_000),
  socketTimeoutMs: int(process.env.MAILGW_SOCKET_TIMEOUT_MS, 40_000),
  maxBodyBytes: 1024 * 1024,
  maxCargaBytes: 4_400_000,
};

export const VERSION = '0.1.0';
