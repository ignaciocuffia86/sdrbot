// Carga en el CRM, capa 1 (docs/23): el gateway escribe por código el mínimo de cada positivo.
//
// Cómo entra una carga a la cola (sdr.crm_carga, una fila por prospecto):
//   - al aprobarse una respuesta_positivo (sdr/store.mjs, aprobar), en la misma transacción;
//   - a pedido: crm_cargar (el orquestador) o el botón del panel.
//
// Cómo sale: el reloj (POST /cron/correo, cada minuto) llama procesarCola. Cada carga hace, en
// orden, contacto → empresa → nota → tarea, y guarda lo que creó después de cada paso: si se
// corta, el reintento sigue desde ahí sin duplicar. Errores de red o de HubSpot se reintentan con
// espera creciente; un token que no sirve pausa la conexión sin gastar intentos; un dato que
// HubSpot no acepta bloquea la carga con el motivo, para que Biguá lo arregle y la reintente.
//
// Reglas de lo que se escribe (docs/11 §6.2): nunca se borra; en un contacto que ya existía sólo
// se completan propiedades vacías y no se cambia el dueño.

import { asRole, asOwner } from '../store.mjs';
import { decryptSecret, encryptSecret } from '../crypto.mjs';
import { GatewayError } from '../errors.mjs';
import { insertarEvento, aplicarEvento, versionActual, pedir, errorsSdr } from './store.mjs';
import * as hubspot from './hubspot.mjs';

const asClient = (clientId, fn) => asRole('mailgw_app', clientId, fn);

export const aadCrm = (clientId) => `crm:${clientId}`;
// Minutos de espera después de cada intento fallido; pasados todos, la carga queda en error.
export const ESPERAS_MIN = [1, 5, 30, 120, 360, 720];
const TOMADA_VENCE_MIN = 10;
const POR_VUELTA = 20;
const META = { bot: 'gateway', tarea: 'crm' };

export const errorsCrm = {
  sinConfigurar: () => new GatewayError('crm_sin_configurar',
    'Este cliente no tiene el CRM conectado. Se conecta en el panel: Canales → CRM.', 503),
  sinToken: () => new GatewayError('crm_sin_token', 'Falta el token de la app privada de HubSpot.', 409),
  hubspot: (msg) => new GatewayError('crm_error', msg, 502),
  invalido: (msg) => new GatewayError('invalid_request', msg, 400),
};

// Un problema con los datos de la carga, no con HubSpot: la carga se bloquea con este motivo.
class Bloqueo extends Error {}

// ---------------------------------------------------------------- configuración

async function verEn(c, clientId) {
  const { rows } = await c.query(`select * from sdr.crm_conexion where client_id = $1`, [clientId]);
  const r = rows[0];
  if (!r) return null;
  return {
    proveedor: r.proveedor, token: Boolean(r.token_enc), portal_id: r.portal_id, origen_campo: r.origen_campo,
    origen_valor: r.origen_valor, dueno_defecto: r.dueno_defecto, campos_fijos: r.campos_fijos, estado: r.estado,
    tope_dia: r.tope_dia, ultimo_ok_at: r.ultimo_ok_at, ultimo_error: r.ultimo_error, actualizado_at: r.actualizado_at,
  };
}

// Lo que ve el panel: nunca el token.
export const ver = (c, clientId) => verEn(c, clientId);

// Guarda la conexión. Si cambia el origen o el dueño, se validan contra el portal del cliente
// antes de guardar: un valor que HubSpot no acepta bloquearía cada carga.
export async function configurar(clientId, d, { fetchImpl } = {}) {
  const actual = await asOwner((c) => c.query(`select * from sdr.crm_conexion where client_id = $1`, [clientId])).then((r) => r.rows[0]);
  const tokenEnc = d.token ? encryptSecret(d.token.trim(), aadCrm(clientId)) : actual?.token_enc ?? null;
  const campo = d.origen_campo === undefined ? actual?.origen_campo ?? null : d.origen_campo || null;
  const valor = d.origen_valor === undefined ? actual?.origen_valor ?? null : d.origen_valor || null;
  const dueno = d.dueno_defecto === undefined ? actual?.dueno_defecto ?? null : d.dueno_defecto || null;
  const fijos = d.campos_fijos === undefined ? actual?.campos_fijos ?? {} : d.campos_fijos;
  if (campo && !valor) throw errorsCrm.invalido('Elegí también el valor de la propiedad de origen.');
  const validar = Boolean(d.token) || campo !== (actual?.origen_campo ?? null) || valor !== (actual?.origen_valor ?? null)
    || dueno !== (actual?.dueno_defecto ?? null) || JSON.stringify(fijos) !== JSON.stringify(actual?.campos_fijos ?? {});
  let portal = d.token ? null : actual?.portal_id ?? null;
  if (validar && tokenEnc && (campo || dueno || Object.keys(fijos).length)) {
    const hs = hubspot.cliente(decryptSecret(tokenEnc, aadCrm(clientId)), { fetchImpl });
    const problemas = [];
    try {
      const [props, duenos, cuenta] = await Promise.all([hs.propiedadesContacto(), dueno ? hs.duenos() : [], portalDe(hs)]);
      portal = cuenta?.portalId ? String(cuenta.portalId) : portal;
      problemas.push(...problemasDeMapeo({ origen_campo: campo, origen_valor: valor, campos_fijos: fijos }, props));
      if (dueno && !duenos.some((o) => String(o.id) === String(dueno))) problemas.push(`No hay un dueño con id ${dueno} en HubSpot.`);
    } catch (e) {
      if (e instanceof hubspot.CrmError) throw errorsCrm.hubspot(e.message);
      throw e;
    }
    if (problemas.length) throw errorsCrm.invalido(problemas.join(' '));
  }
  await asOwner((c) => c.query(
    `insert into sdr.crm_conexion (client_id, token_enc, portal_id, origen_campo, origen_valor, dueno_defecto, campos_fijos, estado, tope_dia)
     values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, 'activa'), coalesce($9, 50))
     on conflict (client_id) do update set token_enc = excluded.token_enc, portal_id = excluded.portal_id,
       origen_campo = excluded.origen_campo, origen_valor = excluded.origen_valor, dueno_defecto = excluded.dueno_defecto,
       campos_fijos = excluded.campos_fijos,
       estado = coalesce($8, case when $10 then 'activa' else sdr.crm_conexion.estado end),
       ultimo_error = case when $10 then null else sdr.crm_conexion.ultimo_error end,
       tope_dia = coalesce($9, sdr.crm_conexion.tope_dia), actualizado_at = now()`,
    [clientId, tokenEnc, portal, campo, valor, dueno, JSON.stringify(fijos), d.estado ?? null, d.tope_dia ?? null, Boolean(d.token)]));
  return asOwner((c) => verEn(c, clientId));
}

const PROPIEDADES_TEXTO = new Set(['string', 'number', 'date', 'datetime']);
const editableProp = (p) => !p.hidden && !p.calculated && !p.modificationMetadata?.readOnlyValue;

function problemasDeMapeo(cx, props) {
  const out = [];
  const porNombre = new Map(props.map((p) => [p.name, p]));
  const revisar = (nombre, valor, que) => {
    const p = porNombre.get(nombre);
    if (!p) return out.push(`${que}: el contacto de HubSpot no tiene la propiedad «${nombre}».`);
    if (!editableProp(p)) return out.push(`${que}: la propiedad «${nombre}» es de sólo lectura en HubSpot.`);
    if (p.options?.length && ['enumeration', 'bool'].includes(p.type)) {
      const valores = String(valor).split(';');
      const faltan = valores.filter((v) => !p.options.some((o) => o.value === v));
      if (faltan.length) out.push(`${que}: «${faltan.join(', ')}» no es un valor de «${p.label ?? nombre}» (valen: ${p.options.map((o) => o.value).join(', ')}).`);
    } else if (!PROPIEDADES_TEXTO.has(p.type) && !['enumeration', 'bool'].includes(p.type)) {
      out.push(`${que}: la propiedad «${nombre}» es de un tipo que no se puede llenar con un valor fijo (${p.type}).`);
    }
    return null;
  };
  if (cx.origen_campo) revisar(cx.origen_campo, cx.origen_valor, 'Origen');
  for (const [k, v] of Object.entries(cx.campos_fijos ?? {})) {
    if (MINIMO_PROPS.includes(k)) out.push(`Campos fijos: «${k}» ya lo completa la carga.`);
    else revisar(k, v, 'Campos fijos');
  }
  return out;
}

export async function claves() {
  return (await asOwner((c) => c.query(`select client_id, token_enc from sdr.crm_conexion where token_enc is not null`))).rows;
}

export async function setClave(clientId, enc) {
  await asOwner((c) => c.query(`update sdr.crm_conexion set token_enc = $2 where client_id = $1`, [clientId, enc]));
}

async function conexion(c, clientId) {
  const { rows } = await c.query(`select * from sdr.crm_conexion where client_id = $1`, [clientId]);
  if (!rows[0]) throw errorsCrm.sinConfigurar();
  return rows[0];
}

const hsDe = (cx, fetchImpl) => {
  if (!cx.token_enc) throw errorsCrm.sinToken();
  return hubspot.cliente(decryptSecret(cx.token_enc, aadCrm(cx.client_id)), { fetchImpl });
};

// El número de portal sólo sirve para armar el enlace al contacto: si la app privada no puede leer
// los datos de la cuenta, se sigue sin él.
async function portalDe(hs) {
  try {
    return await hs.cuenta();
  } catch (e) {
    if (e instanceof hubspot.CrmError && ['permisos', 'no_existe'].includes(e.tipo)) return null;
    throw e;
  }
}

async function anotar(clientId, cambios) {
  const sets = [];
  const vals = [clientId];
  for (const [k, v] of Object.entries(cambios)) { vals.push(v); sets.push(`${k} = $${vals.length}`); }
  await asClient(clientId, (c) => c.query(`update sdr.crm_conexion set ${sets.join(', ')} where client_id = $1`, vals)).catch(() => {});
}

// Probar: el token entra, los permisos alcanzan y el mapeo vale. Devuelve los dueños y las
// propiedades del contacto para que el panel ofrezca elegir el origen y el dueño por defecto.
export async function probar(clientId, { fetchImpl } = {}) {
  const cx = await asOwner((c) => conexion(c, clientId));
  const hs = hsDe(cx, fetchImpl);
  const problemas = [];
  let cuenta = null;
  let duenos = [];
  let props = [];
  try {
    [duenos, props, cuenta] = await Promise.all([hs.duenos(), hs.propiedadesContacto(), portalDe(hs)]);
    await hs.buscarEmpresas('ejemplo.invalid'); // lectura de empresas: el permiso que más se olvida
  } catch (e) {
    if (!(e instanceof hubspot.CrmError)) throw e;
    problemas.push(e.message);
    await anotar(clientId, { ultimo_error: e.message.slice(0, 500), ...(['credencial', 'permisos'].includes(e.tipo) ? { estado: 'credencial_vencida' } : {}) });
  }
  if (!problemas.length) {
    problemas.push(...problemasDeMapeo(cx, props));
    if (cx.dueno_defecto && !duenos.some((o) => String(o.id) === String(cx.dueno_defecto))) {
      problemas.push(`El dueño por defecto (${cx.dueno_defecto}) ya no está en HubSpot.`);
    }
    await anotar(clientId, { ultimo_ok_at: new Date(), ultimo_error: null, portal_id: cuenta?.portalId ? String(cuenta.portalId) : cx.portal_id,
      ...(cx.estado === 'credencial_vencida' ? { estado: 'activa' } : {}) });
  }
  const avisos = [];
  if (!cx.dueno_defecto) avisos.push('Sin dueño por defecto: a un contacto nuevo la tarea le llega sin asignar.');
  if (!cx.origen_campo) avisos.push('Sin propiedad de origen: que vino del SDR queda sólo en la nota.');
  return {
    listo: problemas.length === 0,
    problemas,
    avisos,
    portal_id: cuenta?.portalId ? String(cuenta.portalId) : cx.portal_id,
    duenos: duenos.map((o) => ({ id: String(o.id), nombre: [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email, email: o.email })),
    propiedades: props.filter(editableProp).filter((p) => p.type === 'enumeration' || p.type === 'string' || p.type === 'bool')
      .map((p) => ({ name: p.name, label: p.label ?? p.name, type: p.type, options: (p.options ?? []).filter((o) => !o.hidden).map((o) => ({ value: o.value, label: o.label })) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

// ---------------------------------------------------------------- la cola

export async function encolar(clientId, prospectoId, { motivo = 'pedido', pedida_por = null, aprobacion_id = null } = {}) {
  return asClient(clientId, async (c) => {
    await conexion(c, clientId);
    const p = (await c.query(`select id, estado from sdr.prospecto where client_id = $1 and id = $2`, [clientId, prospectoId])).rows[0];
    if (!p) throw errorsSdr.noExiste(`el prospecto ${prospectoId}`);
    if (p.estado === 'baja') throw errorsCrm.invalido('Ese prospecto pidió la baja: no se carga en el CRM.');
    const { rows } = await c.query(
      `insert into sdr.crm_carga (client_id, prospecto_id, motivo, aprobacion_id, pedida_por) values ($1, $2, $3, $4, $5)
       on conflict (client_id, prospecto_id) do update
         set estado = 'pendiente', intentos = 0, proximo_intento = now(), error = null, pedida_por = excluded.pedida_por
         where sdr.crm_carga.estado in ('error', 'bloqueada')
       returning *, (xmax = 0) as nueva`, [clientId, prospectoId, motivo, aprobacion_id, pedida_por]);
    if (rows.length) return { carga: publica(rows[0]), aviso: rows[0].nueva ? 'En cola: se carga en el CRM en el próximo minuto.' : 'Vuelve a la cola: se reintenta en el próximo minuto.' };
    const ya = (await c.query(`select * from sdr.crm_carga where client_id = $1 and prospecto_id = $2`, [clientId, prospectoId])).rows[0];
    return { carga: publica(ya), aviso: ya.estado === 'hecha' ? 'Ya está cargado en el CRM.' : 'Ya está en la cola.' };
  });
}

// Reintentar una carga en error o bloqueada (botón del panel).
export async function reintentar(clientId, id, porEmail) {
  return asClient(clientId, async (c) => {
    const { rows } = await c.query(
      `update sdr.crm_carga set estado = 'pendiente', intentos = 0, proximo_intento = now(), error = null, pedida_por = coalesce($3, pedida_por)
        where client_id = $1 and id = $2 and estado in ('error', 'bloqueada') returning *`, [clientId, id, porEmail ?? null]);
    if (!rows.length) throw new GatewayError('not_found', 'No hay una carga con error o bloqueada con ese id.', 404);
    return publica(rows[0]);
  });
}

function publica(r, portalId) {
  return {
    id: Number(r.id), prospecto_id: r.prospecto_id, motivo: r.motivo, estado: r.estado, intentos: r.intentos,
    proximo_intento: ['pendiente', 'en_curso'].includes(r.estado) ? r.proximo_intento : null, error: r.error,
    crm_ids: r.crm_ids, pedida_por: r.pedida_por, creado_at: r.creado_at, hecha_at: r.hecha_at,
    ...(portalId !== undefined ? { url: hubspot.urlContacto(portalId, r.crm_ids?.contacto) } : {}),
    ...(r.nombre !== undefined ? { nombre: r.nombre, email: r.email, empresa: r.empresa } : {}),
  };
}

// Las cargas recientes y los positivos que no tienen una (panel y orquestador).
export async function cargas(clientId, { estado, limite = 50 } = {}) {
  return asClient(clientId, async (c) => {
    const cx = (await c.query(`select portal_id from sdr.crm_conexion where client_id = $1`, [clientId])).rows[0];
    const { rows } = await c.query(
      `select k.*, p.nombre, p.email, u.nombre as empresa from sdr.crm_carga k
         join sdr.prospecto p on p.id = k.prospecto_id and p.client_id = k.client_id
         left join sdr.cuenta u on u.id = p.cuenta_id and u.client_id = p.client_id
        where k.client_id = $1 and ($2::text is null or k.estado = $2) order by k.id desc limit $3`,
      [clientId, estado ?? null, limite]);
    const sinCarga = (await c.query(
      `select p.id, p.nombre, p.email, u.nombre as empresa, p.actualizado_at from sdr.prospecto p
         left join sdr.cuenta u on u.id = p.cuenta_id and u.client_id = p.client_id
        where p.client_id = $1 and p.estado = 'positivo'
          and not exists (select 1 from sdr.crm_carga k where k.client_id = p.client_id and k.prospecto_id = p.id)
        order by p.actualizado_at desc limit 50`, [clientId])).rows;
    const conteo = Object.fromEntries((await c.query(
      `select estado, count(*)::int as n from sdr.crm_carga where client_id = $1 group by estado`, [clientId])).rows.map((r) => [r.estado, r.n]));
    return { cargas: rows.map((r) => publica(r, cx?.portal_id ?? null)), positivos_sin_cargar: sinCarga, conteo };
  });
}

// Para el resumen del panel.
export async function estado(clientId) {
  return asClient(clientId, async (c) => {
    const cx = (await c.query(`select * from sdr.crm_conexion where client_id = $1`, [clientId])).rows[0];
    if (!cx) return null;
    const n = (await c.query(
      `select count(*) filter (where estado in ('pendiente', 'en_curso'))::int as en_cola,
              count(*) filter (where estado in ('error', 'bloqueada'))::int as con_problema,
              count(*) filter (where estado = 'hecha' and hecha_at > now() - interval '7 days')::int as semana
         from sdr.crm_carga where client_id = $1`, [clientId])).rows[0];
    return { proveedor: cx.proveedor, token: Boolean(cx.token_enc), estado: cx.estado, ultimo_error: cx.ultimo_error,
      ultimo_ok_at: cx.ultimo_ok_at, ...n };
  });
}

// ---------------------------------------------------------------- qué se escribe

const MINIMO_PROPS = ['email', 'firstname', 'lastname', 'jobtitle', 'company', 'hubspot_owner_id'];
const CANALES = { mail: 'mail', linkedin: 'LinkedIn', whatsapp: 'WhatsApp' };

async function datosDe(c, clientId, prospectoId, aprobacionId) {
  const p = (await c.query(`select * from sdr.prospecto where client_id = $1 and id = $2`, [clientId, prospectoId])).rows[0];
  if (!p) throw errorsSdr.noExiste(`el prospecto ${prospectoId}`);
  const cuenta = p.cuenta_id
    ? (await c.query(`select nombre, dominio, tesis from sdr.cuenta where client_id = $1 and id = $2`, [clientId, p.cuenta_id])).rows[0] ?? null
    : null;
  const respuesta = (await c.query(
    `select * from (
       (select texto, 'mail' as canal, creado_at as at from sdr.correo
         where client_id = $1 and prospecto_id = $2 and tipo = 'respuesta' and texto is not null order by id desc limit 1)
       union all
       (select texto, 'linkedin', coalesce(enviado_at, creado_at) from sdr.linkedin_respuesta
         where client_id = $1 and prospecto_id = $2 and texto is not null order by id desc limit 1)) r
     order by at desc limit 1`, [clientId, prospectoId])).rows[0] ?? null;
  const positivo = (await c.query(
    `select datos, canal, at from sdr.evento where client_id = $1 and prospecto_id = $2 and tipo = 'positivo' order by id desc limit 1`,
    [clientId, prospectoId])).rows[0] ?? null;
  const aprobacion = aprobacionId
    ? (await c.query(`select decision_contenido, contenido from sdr.aprobacion where client_id = $1 and id = $2`, [clientId, aprobacionId])).rows[0] ?? null
    : null;
  const cliente = (await c.query(`select name from mailgw.client where id = $1`, [clientId])).rows[0];
  return { p, cuenta, respuesta, positivo, aprobacion, cliente: cliente?.name ?? clientId };
}

function partirNombre(nombre) {
  const partes = String(nombre ?? '').trim().split(/\s+/).filter(Boolean);
  return { firstname: partes[0] ?? '', lastname: partes.slice(1).join(' ') };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const recortar = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ''));
const fechaCorta = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

function resumenPositivo(d) {
  const x = d.positivo?.datos ?? {};
  return x.resumen ?? x.que_pide ?? x.texto ?? x.clasificacion ?? null;
}

// El día hábil siguiente, a las 12:00 UTC (las 9 en Argentina).
export function vencimientoTarea(desde = new Date()) {
  const d = new Date(Date.UTC(desde.getUTCFullYear(), desde.getUTCMonth(), desde.getUTCDate(), 12));
  do d.setUTCDate(d.getUTCDate() + 1); while ([0, 6].includes(d.getUTCDay()));
  return d;
}

// El mínimo, armado a partir del registro. Es lo mismo que muestra la vista previa.
export function armar(d, cx, { ahora = new Date() } = {}) {
  const { firstname, lastname } = partirNombre(d.p.nombre);
  const contacto = { email: d.p.email ?? null, firstname, lastname, jobtitle: d.p.cargo ?? '', company: d.cuenta?.nombre ?? '' };
  if (cx.origen_campo) contacto[cx.origen_campo] = cx.origen_valor;
  for (const [k, v] of Object.entries(cx.campos_fijos ?? {})) contacto[k] = String(v);
  for (const k of Object.keys(contacto)) if (contacto[k] === '' || contacto[k] === null) delete contacto[k];

  const canal = CANALES[d.respuesta?.canal ?? d.positivo?.canal] ?? d.respuesta?.canal ?? d.positivo?.canal ?? 'otro canal';
  const que = resumenPositivo(d);
  const aprobada = d.aprobacion?.decision_contenido?.texto ?? d.aprobacion?.contenido?.texto ?? null;
  const parrafos = [
    `<p><strong>Positivo del SDR Bot de Biguá</strong> para ${esc(d.cliente)} · por ${esc(canal)}${d.respuesta?.at ? ` · ${esc(fechaCorta(d.respuesta.at))}` : ''}</p>`,
    que ? `<p><strong>Qué pide:</strong> ${esc(que)}</p>` : '',
    d.respuesta?.texto ? `<p><strong>Lo que respondió:</strong></p><blockquote>${esc(recortar(d.respuesta.texto, 4000)).replace(/\n/g, '<br>')}</blockquote>` : '',
    aprobada ? `<p><strong>Respuesta aprobada para enviarle:</strong></p><blockquote>${esc(recortar(aprobada, 3000)).replace(/\n/g, '<br>')}</blockquote>` : '',
    d.cuenta?.tesis ? `<p><strong>Por qué lo contactamos:</strong> ${esc(recortar(d.cuenta.tesis, 600))}</p>` : '',
    `<p>Registro de prospección: ${esc(d.p.id)}</p>`,
  ].filter(Boolean);
  const empresaTxt = d.cuenta?.nombre ? ` (${d.cuenta.nombre})` : '';
  const tarea = {
    hs_task_subject: recortar(`Responder a ${d.p.nombre}${empresaTxt}: positivo del SDR`, 250),
    hs_task_body: [
      `${d.p.nombre}${d.p.cargo ? `, ${d.p.cargo}` : ''}${empresaTxt} respondió por ${canal}.`,
      que ? `Qué pide: ${que}` : null,
      d.respuesta?.texto ? `Lo que escribió: «${recortar(d.respuesta.texto.replace(/\s+/g, ' '), 500)}»` : null,
      aprobada ? 'La respuesta aprobada está en la nota del contacto.' : null,
    ].filter(Boolean).join('\n'),
    hs_task_status: 'NOT_STARTED', hs_task_priority: 'HIGH', hs_task_type: 'TODO',
    hs_timestamp: vencimientoTarea(ahora).toISOString(),
  };
  return {
    buscar_por: d.p.email ?? null,
    contacto,
    empresa: d.cuenta?.dominio ? { name: d.cuenta.nombre, domain: d.cuenta.dominio } : null,
    nota: { hs_note_body: parrafos.join(''), hs_timestamp: ahora.toISOString() },
    tarea,
  };
}

export async function vistaPrevia(clientId, prospectoId) {
  return asClient(clientId, async (c) => {
    const cx = await conexion(c, clientId);
    let id = prospectoId;
    if (!id) {
      id = (await c.query(
        `select id from sdr.prospecto where client_id = $1 and estado in ('positivo', 'en_crm') order by actualizado_at desc limit 1`,
        [clientId])).rows[0]?.id;
    }
    if (!id) return { ejemplo: true, ...armar(ejemplo(clientId), cx) };
    const carga = (await c.query(`select aprobacion_id from sdr.crm_carga where client_id = $1 and prospecto_id = $2`, [clientId, id])).rows[0];
    const d = await datosDe(c, clientId, id, carga?.aprobacion_id ?? null);
    return { ejemplo: false, prospecto_id: id, nombre: d.p.nombre, ...armar(d, cx), dueno: cx.dueno_defecto };
  });
}

const ejemplo = (clientId) => ({
  cliente: clientId,
  p: { id: '00000000-0000-0000-0000-000000000000', nombre: 'Laura Gómez', cargo: 'Gerente de QA', email: 'laura.gomez@ejemplo.com' },
  cuenta: { nombre: 'Ejemplo SA', dominio: 'ejemplo.com', tesis: 'Publicaron una búsqueda de QA Automation esta semana.' },
  respuesta: { texto: 'Hola, sí, nos interesa. ¿Podemos hablar el jueves?', canal: 'mail', at: new Date() },
  positivo: { datos: { resumen: 'Pide una reunión el jueves.' }, canal: 'mail' },
  aprobacion: { decision_contenido: { texto: 'Gracias, Laura. ¿Te sirve el jueves a las 11?' } },
});

// ---------------------------------------------------------------- el worker

// Una vuelta del reloj: toma cargas de a una mientras haya tiempo.
export async function procesarCola({ hasta = Date.now() + 15_000, fetchImpl } = {}) {
  const hechas = [];
  for (let i = 0; i < POR_VUELTA && Date.now() < hasta; i++) {
    const { rows } = await asOwner((c) => c.query(
      `update sdr.crm_carga k set estado = 'en_curso', tomada_at = now(), intentos = k.intentos + 1
        where k.id = (
          select k2.id from sdr.crm_carga k2 join sdr.crm_conexion x on x.client_id = k2.client_id
           where x.estado = 'activa' and x.token_enc is not null
             and ((k2.estado = 'pendiente' and k2.proximo_intento <= now())
               or (k2.estado = 'en_curso' and k2.tomada_at < now() - make_interval(mins => $1)))
           order by k2.proximo_intento, k2.id limit 1 for update of k2 skip locked)
        returning k.id, k.client_id`, [TOMADA_VENCE_MIN]));
    if (!rows.length) break;
    const { id, client_id: clientId } = rows[0];
    hechas.push({ cliente: clientId, carga: Number(id), ...(await cargarUna(clientId, Number(id), { fetchImpl })) });
  }
  return hechas;
}

async function guardarPaso(clientId, id, ids, cambio) {
  await asClient(clientId, (c) => c.query(
    `update sdr.crm_carga set crm_ids = crm_ids || $3::jsonb, cambios = cambios || $4::jsonb where client_id = $1 and id = $2`,
    [clientId, id, JSON.stringify(ids), JSON.stringify(cambio ? [cambio] : [])]));
}

const vacio = (v) => v === null || v === undefined || String(v).trim() === '';

export async function cargarUna(clientId, id, { fetchImpl } = {}) {
  let carga;
  let cx;
  let d;
  try {
    ({ carga, cx, d } = await asClient(clientId, async (c) => {
      const k = (await c.query(`select * from sdr.crm_carga where client_id = $1 and id = $2`, [clientId, id])).rows[0];
      const x = await conexion(c, clientId);
      const hechasDia = (await c.query(
        `select count(*)::int as n from sdr.crm_carga where client_id = $1 and estado = 'hecha' and hecha_at > now() - interval '24 hours'`,
        [clientId])).rows[0].n;
      return { carga: k, cx: { ...x, hechasDia }, d: await datosDe(c, clientId, k.prospecto_id, k.aprobacion_id) };
    }));
  } catch (e) {
    return fallar(clientId, id, e);
  }
  if (cx.estado !== 'activa') return devolver(clientId, id, 0, 'La conexión con el CRM no está activa.');
  if (cx.hechasDia >= cx.tope_dia) return devolver(clientId, id, 60, `Se llegó al tope de ${cx.tope_dia} cargas por día.`);
  try {
    if (!d.p.email) {
      throw new Bloqueo('El prospecto no tiene email y HubSpot lo usa para no duplicar. Completalo en el registro ' +
        '(registro_guardar_prospecto) o cargalo a mano, y reintentá.');
    }
    if (d.p.estado === 'baja') throw new Bloqueo('El prospecto pidió la baja: no se carga.');
    const hs = hsDe(cx, fetchImpl);
    const m = armar(d, cx);
    const ids = { ...carga.crm_ids };

    // 1. Contacto: se busca por email; si existe sólo se completan los vacíos.
    if (!ids.contacto) {
      const leer = [...new Set([...Object.keys(m.contacto), 'hubspot_owner_id'])];
      let existente = (await hs.buscarContactos(d.p.email, leer))[0] ?? null;
      let creado = null;
      if (!existente) {
        try {
          creado = await hs.crearContacto({ ...m.contacto, ...(cx.dueno_defecto ? { hubspot_owner_id: cx.dueno_defecto } : {}) });
        } catch (e) {
          // El buscador de HubSpot tarda unos segundos en ver un contacto nuevo: si otro lo creó
          // recién, el alta falla con 409 y dice cuál es.
          if (!(e instanceof hubspot.CrmError && e.tipo === 'conflicto' && e.existe_id)) throw e;
          existente = await hs.leerContacto(e.existe_id, leer);
        }
      }
      if (creado) {
        ids.contacto = String(creado.id);
        ids.dueno = cx.dueno_defecto ?? null;
        await guardarPaso(clientId, id, { contacto: ids.contacto, contacto_nuevo: true, dueno: ids.dueno },
          { objeto: 'contacto', id: ids.contacto, accion: 'creado', despues: { ...m.contacto, hubspot_owner_id: cx.dueno_defecto ?? null } });
      } else {
        const antes = existente.properties ?? {};
        const completar = Object.fromEntries(Object.entries(m.contacto).filter(([k]) => k !== 'email' && vacio(antes[k])));
        if (Object.keys(completar).length) await hs.actualizarContacto(existente.id, completar);
        ids.contacto = String(existente.id);
        ids.dueno = antes.hubspot_owner_id || cx.dueno_defecto || null;
        await guardarPaso(clientId, id, { contacto: ids.contacto, contacto_nuevo: false, dueno: ids.dueno },
          { objeto: 'contacto', id: ids.contacto, accion: Object.keys(completar).length ? 'completado' : 'sin_cambios',
            antes: Object.fromEntries(Object.keys(completar).map((k) => [k, antes[k] ?? null])), despues: completar });
      }
    }

    // 2. Empresa por dominio, asociada al contacto.
    if (m.empresa && !ids.empresa) {
      const existe = (await hs.buscarEmpresas(m.empresa.domain))[0] ?? null;
      const empresa = existe ?? await hs.crearEmpresa(m.empresa);
      await hs.asociarContactoEmpresa(ids.contacto, empresa.id);
      ids.empresa = String(empresa.id);
      await guardarPaso(clientId, id, { empresa: ids.empresa },
        { objeto: 'empresa', id: ids.empresa, accion: existe ? 'asociada' : 'creada', despues: existe ? null : m.empresa });
    }

    // 3. Nota con la respuesta. 4. Tarea para el dueño.
    if (!ids.nota) {
      const nota = await hs.crearNota(m.nota, ids.contacto, ids.empresa);
      ids.nota = String(nota.id);
      await guardarPaso(clientId, id, { nota: ids.nota }, { objeto: 'nota', id: ids.nota, accion: 'creada' });
    }
    if (!ids.tarea) {
      const tarea = await hs.crearTarea({ ...m.tarea, ...(ids.dueno ? { hubspot_owner_id: ids.dueno } : {}) }, ids.contacto, ids.empresa);
      ids.tarea = String(tarea.id);
      await guardarPaso(clientId, id, { tarea: ids.tarea }, { objeto: 'tarea', id: ids.tarea, accion: 'creada', dueno: ids.dueno });
    }

    const url = hubspot.urlContacto(cx.portal_id, ids.contacto);
    await asClient(clientId, async (c) => {
      await c.query(`update sdr.crm_carga set estado = 'hecha', hecha_at = now(), error = null where client_id = $1 and id = $2`, [clientId, id]);
      const e = { tipo: 'crm.cargado', prospecto_id: d.p.id, canal: 'crm', ref: ids.contacto,
        datos: { capa: 1, carga: id, motivo: carga.motivo, proveedor: 'hubspot', contacto_nuevo: ids.contacto_nuevo ?? null, ...ids, url } };
      await insertarEvento(c, clientId, e, { ...META, version: await versionActual(c, clientId) });
      await aplicarEvento(c, clientId, e);
      await c.query(`update sdr.crm_conexion set ultimo_ok_at = now(), ultimo_error = null where client_id = $1`, [clientId]);
    });
    return { estado: 'hecha', contacto: ids.contacto };
  } catch (e) {
    return fallar(clientId, id, e, d);
  }
}

// Vuelve a la cola sin gastar el intento (la conexión está pausada o se llegó al tope).
async function devolver(clientId, id, minutos, motivo) {
  await asClient(clientId, (c) => c.query(
    `update sdr.crm_carga set estado = 'pendiente', intentos = greatest(intentos - 1, 0), error = $3,
            proximo_intento = now() + make_interval(mins => $4) where client_id = $1 and id = $2`, [clientId, id, motivo, minutos]));
  return { estado: 'pendiente', motivo };
}

async function fallar(clientId, id, e, d) {
  const msg = String(e?.message ?? e).slice(0, 1000);
  if (e instanceof hubspot.CrmError && ['credencial', 'permisos'].includes(e.tipo)) {
    await anotar(clientId, { estado: 'credencial_vencida', ultimo_error: msg.slice(0, 500) });
    return devolver(clientId, id, 0, msg);
  }
  const bloquear = e instanceof Bloqueo || (e instanceof hubspot.CrmError && ['rechazo', 'no_existe', 'conflicto'].includes(e.tipo));
  const reintentable = !bloquear;
  const { rows } = await asClient(clientId, (c) => c.query(
    `update sdr.crm_carga
        set estado = case when $3 and intentos <= $4 then 'pendiente' when $3 then 'error' else 'bloqueada' end,
            proximo_intento = case when $3 and intentos <= $4
                                   then now() + make_interval(mins => ($5::int[])[intentos]) else proximo_intento end,
            error = $6
      where client_id = $1 and id = $2 returning estado, prospecto_id`,
    [clientId, id, reintentable, ESPERAS_MIN.length, ESPERAS_MIN, msg]));
  if (e instanceof hubspot.CrmError) await anotar(clientId, { ultimo_error: msg.slice(0, 500) });
  else if (!(e instanceof Bloqueo) && !(e instanceof GatewayError)) console.error('[mailgw] crm', e);
  const r = rows[0];
  if (r && r.estado !== 'pendiente') {
    // Que no quede en silencio: el orquestador se lo cuenta al operador.
    const nombre = d?.p?.nombre ?? 'un prospecto';
    await pedir(clientId, {
      para_bot: 'orquestador', prospecto_id: r.prospecto_id,
      que: `La carga en el CRM de ${nombre} ${r.estado === 'error' ? 'falló después de varios intentos' : 'quedó bloqueada'}: ${msg.slice(0, 600)}`,
      por_que: 'Contáselo al operador de Biguá. Se reintenta desde el panel (Canales → CRM) cuando esté resuelto.',
    }, META).catch((err) => console.error('[mailgw] crm pedido', err));
  }
  return { estado: r?.estado ?? 'error', error: msg };
}
