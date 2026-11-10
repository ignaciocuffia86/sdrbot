// La lista de no contactar del cliente (docs/21 §3.3 y docs/26 §2): dominios, mails y empresas por
// nombre a los que el SDR no les escribe nunca. Este módulo normaliza lo que se carga en el panel y
// busca coincidencias; los que la hacen cumplir son el registro (cuentas y personas), el envío de
// mails, WhatsApp y la carga en Dripify.
//
// Una empresa por nombre se guarda por su clave (sdr.empresa_clave, en la base: minúsculas, sin
// tildes ni puntuación ni forma societaria) y se compara con la clave del nombre de la cuenta.

import { GatewayError } from '../errors.mjs';
import { citaNombre } from './en_campana.mjs';

export const MAX_FILAS = 5000;
const EMAIL = /^[^\s@]+@([a-z0-9-]+\.)+[a-z0-9-]{2,}$/;
const DOMINIO = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const MAX_NOMBRE = 200;

// «https://www.Empresa.com/contacto», «@empresa.com» o «Ana@Empresa.com» → lo que se guarda.
// Con { empresa: true }, lo que no parece un dominio ni un mail («Agrícola Ortiz y Cía.») es una
// empresa por nombre: vuelve { tipo: 'empresa', nombre } y la clave la calcula la base al guardarla.
// Lo que intenta ser un dominio o un mail y está mal escrito («empresa.c», «ana@») no es una empresa.
export function normalizar(entrada, { empresa = false } = {}) {
  const original = String(entrada ?? '').replace(/\s+/g, ' ').trim();
  let v = original.toLowerCase().replace(/^mailto:/, '');
  if (!v) return null;
  if (empresa && pareceNombre(v)) {
    return /[\p{L}\p{N}]/u.test(v) ? { valor: null, tipo: 'empresa', nombre: original.slice(0, MAX_NOMBRE) } : null;
  }
  if (v.includes('@') && !v.startsWith('@')) {
    v = v.replace(/^<|>$/g, '');
    return EMAIL.test(v) && v.length <= 254 ? { valor: v, tipo: 'email' } : null;
  }
  v = v.replace(/^@/, '').replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '');
  return DOMINIO.test(v) && v.length <= 253 ? { valor: v, tipo: 'dominio' } : null;
}

// Un nombre, no un intento de dominio o de mail: sin arroba, y con espacios o sin puntos.
const pareceNombre = (v) => !v.includes('@') && !/^[a-z]+:\/\//.test(v) && !v.startsWith('www.') && (/\s/.test(v) || !v.includes('.'));

// Un CSV o una lista pegada: una fila por renglón, primera columna el dominio, el mail o el nombre
// de la empresa y la segunda, opcional, el motivo. Separador coma, punto y coma o tabulación. Un
// encabezado se saltea.
export function leerCsv(texto) {
  const filas = [];
  const invalidas = [];
  const lineas = String(texto ?? '').replace(/^﻿/, '').split(/\r?\n/);
  lineas.forEach((linea, i) => {
    if (!linea.trim()) return;
    const celdas = linea.split(/[,;\t]/).map((x) => x.trim().replace(/^"(.*)"$/, '$1').trim());
    if (i === 0 && /^(dominio|e-?mail|mail|valor|domain|empresa)\b/i.test(celdas[0]) && !normalizar(celdas[0])) return;
    const n = normalizar(celdas[0], { empresa: true });
    if (!n) {
      invalidas.push({ renglon: i + 1, texto: linea.slice(0, 120) });
      return;
    }
    const motivo = celdas.slice(1).join(', ').trim().slice(0, 200) || null;
    filas.push({ ...n, motivo, renglon: i + 1 });
  });
  if (filas.length > MAX_FILAS) {
    throw new GatewayError('invalid_request', `La lista tiene ${filas.length} filas; el máximo por carga es ${MAX_FILAS}.`, 400);
  }
  return { filas, invalidas };
}

// Qué chocan con la lista. valores: mails o dominios; un dominio de la lista cubre también sus
// subdominios («empresa.com» frena a «ana@ventas.empresa.com»). Las empresas por nombre se comparan
// con las cuentas: las de `cuentas` (ids), las que tienen uno de esos dominios y las de las personas
// con uno de esos mails; y con los `nombres` sueltos (una cuenta que todavía no se guardó).
export async function coincidencias(c, clientId, valores, { cuentas = [], nombres = [] } = {}) {
  const lista = [...new Set((valores ?? []).filter(Boolean).map((x) => String(x).trim().toLowerCase()))];
  const ids = [...new Set((cuentas ?? []).filter(Boolean))];
  const sueltos = [...new Set((nombres ?? []).filter(Boolean).map(String))];
  if (!lista.length && !ids.length && !sueltos.length) return [];
  const { rows } = await c.query(
    `with x(v, d) as (
       select v, case when position('@' in v) > 0 then split_part(v, '@', 2) else v end from unnest($2::text[]) as v),
     k as (
       select nombre, nombre_clave from sdr.cuenta
        where client_id = $1 and nombre_clave is not null
          and (id = any($3::uuid[]) or dominio in (select d from x)
            or id in (select p.cuenta_id from sdr.prospecto p where p.client_id = $1 and p.email in (select v from x where position('@' in v) > 0)))),
     s(nombre, clave) as (select n, sdr.empresa_clave(n) from unnest($4::text[]) as n)
     select x.v as para, n.valor, n.tipo, n.motivo, n.nombre
       from x join sdr.no_contactar n on n.client_id = $1
        and ((n.tipo = 'email' and n.valor = x.v)
          or (n.tipo = 'dominio' and (x.d = n.valor or x.d like '%.' || n.valor)))
     union all
     select k.nombre, n.valor, n.tipo, n.motivo, n.nombre
       from k join sdr.no_contactar n on n.client_id = $1 and n.tipo = 'empresa' and n.valor = k.nombre_clave
     union all
     select s.nombre, n.valor, n.tipo, n.motivo, n.nombre
       from s join sdr.no_contactar n on n.client_id = $1 and n.tipo = 'empresa' and n.valor = s.clave`,
    [clientId, lista, ids, sueltos]);
  return rows;
}

// El nombre y el motivo los escribió el cliente: van citados, para que el bot los lea como datos
// (llegan a errores, a estado_motivo y a los avisos).
const TIPO = { dominio: (r) => `dominio ${r.valor}`, email: () => 'mail', empresa: (r) => `empresa ${citaNombre(r.nombre ?? r.valor)}` };
export const describirUna = (r) => `${(TIPO[r.tipo] ?? TIPO.email)(r)}${r.motivo ? `: ${citaNombre(r.motivo)}` : ''}`;
export const describir = (rows) => [...new Set(rows.map((r) => `${r.tipo === 'empresa' ? citaNombre(r.para) : r.para} (${describirUna(r)})`))].join(', ');

// Las claves que la base le da a unos nombres (null si no queda nada: «S.A.», «---»).
export async function claves(c, nombres) {
  if (!nombres.length) return [];
  const { rows } = await c.query(`select sdr.empresa_clave(n) as clave from unnest($1::text[]) with ordinality as t(n, i) order by i`, [nombres]);
  return rows.map((r) => r.clave);
}

// Las filas de leerCsv (o de una carga) listas para guardar: las empresas con su clave; las que
// se quedan sin clave pasan a inválidas.
export async function conClaves(c, filas, invalidas = []) {
  const empresas = filas.filter((f) => f.tipo === 'empresa');
  const ks = await claves(c, empresas.map((f) => f.nombre));
  empresas.forEach((f, i) => { f.valor = ks[i]; });
  const malas = empresas.filter((f) => !f.valor);
  return {
    filas: filas.filter((f) => f.valor),
    invalidas: [...invalidas, ...malas.map((f) => ({ renglon: f.renglon ?? null, texto: f.nombre.slice(0, 120) }))],
  };
}

export async function contar(c, clientId) {
  const { rows } = await c.query(
    `select count(*) filter (where tipo = 'dominio')::int as dominios, count(*) filter (where tipo = 'email')::int as emails,
            count(*) filter (where tipo = 'empresa')::int as empresas
       from sdr.no_contactar where client_id = $1`, [clientId]);
  return rows[0];
}
