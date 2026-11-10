// El alta de un cliente desde Claude (alta_cargar, docs/24 §4.4 y docs/29): la vista previa no toca
// nada, un error frena todo, con confirmar carga lo mismo que el asistente del panel, volver a
// llamarla no duplica, y lo que no pasa por el chat queda dicho con su motivo.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/store.mjs';
import * as S from '../src/admin/servicio.mjs';
import { activate, createUser } from '../src/admin/auth.mjs';
import { toolsPara } from '../src/panel/mcp.mjs';

const ID = 'alta-mcp';
let op;
const q = (sql, params) => store.asOwner((c) => c.query(sql, params));

before(async () => {
  const { user, setupToken } = await createUser({ email: 'op@alta-mcp.test', name: 'Op', role: 'bigua_admin' });
  await activate(setupToken, 'contrasena-larga-del-panel');
  op = user;
});

const FICHA = {
  cliente: { id: ID, nombre: 'Alta MCP SA' },
  sdr: { modo: 'operado', aprueba: 'cliente_y_bigua', bots_activos: ['orquestador', 'prospector', 'seguimiento'], calibracion_mails: 10 },
  empresa: {
    nombre_comercial: 'Alta MCP', descripcion: 'Hacemos testing de software para bancos.',
    tono: 'Cercano, técnico, sin exagerar.', idioma: 'Español, de vos',
    responsable_positivos: 'Ana Pérez', responsable_email: 'ana@altamcp.test',
    prueba_social: ['Banca: regresión de 5 días a 6 horas (caso publicado)'],
    excluir: ['Consultoras de testing'],
  },
  usuarios: [{ email: 'ana@altamcp.test', nombre: 'Ana Pérez' }],
  no_contactar: [{ valor: 'competidor.test', motivo: 'competencia' }, { valor: 'Banco Amigo SA' }],
  campana: { nombre: 'Bancos 2027', tipo: 'prospeccion', cuentas_por_dia: 5,
    ajustes: { propuesta: 'Regresión automatizada para core bancario.', roles_objetivo: ['Head of QA', 'CTO'] } },
  pasos: { asci: { estado: 'listo' }, whatsapp: { estado: 'no_aplica' }, crm: { estado: 'esperando', que: 'Si usan HubSpot o planilla', quien: 'el cliente' } },
  campos_pendientes: { link_agenda: { que: 'El link de Calendly de Ana', quien: 'Ana' } },
};

test('la vista previa arma el plan y no crea nada', async () => {
  const r = await S.altaCargar({ user: op, body: { ficha: FICHA } });
  assert.equal(r.vista_previa, true);
  assert.match(r.confirmar, /confirmar: true/);
  const pasos = r.plan.map((p) => p.paso);
  for (const p of ['cliente', 'sdr', 'empresa', 'usuario', 'exclusiones', 'campana', 'asci', 'whatsapp', 'crm', 'campo']) {
    assert.ok(pasos.includes(p), `el plan no dice nada de ${p}`);
  }
  assert.equal((await q(`select count(*)::int as n from mailgw.client where id = $1`, [ID])).rows[0].n, 0);
});

test('un dato inválido frena todo y no se carga nada', async () => {
  const mala = { ...FICHA, empresa: { ...FICHA.empresa, responsable_email: 'no-es-un-mail' },
    pasos: { empresa: { estado: 'listo' } } };
  const r = await S.altaCargar({ user: op, body: { ficha: mala, confirmar: true } });
  assert.equal(r.aplicado, false);
  assert.ok(r.errores.some((e) => /Mail de quien toma/.test(e)), r.errores.join(' | '));
  assert.ok(r.errores.some((e) => /queda listo solo/.test(e)), 'un paso con datos no se marca listo a mano');
  assert.equal((await q(`select count(*)::int as n from mailgw.client where id = $1`, [ID])).rows[0].n, 0);
  await assert.rejects(S.altaCargar({ user: op, body: { ficha: { ...FICHA, empresa: { inventado: 'x' } } } }),
    (e) => e.code === 'invalid_request');
});

test('con confirmar carga lo mismo que el asistente y dice lo que no pasa por el chat', async () => {
  const r = await S.altaCargar({ user: op, body: { ficha: FICHA, confirmar: true } });
  assert.equal(r.aplicado, true);
  assert.deepEqual(r.hecho.slice(0, 3), ['cliente', 'sdr', 'empresa']);
  const cfg = (await q(`select * from sdr.cliente_config where client_id = $1`, [ID])).rows[0];
  assert.equal(cfg.aprueba, 'cliente_y_bigua');
  assert.equal(cfg.calibracion_mails, 10);
  assert.equal(cfg.ajustes.nombre_comercial, 'Alta MCP');
  assert.equal(cfg.ajustes.responsable_email, 'ana@altamcp.test');
  const u = (await q(`select client_id, role from mailgw.admin_user where email = 'ana@altamcp.test'`)).rows[0];
  assert.deepEqual([u.client_id, u.role], [ID, 'client_admin']);
  assert.ok(!JSON.stringify(r).includes('setup_token'), 'el enlace de activación no vuelve por el chat');
  assert.match(r.notas[0], /Nuevo enlace/);
  assert.equal((await q(`select count(*)::int as n from sdr.no_contactar where client_id = $1`, [ID])).rows[0].n, 2);
  const k = (await q(`select estado, cuentas_por_dia, ajustes from sdr.campana where client_id = $1 and nombre = 'Bancos 2027'`, [ID])).rows[0];
  assert.equal(k.estado, 'borrador');
  assert.equal(k.cuentas_por_dia, 5);
  assert.deepEqual(k.ajustes.roles_objetivo, ['Head of QA', 'CTO']);

  const pasos = Object.fromEntries(r.alta.pasos.map((p) => [p.clave, p]));
  assert.equal(pasos.sdr.estado, 'listo');
  assert.equal(pasos.empresa.estado, 'listo');
  assert.equal(pasos.interesados.estado, 'esperando', 'link_agenda quedó pendiente, y es de «Interesados»');
  assert.equal(pasos.asci.estado, 'listo');
  assert.equal(pasos.whatsapp.estado, 'no_aplica');
  assert.equal(pasos.crm.estado, 'esperando');
  assert.equal(pasos.crm.quien, 'el cliente');
  assert.ok(r.fuera_del_chat.some((x) => x.paso === 'Buzones' && /contraseña/.test(x.motivo)));
  assert.ok(!r.fuera_del_chat.some((x) => x.paso === 'WhatsApp'), 'lo que no aplica no queda como pendiente');
  // El asistente del panel ve lo mismo.
  const panel = await S.altaVer({ user: op, params: { client: ID } });
  assert.equal(panel.listos, r.alta.listos);
});

test('volver a llamar con más respuestas completa sin duplicar', async () => {
  const mas = { ...FICHA, empresa: { ...FICHA.empresa, link_agenda: 'https://calendly.com/ana' }, campos_pendientes: undefined };
  delete mas.campos_pendientes;
  const previa = await S.altaCargar({ user: op, body: { ficha: mas } });
  assert.ok(previa.plan.some((p) => p.paso === 'cliente' && p.sin_cambios));
  assert.ok(previa.plan.some((p) => p.paso === 'campana' && p.sin_cambios));
  assert.ok(previa.plan.some((p) => p.paso === 'empresa' && /Link de agenda/.test(p.que)));
  const r = await S.altaCargar({ user: op, body: { ficha: mas, confirmar: true } });
  assert.ok(!r.hecho.includes('cliente') && !r.hecho.includes('campana'));
  assert.equal((await q(`select count(*)::int as n from sdr.campana where client_id = $1 and nombre = 'Bancos 2027'`, [ID])).rows[0].n, 1);
  assert.equal((await q(`select count(*)::int as n from sdr.no_contactar where client_id = $1`, [ID])).rows[0].n, 2);
  assert.equal((await q(`select ajustes->>'link_agenda' as l from sdr.cliente_config where client_id = $1`, [ID])).rows[0].l, 'https://calendly.com/ana');
  // El campo sigue esperando hasta que se lo saca de pendientes (como en el panel: «Ya está definido»).
  await S.altaCargar({ user: op, body: { ficha: { cliente: FICHA.cliente, pasos: { crm: { estado: 'no_aplica' } } }, confirmar: true } });
  assert.equal((await S.altaVer({ user: op, params: { client: ID } })).pasos.find((p) => p.clave === 'crm').estado, 'no_aplica');
});

test('sólo Biguá: un usuario de un cliente no carga altas', async () => {
  const cli = { id: null, email: 'ana@altamcp.test', role: 'client_admin', client_id: ID };
  await assert.rejects(S.altaCargar({ user: cli, body: { ficha: FICHA } }), (e) => e.code === 'forbidden');
  assert.ok(!toolsPara(cli).some((t) => t.name === 'alta_cargar'));
  const t = toolsPara(op).find((x) => x.name === 'alta_cargar');
  assert.ok(t.escribe, 'alta_cargar se anuncia como destructiveHint y cuenta en el tope de cambios');
});
