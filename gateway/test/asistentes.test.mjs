// Que los asistentes (docs/29) no se queden atrás cuando cambia la configuración: todo campo de
// Empresa está en un paso del alta, y toda sección de la campaña y todo lo que puede faltar para
// activarla está en un paso del asistente de campaña. Y que el MCP del panel no se quede atrás del
// asistente: cada paso del alta dice cómo llega desde Claude (ALTA_DESDE_CLAUDE) y la ficha de
// alta_cargar tiene todos los campos de Empresa y de la campaña (docs/24 §4.4). Si esto falla, sumá el campo o la sección al
// paso que corresponda (PASOS_ALTA en src/admin/servicio.mjs, PASOS_CAMPANA en el panel) y a su
// guía, o anotá acá por qué no va (CLAUDE.md, «Formulario de configuración y alta»).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CAMPOS_EMPRESA, BLOQUES_CAMPANA, CAMPOS_CAMPANA, COLUMNAS_CAMPANA } from '../src/sdr/ajustes.mjs';
import { PASOS_ALTA, ALTA_DESDE_CLAUDE, CAMPANA_FUERA_DE_LA_FICHA, esquemaFichaAlta } from '../src/admin/servicio.mjs';
import { toolsPara } from '../src/panel/mcp.mjs';

const app = readFileSync(new URL('../src/admin/static/app.js', import.meta.url), 'utf8');
const ajustes = readFileSync(new URL('../src/sdr/ajustes.mjs', import.meta.url), 'utf8');

// Lo que a propósito no está en el alta, con su motivo.
const FUERA_DEL_ALTA = {};

test('asistente de alta: cada campo de Empresa está en un paso', () => {
  const enPasos = new Set(PASOS_ALTA.flatMap((p) => p.campos ?? []));
  const faltan = CAMPOS_EMPRESA.map((c) => c.clave).filter((k) => !enPasos.has(k) && !FUERA_DEL_ALTA[k]);
  assert.deepEqual(faltan, [], `Campos de Empresa que no están en ningún paso del alta: ${faltan.join(', ')}`);
  const sobran = [...enPasos].filter((k) => !CAMPOS_EMPRESA.some((c) => c.clave === k));
  assert.deepEqual(sobran, [], `Pasos del alta con campos que ya no son de Empresa: ${sobran.join(', ')}`);
  for (const p of PASOS_ALTA) {
    assert.ok(new RegExp(`\\b${p.clave}: '`).test(app.slice(app.indexOf('const GUIA_ALTA'))), `el paso «${p.clave}» no tiene guía en GUIA_ALTA`);
  }
});

test('asistente de campaña: cada sección y cada faltante para activar está en un paso', () => {
  const bloque = app.slice(app.indexOf('const PASOS_CAMPANA'), app.indexOf('function navCampana'));
  const cubiertos = new Set([...bloque.matchAll(/bloques: \[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1])));
  const secciones = BLOQUES_CAMPANA.map((b) => b.clave).filter((k) => !cubiertos.has(k));
  assert.deepEqual(secciones, [], `Secciones de la campaña sin paso en el asistente: ${secciones.join(', ')}`);
  // 'empresa': lo que falta en Empresa se arregla en el alta, no en la campaña.
  const faltantes = [...new Set([...ajustes.matchAll(/falta\('([a-z_]+)'/g)].map((m) => m[1]))].filter((k) => k !== 'empresa' && !cubiertos.has(k));
  assert.deepEqual(faltantes, [], `Faltantes para activar sin paso en el asistente: ${faltantes.join(', ')}`);
});

// ---------------------------------------------------------------- el asistente y el MCP del panel

test('MCP: cada paso del alta dice cómo llega desde Claude', () => {
  const claves = PASOS_ALTA.map((p) => p.clave);
  const sinDecir = claves.filter((k) => !ALTA_DESDE_CLAUDE[k]);
  assert.deepEqual(sinDecir, [], `Pasos del alta sin decidir cómo llegan desde Claude (ALTA_DESDE_CLAUDE en src/admin/servicio.mjs): ${sinDecir.join(', ')}`);
  const sobran = Object.keys(ALTA_DESDE_CLAUDE).filter((k) => !claves.includes(k));
  assert.deepEqual(sobran, [], `ALTA_DESDE_CLAUDE nombra pasos que ya no están en el alta: ${sobran.join(', ')}`);
  for (const p of PASOS_ALTA) {
    const x = ALTA_DESDE_CLAUDE[p.clave];
    assert.ok(['datos', 'marcar', 'fuera'].includes(x.como), `«${p.clave}»: como es datos, marcar o fuera`);
    if (x.como === 'fuera') assert.ok(x.motivo?.length > 10, `«${p.clave}» no pasa por el chat: falta el motivo y dónde se hace`);
    if (x.como === 'marcar') assert.ok(p.manual, `«${p.clave}» se marca a mano desde Claude, pero en el alta no es un paso manual`);
  }
});

test('MCP: la ficha de alta_cargar tiene todos los campos de Empresa y de la campaña', () => {
  const ficha = esquemaFichaAlta().properties;
  const empresa = Object.keys(ficha.empresa.properties);
  const faltan = CAMPOS_EMPRESA.map((c) => c.clave).filter((k) => !empresa.includes(k));
  assert.deepEqual(faltan, [], `Campos de Empresa que no están en la ficha: ${faltan.join(', ')}`);
  const camposDePasos = PASOS_ALTA.filter((p) => ALTA_DESDE_CLAUDE[p.clave].como === 'datos').flatMap((p) => p.campos ?? []);
  assert.deepEqual(camposDePasos.filter((k) => !empresa.includes(k)), []);
  const cols = Object.keys(ficha.campana.properties);
  const colsFaltan = COLUMNAS_CAMPANA.map((c) => c.clave).filter((k) => !cols.includes(k) && !CAMPANA_FUERA_DE_LA_FICHA[k]);
  assert.deepEqual(colsFaltan, [], `Columnas de la campaña que no están en la ficha ni en CAMPANA_FUERA_DE_LA_FICHA: ${colsFaltan.join(', ')}`);
  const ajustes = Object.keys(ficha.campana.properties.ajustes.properties);
  const ajFaltan = CAMPOS_CAMPANA.map((c) => c.clave).filter((k) => !ajustes.includes(k));
  assert.deepEqual(ajFaltan, [], `Campos de la campaña que no están en la ficha: ${ajFaltan.join(', ')}`);
  const sinCampos = BLOQUES_CAMPANA.map((b) => b.clave).filter((b) => ![...COLUMNAS_CAMPANA, ...CAMPOS_CAMPANA]
    .some((c) => c.bloque === b && (cols.includes(c.clave) || ajustes.includes(c.clave))));
  assert.deepEqual(sinCampos, [], `Secciones de la campaña sin ningún campo en la ficha: ${sinCampos.join(', ')}`);
  assert.deepEqual(Object.keys(ficha.pasos.properties).sort(), PASOS_ALTA.map((p) => p.clave).sort(), 'la ficha marca cualquier paso del alta');
});

test('MCP: alta_cargar y alta_ver están para Biguá, no para un cliente, y la descripción nombra cada paso', () => {
  const bigua = toolsPara({ role: 'bigua_admin' });
  const cargar = bigua.find((t) => t.name === 'alta_cargar');
  assert.ok(cargar && bigua.some((t) => t.name === 'alta_ver'));
  for (const p of PASOS_ALTA) assert.ok(cargar.description.includes(p.titulo), `la descripción de alta_cargar no nombra «${p.titulo}»`);
  const cliente = toolsPara({ role: 'client_admin', client_id: 'x' }).map((t) => t.name);
  assert.ok(!cliente.includes('alta_cargar') && !cliente.includes('alta_ver'));
});
