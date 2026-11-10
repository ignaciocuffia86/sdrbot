// La lista de no contactar del cliente (docs/21 §3.3): dominios y mails a los que el SDR no les
// escribe nunca. Este módulo normaliza lo que se carga en el panel y busca coincidencias; los que
// la hacen cumplir son el registro (cuentas y personas), el envío de mails y la carga en Dripify.

import { GatewayError } from '../errors.mjs';

export const MAX_FILAS = 5000;
const EMAIL = /^[^\s@]+@([a-z0-9-]+\.)+[a-z0-9-]{2,}$/;
const DOMINIO = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// «https://www.Empresa.com/contacto», «@empresa.com» o «Ana@Empresa.com» → lo que se guarda.
export function normalizar(entrada) {
  let v = String(entrada ?? '').trim().toLowerCase().replace(/^mailto:/, '');
  if (!v) return null;
  if (v.includes('@') && !v.startsWith('@')) {
    v = v.replace(/^<|>$/g, '');
    return EMAIL.test(v) && v.length <= 254 ? { valor: v, tipo: 'email' } : null;
  }
  v = v.replace(/^@/, '').replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^www\./, '').replace(/\.$/, '');
  return DOMINIO.test(v) && v.length <= 253 ? { valor: v, tipo: 'dominio' } : null;
}

// Un CSV o una lista pegada: una fila por renglón, primera columna el dominio o el mail y la
// segunda, opcional, el motivo. Separador coma, punto y coma o tabulación. Un encabezado se saltea.
export function leerCsv(texto) {
  const filas = [];
  const invalidas = [];
  const lineas = String(texto ?? '').replace(/^﻿/, '').split(/\r?\n/);
  lineas.forEach((linea, i) => {
    if (!linea.trim()) return;
    const celdas = linea.split(/[,;\t]/).map((x) => x.trim().replace(/^"(.*)"$/, '$1').trim());
    const n = normalizar(celdas[0]);
    if (!n) {
      if (i === 0 && /^(dominio|email|mail|valor|domain)/i.test(celdas[0])) return;
      invalidas.push({ renglon: i + 1, texto: linea.slice(0, 120) });
      return;
    }
    const motivo = celdas.slice(1).join(', ').trim().slice(0, 200) || null;
    filas.push({ ...n, motivo });
  });
  if (filas.length > MAX_FILAS) {
    throw new GatewayError('invalid_request', `La lista tiene ${filas.length} filas; el máximo por carga es ${MAX_FILAS}.`, 400);
  }
  return { filas, invalidas };
}

// Qué valores (mails o dominios) y qué nombres de empresa chocan con la lista. Un dominio de la
// lista cubre también sus subdominios: «empresa.com» frena a «ana@ventas.empresa.com». Una empresa
// de la lista (tipo «empresa», cargada sin dominio) se compara por nombre normalizado
// (sdr.norm_empresa): «Agrosuper S.A.» choca con «AGROSUPER».
export async function coincidencias(c, clientId, valores, nombres = []) {
  const lista = [...new Set((valores ?? []).filter(Boolean).map((x) => String(x).trim().toLowerCase()))];
  const noms = [...new Set((nombres ?? []).filter(Boolean).map((x) => String(x).trim()).filter(Boolean))];
  if (!lista.length && !noms.length) return [];
  const { rows } = await c.query(
    `with x(v, d) as (
       select v, case when position('@' in v) > 0 then split_part(v, '@', 2) else v end from unnest($2::text[]) as v)
     select x.v as para, n.valor, n.tipo, n.motivo
       from x join sdr.no_contactar n on n.client_id = $1
        and ((n.tipo = 'email' and n.valor = x.v)
          or (n.tipo = 'dominio' and (x.d = n.valor or x.d like '%.' || n.valor)))
     union all
     select nom as para, n.valor, n.tipo, n.motivo
       from unnest($3::text[]) as nom
       join sdr.no_contactar n on n.client_id = $1 and n.tipo = 'empresa' and n.valor = sdr.norm_empresa(nom)`,
    [clientId, lista, noms]);
  return rows;
}

// Lo de una persona del registro: su mail, y el dominio y el nombre de su cuenta.
export async function deProspecto(c, clientId, p) {
  const k = p.cuenta_id
    ? (await c.query(`select dominio, nombre from sdr.cuenta where client_id = $1 and id = $2`, [clientId, p.cuenta_id])).rows[0]
    : null;
  return coincidencias(c, clientId, [p.email, k?.dominio], [k?.nombre]);
}

const COMO = { dominio: (v) => `dominio ${v}`, email: () => 'mail', empresa: (v) => `empresa «${v}»` };
export const describir = (rows) => [...new Set(rows.map((r) => `${r.para} (${(COMO[r.tipo] ?? COMO.email)(r.valor)}` +
  `${r.motivo ? `: ${r.motivo}` : ''})`))].join(', ');

export async function contar(c, clientId) {
  const { rows } = await c.query(
    `select count(*) filter (where tipo = 'dominio')::int as dominios, count(*) filter (where tipo = 'email')::int as emails
       from sdr.no_contactar where client_id = $1 and tipo <> 'empresa'`, [clientId]);
  const { rows: e } = await c.query(`select count(*)::int as n from sdr.no_contactar where client_id = $1 and tipo = 'empresa'`, [clientId]);
  return { ...rows[0], empresas: e[0].n };
}
