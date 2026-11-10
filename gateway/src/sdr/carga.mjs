// Carga de cuentas por archivo (docs/26), etapa 1. Un Excel (.xlsx) o un CSV que el cliente o un
// operador sube en el panel, con dos destinos:
//   campana       las cuentas de una campaña. En la etapa 1, semillas del ICP: quedan en el
//                 registro como excluidas, con su perfil, para que la campaña busque parecidas
//                 (docs/27). Nadie les escribe.
//   no_contactar  la lista de no contactar de la empresa, la de siempre (no_contactar.mjs).
//
// El archivo no se guarda: se lee en memoria, se arma la vista previa y, al confirmar, el panel lo
// vuelve a mandar con la huella de esa vista previa; si el archivo, la hoja o el mapeo cambiaron,
// no se aplica. Todo lo que trae es contenido del cliente: se guarda como texto (una celda con «=»
// es texto, nunca una fórmula) y el bot lo lee como dato del cliente, no como instrucciones.

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { GatewayError } from '../errors.mjs';
import * as noContactar from './no_contactar.mjs';

export const MAX_BYTES = 3 * 1024 * 1024;
export const MAX_FILAS = 2000;
const MAX_COLUMNAS = 60;
const MAX_CELDA = 1000;
const MAX_DATOS_ORIGEN = 2048;
const MAX_DESCOMPRIMIDO = 40 * 1024 * 1024;

const invalido = (msg) => new GatewayError('invalid_request', msg, 400);

// ---------------------------------------------------------------- campos

// Los campos de cada destino, con los encabezados con que suelen venir (ya normalizados: minúsculas,
// sin tildes ni signos). El mapeo propuesto toma el primero que coincide; el usuario lo corrige.
export const CAMPOS = {
  empresa: { titulo: 'Empresa', obligatorio: true,
    nombres: ['empresa', 'razon social', 'nombre empresa', 'nombre de la empresa', 'compania', 'company', 'cuenta', 'organizacion',
      'exportadora', 'exportador', 'cliente', 'nombre'] },
  dominio: { titulo: 'Sitio web o dominio', nombres: ['dominio', 'sitio web', 'sitio', 'web', 'pagina web', 'website', 'url', 'domain'] },
  pais: { titulo: 'País', nombres: ['pais', 'country'] },
  vertical: { titulo: 'Rubro', nombres: ['rubro', 'vertical', 'industria', 'sector', 'industry', 'actividad'] },
  tamano: { titulo: 'Tamaño', nombres: ['tamano', 'tamanio', 'empleados', 'dotacion', 'size'] },
  rut: { titulo: 'RUT o identificador fiscal', nombres: ['rut', 'cuit', 'nit', 'ruc', 'rfc', 'identificador fiscal', 'tax id'] },
  nota: { titulo: 'Nota para el bot', nombres: ['nota para el bot', 'nota', 'notas', 'comentario', 'comentarios', 'observaciones', 'por que'] },
  motivo: { titulo: 'Motivo', nombres: ['motivo', 'razon', 'por que no', 'observacion', 'observaciones', 'comentario'] },
  contacto_email: { titulo: 'Mail del contacto', nombres: ['mail', 'email', 'e mail', 'correo', 'correo electronico', 'mail contacto'] },
};

export const CAMPOS_DE = {
  campana: ['empresa', 'dominio', 'pais', 'vertical', 'tamano', 'rut', 'nota'],
  no_contactar: ['empresa', 'dominio', 'motivo', 'contacto_email'],
};

const normalizarEncabezado = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

export function proponerMapeo(encabezados, destino) {
  const campos = CAMPOS_DE[destino];
  const norm = encabezados.map(normalizarEncabezado);
  const usadas = new Set();
  const mapeo = {};
  // Primero las coincidencias exactas, después las parciales («Razón social de la exportadora»).
  for (const exacta of [true, false]) {
    for (const campo of campos) {
      if (mapeo[campo] !== undefined) continue;
      for (const n of CAMPOS[campo].nombres) {
        const i = norm.findIndex((h, j) => !usadas.has(j) && h && (exacta ? h === n : ` ${h} `.includes(` ${n} `)));
        if (i >= 0) { mapeo[campo] = i; usadas.add(i); break; }
      }
    }
  }
  return mapeo;
}

function validarMapeo(mapeo, destino, nColumnas) {
  const campos = CAMPOS_DE[destino];
  const out = {};
  const usadas = new Set();
  for (const [campo, i] of Object.entries(mapeo ?? {})) {
    if (i === null || i === undefined) continue;
    if (!campos.includes(campo)) throw invalido(`«${campo}» no es un campo de esta carga.`);
    if (!Number.isInteger(i) || i < 0 || i >= nColumnas) throw invalido(`La columna de «${CAMPOS[campo].titulo}» no existe en el archivo.`);
    if (usadas.has(i)) throw invalido('Una columna no puede ir a dos campos.');
    usadas.add(i);
    out[campo] = i;
  }
  if (out.empresa === undefined) throw invalido('Falta elegir la columna de la empresa.');
  return out;
}

// ---------------------------------------------------------------- lectura del archivo

// { hojas, hoja, encabezados, filas: [{ renglon, celdas }] }. filas sin el encabezado ni los
// renglones vacíos; renglon es el número de fila en el archivo, para el informe.
export function leerArchivo(buf, { hoja } = {}) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw invalido('El archivo está vacío.');
  if (buf.length > MAX_BYTES) throw invalido(`El archivo pasa los ${MAX_BYTES / 1024 / 1024} MB: partilo en dos.`);
  const esZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  let hojas = [];
  let elegida = null;
  let renglones;
  if (esZip) {
    const libro = leerXlsx(buf);
    hojas = libro.hojas.map((h) => h.nombre);
    const h = hoja ? libro.hojas.find((x) => x.nombre === hoja) : libro.hojas[0];
    if (!h) throw invalido(`El archivo no tiene una hoja «${String(hoja).slice(0, 60)}».`);
    elegida = h.nombre;
    renglones = libro.leerHoja(h);
  } else {
    if (buf.subarray(0, 8).includes(0)) throw invalido('No es un Excel (.xlsx) ni un CSV. Un .xls viejo se guarda primero como .xlsx.');
    renglones = leerCsv(decodificar(buf));
  }
  const conDatos = renglones.filter((r) => r.celdas.some((x) => x !== ''));
  if (!conDatos.length) throw invalido('El archivo no tiene filas.');
  const [cab, ...filas] = conDatos;
  if (filas.length > MAX_FILAS) throw invalido(`El archivo tiene ${filas.length} filas; el máximo por carga es ${MAX_FILAS}. Partilo en dos.`);
  const nColumnas = Math.min(MAX_COLUMNAS, Math.max(cab.celdas.length, ...filas.map((f) => f.celdas.length)));
  const encabezados = Array.from({ length: nColumnas }, (_, i) => cab.celdas[i] || `Columna ${letra(i)}`);
  return { hojas, hoja: elegida, encabezados, filas: filas.map((f) => ({ renglon: f.renglon, celdas: f.celdas.slice(0, nColumnas) })) };
}

const letra = (i) => { let s = ''; for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s; return s; };
const celda = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CELDA);

// UTF-8 si lo es (con o sin BOM); si no, Windows-1252 (lo que guarda Excel como «CSV» en español).
function decodificar(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

// CSV con comillas (separadores y saltos de línea adentro, "" como comilla). El separador es el que
// más aparece en el primer renglón, fuera de comillas: coma, punto y coma o tabulación.
export function leerCsv(texto) {
  const primera = texto.split(/\r?\n/, 1)[0].replace(/"[^"]*"/g, '');
  const sep = [',', ';', '\t'].map((s) => [s, primera.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const out = [];
  let fila = [];
  let campo = '';
  let comillas = false;
  let linea = 1;
  let inicio = 1;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (comillas) {
      if (ch === '"') {
        if (texto[i + 1] === '"') { campo += '"'; i++; } else comillas = false;
      } else {
        if (ch === '\n') linea++;
        campo += ch;
      }
      continue;
    }
    if (ch === '"' && campo.trim() === '') { campo = ''; comillas = true; } else if (ch === sep) { fila.push(celda(campo)); campo = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && texto[i + 1] === '\n') i++;
      fila.push(celda(campo));
      out.push({ renglon: inicio, celdas: fila });
      if (out.length > MAX_FILAS + 50) break;
      fila = []; campo = ''; linea++; inicio = linea;
    } else campo += ch;
  }
  if (campo !== '' || fila.length) { fila.push(celda(campo)); out.push({ renglon: inicio, celdas: fila }); }
  return out;
}

// ----- .xlsx: un zip con XML adentro. Se leen sólo los valores (el último calculado, en una
// fórmula): nada se evalúa, ni macros ni vínculos externos.

function leerZip(buf) {
  const min = Math.max(0, buf.length - 65_557);
  let fin = -1;
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === 0x06054b50) { fin = i; break; }
  if (fin < 0) throw invalido('El Excel está dañado (no se pudo abrir).');
  const n = buf.readUInt16LE(fin + 10);
  let p = buf.readUInt32LE(fin + 16);
  const entradas = new Map();
  for (let k = 0; k < n; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw invalido('El Excel está dañado (directorio).');
    const metodo = buf.readUInt16LE(p + 10);
    const comprimido = buf.readUInt32LE(p + 20);
    const tamano = buf.readUInt32LE(p + 24);
    const largoNombre = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comentario = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const nombre = buf.subarray(p + 46, p + 46 + largoNombre).toString('utf8');
    entradas.set(nombre, { metodo, comprimido, tamano, local });
    p += 46 + largoNombre + extra + comentario;
  }
  let total = 0;
  return (nombre) => {
    const e = entradas.get(nombre);
    if (!e) return null;
    if (e.local + 30 > buf.length || buf.readUInt32LE(e.local) !== 0x04034b50) throw invalido('El Excel está dañado (entrada).');
    const desde = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    const datos = buf.subarray(desde, desde + e.comprimido);
    total += e.tamano;
    if (e.tamano > MAX_DESCOMPRIMIDO || total > MAX_DESCOMPRIMIDO) throw invalido('El Excel es demasiado grande por dentro: guardá sólo la hoja que se carga.');
    let out;
    try {
      if (e.metodo === 0) out = Buffer.from(datos);
      else if (e.metodo === 8) out = zlib.inflateRawSync(datos, { maxOutputLength: MAX_DESCOMPRIMIDO });
      else throw invalido('El Excel usa una compresión que no se lee: guardalo de nuevo como .xlsx.');
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      throw invalido('El Excel está dañado o protegido con contraseña.');
    }
    return out.toString('utf8');
  };
}

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const xmlTexto = (s) => s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') {
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  }
  return ENTIDADES[e.toLowerCase()] ?? m;
});
const atributo = (attrs, nombre) => new RegExp(`(?:^|\\s)${nombre}="([^"]*)"`).exec(attrs)?.[1] ?? null;
// El texto de un <si> o un <is>: todos sus <t>, sin la guía fonética (<rPh>).
const textos = (xml) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => xmlTexto(m[1])).join('');

function columnaDe(ref) {
  const m = /^([A-Z]+)/.exec(ref ?? '');
  if (!m) return null;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function leerXlsx(buf) {
  const abrir = leerZip(buf);
  const libro = abrir('xl/workbook.xml');
  if (!libro) throw invalido('No es un Excel (.xlsx) válido.');
  const rels = abrir('xl/_rels/workbook.xml.rels') ?? '';
  const destino = new Map([...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => [atributo(m[1], 'Id'), atributo(m[1], 'Target')]));
  const ruta = (t) => (t.startsWith('/') ? t.slice(1) : `xl/${t}`).replace(/\/\.\//g, '/');
  const hojas = [...libro.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => ({
    nombre: xmlTexto(atributo(m[1], 'name') ?? ''), archivo: destino.get(atributo(m[1], 'r:id')),
  })).filter((h) => h.archivo);
  if (!hojas.length) throw invalido('El Excel no tiene hojas.');
  let compartidos = null;
  const compartido = (i) => {
    if (!compartidos) {
      const xml = abrir('xl/sharedStrings.xml') ?? '';
      compartidos = [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textos(m[1]));
    }
    return compartidos[i] ?? '';
  };
  const leerHoja = (h) => {
    const xml = abrir(ruta(h.archivo));
    if (xml === null) throw invalido(`No se pudo leer la hoja «${h.nombre}».`);
    const out = [];
    let siguiente = 1;
    for (const m of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const renglon = Number(atributo(m[1], 'r')) || siguiente;
      siguiente = renglon + 1;
      const celdas = [];
      let col = 0;
      for (const cm of (m[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const c = columnaDe(atributo(cm[1], 'r'));
        if (c !== null) col = c;
        if (col >= MAX_COLUMNAS) break;
        const tipo = atributo(cm[1], 't');
        const dentro = cm[2] ?? '';
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(dentro)?.[1];
        let valor = '';
        if (tipo === 's') valor = v === undefined ? '' : compartido(Number(v));
        else if (tipo === 'inlineStr') valor = textos(/<is\b[^>]*>([\s\S]*?)<\/is>/.exec(dentro)?.[1] ?? '');
        else if (tipo === 'b') valor = v === '1' ? 'VERDADERO' : v === '0' ? 'FALSO' : '';
        else if (tipo === 'e') valor = '';
        else valor = v === undefined ? '' : xmlTexto(v);
        while (celdas.length < col) celdas.push('');
        celdas[col] = celda(valor);
        col++;
      }
      out.push({ renglon, celdas });
      if (out.length > MAX_FILAS + 50) break;
    }
    return out;
  };
  return { hojas, leerHoja };
}

// ---------------------------------------------------------------- filas

const recortar = (s, n) => (s ? s.slice(0, n) : null);

// La fila del archivo, ya con sus campos: { renglon, empresa, dominio, ..., extra, avisos, error }.
function normalizarFila(f, mapeo, encabezados, destino) {
  const v = (campo) => (mapeo[campo] === undefined ? '' : f.celdas[mapeo[campo]] ?? '');
  const avisos = [];
  const fila = { renglon: f.renglon, empresa: recortar(v('empresa'), noContactar.MAX_NOMBRE), avisos };
  if (!fila.empresa || !/[\p{L}\p{N}]/u.test(fila.empresa)) return { ...fila, error: 'sin el nombre de la empresa' };
  const web = v('dominio');
  if (web) {
    const n = noContactar.normalizar(web);
    if (n?.tipo === 'dominio') fila.dominio = n.valor;
    else avisos.push(`«${web.slice(0, 60)}» no es un sitio web: va por el nombre`);
  }
  if (destino === 'no_contactar') {
    fila.motivo = recortar(v('motivo'), 200);
    const mail = v('contacto_email');
    if (mail) {
      const n = noContactar.normalizar(mail);
      if (n?.tipo === 'email') fila.email = n.valor;
      else avisos.push(`«${mail.slice(0, 60)}» no es un mail: no se carga`);
    }
    return fila;
  }
  fila.pais = recortar(v('pais'), 80);
  fila.vertical = recortar(v('vertical'), 200);
  fila.tamano = recortar(v('tamano'), 80);
  fila.nota = recortar(v('nota'), 300);
  // Lo que no se mapeó queda como dato del cliente, con su encabezado, hasta 2 KB.
  const usadas = new Set(Object.values(mapeo));
  const extra = {};
  if (v('rut')) extra.rut = v('rut').slice(0, 40);
  let largo = JSON.stringify(extra).length;
  encabezados.forEach((h, i) => {
    const x = f.celdas[i];
    if (usadas.has(i) || !x) return;
    const k = String(h).slice(0, 60);
    const suma = k.length + x.length + 6;
    if (largo + suma > MAX_DATOS_ORIGEN) return;
    extra[k] = x;
    largo += suma;
  });
  fila.datos_origen = extra;
  return fila;
}

export function huella({ archivo, hoja, destino, campanaId, mapeo }) {
  const h = crypto.createHash('sha256');
  h.update(archivo);
  h.update(JSON.stringify([hoja ?? null, destino, campanaId ?? null, Object.entries(mapeo).sort()]));
  return h.digest('base64url').slice(0, 32);
}

// Lee el archivo y arma las filas del destino. Devuelve también lo que el panel necesita para el
// paso de mapeo: hojas, encabezados, el mapeo usado y una muestra de los primeros renglones.
export function prepararFilas({ archivo, hoja, mapeo, destino, campanaId }) {
  const buf = Buffer.from(String(archivo ?? ''), 'base64');
  const libro = leerArchivo(buf, { hoja });
  const usado = validarMapeo(mapeo ?? proponerMapeo(libro.encabezados, destino), destino, libro.encabezados.length);
  const filas = libro.filas.map((f) => normalizarFila(f, usado, libro.encabezados, destino));
  return {
    hojas: libro.hojas, hoja: libro.hoja, encabezados: libro.encabezados, mapeo: usado,
    campos: CAMPOS_DE[destino].map((k) => ({ clave: k, titulo: CAMPOS[k].titulo, obligatorio: Boolean(CAMPOS[k].obligatorio) })),
    muestra: libro.filas.slice(0, 5).map((f) => f.celdas),
    filas,
    huella: huella({ archivo: String(archivo), hoja: libro.hoja, destino, campanaId, mapeo: usado }),
  };
}

// ---------------------------------------------------------------- no contactar

// Las filas de la lista que salen del archivo: la empresa por dominio o, sin dominio, por nombre; y
// el mail del contacto si su dominio no queda cubierto. c: una conexión (para las claves).
export async function planNoContactar(c, clientId, filas) {
  const entradas = [];
  for (const f of filas) {
    if (f.error) continue;
    entradas.push(f.dominio
      ? { renglon: f.renglon, tipo: 'dominio', valor: f.dominio, motivo: f.motivo }
      : { renglon: f.renglon, tipo: 'empresa', valor: null, nombre: f.empresa, motivo: f.motivo });
    if (f.email) {
      const d = f.email.split('@')[1];
      if (!f.dominio || !(d === f.dominio || d.endsWith(`.${f.dominio}`))) {
        entradas.push({ renglon: f.renglon, tipo: 'email', valor: f.email, motivo: f.motivo });
      }
    }
  }
  const { filas: conClave, invalidas } = await noContactar.conClaves(c, entradas);
  const { rows: ya } = await c.query(`select valor from sdr.no_contactar where client_id = $1 and valor = any($2)`,
    [clientId, conClave.map((e) => e.valor)]);
  const estaban = new Set(ya.map((r) => r.valor));
  const vistas = new Set();
  const nuevas = [];
  for (const e of conClave) {
    if (estaban.has(e.valor)) e.resultado = 'ya_estaba';
    else if (vistas.has(e.valor)) e.resultado = 'repetida';
    else { e.resultado = 'nueva'; nuevas.push(e); }
    vistas.add(e.valor);
  }
  return { entradas: conClave, nuevas, sinClave: invalidas };
}

// ---------------------------------------------------------------- semillas de una campaña

// Qué pasa con cada fila en una campaña: una cuenta nueva, o una que ya está en el registro (no se
// toca: una cuenta está en una sola campaña, docs/21 §4.3). c: con el rol de la aplicación.
export async function planSemillas(c, clientId, campana, filas) {
  const validas = filas.filter((f) => !f.error);
  const ks = await noContactar.claves(c, validas.map((f) => f.empresa));
  validas.forEach((f, i) => { f.clave = ks[i]; });
  const { rows: existentes } = await c.query(
    `select k.id, k.nombre, k.dominio, k.nombre_clave, k.estado, k.uso, k.campana_id, cp.nombre as campana
       from sdr.cuenta k left join sdr.campana cp on cp.id = k.campana_id and cp.client_id = k.client_id
      where k.client_id = $1 and (k.dominio = any($2) or k.nombre_clave = any($3))`,
    [clientId, validas.map((f) => f.dominio).filter(Boolean), validas.map((f) => f.clave).filter(Boolean)]);
  const porDominio = new Map(existentes.filter((k) => k.dominio).map((k) => [k.dominio, k]));
  const porClave = new Map();
  for (const k of existentes) if (k.nombre_clave && !porClave.has(k.nombre_clave)) porClave.set(k.nombre_clave, k);
  const nc = await noContactar.coincidencias(c, clientId, validas.map((f) => f.dominio).filter(Boolean),
    { nombres: validas.map((f) => f.empresa) });
  const enLista = new Set(nc.map((r) => r.para));
  const vistas = new Set();
  const nuevas = [];
  let orden = 0;
  for (const f of validas) {
    if (!f.clave) { f.error = 'el nombre de la empresa queda vacío sin la forma societaria'; continue; }
    const llave = f.dominio ?? `#${f.clave}`;
    // Sin dominio, la cuenta del registro con el mismo nombre (si no tiene un dominio distinto).
    const k = f.dominio ? porDominio.get(f.dominio) : porClave.get(f.clave);
    if (vistas.has(llave)) f.resultado = 'repetida';
    else if (k && k.uso === 'semilla' && k.campana_id === campana.id) f.resultado = 'ya_era_semilla';
    else if (k) { f.resultado = 'ya_en_registro'; f.existente = { estado: k.estado, campana: k.campana, uso: k.uso }; } else {
      f.resultado = 'nueva';
      f.prioridad = ++orden;
      nuevas.push(f);
    }
    if (enLista.has(f.empresa) || (f.dominio && enLista.has(f.dominio))) f.en_no_contactar = true;
    vistas.add(llave);
  }
  return { nuevas };
}

// Escribe de a tandas de 200 (una sola consulta grande con 2.000 filas pesa en la base) y junta lo
// que devuelve cada una. Todo dentro de la transacción de quien llama.
export async function insertarEnTandas(items, fn, tam = 200) {
  const out = [];
  for (let i = 0; i < items.length; i += tam) out.push(...(await fn(items.slice(i, i + tam))));
  return out;
}

export function resumirFilas(filas, campo = 'resultado') {
  const out = {};
  for (const f of filas) {
    const k = f.error ? 'invalida' : f[campo] ?? 'otra';
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
