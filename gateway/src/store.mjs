// Acceso a la base (esquema mailgw). Todo lo que hace cumplir una regla —cupo diario,
// idempotencia de envíos, bloqueo por fallas de autenticación— se resuelve acá en una
// sola sentencia o transacción, nunca leyendo y después escribiendo desde JS.

import pg from 'pg';
import { errors } from './errors.mjs';
import { limits } from './config.mjs';

let pool;

// DATABASE_URL, o la POSTGRES_URL que la integración de Supabase en Vercel carga sola al
// conectar la base al proyecto. Esa trae sslmode y parámetros propios del pooler (supa,
// pgbouncer) que pg interpreta a su modo y pisan la configuración TLS de abajo: se sacan.
export function connectionString() {
  const raw = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!raw) throw errors.config('Falta DATABASE_URL (o POSTGRES_URL de la integración de Supabase).');
  const url = new URL(raw);
  for (const k of ['sslmode', 'sslrootcert', 'supa', 'pgbouncer']) url.searchParams.delete(k);
  return url.toString();
}

export function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: connectionString(),
      // El pooler de Supabase exige TLS. Igual que ASCI, sin validar la cadena: el
      // certificado del pooler no está en el almacén de Node.
      ssl: process.env.MAILGW_DB_SSL === 'off' ? false : { rejectUnauthorized: false },
      max: 3,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return pool;
}

export async function closePool() {
  if (pool) { const p = pool; pool = undefined; await p.end(); }
}

// Dos maneras de hablar con la base:
//
//   q / tx      con el usuario de la conexión, dueño de las tablas: sólo la CLI de
//               administración (altas, migraciones, rotación de llave).
//   asClient    todo lo que el gateway hace por un pedido: en una transacción con el rol
//               mailgw_app y mailgw.client_id fijado al cliente del token. Las políticas de
//               la 002 filtran cada tabla por ese cliente, así que una consulta con un error
//               no puede leer ni escribir filas de otro cliente.
const q = (text, params) => getPool().query(text, params);

async function tx(fn) {
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

// set_config(..., true) vale sólo para la transacción: con el pooler en modo transacción la
// conexión física se comparte entre pedidos, y nada de un cliente queda pegado a la próxima.
async function asClient(clientId, fn) {
  return tx(async (c) => {
    await c.query(`select set_config('role', 'mailgw_app', true), set_config('mailgw.client_id', $1, true)`,
      [clientId ?? '']);
    return fn(c);
  });
}

const one = async (clientId, text, params) => (await asClient(clientId, (c) => c.query(text, params))).rows;

// ---------------------------------------------------------------- tokens

// Antes de saber de qué cliente es el pedido: el rol de la aplicación sin cliente fijado no
// ve ninguna fila, y el token se busca por hash con mailgw.autenticar.
export async function findToken(hash) {
  const rows = await one(null, `select id, client_id, name, scopes from mailgw.autenticar($1)`, [hash]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------- buzones

const PUBLIC_COLS = `id, client_id, email, display_name, imap_host, imap_port, imap_security,
  smtp_host, smtp_port, smtp_security, timezone, daily_send_cap, append_sent, sent_folder,
  drafts_folder, status, auth_failures, last_ok_at, last_error, last_error_at`;

// El filtro por client_id se mantiene en las consultas además de la política: la política es
// la segunda barrera, no la única.
export async function listAccounts(clientId) {
  return one(clientId, `select ${PUBLIC_COLS} from mailgw.account where client_id = $1 order by email`, [clientId]);
}

export async function getAccount(clientId, email) {
  const rows = await one(clientId,
    `select ${PUBLIC_COLS}, username, secret_enc from mailgw.account
      where client_id = $1 and email = lower($2)`, [clientId, email]);
  return rows[0] ?? null;
}

// Resultado de un intento de autenticación contra el servidor del buzón. Tres fallas
// seguidas bloquean el buzón: los servidores de hosting compartido (cPanel, Plesk)
// suelen bloquear la IP o la cuenta tras unos pocos intentos fallidos, y el gateway
// reintentaría cada 15 minutos.
export async function recordAuth(account, ok, message = null) {
  if (ok) {
    await one(account.client_id,
      `update mailgw.account set auth_failures = 0, last_ok_at = now(), updated_at = now()
        where id = $1 and (auth_failures <> 0 or last_ok_at is null or last_ok_at < now() - interval '1 minute')`,
      [account.id]);
    return;
  }
  await one(account.client_id,
    `update mailgw.account
        set auth_failures = auth_failures + 1,
            status = case when auth_failures + 1 >= $3 then 'auth_error' else status end,
            last_error = $2, last_error_at = now(), updated_at = now()
      where id = $1`, [account.id, message, limits.maxAuthFailures]);
}

export async function recordError(account, message) {
  await one(account.client_id,
    `update mailgw.account set last_error = $2, last_error_at = now(), updated_at = now() where id = $1`,
    [account.id, message]);
}

// ---------------------------------------------------------------- envíos

// Reserva un envío: idempotencia y cupo en una sola transacción.
// Devuelve { state: 'reserved', id } | { state: 'duplicate', row } | { state: 'in_progress' }
//        | { state: 'cap_reached' }.
export async function reserveSend(account, key, day, kind) {
  return asClient(account.client_id, async (c) => {
    const ins = await c.query(
      `insert into mailgw.send_log (client_id, account_id, idempotency_key, day, kind, status)
       values ($1, $2, $3, $4, $5, 'reserved')
       on conflict (account_id, idempotency_key) do nothing
       returning id`, [account.client_id, account.id, key, day, kind]);
    if (!ins.rows.length) {
      const prev = await c.query(
        `select status, kind, message_id, recipients, subject, smtp_response, sent_folder, sent_uid, sent_at
           from mailgw.send_log where account_id = $1 and idempotency_key = $2`, [account.id, key]);
      const row = prev.rows[0];
      return row?.status === 'sent' ? { state: 'duplicate', row } : { state: 'in_progress' };
    }
    const cnt = await c.query(
      `insert into mailgw.send_counter as s (client_id, account_id, day, count) values ($1, $2, $3, 1)
       on conflict (account_id, day) do update set count = s.count + 1
         where s.count < $4
       returning count`, [account.client_id, account.id, day, account.daily_send_cap]);
    if (!cnt.rows.length || cnt.rows[0].count > account.daily_send_cap) {
      throw Object.assign(new Error('cap'), { capReached: true });
    }
    return { state: 'reserved', id: ins.rows[0].id };
  }).catch((e) => {
    if (e.capReached) return { state: 'cap_reached' };
    throw e;
  });
}

export async function completeSend(account, id, r) {
  await one(account.client_id,
    `update mailgw.send_log
        set status = 'sent', message_id = $2, recipients = $3, subject = $4, smtp_response = $5,
            sent_folder = $6, sent_uid = $7, sent_at = now()
      where id = $1`,
    [id, r.message_id, r.recipients, r.subject, r.smtp_response, r.sent_folder, r.sent_uid]);
}

// Un envío que falló antes de que el servidor SMTP lo aceptara: se borra la reserva y se
// devuelve el lugar en el cupo, así un reintento con la misma clave vuelve a intentar.
export async function releaseSend(account, id, day) {
  await asClient(account.client_id, async (c) => {
    await c.query(`delete from mailgw.send_log where id = $1 and status = 'reserved'`, [id]);
    await c.query(`update mailgw.send_counter set count = greatest(count - 1, 0)
                    where account_id = $1 and day = $2`, [account.id, day]);
  });
}

export async function sendsToday(account, day) {
  const rows = await one(account.client_id,
    `select count from mailgw.send_counter where account_id = $1 and day = $2`, [account.id, day]);
  return rows[0]?.count ?? 0;
}

// ---------------------------------------------------------------- auditoría

export async function audit(entry) {
  try {
    await one(entry.clientId,
      `insert into mailgw.audit_log (client_id, token_id, account_id, op, ok, error_code, detail)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [entry.clientId ?? null, entry.tokenId ?? null, entry.accountId ?? null, entry.op, entry.ok,
        entry.errorCode ?? null, entry.detail ? JSON.stringify(entry.detail) : null]);
  } catch (e) {
    // La auditoría no tumba la operación que ya se hizo.
    console.error('[mailgw] audit', e.message);
  }
}

// ---------------------------------------------------------------- administración (CLI)

export async function migrate(sqlFiles) {
  await q(`create schema if not exists mailgw`);
  await q(`create table if not exists mailgw.migration (name text primary key, applied_at timestamptz not null default now())`);
  await q(`alter table mailgw.migration enable row level security`);
  const done = new Set((await q(`select name from mailgw.migration`)).rows.map((r) => r.name));
  const applied = [];
  for (const { name, sql } of sqlFiles) {
    if (done.has(name)) continue;
    await tx(async (c) => {
      await c.query(sql);
      await c.query(`insert into mailgw.migration (name) values ($1)`, [name]);
    });
    applied.push(name);
  }
  return applied;
}

export async function upsertClient(id, name) {
  await q(`insert into mailgw.client (id, name) values ($1, $2)
           on conflict (id) do update set name = excluded.name`, [id, name]);
}

export async function createToken(clientId, name, hash, scopes, expiresAt) {
  const { rows } = await q(
    `insert into mailgw.token (client_id, name, token_hash, scopes, expires_at)
     values ($1, $2, $3, $4, $5) returning id`, [clientId, name, hash, scopes, expiresAt]);
  return rows[0].id;
}

export async function listTokens(clientId) {
  const { rows } = await q(
    `select id, name, scopes, created_at, expires_at, revoked_at, last_used_at
       from mailgw.token where client_id = $1 order by created_at`, [clientId]);
  return rows;
}

export async function revokeToken(id) {
  const { rowCount } = await q(`update mailgw.token set revoked_at = now() where id = $1 and revoked_at is null`, [id]);
  return rowCount > 0;
}

export async function upsertAccount(a) {
  const { rows } = await q(
    `insert into mailgw.account (client_id, email, display_name, username, secret_enc,
        imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security,
        timezone, daily_send_cap, append_sent, sent_folder, drafts_folder)
     values ($1, lower($2), $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     on conflict (client_id, email) do update set
        display_name = excluded.display_name, username = excluded.username, secret_enc = excluded.secret_enc,
        imap_host = excluded.imap_host, imap_port = excluded.imap_port, imap_security = excluded.imap_security,
        smtp_host = excluded.smtp_host, smtp_port = excluded.smtp_port, smtp_security = excluded.smtp_security,
        timezone = excluded.timezone, daily_send_cap = excluded.daily_send_cap, append_sent = excluded.append_sent,
        sent_folder = excluded.sent_folder, drafts_folder = excluded.drafts_folder,
        status = 'active', auth_failures = 0, updated_at = now()
     returning id`,
    [a.client_id, a.email, a.display_name ?? null, a.username, a.secret_enc,
      a.imap_host, a.imap_port, a.imap_security, a.smtp_host, a.smtp_port, a.smtp_security,
      a.timezone, a.daily_send_cap, a.append_sent, a.sent_folder ?? null, a.drafts_folder ?? null]);
  return rows[0].id;
}

export async function setSecret(clientId, email, secretEnc) {
  const { rowCount } = await q(
    `update mailgw.account set secret_enc = $3, status = 'active', auth_failures = 0, updated_at = now()
      where client_id = $1 and email = lower($2)`, [clientId, email, secretEnc]);
  return rowCount > 0;
}

export async function setStatus(clientId, email, status) {
  const { rowCount } = await q(
    `update mailgw.account set status = $3, auth_failures = case when $3 = 'active' then 0 else auth_failures end,
            updated_at = now()
      where client_id = $1 and email = lower($2)`, [clientId, email, status]);
  return rowCount > 0;
}

// Un envío cortado a mitad (status reserved) bloquea su clave para no duplicar. Un operador
// lo libera después de confirmar en Enviados que el mail no salió.
export async function clearReservation(clientId, email, key) {
  return tx(async (c) => {
    const { rows } = await c.query(
      `delete from mailgw.send_log l using mailgw.account a
        where l.account_id = a.id and a.client_id = $1 and a.email = lower($2)
          and l.idempotency_key = $3 and l.status = 'reserved'
        returning l.account_id, l.day`, [clientId, email, key]);
    if (!rows.length) return false;
    await c.query(`update mailgw.send_counter set count = greatest(count - 1, 0) where account_id = $1 and day = $2`,
      [rows[0].account_id, rows[0].day]);
    return true;
  });
}

export async function allSecrets() {
  const { rows } = await q(`select id, client_id, email, secret_enc from mailgw.account`);
  return rows;
}

export async function setSecretById(id, secretEnc) {
  await q(`update mailgw.account set secret_enc = $2, updated_at = now() where id = $1`, [id, secretEnc]);
}
