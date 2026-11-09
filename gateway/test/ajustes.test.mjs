// Los ajustes partidos en Empresa y campaña (docs/21 §6.2): qué vive dónde, la herencia, los
// permisos por modo (decisión 13), el volumen contra el tope (decisión 12) y lo que hace falta
// para activar una campaña. Sin base: es el módulo solo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAMPOS, CAMPOS_EMPRESA, CAMPOS_CAMPANA, HEREDABLES, aplicarCambiosEmpresa, aplicarCambiosCampana,
  aplicarColumnasCampana, faltantesParaActivar, ajustesEfectivos,
} from '../src/sdr/ajustes.mjs';

const BIGUA = { esBigua: true };
const OPERADO = { esBigua: false, autogestion: false };
const AUTO = { esBigua: false, autogestion: true };
const claves = (campos) => campos.map((c) => c.clave);

test('ajustes: cada campo vive en su nivel', () => {
  assert.deepEqual(claves(CAMPOS_EMPRESA), ['nombre_comercial', 'descripcion', 'tono', 'idioma', 'firma', 'excluir',
    'prueba_social', 'objeciones', 'responsable_positivos', 'link_agenda', 'acepta_mails_extrapolados']);
  assert.deepEqual(claves(CAMPOS_CAMPANA), ['propuesta', 'prueba_social', 'icp', 'roles_objetivo', 'excluir', 'senal_avisos',
    'dias_aviso', 'llamado_accion', 'links_permitidos', 'tono', 'idioma', 'positivos', 'objeciones',
    'responsable_positivos', 'link_agenda', 'acepta_mails_extrapolados']);
  // La firma es del buzón y de Empresa, nunca de la campaña (decisión 11); el texto libre de
  // buzones y la oferta no siguen.
  for (const k of ['firma', 'buzones', 'oferta', 'cuentas_por_dia']) assert.ok(!claves(CAMPOS_CAMPANA).includes(k), k);
  for (const k of ['oferta', 'buzones', 'icp', 'cuentas_por_dia']) assert.ok(!claves(CAMPOS_EMPRESA).includes(k), k);
  // Lo que se hereda está en los dos niveles.
  for (const k of HEREDABLES) {
    assert.ok(claves(CAMPOS_EMPRESA).includes(k) && claves(CAMPOS_CAMPANA).includes(k), k);
    assert.equal(CAMPOS_CAMPANA.find((c) => c.clave === k).hereda, true);
  }
  // El formulario de hoy sigue igual mientras dure la transición.
  assert.equal(CAMPOS.length, 19);
  assert.ok(claves(CAMPOS).includes('oferta') && claves(CAMPOS).includes('buzones'));
});

test('ajustes: Empresa valida como el formulario de hoy y no acepta campos de campaña', () => {
  const e = aplicarCambiosEmpresa({}, { nombre_comercial: ' Acme ', descripcion: 'QA', excluir: 'consultoras\n\nestudios' }, OPERADO);
  assert.deepEqual(e, { nombre_comercial: 'Acme', descripcion: 'QA', excluir: ['consultoras', 'estudios'] });
  assert.throws(() => aplicarCambiosEmpresa(e, { icp: 'x' }, BIGUA), /No existe el campo «icp»/);
  assert.throws(() => aplicarCambiosEmpresa(e, { acepta_mails_extrapolados: true }, OPERADO), /lo cambia Biguá/);
  assert.equal(aplicarCambiosEmpresa(e, { acepta_mails_extrapolados: true }, AUTO).acepta_mails_extrapolados, true);
  assert.equal(aplicarCambiosEmpresa(e, { descripcion: '' }, OPERADO).descripcion, undefined);
});

test('ajustes: campaña, links permitidos y casos elegidos de la biblioteca de Empresa', () => {
  const empresa = { prueba_social: ['Banca: 5 días a 6 horas (caso publicado)', 'Retail: 40 % menos de regresión'] };
  const c = aplicarCambiosCampana({}, {
    propuesta: 'Webinar de automatización', links_permitidos: 'https://acme.test/webinar\nhttps://acme.test/webinar',
    prueba_social: ['Retail: 40 % menos de regresión'],
  }, OPERADO, { empresa });
  assert.deepEqual(c.links_permitidos, ['https://acme.test/webinar']);
  assert.deepEqual(c.prueba_social, ['Retail: 40 % menos de regresión']);
  assert.throws(() => aplicarCambiosCampana(c, { prueba_social: ['Un caso inventado'] }, OPERADO, { empresa }), /no está en/);
  assert.throws(() => aplicarCambiosCampana(c, { links_permitidos: 'http://acme.test' }, OPERADO), /https:\/\//);
  assert.throws(() => aplicarCambiosCampana(c, { links_permitidos: ['https://a.test', 'https://b.test', 'https://c.test', 'https://d.test'] },
    OPERADO), /máximo es 3/);
  assert.throws(() => aplicarCambiosCampana(c, { firma: 'x' }, BIGUA), /No existe el campo «firma»/);
});

test('ajustes: permisos de la campaña según el modo (decisión 13)', () => {
  // En los dos modos, el contenido.
  for (const p of [OPERADO, AUTO]) {
    const c = aplicarCambiosCampana({}, { icp: 'Software', llamado_accion: 'Una charla', tono: 'cercano' }, p);
    assert.equal(c.icp, 'Software');
  }
  // En autogestionado, además, el ritmo.
  assert.throws(() => aplicarCambiosCampana({}, { dias_aviso: 10 }, OPERADO), /lo cambia Biguá/);
  assert.equal(aplicarCambiosCampana({}, { dias_aviso: 10 }, AUTO).dias_aviso, 10);
  // Siempre Biguá: la señal.
  assert.throws(() => aplicarCambiosCampana({}, { senal_avisos: 'texto: qa' }, AUTO), /lo cambia Biguá/);
  assert.equal(aplicarCambiosCampana({}, { senal_avisos: 'texto: qa' }, BIGUA).senal_avisos, 'texto: qa');
  // Mandar sin cambios lo que no puede tocar no es un error (el panel manda el formulario entero).
  assert.deepEqual(aplicarCambiosCampana({ senal_avisos: 'texto: qa' }, { senal_avisos: 'texto: qa' }, OPERADO), { senal_avisos: 'texto: qa' });

  const fila = { nombre: 'Principal', tipo: 'prospeccion', estado: 'activa', cuentas_por_dia: 5, calibracion_mails: 20 };
  assert.deepEqual(aplicarColumnasCampana(fila, { nombre: 'Principal AR' }, OPERADO), { nombre: 'Principal AR' });
  assert.throws(() => aplicarColumnasCampana(fila, { estado: 'pausada' }, OPERADO), /lo cambia Biguá/);
  assert.deepEqual(aplicarColumnasCampana(fila, { estado: 'pausada' }, AUTO), { estado: 'pausada' });
  assert.throws(() => aplicarColumnasCampana(fila, { calibracion_mails: 0 }, AUTO), /lo cambia Biguá/);
  assert.throws(() => aplicarColumnasCampana(fila, { dripify_campana_id: 9 }, AUTO), /lo cambia Biguá/);
  assert.deepEqual(aplicarColumnasCampana(fila, { calibracion_mails: 0, dripify_campana_id: 9 }, BIGUA), { calibracion_mails: 0, dripify_campana_id: 9 });
});

test('ajustes: estados de la campaña', () => {
  assert.throws(() => aplicarColumnasCampana(null, { tipo: 'evento' }, BIGUA), /necesita un nombre/);
  assert.deepEqual(aplicarColumnasCampana(null, { nombre: 'Webinar', tipo: 'evento' }, BIGUA), { nombre: 'Webinar', tipo: 'evento' });
  assert.throws(() => aplicarColumnasCampana(null, { nombre: 'X', estado: 'activa' }, BIGUA), /arranca en borrador/);

  const activa = { nombre: 'X', tipo: 'evento', estado: 'activa', cuentas_por_dia: 3 };
  assert.throws(() => aplicarColumnasCampana(activa, { tipo: 'prospeccion' }, BIGUA), /no cambia una vez activada/);
  assert.throws(() => aplicarColumnasCampana(activa, { estado: 'borrador' }, BIGUA), /no vuelve a borrador/);
  assert.deepEqual(aplicarColumnasCampana(activa, { estado: 'terminada' }, BIGUA), { estado: 'terminada' });

  const terminada = { ...activa, estado: 'terminada' };
  assert.throws(() => aplicarColumnasCampana(terminada, { estado: 'activa' }, BIGUA), /no se reactiva/);
  assert.throws(() => aplicarColumnasCampana(terminada, { nombre: 'Y' }, BIGUA), /no se edita/);

  // Fechas: el formato, el orden, y la que llega de la base como Date.
  assert.throws(() => aplicarColumnasCampana(activa, { inicio: '2026-02-30' }, BIGUA), /AAAA-MM-DD/);
  assert.throws(() => aplicarColumnasCampana(activa, { inicio: '2026-11-20', fin: '2026-11-10' }, BIGUA), /después del inicio/);
  const conFechas = { ...activa, inicio: new Date(2026, 10, 10), fin: new Date(2026, 10, 28) };
  assert.deepEqual(aplicarColumnasCampana(conFechas, { inicio: '2026-11-10', fin: '2026-11-28' }, BIGUA), {});
  assert.throws(() => aplicarColumnasCampana(conFechas, { fin: '2026-11-01' }, BIGUA), /después del inicio/);
});

test('ajustes: el volumen de las activas no pasa el tope del cliente (decisión 12)', () => {
  const borrador = { nombre: 'B', tipo: 'prospeccion', estado: 'borrador', cuentas_por_dia: 8 };
  // Sola, sin tope: se activa.
  assert.deepEqual(aplicarColumnasCampana(borrador, { estado: 'activa' }, BIGUA), { estado: 'activa' });
  // Con otra activa, sin tope cargado: no.
  assert.throws(() => aplicarColumnasCampana(borrador, { estado: 'activa' }, BIGUA, { otrasActivas: 5 }), /tope de cuentas por día/);
  // Con tope: hasta el tope.
  assert.deepEqual(aplicarColumnasCampana(borrador, { estado: 'activa' }, BIGUA, { tope: 13, otrasActivas: 5 }), { estado: 'activa' });
  assert.throws(() => aplicarColumnasCampana(borrador, { estado: 'activa' }, BIGUA, { tope: 12, otrasActivas: 5 }), /sumarían 13/);
  const activa = { ...borrador, estado: 'activa' };
  assert.throws(() => aplicarColumnasCampana(activa, { cuentas_por_dia: 9 }, AUTO, { tope: 13, otrasActivas: 5 }), /sumarían 14/);
  // Vaciar el volumen no deja la campaña sin valor (la columna no admite vacío).
  assert.throws(() => aplicarColumnasCampana(activa, { cuentas_por_dia: '' }, BIGUA), /no puede quedar vacío/);
  // Un borrador puede tener cualquier volumen: se controla al activarlo.
  assert.deepEqual(aplicarColumnasCampana(borrador, { cuentas_por_dia: 50 }, AUTO, { tope: 13, otrasActivas: 5 }), { cuentas_por_dia: 50 });
});

test('ajustes: lo que falta para activar una campaña', () => {
  const empresa = { nombre_comercial: 'Acme' };
  const vacia = { tipo: 'prospeccion', ajustes: {}, buzones: [], cuentas_por_dia: 0 };
  assert.deepEqual(faltantesParaActivar(vacia, empresa).map((f) => f.clave), ['propuesta', 'icp', 'roles_objetivo', 'buzones', 'cuentas_por_dia']);

  const lista = { tipo: 'prospeccion', ajustes: { propuesta: 'QA', icp: 'Software', roles_objetivo: ['CTO'] },
    buzones: ['00000000-0000-0000-0000-000000000001'], cuentas_por_dia: 5 };
  assert.deepEqual(faltantesParaActivar(lista, empresa), []);
  assert.deepEqual(faltantesParaActivar(lista, {}).map((f) => f.clave), ['nombre_comercial']);

  const evento = { ...lista, tipo: 'evento' };
  assert.deepEqual(faltantesParaActivar(evento, empresa).map((f) => f.clave), ['fin', 'links_permitidos']);
  // La reactivación no necesita audiencia: trabaja sobre prospectos propios.
  const reac = { ...lista, tipo: 'reactivacion', ajustes: { propuesta: 'Retomar' } };
  assert.deepEqual(faltantesParaActivar(reac, empresa), []);
});

test('ajustes: lo que leen los bots, Empresa con la campaña encima', () => {
  const empresa = {
    nombre_comercial: 'Acme', descripcion: 'QA', firma: 'Equipo Acme', tono: 'formal', idioma: 'español',
    excluir: ['consultoras'], objeciones: ['Caro: vale la pena'], prueba_social: ['Caso A', 'Caso B'],
    link_agenda: 'https://acme.test/agenda', acepta_mails_extrapolados: false,
  };
  const campana = {
    propuesta: 'Webinar', tono: 'cercano', excluir: ['consultoras', 'estudios'], prueba_social: ['Caso B'],
    acepta_mails_extrapolados: true, links_permitidos: ['https://acme.test/webinar'],
  };
  const { valores, origen } = ajustesEfectivos(empresa, campana, 'evento');
  assert.equal(valores.tono, 'cercano');
  assert.equal(origen.tono, 'campana');
  assert.equal(valores.idioma, 'español');
  assert.equal(origen.idioma, 'empresa');
  assert.equal(valores.acepta_mails_extrapolados, true);
  assert.deepEqual(valores.excluir, ['consultoras', 'estudios']);
  assert.equal(origen.excluir, 'ambas');
  assert.deepEqual(valores.objeciones, ['Caro: vale la pena']);
  assert.equal(origen.objeciones, 'empresa');
  assert.deepEqual(valores.prueba_social, ['Caso B']);
  assert.equal(valores.firma, 'Equipo Acme');
  assert.equal(valores.llamado_accion, 'Inscribirse con el link.');
  assert.equal(origen.llamado_accion, 'tipo');
  assert.equal(Object.keys(valores)[0], 'nombre_comercial');

  // Sin casos elegidos, la campaña cita todos.
  assert.deepEqual(ajustesEfectivos(empresa, {}).valores.prueba_social, ['Caso A', 'Caso B']);
  // Un caso que se borró de Empresa deja de citarse, aunque la campaña lo tenga elegido.
  assert.equal(ajustesEfectivos({ prueba_social: ['Caso A'] }, { prueba_social: ['Caso B'] }).valores.prueba_social, undefined);
});
