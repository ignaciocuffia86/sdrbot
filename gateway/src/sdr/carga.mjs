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
import { normalizeLinkedin } from './linkedin.mjs';

export const MAX_BYTES = 3 * 1024 * 1024;
export const MAX_FILAS = 2000;
const MAX_COLUMNAS = 60;
const MAX_CELDA = 1000;
const MAX_DATOS_ORIGEN = 2048;
const MAX_DESCOMPRIMIDO = 20 * 1024 * 1024;

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
  uso: { titulo: 'Uso (prospectar o semilla)', nombres: ['uso', 'tipo de fila', 'semilla'] },
  contacto_nombre: { titulo: 'Contacto: nombre', nombres: ['contacto', 'nombre contacto', 'nombre del contacto', 'persona', 'nombre y apellido'] },
  contacto_cargo: { titulo: 'Contacto: cargo', nombres: ['cargo', 'puesto', 'rol', 'titulo', 'position', 'title'] },
  contacto_telefono: { titulo: 'Contacto: teléfono', nombres: ['telefono', 'celular', 'movil', 'whatsapp', 'phone', 'tel'] },
  contacto_linkedin: { titulo: 'Contacto: LinkedIn', nombres: ['linkedin', 'perfil linkedin', 'url linkedin', 'linkedin url'] },
};

export const CAMPOS_DE = {
  campana: ['empresa', 'dominio', 'pais', 'vertical', 'tamano', 'rut', 'nota', 'uso',
    'contacto_nombre', 'contacto_cargo', 'contacto_email', 'contacto_telefono', 'contacto_linkedin'],
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
    // El tamaño que declara el zip puede mentir: el tope cuenta lo que de verdad sale, y cada entrada
    // se descomprime con lo que queda del tope total como máximo.
    const grande = () => invalido('El Excel es demasiado grande por dentro: guardá sólo la hoja que se carga.');
    const queda = MAX_DESCOMPRIMIDO - total;
    if (e.tamano > queda) throw grande();
    let out;
    try {
      if (e.metodo === 0) out = Buffer.from(datos);
      else if (e.metodo === 8) out = zlib.inflateRawSync(datos, { maxOutputLength: Math.max(1, queda) });
      else throw invalido('El Excel usa una compresión que no se lee: guardalo de nuevo como .xlsx.');
    } catch (err) {
      if (err instanceof GatewayError) throw err;
      if (err?.code === 'ERR_BUFFER_TOO_LARGE') throw grande();
      throw invalido('El Excel está dañado o protegido con contraseña.');
    }
    total += out.length;
    if (total > MAX_DESCOMPRIMIDO) throw grande();
    return out.toString('utf8');
  };
}

// El XML se recorre con búsquedas hacia adelante (indexOf), nunca con expresiones que vuelvan a
// mirar lo ya leído: el trabajo crece en línea con el tamaño, también con un archivo armado para
// trabar el gateway (Vercel 01M7360X214QQ68W26K5AYZAE5). Lo mal formado (una etiqueta sin cerrar, una
// etiqueta enorme) se rechaza en el acto, y la lectura entera tiene un plazo.
const MAX_ETIQUETA = 4096;
const MAX_TEXTO_CRUDO = MAX_CELDA * 8;
const MAX_COMPARTIDOS = 100_000;
const PLAZO_MS = 4000;

const malformado = () => invalido('El Excel está mal formado: guardalo de nuevo desde Excel como .xlsx.');

function reloj() {
  const hasta = Date.now() + PLAZO_MS;
  let n = 0;
  return () => {
    if ((++n & 255) === 0 && Date.now() > hasta) {
      throw invalido('El Excel tarda demasiado en leerse: guardá sólo la hoja que se carga o pasalo a CSV.');
    }
  };
}

// La próxima etiqueta <nombre ...> desde `desde`: { attrs, vacia (<x/>), fin (después del «>») }.
// «<c» no confunde a «<col»: después del nombre tiene que venir un espacio, «>» o «/».
function etiqueta(xml, nombre, desde) {
  const marca = `<${nombre}`;
  let i = desde;
  for (;;) {
    i = xml.indexOf(marca, i);
    if (i < 0) return null;
    const sig = xml.charCodeAt(i + marca.length);
    if (sig === 32 || sig === 9 || sig === 10 || sig === 13 || sig === 62 || sig === 47) {
      const cierre = xml.indexOf('>', i);
      if (cierre < 0 || cierre - i > MAX_ETIQUETA) throw malformado();
      const vacia = xml.charCodeAt(cierre - 1) === 47;
      return { attrs: xml.slice(i + marca.length, vacia ? cierre - 1 : cierre), vacia, fin: cierre + 1 };
    }
    i += marca.length;
  }
}

// Cada elemento <nombre> desde el principio, con su contenido aparte (un string propio, así las
// búsquedas de adentro no recorren el resto del archivo). Uno abierto y sin cerrar: mal formado.
function* elementos(xml, nombre, tic = () => {}) {
  const cierre = `</${nombre}>`;
  let pos = 0;
  for (;;) {
    tic();
    const e = etiqueta(xml, nombre, pos);
    if (!e) return;
    if (e.vacia) { pos = e.fin; yield { attrs: e.attrs, contenido: '' }; continue; }
    const fin = xml.indexOf(cierre, e.fin);
    if (fin < 0) throw malformado();
    pos = fin + cierre.length;
    yield { attrs: e.attrs, contenido: xml.slice(e.fin, fin) };
  }
}

const primero = (xml, nombre) => { for (const e of elementos(xml, nombre)) return e; return null; };

// Los atributos de una etiqueta (ya acotada a MAX_ETIQUETA), en una sola pasada.
function atributos(s) {
  const out = new Map();
  let i = 0;
  for (;;) {
    const igual = s.indexOf('=', i);
    if (igual < 0) return out;
    let j = igual + 1;
    while (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r') j++;
    const comilla = s[j];
    if (comilla !== '"' && comilla !== "'") throw malformado();
    const fin = s.indexOf(comilla, j + 1);
    if (fin < 0) throw malformado();
    const nombre = s.slice(i, igual).trim().split(/\s+/).pop();
    out.set(nombre, s.slice(j + 1, fin));
    i = fin + 1;
  }
}

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
// Sobre textos ya acotados: cada «&» mira a lo sumo unos pocos caracteres.
const xmlTexto = (s) => s.slice(0, MAX_TEXTO_CRUDO).replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/gi, (m, e) => {
  if (e[0] === '#') {
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
  }
  return ENTIDADES[e.toLowerCase()] ?? m;
});

// El texto de un <si> o un <is>: todos sus <t>, sin la guía fonética (<rPh>).
function textos(xml) {
  let partes = '';
  for (const r of elementos(xml, 'r')) {
    const t = primero(r.contenido, 't');
    if (t) partes += t.contenido;
    if (partes.length > MAX_TEXTO_CRUDO) break;
  }
  if (!partes) {
    // Sin runs: el <t> de primer nivel (el de un <rPh> va adentro de él y no cuenta).
    const sinFonetica = xml.split('<rPh')[0];
    partes = primero(sinFonetica, 't')?.contenido ?? '';
  }
  return xmlTexto(partes);
}

function columnaDe(ref) {
  const m = /^([A-Z]{1,3})/.exec(ref ?? '');
  if (!m) return null;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function leerXlsx(buf) {
  const abrir = leerZip(buf);
  const tic = reloj();
  const libro = abrir('xl/workbook.xml');
  if (!libro) throw invalido('No es un Excel (.xlsx) válido.');
  const rels = abrir('xl/_rels/workbook.xml.rels') ?? '';
  const destino = new Map();
  for (const r of elementos(rels, 'Relationship', tic)) {
    const a = atributos(r.attrs);
    destino.set(a.get('Id'), a.get('Target'));
  }
  const ruta = (t) => (t.startsWith('/') ? t.slice(1) : `xl/${t}`).replace(/\/\.\//g, '/');
  const hojas = [];
  for (const e of elementos(libro, 'sheet', tic)) {
    const a = atributos(e.attrs);
    const archivo = destino.get(a.get('r:id'));
    if (archivo) hojas.push({ nombre: xmlTexto(a.get('name') ?? '').slice(0, 120), archivo });
    if (hojas.length > 200) break;
  }
  if (!hojas.length) throw invalido('El Excel no tiene hojas.');
  let compartidos = null;
  const compartido = (i) => {
    if (!compartidos) {
      compartidos = [];
      for (const si of elementos(abrir('xl/sharedStrings.xml') ?? '', 'si', tic)) {
        compartidos.push(textos(si.contenido));
        if (compartidos.length >= MAX_COMPARTIDOS) break;
      }
    }
    return compartidos[i] ?? '';
  };
  const leerHoja = (h) => {
    const xml = abrir(ruta(h.archivo));
    if (xml === null) throw invalido(`No se pudo leer la hoja «${h.nombre}».`);
    const out = [];
    let siguiente = 1;
    for (const fila of elementos(xml, 'row', tic)) {
      const renglon = Number(atributos(fila.attrs).get('r')) || siguiente;
      siguiente = renglon + 1;
      const celdas = [];
      let col = 0;
      for (const c of elementos(fila.contenido, 'c', tic)) {
        const a = atributos(c.attrs);
        const n = columnaDe(a.get('r'));
        if (n !== null) col = n;
        if (col >= MAX_COLUMNAS) break;
        const tipo = a.get('t');
        const v = primero(c.contenido, 'v')?.contenido;
        let valor = '';
        if (tipo === 's') valor = v === undefined ? '' : compartido(Number(v));
        else if (tipo === 'inlineStr') valor = textos(primero(c.contenido, 'is')?.contenido ?? '');
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
  const uso = normalizarEncabezado(v('uso'));
  if (uso) {
    if (/^(semilla|modelo|icp|referencia)/.test(uso)) fila.uso = 'semilla';
    else if (/^(prospect|contact|escrib|lista)/.test(uso) || /^(si|s)$/.test(uso)) fila.uso = 'prospectar';
    else avisos.push(`«${v('uso').slice(0, 40)}» no es un uso (prospectar o semilla): va el de la campaña`);
  }
  // Una persona por fila (docs/26 §3.2). Sin nombre, el mail o el perfil hacen de nombre.
  const persona = {};
  const mail = v('contacto_email');
  if (mail) {
    const n = noContactar.normalizar(mail);
    if (n?.tipo === 'email') persona.email = n.valor;
    else avisos.push(`«${mail.slice(0, 60)}» no es un mail: no se carga`);
  }
  const li = v('contacto_linkedin');
  if (li) {
    try { persona.linkedin_url = normalizeLinkedin(li); } catch { avisos.push(`«${li.slice(0, 80)}» no es un perfil de LinkedIn: no se carga`); }
  }
  const tel = v('contacto_telefono');
  if (tel) {
    const t = tel.replace(/[ ().-]/g, '');
    if (/^\+?[0-9]{6,20}$/.test(t)) persona.whatsapp = t;
    else avisos.push(`«${tel.slice(0, 30)}» no es un teléfono: no se carga`);
  }
  persona.cargo = recortar(v('contacto_cargo'), 200);
  persona.nombre = recortar(v('contacto_nombre'), 200);
  if (persona.email || persona.linkedin_url) {
    persona.nombre = persona.nombre || persona.email || persona.linkedin_url.split('/in/')[1];
    fila.persona = persona;
  } else if (persona.nombre || persona.cargo || persona.whatsapp) {
    avisos.push('el contacto no tiene mail ni LinkedIn: no se carga (el prospector busca a quien decide)');
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

// ---------------------------------------------------------------- cuentas de una campaña

// Qué pasa con cada fila en una campaña (docs/26 §4.3). El uso de la fila (prospectar o semilla)
// sale de su columna o, si no la trae, de la campaña: una «Lista del cliente» prospecta; las demás
// sólo toman semillas (decisión 2). c: con el rol de la aplicación. Deja en cada fila:
//   resultado  nueva | suma_contacto (otra fila de la misma empresa) | suma_a_existente (ya estaba
//              en investigación: se le suman los contactos y la nota) | ya_en_registro (en otro
//              estado: no se toca) | ya_era_semilla | repetida (semilla repetida en el archivo)
//   persona.resultado  nueva | ya_existe | repetida | no_contactar | suprimida
export async function planCampana(c, clientId, campana, filas) {
  const esLista = campana.tipo === 'lista';
  const validas = [];
  for (const f of filas) {
    if (f.error) continue;
    f.uso = f.uso ?? (esLista ? 'prospectar' : 'semilla');
    if (f.uso === 'prospectar' && !esLista) { f.error = 'esta campaña no es una «Lista del cliente»: sólo toma semillas'; continue; }
    validas.push(f);
  }
  const ks = await noContactar.claves(c, validas.map((f) => f.empresa));
  validas.forEach((f, i) => { f.clave = ks[i]; });
  const { rows: existentes } = await c.query(
    `select k.id, k.nombre, k.dominio, k.nombre_clave, k.estado, k.uso, k.campana_id, k.tesis, cp.nombre as campana
       from sdr.cuenta k left join sdr.campana cp on cp.id = k.campana_id and cp.client_id = k.client_id
      where k.client_id = $1 and (k.dominio = any($2) or k.nombre_clave = any($3))`,
    [clientId, validas.map((f) => f.dominio).filter(Boolean), validas.map((f) => f.clave).filter(Boolean)]);
  const porDominio = new Map(existentes.filter((k) => k.dominio).map((k) => [k.dominio, k]));
  const porClave = new Map();
  for (const k of existentes) if (k.nombre_clave && !porClave.has(k.nombre_clave)) porClave.set(k.nombre_clave, k);
  const nc = await noContactar.coincidencias(c, clientId, validas.map((f) => f.dominio).filter(Boolean),
    { nombres: validas.map((f) => f.empresa) });
  const enLista = new Set(nc.map((r) => r.para));

  // Las personas: las que ya están en el registro (mismo mail o LinkedIn), en la supresión o en no contactar.
  const personas = validas.filter((f) => f.persona && f.uso === 'prospectar').map((f) => f.persona);
  const mails = personas.map((p) => p.email).filter(Boolean);
  const perfiles = personas.map((p) => p.linkedin_url).filter(Boolean);
  const { rows: yaPersonas } = await c.query(
    `select email, linkedin_url from sdr.prospecto where client_id = $1 and (email = any($2) or linkedin_url = any($3))`,
    [clientId, mails, perfiles]);
  const personaExiste = new Set([...yaPersonas.map((r) => r.email), ...yaPersonas.map((r) => r.linkedin_url)].filter(Boolean));
  const { rows: sup } = await c.query(`select email from sdr.supresion where client_id = $1 and email = any($2)`, [clientId, mails]);
  const suprimidos = new Set(sup.map((r) => r.email));
  const mailsNc = new Set((await noContactar.coincidencias(c, clientId, mails)).map((r) => r.para));

  const porLlave = new Map();
  const cuentasNuevas = [];
  const personasNuevas = [];
  const vistasPersonas = new Set();
  let orden = 0;
  for (const f of validas) {
    if (!f.clave) { f.error = 'el nombre de la empresa queda vacío sin la forma societaria'; continue; }
    const llave = f.dominio ?? `#${f.clave}`;
    const k = f.dominio ? porDominio.get(f.dominio) : porClave.get(f.clave);
    f.en_no_contactar = enLista.has(f.empresa) || Boolean(f.dominio && enLista.has(f.dominio));
    const previa = porLlave.get(llave);
    // La cuenta destino de las personas de esta fila: { nueva: fila } o { id, campana_id } o nada.
    let destino = null;
    if (previa) {
      if (f.uso === 'semilla' || previa.uso === 'semilla') f.resultado = 'repetida';
      else { f.resultado = 'suma_contacto'; destino = previa.destino; }
    } else if (k && k.uso === 'semilla' && k.campana_id === campana.id && f.uso === 'semilla') {
      f.resultado = 'ya_era_semilla';
    } else if (k && f.uso === 'prospectar' && k.estado === 'en_investigacion') {
      f.resultado = 'suma_a_existente';
      f.existente = { estado: k.estado, campana: k.campana, uso: k.uso };
      f.cuenta_id = k.id;
      destino = { id: k.id, campana_id: k.campana_id };
    } else if (k) {
      f.resultado = 'ya_en_registro';
      f.existente = { estado: k.estado, campana: k.campana, uso: k.uso };
    } else {
      f.resultado = 'nueva';
      f.prioridad = ++orden;
      cuentasNuevas.push(f);
      // Una cuenta para prospectar que está en no contactar entra excluida y sin personas.
      if (!(f.uso === 'prospectar' && f.en_no_contactar)) destino = { nueva: f };
    }
    if (!previa) porLlave.set(llave, { uso: f.uso, destino });
    const p = f.persona;
    if (p && f.uso === 'prospectar' && destino) {
      const llaves = [p.email, p.linkedin_url].filter(Boolean);
      if (llaves.some((x) => vistasPersonas.has(x))) p.resultado = 'repetida';
      else if (llaves.some((x) => personaExiste.has(x))) p.resultado = 'ya_existe';
      else if (p.email && suprimidos.has(p.email)) p.resultado = 'suprimida';
      else if (p.email && mailsNc.has(p.email)) p.resultado = 'no_contactar';
      else { p.resultado = 'nueva'; personasNuevas.push({ persona: p, destino, fila: f }); }
      llaves.forEach((x) => vistasPersonas.add(x));
    } else if (p && f.uso === 'prospectar') {
      p.resultado = f.en_no_contactar ? 'no_contactar' : 'ya_existe';
    }
  }
  return { cuentasNuevas, personasNuevas, sumarNota: validas.filter((f) => f.resultado === 'suma_a_existente' && f.nota) };
}

// Escribe lo que planCampana decidió, en la transacción de quien llama (rol de la aplicación).
// Devuelve cuántas cuentas y personas entraron de verdad (otra carga pudo ganar una fila).
export async function aplicarCampana(c, clientId, campana, plan, { loteId, motivoSemilla, motivoNoContactar }) {
  const idDe = new Map();
  const creadas = await insertarEnTandas(plan.cuentasNuevas, async (t) => {
    const { rows } = await c.query(
      `insert into sdr.cuenta (client_id, nombre, dominio, pais, vertical, tamano, tesis, estado, estado_motivo, campana_id,
                               origen, uso, lote_id, datos_origen, prioridad)
       select $1, x.nombre, x.dominio, x.pais, x.vertical, x.tamano, x.tesis, x.estado, x.estado_motivo, $2, 'archivo', x.uso, $3,
              coalesce(x.datos_origen, '{}'::jsonb), x.prioridad
         from jsonb_to_recordset($4::jsonb) as x(nombre text, dominio text, pais text, vertical text, tamano text, tesis text,
                                                 estado text, estado_motivo text, uso text, datos_origen jsonb, prioridad int)
       on conflict do nothing returning id, prioridad, uso, estado`,
      [clientId, campana.id, loteId, JSON.stringify(t.map((f) => ({
        nombre: f.empresa, dominio: f.dominio ?? null, pais: f.pais, vertical: f.vertical, tamano: f.tamano, tesis: f.nota,
        uso: f.uso, datos_origen: f.datos_origen, prioridad: f.prioridad,
        estado: f.uso === 'prospectar' && !f.en_no_contactar ? 'en_investigacion' : 'excluida',
        estado_motivo: f.uso === 'semilla' ? motivoSemilla : f.en_no_contactar ? motivoNoContactar : null,
      })))]);
    return rows;
  });
  for (const r of creadas) idDe.set(r.prioridad, r.id);
  for (const f of plan.sumarNota) {
    await c.query(`update sdr.cuenta set tesis = coalesce(tesis, $3), actualizado_at = now() where client_id = $1 and id = $2`,
      [clientId, f.cuenta_id, f.nota]);
  }
  const filasPersonas = plan.personasNuevas.map(({ persona: p, destino }) => {
    const cuentaId = destino.nueva ? idDe.get(destino.nueva.prioridad) : destino.id;
    if (!cuentaId) return null;
    return { cuenta_id: cuentaId, campana_id: destino.nueva ? campana.id : destino.campana_id, nombre: p.nombre, cargo: p.cargo,
      email: p.email ?? null, email_calidad: p.email ? 'del_cliente' : null, linkedin_url: p.linkedin_url ?? null, whatsapp: p.whatsapp ?? null };
  }).filter(Boolean);
  const personas = await insertarEnTandas(filasPersonas, async (t) => (await c.query(
    `insert into sdr.prospecto (client_id, cuenta_id, campana_id, nombre, cargo, email, email_calidad, linkedin_url, whatsapp, lote_id)
     select $1, x.cuenta_id, x.campana_id, x.nombre, x.cargo, x.email, x.email_calidad, x.linkedin_url, x.whatsapp, $2
       from jsonb_to_recordset($3::jsonb) as x(cuenta_id uuid, campana_id uuid, nombre text, cargo text, email text,
                                               email_calidad text, linkedin_url text, whatsapp text)
     on conflict do nothing returning id`, [clientId, loteId, JSON.stringify(t)])).rows);
  return {
    cuentas: creadas.length,
    prospectar: creadas.filter((r) => r.uso === 'prospectar' && r.estado === 'en_investigacion').length,
    semillas: creadas.filter((r) => r.uso === 'semilla').length,
    personas: personas.length,
  };
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
