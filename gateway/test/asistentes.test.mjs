// Que los asistentes (docs/29) no se queden atrás cuando cambia la configuración: todo campo de
// Empresa está en un paso del alta, y toda sección de la campaña y todo lo que puede faltar para
// activarla está en un paso del asistente de campaña. Si esto falla, sumá el campo o la sección al
// paso que corresponda (PASOS_ALTA en src/admin/servicio.mjs, PASOS_CAMPANA en el panel) y a su
// guía, o anotá acá por qué no va (CLAUDE.md, «Formulario de configuración y alta»).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CAMPOS_EMPRESA, BLOQUES_CAMPANA } from '../src/sdr/ajustes.mjs';
import { PASOS_ALTA } from '../src/admin/servicio.mjs';

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
