// Los ajustes de un cliente que se editan en el panel: qué campos hay, quién puede tocar cada
// uno y cómo se validan. Lo que se guarda acá aparece en la sección «Ajustes de este cliente» de
// las reglas de todos los bots desde su próxima corrida.

import { GatewayError } from '../errors.mjs';

// cliente: true = lo edita el usuario del cliente; false = sólo un operador de Biguá.
export const CAMPOS = [
  { clave: 'nombre_comercial', titulo: 'Nombre comercial', tipo: 'texto', max: 120, cliente: true,
    ayuda: 'Cómo se presenta la empresa en los mails.' },
  { clave: 'oferta', titulo: 'Oferta', tipo: 'parrafo', max: 1500, cliente: true,
    ayuda: 'Qué ofrecen y para qué sirve, en dos o tres líneas. Sin precios, plazos ni resultados que no estén confirmados: los bots no los inventan, pero repiten lo que diga acá.' },
  { clave: 'icp', titulo: 'A quién le venden', tipo: 'parrafo', max: 1500, cliente: true,
    ayuda: 'País, industrias, tamaño y las señales que importan (por ejemplo, avisos de empleo abiertos).' },
  { clave: 'roles_objetivo', titulo: 'Cargos a los que se escribe', tipo: 'lista', max: 120, maxItems: 25, cliente: true,
    ayuda: 'Uno por línea. Es la elección de a quién revelar en ASCI.' },
  { clave: 'excluir', titulo: 'A quién no escribirle', tipo: 'lista', max: 300, maxItems: 25, cliente: true,
    ayuda: 'Uno por línea: tipos de empresa, competidores, cargos.' },
  { clave: 'tono', titulo: 'Tono', tipo: 'parrafo', max: 600, cliente: true,
    ayuda: 'Cómo escriben: formal o cercano, técnico o comercial, qué evitar.' },
  { clave: 'idioma', titulo: 'Idioma y trato', tipo: 'texto', max: 200, cliente: true,
    ayuda: 'Por ejemplo: español, de vos en Argentina y de usted en Chile.' },
  { clave: 'firma', titulo: 'Firma', tipo: 'parrafo', max: 400, cliente: true,
    ayuda: 'Tal como va al pie de cada mail.' },
  { clave: 'objeciones', titulo: 'Objeciones y cómo responderlas', tipo: 'lista', max: 600, maxItems: 20, cliente: true,
    ayuda: 'Una por línea: «lo que dicen»: cómo se responde.' },
  { clave: 'positivos', titulo: 'Qué cuenta como respuesta positiva', tipo: 'lista', max: 120, maxItems: 15, cliente: true,
    ayuda: 'Uno por línea. Una respuesta positiva se contesta sólo con aprobación del operador.' },
  { clave: 'buzones', titulo: 'Qué buzón usar para qué', tipo: 'parrafo', max: 600, cliente: false,
    ayuda: 'Por ejemplo: «ventas@ para Argentina, info@ para Chile».' },
  { clave: 'cuentas_por_dia', titulo: 'Cuentas nuevas por día', tipo: 'numero', min: 0, max: 100, cliente: false,
    ayuda: 'Lo que el orquestador le pide al prospector cada día.' },
  { clave: 'dias_aviso', titulo: 'Antigüedad máxima del aviso (días)', tipo: 'numero', min: 3, max: 60, cliente: false,
    ayuda: 'Sólo se prospecta una cuenta con un aviso publicado en estos últimos días. Vacío: 14.' },
  { clave: 'acepta_mails_extrapolados', titulo: 'Acepta mails extrapolados', tipo: 'si_no', cliente: false,
    ayuda: 'Si se le escribe a un mail deducido del patrón de la empresa y no verificado.' },
];
const POR_CLAVE = new Map(CAMPOS.map((c) => [c.clave, c]));

const invalido = (msg) => new GatewayError('invalid_request', msg, 400);

function limpiarValor(c, v) {
  if (v === null || v === undefined) return undefined;
  switch (c.tipo) {
    case 'texto':
    case 'parrafo': {
      if (typeof v !== 'string') throw invalido(`«${c.titulo}» tiene que ser texto.`);
      const t = v.replace(/\r\n/g, '\n').trim();
      if (c.tipo === 'texto' && t.includes('\n')) throw invalido(`«${c.titulo}» va en una sola línea.`);
      if (t.length > c.max) throw invalido(`«${c.titulo}» tiene ${t.length} caracteres; el máximo es ${c.max}.`);
      return t || undefined;
    }
    case 'lista': {
      const items = (Array.isArray(v) ? v : String(v).split('\n')).map((x) => {
        if (typeof x !== 'string') throw invalido(`«${c.titulo}» tiene que ser una lista de textos.`);
        return x.trim();
      }).filter(Boolean);
      if (items.length > c.maxItems) throw invalido(`«${c.titulo}» tiene ${items.length} renglones; el máximo es ${c.maxItems}.`);
      for (const x of items) if (x.length > c.max) throw invalido(`Un renglón de «${c.titulo}» pasa los ${c.max} caracteres.`);
      return items.length ? items : undefined;
    }
    case 'numero': {
      const n = typeof v === 'string' && v.trim() === '' ? undefined : Number(v);
      if (n === undefined) return undefined;
      if (!Number.isInteger(n) || n < c.min || n > c.max) throw invalido(`«${c.titulo}» va de ${c.min} a ${c.max}.`);
      return n;
    }
    case 'si_no':
      if (typeof v !== 'boolean') throw invalido(`«${c.titulo}» es sí o no.`);
      return v;
    default:
      return undefined;
  }
}

// Mezcla lo que llega del panel sobre los ajustes actuales. Un campo vacío se borra; un campo
// que el usuario no puede tocar, o que no existe, se rechaza. Las claves que no son del
// formulario (cargadas por la CLI) se conservan tal cual, al final.
export function aplicarCambios(actuales, cambios, { esBigua }) {
  if (!cambios || typeof cambios !== 'object' || Array.isArray(cambios)) throw invalido('Faltan los ajustes.');
  const nuevo = { ...(actuales ?? {}) };
  for (const [k, v] of Object.entries(cambios)) {
    const c = POR_CLAVE.get(k);
    if (!c) throw invalido(`No existe el campo «${k}».`);
    if (!c.cliente && !esBigua) {
      if (JSON.stringify(v ?? null) === JSON.stringify(nuevo[k] ?? null)) continue;
      throw new GatewayError('forbidden', `«${c.titulo}» lo cambia Biguá.`, 403);
    }
    const limpio = limpiarValor(c, v);
    if (limpio === undefined) delete nuevo[k];
    else nuevo[k] = limpio;
  }
  return ordenar(nuevo);
}

export function ordenar(a) {
  const out = {};
  for (const c of CAMPOS) if (a[c.clave] !== undefined) out[c.clave] = a[c.clave];
  for (const [k, v] of Object.entries(a)) if (!POR_CLAVE.has(k)) out[k] = v;
  return out;
}

export function diferencias(antes, despues) {
  const claves = new Set([...Object.keys(antes ?? {}), ...Object.keys(despues ?? {})]);
  return [...claves].filter((k) => JSON.stringify(antes?.[k] ?? null) !== JSON.stringify(despues?.[k] ?? null));
}

export const tituloDe = (k) => POR_CLAVE.get(k)?.titulo ?? k;
