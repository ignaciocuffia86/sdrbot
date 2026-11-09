// Las campañas de un cliente en el panel (docs/21 §3.2, §4 y §6.2; etapa C1): listar, ver,
// crear, editar, activar, pausar, terminar y duplicar.
//
// Cada función recibe la conexión que ya abrió el panel para el usuario: el dueño para un
// operador de Biguá, mailgw_portal con su cliente fijado para un usuario de cliente. Por eso
// todas las consultas filtran por client_id aunque la base ya lo haga para el portal.
//
// Qué puede tocar cada uno, los estados y el tope los decide ajustes.mjs; acá se lee y se
// escribe la base.

import { GatewayError } from '../errors.mjs';
import { asRole } from '../store.mjs';
import {
  BLOQUES_CAMPANA, CAMPOS_CAMPANA, COLUMNAS_CAMPANA, TIPOS, ajustesEfectivos, aplicarCambiosCampana,
  aplicarColumnasCampana, controlarTope, diferencias, editable, faltantesParaActivar, tituloCampana, tituloDe,
} from './ajustes.mjs';

const invalido = (msg) => new GatewayError('invalid_request', msg, 400);
const noExiste = (msg = 'No existe esa campaña.') => new GatewayError('not_found', msg, 404);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Las columnas que el panel puede escribir. Los nombres que van armados en el SQL salen sólo de
// esta lista: aunque ajustes.mjs ya rechaza cualquier otra clave, acá se controla otra vez.
const ESCRIBIBLES = new Set(['nombre', 'tipo', 'estado', 'inicio', 'fin', 'cuentas_por_dia', 'dripify_campana_id', 'calibracion_mails']);
const columnasSql = (obj) => {
  const k = Object.keys(obj);
  for (const x of k) if (!ESCRIBIBLES.has(x)) throw invalido(`No existe el campo «${x}».`);
  return k;
};

const COLS = `id, client_id, clave, nombre, tipo, estado, ajustes, dripify_campana_id, cuentas_por_dia, calibracion_mails,
  to_char(inicio, 'YYYY-MM-DD') as inicio, to_char(fin, 'YYYY-MM-DD') as fin, duplicada_de, terminada_at,
  creado_at, actualizado_at`;

// La configuración del cliente que hace falta para decidir: modo, tope y los ajustes de Empresa.
// Con bloquear, toma la fila para que dos guardados a la vez no pasen juntos el tope.
async function contexto(c, clientId, { bloquear = false } = {}) {
  const cfg = (await c.query(
    `select ajustes, modo, tope_cuentas_dia from sdr.cliente_config where client_id = $1${bloquear ? ' for update' : ''}`,
    [clientId])).rows[0];
  if (!cfg) throw noExiste('El SDR no está activado para este cliente.');
  return cfg;
}

const permisoDe = (esBigua, cfg) => ({ esBigua, autogestion: cfg.modo === 'autogestionado', tope: cfg.tope_cuentas_dia });

async function fila(c, clientId, id, { bloquear = false } = {}) {
  if (!UUID.test(String(id))) throw noExiste();
  const { rows } = await c.query(`select ${COLS} from sdr.campana where client_id = $1 and id = $2${bloquear ? ' for update' : ''}`,
    [clientId, id]);
  if (!rows.length) throw noExiste();
  const buzones = (await c.query(`select account_id from sdr.campana_buzon where client_id = $1 and campana_id = $2 order by account_id`,
    [clientId, id])).rows.map((r) => r.account_id);
  return { ...rows[0], buzones };
}

const numero = (v) => (v === null || v === undefined ? null : Number(v));
const publica = (r) => ({ ...r, dripify_campana_id: numero(r.dripify_campana_id) });

async function otrasActivas(c, clientId, id) {
  const { rows } = await c.query(
    `select coalesce(sum(cuentas_por_dia), 0)::int as n from sdr.campana
      where client_id = $1 and estado = 'activa' and id is distinct from $2`, [clientId, id ?? null]);
  return rows[0].n;
}

async function buzonesDelCliente(c, clientId) {
  return (await c.query(
    `select id, email, display_name, status from mailgw.account where client_id = $1 order by email`, [clientId])).rows;
}

// ---------------------------------------------------------------- lectura

// Personas por campaña. Se leen con el rol de la aplicación y el cliente fijado, como el Resumen:
// el portal no ve el registro (007). Abre su propia conexión, así que se llama con la del panel ya
// cerrada (el pool es chico: una conexión pedida adentro de otra puede trabar a todos).
export async function numeros(clientId) {
  const { rows } = await asRole('mailgw_app', clientId, (c) => c.query(
    `select campana_id, count(*)::int as prospectos,
            count(*) filter (where estado in ('respondio', 'positivo', 'en_crm'))::int as respondieron
       from sdr.prospecto where client_id = $1 group by campana_id`, [clientId]));
  return Object.fromEntries(rows.map((r) => [r.campana_id, r]));
}

// Sin los números de personas: los suma conNumeros, afuera de la transacción del panel.
export async function listar(c, clientId, { esBigua }) {
  const cfg = await contexto(c, clientId);
  const { rows } = await c.query(
    `select ${COLS},
            (select coalesce(array_agg(a.email order by a.email), '{}') from sdr.campana_buzon b
               join mailgw.account a on a.id = b.account_id and a.client_id = b.client_id
              where b.client_id = k.client_id and b.campana_id = k.id) as buzones_emails,
            (select array_agg(b.account_id) from sdr.campana_buzon b
              where b.client_id = k.client_id and b.campana_id = k.id) as buzones
       from sdr.campana k where client_id = $1
      order by case estado when 'activa' then 0 when 'pausada' then 1 when 'borrador' then 2 else 3 end, creado_at`,
    [clientId]);
  const campanas = rows.map(({ ajustes, buzones, ...r }) => ({
    ...publica(r),
    pendientes: r.estado === 'terminada' ? 0 : faltantesParaActivar({ ...r, ajustes, buzones: buzones ?? [] }, cfg.ajustes).length,
  }));
  return {
    campanas,
    modo: cfg.modo,
    tope_cuentas_dia: cfg.tope_cuentas_dia,
    cuentas_activas: campanas.filter((x) => x.estado === 'activa').reduce((s, x) => s + x.cuentas_por_dia, 0),
    tipos: Object.entries(TIPOS).map(([clave, t]) => ({ clave, titulo: t.titulo })),
    // Decisión 1: el cliente crea borradores en los dos modos.
    puede_crear: true,
    puede_activar: esBigua || cfg.modo === 'autogestionado',
  };
}

export async function conNumeros(clientId, lista) {
  const n = await numeros(clientId);
  return {
    ...lista,
    campanas: lista.campanas.map((k) => ({ ...k, prospectos: n[k.id]?.prospectos ?? 0, respondieron: n[k.id]?.respondieron ?? 0 })),
  };
}

export async function ver(c, clientId, id, { esBigua }) {
  const cfg = await contexto(c, clientId);
  const k = await fila(c, clientId, id);
  const permiso = permisoDe(esBigua, cfg);
  const historial = (await c.query(
    `select id, at, por_email, por_rol, cambios, nota from sdr.ajustes_historial
      where client_id = $1 and campana_id = $2 order by id desc limit 30`, [clientId, id])).rows;
  return {
    campana: publica(k),
    bloques: BLOQUES_CAMPANA,
    campos: CAMPOS_CAMPANA.map((x) => ({ ...x, editable: k.estado !== 'terminada' && editable(x, permiso) })),
    columnas: COLUMNAS_CAMPANA.map((x) => ({
      ...x, editable: k.estado !== 'terminada' && editable(x, permiso) && !(x.clave === 'tipo' && k.estado !== 'borrador'),
    })),
    tipos: Object.entries(TIPOS).map(([clave, t]) => ({ clave, titulo: t.titulo, llamado_accion: t.llamado_accion })),
    // Lo que la campaña hereda de Empresa, para mostrarlo atenuado («De Empresa: …»).
    empresa: cfg.ajustes ?? {},
    efectivos: conTitulos(ajustesEfectivos(cfg.ajustes, k.ajustes, k.tipo)),
    faltantes: k.estado === 'terminada' ? [] : faltantesParaActivar(k, cfg.ajustes),
    buzones_disponibles: await buzonesDelCliente(c, clientId),
    modo: cfg.modo,
    tope_cuentas_dia: cfg.tope_cuentas_dia,
    otras_activas: await otrasActivas(c, clientId, id),
    historial: historial.map((r) => ({ ...r, id: Number(r.id), cambios_titulos: r.cambios.map(tituloCampana) })),
  };
}

// En lo que leen los bots, cada clave con su título general (el de Empresa): las listas que se
// suman no son «de esta campaña».
const conTitulos = (e) => ({ ...e, titulos: Object.fromEntries(Object.keys(e.valores).map((k) => [k, tituloDe(k)])) });

// ---------------------------------------------------------------- escritura

// Una clave legible y única a partir del nombre: «Webinar automatización» → webinar-automatizacion.
async function claveNueva(c, clientId, nombre) {
  let base = nombre.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34).replace(/-+$/, '');
  if (base.length < 2) base = 'campana';
  if (base === 'principal') base = 'principal-2';
  const usadas = new Set((await c.query(
    `select clave from sdr.campana where client_id = $1 and (clave = $2 or clave like $2 || '-%')`, [clientId, base])).rows.map((r) => r.clave));
  if (!usadas.has(base)) return base;
  for (let i = 2; ; i += 1) if (!usadas.has(`${base}-${i}`)) return `${base}-${i}`;
}

async function ponerBuzones(c, clientId, id, ids) {
  const delCliente = new Set((await buzonesDelCliente(c, clientId)).map((b) => b.id));
  const ajenos = ids.filter((x) => !delCliente.has(x));
  if (ajenos.length) throw invalido('Hay buzones que no son de este cliente.');
  await c.query(`delete from sdr.campana_buzon where client_id = $1 and campana_id = $2 and account_id <> all($3::uuid[])`, [clientId, id, ids]);
  await c.query(
    `insert into sdr.campana_buzon (client_id, campana_id, account_id) select $1, $2, unnest($3::uuid[]) on conflict do nothing`,
    [clientId, id, ids]);
}

async function historial(c, clientId, id, ajustes, cambios, user, nota) {
  await c.query(
    `insert into sdr.ajustes_historial (client_id, campana_id, ajustes, cambios, por_email, por_rol, nota) values ($1, $2, $3, $4, $5, $6, $7)`,
    [clientId, id, JSON.stringify(ajustes), cambios, user.email, user.role, nota ?? null]);
}

// Separa lo que llega del panel: ajustes de la campaña por un lado, columnas por el otro.
function partir(datos) {
  if (!datos || typeof datos !== 'object' || Array.isArray(datos)) throw invalido('Faltan los datos de la campaña.');
  const { ajustes, nota, ...columnas } = datos;
  if (ajustes !== undefined && (typeof ajustes !== 'object' || ajustes === null || Array.isArray(ajustes))) {
    throw invalido('«ajustes» va como un objeto.');
  }
  if (nota !== undefined && (typeof nota !== 'string' || nota.length > 300)) throw invalido('La nota va en texto, hasta 300 caracteres.');
  return { ajustes: ajustes ?? {}, columnas, nota };
}

// Crea una campaña en borrador. datos: { nombre, tipo?, ...columnas, ajustes? }.
export async function crear(c, clientId, datos, { user, esBigua }) {
  const cfg = await contexto(c, clientId, { bloquear: true });
  const permiso = permisoDe(esBigua, cfg);
  const { ajustes: cambiosAjustes, columnas, nota } = partir(datos);
  if (!('tipo' in columnas)) columnas.tipo = 'prospeccion';
  // El tipo de una campaña nueva lo elige quien la crea; después lo cambia Biguá.
  const cols = aplicarColumnasCampana(null, columnas, { ...permiso, esBigua: true, autogestion: true }, { tope: cfg.tope_cuentas_dia });
  for (const k of Object.keys(columnas)) {
    if (k === 'nombre' || k === 'tipo') continue;
    aplicarColumnasCampana({ estado: 'borrador' }, { [k]: columnas[k] }, permiso, { tope: cfg.tope_cuentas_dia });
  }
  const ajustes = aplicarCambiosCampana({}, cambiosAjustes, permiso, { empresa: cfg.ajustes });
  const { buzones, ...resto } = cols;
  const clave = await claveNueva(c, clientId, cols.nombre);
  const nombres = columnasSql(resto);
  const { rows } = await c.query(
    `insert into sdr.campana (client_id, clave, ajustes, ${nombres.join(', ')})
     values ($1, $2, $3, ${nombres.map((_, i) => `$${i + 4}`).join(', ')}) returning id`,
    [clientId, clave, JSON.stringify(ajustes), ...nombres.map((k) => resto[k])]);
  const id = rows[0].id;
  if (buzones?.length) await ponerBuzones(c, clientId, id, buzones);
  await historial(c, clientId, id, ajustes, ['creada', ...Object.keys(cols), ...Object.keys(ajustes)], user, nota);
  return { id, clave, cambios: ['creada'] };
}

// Edita una campaña: columnas (nombre, estado, fechas, buzones, volumen…) y ajustes.
export async function guardar(c, clientId, id, datos, { user, esBigua }) {
  const cfg = await contexto(c, clientId, { bloquear: true });
  const actual = await fila(c, clientId, id, { bloquear: true });
  const permiso = permisoDe(esBigua, cfg);
  const { ajustes: cambiosAjustes, columnas, nota } = partir(datos);

  if (actual.estado === 'terminada' && Object.keys(cambiosAjustes).length) {
    throw invalido('Una campaña terminada no se edita: duplicala.');
  }
  const tope = { tope: cfg.tope_cuentas_dia, otrasActivas: await otrasActivas(c, clientId, id) };
  const cols = aplicarColumnasCampana(actual, columnas, permiso, { ...tope, controlarTope: false });
  const ajustes = aplicarCambiosCampana(actual.ajustes, cambiosAjustes, permiso, { empresa: cfg.ajustes });
  const cambiosA = diferencias(actual.ajustes, ajustes);
  const cambiosC = Object.keys(cols);
  if (!cambiosA.length && !cambiosC.length) return { cambios: [] };

  // Para activar no puede faltar nada. Una campaña que ya está activa puede tener pendientes (la
  // «principal» migrada, por ejemplo), pero un cambio no puede sumarle pendientes nuevos.
  const despues = { ...actual, ...cols, ajustes };
  if (despues.estado === 'activa') {
    const antes = new Set(actual.estado === 'activa' ? faltantesParaActivar(actual, cfg.ajustes).map((f) => f.clave) : []);
    const faltan = faltantesParaActivar(despues, cfg.ajustes).filter((f) => !antes.has(f.clave));
    const texto = () => faltan.map((f) => f.mensaje).join(' ');
    if (faltan.length && cols.estado === 'activa') throw invalido(`No se puede activar la campaña. ${texto()}`);
    if (faltan.length) throw invalido(`No se guardó: la campaña está activa. ${texto()}`);
  }
  controlarTope(actual, cols, tope);

  const { buzones, ...resto } = cols;
  const nombresSet = columnasSql(resto);
  const sets = nombresSet.map((k, i) => `${k} = $${i + 4}`);
  if (cols.estado === 'terminada') sets.push('terminada_at = now()');
  await c.query(
    `update sdr.campana set ajustes = $3, actualizado_at = now()${sets.length ? `, ${sets.join(', ')}` : ''}
      where client_id = $1 and id = $2`,
    [clientId, id, JSON.stringify(ajustes), ...nombresSet.map((k) => resto[k])]);
  if (buzones !== undefined) await ponerBuzones(c, clientId, id, buzones ?? []);
  await historial(c, clientId, id, ajustes, [...cambiosC, ...cambiosA], user, nota);
  return { cambios: [...cambiosC, ...cambiosA], estado_antes: actual.estado, estado: despues.estado, nombre: despues.nombre };
}

// Una copia en borrador (decisión 13: una terminada no se reactiva, se duplica). Copia los ajustes,
// los buzones, el tipo y el volumen; no las fechas ni la campaña de Dripify, que son de cada una.
export async function duplicar(c, clientId, id, { nombre } = {}, { user }) {
  await contexto(c, clientId, { bloquear: true });
  const k = await fila(c, clientId, id);
  const nuevoNombre = (typeof nombre === 'string' && nombre.trim()) ? nombre.trim().slice(0, 120) : `${k.nombre} (copia)`.slice(0, 120);
  const clave = await claveNueva(c, clientId, nuevoNombre);
  const { rows } = await c.query(
    `insert into sdr.campana (client_id, clave, nombre, tipo, ajustes, cuentas_por_dia, duplicada_de)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [clientId, clave, nuevoNombre, k.tipo, JSON.stringify(k.ajustes), k.cuentas_por_dia, k.id]);
  const nuevo = rows[0].id;
  if (k.buzones.length) await ponerBuzones(c, clientId, nuevo, k.buzones);
  await historial(c, clientId, nuevo, k.ajustes, ['creada'], user, `Copia de «${k.nombre}»`);
  return { id: nuevo, clave, de: k.nombre };
}
