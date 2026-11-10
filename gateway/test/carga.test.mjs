// Carga de cuentas por archivo (docs/26, etapa 1): lectura de Excel y CSV, mapeo, la lista de no
// contactar de la empresa desde un archivo (con empresas por nombre y el freno de lo que ya está en
// marcha en Dripify) y las semillas de una campaña; y que un cliente no vea ni toque lo de otro.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import * as store from '../src/store.mjs';
import { startServer } from '../src/server.mjs';
import { createUser } from '../src/admin/auth.mjs';
import * as carga from '../src/sdr/carga.mjs';
import * as sdr from '../src/sdr/store.mjs';
import * as correo from '../src/sdr/correo.mjs';

let server, base;
const A = 'carga-a';
const B = 'carga-b';
const meta = { bot: 'prospector', tarea: 'diaria' };

function browser() {
  let cookie = null;
  return {
    async call(method, path, body) {
      const res = await fetch(`${base}/admin/api${path}`, {
        method,
        headers: { 'x-mailgw-admin': '1', ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, body: await res.json() };
    },
  };
}

async function loggedIn(email, role, clientId) {
  const { setupToken } = await createUser({ email, name: email, role, clientId });
  const b = browser();
  assert.equal((await b.call('POST', '/activate', { token: setupToken, password: 'clave-larga-de-prueba' })).status, 200);
  assert.equal((await b.call('POST', '/login', { email, password: 'clave-larga-de-prueba' })).status, 200);
  return b;
}

const ok = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.data; };
const q = (sql, params) => store.asOwner((c) => c.query(sql, params));
const u = {};

// ----- un .xlsx mínimo, como lo guarda Excel: un zip con el libro, las hojas y los textos compartidos.

function zip(archivos) {
  const locales = [];
  const centrales = [];
  let offset = 0;
  for (const [nombre, texto] of Object.entries(archivos)) {
    const datos = Buffer.from(texto, 'utf8');
    const comprimido = zlib.deflateRawSync(datos);
    const n = Buffer.from(nombre, 'utf8');
    const crc = zlib.crc32(datos);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comprimido.length, 18); local.writeUInt32LE(datos.length, 22);
    local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(comprimido.length, 20); central.writeUInt32LE(datos.length, 24);
    central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locales.push(local, n, comprimido);
    centrales.push(central, n);
    offset += 30 + n.length + comprimido.length;
  }
  const dir = Buffer.concat(centrales);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(centrales.length / 2, 8); fin.writeUInt16LE(centrales.length / 2, 10);
  fin.writeUInt32LE(dir.length, 12); fin.writeUInt32LE(offset, 16);
  return Buffer.concat([...locales, dir, fin]);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// hojas: { nombre: [[celda, ...], ...] }. Los textos van a sharedStrings; los números, como número;
// una celda { f, v } es una fórmula con su último valor calculado.
function xlsx(hojas) {
  const compartidos = [];
  const idx = (s) => { let i = compartidos.indexOf(s); if (i < 0) { i = compartidos.length; compartidos.push(s); } return i; };
  const archivos = {};
  const nombres = Object.keys(hojas);
  nombres.forEach((nombre, k) => {
    const filas = hojas[nombre].map((fila, r) => `<row r="${r + 1}">${fila.map((v, c) => {
      const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
      if (v === null || v === undefined) return '';
      if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
      if (typeof v === 'object') return `<c r="${ref}" t="str"><f>${esc(v.f)}</f><v>${esc(v.v)}</v></c>`;
      return `<c r="${ref}" t="s"><v>${idx(v)}</v></c>`;
    }).join('')}</row>`).join('');
    archivos[`xl/worksheets/sheet${k + 1}.xml`] = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${filas}</sheetData></worksheet>`;
  });
  archivos['xl/workbook.xml'] = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${nombres.map((n, k) =>
  `<sheet name="${esc(n)}" sheetId="${k + 1}" r:id="rId${k + 1}"/>`).join('')}</sheets></workbook>`;
  archivos['xl/_rels/workbook.xml.rels'] = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
    nombres.map((_, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${k + 1}.xml"/>`).join('')}</Relationships>`;
  archivos['xl/sharedStrings.xml'] = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${
    compartidos.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`;
  return zip(archivos);
}

const b64 = (buf) => Buffer.from(buf).toString('base64');

before(async () => {
  server = await startServer(0);
  base = `http://127.0.0.1:${server.address().port}`;
  await store.upsertClient(A, 'Carga A');
  await store.upsertClient(B, 'Carga B');
  await q(`insert into sdr.cliente_config (client_id, ajustes) values ($1, $2), ($3, $2)`,
    [A, { nombre_comercial: 'A SA', oferta: 'Logística', icp: 'Exportadoras', roles_objetivo: ['Gerente'], cuentas_por_dia: 5 }, B]);
  u.bigua = await loggedIn('operador@carga.test', 'bigua_admin');
  u.a = await loggedIn('usuario@carga-a.test', 'client_admin', A);
  u.b = await loggedIn('usuario@carga-b.test', 'client_admin', B);
});

after(async () => {
  await q(`delete from mailgw.client where id in ($1, $2)`, [A, B]);
  await new Promise((r) => server.close(r));
  await store.closePool();
});

// ---------------------------------------------------------------- lectura

test('lectura: Excel con varias hojas, celdas vacías y fórmulas; el mapeo se propone por el encabezado', () => {
  const buf = xlsx({
    Exportadoras: [
      ['Razón Social', 'Sitio Web', 'Rubro', 'RUT', 'Motivo', 'Mail', 'Región'],
      ['Copefruit S.A.', 'https://www.copefruit.test/contacto', 'Fruta fresca', '76.123.456-7', 'Cliente actual', 'gerente@copefruit.test', 'Maule'],
      [null, null, null, null, null, null, null],
      ['Agrícola Ortiz y Cía. Ltda.', null, 'Uva', { f: 'HYPERLINK("http://x.test","x")', v: '=1+1' }, 'Referido de Juan', null, 'O\'Higgins'],
      ['Agrosuper', 'agrosuper.test', 12345, null, 'Cliente', null, null],
    ],
    Referidos: [['Empresa'], ['Pepe & Hijos <SA>']],
  });
  const r = carga.leerArchivo(buf);
  assert.deepEqual(r.hojas, ['Exportadoras', 'Referidos']);
  assert.equal(r.hoja, 'Exportadoras');
  assert.equal(r.filas.length, 3, 'la fila vacía no cuenta');
  assert.deepEqual(r.filas.map((f) => f.renglon), [2, 4, 5], 'el renglón es el del archivo');
  assert.equal(r.filas[1].celdas[3], '=1+1', 'de una fórmula queda el valor, como texto; nada se evalúa');
  assert.equal(r.filas[2].celdas[2], '12345');
  assert.deepEqual(carga.proponerMapeo(r.encabezados, 'no_contactar'), { empresa: 0, dominio: 1, motivo: 4, contacto_email: 5 });
  assert.deepEqual(carga.proponerMapeo(r.encabezados, 'campana'), { empresa: 0, dominio: 1, vertical: 2, rut: 3 });
  assert.deepEqual(carga.leerArchivo(buf, { hoja: 'Referidos' }).filas[0].celdas, ['Pepe & Hijos <SA>']);
  assert.throws(() => carga.leerArchivo(buf, { hoja: 'Otra' }), /no tiene una hoja/);
});

test('lectura: CSV en Latin-1 con punto y coma y comillas; topes de tamaño y filas; lo que no es un archivo', () => {
  const csv = Buffer.from('Empresa;Web;Motivo\r\n"Copefruit; S.A.";copefruit.test;"dice ""no""\nde nuevo"\r\nÑandú SRL;;cliente\r\n', 'latin1');
  const r = carga.leerArchivo(csv);
  assert.deepEqual(r.encabezados, ['Empresa', 'Web', 'Motivo']);
  assert.deepEqual(r.filas[0].celdas, ['Copefruit; S.A.', 'copefruit.test', 'dice "no" de nuevo']);
  assert.equal(r.filas[1].celdas[0], 'Ñandú SRL');
  assert.equal(r.filas[1].renglon, 4, 'el salto de línea dentro de las comillas corre el renglón');
  const coma = carga.leerArchivo(Buffer.from('\uFEFFempresa,dominio\nUno,uno.test\n'));
  assert.deepEqual(coma.filas[0].celdas, ['Uno', 'uno.test']);

  const muchas = Buffer.from(`empresa\n${Array.from({ length: carga.MAX_FILAS + 1 }, (_, i) => `E${i}`).join('\n')}\n`);
  assert.throws(() => carga.leerArchivo(muchas), /el máximo por carga es 2000/);
  assert.throws(() => carga.leerArchivo(Buffer.alloc(carga.MAX_BYTES + 1, 'a')), /pasa los 3 MB/);
  assert.throws(() => carga.leerArchivo(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0, 1])), /No es un Excel/);
  assert.throws(() => carga.leerArchivo(Buffer.from('PK\u0003\u0004basura')), /dañado/);

  // Un zip que declara tamaños chicos y se infla mucho más: el tope cuenta lo que de verdad sale.
  const bomba = xlsx({ Hoja: [['empresa'], ['x'.repeat(10)]] });
  const relleno = zip({ 'xl/workbook.xml': '<workbook><sheets><sheet name="H" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData>${' '.repeat(45 * 1024 * 1024)}</sheetData></worksheet>` });
  // Se le baja el tamaño declarado en el directorio central a la hoja (la última entrada).
  const fin = relleno.length - 22;
  const dir = relleno.readUInt32LE(fin + 16);
  let p = dir;
  for (let k = 0; k < 2; k++) p += 46 + relleno.readUInt16LE(p + 28);
  relleno.writeUInt32LE(100, p + 24);
  assert.ok(relleno.length < carga.MAX_BYTES, 'comprimido entra en el tope del archivo');
  assert.throws(() => carga.leerArchivo(relleno), /demasiado grande por dentro/);
  assert.equal(carga.leerArchivo(bomba).filas.length, 1);
});

// ---------------------------------------------------------------- no contactar desde un archivo

test('no contactar por archivo: vista previa, confirmar con la misma huella, empresas por nombre y freno en Dripify', async () => {
  // El registro ya tiene: una cuenta en investigación sin dominio con el nombre de un referido, y una
  // en contacto con una persona cargada en Dripify.
  const ortiz = (await sdr.guardarCuenta(A, { nombre: 'Agricola Ortiz' }, meta)).cuenta;
  const copefruit = (await sdr.guardarCuenta(A, { nombre: 'Copefruit', dominio: 'copefruit.test', estado: 'en_contacto' }, meta)).cuenta;
  const ana = (await sdr.guardarProspecto(A, { nombre: 'Ana', email: 'ana@copefruit.test', cuenta_id: copefruit.id }, meta)).prospecto;
  await q(`update sdr.prospecto set dripify = '{"estado":"cargado","carga":"x1"}' where id = $1`, [ana.id]);
  await q(`insert into sdr.no_contactar (client_id, valor, tipo, motivo) values ($1, 'agrosuper.test', 'dominio', 'ya estaba')`, [A]);

  const archivo = b64(xlsx({ Hoja1: [
    ['Razón social', 'Web', 'Motivo', 'Mail'],
    ['Copefruit S.A.', 'www.copefruit.test', 'Cliente actual', 'gerente@copefruit.test'],
    ['Agrícola Ortiz y Cía. Ltda.', null, 'Referido de Juan', 'juan.ortiz@gmail.test'],
    ['Agrosuper', 'agrosuper.test', 'Cliente', null],
    ['COPEFRUIT', 'copefruit.test', 'repetida', null],
    [null, 'sinnombre.test', null, null],
    ['S.A.', null, 'sólo la forma societaria', null],
    ['Frutas del Sur', 'no es un sitio', null, 'no es un mail'],
  ] }));
  const path = `/clients/${A}/no-contactar/cargas`;
  const pv = ok(await u.a.call('POST', `${path}/previa`, { archivo, nombre: 'C:\\Users\\alberto\\referidos.xlsx' }));
  assert.deepEqual(pv.mapeo, { empresa: 0, dominio: 1, motivo: 2, contacto_email: 3 });
  assert.equal(pv.totales.filas, 7);
  assert.equal(pv.totales.invalidas, 2, JSON.stringify(pv.invalidas));
  assert.deepEqual(pv.invalidas.map((x) => x.renglon).sort(), [6, 7]);
  assert.equal(pv.totales.nuevas, 4, JSON.stringify(pv.filas));
  assert.equal(pv.totales.por_dominio, 1);
  assert.equal(pv.totales.por_nombre, 2, 'Ortiz y Frutas del Sur, sin sitio válido, van por el nombre');
  assert.equal(pv.totales.mails, 1, 'el mail de Copefruit lo cubre su dominio; el de Ortiz no');
  assert.equal(pv.totales.ya_estaban, 1);
  assert.equal(pv.totales.repetidas, 1);
  assert.ok(pv.avisos.some((x) => x.renglon === 8 && x.avisos.length === 2));
  assert.equal(pv.efecto.cuentas_excluidas, 1, 'Ortiz, en investigación, quedaría excluida');
  assert.equal(pv.efecto.cuentas_en_marcha, 1, 'Copefruit está en contacto');
  assert.equal(pv.efecto.frenos, 1, 'Ana está cargada en Dripify');
  // La vista previa no escribe nada.
  assert.equal((await q(`select count(*)::int as n from sdr.no_contactar where client_id = $1`, [A])).rows[0].n, 1);
  assert.equal((await q(`select estado from sdr.cuenta where id = $1`, [ortiz.id])).rows[0].estado, 'en_investigacion');

  // Con otro mapeo la huella no es la misma: no se aplica lo que no se vio.
  const otra = await u.a.call('POST', path, { archivo, nombre: 'referidos.xlsx', mapeo: { empresa: 0, motivo: 2 }, huella: pv.huella });
  assert.equal(otra.status, 409);
  assert.equal(otra.body.error.code, 'carga_cambio');

  const ap = ok(await u.a.call('POST', path, { archivo, nombre: 'C:\\Users\\alberto\\referidos.xlsx', huella: pv.huella }));
  assert.equal(ap.lote.archivo, 'referidos.xlsx', 'sin la ruta');
  assert.equal(ap.lote.resumen.nuevas, 4);
  assert.deepEqual(ap.efecto, { ...ap.efecto, cuentas_excluidas: 1, cuentas_en_marcha: 1, frenos: 1 });
  const empresa = ap.no_contactar.find((x) => x.tipo === 'empresa' && x.valor === 'agricola ortiz');
  assert.ok(empresa, JSON.stringify(ap.no_contactar));
  assert.equal(empresa.nombre, 'Agrícola Ortiz y Cía. Ltda.');
  assert.equal(empresa.motivo, 'Referido de Juan');
  assert.equal(empresa.lote_archivo, 'referidos.xlsx');
  assert.deepEqual(ap.totales, { dominios: 2, emails: 1, empresas: 2 });

  // El registro: Ortiz excluida con su motivo; Copefruit sigue en contacto pero Ana se frena en Dripify.
  const k = (await q(`select estado, estado_motivo from sdr.cuenta where id = $1`, [ortiz.id])).rows[0];
  assert.equal(k.estado, 'excluida');
  assert.match(k.estado_motivo, /No contactar: empresa «Agrícola Ortiz y Cía\. Ltda\.»: «Referido de Juan»/, 'lo del cliente va citado');
  assert.equal((await q(`select estado from sdr.cuenta where id = $1`, [copefruit.id])).rows[0].estado, 'en_contacto');
  const freno = (await q(`select dripify->'freno' as f from sdr.prospecto where id = $1`, [ana.id])).rows[0].f;
  assert.equal(freno.pendiente, true);
  assert.equal(freno.motivo, 'está en la lista de no contactar del cliente');
  const ev = await q(`select count(*)::int as n from sdr.evento where client_id = $1 and cuenta_id = $2 and tipo = 'cuenta.excluida'`, [A, ortiz.id]);
  assert.equal(ev.rows[0].n, 1);

  // Lo que llega después: una cuenta con el mismo nombre aunque traiga dominio (docs/26 §7, caso 4),
  // una persona de una cuenta de ese nombre y un mail a ella.
  const tarde = await sdr.guardarCuenta(A, { nombre: 'AGRICOLA ORTIZ SpA', dominio: 'ortiz.test' }, meta);
  assert.equal(tarde.no_contactar, true);
  assert.equal(tarde.cuenta.estado, 'excluida');
  await assert.rejects(sdr.guardarProspecto(A, { nombre: 'Pedro', cuenta_id: ortiz.id }, meta), /no contactar/);
  await assert.rejects(sdr.guardarProspecto(A, { nombre: 'Juan', email: 'juan.ortiz@gmail.test' }, meta), /no contactar/);
  await assert.rejects(correo.controlarDestinatarios(A, ['Juan.Ortiz@gmail.test'], 'send'), (e) => e.code === 'no_contactar');
  const fs = (await sdr.guardarCuenta(A, { nombre: 'Frutas del Sur Ltda.' }, meta)).cuenta;
  assert.equal(fs.estado, 'excluida');
  const libre = await sdr.guardarCuenta(A, { nombre: 'Frutas del Norte' }, meta);
  assert.equal(libre.cuenta.estado, 'en_investigacion', 'otro nombre pasa');
  const sinDominio = (await sdr.guardarProspecto(A, { nombre: 'Rita', email: 'rita@fdn.test', cuenta_id: libre.cuenta.id }, meta)).prospecto;
  assert.ok(sinDominio.id);

  // La lista muestra de qué carga vino; quitar una empresa por su clave la saca.
  const quitar = ok(await u.a.call('POST', `/clients/${A}/no-contactar/quitar`, { valores: ['frutas del sur'] }));
  assert.equal(quitar.quitados, 1);
  const cargas = ok(await u.a.call('GET', `/clients/${A}/cargas`)).cargas;
  assert.equal(cargas.length, 1);
  assert.equal(cargas[0].destino, 'no_contactar');
  assert.equal(cargas[0].por_email, 'usuario@carga-a.test');
  const act = ok(await u.bigua.call('GET', `/clients/${A}/activity`)).activity;
  const op = act.find((x) => x.op === 'admin.sdr.carga');
  assert.ok(op, 'queda auditado');
  assert.ok(!JSON.stringify(op).includes('Ortiz'), 'la auditoría lleva conteos, no contenido');
  // Tocó algo en marcha: el orquestador se entera.
  const avisos = await q(`select que from sdr.pedido where client_id = $1 and para_bot = 'orquestador' and de_bot = 'panel'`, [A]);
  assert.ok(avisos.rows.some((x) => /lista de no contactar/.test(x.que) && /1 persona\(s\) cargadas en Dripify/.test(x.que)), JSON.stringify(avisos.rows));
});

test('no contactar: el alta a mano y el CSV pegado aceptan una empresa por nombre y frenan lo que está en marcha', async () => {
  const k = (await sdr.guardarCuenta(A, { nombre: 'Viña Concha S.A.', dominio: 'concha.test', estado: 'en_pausa' }, meta)).cuenta;
  const p = (await sdr.guardarProspecto(A, { nombre: 'Luis', linkedin_url: 'https://www.linkedin.com/in/luis-concha', cuenta_id: k.id }, meta)).prospecto;
  await q(`update sdr.prospecto set dripify = '{"estado":"cargado"}' where id = $1`, [p.id]);
  const r = ok(await u.a.call('POST', `/clients/${A}/no-contactar`, { valor: 'Viña Concha', motivo: 'Cliente' }));
  assert.equal(r.agregados, 1);
  assert.equal(r.efecto.frenos, 1);
  assert.equal(r.efecto.cuentas_en_marcha, 1);
  assert.ok(r.no_contactar.some((x) => x.tipo === 'empresa' && x.valor === 'vina concha' && x.nombre === 'Viña Concha'));
  const csv = ok(await u.a.call('POST', `/clients/${A}/no-contactar`, { csv: 'empresa,motivo\nLa Rosa Ltda.,Partner\n---,nada\n' }));
  assert.equal(csv.agregados, 1);
  assert.equal(csv.invalidas.length, 1);
  await assert.rejects(sdr.guardarProspecto(A, { nombre: 'Otro', cuenta_id: k.id }, meta), /no contactar/);
});

// ---------------------------------------------------------------- semillas de una campaña

test('semillas: se cargan en su campaña, quedan excluidas con su perfil y no pisan lo que ya está en el registro', async () => {
  const camp = ok(await u.a.call('GET', `/clients/${A}/sdr/campanas`)).campanas;
  const principal = camp.find((x) => x.clave === 'principal');
  const icp = ok(await u.a.call('POST', `/clients/${A}/sdr/campanas`, { nombre: 'Exportadoras por ICP' })).campana;
  // Una cuenta que ya trabaja la principal.
  await sdr.guardarCuenta(A, { nombre: 'Frutícola Maule', dominio: 'maule.test' }, meta);

  const archivo = b64(Buffer.from([
    'Empresa,Web,Rubro,Tamaño,Nota,Región,Contacto',
    'Hortifrut S.A.,hortifrut.test,Berries,grande,Exporta a China,Maule,=cmd|calc',
    'Frutícola Maule,maule.test,Fruta,mediana,,Maule,',
    'Subsole,,Uva,,,Valparaíso,',
    'HORTIFRUT,hortifrut.test,Berries,,,,',
    ',sin.test,,,,,',
  ].join('\n'), 'utf8'));
  const path = `/clients/${A}/sdr/campanas/${icp.id}/cargas`;
  const pv = ok(await u.a.call('POST', `${path}/previa`, { archivo, nombre: 'semillas.csv' }));
  assert.equal(pv.campana.nombre, 'Exportadoras por ICP');
  assert.deepEqual(pv.mapeo, { empresa: 0, dominio: 1, vertical: 2, tamano: 3, nota: 4 });
  assert.deepEqual({ ...pv.totales }, { filas: 5, invalidas: 1, nuevas: 2, ya_en_registro: 1, ya_eran_semilla: 0, repetidas: 1,
    sin_dominio: 1, en_no_contactar: 0 });
  const maule = pv.filas.find((f) => f.empresa === 'Frutícola Maule');
  assert.equal(maule.resultado, 'ya_en_registro');
  assert.equal(maule.existente.campana, principal.nombre);

  const ap = ok(await u.a.call('POST', path, { archivo, nombre: 'semillas.csv', huella: pv.huella }));
  assert.equal(ap.lote.resumen.nuevas, 2);
  const { rows } = await q(`select nombre, dominio, vertical, tamano, tesis, estado, estado_motivo, campana_id, origen, uso, datos_origen, prioridad
                              from sdr.cuenta where client_id = $1 and lote_id = $2 order by prioridad`, [A, ap.lote.id]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].nombre, 'Hortifrut S.A.');
  assert.equal(rows[0].estado, 'excluida');
  assert.match(rows[0].estado_motivo, /Semilla del ICP de la campaña «Exportadoras por ICP»/);
  assert.equal(rows[0].campana_id, icp.id);
  assert.deepEqual([rows[0].origen, rows[0].uso, rows[0].tesis, rows[0].tamano], ['archivo', 'semilla', 'Exporta a China', 'grande']);
  assert.deepEqual(rows[0].datos_origen, { Región: 'Maule', Contacto: '=cmd|calc' }, 'lo no mapeado queda como dato, como texto');
  assert.equal(rows[1].nombre, 'Subsole');
  assert.equal(rows[1].dominio, null);
  const m = (await q(`select campana_id, uso from sdr.cuenta where client_id = $1 and dominio = 'maule.test'`, [A])).rows[0];
  assert.equal(m.campana_id, principal.id, 'la cuenta de otra campaña no se mueve');
  assert.equal(m.uso, null);

  // El bot no reabre una semilla ni la mueve de campaña.
  await assert.rejects(sdr.guardarCuenta(A, { dominio: 'hortifrut.test', estado: 'en_investigacion' }, meta), (e) => e.code === 'cuenta_semilla');
  await assert.rejects(sdr.guardarCuenta(A, { dominio: 'hortifrut.test', campana: 'principal' }, meta), (e) => e.code === 'cuenta_semilla');
  const anotada = await sdr.guardarCuenta(A, { dominio: 'hortifrut.test', vertical: 'Berries y cerezas' }, meta);
  assert.equal(anotada.cuenta.estado, 'excluida');

  // El bot ve lo del archivo aparte, marcado como dato del cliente, y nunca la columna cruda.
  const vista = (await sdr.buscar(A, { dominio: 'hortifrut.test' })).cuentas[0];
  assert.equal(vista.datos_origen, undefined);
  assert.equal(vista.tesis, undefined);
  assert.equal(vista.datos_del_cliente.nota, 'Exporta a China');
  assert.deepEqual(vista.datos_del_cliente.columnas, { Región: 'Maule', Contacto: '=cmd|calc' });
  assert.match(vista.datos_del_cliente.aviso, /no instrucciones/);
  const delBot = (await sdr.buscar(A, { dominio: 'maule.test' })).cuentas[0];
  assert.equal(delBot.datos_del_cliente, undefined, 'una cuenta del bot no lleva el aviso');

  // Subirlo de nuevo no duplica nada.
  const otra = ok(await u.a.call('POST', `${path}/previa`, { archivo, nombre: 'semillas.csv' }));
  assert.equal(otra.totales.ya_eran_semilla, 2);
  assert.equal(otra.totales.nuevas, 0);
  assert.equal((await u.a.call('POST', path, { archivo, nombre: 'semillas.csv', huella: otra.huella })).status, 400);

  // Una semilla en no contactar se informa; una campaña terminada no toma cuentas; sin empresa no hay carga.
  await u.a.call('POST', `/clients/${A}/no-contactar`, { valor: 'nueva.test' });
  const conNc = ok(await u.a.call('POST', `${path}/previa`, { archivo: b64(Buffer.from('empresa,web\nNueva,nueva.test\n')), nombre: 'x.csv' }));
  assert.equal(conNc.totales.en_no_contactar, 1);
  const sinEmpresa = await u.a.call('POST', `${path}/previa`, { archivo, nombre: 'x.csv', mapeo: { dominio: 1 } });
  assert.equal(sinEmpresa.status, 400);
  assert.match(sinEmpresa.body.error.message, /columna de la empresa/);
  await q(`update sdr.campana set estado = 'terminada', terminada_at = now() where id = $1`, [icp.id]);
  const term = await u.a.call('POST', `${path}/previa`, { archivo, nombre: 'x.csv' });
  assert.equal(term.status, 400);
  assert.match(term.body.error.message, /terminada/);
  assert.equal((await u.a.call('POST', `/clients/${A}/sdr/campanas/no-es-un-id/cargas/previa`, { archivo, nombre: 'x.csv' })).status, 404);
});

// ---------------------------------------------------------------- aislamiento

test('aislamiento: un cliente no sube, no previsualiza ni ve las cargas de otro', async () => {
  const archivo = b64(Buffer.from('empresa\nCualquiera\n'));
  for (const [m, p] of [['POST', `/clients/${A}/no-contactar/cargas/previa`], ['POST', `/clients/${A}/no-contactar/cargas`],
    ['GET', `/clients/${A}/cargas`]]) {
    const r = await u.b.call(m, p, m === 'POST' ? { archivo, nombre: 'x.csv' } : undefined);
    assert.equal(r.status, 404, `${m} ${p}: ${JSON.stringify(r.body)}`);
  }
  const campA = ok(await u.a.call('GET', `/clients/${A}/sdr/campanas`)).campanas[0];
  assert.equal((await u.b.call('POST', `/clients/${A}/sdr/campanas/${campA.id}/cargas/previa`, { archivo, nombre: 'x.csv' })).status, 404);
  // Con el id de una campaña de A en la ruta de B, tampoco: la campaña se busca dentro del cliente.
  assert.equal((await u.b.call('POST', `/clients/${B}/sdr/campanas/${campA.id}/cargas/previa`, { archivo, nombre: 'x.csv' })).status, 404);
  const cruz = await store.asRole('mailgw_portal', B, (c) => c.query(`select * from sdr.lote_carga`));
  assert.equal(cruz.rows.length, 0);
  const cruzApp = await store.asRole('mailgw_app', B, (c) => c.query(`select * from sdr.lote_carga`));
  assert.equal(cruzApp.rows.length, 0);
  await assert.rejects(store.asRole('mailgw_portal', B, (c) => c.query(
    `insert into sdr.lote_carga (client_id, destino, archivo, mapeo, por_email) values ($1, 'no_contactar', 'x', '{}', 'x')`, [A])),
  /row-level security/);
  await assert.rejects(store.asRole('mailgw_app', A, (c) => c.query(
    `insert into sdr.no_contactar (client_id, valor, tipo) values ($1, 'bot', 'empresa')`, [A])), /permission denied/,
  'los bots siguen sin poder cambiar la lista');
});

test('el cuerpo de una carga puede pasar el MB de las demás rutas, hasta su tope', async () => {
  const grande = b64(Buffer.alloc(1_500_000, 'empresa\nUna\n'));
  const r = await u.a.call('POST', `/clients/${A}/no-contactar/cargas/previa`, { archivo: grande, nombre: 'grande.csv' });
  assert.notEqual(r.status, 413, JSON.stringify(r.body).slice(0, 200));
  const otra = await u.a.call('POST', `/clients/${A}/no-contactar`, { csv: 'x'.repeat(1_200_000) });
  assert.equal(otra.status, 413);
});
