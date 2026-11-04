// Cifrado de las contraseñas de los buzones: AES-256-GCM con la clave de MAILGW_ENC_KEYS.
//
// Formato: v1:<id de clave>:<iv>:<tag>:<texto cifrado>, todo en base64url.
// El AAD ata el texto cifrado a su buzón (cliente y email): copiar el secret_enc de una
// fila a otra no sirve para entrar a otro buzón, porque el descifrado falla.

import crypto from 'node:crypto';
import { keys as defaultKeys } from './config.mjs';
import { errors } from './errors.mjs';

const b64 = (buf) => buf.toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url');

export const aadFor = (clientId, email) => `mailgw:${clientId}:${email.toLowerCase()}`;

export function encryptSecret(plain, aad, keys = defaultKeys()) {
  const [id, key] = keys.current;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', id, b64(iv), b64(cipher.getAuthTag()), b64(ct)].join(':');
}

export function decryptSecret(blob, aad, keys = defaultKeys()) {
  const [v, id, iv, tag, ct] = String(blob).split(':');
  if (v !== 'v1' || !ct) throw errors.config('Secreto de buzón con formato desconocido.');
  const key = keys.byId.get(id);
  if (!key) throw errors.config(`No está la clave "${id}" en MAILGW_ENC_KEYS para descifrar el buzón.`);
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, unb64(iv));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(unb64(tag));
    return Buffer.concat([decipher.update(unb64(ct)), decipher.final()]).toString('utf8');
  } catch {
    throw errors.config('No se pudo descifrar la contraseña del buzón (clave o buzón equivocados).');
  }
}

export const keyIdOf = (blob) => String(blob).split(':')[1];

// Tokens del gateway: "mgw_" + 32 bytes aleatorios. En la base sólo va el sha256.
export function newToken() {
  const token = `mgw_${crypto.randomBytes(32).toString('base64url')}`;
  return { token, hash: hashToken(token) };
}

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
