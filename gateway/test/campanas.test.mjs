// Campañas en la base (migración 012, docs/21 §6.2): la «principal» de cada cliente, campana_id
// completado solo en el registro, y el aislamiento entre clientes de las tablas nuevas.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';

let owner;

// Una transacción como la que abre el gateway para un pedido.
async function as(role, clientId, sql, params = []) {
  const c = await owner.connect();
  try {
    await c.query('begin');
    await c.query(`select set_config('role', $1, true), set_config('mailgw.client_id', $2, true)`, [role, clientId ?? '']);
    const r = await c.query(sql, params);
    await c.query('commit');
    return r;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
const app = (clientId, sql, params) => as('mailgw_app', clientId, sql, params);
const portal = (clientId, sql, params) => as('mailgw_portal', clientId, sql, params);

const buzon = {};

before(async () => {
  owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  await owner.query(`insert into mailgw.client (id, name) values ('cmp-a', 'A'), ('cmp-b', 'B'), ('cmp-c', 'C') on conflict do nothing`);
  for (const [k, client, email] of [['a1', 'cmp-a', 'uno@a.test'], ['a2', 'cmp-a', 'dos@a.test'], ['b1', 'cmp-b', 'uno@b.test']]) {
    const { rows } = await owner.query(
      `insert into mailgw.account (client_id, email, username, secret_enc, imap_host, imap_port, imap_security, smtp_host, smtp_port, smtp_security)
       values ($1, $2, $2, 'v1:k:x:y:z', 'h', 993, 'tls', 'h', 465, 'tls') returning id`, [client, email]);
    buzon[k] = rows[0].id;
  }
  await owner.query(`insert into sdr.dripify_cuenta (client_id, campana_id) values ('cmp-a', 777)`);
});

after(async () => {
  await owner.query(`delete from mailgw.client where id in ('cmp-a', 'cmp-b', 'cmp-c')`);
  await owner.end();
});

const principal = async (clientId) =>
  (await owner.query(`select * from sdr.campana where client_id = $1 and clave = 'principal'`, [clientId])).rows[0];

test('el alta de la configuración crea la «principal» con los ajustes de hoy', async () => {
  const ajustes = {
    nombre_comercial: 'A SA', oferta: 'QA tercerizado', icp: 'Software B2B', roles_objetivo: ['CTO'],
    senal_avisos: 'avisos de QA', dias_aviso: 14, llamado_accion: 'Una charla', positivos: ['pide reunión'],
    acepta_mails_extrapolados: true, cuentas_por_dia: 12, excluir: ['consultoras'], tono: 'directo',
  };
  await owner.query(`insert into sdr.cliente_config (client_id, ajustes, calibracion_mails) values ('cmp-a', $1, 7)`, [ajustes]);

  const p = await principal('cmp-a');
  assert.equal(p.nombre, 'Principal');
  assert.equal(p.tipo, 'prospeccion');
  assert.equal(p.estado, 'activa');
  assert.equal(p.cuentas_por_dia, 12);
  assert.equal(p.calibracion_mails, 7);
  assert.equal(Number(p.dripify_campana_id), 777);
  assert.deepEqual(p.ajustes, {
    propuesta: 'QA tercerizado', icp: 'Software B2B', roles_objetivo: ['CTO'], senal_avisos: 'avisos de QA',
    dias_aviso: 14, llamado_accion: 'Una charla', positivos: ['pide reunión'], acepta_mails_extrapolados: true,
  });

  const bz = await owner.query(`select account_id from sdr.campana_buzon where campana_id = $1 order by account_id`, [p.id]);
  assert.deepEqual(bz.rows.map((r) => r.account_id).sort(), [buzon.a1, buzon.a2].sort());

  // Empresa no cambia: las claves se copian, no se mueven (las mueve la 013).
  const cfg = (await owner.query(`select ajustes from sdr.cliente_config where client_id = 'cmp-a'`)).rows[0];
  assert.equal(cfg.ajustes.oferta, 'QA tercerizado');
  assert.equal(cfg.ajustes.cuentas_por_dia, 12);
});

test('sin bots activos, la «principal» nace pausada', async () => {
  await owner.query(`insert into sdr.cliente_config (client_id, bots_activos) values ('cmp-c', '{}')`);
  const p = await principal('cmp-c');
  assert.equal(p.estado, 'pausada');
  assert.equal(p.cuentas_por_dia, 0);
  assert.deepEqual(p.ajustes, {});
});

test('lo que el código de hoy guarda sin campaña queda en la «principal»', async () => {
  const pa = await principal('cmp-a');
  const cta = await app('cmp-a', `insert into sdr.cuenta (client_id, nombre, dominio) values ('cmp-a', 'Acme', 'acme.test') returning *`);
  assert.equal(cta.rows[0].campana_id, pa.id);
  const pr = await app('cmp-a', `insert into sdr.prospecto (client_id, cuenta_id, nombre) values ('cmp-a', $1, 'Ana') returning *`, [cta.rows[0].id]);
  assert.equal(pr.rows[0].campana_id, pa.id);
  const ev = await app('cmp-a', `insert into sdr.evento (client_id, prospecto_id, tipo) values ('cmp-a', $1, 'nota') returning campana_id`, [pr.rows[0].id]);
  assert.equal(ev.rows[0].campana_id, pa.id);
  const ap = await app('cmp-a', `insert into sdr.aprobacion (client_id, tipo, pedida_por, contenido) values ('cmp-a', 'calibracion_mail', 'prospector', '{}') returning campana_id`);
  assert.equal(ap.rows[0].campana_id, pa.id);
  const pe = await app('cmp-a', `insert into sdr.pedido (client_id, de_bot, para_bot, que) values ('cmp-a', 'orquestador', 'prospector', '3 cuentas') returning campana_id`);
  assert.equal(pe.rows[0].campana_id, pa.id);
  const dc = await app('cmp-a', `insert into sdr.dripify_carga (client_id, clave, dripify_campana_id, prospectos) values ('cmp-a', 'carga-1', 777, '{}') returning campana_id`);
  assert.equal(dc.rows[0].campana_id, pa.id);
});

test('un cliente sin configuración recibe su «principal» con la primera fila del registro', async () => {
  assert.equal(await principal('cmp-b'), undefined);
  const r = await app('cmp-b', `insert into sdr.cuenta (client_id, nombre) values ('cmp-b', 'Beta') returning campana_id`);
  const p = await principal('cmp-b');
  assert.equal(r.rows[0].campana_id, p.id);
  assert.equal(p.estado, 'activa');
  assert.equal((await owner.query(`select count(*)::int n from sdr.campana_buzon where campana_id = $1`, [p.id])).rows[0].n, 1);
});

test('no se puede atar una fila ni un buzón a una campaña de otro cliente', async () => {
  const pb = await principal('cmp-b');
  await assert.rejects(
    app('cmp-a', `insert into sdr.cuenta (client_id, nombre, campana_id) values ('cmp-a', 'Cruzada', $1)`, [pb.id]),
    /foreign key|violates/);
  const pa = await principal('cmp-a');
  await assert.rejects(
    owner.query(`insert into sdr.campana_buzon (client_id, campana_id, account_id) values ('cmp-a', $1, $2)`, [pa.id, buzon.b1]),
    /foreign key|violates/);
});

test('la función de la «principal» no sirve para otro cliente', async () => {
  await assert.rejects(app('cmp-a', `select sdr.campana_principal('cmp-b')`), /fuera de la sesión/);
  await assert.rejects(app('cmp-a', `insert into sdr.cuenta (client_id, nombre) values ('cmp-b', 'Ajena')`),
    /row-level security/);
});

test('cada cliente ve sólo sus campañas; la aplicación no las escribe', async () => {
  const a = await app('cmp-a', `select clave from sdr.campana where client_id like 'cmp-%'`);
  assert.deepEqual(a.rows.map((r) => r.clave), ['principal']);
  const bz = await app('cmp-a', `select account_id from sdr.campana_buzon where client_id like 'cmp-%'`);
  assert.equal(bz.rows.length, 2);
  await assert.rejects(app('cmp-a', `update sdr.campana set nombre = 'x'`), /permission denied/);
  await assert.rejects(app('cmp-a', `insert into sdr.campana (client_id, clave, nombre) values ('cmp-a', 'otra', 'Otra')`), /permission denied/);
});

test('el panel crea campañas de su cliente y no de otro', async () => {
  const r = await portal('cmp-a', `insert into sdr.campana (client_id, clave, nombre, tipo) values ('cmp-a', 'webinar-2026-11', 'Webinar', 'evento') returning *`);
  assert.equal(r.rows[0].estado, 'borrador');
  assert.equal(r.rows[0].calibracion_mails, 5);
  await portal('cmp-a', `insert into sdr.campana_buzon (client_id, campana_id, account_id) values ('cmp-a', $1, $2)`, [r.rows[0].id, buzon.a1]);
  await assert.rejects(
    portal('cmp-a', `insert into sdr.campana (client_id, clave, nombre) values ('cmp-b', 'ajena', 'Ajena')`), /row-level security/);
  const vistas = await portal('cmp-b', `select clave from sdr.campana where client_id like 'cmp-%'`);
  assert.deepEqual(vistas.rows.map((x) => x.clave), ['principal']);
});

test('una campaña terminada lleva su fecha, y el fin no va antes del inicio', async () => {
  await assert.rejects(owner.query(`update sdr.campana set estado = 'terminada' where client_id = 'cmp-c'`), /check/);
  await owner.query(`update sdr.campana set estado = 'terminada', terminada_at = now() where client_id = 'cmp-c'`);
  await assert.rejects(
    owner.query(`insert into sdr.campana (client_id, clave, nombre, inicio, fin) values ('cmp-c', 'mal', 'Mal', '2026-11-20', '2026-11-10')`),
    /check/);
});
