// Carga por archivo (docs/26, etapa 1): lectura de CSV y Excel, mapeo de columnas y lo que se hace
// con cada fila. Sin base: lo que toca la base está en admin.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as carga from '../src/sdr/carga.mjs';
import { xlsx, zip } from './xlsx.mjs';

const b64 = (buf) => Buffer.from(buf).toString('base64');

test('CSV: separador, comillas, saltos dentro de una celda y Latin-1', () => {
  const t = 'Empresa;Web;Motivo\n"Agrosuper; S.A.";agrosuper.cl;"dijo ""no"""\nCopefruit;;"cliente\nhace años"\n';
  const r = carga.leerArchivo({ nombre: 'base.csv', contenido_base64: b64(t) });
  assert.deepEqual(r.filas, [['Empresa', 'Web', 'Motivo'], ['Agrosuper; S.A.', 'agrosuper.cl', 'dijo "no"'], ['Copefruit', '', 'cliente\nhace años']]);
  const latin = Buffer.from('empresa,motivo\nViña Concha y Toro,referido de Pía\n', 'latin1');
  assert.equal(carga.leerArchivo({ nombre: 'x.csv', contenido_base64: b64(latin) }).filas[1][0], 'Viña Concha y Toro');
});

test('Excel: cadenas compartidas, números, celdas vacías, fórmulas por su valor y varias hojas', () => {
  const buf = xlsx({
    Exportadoras: [['Razón social', 'Sitio web', 'Empleados', 'Uso'], ['Frutícola & Cía', 'https://www.fruticola.cl/', 1200, 'semilla'],
      ['Sin web', '', '', 'referido'], [{ f: 'CONCAT("Hola","Mundo")', v: 'HolaMundo' }, '', 5]],
    Otra: [['x'], ['y']],
  });
  const r = carga.leerArchivo({ nombre: 'base.xlsx', contenido_base64: b64(buf) });
  assert.deepEqual(r.hojas, ['Exportadoras', 'Otra']);
  assert.equal(r.hoja, 'Exportadoras');
  assert.deepEqual(r.filas[1], ['Frutícola & Cía', 'https://www.fruticola.cl/', '1200', 'semilla']);
  assert.deepEqual(r.filas[2], ['Sin web', '', '', 'referido']);
  assert.deepEqual(r.filas[3], ['HolaMundo', '', '5'], 'la fórmula vale por su valor guardado');
  assert.deepEqual(carga.leerArchivo({ nombre: 'base.xlsx', contenido_base64: b64(buf) }, { hoja: 'Otra' }).filas, [['x'], ['y']]);
  assert.throws(() => carga.leerArchivo({ nombre: 'base.xlsx', contenido_base64: b64(buf) }, { hoja: 'Nada' }), /no tiene una hoja/);
});

test('Excel: un zip que se infla de más, uno dañado, un .xls viejo y el tope de tamaño', () => {
  const bomba = zip({ 'xl/workbook.xml': '<workbook><sheets><sheet name="a" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': Buffer.alloc(41 * 1024 * 1024, 0x20) });
  assert.ok(bomba.length < carga.MAX_BYTES);
  assert.throws(() => carga.leerArchivo({ nombre: 'b.xlsx', contenido_base64: b64(bomba) }), /dañado o es demasiado grande/);
  const roto = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100)]);
  assert.throws(() => carga.leerArchivo({ nombre: 'r.xlsx', contenido_base64: b64(roto) }), /no es un Excel válido/);
  assert.throws(() => carga.leerArchivo({ nombre: 'viejo.xls', contenido_base64: b64(Buffer.from([0xd0, 0xcf, 0x11, 0xe0])) }), /\.xls/);
  assert.throws(() => carga.leerArchivo({ nombre: 'g.csv', contenido_base64: b64(Buffer.alloc(carga.MAX_BYTES + 1, 0x61)) }), /tope es 600 KB/);
});

test('columnas: el mapeo sale de los encabezados y lo que manda el usuario gana', () => {
  const enc = ['Razón Social', 'Página web', 'Correo electrónico', 'Observaciones', 'Uso', 'RUT'];
  assert.deepEqual(carga.proponerMapeo(enc), {
    empresa: 'Razón Social', dominio: 'Página web', uso: 'Uso', motivo: 'Observaciones', rut: 'RUT', contacto_email: 'Correo electrónico' });
  assert.deepEqual(carga.proponerMapeo(enc, { motivo: null, nota: 'Observaciones' }).nota, 'Observaciones');
  assert.equal(carga.proponerMapeo(enc, { motivo: null }).motivo, undefined);
  assert.throws(() => carga.proponerMapeo(enc, { empresa: 'No existe' }), /no tiene la columna/);
});

test('filas: uso por columna o por defecto, motivo del uso, errores y fórmulas que no se guardan como tales', () => {
  const filas = [['Empresa', 'Web', 'Uso', 'Motivo', 'Mail', 'Rubro'],
    ['Agrosuper', 'agrosuper.cl', 'referido', '', 'juan@gmail.com', 'agro'],
    ['Ortiz', '', '', '=HYPERLINK("x")', '', ''],
    ['Rara', 'no es un sitio', '', '', '', ''],
    ['Otra', '', 'quizás', '', '', ''],
    ['', '', '', '', '', ''],
    ['Modelo SpA', 'modelo.cl', 'semilla', '', '', 'alimentos']];
  const mapeo = carga.proponerMapeo(filas[0], { contacto_email: 'Mail' });
  const r = carga.interpretar(filas, mapeo, 'no_contactar');
  assert.equal(r.length, 5, 'la fila vacía no cuenta');
  assert.deepEqual([r[0].uso, r[0].motivo, r[0].dominio, r[0].email], ['no_contactar', 'referido', 'agrosuper.cl', 'juan@gmail.com']);
  assert.equal(r[1].motivo, `'=HYPERLINK("x")`);
  assert.match(r[2].error, /no es un sitio web/);
  assert.match(r[3].error, /no se entiende/);
  assert.equal(r[4].uso, 'semilla');
  assert.equal(r[4].vertical, 'alimentos');
});
