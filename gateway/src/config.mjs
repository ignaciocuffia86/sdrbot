import { errors } from './errors.mjs';

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

// MAILGW_ENC_KEYS = "k2:<base64 de 32 bytes>,k1:<base64>". La primera cifra; todas descifran.
// Rotar es anteponer una clave nueva, correr `admin rekey` y después sacar la vieja.
export function parseKeys(raw) {
  if (!raw) throw errors.config('Falta MAILGW_ENC_KEYS.');
  const entries = raw.split(',').map((s) => s.trim()).filter(Boolean).map((part) => {
    const i = part.indexOf(':');
    if (i < 1) throw errors.config('MAILGW_ENC_KEYS: cada clave va como id:base64.');
    const id = part.slice(0, i);
    const key = Buffer.from(part.slice(i + 1), 'base64');
    if (!/^[a-z0-9]{1,16}$/i.test(id)) throw errors.config(`MAILGW_ENC_KEYS: id inválido "${id}".`);
    if (key.length !== 32) throw errors.config(`MAILGW_ENC_KEYS: la clave "${id}" no tiene 32 bytes.`);
    return [id, key];
  });
  if (!entries.length) throw errors.config('MAILGW_ENC_KEYS está vacía.');
  return { current: entries[0], byId: new Map(entries) };
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
};

export const VERSION = '0.1.0';
