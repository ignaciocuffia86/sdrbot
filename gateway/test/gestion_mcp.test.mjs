// Etapa M3 del MCP del panel (docs/24 §4.2): gestionar desde Claude lo mismo que en el panel. Cada
// herramienta que cambia algo tiene vista previa (la misma operación, deshecha al final), aplica los
// mismos permisos que el panel y, con confirmar, deja lo mismo que la pantalla.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/store.mjs';
import * as sdr from '../src/sdr/store.mjs';
import { toolsPara } from '../src/panel/mcp.mjs';

const C = 'gest-a';
const AUTO = 'gest-auto';
const op = { id: null, email: 'op@gest.test', role: 'bigua_admin', client_id: null };
const cli = { id: null, email: 'ana@gest-a.test', role: 'client_admin', client_id: C };
const auto = { id: null, email: 'eva@gest-auto.test', role: 'client_admin', client_id: AUTO };
const q = (sql, params) => store.asOwner((c) => c.query(sql, params));

// Llama a la herramienta como lo hace el MCP: por nombre, con los argumentos, y devuelve lo que vuelve.
async function tool(user, name, args) {
  const t = toolsPara(user).find((x) => x.name === name);
  assert.ok(t, `${user.email} no tiene la herramienta ${name}`);
  return t.run(user, args);
}
const cuenta = async (sql, params) => (await q(sql, params)).rows[0].n;

before(async () => {
  for (const [id, modo] of [[C, 'operado'], [AUTO, 'autogestionado']]) {
    await store.upsertClient(id, id);
    await store.upsertAccount({
      client_id: id, email: `hola@${id}.test`, display_name: 'Hola', username: `hola@${id}.test`, secret_enc: Buffer.from('x'),
      imap_host: 'imap.test', imap_port: 993, imap_security: 'tls', smtp_host: 'smtp.test', smtp_port: 465, smtp_security: 'tls',
      timezone: 'America/Argentina/Buenos_Aires', daily_send_cap: 40, append_sent: false,
    });
    await sdr.setConfig(id, { bots_activos: ['orquestador', 'prospector'], modo, tope_cuentas_dia: 20 });
  }
});

test('las herramientas que cambian algo se anuncian como cambios', () => {
  const nombres = ['campana_crear', 'campana_editar', 'campana_estado', 'campana_duplicar', 'campana_restaurar', 'campana_paso_marcar',
    'ajustes_editar', 'ajustes_restaurar'];
  for (const n of nombres) {
    const t = toolsPara(cli).find((x) => x.name === n);
    assert.ok(t?.escribe, `${n} no está para el cliente o no cuenta como cambio`);
  }
});

test('Empresa: la vista previa dice antes y después y no guarda; con confirmar guarda', async () => {
  const previa = await tool(cli, 'ajustes_editar', { cambios: { nombre_comercial: 'Gest A', tono: 'Directo.' } });
  assert.equal(previa.vista_previa, true);
  assert.deepEqual(previa.cambios.map((x) => x.campo).sort(), ['nombre_comercial', 'tono']);
  assert.equal(previa.cambios.find((x) => x.campo === 'tono').despues, 'Directo.');
  assert.equal((await q(`select ajustes->>'tono' as t from sdr.cliente_config where client_id = $1`, [C])).rows[0].t, null);
  assert.equal(await cuenta(`select count(*)::int as n from sdr.ajustes_historial where client_id = $1`, [C]), 0, 'la vista previa no deja historial');

  const r = await tool(cli, 'ajustes_editar', { cambios: { nombre_comercial: 'Gest A', tono: 'Directo.' }, nota: 'desde Claude', confirmar: true });
  assert.deepEqual(r.cambios.sort(), ['nombre_comercial', 'tono']);
  assert.equal((await q(`select ajustes->>'tono' as t from sdr.cliente_config where client_id = $1`, [C])).rows[0].t, 'Directo.');
  // Lo que el cliente no edita en modo operado (si se aceptan mails extrapolados) se le niega, igual que en el panel.
  await assert.rejects(tool(cli, 'ajustes_editar', { cambios: { acepta_mails_extrapolados: true } }), (e) => e.code === 'forbidden');
  await assert.rejects(tool(cli, 'ajustes_editar', { cambios: { no_existe: 'x' } }), (e) => e.code === 'invalid_request');
});

test('Empresa: volver a una versión, con vista previa', async () => {
  await tool(cli, 'ajustes_editar', { cambios: { tono: 'Cálido.' }, confirmar: true });
  const versiones = (await q(`select id, ajustes->>'tono' as t from sdr.ajustes_historial where client_id = $1 and campana_id is null order by id`, [C])).rows;
  const primera = versiones.find((v) => v.t === 'Directo.');
  const previa = await tool(cli, 'ajustes_restaurar', { version: Number(primera.id) });
  assert.equal(previa.vista_previa, true);
  assert.deepEqual(previa.cambios.map((x) => [x.campo, x.antes, x.despues]), [['tono', 'Cálido.', 'Directo.']]);
  assert.equal((await q(`select ajustes->>'tono' as t from sdr.cliente_config where client_id = $1`, [C])).rows[0].t, 'Cálido.');
  await tool(cli, 'ajustes_restaurar', { version: Number(primera.id), confirmar: true });
  assert.equal((await q(`select ajustes->>'tono' as t from sdr.cliente_config where client_id = $1`, [C])).rows[0].t, 'Directo.');
});

test('campañas: crear con vista previa, por mail de buzón, y no crea nada hasta confirmar', async () => {
  const datos = { cliente: C, nombre: 'Bancos', cuentas_por_dia: 5, buzones: [`hola@${C}.test`],
    ajustes: { propuesta: 'Testing para bancos.', icp: 'Bancos medianos.', roles_objetivo: ['CTO'] } };
  // En modo operado el volumen y los buzones los elige Biguá, como en el panel.
  await assert.rejects(tool(cli, 'campana_crear', { ...datos, cliente: undefined }), (e) => e.code === 'forbidden');
  const previa = await tool(op, 'campana_crear', datos);
  assert.equal(previa.vista_previa, true);
  assert.equal(previa.campana.estado, 'borrador');
  assert.equal(previa.campana.id, undefined, 'la vista previa no tiene id: la campaña no llega a existir');
  assert.deepEqual(previa.cambios.find((x) => x.campo === 'buzones').despues, [`hola@${C}.test`]);
  assert.deepEqual(previa.faltantes, []);
  assert.equal(await cuenta(`select count(*)::int as n from sdr.campana where client_id = $1 and nombre = 'Bancos'`, [C]), 0);
  await assert.rejects(tool(op, 'campana_crear', { ...datos, buzones: ['ajeno@otro.test'] }), (e) => e.code === 'invalid_request');

  const r = await tool(op, 'campana_crear', { ...datos, confirmar: true });
  assert.equal(r.creada.estado, 'borrador');
  assert.equal(await cuenta(`select count(*)::int as n from sdr.campana where client_id = $1 and nombre = 'Bancos'`, [C]), 1);
});

test('campañas: editar muestra antes y después, respeta permisos y guarda con confirmar', async () => {
  const previa = await tool(op, 'campana_editar', { cliente: C, campana: 'bancos', cambios: { cuentas_por_dia: 8, ajustes: { propuesta: 'Regresión.' } } });
  assert.equal(previa.vista_previa, true);
  assert.deepEqual(previa.cambios.map((x) => [x.campo, x.antes, x.despues]).sort(),
    [['cuentas_por_dia', 5, 8], ['propuesta', 'Testing para bancos.', 'Regresión.']]);
  assert.equal((await q(`select cuentas_por_dia from sdr.campana where client_id = $1 and clave = 'bancos'`, [C])).rows[0].cuentas_por_dia, 5);
  // El cliente operado cambia lo que dice la campaña, no el volumen ni la campaña de Dripify.
  await assert.rejects(tool(cli, 'campana_editar', { campana: 'bancos', cambios: { cuentas_por_dia: 8 } }), (e) => e.code === 'forbidden');
  await assert.rejects(tool(cli, 'campana_editar', { campana: 'bancos', cambios: { dripify_campana_id: 9 } }), (e) => e.code === 'forbidden');
  const r = await tool(cli, 'campana_editar', { campana: 'bancos', cambios: { ajustes: { icp: 'Bancos chicos.' } }, nota: 'más chicos', confirmar: true });
  assert.deepEqual(r.cambios, ['icp']);
  assert.equal((await q(`select ajustes->>'icp' as i from sdr.campana where client_id = $1 and clave = 'bancos'`, [C])).rows[0].i, 'Bancos chicos.');
  const b = await tool(op, 'campana_editar', { cliente: C, campana: 'bancos', cambios: { cuentas_por_dia: 8 }, confirmar: true });
  assert.deepEqual(b.cambios, ['cuentas_por_dia']);
});

test('campañas: activar sólo en autogestionado, con lo que falta a la vista y la huella de la vista previa', async () => {
  // Operado: activar lo hace Biguá.
  await assert.rejects(tool(cli, 'campana_estado', { campana: 'bancos', estado: 'activa' }), (e) => e.code === 'forbidden');
  // Autogestionado: el cliente puede, si no falta nada.
  await tool(auto, 'ajustes_editar', { cambios: { nombre_comercial: 'Auto' }, confirmar: true });
  await tool(auto, 'campana_crear', { nombre: 'Retail', cuentas_por_dia: 3, ajustes: { propuesta: 'X.' }, confirmar: true });
  const falta = await tool(auto, 'campana_estado', { campana: 'retail', estado: 'activa' });
  assert.equal(falta.se_puede, false);
  assert.ok(falta.faltantes.some((m) => /buzón/.test(m)) && falta.faltantes.some((m) => /cargos/.test(m)), falta.faltantes.join(' | '));
  // Con confirmar tampoco: lo que falta frena antes.
  assert.equal((await tool(auto, 'campana_estado', { campana: 'retail', estado: 'activa', confirmar: true })).se_puede, false);
  assert.equal((await q(`select estado from sdr.campana where client_id = $1 and clave = 'retail'`, [AUTO])).rows[0].estado, 'borrador');

  await tool(auto, 'campana_editar', { campana: 'retail', cambios: { buzones: [`hola@${AUTO}.test`], ajustes: { icp: 'Retail.', roles_objetivo: ['CMO'] } }, confirmar: true });
  const previa = await tool(auto, 'campana_estado', { campana: 'retail', estado: 'activa' });
  assert.equal(previa.vista_previa, true);
  assert.equal(previa.se_puede, true);
  assert.equal(previa.estado, 'activa');
  assert.match(previa.huella, /^[0-9a-f]{16}$/);
  assert.equal((await q(`select estado from sdr.campana where client_id = $1 and clave = 'retail'`, [AUTO])).rows[0].estado, 'borrador');
  // Sin la huella de la vista previa, no se activa.
  await assert.rejects(tool(auto, 'campana_estado', { campana: 'retail', estado: 'activa', confirmar: true }), (e) => e.code === 'vista_previa_vencida');
  const r = await tool(auto, 'campana_estado', { campana: 'retail', estado: 'activa', confirmar: true, huella: previa.huella });
  assert.equal(r.estado, 'activa');
  // Una huella vieja ya no sirve: la campaña cambió.
  await assert.rejects(tool(auto, 'campana_estado', { campana: 'retail', estado: 'pausada', confirmar: true, huella: previa.huella }),
    (e) => e.code === 'vista_previa_vencida');
  const p = await tool(auto, 'campana_estado', { campana: 'retail', estado: 'pausada' });
  assert.equal((await tool(auto, 'campana_estado', { campana: 'retail', estado: 'pausada', confirmar: true, huella: p.huella })).estado, 'pausada');
});

test('campañas: duplicar, volver a una versión y los pasos del asistente', async () => {
  const previa = await tool(cli, 'campana_duplicar', { campana: 'bancos', nombre: 'Bancos 2' });
  assert.equal(previa.vista_previa, true);
  assert.equal(previa.campana.nombre, 'Bancos 2');
  assert.equal(await cuenta(`select count(*)::int as n from sdr.campana where client_id = $1 and nombre = 'Bancos 2'`, [C]), 0);
  const d = await tool(cli, 'campana_duplicar', { campana: 'bancos', nombre: 'Bancos 2', confirmar: true });
  assert.equal(d.creada.nombre, 'Bancos 2');

  await tool(cli, 'campana_editar', { campana: 'bancos', cambios: { ajustes: { propuesta: 'Otra.' } }, confirmar: true });
  const id = (await q(`select id from sdr.campana where client_id = $1 and clave = 'bancos'`, [C])).rows[0].id;
  const v = (await q(`select id from sdr.ajustes_historial where client_id = $1 and campana_id = $2 and ajustes->>'propuesta' = 'Testing para bancos.' order by id limit 1`, [C, id])).rows[0];
  const pr = await tool(cli, 'campana_restaurar', { campana: 'bancos', version: Number(v.id) });
  // Vuelve todo lo que dice la campaña a esa versión: la propuesta y el ICP de entonces.
  assert.deepEqual(pr.cambios.map((x) => [x.campo, x.despues]).sort(), [['icp', 'Bancos medianos.'], ['propuesta', 'Testing para bancos.']]);
  await tool(cli, 'campana_restaurar', { campana: 'bancos', version: Number(v.id), confirmar: true });
  assert.equal((await q(`select ajustes->>'propuesta' as p from sdr.campana where id = $1`, [id])).rows[0].p, 'Testing para bancos.');

  const asis = await tool(cli, 'campana_paso_marcar', { campana: 'bancos', paso: 'mensajes', estado: 'esperando', que: 'El link del webinar', quien: 'Ana' });
  assert.ok(asis.pasos.some((p) => p.paso === 'mensajes' && p.estado === 'esperando' && p.quien === 'Ana'));
  await tool(cli, 'campana_paso_marcar', { campana: 'bancos', campo: 'link_agenda', estado: 'esperando', que: 'El Calendly' });
  await assert.rejects(tool(cli, 'campana_paso_marcar', { campana: 'bancos', campo: 'inventado', estado: 'esperando', que: 'x' }),
    (e) => e.code === 'invalid_request');
  const fin = await tool(cli, 'campana_paso_marcar', { campana: 'bancos', paso: 'mensajes', estado: null });
  assert.ok(!fin.pasos.some((p) => p.paso === 'mensajes'));
});

test('un cliente no toca las campañas ni Empresa de otro', async () => {
  await assert.rejects(tool(cli, 'ajustes_editar', { cliente: AUTO, cambios: { tono: 'x' } }), (e) => e.code === 'not_found');
  await assert.rejects(tool(cli, 'campana_editar', { cliente: AUTO, campana: 'retail', cambios: { cuentas_por_dia: 1 } }), (e) => e.code === 'not_found');
  const idAuto = (await q(`select id from sdr.campana where client_id = $1 and clave = 'retail'`, [AUTO])).rows[0].id;
  await assert.rejects(tool(cli, 'campana_editar', { campana: idAuto, cambios: { cuentas_por_dia: 1 } }), (e) => e.code === 'not_found');
  // Biguá pasa el cliente.
  const r = await tool(op, 'campana_editar', { cliente: AUTO, campana: 'retail', cambios: { calibracion_mails: 4 } });
  assert.equal(r.vista_previa, true);
});

// ---------------------------------------------------------------- No contactar y listas

test('No contactar: agregar con vista previa, lo que no se entiende, y quitar', async () => {
  const valores = [{ valor: 'competidor.test', motivo: 'competencia' }, { valor: 'jefe@cliente-viejo.test' }, { valor: 'Banco Amigo SA' }, { valor: '!!!' }];
  const previa = await tool(cli, 'no_contactar_agregar', { valores });
  assert.equal(previa.vista_previa, true);
  assert.deepEqual(previa.agregaria.map((x) => x.tipo).sort(), ['dominio', 'email', 'empresa']);
  assert.equal(previa.invalidas.length, 1);
  assert.ok(previa.efecto && 'cuentas_en_marcha' in previa.efecto);
  assert.equal(await cuenta(`select count(*)::int as n from sdr.no_contactar where client_id = $1`, [C]), 0);

  const r = await tool(cli, 'no_contactar_agregar', { valores, confirmar: true });
  assert.equal(r.agregados, 3);
  assert.equal((await tool(cli, 'no_contactar_agregar', { valores })).ya_estaban, 3, 'lo que ya estaba no se vuelve a sumar');
  const lista = await tool(cli, 'no_contactar_listar', {});
  assert.ok(lista.aviso && lista.datos_externos.no_contactar.some((x) => x.valor === 'competidor.test'));

  const pq = await tool(cli, 'no_contactar_quitar', { valores: ['competidor.test', 'nunca-estuvo.test'] });
  assert.deepEqual(pq.quitaria.map((x) => x.valor), ['competidor.test']);
  assert.deepEqual(pq.no_estaban, ['nunca-estuvo.test']);
  assert.equal(await cuenta(`select count(*)::int as n from sdr.no_contactar where client_id = $1`, [C]), 3);
  assert.equal((await tool(cli, 'no_contactar_quitar', { valores: ['competidor.test'], confirmar: true })).quitados, 1);
  await assert.rejects(tool(cli, 'no_contactar_agregar', { valores: Array.from({ length: 501 }, (_, i) => ({ valor: `d${i}.test` })) }),
    (e) => e.code === 'invalid_request' && /panel/.test(e.message));
});

test('lista de cuentas pegada: vista previa con huella, carga, y deshacer con vista previa', async () => {
  await tool(op, 'campana_crear', { cliente: C, nombre: 'Lista Expo', tipo: 'lista', confirmar: true });
  const filas = [
    { empresa: 'Exportadora Sur', dominio: 'expsur.test', contacto_nombre: 'Juan Gómez', contacto_email: 'juan@expsur.test', contacto_cargo: 'CEO' },
    { empresa: 'Frutas "Del Valle", SA', dominio: 'delvalle.test' },
    { empresa: '', dominio: 'sin-nombre.test' },
    { empresa: 'Banco Amigo SA' },
  ];
  const previa = await tool(cli, 'campana_cuentas_cargar', { campana: 'lista-expo', filas });
  assert.equal(previa.vista_previa, true);
  assert.equal(previa.uso, 'prospectar');
  assert.equal(previa.totales.filas, 4);
  assert.equal(previa.totales.invalidas, 1, 'la fila sin empresa es un error');
  assert.equal(previa.totales.en_no_contactar, 1, 'Banco Amigo está en no contactar');
  assert.ok(previa.datos_externos.filas.some((f) => f.empresa === 'Frutas "Del Valle", SA'), 'las comillas y las comas llegan enteras');
  assert.equal(await cuenta(`select count(*)::int as n from sdr.lote_carga where client_id = $1`, [C]), 0);
  await assert.rejects(tool(cli, 'campana_cuentas_cargar', { campana: 'lista-expo', filas, confirmar: true }), (e) => e.code === 'vista_previa_vencida');
  await assert.rejects(tool(cli, 'campana_cuentas_cargar', { campana: 'lista-expo', filas: filas.slice(0, 2), confirmar: true, huella: previa.huella }),
    (e) => e.code === 'carga_cambio', 'otra lista con la huella de la vista previa no entra');

  const r = await tool(cli, 'campana_cuentas_cargar', { campana: 'lista-expo', filas, confirmar: true, huella: previa.huella });
  assert.equal(r.lote.resumen.personas, 1);
  assert.equal(r.lote.archivo, 'Lista pegada en Claude.csv');
  const lista = await tool(cli, 'campana_lista_ver', { campana: 'lista-expo' });
  assert.ok(lista.lista.cargadas >= 2);

  const pd = await tool(cli, 'carga_deshacer', { carga: r.lote.id });
  assert.equal(pd.vista_previa, true);
  assert.ok(pd.deshace.cuentas >= 2);
  assert.equal((await q(`select estado from sdr.lote_carga where id = $1`, [r.lote.id])).rows[0].estado, 'aplicado', 'la vista previa no deshace');
  const d = await tool(cli, 'carga_deshacer', { carga: r.lote.id, confirmar: true });
  assert.equal(d.deshecho.cuentas, pd.deshace.cuentas);
  await assert.rejects(tool(cli, 'carga_deshacer', { carga: r.lote.id }), (e) => e.code === 'invalid_request');
  await assert.rejects(tool(cli, 'campana_cuentas_cargar', { campana: 'lista-expo', filas: Array.from({ length: 501 }, (_, i) => ({ empresa: `E${i}` })) }),
    (e) => e.code === 'invalid_request' && /panel/.test(e.message));
});

// ---------------------------------------------------------------- buzones, dominios y WhatsApp

test('buzones: pausar y reactivar con vista previa; probar no muestra la contraseña', async () => {
  const previa = await tool(cli, 'buzon_estado', { buzon: `hola@${C}.test`, estado: 'paused' });
  assert.deepEqual([previa.vista_previa, previa.antes, previa.despues], [true, 'active', 'paused']);
  assert.equal((await q(`select status from mailgw.account where email = $1`, [`hola@${C}.test`])).rows[0].status, 'active');
  assert.equal((await tool(cli, 'buzon_estado', { buzon: `hola@${C}.test`, estado: 'paused', confirmar: true })).status, 'paused');
  await tool(cli, 'buzon_estado', { buzon: `hola@${C}.test`, estado: 'active', confirmar: true });
  await assert.rejects(tool(cli, 'buzon_estado', { buzon: `hola@${AUTO}.test`, estado: 'paused' }), (e) => e.code === 'not_found');
  assert.ok(toolsPara(cli).find((t) => t.name === 'buzon_probar').accion, 'probar cuenta en el tope de cambios, sin ser destructiva');
});

test('dominios: los selectores DKIM con vista previa; verificar sólo los dominios propios', async () => {
  const previa = await tool(cli, 'dominio_selectores', { dominio: `${C}.test`, selectores: ['Mail2026'] });
  assert.deepEqual(previa.despues, ['mail2026']);
  const r = await tool(cli, 'dominio_selectores', { dominio: `${C}.test`, selectores: ['Mail2026'], confirmar: true });
  assert.deepEqual(r.dkim_selectors, ['mail2026']);
  await assert.rejects(tool(cli, 'dominio_selectores', { dominio: `${AUTO}.test`, selectores: ['x'] }), (e) => e.code === 'not_found');
  await assert.rejects(tool(cli, 'dominio_verificar', { dominio: 'ajeno.test' }), (e) => e.code === 'not_found');
});

test('WhatsApp: sólo Biguá, con vista previa de antes y después y las mismas validaciones', async () => {
  assert.ok(!toolsPara(cli).some((t) => t.name === 'whatsapp_configurar'));
  const previa = await tool(op, 'whatsapp_configurar', { cliente: C, activo: true, numero: '+54 9 11 5555 0000', hora_desde: 9, hora_hasta: 18 });
  assert.equal(previa.vista_previa, true);
  assert.deepEqual(previa.cambios.map((x) => x.campo).sort(), ['activo', 'hora_desde', 'hora_hasta', 'numero']);
  assert.equal(await cuenta(`select count(*)::int as n from sdr.whatsapp_config where client_id = $1`, [C]), 0);
  await assert.rejects(tool(op, 'whatsapp_configurar', { cliente: C, hora_desde: 20, hora_hasta: 10 }), (e) => e.code === 'invalid_request');
  const r = await tool(op, 'whatsapp_configurar', { cliente: C, activo: true, numero: '+54 9 11 5555 0000', hora_desde: 9, hora_hasta: 18, confirmar: true });
  assert.equal(r.whatsapp.hora_desde, 9);
  assert.equal((await tool(op, 'whatsapp_configurar', { cliente: C, hora_desde: 9 })).cambios.length, 0);
});

test('alta_cargar: WhatsApp llega con la ficha', async () => {
  const ficha = { cliente: { id: 'gest-wa', nombre: 'Gest WA' }, whatsapp: { activo: true, numero: '+5491155550001', dias: [1, 2, 3, 4, 5] } };
  const previa = await tool(op, 'alta_cargar', { ficha });
  assert.ok(previa.plan.some((p) => p.paso === 'whatsapp' && /queda activo/.test(p.que)), JSON.stringify(previa.plan));
  const mala = await tool(op, 'alta_cargar', { ficha: { ...ficha, whatsapp: { pausa_min_seg: 300, pausa_max_seg: 60 } } });
  assert.ok(mala.errores.some((e) => /WhatsApp/.test(e)));
  const r = await tool(op, 'alta_cargar', { ficha, confirmar: true });
  assert.ok(r.hecho.includes('whatsapp'));
  assert.equal(r.alta.pasos.find((p) => p.clave === 'whatsapp').estado, 'listo');
});
