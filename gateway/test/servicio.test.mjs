// El servicio del panel sin HTTP (docs/23 §2, etapa M0): las operaciones se llaman con
// { user, params, body } y aplican los mismos permisos que las rutas. Es como las va a usar el
// MCP del panel, que no tiene cookie ni pedido HTTP.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/store.mjs';
import * as S from '../src/admin/servicio.mjs';

const A = 'srv-a';
const B = 'srv-b';
const bigua = { id: null, email: 'op@bigua.test', role: 'bigua_admin', client_id: null };
const deA = { id: null, email: 'ana@srv-a.test', role: 'client_admin', client_id: A };

before(async () => {
  await store.asOwner(async (c) => {
    for (const id of [A, B]) await c.query(`insert into mailgw.client (id, name) values ($1, $1) on conflict do nothing`, [id]);
  });
});

test('el cliente ve su cliente y no otro, igual que por la ruta', async () => {
  const r = await S.clienteVer({ user: deA, params: { client: A } });
  assert.equal(r.client.id, A);
  assert.equal(r.can_manage_access, false);
  assert.equal(r.users, undefined);
  await assert.rejects(S.clienteVer({ user: deA, params: { client: B } }), (e) => e.code === 'not_found');
  await assert.rejects(S.noContactarListar({ user: deA, params: { client: B } }), (e) => e.code === 'not_found');
});

test('el cliente lista sólo su cliente; Biguá, todos', async () => {
  const propio = await S.clientesListar({ user: deA });
  assert.deepEqual(propio.clients.map((c) => c.id), [A]);
  const todos = (await S.clientesListar({ user: bigua })).clients.map((c) => c.id);
  assert.ok(todos.includes(A) && todos.includes(B));
});

test('lo que es sólo de Biguá se niega al cliente', async () => {
  await assert.rejects(S.clienteCrear({ user: deA, body: { id: 'srv-c', name: 'C' } }), (e) => e.code === 'forbidden');
  await assert.rejects(S.tokenCrear({ user: deA, params: { client: A }, body: { name: 'x', scopes: ['read'] } }), (e) => e.code === 'forbidden');
  await assert.rejects(S.equipoListar({ user: deA }), (e) => e.code === 'forbidden');
});

test('las validaciones son las de la ruta', async () => {
  await assert.rejects(S.noContactarAgregar({ user: deA, params: { client: A }, body: { valor: 'no es nada' } }),
    (e) => e.code === 'invalid_request');
  const r = await S.noContactarAgregar({ user: deA, params: { client: A }, body: { valor: 'competidor.test', motivo: 'competencia' } });
  assert.equal(r.agregados, 1);
  assert.ok(r.no_contactar.some((x) => x.valor === 'competidor.test'));
});
