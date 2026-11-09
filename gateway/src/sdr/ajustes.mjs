// Los ajustes de un cliente que se editan en el panel: qué campos hay, en qué nivel viven
// (Empresa o campaña, docs/21 §6.2), quién puede tocar cada uno y cómo se validan.
//
// Tres esquemas sobre el mismo validador:
//   - EMPRESA: lo común a todas las campañas (sdr.cliente_config.ajustes).
//   - CAMPAÑA: lo de cada campaña (sdr.campana.ajustes) y sus columnas (estado, fechas, volumen…).
//   - El formulario de hoy (BLOQUES y CAMPOS): Empresa y la campaña «principal» juntas, como las
//     editan hoy el panel y las leen las reglas. Es la transición: se va cuando el panel y las
//     reglas lean la campaña y la migración 013 saque de Empresa las claves de la campaña.

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
    ayuda: 'Cómo escriben: formal o cercano, técnico o comercial, qué evitar.' },
  idioma: { titulo: 'Idioma y trato', tipo: 'texto', max: 200, cliente: true,
    ayuda: 'Por ejemplo: español, de vos en Argentina y de usted en Chile.' },
  firma: { titulo: 'Firma por defecto', tipo: 'parrafo', max: 400, cliente: true,
    ayuda: 'Para los buzones que no tienen firma propia (la firma de cada buzón se carga en Canales → Correo).' },
  prueba_social: { titulo: 'Casos y datos que se pueden citar', tipo: 'lista', max: 300, maxItems: 15, cliente: true,
    ayuda: 'Uno por renglón, con su fuente: «Banca: regresión de 5 días a 6 horas (caso publicado)». Es lo único que los bots citan como resultado.' },
  icp: { titulo: 'A quién le venden', tipo: 'parrafo', max: 1500, cliente: true,
    ayuda: 'País, industrias, tamaño y las señales que importan (por ejemplo, avisos de empleo abiertos).' },
  roles_objetivo: { titulo: 'Cargos a los que se escribe', tipo: 'lista', max: 120, maxItems: 25, cliente: true,
    ayuda: 'Uno por línea. Es la elección de a quién revelar en ASCI.' },
  excluir: { titulo: 'Tipos de empresa y cargos a evitar', tipo: 'lista', max: 300, maxItems: 25, cliente: true,
    ayuda: 'Uno por línea: tipos de empresa, rubros, cargos. Las empresas y personas puntuales van en «No contactar», abajo.' },
  dias_aviso: { titulo: 'Antigüedad máxima del aviso (días)', tipo: 'numero', min: 3, max: 60, autogestion: true,
    ayuda: 'Sólo se prospecta una cuenta con un aviso publicado en estos últimos días. Vacío: 14.' },
  senal_avisos: { titulo: 'Señal en los avisos', tipo: 'parrafo', max: 500, cliente: false,
    ayuda: 'Cómo le pide el prospector los avisos a ASCI (avisos_recientes). Por ejemplo: «texto: qa | tester | testing, solo_titulo: sí» o «fabricante: SAP». Vacío: lo arma con la oferta.' },
  llamado_accion: { titulo: 'Qué le pedimos al prospecto', tipo: 'parrafo', max: 300, cliente: true,
    ayuda: 'El pedido del final del primer mail, por ejemplo «una charla de 20 minutos esta semana». Vacío: una pregunta que se conteste en una línea.' },
  links_permitidos: { titulo: 'Links que pueden ir en los mails', tipo: 'urls', max: 300, maxItems: 3, cliente: true,
    ayuda: 'Hasta 3, uno por línea, empezando con https://. Fuera de estos, los mails no llevan links (por ejemplo, el de inscripción a un webinar).' },
  objeciones: { titulo: 'Objeciones y cómo responderlas', tipo: 'lista', max: 600, maxItems: 20, cliente: true,
    ayuda: 'Una por línea: «lo que dicen»: cómo se responde.' },
  positivos: { titulo: 'Qué cuenta como respuesta positiva', tipo: 'lista', max: 120, maxItems: 15, cliente: true,
    ayuda: 'Uno por línea. Una respuesta positiva se contesta sólo con aprobación del operador.' },
  responsable_positivos: { titulo: 'Quién toma a los interesados', tipo: 'texto', max: 200, cliente: true,
    ayuda: 'Nombre y mail de quien sigue con un interesado, por ejemplo «Ana Pérez, ana@empresa.com». Los bots lo nombran al proponer la reunión.' },
  link_agenda: { titulo: 'Link de agenda', tipo: 'url', max: 300, cliente: true,
    ayuda: 'Para que un interesado elija horario (Calendly, HubSpot Meetings). Va sólo en la respuesta a un positivo, que siempre se aprueba antes.' },
  cuentas_por_dia: { titulo: 'Cuentas nuevas por día', tipo: 'numero', min: 0, max: 100, autogestion: true,
    ayuda: 'Lo que el orquestador le pide al prospector cada día.' },
  buzones: { titulo: 'Qué buzón usar para qué', tipo: 'parrafo', max: 600, autogestion: true,
    ayuda: 'Por ejemplo: «ventas@ para Argentina, info@ para Chile».' },
  acepta_mails_extrapolados: { titulo: 'Acepta mails extrapolados', tipo: 'si_no', autogestion: true,
    ayuda: 'Si se le escribe a un mail deducido del patrón de la empresa y no verificado.' },
};

const armar = (lista) => lista.map(([clave, bloque, extra = {}]) => ({ clave, bloque, ...DEF[clave], ...extra }));

// ---------------------------------------------------------------- Empresa

export const BLOQUES_EMPRESA = [
  { clave: 'identidad', titulo: 'Identidad', ayuda: 'Quién es la empresa.' },
  { clave: 'voz', titulo: 'Voz', ayuda: 'Cómo escribe. Una campaña puede cambiar el tono y el idioma.' },
  { clave: 'exclusiones', titulo: 'Exclusiones de siempre', ayuda: 'A quién no se le escribe desde ninguna campaña. Cada campaña puede sumar las suyas.' },
  { clave: 'prueba', titulo: 'Casos y datos', ayuda: 'La biblioteca: cada campaña elige cuáles cita.' },
  { clave: 'conversacion', titulo: 'Conversación', ayuda: 'Las objeciones de siempre y qué pasa con un interesado. Cada campaña suma sus objeciones y puede cambiar lo demás.' },
  { clave: 'operacion', titulo: 'Operación', ayuda: 'Lo que vale para las campañas que no digan otra cosa.' },
];

export const CAMPOS_EMPRESA = armar([
  ['nombre_comercial', 'identidad'],
  ['descripcion', 'identidad'],
  ['tono', 'voz'],
  ['idioma', 'voz'],
  ['firma', 'voz'],
  ['excluir', 'exclusiones'],
  ['prueba_social', 'prueba'],
  ['objeciones', 'conversacion', { titulo: 'Objeciones de siempre y cómo responderlas' }],
  ['responsable_positivos', 'conversacion'],
  ['link_agenda', 'conversacion'],
  ['acepta_mails_extrapolados', 'operacion'],
]);

// ---------------------------------------------------------------- campaña

// Las secciones del editor de la campaña (docs/21 §3.2).
export const BLOQUES_CAMPANA = [
  { clave: 'objetivo', titulo: 'Objetivo', ayuda: 'Tipo, estado y fechas.' },
  { clave: 'propuesta', titulo: 'Propuesta', ayuda: 'Qué se ofrece en esta campaña y qué casos se citan.' },
  { clave: 'audiencia', titulo: 'Audiencia', ayuda: 'A quién se le escribe, a quién no (además de las exclusiones de Empresa) y qué dispara el primer contacto.' },
  { clave: 'mensajes', titulo: 'Mensajes', ayuda: 'Qué se le pide al prospecto, qué links pueden ir y cómo se escribe.' },
  { clave: 'respuestas', titulo: 'Respuestas', ayuda: 'Qué es positivo, las objeciones propias (además de las de Empresa) y quién toma a los interesados.' },
  { clave: 'ritmo', titulo: 'Canales y ritmo', ayuda: 'Buzones, volumen y LinkedIn.' },
  { clave: 'avanzado', titulo: 'Avanzado', ayuda: 'Lo que ajusta Biguá.' },
];

// Lo que la campaña cambia de Empresa: si la campaña no lo tiene, vale el de Empresa (decisión 9 y
// §6.2). La firma no: es del buzón (decisión 11).
export const HEREDABLES = ['tono', 'idioma', 'acepta_mails_extrapolados', 'responsable_positivos', 'link_agenda'];

// Las listas que están en los dos niveles se suman: el bot ve las de Empresa y las de la campaña.
export const SE_SUMAN = ['excluir', 'objeciones'];

export const CAMPOS_CAMPANA = armar([
  ['propuesta', 'propuesta'],
  ['prueba_social', 'propuesta', { titulo: 'Casos que cita esta campaña', tipo: 'seleccion', de: 'prueba_social',
    ayuda: 'Los de «Casos y datos» de Empresa que se pueden citar en esta campaña. Ninguno elegido: todos.' }],
  ['icp', 'audiencia'],
  ['roles_objetivo', 'audiencia'],
  ['excluir', 'audiencia', { titulo: 'Exclusiones de esta campaña',
    ayuda: 'Además de las de Empresa. Uno por línea: tipos de empresa, rubros, cargos.' }],
  ['senal_avisos', 'audiencia', { ayuda: 'Cómo le pide el prospector los avisos a ASCI (avisos_recientes). Por ejemplo: «texto: qa | tester | testing, solo_titulo: sí» o «fabricante: SAP». Vacío: lo arma con la propuesta.' }],
  ['dias_aviso', 'audiencia'],
  ['llamado_accion', 'mensajes', { ayuda: 'El pedido del final del primer mail. Vacío: el de su tipo de campaña.' }],
  ['links_permitidos', 'mensajes'],
  ['tono', 'mensajes'],
  ['idioma', 'mensajes'],
  ['positivos', 'respuestas'],
  ['objeciones', 'respuestas', { titulo: 'Objeciones de esta campaña', ayuda: 'Además de las de Empresa. Una por línea: «lo que dicen»: cómo se responde.' }],
  ['responsable_positivos', 'respuestas'],
  ['link_agenda', 'respuestas'],
  ['acepta_mails_extrapolados', 'ritmo'],
]).map((c) => (HEREDABLES.includes(c.clave) ? { ...c, hereda: true } : c));

// Los tipos (docs/21 §4.2): el valor de «Qué le pedimos al prospecto» cuando la campaña no dice
// nada, y lo que hace falta para activarla.
export const TIPOS = {
  prospeccion: { titulo: 'Prospección por señal', llamado_accion: 'Una charla corta para ver si tiene sentido.' },
  evento: { titulo: 'Invitación a evento', llamado_accion: 'Inscribirse con el link.', fechas: true, links: true },
  reactivacion: { titulo: 'Reactivación', llamado_accion: '¿Sigue vigente el tema?', sinSenal: true },
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

// ---------------------------------------------------------------- el formulario de hoy (transición)

// Empresa y la «principal» en un solo formulario, como hoy. Lo usan el panel (pestaña Empresa) y
// «Ajustes de este cliente» de las reglas hasta que lean la campaña.
export const BLOQUES = [
  { clave: 'identidad', titulo: 'Identidad y voz', ayuda: 'Cómo se presenta la empresa y cómo escribe.' },
  { clave: 'audiencia', titulo: 'A quién y con qué señal', ayuda: 'A quién se le escribe, a quién no y qué dispara el primer contacto.' },
  { clave: 'conversacion', titulo: 'Conversación', ayuda: 'Qué se le pide al prospecto, cómo se responden las objeciones y qué pasa con un interesado.' },
  { clave: 'operacion', titulo: 'Operación', ayuda: 'Volumen y buzones.' },
];

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
  ['link_agenda', 'conversacion'],
  ['cuentas_por_dia', 'operacion'],
  ['buzones', 'operacion'],
  ['acepta_mails_extrapolados', 'operacion'],
]);

// ---------------------------------------------------------------- validación

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

// contexto.empresa: los ajustes de Empresa, para validar lo que se elige de ellos.
function limpiarValor(c, v, contexto = {}) {
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
      const items = renglones(c, v);
      for (const x of items) if (x.length > c.max) throw invalido(`Un renglón de «${c.titulo}» pasa los ${c.max} caracteres.`);
      return items.length ? items : undefined;
    }
    case 'urls': {
      const items = [...new Set(renglones(c, v).map((t) => urlValida(c, t)))];
      return items.length ? items : undefined;
    }
    case 'seleccion': {
      const items = [...new Set(renglones(c, v))];
      const de = contexto.empresa?.[c.de] ?? [];
      for (const x of items) {
        if (!de.includes(x)) throw invalido(`«${x.slice(0, 60)}» no está en «${DEF[c.de].titulo}» de Empresa.`);
      }
      return items.length ? items : undefined;
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
function aplicar(campos, actuales, cambios, permiso, contexto = {}) {
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
    const limpio = limpiarValor(c, v, contexto);
    if (k === 'cuentas_por_dia' && !permiso.esBigua && permiso.tope != null && limpio !== undefined && limpio > permiso.tope
        && limpio !== nuevo[k]) {
      throw invalido(`«${c.titulo}» va hasta ${permiso.tope}: es el tope que fijó Biguá para este cliente.`);
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

// El formulario de hoy. tope: el máximo de cuentas por día que Biguá le fijó a un cliente
// autogestionado.
export const aplicarCambios = (actuales, cambios, permiso) => aplicar(CAMPOS, actuales, cambios, permiso);
export const ordenar = (a) => ordenarSegun(CAMPOS, a);

export const aplicarCambiosEmpresa = (actuales, cambios, permiso) => aplicar(CAMPOS_EMPRESA, actuales, cambios, permiso);
export const ordenarEmpresa = (a) => ordenarSegun(CAMPOS_EMPRESA, a);

// Los ajustes de una campaña. empresa: los ajustes de Empresa (para elegir los casos).
export const aplicarCambiosCampana = (actuales, cambios, permiso, { empresa = {} } = {}) =>
  aplicar(CAMPOS_CAMPANA, actuales, cambios, permiso, { empresa });
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
  if (!(campana.buzones ?? []).length) falta('ritmo', 'buzones', 'Falta elegir al menos un buzón.');
  if (!campana.cuentas_por_dia) falta('ritmo', 'cuentas_por_dia', 'Faltan las cuentas nuevas por día.');
  if (tipo.fechas && (!campana.inicio || !campana.fin)) falta('objetivo', 'fin', 'Una campaña de evento necesita inicio y fin.');
  if (tipo.links && !a.links_permitidos?.length) falta('mensajes', 'links_permitidos', 'Falta el link de inscripción.');
  if (!empresa.nombre_comercial) falta('empresa', 'nombre_comercial', 'Falta el nombre comercial en Empresa.');
  return faltan;
}

// ---------------------------------------------------------------- lo que leen los bots

// Los ajustes con los que trabaja una campaña: los de Empresa con los de la campaña encima.
// Devuelve { valores, origen }: origen dice de dónde salió cada clave ('empresa', 'campana',
// 'ambas' para las listas que se suman, o 'tipo' para el valor por defecto del tipo).
export function ajustesEfectivos(empresa = {}, campana = {}, tipo = 'prospeccion') {
  const e = empresa ?? {};
  const c = campana ?? {};
  const valores = {};
  const origen = {};
  const poner = (k, v, o) => { if (v !== undefined) { valores[k] = v; origen[k] = o; } };

  for (const k of ['nombre_comercial', 'descripcion', 'firma']) poner(k, e[k], 'empresa');
  for (const k of ['propuesta', 'icp', 'roles_objetivo', 'senal_avisos', 'dias_aviso', 'links_permitidos', 'positivos']) {
    poner(k, c[k], 'campana');
  }
  for (const k of HEREDABLES) poner(k, c[k] ?? e[k], c[k] !== undefined ? 'campana' : 'empresa');
  for (const k of SE_SUMAN) {
    const suma = [...new Set([...(e[k] ?? []), ...(c[k] ?? [])])];
    if (suma.length) poner(k, suma, e[k]?.length && c[k]?.length ? 'ambas' : e[k]?.length ? 'empresa' : 'campana');
  }
  if (e.prueba_social?.length) {
    const elegidos = c.prueba_social?.length ? e.prueba_social.filter((x) => c.prueba_social.includes(x)) : e.prueba_social;
    if (elegidos.length) poner('prueba_social', elegidos, c.prueba_social?.length ? 'campana' : 'empresa');
  }
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
