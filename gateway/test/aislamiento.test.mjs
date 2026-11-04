// Aislamiento entre clientes en la base misma, sin pasar por el gateway: con el rol de la
// aplicación (mailgw_app) y un cliente fijado, cada consulta tiene que ver y tocar sólo las
// filas de ese cliente, aunque la consulta no filtre por cliente.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { newToken } from '../src/crypto.mjs';

let owner;

// Una transacción como la que abre el gateway para un pedido.
async function as(clientId, sql, params = []) {
  const c = await owner.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('role', 'mailgw_app', true), set_config('mailgw.client_id', $1, true)`, [clientId ?? '']);
    const r = await c.query(sql, params);
    await c.query('rollback');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const ids = {};
let hashA;

before(async () => {
  owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  await owner.query(`insert into mailgw.client (id, name) values ('iso-a', 'A'), ('iso-b', 'B') on conflict do nothing`);
  for (const [k, client, email] of [['a', 'iso-a', 'x@a.test'], ['b', 'iso-b', 'x@b.test'], ['b2', 'iso-b', 'mismo@comun.test'], ['a2', 'iso-a', 'mismo@comun.test']]) {
    const { rows } = await owner.query(
      `insert into mailgw.account (client_id, email, username, secret_enc, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security)
       values ($1, $2, $2, 'v1:k:x:y:z', 'h', 993, 'tls', 'h', 465, 'tls') returning id`, [client, email]);
    ids[k] = rows[0].id;
  }
  await owner.query(`insert into mailgw.send_log (client_id, account_id, idempotency_key, day, kind, status)
                     values ('iso-b', $1, 'clave-de-b-0001', current_date, 'send', 'sent')`, [ids.b]);
  const t = newToken();
  hashA = t.hash;
  await owner.query(`insert into mailgw.token (client_id, name, token_hash, scopes) values ('iso-a', 't', $1, '{read}')`, [hashA]);
});

after(async () => {
  await owner.query(`delete from mailgw.client where id in ('iso-a', 'iso-b')`);
  await owner.end();
});

test('cada cliente ve sólo sus buzones, aunque la consulta no filtre', async () => {
  const a = await as('iso-a', `select email from mailgw.account where client_id like 'iso-%' order by email`);
  assert.deepEqual(a.rows.map((r) => r.email), ['mismo@comun.test', 'x@a.test']);
  const b = await as('iso-b', `select email from mailgw.account where client_id like 'iso-%' order by email`);
  assert.deepEqual(b.rows.map((r) => r.email), ['mismo@comun.test', 'x@b.test']);
});

test('sin cliente fijado no se ve nada', async () => {
  assert.equal((await as(null, `select * from mailgw.account`)).rowCount, 0);
  assert.equal((await as(null, `select * from mailgw.send_log`)).rowCount, 0);
  assert.equal((await as(null, `select * from mailgw.client`)).rowCount, 0);
});

test('no se pueden leer los envíos ni los contadores de otro cliente', async () => {
  assert.equal((await as('iso-a', `select * from mailgw.send_log where idempotency_key = 'clave-de-b-0001'`)).rowCount, 0);
  assert.equal((await as('iso-b', `select * from mailgw.send_log where idempotency_key = 'clave-de-b-0001'`)).rowCount, 1);
});

test('no se pueden modificar ni borrar filas de otro cliente', async () => {
  const upd = await as('iso-a', `update mailgw.account set status = 'paused' where id = $1`, [ids.b]);
  assert.equal(upd.rowCount, 0);
  const del = await as('iso-a', `delete from mailgw.send_log where account_id = $1`, [ids.b]);
  assert.equal(del.rowCount, 0);
  // Mover un buzón propio a otro cliente tampoco.
  await assert.rejects(as('iso-a', `update mailgw.account set client_id = 'iso-b' where id = $1`, [ids.a]), /row-level security/);
});

test('no se pueden escribir filas a nombre de otro cliente ni contra un buzón ajeno', async () => {
  await assert.rejects(
    as('iso-a', `insert into mailgw.send_log (client_id, account_id, idempotency_key, day, kind, status)
                 values ('iso-b', $1, 'intrusa-0000001', current_date, 'send', 'reserved')`, [ids.b]),
    /row-level security/);
  await assert.rejects(
    as('iso-a', `insert into mailgw.send_log (client_id, account_id, idempotency_key, day, kind, status)
                 values ('iso-a', $1, 'intrusa-0000002', current_date, 'send', 'reserved')`, [ids.b]),
    /foreign key|violates/);
  await assert.rejects(
    as('iso-a', `insert into mailgw.audit_log (client_id, op, ok) values ('iso-b', 'x', true)`),
    /row-level security/);
});

test('el rol de la aplicación no lee tokens ni crea buzones; autenticar sólo devuelve su cliente', async () => {
  await assert.rejects(as('iso-a', `select * from mailgw.token`), /permission denied/);
  await assert.rejects(
    as('iso-a', `insert into mailgw.account (client_id, email, username, secret_enc, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security)
                 values ('iso-a', 'nuevo@a.test', 'u', 's', 'h', 993, 'tls', 'h', 465, 'tls')`),
    /permission denied/);
  const r = await as(null, `select client_id, scopes from mailgw.autenticar($1)`, [hashA]);
  assert.deepEqual(r.rows, [{ client_id: 'iso-a', scopes: ['read'] }]);
  assert.equal((await as(null, `select * from mailgw.autenticar('no-existe')`)).rowCount, 0);
});

test('el rol de la aplicación no saltea RLS ni es dueño de nada', async () => {
  const { rows } = await owner.query(`select rolbypassrls, rolsuper, rolcanlogin from pg_roles where rolname = 'mailgw_app'`);
  assert.deepEqual(rows[0], { rolbypassrls: false, rolsuper: false, rolcanlogin: false });
  const own = await owner.query(`select count(*)::int n from pg_tables where schemaname = 'mailgw' and tableowner = 'mailgw_app'`);
  assert.equal(own.rows[0].n, 0);
});
