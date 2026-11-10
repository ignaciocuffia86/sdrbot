// Carga de cuentas por archivo, etapa 1 (docs/26 §9): un Excel (.xlsx) o un CSV que el cliente o
// Biguá suben en el panel. Cada fila hace una de dos cosas:
//   - no_contactar: va a la lista de siempre (sdr.no_contactar), por dominio, por nombre de empresa
//     (tipo «empresa», para los referidos sin sitio web) y por el mail del contacto si es de otro
//     dominio. El gateway ya la hace cumplir en el registro, el correo, Dripify y WhatsApp.
//   - semilla: sólo Biguá. Una cuenta excluida en el registro, con su perfil, para la campaña por
//     ICP (docs/27 §3.2). Nadie le escribe.
// Las filas «prospectar» llegan en la etapa 2: se cuentan y no se cargan.
//
// Sin estado entre la vista previa y la aplicación: el panel manda el archivo las dos veces y acá
// se vuelve a leer. El archivo no se guarda; del lote queda sólo el resumen con conteos.
//
// El archivo es contenido del cliente: se lee como datos (los valores guardados de las celdas, nunca
// fórmulas), con topes de tamaño, y lo que se guarda va como texto.

import zlib from 'node:zlib';
import { GatewayError } from '../errors.mjs';
import * as noContactar from './no_contactar.mjs';

export const MAX_BYTES = 600 * 1024;          // el archivo, antes de base64 (el cuerpo JSON tope es 1 MB)
export const MAX_FILAS = 2000;
const MAX_DESCOMPRIMIDO = 40 * 1024 * 1024;   // por parte del .xlsx: corta un zip bomba
const MAX_CELDA = 500;
const MAX_EXTRA = 2048;                       // bytes de columnas sin mapear que se guardan por semilla

const invalido = (msg) => new GatewayError('invalid_request', msg, 400);

// ---------------------------------------------------------------- leer el archivo

// Devuelve { hojas: [nombres], hoja, filas: [[celdas]] } con la primera fila como encabezado.
export function leerArchivo({ nombre, contenido_base64: b64 }, { hoja } = {}) {
  const buf = Buffer.from(String(b64 ?? ''), 'base64');
  if (!buf.length) throw invalido('El archivo está vacío.');
  if (buf.length > MAX_BYTES) throw invalido(`El archivo pesa ${Math.round(buf.length / 1024)} KB y el tope es ${MAX_BYTES / 1024} KB: partilo en dos.`);
  const esZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  if (esZip) return leerXlsx(buf, hoja);
  if (/\.xls$/i.test(nombre ?? '')) throw invalido('El formato .xls (Excel 97-2003) no se lee: guardalo como .xlsx o como CSV.');
  return { hojas: [], hoja: null, filas: leerCsv(texto(buf)) };
}

// UTF-8 si lo es; si no, Latin-1 (el CSV que exporta Excel en español).
function texto(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); } catch { return buf.toString('latin1'); }
}

// CSV con comillas («"Agrosuper, S.A."»), separador coma, punto y coma o tabulación (el que más
// aparezca en el encabezado) y saltos de línea dentro de una celda entre comillas.
export function leerCsv(t) {
  const primera = t.split(/\r?\n/, 1)[0] ?? '';
  const sep = [',', ';', '\t'].map((s) => [s, primera.split(s).length]).sort((a, b) => b[1] - a[1])[0][0];
  const filas = [];
  let fila = [];
  let celda = '';
  let comillas = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (comillas) {
      if (ch === '"' && t[i + 1] === '"') { celda += '"'; i++; } else if (ch === '"') comillas = false; else celda += ch;
    } else if (ch === '"' && !celda.trim()) { comillas = true; celda = ''; } else if (ch === sep) { fila.push(celda); celda = ''; } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && t[i + 1] === '\n') i++;
      fila.push(celda); filas.push(fila); fila = []; celda = '';
    } else celda += ch;
    if (filas.length > MAX_FILAS + 1) break;
  }
  if (celda || fila.length) { fila.push(celda); filas.push(fila); }
  return filas.map((f) => f.map((x) => x.trim()));
}

// --- .xlsx: un zip con XML. Se leen el libro, las cadenas compartidas y una hoja.

function partesZip(buf) {
  // El directorio central, desde el registro de fin (los últimos 64 KB como mucho).
  let fin = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { fin = i; break; }
  }
  if (fin < 0) throw invalido('El archivo no es un Excel válido (.xlsx).');
  const n = buf.readUInt16LE(fin + 10);
  let p = buf.readUInt32LE(fin + 16);
  const partes = new Map();
  for (let k = 0; k < n && p + 46 <= buf.length; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const metodo = buf.readUInt16LE(p + 10);
    const comprimido = buf.readUInt32LE(p + 20);
    const largoNombre = buf.readUInt16LE(p + 28);
    const largoExtra = buf.readUInt16LE(p + 30);
    const largoComentario = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const nombre = buf.subarray(p + 46, p + 46 + largoNombre).toString('utf8');
    partes.set(nombre, { metodo, comprimido, local });
    p += 46 + largoNombre + largoExtra + largoComentario;
  }
  return (nombre) => {
    const e = partes.get(nombre);
    if (!e) return null;
    if (e.local + 30 > buf.length || buf.readUInt32LE(e.local) !== 0x04034b50) throw invalido('El Excel está dañado.');
    const ini = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    const datos = buf.subarray(ini, ini + e.comprimido);
    if (e.metodo === 0) return datos.toString('utf8');
    if (e.metodo !== 8) throw invalido('El Excel usa una compresión que no se lee: guardalo de nuevo como .xlsx o como CSV.');
    try {
      return zlib.inflateRawSync(datos, { maxOutputLength: MAX_DESCOMPRIMIDO }).toString('utf8');
    } catch {
      throw invalido('El Excel está dañado o es demasiado grande.');
    }
  };
}

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const xmlTexto = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') {
    const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : '';
  }
  return ENTIDADES[e] ?? m;
});
const textosDe = (xml) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => xmlTexto(m[1])).join('');
const columna = (ref) => {
  const letras = /^[A-Z]+/.exec(ref ?? '')?.[0] ?? '';
  let n = 0;
  for (const ch of letras) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

function leerXlsx(buf, hojaPedida) {
  const parte = partesZip(buf);
  const libro = parte('xl/workbook.xml');
  if (!libro) throw invalido('El archivo no es un Excel válido (.xlsx).');
  const rels = parte('xl/_rels/workbook.xml.rels') ?? '';
  const destino = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
    /\bId="([^"]+)"/.exec(m[0])?.[1], /\bTarget="([^"]+)"/.exec(m[0])?.[1]]));
  const hojas = [...libro.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
    nombre: xmlTexto(/\bname="([^"]*)"/.exec(m[0])?.[1] ?? ''),
    rid: /\br:id="([^"]+)"/.exec(m[0])?.[1] ?? /\bid="([^"]+)"/.exec(m[0])?.[1],
  }));
  if (!hojas.length) throw invalido('El Excel no tiene hojas.');
  const elegida = hojaPedida ? hojas.find((x) => x.nombre === hojaPedida) : hojas[0];
  if (!elegida) throw invalido(`El Excel no tiene una hoja «${String(hojaPedida).slice(0, 60)}».`);
  let ruta = destino.get(elegida.rid) ?? 'worksheets/sheet1.xml';
  ruta = ruta.startsWith('/') ? ruta.slice(1) : `xl/${ruta.replace(/^\.\//, '')}`;
  const xml = parte(ruta);
  if (!xml) throw invalido('No se encontró la hoja dentro del Excel.');
  const compartidas = [...(parte('xl/sharedStrings.xml') ?? '').matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => textosDe(m[1]));
  const filas = [];
  for (const m of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const fila = [];
    for (const c of (m[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const cuerpo = c[2] ?? '';
      const tipo = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(cuerpo)?.[1];
      let valor = '';
      if (tipo === 's') valor = compartidas[Number(v)] ?? '';
      else if (tipo === 'inlineStr') valor = textosDe(cuerpo);
      else if (tipo === 'b') valor = v === '1' ? 'sí' : 'no';
      else if (v !== undefined) valor = xmlTexto(v);
      const i = columna(/\br="([A-Z]+\d+)"/.exec(attrs)?.[1]);
      fila[i >= 0 ? i : fila.length] = valor.trim();
    }
    filas.push(Array.from(fila, (x) => x ?? ''));
    if (filas.length > MAX_FILAS + 1) break;
  }
  return { hojas: hojas.map((x) => x.nombre), hoja: elegida.nombre, filas };
}

// ---------------------------------------------------------------- columnas

// Los campos que entiende la carga y los encabezados con que suelen venir (sin acentos, minúsculas).
export const CAMPOS = {
  empresa: { titulo: 'Empresa', sinonimos: ['empresa', 'razon social', 'compania', 'company', 'cuenta', 'cliente', 'nombre empresa', 'organizacion', 'exportador', 'exportadora'] },
  dominio: { titulo: 'Sitio web o dominio', sinonimos: ['dominio', 'web', 'sitio', 'sitio web', 'website', 'url', 'pagina', 'pagina web', 'domain'] },
  uso: { titulo: 'Uso', sinonimos: ['uso', 'tipo', 'accion', 'categoria'] },
  motivo: { titulo: 'Motivo', sinonimos: ['motivo', 'razon', 'observacion', 'observaciones', 'comentario', 'comentarios', 'relacion'] },
  pais: { titulo: 'País', sinonimos: ['pais', 'country'] },
  vertical: { titulo: 'Rubro', sinonimos: ['rubro', 'vertical', 'industria', 'sector', 'industry'] },
  tamano: { titulo: 'Tamaño', sinonimos: ['tamano', 'empleados', 'dotacion', 'size', 'employees'] },
  rut: { titulo: 'RUT o identificador fiscal', sinonimos: ['rut', 'cuit', 'ruc', 'nit', 'rfc', 'tax id'] },
  nota: { titulo: 'Nota para el bot', sinonimos: ['nota', 'notas', 'por que', 'tesis'] },
  contacto_email: { titulo: 'Mail del contacto', sinonimos: ['mail', 'email', 'correo', 'e mail', 'mail contacto', 'email contacto', 'correo electronico'] },
};

const sinAcentos = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// campo → índice de columna, por los encabezados. Lo que mande el usuario gana.
export function proponerMapeo(encabezados, dado = {}) {
  const norm = encabezados.map(sinAcentos);
  const mapeo = {};
  const usadas = new Set();
  for (const [campo, def] of Object.entries(CAMPOS)) {
    if (campo in dado) continue;
    const i = norm.findIndex((h, j) => !usadas.has(j) && def.sinonimos.includes(h));
    const j = i >= 0 ? i : norm.findIndex((h, k) => !usadas.has(k) && def.sinonimos.some((s) => s.length > 3 && h.includes(s)));
    if (j >= 0) { mapeo[campo] = encabezados[j]; usadas.add(j); }
  }
  for (const [campo, h] of Object.entries(dado)) {
    if (!(campo in CAMPOS)) throw invalido(`No existe el campo «${String(campo).slice(0, 40)}».`);
    if (h === null || h === '') continue;
    if (!encabezados.includes(h)) throw invalido(`El archivo no tiene la columna «${String(h).slice(0, 80)}».`);
    mapeo[campo] = h;
  }
  return mapeo;
}

// ---------------------------------------------------------------- filas

const USOS = {
  no_contactar: ['no contactar', 'no_contactar', 'nocontactar', 'excluir', 'excluida', 'exclusion', 'manual', 'referido', 'referida',
    'cliente', 'cliente actual', 'conocido', 'partner', 'competidor', 'no'],
  semilla: ['semilla', 'modelo', 'como esta', 'icp'],
  prospectar: ['prospectar', 'prospeccion', 'contactar', 'si', 'objetivo'],
};
const usoDe = (celda) => {
  const v = sinAcentos(celda);
  if (!v) return null;
  for (const [uso, palabras] of Object.entries(USOS)) if (palabras.includes(v)) return uso;
  return 'desconocido';
};

// Lo que empieza como una fórmula en una planilla no se guarda así: si se exporta, no se ejecuta.
const texto1 = (v, max = MAX_CELDA) => {
  const t = String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  return /^[=+\-@]/.test(t) ? `'${t}` : t;
};

function dominioDe(celda) {
  const n = noContactar.normalizar(celda);
  if (!n) return null;
  return n.tipo === 'dominio' ? n.valor : n.valor.split('@')[1];
}

// Cada fila del archivo, ya interpretada: { renglon, uso, empresa, dominio, email, motivo, ..., error }.
export function interpretar(filas, mapeo, usoDefecto) {
  const [enc = [], ...datos] = filas;
  if (datos.length > MAX_FILAS) throw invalido(`El archivo tiene ${datos.length} filas y el tope es ${MAX_FILAS}: partilo en dos.`);
  const idx = Object.fromEntries(Object.entries(mapeo).map(([k, h]) => [k, enc.indexOf(h)]));
  const mapeadas = new Set(Object.values(idx));
  const out = [];
  datos.forEach((f, i) => {
    const celda = (k) => (idx[k] >= 0 ? String(f[idx[k]] ?? '').trim() : '');
    if (!f.some((x) => String(x ?? '').trim())) return;
    const r = { renglon: i + 2 };
    const usoCelda = celda('uso');
    r.uso = usoDe(usoCelda) ?? usoDefecto;
    r.empresa = texto1(celda('empresa'), 200);
    const web = celda('dominio');
    r.dominio = web ? dominioDe(web) : null;
    const mail = celda('contacto_email');
    const nm = mail ? noContactar.normalizar(mail) : null;
    r.email = nm?.tipo === 'email' ? nm.valor : null;
    // «referido» o «cliente» en la columna de uso, sin motivo: ese es el motivo.
    r.motivo = texto1(celda('motivo') || (r.uso === 'no_contactar' && usoCelda && !['no contactar', 'no_contactar', 'excluir', 'no'].includes(sinAcentos(usoCelda)) ? usoCelda : ''), 200) || null;
    for (const k of ['pais', 'vertical', 'tamano', 'rut', 'nota']) r[k] = texto1(celda(k), k === 'nota' ? 300 : 120) || null;
    if (r.uso === 'desconocido') r.error = `el uso «${texto1(usoCelda, 40)}» no se entiende (no contactar, semilla o prospectar)`;
    else if (web && !r.dominio) r.error = `«${texto1(web, 60)}» no es un sitio web ni un dominio`;
    else if (mail && !r.email) r.error = `«${texto1(mail, 60)}» no es un mail`;
    else if (!r.empresa && !r.dominio && !r.email) r.error = 'no tiene empresa, dominio ni mail';
    if (r.uso === 'semilla' && !r.error && !r.empresa) r.error = 'una semilla necesita el nombre de la empresa';
    // Lo que no se mapeó queda con la semilla, como dato del cliente.
    if (r.uso === 'semilla') {
      const extra = {};
      let peso = 0;
      enc.forEach((h, j) => {
        const v = texto1(f[j], 200);
        if (mapeadas.has(j) || !v || !h) return;
        peso += h.length + v.length;
        if (peso <= MAX_EXTRA) extra[texto1(h, 60)] = v;
      });
      r.extra = extra;
    }
    out.push(r);
  });
  return out;
}

// ---------------------------------------------------------------- vista previa y aplicación

// Lo que haría la carga, sin escribir nada. c: la conexión del panel (dueño o mailgw_portal).
// esBigua: sólo Biguá carga semillas (el rol del cliente no escribe el registro).
export async function planificar(c, clientId, filasInterpretadas, { esBigua }) {
  const plan = { no_contactar: [], semillas: [], salteadas: [], invalidas: [] };
  for (const r of filasInterpretadas) {
    if (r.error) { plan.invalidas.push({ renglon: r.renglon, motivo: r.error }); continue; }
    if (r.uso === 'prospectar') { plan.salteadas.push({ renglon: r.renglon, motivo: 'prospectar llega en la etapa 2: esta fila no se carga' }); continue; }
    if (r.uso === 'semilla' && !esBigua) { plan.salteadas.push({ renglon: r.renglon, motivo: 'las semillas las carga Biguá' }); continue; }
    if (r.uso === 'semilla') { plan.semillas.push(r); continue; }
    // No contactar: la empresa por dominio y por nombre, y el mail del contacto si es de otro dominio.
    const valores = [];
    if (r.dominio) valores.push({ valor: r.dominio, tipo: 'dominio' });
    if (r.empresa) valores.push({ nombre: r.empresa, tipo: 'empresa' });
    if (r.email && r.email.split('@')[1] !== r.dominio) valores.push({ valor: r.email, tipo: 'email' });
    for (const v of valores) plan.no_contactar.push({ ...v, motivo: r.motivo, renglon: r.renglon });
  }
  // Los nombres, normalizados como los guarda la base. Un nombre que normalizado queda en menos de
  // tres letras («3M» sí, «SA» no) no se puede cargar como empresa.
  const nombres = plan.no_contactar.filter((x) => x.tipo === 'empresa');
  if (nombres.length) {
    const { rows } = await c.query(`select sdr.norm_empresa(x) as n from unnest($1::text[]) with ordinality as t(x, i) order by i`,
      [nombres.map((x) => x.nombre)]);
    nombres.forEach((x, i) => { x.valor = rows[i].n; });
  }
  plan.no_contactar = plan.no_contactar.filter((x) => {
    if (x.valor && x.valor.length >= 3) return true;
    // Una fila que sólo traía ese nombre queda sin nada que excluir: se informa.
    if (!plan.no_contactar.some((y) => y.renglon === x.renglon && y !== x)) {
      plan.invalidas.push({ renglon: x.renglon, motivo: `el nombre «${x.nombre}» no alcanza para reconocer la empresa` });
    }
    return false;
  });
  // Una sola vez cada valor (la primera fila manda el motivo).
  const vistos = new Map();
  for (const x of plan.no_contactar) if (!vistos.has(x.valor)) vistos.set(x.valor, x);
  plan.no_contactar = [...vistos.values()];
  const { rows: ya } = await c.query(`select valor from sdr.no_contactar where client_id = $1 and valor = any($2)`,
    [clientId, plan.no_contactar.map((x) => x.valor)]);
  const yaEstan = new Set(ya.map((r) => r.valor));
  for (const x of plan.no_contactar) x.ya_estaba = yaEstan.has(x.valor);

  if (plan.semillas.length) {
    const { rows: norm } = await c.query(`select sdr.norm_empresa(x) as n from unnest($1::text[]) with ordinality as t(x, i) order by i`,
      [plan.semillas.map((r) => r.empresa)]);
    plan.semillas = plan.semillas.filter((r, i) => {
      if ((norm[i].n ?? '').length >= 3) return true;
      plan.invalidas.push({ renglon: r.renglon, motivo: `el nombre «${r.empresa}» no alcanza para reconocer la empresa` });
      return false;
    });
  }
  if (plan.semillas.length) {
    const { rows } = await c.query(
      `select s.i, k.id, k.nombre, k.estado, k.uso
         from unnest($2::text[], $3::text[]) with ordinality as s(nombre, dominio, i)
         join sdr.cuenta k on k.client_id = $1
          and ((s.dominio is not null and k.dominio = s.dominio) or sdr.norm_empresa(k.nombre) = sdr.norm_empresa(s.nombre))`,
      [clientId, plan.semillas.map((r) => r.empresa), plan.semillas.map((r) => r.dominio)]);
    const porFila = new Map(rows.map((r) => [Number(r.i) - 1, r]));
    plan.semillas.forEach((r, i) => { if (porFila.has(i)) r.ya_estaba = { estado: porFila.get(i).estado, uso: porFila.get(i).uso }; });
    const vistas = new Set();
    plan.semillas = plan.semillas.filter((r) => {
      const k = r.dominio ?? r.empresa.toLowerCase();
      if (vistas.has(k)) return false;
      vistas.add(k);
      return true;
    });
  }
  return plan;
}

export function resumen(plan) {
  const nc = plan.no_contactar;
  const cuenta = (tipo) => nc.filter((x) => x.tipo === tipo && !x.ya_estaba).length;
  return {
    no_contactar: { nuevas: nc.filter((x) => !x.ya_estaba).length, ya_estaban: nc.filter((x) => x.ya_estaba).length,
      dominios: cuenta('dominio'), empresas: cuenta('empresa'), mails: cuenta('email') },
    semillas: { nuevas: plan.semillas.filter((r) => !r.ya_estaba).length, ya_estaban: plan.semillas.filter((r) => r.ya_estaba).length },
    salteadas: plan.salteadas.length,
    invalidas: plan.invalidas.length,
  };
}

// Escribe el plan: el lote, la lista y las semillas. Dentro de la transacción de quien llama.
export async function aplicar(c, clientId, plan, { archivo, usoDefecto, mapeo, porEmail }) {
  const res = resumen(plan);
  const { rows: [lote] } = await c.query(
    `insert into sdr.lote_carga (client_id, archivo, uso_defecto, mapeo, resumen, por_email)
     values ($1, $2, $3, $4, $5, $6) returning id, creado_at`,
    [clientId, texto1(archivo || 'archivo', 200) || 'archivo', usoDefecto, JSON.stringify(mapeo), JSON.stringify(res), porEmail ?? null]);
  const nuevas = plan.no_contactar.filter((x) => !x.ya_estaba);
  let agregadas = 0;
  if (nuevas.length) {
    const { rowCount } = await c.query(
      `insert into sdr.no_contactar (client_id, valor, tipo, motivo, por_email, lote_id)
       select $1, f.valor, f.tipo, f.motivo, $5, $6 from unnest($2::text[], $3::text[], $4::text[]) as f(valor, tipo, motivo)
       on conflict (client_id, valor) do nothing`,
      [clientId, nuevas.map((x) => x.valor), nuevas.map((x) => x.tipo), nuevas.map((x) => x.motivo), porEmail ?? null, lote.id]);
    agregadas = rowCount;
  }
  let semillas = 0;
  for (const r of plan.semillas.filter((x) => !x.ya_estaba)) {
    const datos = { ...(r.rut ? { rut: r.rut } : {}), ...(r.nota ? { nota: r.nota } : {}), ...(Object.keys(r.extra ?? {}).length ? { columnas: r.extra } : {}) };
    const { rowCount } = await c.query(
      `insert into sdr.cuenta (client_id, nombre, dominio, pais, vertical, tamano, estado, estado_motivo, origen, uso, lote_id, datos_origen)
       values ($1, $2, $3, $4, $5, $6, 'excluida', 'Semilla del ICP: cargada por archivo, no se le escribe', 'archivo', 'semilla', $7, $8)
       on conflict do nothing`,
      [clientId, r.empresa, r.dominio, r.pais, r.vertical, r.tamano, lote.id, JSON.stringify(datos)]);
    semillas += rowCount;
  }
  return { lote_id: lote.id, creado_at: lote.creado_at, agregadas, semillas, resumen: res };
}

// Para mostrar: las primeras filas de cada cosa, sin todo el contenido.
export function muestra(plan, n = 50) {
  return {
    no_contactar: plan.no_contactar.slice(0, n).map((x) => ({ renglon: x.renglon, valor: x.valor, tipo: x.tipo, motivo: x.motivo, ya_estaba: x.ya_estaba })),
    semillas: plan.semillas.slice(0, n).map((r) => ({ renglon: r.renglon, empresa: r.empresa, dominio: r.dominio, pais: r.pais, vertical: r.vertical, ya_estaba: r.ya_estaba ?? null })),
    salteadas: plan.salteadas.slice(0, n),
    invalidas: plan.invalidas.slice(0, n),
  };
}
