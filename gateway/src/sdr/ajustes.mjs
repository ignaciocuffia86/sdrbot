// Los ajustes de un cliente que se editan en el panel: qué campos hay, quién puede tocar cada
// uno y cómo se validan. Lo que se guarda acá aparece en la sección «Ajustes de este cliente» de
// las reglas de todos los bots desde su próxima corrida.

import { GatewayError } from '../errors.mjs';

// Bloques del formulario (docs/21 §3.3): en este orden se muestran en el panel y se los pasan los
// bots en «Ajustes de este cliente».
export const BLOQUES = [
  { clave: 'identidad', titulo: 'Identidad y voz', ayuda: 'Cómo se presenta la empresa y cómo escribe.' },
  { clave: 'audiencia', titulo: 'A quién y con qué señal', ayuda: 'A quién se le escribe, a quién no y qué dispara el primer contacto.' },
  { clave: 'conversacion', titulo: 'Conversación', ayuda: 'Qué se le pide al prospecto, cómo se responden las objeciones y qué pasa con un interesado.' },
  { clave: 'operacion', titulo: 'Operación', ayuda: 'Volumen y buzones.' },
];

// Quién edita cada campo:
//   cliente: true        el usuario del cliente, siempre.
//   autogestion: true    el usuario del cliente si el cliente es autogestionado; si no, Biguá.
//   ninguno de los dos   sólo un operador de Biguá.
export const CAMPOS = [
  { clave: 'nombre_comercial', bloque: 'identidad', titulo: 'Nombre comercial', tipo: 'texto', max: 120, cliente: true,
    ayuda: 'Cómo se presenta la empresa en los mails.' },
  { clave: 'oferta', bloque: 'identidad', titulo: 'Oferta', tipo: 'parrafo', max: 1500, cliente: true,
    ayuda: 'Qué ofrecen y para qué sirve, en dos o tres líneas. Sin precios, plazos ni resultados que no estén confirmados: los bots no los inventan, pero repiten lo que diga acá.' },
  { clave: 'tono', bloque: 'identidad', titulo: 'Tono', tipo: 'parrafo', max: 600, cliente: true,
    ayuda: 'Cómo escriben: formal o cercano, técnico o comercial, qué evitar.' },
  { clave: 'idioma', bloque: 'identidad', titulo: 'Idioma y trato', tipo: 'texto', max: 200, cliente: true,
    ayuda: 'Por ejemplo: español, de vos en Argentina y de usted en Chile.' },
  { clave: 'firma', bloque: 'identidad', titulo: 'Firma por defecto', tipo: 'parrafo', max: 400, cliente: true,
    ayuda: 'Para los buzones que no tienen firma propia (la firma de cada buzón se carga en Canales → Correo).' },
  { clave: 'prueba_social', bloque: 'identidad', titulo: 'Casos y datos que se pueden citar', tipo: 'lista', max: 300, maxItems: 15, cliente: true,
    ayuda: 'Uno por renglón, con su fuente: «Banca: regresión de 5 días a 6 horas (caso publicado)». Es lo único que los bots citan como resultado.' },
  { clave: 'icp', bloque: 'audiencia', titulo: 'A quién le venden', tipo: 'parrafo', max: 1500, cliente: true,
    ayuda: 'País, industrias, tamaño y las señales que importan (por ejemplo, avisos de empleo abiertos).' },
  { clave: 'roles_objetivo', bloque: 'audiencia', titulo: 'Cargos a los que se escribe', tipo: 'lista', max: 120, maxItems: 25, cliente: true,
    ayuda: 'Uno por línea. Es la elección de a quién revelar en ASCI.' },
  { clave: 'excluir', bloque: 'audiencia', titulo: 'Tipos de empresa y cargos a evitar', tipo: 'lista', max: 300, maxItems: 25, cliente: true,
    ayuda: 'Uno por línea: tipos de empresa, rubros, cargos. Las empresas y personas puntuales van en «No contactar», abajo.' },
  { clave: 'dias_aviso', bloque: 'audiencia', titulo: 'Antigüedad máxima del aviso (días)', tipo: 'numero', min: 3, max: 60, autogestion: true,
    ayuda: 'Sólo se prospecta una cuenta con un aviso publicado en estos últimos días. Vacío: 14.' },
  { clave: 'senal_avisos', bloque: 'audiencia', titulo: 'Señal en los avisos', tipo: 'parrafo', max: 500, cliente: false,
    ayuda: 'Cómo le pide el prospector los avisos a ASCI (avisos_recientes). Por ejemplo: «texto: qa | tester | testing, solo_titulo: sí» o «fabricante: SAP». Vacío: lo arma con la oferta.' },
  { clave: 'llamado_accion', bloque: 'conversacion', titulo: 'Qué le pedimos al prospecto', tipo: 'parrafo', max: 300, cliente: true,
    ayuda: 'El pedido del final del primer mail, por ejemplo «una charla de 20 minutos esta semana». Vacío: una pregunta que se conteste en una línea.' },
  { clave: 'objeciones', bloque: 'conversacion', titulo: 'Objeciones y cómo responderlas', tipo: 'lista', max: 600, maxItems: 20, cliente: true,
    ayuda: 'Una por línea: «lo que dicen»: cómo se responde.' },
  { clave: 'positivos', bloque: 'conversacion', titulo: 'Qué cuenta como respuesta positiva', tipo: 'lista', max: 120, maxItems: 15, cliente: true,
    ayuda: 'Uno por línea. Una respuesta positiva se contesta sólo con aprobación del operador.' },
  { clave: 'responsable_positivos', bloque: 'conversacion', titulo: 'Quién toma a los interesados', tipo: 'texto', max: 200, cliente: true,
    ayuda: 'Nombre y mail de quien sigue con un interesado, por ejemplo «Ana Pérez, ana@empresa.com». Los bots lo nombran al proponer la reunión.' },
  { clave: 'link_agenda', bloque: 'conversacion', titulo: 'Link de agenda', tipo: 'url', max: 300, cliente: true,
    ayuda: 'Para que un interesado elija horario (Calendly, HubSpot Meetings). Va sólo en la respuesta a un positivo, que siempre se aprueba antes.' },
  { clave: 'cuentas_por_dia', bloque: 'operacion', titulo: 'Cuentas nuevas por día', tipo: 'numero', min: 0, max: 100, autogestion: true,
    ayuda: 'Lo que el orquestador le pide al prospector cada día.' },
  { clave: 'buzones', bloque: 'operacion', titulo: 'Qué buzón usar para qué', tipo: 'parrafo', max: 600, autogestion: true,
    ayuda: 'Por ejemplo: «ventas@ para Argentina, info@ para Chile».' },
  { clave: 'acepta_mails_extrapolados', bloque: 'operacion', titulo: 'Acepta mails extrapolados', tipo: 'si_no', autogestion: true,
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
    case 'url': {
      if (typeof v !== 'string') throw invalido(`«${c.titulo}» tiene que ser texto.`);
      const t = v.trim();
      if (!t) return undefined;
      let u = null;
      try { u = new URL(t); } catch { /* inválida */ }
      if (!u || u.protocol !== 'https:' || /\s/.test(t)) throw invalido(`«${c.titulo}» tiene que ser un link que empiece con https://.`);
      if (t.length > c.max) throw invalido(`«${c.titulo}» tiene ${t.length} caracteres; el máximo es ${c.max}.`);
      return t;
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

// Si el usuario puede cambiar un campo. esBigua: operador de Biguá; autogestion: el cliente es
// autogestionado (docs/21 §6, decisión 1).
export const editable = (c, { esBigua, autogestion = false }) => esBigua || c.cliente === true || (c.autogestion === true && autogestion);

// Mezcla lo que llega del panel sobre los ajustes actuales. Un campo vacío se borra; un campo
// que el usuario no puede tocar, o que no existe, se rechaza. Las claves que no son del
// formulario (cargadas por la CLI) se conservan tal cual, al final. tope: el máximo de cuentas
// por día que Biguá le fijó a un cliente autogestionado.
export function aplicarCambios(actuales, cambios, { esBigua, autogestion = false, tope = null }) {
  if (!cambios || typeof cambios !== 'object' || Array.isArray(cambios)) throw invalido('Faltan los ajustes.');
  const nuevo = { ...(actuales ?? {}) };
  for (const [k, v] of Object.entries(cambios)) {
    const c = POR_CLAVE.get(k);
    if (!c) throw invalido(`No existe el campo «${k}».`);
    if (!editable(c, { esBigua, autogestion })) {
      if (JSON.stringify(v ?? null) === JSON.stringify(nuevo[k] ?? null)) continue;
      throw new GatewayError('forbidden', `«${c.titulo}» lo cambia Biguá.`, 403);
    }
    const limpio = limpiarValor(c, v);
    if (k === 'cuentas_por_dia' && !esBigua && tope !== null && limpio !== undefined && limpio > tope
        && limpio !== nuevo[k]) {
      throw invalido(`«${c.titulo}» va hasta ${tope}: es el tope que fijó Biguá para este cliente.`);
    }
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
