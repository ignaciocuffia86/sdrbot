// Autenticación del panel /admin: contraseñas con scrypt, sesiones en la base con la cookie
// como único portador, y activación de cuentas con un enlace de un solo uso.

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { getPool } from '../store.mjs';
import { GatewayError } from '../errors.mjs';

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 };

export const SESSION_COOKIE = 'mgw_admin';
const SESSION_HOURS = 12;
const IDLE_MINUTES = 120;
const SETUP_HOURS = 24;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
export const MIN_PASSWORD = 12;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');
const q = (text, params) => getPool().query(text, params);

export const authError = (message = 'Email o contraseña incorrectos.') =>
  new GatewayError('unauthorized', message, 401);

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, key] = String(stored ?? '').split('$');
  if (alg !== 'scrypt' || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const got = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

// Hash de referencia para igualar el tiempo de respuesta cuando el email no existe.
let dummyHash;

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > 200) {
    throw new GatewayError('invalid_request', `La contraseña tiene que tener entre ${MIN_PASSWORD} y 200 caracteres.`, 400);
  }
}

// ---------------------------------------------------------------- usuarios y activación

// Crea un usuario sin contraseña y devuelve el token de activación (una sola vez).
export async function createUser({ email, name, role, clientId, createdBy }) {
  const token = randomToken();
  const { rows } = await q(
    `insert into mailgw.admin_user (email, name, role, client_id, setup_token_hash, setup_expires_at, created_by)
     values (lower($1), $2, $3, $4, $5, now() + make_interval(hours => $6), $7)
     returning id, email, name, role, client_id`,
    [email, name, role, clientId ?? null, sha256(token), SETUP_HOURS, createdBy ?? null]);
  return { user: rows[0], setupToken: token };
}

// Nuevo enlace de activación: sirve para "olvidé mi contraseña" (lo genera un operador) y
// deja la contraseña anterior sin efecto recién cuando se usa el enlace.
export async function resetSetup(userId) {
  const token = randomToken();
  const { rowCount } = await q(
    `update mailgw.admin_user set setup_token_hash = $2, setup_expires_at = now() + make_interval(hours => $3)
      where id = $1`, [userId, sha256(token), SETUP_HOURS]);
  return rowCount ? token : null;
}

export async function activate(token, password) {
  validatePassword(password);
  const hash = await hashPassword(password);
  const { rows } = await q(
    `update mailgw.admin_user
        set password_hash = $2, setup_token_hash = null, setup_expires_at = null,
            failed_logins = 0, locked_until = null
      where setup_token_hash = $1 and setup_expires_at > now() and active
      returning id, email`, [sha256(String(token ?? '')), hash]);
  if (!rows.length) throw authError('El enlace de activación no es válido o ya venció. Pedí uno nuevo.');
  await q(`delete from mailgw.admin_session where user_id = $1`, [rows[0].id]);
  await revocarConexiones(rows[0].id);
  return rows[0];
}

// ---------------------------------------------------------------- login y sesiones

// Valida email y contraseña con el bloqueo por intentos fallidos, sin abrir sesión. La usan el
// login del panel y el login de OAuth del MCP del panel (docs/24 §3.4), con las mismas reglas.
export async function verificarCredenciales(email, password) {
  const { rows } = await q(
    `select id, email, name, role, client_id, password_hash, active, failed_logins, locked_until
       from mailgw.admin_user where email = lower($1)`,
    [String(email ?? '')]);
  const u = rows[0];
  dummyHash ??= await hashPassword(randomToken());
  if (!u || !u.active || !u.password_hash) {
    await verifyPassword(String(password ?? ''), dummyHash);
    throw authError();
  }
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    throw authError(`Cuenta bloqueada por intentos fallidos. Probá de nuevo en ${LOCK_MINUTES} minutos.`);
  }
  if (!(await verifyPassword(String(password ?? ''), u.password_hash))) {
    await q(`update mailgw.admin_user
                set failed_logins = failed_logins + 1,
                    locked_until = case when failed_logins + 1 >= $2 then now() + make_interval(mins => $3) else locked_until end
              where id = $1`, [u.id, MAX_FAILED, LOCK_MINUTES]);
    throw authError();
  }
  await q(`update mailgw.admin_user set failed_logins = 0, locked_until = null, last_login_at = now() where id = $1`, [u.id]);
  return { id: u.id, email: u.email, name: u.name, role: u.role, client_id: u.client_id };
}

export async function login(email, password, meta) {
  const u = await verificarCredenciales(email, password);
  const token = randomToken();
  await q(`insert into mailgw.admin_session (token_hash, user_id, expires_at, ip, user_agent)
           values ($1, $2, now() + make_interval(hours => $3), $4, $5)`,
  [sha256(token), u.id, SESSION_HOURS, meta?.ip ?? null, meta?.userAgent?.slice(0, 200) ?? null]);
  return token;
}

// Las conexiones de Claude (MCP del panel) de un usuario quedan revocadas cuando se lo desactiva o
// se le resetea la contraseña: un token copiado no sobrevive a eso.
export async function revocarConexiones(userId, c = null) {
  await (c ?? getPool()).query(`update mailgw.oauth_token set revoked_at = now() where user_id = $1 and revoked_at is null`, [userId]);
}

export async function logout(token) {
  if (token) await q(`delete from mailgw.admin_session where token_hash = $1`, [sha256(token)]);
}

// El usuario de una sesión vigente, o null. Una sesión vence a las 12 horas o tras dos
// horas sin uso; un usuario desactivado pierde todas sus sesiones.
export async function sessionUser(token) {
  if (!token) return null;
  const { rows } = await q(
    `update mailgw.admin_session s set last_seen_at = now()
       from mailgw.admin_user u
      where s.token_hash = $1 and u.id = s.user_id and u.active
        and s.expires_at > now() and s.last_seen_at > now() - make_interval(mins => $2)
      returning u.id, u.email, u.name, u.role, u.client_id`, [sha256(token), IDLE_MINUTES]);
  return rows[0] ?? null;
}

export async function changePassword(userId, current, next) {
  validatePassword(next);
  const { rows } = await q(`select password_hash from mailgw.admin_user where id = $1`, [userId]);
  if (!rows.length || !(await verifyPassword(String(current ?? ''), rows[0].password_hash))) {
    throw authError('La contraseña actual no es correcta.');
  }
  await q(`update mailgw.admin_user set password_hash = $2 where id = $1`, [userId, await hashPassword(next)]);
}

export function cookieFor(token, { secure = true } = {}) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/admin', 'HttpOnly', 'SameSite=Strict', `Max-Age=${SESSION_HOURS * 3600}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearCookie({ secure = true } = {}) {
  return [`${SESSION_COOKIE}=`, 'Path=/admin', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0', ...(secure ? ['Secure'] : [])].join('; ');
}

export function tokenFromCookie(req) {
  const raw = req.headers?.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === SESSION_COOKIE) return v.join('=') || null;
  }
  return null;
}
