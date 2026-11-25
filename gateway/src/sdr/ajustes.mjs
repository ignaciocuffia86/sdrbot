// Los ajustes de un cliente que se editan en el panel: qué campos hay, en qué nivel viven
// (Empresa o campaña, docs/21 §6.2), quién puede tocar cada uno y cómo se validan.
//
// Dos esquemas sobre el mismo validador:
//   - EMPRESA: quién es la empresa, igual para todas las campañas (sdr.cliente_config.ajustes).
//   - CAMPAÑA: todo lo demás, de cada campaña (sdr.campana.ajustes) y sus columnas (estado, fechas,
//     volumen…). Desde la migración 024 el tono, el idioma, los casos, las objeciones, las
//     exclusiones y quién toma a los interesados son sólo de la campaña: una campaña en inglés y
//     otra en español no comparten nada de eso (docs/21 §6.2).
// Más CAMPOS, las claves con las que las reglas de antes de las campañas leen a un cliente (Empresa y
// la «principal» juntas): sólo para armar esa sección de las reglas, ya no se editan así (migración 022).

import { GatewayError } from '../errors.mjs';

const invalido = (msg) => new GatewayError('invalid_request', msg, 400);
const prohibido = (msg) => new GatewayError('forbidden', msg, 403);

// ---------------------------------------------------------------- definiciones

// Quién edita cada campo:
//   cliente: true        el usuario del cliente, siempre.
//   autogestion: true    el usuario del cliente si el cliente es autogestionado; si no, Biguá.
//   ninguno de los dos   sólo un operador de Biguá.
// Cada definición está una sola vez; los esquemas de abajo la usan con su bloque.
const DEF = {
  nombre_comercial: { titulo: 'Nombre comercial', tipo: 'texto', max: 120, cliente: true,
    ayuda: 'Cómo se presenta la empresa en los mails.' },
  descripcion: { titulo: 'Qué hace la empresa', tipo: 'parrafo', max: 1500, cliente: true,
    ayuda: 'La descripción general, la misma para todas las campañas. Lo que se ofrece en cada campaña va en su «Propuesta».' },
  oferta: { titulo: 'Oferta', tipo: 'parrafo', max: 1500, cliente: true,
    ayuda: 'Qué ofrecen y para qué sirve, en dos o tres líneas. Sin precios, plazos ni resultados que no estén confirmados: los bots no los inventan, pero repiten lo que diga acá.' },
  propuesta: { titulo: 'Propuesta', tipo: 'parrafo', max: 1500, cliente: true,
    ayuda: 'Qué se ofrece en esta campaña, para qué sirve y por qué ahora. Sin precios, plazos ni resultados que no estén confirmados: los bots no los inventan, pero repiten lo que diga acá.' },
  tono: { titulo: 'Tono', tipo: 'parrafo', max: 600, cliente: true,
    ayuda: 'Cómo se escribe en esta campaña: formal o cercano, técnico o comercial, qué evitar.' },
  idioma: { titulo: 'Idioma y trato', tipo: 'texto', max: 200, cliente: true,
    ayuda: 'En qué idioma se escribe en esta campaña y cómo se trata al prospecto. Por ejemplo: español, de vos en Argentina y de usted en Chile; o inglés. Vacío: español neutro.' },
  firma: { titulo: 'Firma por defecto', tipo: 'parrafo', max: 400, cliente: true,
    ayuda: 'Para los buzones que no tienen firma propia (la firma de cada buzón se carga en Canales → Correo).' },
  prueba_social: { titulo: 'Casos y datos que se pueden citar', tipo: 'lista', max: 300, maxItems: 15, cliente: true,
    ayuda: 'Los de esta campaña, uno por renglón, con su fuente: «Banca: regresión de 5 días a 6 horas (caso publicado)». Es lo único que los bots citan como resultado. Para usar los mismos en otra campaña, duplicala.' },
  icp: { titulo: 'A quién le venden', tipo: 'parrafo', max: 1500, cliente: true,
    ayuda: 'País, industrias, tamaño y las señales que importan (por ejemplo, avisos de empleo abiertos).' },
  roles_objetivo: { titulo: 'Cargos a los que se escribe', tipo: 'lista', max: 120, maxItems: 25, cliente: true,
    ayuda: 'Uno por línea. Es la elección de a quién revelar en ASCI.' },
  excluir: { titulo: 'Tipos de empresa y cargos a evitar', tipo: 'lista', max: 300, maxItems: 25, cliente: true,
    ayuda: 'Los de esta campaña, uno por línea: tipos de empresa, rubros, cargos. Las empresas y personas puntuales a las que no se les escribe nunca, desde ninguna campaña, van en «No contactar» (Empresa).' },
  dias_aviso: { titulo: 'Antigüedad máxima del aviso (días)', tipo: 'numero', min: 3, max: 60, autogestion: true,
    ayuda: 'Sólo se prospecta una cuenta con un aviso publicado en estos últimos días. Vacío: 14.' },
  senal_avisos: { titulo: 'Señal en los avisos', tipo: 'parrafo', max: 500, cliente: false,
    ayuda: 'Cómo le pide el prospector los avisos a ASCI (avisos_recientes). Por ejemplo: «texto: qa | tester | testing, solo_titulo: sí» o «fabricante: SAP». Vacío: lo arma con la oferta.' },
  llamado_accion: { titulo: 'Qué le pedimos al prospecto', tipo: 'parrafo', max: 300, cliente: true,
    ayuda: 'El pedido del final del primer mail, por ejemplo «una charla de 20 minutos esta semana». Vacío: una pregunta que se conteste en una línea.' },
  links_permitidos: { titulo: 'Links que pueden ir en los mails', tipo: 'urls', max: 300, maxItems: 3, cliente: true,
    ayuda: 'Hasta 3, uno por línea, empezando con https://. Fuera de estos, los mails no llevan links (por ejemplo, el de inscripción a un webinar).' },
  objeciones: { titulo: 'Objeciones y cómo responderlas', tipo: 'lista', max: 600, maxItems: 20, cliente: true,
    ayuda: 'Las de esta campaña, una por línea: «lo que dicen»: cómo se responde.' },
  positivos: { titulo: 'Qué cuenta como respuesta positiva', tipo: 'lista', max: 120, maxItems: 15, cliente: true,
    ayuda: 'Uno por línea. Una respuesta positiva se contesta sólo con aprobación del operador.' },
  responsable_positivos: { titulo: 'Quién toma a los interesados', tipo: 'texto', max: 200, cliente: true,
    ayuda: 'El nombre de quien sigue con un interesado de esta campaña, por ejemplo «Ana Pérez» (el AM de la vertical o del territorio). Los bots lo nombran al proponer la reunión.' },
  responsable_email: { titulo: 'Mail de quien toma a los interesados', tipo: 'email', max: 254, cliente: true,
    ayuda: 'La casilla del dominio principal de quien toma a los interesados, por ejemplo ana@empresa.com. Va en copia en la respuesta a un interesado: desde ahí la conversación sigue con esa persona.' },
  link_agenda: { titulo: 'Link de agenda', tipo: 'url', max: 300, cliente: true,
    ayuda: 'Para que un interesado elija horario (Calendly, HubSpot Meetings). Va sólo en la respuesta a un positivo, que siempre se aprueba antes.' },
  cuentas_por_dia: { titulo: 'Cuentas nuevas por día', tipo: 'numero', min: 0, max: 100, autogestion: true,
    ayuda: 'Lo que el orquestador le pide al prospector cada día.' },
  buzones: { titulo: 'Qué buzón usar para qué', tipo: 'parrafo', max: 600, autogestion: true,
    ayuda: 'Por ejemplo: «ventas@ para Argentina, info@ para Chile».' },
  acepta_mails_extrapolados: { titulo: 'Acepta mails extrapolados', tipo: 'si_no', autogestion: true,
    ayuda: 'Si se le escribe a un mail deducido del patrón de la empresa y no verificado.' },
  acepta_mails_del_cliente: { titulo: 'Acepta los mails del archivo', tipo: 'si_no', autogestion: true,
    ayuda: 'En una campaña «Lista del cliente»: si el primer mail puede ir al mail que trae el archivo, sin verificarlo. Si no dice nada, sí.' },
};

const armar = (lista) => lista.map(([clave, bloque, extra = {}]) => ({ clave, bloque, ...DEF[clave], ...extra }));

// ---------------------------------------------------------------- Empresa

// Sólo quién es la empresa y lo que vale para todas las campañas. Cómo habla, qué casos cita, qué
// objeciones contesta, a quién evita y quién toma a los interesados es de cada campaña.
export const BLOQUES_EMPRESA = [
  { clave: 'identidad', titulo: 'Identidad', ayuda: 'Quién es la empresa. Cómo habla, sus casos, sus objeciones y quién toma a los interesados van en cada campaña.' },
  { clave: 'voz', titulo: 'Firma', ayuda: 'La de los buzones que no tienen una propia.' },
  { clave: 'operacion', titulo: 'Operación', ayuda: 'Lo que vale para las campañas que no digan otra cosa.' },
];

export const CAMPOS_EMPRESA = armar([
  ['nombre_comercial', 'identidad'],
  ['descripcion', 'identidad'],
  ['firma', 'voz'],
  ['acepta_mails_extrapolados', 'operacion'],
]);

// Lo que era de Empresa y desde la migración 024 es sólo de la campaña. Si llega a Empresa por otro
// camino (la CLI, o volver a una versión de antes de la 024), sdr.migrar_empresa_024 lo pasa a
// todas las campañas del cliente.
export const DE_CAMPANA_DESDE_024 = ['tono', 'idioma', 'excluir', 'prueba_social', 'objeciones',
  'responsable_positivos', 'responsable_email', 'link_agenda'];

// ---------------------------------------------------------------- campaña

// Las secciones del editor de la campaña (docs/21 §3.2).
export const BLOQUES_CAMPANA = [
  { clave: 'objetivo', titulo: 'Objetivo', ayuda: 'Tipo, estado y fechas.' },
  { clave: 'propuesta', titulo: 'Propuesta', ayuda: 'Qué se ofrece en esta campaña y qué casos se citan.' },
  { clave: 'audiencia', titulo: 'Audiencia', ayuda: 'A quién se le escribe, a quién no y qué dispara el primer contacto. «No contactar», en Empresa, vale además para todas las campañas.' },
  { clave: 'mensajes', titulo: 'Mensajes', ayuda: 'En qué idioma y con qué tono se escribe, qué se le pide al prospecto y qué links pueden ir.' },
  { clave: 'respuestas', titulo: 'Respuestas', ayuda: 'Qué es positivo, las objeciones y quién toma a los interesados.' },
  { clave: 'ritmo', titulo: 'Canales y ritmo', ayuda: 'Buzones, volumen y LinkedIn.' },
  { clave: 'avanzado', titulo: 'Avanzado', ayuda: 'Lo que ajusta Biguá.' },
];

// Lo que la campaña cambia de Empresa: si la campaña no lo tiene, vale el de Empresa (decisión 9 y
// §6.2). La firma no: es del buzón (decisión 11). Desde la migración 024 es sólo esto: lo demás que
// se heredaba o se sumaba (tono, idioma, exclusiones, objeciones, interesados) es de la campaña.
export const HEREDABLES = ['acepta_mails_extrapolados'];

export const CAMPOS_CAMPANA = armar([
  ['propuesta', 'propuesta'],
  ['prueba_social', 'propuesta'],
  ['icp', 'audiencia'],
  ['roles_objetivo', 'audiencia'],
  ['excluir', 'audiencia'],
  ['senal_avisos', 'audiencia', { ayuda: 'Cómo le pide el prospector los avisos a ASCI (avisos_recientes). Por ejemplo: «texto: qa | tester | testing, solo_titulo: sí» o «fabricante: SAP». Vacío: lo arma con la propuesta.' }],
  ['dias_aviso', 'audiencia'],
  ['llamado_accion', 'mensajes', { ayuda: 'El pedido del final del primer mail. Vacío: el de su tipo de campaña.' }],
  ['idioma', 'mensajes'],
  ['tono', 'mensajes'],
  ['links_permitidos', 'mensajes'],
  ['positivos', 'respuestas'],
  ['objeciones', 'respuestas'],
  ['responsable_positivos', 'respuestas'],
  ['responsable_email', 'respuestas'],
  ['link_agenda', 'respuestas'],
  ['acepta_mails_extrapolados', 'ritmo'],
  ['acepta_mails_del_cliente', 'ritmo'],
]).map((c) => (HEREDABLES.includes(c.clave) ? { ...c, hereda: true } : c));

// Los tipos (docs/21 §4.2): el valor de «Qué le pedimos al prospecto» cuando la campaña no dice
// nada, y lo que hace falta para activarla.
export const TIPOS = {
  prospeccion: { titulo: 'Prospección por señal', llamado_accion: 'Una charla corta para ver si tiene sentido.' },
  evento: { titulo: 'Invitación a evento', llamado_accion: 'Inscribirse con el link.', fechas: true, links: true },
  reactivacion: { titulo: 'Reactivación', llamado_accion: '¿Sigue vigente el tema?', sinSenal: true },
  // docs/27 §5.1: no busca cuentas por avisos; trabaja las que el cliente cargó desde un archivo.
  lista: { titulo: 'Lista del cliente', llamado_accion: 'Una charla corta para ver si tiene sentido.', sinSenal: true, lista: true },
};

// Las columnas de sdr.campana que se editan en el panel, con el mismo esquema de permisos
// (decisión 13). El tipo y la calibración son de Biguá; el tipo, además, no cambia una vez
// activa la campaña.
export const COLUMNAS_CAMPANA = [
  { clave: 'nombre', bloque: 'objetivo', titulo: 'Nombre', tipo: 'texto', max: 120, cliente: true },
  { clave: 'tipo', bloque: 'objetivo', titulo: 'Tipo', tipo: 'opcion', opciones: Object.keys(TIPOS), cliente: false },
  { clave: 'estado', bloque: 'objetivo', titulo: 'Estado', tipo: 'opcion', opciones: ['borrador', 'activa', 'pausada', 'terminada'], autogestion: true },
  { clave: 'inicio', bloque: 'objetivo', titulo: 'Inicio', tipo: 'fecha', autogestion: true },
  { clave: 'fin', bloque: 'objetivo', titulo: 'Fin', tipo: 'fecha', autogestion: true },
  { clave: 'buzones', bloque: 'ritmo', titulo: 'Buzones', tipo: 'ids', maxItems: 50, autogestion: true },
  { clave: 'cuentas_por_dia', bloque: 'ritmo', titulo: 'Cuentas nuevas por día', tipo: 'numero', min: 0, max: 100, autogestion: true },
  { clave: 'dripify_campana_id', bloque: 'ritmo', titulo: 'Campaña de Dripify', tipo: 'numero', min: 1, max: Number.MAX_SAFE_INTEGER, cliente: false },
  { clave: 'calibracion_mails', bloque: 'avanzado', titulo: 'Mails a calibrar', tipo: 'numero', min: 0, max: 500, cliente: false },
];

// ---------------------------------------------------------------- las claves de las reglas de antes

// Empresa y la «principal» juntas, con sus nombres de antes de las campañas (la propuesta como
// «oferta», las cuentas por día). Sólo para la sección de las reglas que todavía no conocen las
// campañas (store.seccionesCliente con porCampana: false): el orden y qué va citado. El panel ya no
// las edita así desde la migración 022.

export const CAMPOS = armar([
  ['nombre_comercial', 'identidad'],
  ['oferta', 'identidad'],
  ['tono', 'identidad'],
  ['idioma', 'identidad'],
  ['firma', 'identidad'],
  ['prueba_social', 'identidad'],
  ['icp', 'audiencia'],
  ['roles_objetivo', 'audiencia'],
  ['excluir', 'audiencia'],
  ['dias_aviso', 'audiencia'],
  ['senal_avisos', 'audiencia'],
  ['llamado_accion', 'conversacion'],
  ['objeciones', 'conversacion'],
  ['positivos', 'conversacion'],
  ['responsable_positivos', 'conversacion'],
  ['responsable_email', 'conversacion'],
  ['link_agenda', 'conversacion'],
  ['cuentas_por_dia', 'operacion'],
  ['buzones', 'operacion'],
  ['acepta_mails_extrapolados', 'operacion'],
]);

// ---------------------------------------------------------------- validación

const EMAIL = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;

function urlValida(c, t) {
  let u = null;
  try { u = new URL(t); } catch { /* inválida */ }
  if (!u || u.protocol !== 'https:' || /\s/.test(t)) throw invalido(`«${c.titulo}» tiene que ser un link que empiece con https://.`);
  if (t.length > c.max) throw invalido(`«${c.titulo}» tiene ${t.length} caracteres; el máximo es ${c.max}.`);
  return t;
}

function renglones(c, v) {
  const items = (Array.isArray(v) ? v : String(v).split('\n')).map((x) => {
    if (typeof x !== 'string') throw invalido(`«${c.titulo}» tiene que ser una lista de textos.`);
    return x.trim();
  }).filter(Boolean);
  if (items.length > c.maxItems) throw invalido(`«${c.titulo}» tiene ${items.length} renglones; el máximo es ${c.maxItems}.`);
  return items;
}

function limpiarValor(c, v) {
  if (v === null || v === undefined) return undefined;
  switch (c.tipo) {
    case 'texto':
    case 'parrafo': {
      if (typeof v !== 'string') throw invalido(`«${c.titulo}» tiene que ser texto.`);
      const t = v.replace(/\r\n/g, '\n').trim();
      if (c.tipo === 'texto' && /[\n\u2028\u2029]/.test(t)) throw invalido(`«${c.titulo}» va en una sola línea.`);
      if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(t) || (c.tipo === 'texto' && t.includes('\t'))) {
        throw invalido(`«${c.titulo}» tiene caracteres de control.`);
      }
      if (t.length > c.max) throw invalido(`«${c.titulo}» tiene ${t.length} caracteres; el máximo es ${c.max}.`);
      return t || undefined;
    }
    case 'lista': {
      const items = renglones(c, v);
      for (const x of items) if (x.length > c.max) throw invalido(`Un renglón de «${c.titulo}» pasa los ${c.max} caracteres.`);
      return items.length ? items : undefined;
    }
    case 'urls': {
      const items = [...new Set(renglones(c, v).map((t) => urlValida(c, t)))];
      return items.length ? items : undefined;
    }
    case 'email': {
      if (typeof v !== 'string') throw invalido(`«${c.titulo}» tiene que ser texto.`);
      const t = v.trim().toLowerCase();
      if (!t) return undefined;
      if (t.length > c.max || !EMAIL.test(t)) throw invalido(`«${c.titulo}» tiene que ser un mail, por ejemplo ana@empresa.com.`);
      return t;
    }
    case 'url': {
      if (typeof v !== 'string') throw invalido(`«${c.titulo}» tiene que ser texto.`);
      const t = v.trim();
      return t ? urlValida(c, t) : undefined;
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
    case 'opcion':
      if (!c.opciones.includes(v)) throw invalido(`«${c.titulo}» es uno de: ${c.opciones.join(', ')}.`);
      return v;
    case 'fecha': {
      if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))
          || new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) !== v) {
        throw invalido(`«${c.titulo}» es una fecha AAAA-MM-DD.`);
      }
      return v;
    }
    case 'ids': {
      if (!Array.isArray(v)) throw invalido(`«${c.titulo}» es una lista.`);
      const ids = [...new Set(v)];
      if (ids.length > c.maxItems) throw invalido(`«${c.titulo}» va hasta ${c.maxItems}.`);
      for (const x of ids) {
        if (typeof x !== 'string' || !/^[0-9a-f-]{36}$/i.test(x)) throw invalido(`«${c.titulo}» tiene un id inválido.`);
      }
      return ids;
    }
    default:
      return undefined;
  }
}

// Si el usuario puede cambiar un campo. esBigua: operador de Biguá; autogestion: el cliente es
// autogestionado (docs/21 §6, decisión 1).
export const editable = (c, { esBigua, autogestion = false }) => esBigua || c.cliente === true || (c.autogestion === true && autogestion);

const igual = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

// Mezcla los cambios sobre los ajustes actuales según un esquema. Un campo vacío se borra; un
// campo que el usuario no puede tocar, o que no existe, se rechaza (mandar el mismo valor que ya
// tiene no cuenta como cambio). Las claves que no son del esquema (cargadas por la CLI) se
// conservan tal cual, al final.
function aplicar(campos, actuales, cambios, permiso) {
  if (!cambios || typeof cambios !== 'object' || Array.isArray(cambios)) throw invalido('Faltan los ajustes.');
  const porClave = new Map(campos.map((c) => [c.clave, c]));
  const nuevo = { ...(actuales ?? {}) };
  for (const [k, v] of Object.entries(cambios)) {
    const c = porClave.get(k);
    if (!c) throw invalido(`No existe el campo «${k}».`);
    if (!editable(c, permiso)) {
      if (igual(v, nuevo[k])) continue;
      throw prohibido(`«${c.titulo}» lo cambia Biguá.`);
    }
    const limpio = limpiarValor(c, v);
    if (k === 'cuentas_por_dia' && !permiso.esBigua && permiso.tope != null && limpio !== nuevo[k]) {
      // Vacío, el orquestador usa su valor por defecto (10, playbooks/orquestador/diaria.md), que
      // puede pasar el tope: el cliente no lo puede dejar vacío.
      if (limpio === undefined) throw invalido(`«${c.titulo}» no puede quedar vacío: va de 0 a ${permiso.tope}, el tope que fijó Biguá para este cliente.`);
      if (limpio > permiso.tope) throw invalido(`«${c.titulo}» va hasta ${permiso.tope}: es el tope que fijó Biguá para este cliente.`);
    }
    if (limpio === undefined) delete nuevo[k];
    else nuevo[k] = limpio;
  }
  return ordenarSegun(campos, nuevo);
}

function ordenarSegun(campos, a) {
  const claves = new Set(campos.map((c) => c.clave));
  const out = {};
  for (const c of campos) if (a[c.clave] !== undefined) out[c.clave] = a[c.clave];
  for (const [k, v] of Object.entries(a)) if (!claves.has(k)) out[k] = v;
  return out;
}

// El orden de las claves de las reglas de antes.
export const ordenar = (a) => ordenarSegun(CAMPOS, a);

export const aplicarCambiosEmpresa = (actuales, cambios, permiso) => aplicar(CAMPOS_EMPRESA, actuales, cambios, permiso);

// Las claves de la campaña que no van en Empresa: si llegan ahí (por la CLI, o al volver a una
// versión de antes de la 014), sdr.migrar_empresa_014 las pasa a la «principal» (docs/21 §6.2, paso 3).
export const LEGADO_EMPRESA = ['oferta', 'icp', 'roles_objetivo', 'senal_avisos', 'dias_aviso', 'llamado_accion', 'links_permitidos',
  'positivos', 'cuentas_por_dia', 'buzones'];
export const tieneLegado = (ajustes) => LEGADO_EMPRESA.some((k) => ajustes?.[k] !== undefined);
export const tieneLegado024 = (ajustes) => DE_CAMPANA_DESDE_024.some((k) => ajustes?.[k] !== undefined);

// El formulario de Empresa del panel: lo común a todas las campañas; lo de cada campaña, en su
// campaña. Desde la migración 022 es uno solo (antes había uno de transición que editaba también lo
// de la «principal»).
export const FORMULARIO_EMPRESA = { bloques: BLOQUES_EMPRESA, campos: CAMPOS_EMPRESA, aplicar: aplicarCambiosEmpresa };
export const ordenarEmpresa = (a) => ordenarSegun(CAMPOS_EMPRESA, a);

// Los ajustes de una campaña.
export const aplicarCambiosCampana = (actuales, cambios, permiso) => aplicar(CAMPOS_CAMPANA, actuales, cambios, permiso);
export const ordenarCampana = (a) => ordenarSegun(CAMPOS_CAMPANA, a);

// Las columnas de una campaña (nombre, tipo, estado, fechas, buzones, volumen, Dripify,
// calibración). actual: la fila de hoy, o null para una campaña nueva. tope: el
// tope_cuentas_dia del cliente; otrasActivas: la suma de cuentas_por_dia de las demás campañas
// activas del cliente. Devuelve sólo las columnas que cambian, validadas. Con controlarTope: false
// no mira el tope, para que quien llama controle antes otra cosa (lo que falta para activar) y
// después llame a controlarTope.
export function aplicarColumnasCampana(actual, cambios, permiso, { tope = null, otrasActivas = 0, controlarTope: conTope = true } = {}) {
  if (!cambios || typeof cambios !== 'object' || Array.isArray(cambios)) throw invalido('Faltan los datos de la campaña.');
  const porClave = new Map(COLUMNAS_CAMPANA.map((c) => [c.clave, c]));
  const out = {};
  for (const [k, v] of Object.entries(cambios)) {
    const c = porClave.get(k);
    if (!c) throw invalido(`No existe el campo «${k}».`);
    const antes = actual?.[k] instanceof Date ? fecha(actual[k]) : actual?.[k];
    if (!editable(c, permiso)) {
      if (igual(v, antes)) continue;
      throw prohibido(`«${c.titulo}» lo cambia Biguá.`);
    }
    const limpio = limpiarValor(c, v);
    if (k === 'nombre' && limpio === undefined) throw invalido('La campaña necesita un nombre.');
    if ((k === 'cuentas_por_dia' || k === 'calibracion_mails' || k === 'tipo') && limpio === undefined) {
      throw invalido(`«${c.titulo}» no puede quedar vacío.`);
    }
    if (!igual(limpio ?? null, antes ?? null)) out[k] = limpio ?? null;
  }
  if (!actual && !out.nombre) throw invalido('La campaña necesita un nombre.');

  const estadoAntes = actual?.estado ?? 'borrador';
  const estado = out.estado ?? estadoAntes;
  if ('tipo' in out && actual && estadoAntes !== 'borrador') {
    throw invalido('El tipo de una campaña no cambia una vez activada: duplicala como un borrador nuevo.');
  }
  if ('estado' in out) {
    if (!actual && estado !== 'borrador') throw invalido('Una campaña nueva arranca en borrador.');
    if (estadoAntes === 'terminada') throw invalido('Una campaña terminada no se reactiva: duplicala.');
    if (estado === 'borrador' && estadoAntes !== 'borrador') throw invalido('Una campaña que ya se activó no vuelve a borrador.');
  }
  if (actual?.estado === 'terminada' && Object.keys(out).length) {
    throw invalido('Una campaña terminada no se edita: duplicala.');
  }
  const inicio = out.inicio !== undefined ? out.inicio : actual?.inicio ?? null;
  const fin = out.fin !== undefined ? out.fin : actual?.fin ?? null;
  if (inicio && fin && fecha(inicio) > fecha(fin)) throw invalido('El fin de la campaña va después del inicio.');

  if (conTope) controlarTope(actual, out, { tope, otrasActivas });
  return out;
}

// Decisión 12: la suma de las activas no pasa el tope del cliente. Para tener más de una campaña
// activa, el tope tiene que estar cargado. Sólo mira si el cambio activa la campaña o le cambia el
// volumen estando activa.
export function controlarTope(actual, cambios, { tope = null, otrasActivas = 0 } = {}) {
  const estado = cambios.estado ?? actual?.estado ?? 'borrador';
  if (estado !== 'activa' || !('cuentas_por_dia' in cambios || 'estado' in cambios)) return;
  const cuentas = cambios.cuentas_por_dia ?? actual?.cuentas_por_dia ?? 0;
  if (tope == null && otrasActivas > 0) {
    throw invalido('Para tener más de una campaña activa, Biguá tiene que cargar el tope de cuentas por día del cliente.');
  }
  if (tope != null && otrasActivas + cuentas > tope) {
    throw invalido(`Las campañas activas sumarían ${otrasActivas + cuentas} cuentas por día; el tope del cliente es ${tope}.`);
  }
}

// pg devuelve las columnas date como Date a la medianoche local.
const dos = (n) => String(n).padStart(2, '0');
const fecha = (v) => (v instanceof Date ? `${v.getFullYear()}-${dos(v.getMonth() + 1)}-${dos(v.getDate())}` : String(v));

// Lo que le falta a una campaña para activarla (docs/21 §3.2: «una campaña no se puede activar con
// puntos pendientes»). campana: la fila con sus ajustes y buzones (lista de ids); empresa: los
// ajustes de Empresa. Devuelve [{ bloque, clave, mensaje }], vacío si se puede activar.
export function faltantesParaActivar(campana, empresa = {}) {
  const a = campana.ajustes ?? {};
  const tipo = TIPOS[campana.tipo] ?? TIPOS.prospeccion;
  const faltan = [];
  const falta = (bloque, clave, mensaje) => faltan.push({ bloque, clave, mensaje });
  if (!a.propuesta) falta('propuesta', 'propuesta', 'Falta la propuesta de la campaña.');
  if (!tipo.sinSenal) {
    if (!a.icp) falta('audiencia', 'icp', 'Falta a quién le venden.');
    if (!a.roles_objetivo?.length) falta('audiencia', 'roles_objetivo', 'Faltan los cargos a los que se escribe.');
  }
  // Una lista: los cargos, para buscar a quien decide cuando la fila no trae contacto, y al menos
  // una cuenta cargada (campana.cuentas_de_lista la cuenta quien llama; sin el dato, no se exige).
  if (tipo.lista) {
    if (!a.roles_objetivo?.length) falta('audiencia', 'roles_objetivo', 'Faltan los cargos a los que se escribe cuando la fila no trae contacto.');
    if (campana.cuentas_de_lista === 0) falta('lista', 'lista', 'Falta cargar la lista de cuentas (Subir Excel o CSV, abajo).');
  }
  if (!(campana.buzones ?? []).length) falta('ritmo', 'buzones', 'Falta elegir al menos un buzón.');
  if (!campana.cuentas_por_dia) falta('ritmo', 'cuentas_por_dia', 'Faltan las cuentas nuevas por día.');
  if (tipo.fechas && (!campana.inicio || !campana.fin)) falta('objetivo', 'fin', 'Una campaña de evento necesita inicio y fin.');
  if (tipo.links && !a.links_permitidos?.length) falta('mensajes', 'links_permitidos', 'Falta el link de inscripción.');
  // Un interesado se deriva en copia a quien lo toma (docs/26): sin su nombre y su mail, la respuesta
  // a un positivo no puede salir. Es de cada campaña (el AM de la vertical, del territorio…).
  if (!a.responsable_positivos) falta('respuestas', 'responsable_positivos', 'Falta quién toma a los interesados.');
  if (!a.responsable_email) falta('respuestas', 'responsable_email', 'Falta el mail de quien toma a los interesados.');
  if (!empresa.nombre_comercial) falta('empresa', 'nombre_comercial', 'Falta el nombre comercial en Empresa.');
  return faltan;
}

// ---------------------------------------------------------------- lo que leen los bots

// Los ajustes con los que trabaja una campaña: los de Empresa con los de la campaña encima.
// Devuelve { valores, origen }: origen dice de dónde salió cada clave ('empresa', 'campana' o 'tipo'
// para el valor por defecto del tipo).
export function ajustesEfectivos(empresa = {}, campana = {}, tipo = 'prospeccion') {
  const e = empresa ?? {};
  const c = campana ?? {};
  const valores = {};
  const origen = {};
  const poner = (k, v, o) => { if (v !== undefined) { valores[k] = v; origen[k] = o; } };

  for (const k of ['nombre_comercial', 'descripcion', 'firma']) poner(k, e[k], 'empresa');
  for (const k of ['propuesta', 'prueba_social', 'icp', 'roles_objetivo', 'excluir', 'senal_avisos', 'dias_aviso', 'idioma', 'tono',
    'links_permitidos', 'positivos', 'objeciones', 'responsable_positivos', 'responsable_email', 'link_agenda', 'acepta_mails_del_cliente']) {
    poner(k, c[k], 'campana');
  }
  for (const k of HEREDABLES) poner(k, c[k] ?? e[k], c[k] !== undefined ? 'campana' : 'empresa');
  if (c.llamado_accion) poner('llamado_accion', c.llamado_accion, 'campana');
  else poner('llamado_accion', (TIPOS[tipo] ?? TIPOS.prospeccion).llamado_accion, 'tipo');

  const orden = new Map([...CAMPOS_EMPRESA, ...CAMPOS_CAMPANA].map((x, i) => [x.clave, i]));
  const claves = Object.keys(valores).sort((a, b) => (orden.get(a) ?? 99) - (orden.get(b) ?? 99));
  return { valores: Object.fromEntries(claves.map((k) => [k, valores[k]])), origen };
}

// ---------------------------------------------------------------- utilidades

export function diferencias(antes, despues) {
  const claves = new Set([...Object.keys(antes ?? {}), ...Object.keys(despues ?? {})]);
  return [...claves].filter((k) => !igual(antes?.[k], despues?.[k]));
}

export const tituloDe = (k) => DEF[k]?.titulo ?? COLUMNAS_CAMPANA.find((c) => c.clave === k)?.titulo ?? k;

// El título de un cambio en una campaña: el de la campaña primero (en el historial, «buzones» son
// los buzones elegidos, no el texto libre de Empresa).
export const tituloCampana = (k) => (k === 'creada' ? 'Creada'
  : COLUMNAS_CAMPANA.find((c) => c.clave === k)?.titulo ?? CAMPOS_CAMPANA.find((c) => c.clave === k)?.titulo ?? tituloDe(k));
