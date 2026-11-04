import { hashToken } from './crypto.mjs';
import { findToken } from './store.mjs';
import { errors } from './errors.mjs';

export function bearerOf(req) {
  const raw = req.headers?.authorization ?? '';
  const m = /^Bearer\s+(\S+)\s*$/i.exec(String(raw));
  return m ? m[1] : null;
}

// Contexto de un pedido: de qué cliente es el token y qué permisos tiene. Todo lo demás
// (qué buzones ve) se filtra por clientId en la base.
export async function authenticate(req) {
  const token = bearerOf(req);
  if (!token || !token.startsWith('mgw_') || token.length > 200) throw errors.unauthorized();
  const row = await findToken(hashToken(token));
  if (!row) throw errors.unauthorized();
  return { clientId: row.client_id, tokenId: row.id, tokenName: row.name, scopes: row.scopes };
}
