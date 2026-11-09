// LinkedIn por Dripify (etapa 3 de docs/09), desde el gateway.
//
// Cada cliente tiene su cuenta de Dripify y una campaña esqueleto: invitación con nota, mensaje 1
// cuando acepta y mensaje 2 unos días después. Todo el contenido son tres variables por persona
// (VARIABLES): el bot las escribe, el gateway las carga en la campaña por la API de Dripify
// (https://api.dripify.com, X-Api-Key) y documenta cada paso en el registro.
//
// Lo que vuelve:
//   - el webhook de la campaña (POST /hook/dripify/<cliente>/<secreto>), con la invitación, la
//     conexión, los mensajes y la primera respuesta;
//   - la lectura de conversaciones ya abiertas por la API (el reloj y linkedin_revisar), porque
//     Dripify avisa por webhook sólo la primera respuesta de cada persona.
//
// Freno cruzado: si alguien responde por mail o pide la baja, el gateway saca a esa persona de la
// campaña (lista negra de Dripify) para que LinkedIn no le siga escribiendo. Al revés, una
// respuesta por LinkedIn deja al prospecto en «respondio» y el gateway ya no deja salir mails de
// la secuencia (controlarDestinatarios).

import crypto from 'node:crypto';
import { asRole, asOwner } from '../store.mjs';
import { decryptSecret, encryptSecret, hashToken } from '../crypto.mjs';
import { GatewayError } from '../errors.mjs';
import { normalizeLinkedin } from './linkedin.mjs';
import * as noContactar from './no_contactar.mjs';
import { insertarEvento, aplicarEvento, versionActual, errorsSdr } from './store.mjs';

const asClient = (clientId, fn) => asRole('mailgw_app', clientId, fn);

export const VARIABLES = ['sdr_nota', 'sdr_mensaje1', 'sdr_mensaje2'];
const MENSAJE_MAX = 1000; // tope de un campo personalizado en Dripify
const TEXTO_MAX = 8000;
// Dripify: 60 pedidos por minuto y 5000 por día por key. El gateway se queda abajo.
export const CUPO = { minuto: 50, dia: 4500 };
// Una conversación abierta se vuelve a leer a lo sumo cada tantos minutos, y sólo si hubo
// movimiento por LinkedIn en los últimos días.
const RELEER_MIN = 15;
const DIAS_CONVERSACION = 30;
const CONVERSACIONES_POR_VUELTA = 10;
// Un freno que no encuentra a la persona en Dripify (la lista todavía se está procesando) se
// reintenta en cada vuelta del reloj durante este tiempo.
const FRENO_HORAS = 24;
const ESTADOS_CARGABLES = ['investigado', 'en_contacto', 'sin_respuesta'];

const base = () => (process.env.MAILGW_DRIPIFY_URL || 'https://api.dripify.com').replace(/\/+$/, '');
export const aadDripify = (clientId) => `dripify:${clientId}`;

export const errorsDripify = {
  sinConfigurar: () => new GatewayError('dripify_sin_configurar',
    'Este cliente no tiene Dripify configurado (API key y campaña). Lo carga Biguá en el panel, pestaña SDR.', 503),
  clave: () => new GatewayError('dripify_clave',
    'Dripify rechazó la API key. Hay que cargar la correcta en el panel (pestaña SDR, Dripify).', 502),
  sinApi: () => new GatewayError('dripify_sin_api',
    'El plan de Dripify de este cliente no incluye la API (Open API). Avisar a Biguá.', 502),
  limite: (seg) => new GatewayError('dripify_limite',
    `Se llegó al cupo de pedidos a Dripify. Reintentar en ${seg} segundos; si es el cupo del día, mañana.`, 429, { reintentar_en: seg }),
  rechazo: (status, msg) => new GatewayError('dripify_rechazo', `Dripify rechazó el pedido (HTTP ${status}): ${msg}`, 422),
  noEncontrado: (msg) => new GatewayError('dripify_no_encontrado', msg, 404),
  caido: (detalle) => new GatewayError('dripify_caido', `Dripify no respondió bien: ${detalle}. Reintentar más tarde.`, 502),
  campanaInactiva: (estado) => new GatewayError('dripify_campana_inactiva',
    `La campaña de Dripify está ${estado}: Dripify sólo procesa prospectos en una campaña ACTIVE, y se activa ` +
    'desde Dripify (no por la API). Avisar a Biguá.', 409),
  faltanCampos: (faltan) => new GatewayError('dripify_faltan_campos',
    `En Dripify faltan los campos personalizados ${faltan.join(', ')} (Settings → Lead fields). Avisar a Biguá.`, 409),
  enCurso: () => new GatewayError('dripify_en_curso',
    'Ya hay una carga o un mensaje con esa clave en curso o cortado a mitad. No se reintenta para no duplicar: ' +
    'revisar en Dripify antes de usar otra clave.', 409),
};

// ---------------------------------------------------------------- configuración (dueño)

export async function configurar(clientId, d) {
  return asOwner(async (c) => {
    const { rows } = await c.query(`select * from sdr.dripify_cuenta where client_id = $1`, [clientId]);
    const actual = rows[0];
    const enc = d.api_key ? encryptSecret(d.api_key.trim(), aadDripify(clientId)) : actual?.api_key_enc ?? null;
    const campana = d.campana_id === undefined ? actual?.campana_id ?? null : d.campana_id;
    const cambia = d.api_key || (d.campana_id !== undefined && String(d.campana_id) !== String(actual?.campana_id));
    await c.query(
      `insert into sdr.dripify_cuenta (client_id, api_key_enc, campana_id, nota_max, activo)
       values ($1, $2, $3, coalesce($4, 300), coalesce($5, true))
       on conflict (client_id) do update set api_key_enc = excluded.api_key_enc, campana_id = excluded.campana_id,
         nota_max = coalesce($4, sdr.dripify_cuenta.nota_max), activo = coalesce($5, sdr.dripify_cuenta.activo),
         campos = case when $6 then '{}'::jsonb else sdr.dripify_cuenta.campos end,
         ultimo_error = case when $6 then null else sdr.dripify_cuenta.ultimo_error end, actualizado_at = now()`,
      [clientId, enc, campana, d.nota_max ?? null, d.activo ?? null, Boolean(cambia)]);
    return verEn(c, clientId);
  });
}

// El secreto va en la URL porque Dripify no deja agregar cabeceras al webhook. Se muestra una
// sola vez; en la base queda el hash.
export async function generarWebhook(clientId) {
  const secreto = crypto.randomBytes(24).toString('base64url');
  await asOwner((c) => c.query(
    `insert into sdr.dripify_cuenta (client_id, webhook_hash) values ($1, $2)
     on conflict (client_id) do update set webhook_hash = excluded.webhook_hash, actualizado_at = now()`,
    [clientId, hashToken(secreto)]));
  return { ruta: `/hook/dripify/${encodeURIComponent(clientId)}/${secreto}` };
}

async function verEn(c, clientId) {
  const { rows } = await c.query(`select * from sdr.dripify_cuenta where client_id = $1`, [clientId]);
  const r = rows[0];
  if (!r) return null;
  return {
    api_key: Boolean(r.api_key_enc), campana_id: r.campana_id === null ? null : Number(r.campana_id), campos: r.campos,
    nota_max: r.nota_max, webhook: Boolean(r.webhook_hash), activo: r.activo,
    ultimo_ok_at: r.ultimo_ok_at, ultimo_error: r.ultimo_error, actualizado_at: r.actualizado_at,
  };
}

// Lo que el panel muestra: nunca la key.
export const ver = (c, clientId) => verEn(c, clientId);

export async function claves() {
  return (await asOwner((c) => c.query(`select client_id, api_key_enc from sdr.dripify_cuenta where api_key_enc is not null`))).rows;
}

export async function setClave(clientId, enc) {
  await asOwner((c) => c.query(`update sdr.dripify_cuenta set api_key_enc = $2 where client_id = $1`, [clientId, enc]));
}

// ---------------------------------------------------------------- la API

async function conexion(clientId) {
  const { rows } = await asClient(clientId, (c) => c.query(`select * from sdr.dripify_cuenta where client_id = $1`, [clientId]));
  const cta = rows[0];
  if (!cta?.api_key_enc || !cta.campana_id || !cta.activo) throw errorsDripify.sinConfigurar();
  return { clientId, cuenta: cta, key: decryptSecret(cta.api_key_enc, aadDripify(clientId)) };
}

async function tomarCupo(clientId, n = 1) {
  const { rows } = await asClient(clientId, async (c) => {
    await c.query(`insert into sdr.dripify_uso (client_id) values ($1) on conflict (client_id) do nothing`, [clientId]);
    return c.query(
      `with u as (
         select case when minuto = date_trunc('minute', now()) then n_minuto else 0 end as m,
                case when dia = current_date then n_dia else 0 end as d
           from sdr.dripify_uso where client_id = $1)
       update sdr.dripify_uso set minuto = date_trunc('minute', now()), n_minuto = u.m + $2, dia = current_date, n_dia = u.d + $2
         from u where client_id = $1 and u.m + $2 <= $3 and u.d + $2 <= $4
       returning n_minuto, n_dia`, [clientId, n, CUPO.minuto, CUPO.dia]);
  });
  if (!rows.length) throw errorsDripify.limite(60 - new Date().getUTCSeconds());
}

async function anotar(clientId, error) {
  await asClient(clientId, (c) => c.query(
    error
      ? `update sdr.dripify_cuenta set ultimo_error = $2 where client_id = $1`
      : `update sdr.dripify_cuenta set ultimo_ok_at = now(), ultimo_error = null where client_id = $1`,
    error ? [clientId, error.slice(0, 500)] : [clientId])).catch(() => {});
}

// Un pedido a Dripify. Con permitir404, un 404 devuelve null (por ejemplo, «no hay conversación»).
async function api(cx, method, path, { body, query, permitir404 = false } = {}) {
  await tomarCupo(cx.clientId);
  const url = new URL(`${base()}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { 'x-api-key': cx.key, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    const err = errorsDripify.caido(e.name === 'TimeoutError' ? 'no contestó en 20 segundos' : e.message);
    err.cortado = true; // no se sabe si Dripify lo hizo
    await anotar(cx.clientId, err.message);
    throw err;
  }
  const texto = await res.text();
  let json = null;
  try { json = texto ? JSON.parse(texto) : null; } catch { json = null; }
  if (res.ok) {
    if (cx.cuenta.ultimo_error || !cx.cuenta.ultimo_ok_at) { await anotar(cx.clientId, null); cx.cuenta.ultimo_error = null; cx.cuenta.ultimo_ok_at = new Date(); }
    return json;
  }
  if (res.status === 404 && permitir404) return null;
  const msg = (json?.message ?? json?.error ?? texto ?? '').toString().slice(0, 300) || res.statusText;
  let err;
  if (res.status === 401) err = errorsDripify.clave();
  else if (res.status === 403) err = errorsDripify.sinApi();
  else if (res.status === 429) err = errorsDripify.limite(Number(res.headers.get('retry-after')) || 60);
  else if (res.status === 404) err = errorsDripify.noEncontrado(`Dripify no encontró ${path}: ${msg}`);
  else if (res.status >= 500) { err = errorsDripify.caido(`HTTP ${res.status} ${msg}`); err.cortado = true; }
  else err = errorsDripify.rechazo(res.status, msg);
  err.http = res.status;
  if (res.status !== 404) await anotar(cx.clientId, err.message);
  throw err;
}

async function todas(cx, path, query = {}) {
  const items = [];
  let cursor;
  for (let i = 0; i < 5; i++) {
    const r = await api(cx, 'GET', path, { query: { ...query, limit: 100, cursor } });
    items.push(...(r?.items ?? []));
    cursor = r?.nextCursor;
    if (!cursor) break;
  }
  return items;
}

// Ids de los campos personalizados de la campaña, por nombre. Se guardan en la cuenta.
async function campos(cx, { refrescar = false } = {}) {
  const guardados = cx.cuenta.campos ?? {};
  if (!refrescar && VARIABLES.every((v) => guardados[v])) return guardados;
  const lista = await api(cx, 'GET', '/v1/open-api/custom-lead-fields');
  const porNombre = {};
  for (const f of Array.isArray(lista) ? lista : lista?.items ?? []) porNombre[String(f.name).trim().toLowerCase()] = Number(f.id);
  const out = Object.fromEntries(VARIABLES.filter((v) => porNombre[v]).map((v) => [v, porNombre[v]]));
  await asClient(cx.clientId, (c) => c.query(`update sdr.dripify_cuenta set campos = $2 where client_id = $1`, [cx.clientId, JSON.stringify(out)]));
  cx.cuenta.campos = out;
  return out;
}

async function campana(cx) {
  const lista = await todas(cx, '/v1/open-api/campaigns');
  return lista.find((x) => String(x.id) === String(cx.cuenta.campana_id)) ?? null;
}

// Para el panel («Probar») y la herramienta dripify_estado.
export async function estado(clientId) {
  const cx = await conexion(clientId);
  const k = await campana(cx);
  const cs = await campos(cx, { refrescar: true });
  const faltan = VARIABLES.filter((v) => !cs[v]);
  let estadisticas = null;
  if (k) {
    const s = await api(cx, 'GET', `/v1/open-api/campaigns/${cx.cuenta.campana_id}/statistics`, { permitir404: true });
    if (s) {
      estadisticas = {
        prospectos: s.totalLeads ?? null, contactados: s.contactedLeads ?? null,
        aceptacion: s.acceptanceRate ?? null, respuesta: s.replyRate ?? null, por_estado: s.leadStatusBreakdown ?? null,
      };
    }
  }
  const { rows: uso } = await asClient(clientId, (c) => c.query(
    `select case when minuto = date_trunc('minute', now()) then n_minuto else 0 end as minuto,
            case when dia = current_date then n_dia else 0 end as dia from sdr.dripify_uso where client_id = $1`, [clientId]));
  const problemas = [];
  if (!k) problemas.push(`No existe la campaña ${cx.cuenta.campana_id} en esta cuenta de Dripify.`);
  else if (k.status !== 'ACTIVE') problemas.push(`La campaña está ${k.status}: activarla en Dripify.`);
  if (k?.locked) problemas.push('La campaña está bloqueada (por ejemplo, por el límite del plan).');
  if (faltan.length) problemas.push(`Faltan los campos personalizados ${faltan.join(', ')} en Dripify (Settings → Lead fields).`);
  return {
    listo: problemas.length === 0, problemas,
    campana: k ? { id: Number(k.id), nombre: k.name, estado: k.status, bloqueada: Boolean(k.locked) } : null,
    campos: cs, nota_max: cx.cuenta.nota_max, estadisticas,
    cupo: { minuto: uso[0]?.minuto ?? 0, dia: uso[0]?.dia ?? 0, tope_minuto: CUPO.minuto, tope_dia: CUPO.dia },
  };
}

// El id de la persona en Dripify. Se busca por la URL de LinkedIn la primera vez y queda en el
// prospecto. Recién cargada, Dripify tarda unos minutos en procesar la lista: puede no estar.
async function leadDe(cx, p) {
  if (p.dripify?.lead_id) return Number(p.dripify.lead_id);
  if (!p.linkedin_url) return null;
  const r = await api(cx, 'POST', '/v1/open-api/leads/search', { body: { linkedinUrl: p.linkedin_url } });
  const lista = Array.isArray(r) ? r : r?.items ?? [];
  const slug = p.linkedin_url.split('/in/')[1];
  const mismo = lista.filter((l) => {
    try { return (l.linkedinProfileUrl && normalizeLinkedin(l.linkedinProfileUrl) === p.linkedin_url) || String(l.publicId ?? '').toLowerCase() === slug; } catch { return false; }
  });
  const lead = mismo[0] ?? (lista.length === 1 ? lista[0] : null);
  if (!lead) return null;
  await asClient(cx.clientId, (c) => c.query(
    `update sdr.prospecto set dripify = coalesce(dripify, '{}'::jsonb) || jsonb_build_object('lead_id', $3::bigint)
      where client_id = $1 and id = $2`, [cx.clientId, p.id, lead.id]));
  p.dripify = { ...(p.dripify ?? {}), lead_id: Number(lead.id) };
  return Number(lead.id);
}

async function prospectoEn(c, clientId, id) {
  const { rows } = await c.query(`select * from sdr.prospecto where client_id = $1 and id = $2`, [clientId, id]);
  if (!rows.length) throw errorsSdr.noExiste(`el prospecto ${id}`);
  return rows[0];
}

const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
const marcadores = (s) => /\{\{|\}\}|\[(nombre|empresa|cargo|name|company)\]/i.test(s);

// ---------------------------------------------------------------- cargar en la campaña

// Controles antes de cargar: la persona tiene LinkedIn, no respondió ni está cerrada, no estaba
// cargada, los textos entran y, en calibración, coinciden con lo aprobado.
async function controlarCarga(c, clientId, items, notaMax) {
  const { rows: cfg } = await c.query(`select calibracion_mails from sdr.cliente_config where client_id = $1`, [clientId]);
  const { rows: usadas } = await c.query(
    `select count(*)::int as n from sdr.aprobacion where client_id = $1 and tipo = 'calibracion_mail' and estado = 'usada'`, [clientId]);
  const calibrando = (cfg[0]?.calibracion_mails ?? 0) > usadas[0].n;
  const errores = [];
  const aprobaciones = [];
  const vistos = new Set();
  for (const it of items) {
    const e = (msg) => errores.push({ prospecto_id: it.prospecto_id, error: msg });
    if (vistos.has(it.prospecto_id)) { e('está dos veces en la carga'); continue; }
    vistos.add(it.prospecto_id);
    const { rows } = await c.query(
      `select p.*, exists (select 1 from sdr.correo x where x.client_id = p.client_id and x.prospecto_id = p.id and x.estado = 'nuevo')
                   or exists (select 1 from sdr.linkedin_respuesta l where l.client_id = p.client_id and l.prospecto_id = p.id and l.estado = 'nuevo') as sin_leer
         from sdr.prospecto p where p.client_id = $1 and p.id = $2`, [clientId, it.prospecto_id]);
    const p = rows[0];
    if (!p) { e('no existe en el registro'); continue; }
    if (!p.linkedin_url) { e('no tiene URL de LinkedIn'); continue; }
    if (!ESTADOS_CARGABLES.includes(p.estado)) { e(`está en estado ${p.estado}: no entra a la campaña`); continue; }
    if (p.sin_leer) { e('tiene una respuesta sin atender: la lee seguimiento antes'); continue; }
    if (p.dripify?.carga) { e(`ya se cargó en Dripify (carga ${p.dripify.carga})`); continue; }
    if (p.email) {
      const { rowCount } = await c.query(`select 1 from sdr.supresion where client_id = $1 and email = $2`, [clientId, p.email]);
      if (rowCount) { e('está en la supresión del cliente (baja o rebote)'); continue; }
    }
    const dominio = p.cuenta_id
      ? (await c.query(`select dominio from sdr.cuenta where client_id = $1 and id = $2`, [clientId, p.cuenta_id])).rows[0]?.dominio
      : null;
    const nc = await noContactar.coincidencias(c, clientId, [p.email, dominio]);
    if (nc.length) { e(`está en la lista de no contactar del cliente: ${noContactar.describir(nc)}`); continue; }
    const textos = { nota: it.nota, mensaje1: it.mensaje1, mensaje2: it.mensaje2 };
    if (norm(it.nota).length > notaMax) { e(`la nota tiene ${norm(it.nota).length} caracteres y el tope es ${notaMax}`); continue; }
    const largo = ['mensaje1', 'mensaje2'].find((k) => norm(textos[k]).length > MENSAJE_MAX);
    if (largo) { e(`${largo} tiene más de ${MENSAJE_MAX} caracteres (tope de un campo de Dripify)`); continue; }
    const vacio = Object.keys(textos).find((k) => !norm(textos[k]));
    if (vacio) { e(`falta ${vacio}`); continue; }
    const conMarcas = Object.keys(textos).find((k) => marcadores(textos[k]));
    if (conMarcas) { e(`${conMarcas} tiene marcadores sin completar ({{…}} o [Nombre]): el texto va escrito entero`); continue; }
    if (calibrando || it.aprobacion_id) {
      if (!it.aprobacion_id) {
        e('el cliente está en calibración: hace falta la aprobación del primer contacto con el texto de LinkedIn ' +
          '(registro_pedir_aprobacion tipo calibracion_mail, con contenido.linkedin {nota, mensaje1, mensaje2})');
        continue;
      }
      const { rows: ap } = await c.query(`select * from sdr.aprobacion where client_id = $1 and id = $2`, [clientId, it.aprobacion_id]);
      const a = ap[0];
      if (!a) { e(`no existe la aprobación ${it.aprobacion_id}`); continue; }
      if (a.tipo !== 'calibracion_mail' || !['aprobada', 'usada'].includes(a.estado)) { e(`la aprobación es ${a.tipo} y está ${a.estado}`); continue; }
      if (a.prospecto_id && a.prospecto_id !== p.id) { e('la aprobación es de otro prospecto'); continue; }
      const li = (a.decision_contenido ?? a.contenido)?.linkedin;
      if (!li) { e('la aprobación no tiene el texto de LinkedIn (contenido.linkedin)'); continue; }
      const dif = Object.keys(textos).filter((k) => norm(li[k]) !== norm(textos[k]));
      if (dif.length) { e(`no coincide con lo aprobado: ${dif.join(', ')} (si el operador lo editó, la versión editada está en decision_contenido.linkedin)`); continue; }
      aprobaciones.push(a);
    }
    it.p = p;
  }
  return { errores, aprobaciones };
}

export async function cargar(clientId, a, meta) {
  const cx = await conexion(clientId);
  // Reintento con la misma clave: devuelve lo que pasó la primera vez.
  const { rows: prev } = await asClient(clientId, (c) => c.query(
    `select * from sdr.dripify_carga where client_id = $1 and clave = $2`, [clientId, a.idempotency_key]));
  if (prev[0]?.estado === 'ok') return { repetida: true, ...resultadoCarga(prev[0]) };
  if (prev[0]?.estado === 'enviando') throw errorsDripify.enCurso();

  const { errores, aprobaciones } = await asClient(clientId, (c) => controlarCarga(c, clientId, a.prospectos, cx.cuenta.nota_max));
  if (errores.length) {
    throw new GatewayError('dripify_carga_rechazada',
      `No se cargó nada: ${errores.length} de ${a.prospectos.length} no pasan los controles. Corregí o sacá esos y volvé a cargar.`,
      422, { errores });
  }
  const k = await campana(cx);
  if (!k) throw errorsDripify.noEncontrado(`No existe la campaña ${cx.cuenta.campana_id} en la cuenta de Dripify del cliente. Avisar a Biguá.`);
  if (k.status !== 'ACTIVE') throw errorsDripify.campanaInactiva(k.status);
  const cs = await campos(cx);
  const faltan = VARIABLES.filter((v) => !cs[v]);
  if (faltan.length) throw errorsDripify.faltanCampos(faltan);

  const ids = a.prospectos.map((x) => x.prospecto_id);
  const { rows: carga } = await asClient(clientId, (c) => c.query(
    `insert into sdr.dripify_carga (client_id, clave, dripify_campana_id, prospectos) values ($1, $2, $3, $4)
     on conflict (client_id, clave) do update set estado = 'enviando', error = null, prospectos = excluded.prospectos, creado_at = now()
       where sdr.dripify_carga.estado = 'error'
     returning *`, [clientId, a.idempotency_key, cx.cuenta.campana_id, ids]));
  if (!carga.length) throw errorsDripify.enCurso();
  const id = Number(carga[0].id);

  let r;
  try {
    r = await api(cx, 'POST', `/v1/open-api/campaigns/${cx.cuenta.campana_id}/leads`, {
      body: {
        name: `SDR ${a.idempotency_key}`.slice(0, 120),
        leads: a.prospectos.map((it) => ({
          linkedinUrl: it.p.linkedin_url,
          customFields: [
            { customLeadFieldId: cs.sdr_nota, value: norm(it.nota) },
            { customLeadFieldId: cs.sdr_mensaje1, value: norm(it.mensaje1) },
            { customLeadFieldId: cs.sdr_mensaje2, value: norm(it.mensaje2) },
          ],
        })),
      },
    });
  } catch (e) {
    // Si se cortó sin respuesta, no se sabe si Dripify la tomó: queda «enviando» y no se reintenta.
    if (!e.cortado) {
      await asClient(clientId, (c) => c.query(`update sdr.dripify_carga set estado = 'error', error = $3 where client_id = $1 and id = $2`,
        [clientId, id, e.message.slice(0, 500)]));
    }
    throw e;
  }

  const lista = r?.leadList ?? {};
  return asClient(clientId, async (c) => {
    const { rows: fin } = await c.query(
      `update sdr.dripify_carga set estado = 'ok', lead_list_id = $3, aceptados = $4, duplicados = $5
        where client_id = $1 and id = $2 returning *`,
      [clientId, id, lista.id ?? null, r?.acceptedCount ?? null, r?.duplicateCount ?? null]);
    const version = await versionActual(c, clientId);
    for (const it of a.prospectos) {
      await c.query(
        `update sdr.prospecto set dripify = coalesce(dripify, '{}'::jsonb) || $3::jsonb, actualizado_at = now()
          where client_id = $1 and id = $2`,
        [clientId, it.prospecto_id, JSON.stringify({
          estado: 'cargado', carga: id, campana_id: Number(cx.cuenta.campana_id), lead_list_id: lista.id ?? null,
          cargado_at: new Date().toISOString(),
        })]);
      const ev = {
        tipo: 'linkedin.cargado', canal: 'linkedin', prospecto_id: it.prospecto_id, ref: `dripify:carga:${id}`,
        datos: { carga: id, lead_list_id: lista.id ?? null, nota: norm(it.nota), mensaje1: norm(it.mensaje1), mensaje2: norm(it.mensaje2),
          ...(it.aprobacion_id ? { aprobacion: it.aprobacion_id } : {}) },
      };
      await insertarEvento(c, clientId, ev, { ...meta, version });
      await aplicarEvento(c, clientId, ev);
    }
    // Una aprobación sólo de LinkedIn (sin mail) se gasta acá; la que trae mail la gasta el envío.
    for (const ap of aprobaciones) {
      if ((ap.decision_contenido ?? ap.contenido)?.texto === undefined && ap.estado === 'aprobada') {
        await c.query(`update sdr.aprobacion set estado = 'usada', usada_at = now(), usada_clave = $3 where client_id = $1 and id = $2`,
          [clientId, ap.id, `dripify:${a.idempotency_key}`]);
      }
    }
    return { repetida: false, ...resultadoCarga(fin[0]) };
  });
}

function resultadoCarga(r) {
  return {
    carga: Number(r.id), campana_id: Number(r.dripify_campana_id), lead_list_id: r.lead_list_id === null ? null : Number(r.lead_list_id),
    prospectos: r.prospectos.length, aceptados: r.aceptados, duplicados: r.duplicados,
    nota: 'Dripify procesa la lista en unos minutos y arranca la secuencia (invitación, mensaje 1 al aceptar, mensaje 2 después). ' +
      'Lo que pase vuelve solo al registro.',
  };
}

// ---------------------------------------------------------------- conversación y respuesta

export async function conversacion(clientId, prospectoId, limite = 20) {
  const cx = await conexion(clientId);
  const p = await asClient(clientId, (c) => prospectoEn(c, clientId, prospectoId));
  const lead = await leadDe(cx, p);
  if (!lead) return { prospecto_id: p.id, en_dripify: false, nota: 'Dripify todavía no tiene a esta persona (o no está cargada).', mensajes: [] };
  const conv = await api(cx, 'GET', `/v1/open-api/leads/${lead}/conversation`, { permitir404: true });
  if (!conv) return { prospecto_id: p.id, en_dripify: true, lead_id: lead, conversacion: null, nota: 'Todavía no hay conversación (no aceptó la invitación o no hubo mensajes).', mensajes: [] };
  const msgs = await api(cx, 'GET', `/v1/open-api/conversations/${encodeURIComponent(conv.conversationId)}/messages`);
  const mensajes = (msgs?.items ?? []).slice(0, limite).map((m) => ({
    id: m.eventId ?? null, de: m.direction === 'LEAD' ? 'prospecto' : 'nosotros', texto: String(m.message ?? '').slice(0, TEXTO_MAX),
    at: m.createdAt ?? null, editado_at: m.editedAt ?? null, adjuntos: (m.attachments ?? []).length,
  })).reverse();
  return { prospecto_id: p.id, en_dripify: true, lead_id: lead, conversacion: conv.conversationId, sin_leer: conv.unreadCount ?? null, mensajes };
}

export async function responder(clientId, a, meta) {
  const cx = await conexion(clientId);
  const texto = norm(a.texto);
  const { p, ap } = await asClient(clientId, async (c) => {
    const p = await prospectoEn(c, clientId, a.prospecto_id);
    if (['baja', 'negativo', 'descartado'].includes(p.estado)) {
      throw new GatewayError('prospecto_respondio', `Esta persona está en estado ${p.estado}: no se le escribe más.`, 409);
    }
    let ap = null;
    if (p.estado === 'positivo' && !a.aprobacion_id) {
      throw errorsSdr.aprobacionRequerida('Es la respuesta a un positivo: necesita una aprobación (registro_pedir_aprobacion, tipo ' +
        'respuesta_positivo, con contenido.canal "linkedin" y el texto). Mandala cuando esté aprobada, pasando aprobacion_id.');
    }
    if (a.aprobacion_id) {
      const { rows } = await c.query(`select * from sdr.aprobacion where client_id = $1 and id = $2`, [clientId, a.aprobacion_id]);
      ap = rows[0];
      if (!ap) throw errorsSdr.noExiste(`la aprobación ${a.aprobacion_id}`);
      const reintento = ap.estado === 'usada' && ap.usada_clave === `dripify:${a.idempotency_key}`;
      if (ap.estado !== 'aprobada' && !reintento) throw errorsSdr.aprobacionRequerida(`La aprobación está ${ap.estado}: no se puede usar.`);
      // Sólo una respuesta a un positivo, para LinkedIn y para esta persona: una calibración, una
      // aprobación de mail o una sin prospecto no habilitan un mensaje por LinkedIn.
      if (ap.tipo !== 'respuesta_positivo') {
        throw errorsSdr.aprobacionRequerida(`La aprobación es de tipo ${ap.tipo}: un mensaje por LinkedIn necesita una respuesta_positivo.`);
      }
      const final = ap.decision_contenido ?? ap.contenido;
      const dif = [];
      if (final.canal !== 'linkedin') dif.push(`el canal (la aprobación es para ${final.canal ?? 'mail'})`);
      if (norm(final.texto) !== texto) dif.push('el texto');
      if (ap.prospecto_id !== p.id) dif.push('el prospecto');
      if (dif.length) throw errorsSdr.aprobacionNoCoincide(`No coincide con lo aprobado: ${dif.join(', ')}. Mandá exactamente lo aprobado.`);
    }
    return { p, ap };
  });
  const { rows: prev } = await asClient(clientId, (c) => c.query(
    `insert into sdr.dripify_envio (client_id, clave, prospecto_id, texto, aprobacion_id) values ($1, $2, $3, $4, $5)
     on conflict (client_id, clave) do update set estado = 'enviando', error = null where sdr.dripify_envio.estado = 'error'
     returning *`, [clientId, a.idempotency_key, p.id, texto, ap?.id ?? null]));
  if (!prev.length) {
    const { rows } = await asClient(clientId, (c) => c.query(`select * from sdr.dripify_envio where client_id = $1 and clave = $2`, [clientId, a.idempotency_key]));
    if (rows[0]?.estado === 'ok' && rows[0].prospecto_id === p.id) return { repetido: true, event_id: rows[0].event_id };
    throw errorsDripify.enCurso();
  }
  const envio = Number(prev[0].id);
  const fallar = async (e) => {
    if (!e.cortado) {
      await asClient(clientId, (c) => c.query(`update sdr.dripify_envio set estado = 'error', error = $3 where client_id = $1 and id = $2`,
        [clientId, envio, e.message.slice(0, 500)]));
    }
    throw e;
  };
  let lead;
  try { lead = await leadDe(cx, p); } catch (e) { return fallar(e); }
  if (!lead) return fallar(errorsDripify.noEncontrado('Dripify no tiene a esta persona: no se le puede escribir por LinkedIn.'));
  let r;
  try {
    r = await api(cx, 'POST', `/v1/open-api/leads/${lead}/messages`, { body: { message: texto } });
  } catch (e) {
    if (e.http === 404 || e.http === 409) {
      return fallar(new GatewayError('dripify_sin_conversacion',
        'No hay conversación abierta con esta persona en LinkedIn (no aceptó la invitación todavía): no se puede mandar el mensaje.', 409));
    }
    return fallar(e);
  }
  return asClient(clientId, async (c) => {
    await c.query(`update sdr.dripify_envio set estado = 'ok', event_id = $3, lead_id = $4 where client_id = $1 and id = $2`,
      [clientId, envio, r?.eventId ?? null, lead]);
    const ev = { tipo: 'linkedin.mensaje', canal: 'linkedin', prospecto_id: p.id, ref: r?.eventId ? `dripify:${r.eventId}` : null,
      datos: { manual: true, texto, ...(ap ? { aprobacion: ap.id } : {}) } };
    await insertarEvento(c, clientId, ev, { ...meta, version: await versionActual(c, clientId) });
    await aplicarEvento(c, clientId, ev);
    if (ap?.estado === 'aprobada') {
      await c.query(`update sdr.aprobacion set estado = 'usada', usada_at = now(), usada_clave = $3 where client_id = $1 and id = $2`,
        [clientId, ap.id, `dripify:${a.idempotency_key}`]);
    }
    return { repetido: false, event_id: r?.eventId ?? null,
      nota: 'Mandar un mensaje a mano pausa la secuencia de Dripify para esta persona: lo que sigue lo decide seguimiento.' };
  });
}

// ---------------------------------------------------------------- frenar y reanudar

export async function frenar(clientId, prospectoId, motivo, meta) {
  const cx = await conexion(clientId);
  const p = await asClient(clientId, (c) => prospectoEn(c, clientId, prospectoId));
  return frenarEn(cx, p, motivo, meta);
}

async function frenarEn(cx, p, motivo, meta) {
  const lead = await leadDe(cx, p);
  if (!lead) return { frenado: false, motivo: 'Dripify todavía no tiene a esta persona: se reintenta en la próxima vuelta del reloj.' };
  await api(cx, 'PUT', `/v1/open-api/leads/${lead}/blacklist`);
  await asClient(cx.clientId, async (c) => {
    await c.query(
      `update sdr.prospecto set dripify = (coalesce(dripify, '{}'::jsonb) - 'freno') || jsonb_build_object('estado', 'frenado', 'frenado_at', now(), 'frenado_motivo', $3::text)
        where client_id = $1 and id = $2`, [cx.clientId, p.id, motivo]);
    await insertarEvento(c, cx.clientId, { tipo: 'linkedin.pausado', canal: 'linkedin', prospecto_id: p.id, datos: { motivo, lead_id: lead } },
      { ...meta, version: await versionActual(c, cx.clientId) });
  });
  return { frenado: true, lead_id: lead };
}

// Quién puede volver a la secuencia: los que se cargan y quien respondió (seguimiento decidió seguir
// por LinkedIn). Nunca quien pidió la baja, dijo que no, quedó descartado o pasó al CRM.
const ESTADOS_REANUDABLES = [...ESTADOS_CARGABLES, 'respondio'];

export async function reanudar(clientId, prospectoId, meta) {
  const cx = await conexion(clientId);
  const p = await asClient(clientId, async (c) => {
    const p = await prospectoEn(c, clientId, prospectoId);
    const no = (msg) => new GatewayError('prospecto_cerrado', `No se reanuda: ${msg}`, 409);
    if (!ESTADOS_REANUDABLES.includes(p.estado)) throw no(`la persona está en estado ${p.estado}.`);
    // Una baja registrada vale aunque el estado haya cambiado después, y por cualquier canal.
    const { rowCount: baja } = await c.query(
      `select 1 from sdr.evento where client_id = $1 and prospecto_id = $2 and tipo = 'baja' limit 1`, [clientId, p.id]);
    if (baja) throw no('la persona pidió la baja.');
    if (p.dripify?.frenado_motivo === 'pidió la baja') throw no('la secuencia se frenó porque pidió la baja.');
    if (p.email) {
      const { rowCount } = await c.query(`select 1 from sdr.supresion where client_id = $1 and email = $2`, [clientId, p.email]);
      if (rowCount) throw no('está en la supresión del cliente (baja o rebote).');
    }
    const dominio = p.cuenta_id
      ? (await c.query(`select dominio from sdr.cuenta where client_id = $1 and id = $2`, [clientId, p.cuenta_id])).rows[0]?.dominio
      : null;
    const nc = await noContactar.coincidencias(c, clientId, [p.email, dominio]);
    if (nc.length) throw no(`está en la lista de no contactar del cliente: ${noContactar.describir(nc)}.`);
    return p;
  });
  const lead = await leadDe(cx, p);
  if (!lead) throw errorsDripify.noEncontrado('Dripify no tiene a esta persona.');
  await api(cx, 'DELETE', `/v1/open-api/leads/${lead}/blacklist`);
  await api(cx, 'POST', `/v1/open-api/leads/${lead}/resume`);
  await asClient(clientId, async (c) => {
    await c.query(`update sdr.prospecto set dripify = (coalesce(dripify, '{}'::jsonb) - 'freno') || '{"estado":"cargado"}'::jsonb
                    where client_id = $1 and id = $2`, [clientId, p.id]);
    await insertarEvento(c, clientId, { tipo: 'nota', canal: 'linkedin', prospecto_id: p.id, datos: { dripify: 'reanudado', lead_id: lead } },
      { ...meta, version: await versionActual(c, clientId) });
  });
  return { reanudado: true, lead_id: lead };
}

// Los frenos que dejó el correo (respuesta o baja por mail): ver aplicarEvento en store.mjs.
export async function frenarPendientes(clientId, { hasta = Date.now() + 20_000 } = {}) {
  const { rows } = await asClient(clientId, (c) => c.query(
    `select * from sdr.prospecto where client_id = $1 and dripify->'freno'->>'pendiente' = 'true' order by actualizado_at limit 20`, [clientId]));
  if (!rows.length) return [];
  let cx;
  try { cx = await conexion(clientId); } catch (e) { return [{ error: e.message }]; }
  const out = [];
  for (const p of rows) {
    if (Date.now() > hasta) break;
    const motivo = p.dripify.freno.motivo ?? 'respondió por otro canal';
    try {
      const r = await frenarEn(cx, p, motivo, { bot: 'gateway', tarea: 'freno' });
      if (!r.frenado && Date.now() - new Date(p.dripify.freno.desde).getTime() > FRENO_HORAS * 3_600_000) {
        await asClient(clientId, async (c) => {
          await c.query(`update sdr.prospecto set dripify = dripify || jsonb_build_object('freno', (dripify->'freno') || '{"pendiente":false,"fallo":true}'::jsonb)
                          where client_id = $1 and id = $2`, [clientId, p.id]);
          await insertarEvento(c, clientId, { tipo: 'nota', canal: 'linkedin', prospecto_id: p.id,
            datos: { dripify: 'no se pudo frenar', motivo: 'Dripify no encontró a la persona en 24 horas: revisar a mano', freno: motivo } },
          { bot: 'gateway', tarea: 'freno' });
        });
      }
      out.push({ prospecto_id: p.id, ...r });
    } catch (e) {
      out.push({ prospecto_id: p.id, frenado: false, error: e.message });
      if (e.code === 'dripify_limite' || e.code === 'dripify_clave' || e.code === 'dripify_sin_api') break;
    }
  }
  return out;
}

// ---------------------------------------------------------------- webhook

const TIPOS_WEBHOOK = { invitacion: 'linkedin.invitacion', conexion: 'linkedin.conexion', mensaje: 'linkedin.mensaje', respuesta: 'respuesta' };

function recorrer(x, fn, clave = '', prof = 0) {
  if (prof > 8 || x === null || x === undefined) return;
  if (Array.isArray(x)) { for (const y of x) recorrer(y, fn, clave, prof + 1); return; }
  if (typeof x === 'object') { for (const [k, v] of Object.entries(x)) recorrer(v, fn, k, prof + 1); return; }
  fn(clave, x);
}

// Las URLs de LinkedIn que identifican a la persona del evento. Sólo valen los campos cuyo valor
// entero es una URL de perfil: una URL mencionada adentro de un texto no cuenta, y las partes del
// cuerpo que son conversación o mensajes no se miran. Si no, quien responde podría escribir la URL
// de otra persona y el evento quedaría atado a ella.
const PARTES_DE_TEXTO = /conversation|message|text|reply|body|content|note|comment/i;
const URL_PERFIL = /^(https?:\/\/)?([a-z]{2,3}\.|www\.)?linkedin\.com\/in\/[^\s"'<>?#]+\/?([?#][^\s]*)?$/i;

export function urlsDe(cuerpo) {
  const urls = new Set();
  const ver = (x, prof = 0) => {
    if (prof > 8 || x === null || x === undefined) return;
    if (Array.isArray(x)) { for (const y of x) ver(y, prof + 1); return; }
    if (typeof x !== 'object') return;
    for (const [k, v] of Object.entries(x)) {
      if (PARTES_DE_TEXTO.test(k)) continue;
      if (typeof v === 'string') {
        const t = v.trim();
        if (URL_PERFIL.test(t)) { try { urls.add(normalizeLinkedin(t)); } catch { /* una URL cortada no sirve para atar */ } }
      } else {
        ver(v, prof + 1);
      }
    }
  };
  ver(cuerpo);
  return [...urls];
}

// Dripify no documenta el cuerpo: si la URL del webhook no dice qué es (?e=…), una conversación
// en el cuerpo quiere decir respuesta.
function clavesDe(x, out = new Set(), prof = 0) {
  if (!x || typeof x !== 'object' || prof > 8) return out;
  if (Array.isArray(x)) { for (const y of x) clavesDe(y, out, prof + 1); return out; }
  for (const [k, v] of Object.entries(x)) { out.add(k); clavesDe(v, out, prof + 1); }
  return out;
}

export function tipoWebhook(cuerpo, e) {
  if (e && TIPOS_WEBHOOK[e]) return e;
  return [...clavesDe(cuerpo)].some((k) => /conversation|reply|replied|respon/i.test(k)) ? 'respuesta' : 'desconocido';
}

function textoConversacion(cuerpo) {
  const partes = [];
  const buscar = (x, prof = 0) => {
    if (!x || typeof x !== 'object' || prof > 6) return;
    for (const [k, v] of Object.entries(x)) {
      if (/conversation/i.test(k)) recorrer(v, (_k, s) => { if (typeof s === 'string' && s.trim() && !/^https?:\/\//.test(s)) partes.push(s.trim()); });
      else if (typeof v === 'object') buscar(v, prof + 1);
    }
  };
  buscar(cuerpo);
  const t = partes.join('\n').slice(0, TEXTO_MAX);
  return t || null;
}

export async function webhook(clientId, secreto, e, cuerpo) {
  const { rows } = await asOwner((c) => c.query(`select webhook_hash from sdr.dripify_cuenta where client_id = $1`, [clientId]));
  const esperado = rows[0]?.webhook_hash;
  const dado = hashToken(String(secreto ?? ''));
  if (!esperado || !crypto.timingSafeEqual(Buffer.from(dado), Buffer.from(esperado))) {
    throw new GatewayError('not_found', 'Ruta inexistente.', 404);
  }
  const tipo = tipoWebhook(cuerpo, e);
  const urls = urlsDe(cuerpo);
  return asClient(clientId, async (c) => {
    const { rows: ps } = urls.length
      ? await c.query(`select * from sdr.prospecto where client_id = $1 and linkedin_url = any($2) order by actualizado_at desc limit 2`, [clientId, urls])
      : { rows: [] };
    // Con dos personas posibles no se adivina: el evento queda sin atar, para revisar.
    const ambiguo = ps.length > 1;
    const p = ambiguo ? null : (ps[0] ?? null);
    const { rows: ins } = await c.query(
      `insert into sdr.dripify_evento (client_id, tipo, linkedin_url, prospecto_id, cuerpo) values ($1, $2, $3, $4, $5) returning id`,
      [clientId, tipo, p?.linkedin_url ?? urls[0] ?? null, p?.id ?? null, JSON.stringify(cuerpo ?? {})]);
    const id = Number(ins[0].id);
    const marcar = (procesado, error = null) => c.query(`update sdr.dripify_evento set procesado = $2, error = $3 where id = $1`, [id, procesado, error]);
    if (!p) {
      await marcar(false, ambiguo ? 'el cuerpo trae URLs de más de un prospecto: no se ata a ninguno'
        : urls.length ? 'ningún prospecto con esa URL de LinkedIn' : 'el cuerpo no trae una URL de LinkedIn');
      return { evento: id, atado: false };
    }
    if (tipo === 'desconocido') { await marcar(false, 'no se sabe qué evento es: agregar ?e=… a la URL del webhook'); return { evento: id, atado: true, tipo }; }
    const meta = { bot: 'gateway', tarea: 'dripify', version: await versionActual(c, clientId) };
    const ev = { tipo: TIPOS_WEBHOOK[tipo], canal: 'linkedin', prospecto_id: p.id, ref: `dripify:webhook:${id}`, datos: { dripify_evento: id } };
    await insertarEvento(c, clientId, ev, meta);
    await aplicarEvento(c, clientId, ev);
    if (tipo === 'respuesta') {
      await c.query(
        `insert into sdr.linkedin_respuesta (client_id, prospecto_id, lead_id, texto, origen, dripify_evento) values ($1, $2, $3, $4, 'webhook', $5)`,
        [clientId, p.id, p.dripify?.lead_id ?? null, textoConversacion(cuerpo), id]);
      await c.query(
        `update sdr.prospecto set proximo_paso = 'seguimiento: leer la respuesta de LinkedIn', proximo_canal = null, proximo_fecha = null,
                dripify = coalesce(dripify, '{}'::jsonb) || jsonb_build_object('ultimo_lead_at', now()), actualizado_at = now()
          where client_id = $1 and id = $2`, [clientId, p.id]);
    }
    await marcar(true);
    return { evento: id, atado: true, tipo };
  });
}

// ---------------------------------------------------------------- lo que espera a seguimiento

// Conversaciones ya abiertas: Dripify avisa por webhook sólo la primera respuesta, así que las de
// quienes ya respondieron se leen por la API. También completa el texto de las respuestas que
// llegaron por webhook sin él.
export async function revisarConversaciones(clientId, { hasta = Date.now() + 20_000, limite = CONVERSACIONES_POR_VUELTA } = {}) {
  const { rows } = await asClient(clientId, (c) => c.query(
    `select p.* from sdr.prospecto p
      where p.client_id = $1 and p.dripify is not null and p.linkedin_url is not null
        and (p.estado in ('respondio', 'positivo', 'derivo')
             or exists (select 1 from sdr.linkedin_respuesta l where l.client_id = p.client_id and l.prospecto_id = p.id and l.estado = 'nuevo' and l.texto is null))
        and coalesce((p.dripify->>'ultimo_lead_at')::timestamptz, p.ultima_interaccion_at, p.creado_at) > now() - make_interval(days => $2)
        and (p.dripify->>'revisado_at' is null or (p.dripify->>'revisado_at')::timestamptz < now() - make_interval(mins => $3))
      order by (p.dripify->>'revisado_at') nulls first limit $4`, [clientId, DIAS_CONVERSACION, RELEER_MIN, limite]));
  if (!rows.length) return [];
  let cx;
  try { cx = await conexion(clientId); } catch (e) { return [{ error: e.message }]; }
  const out = [];
  for (const p of rows) {
    if (Date.now() > hasta) break;
    try {
      out.push({ prospecto_id: p.id, nuevos: await revisarUna(cx, p) });
    } catch (e) {
      out.push({ prospecto_id: p.id, error: e.message });
      if (['dripify_limite', 'dripify_clave', 'dripify_sin_api'].includes(e.code)) break;
    }
  }
  return out;
}

async function revisarUna(cx, p) {
  const clientId = cx.clientId;
  const marcarRevisado = (extra = {}) => asClient(clientId, (c) => c.query(
    `update sdr.prospecto set dripify = coalesce(dripify, '{}'::jsonb) || $3::jsonb where client_id = $1 and id = $2`,
    [clientId, p.id, JSON.stringify({ revisado_at: new Date().toISOString(), ...extra })]));
  const lead = await leadDe(cx, p);
  if (!lead) { await marcarRevisado(); return 0; }
  const conv = await api(cx, 'GET', `/v1/open-api/leads/${lead}/conversation`, { permitir404: true });
  const { rows: sinTexto } = await asClient(clientId, (c) => c.query(
    `select id from sdr.linkedin_respuesta where client_id = $1 and prospecto_id = $2 and estado = 'nuevo' and texto is null`, [clientId, p.id]));
  const ultimo = p.dripify?.ultimo_lead_at ? new Date(p.dripify.ultimo_lead_at) : null;
  const hayNuevo = conv?.lastMessage?.direction === 'LEAD' && (!ultimo || new Date(conv.lastMessage.createdAt) > ultimo);
  if (!conv || (!hayNuevo && !sinTexto.length)) { await marcarRevisado(); return 0; }
  const msgs = (await api(cx, 'GET', `/v1/open-api/conversations/${encodeURIComponent(conv.conversationId)}/messages`))?.items ?? [];
  // Los mensajes vienen del más nuevo al más viejo. Lo del prospecto después de lo último nuestro.
  const delLead = [];
  for (const m of msgs) {
    if (m.direction !== 'LEAD') break;
    delLead.push(m);
  }
  delLead.reverse();
  return asClient(clientId, async (c) => {
    let nuevos = 0;
    if (sinTexto.length && delLead.length) {
      // Las que llegaron por webhook sin texto: se completan con lo que escribió la persona.
      await c.query(`update sdr.linkedin_respuesta set texto = $3, conversation_id = $4, lead_id = $5, mensaje_id = $6
                      where client_id = $1 and id = $2`,
      [clientId, sinTexto[0].id, delLead.map((m) => m.message).join('\n\n').slice(0, TEXTO_MAX), conv.conversationId, lead, delLead.at(-1).eventId ?? null]);
    } else if (hayNuevo) {
      for (const m of delLead.filter((x) => !ultimo || new Date(x.createdAt) > ultimo)) {
        const { rowCount } = await c.query(
          `insert into sdr.linkedin_respuesta (client_id, prospecto_id, lead_id, conversation_id, mensaje_id, texto, enviado_at, origen)
           values ($1, $2, $3, $4, $5, $6, $7, 'api') on conflict do nothing`,
          [clientId, p.id, lead, conv.conversationId, m.eventId ?? null, String(m.message ?? '').slice(0, TEXTO_MAX), m.createdAt ?? null]);
        nuevos += rowCount;
      }
      if (nuevos) {
        const ev = { tipo: 'respuesta', canal: 'linkedin', prospecto_id: p.id, ref: `dripify:${delLead.at(-1).eventId ?? conv.conversationId}`,
          datos: { mensajes: nuevos, conversacion: conv.conversationId } };
        await insertarEvento(c, clientId, ev, { bot: 'gateway', tarea: 'dripify', version: await versionActual(c, clientId) });
        await aplicarEvento(c, clientId, ev);
        await c.query(`update sdr.prospecto set proximo_paso = 'seguimiento: leer la respuesta de LinkedIn', proximo_canal = null, proximo_fecha = null
                        where client_id = $1 and id = $2`, [clientId, p.id]);
      }
    }
    const nuevoUltimo = delLead.length ? delLead.at(-1).createdAt : conv.lastMessage?.createdAt;
    await c.query(`update sdr.prospecto set dripify = coalesce(dripify, '{}'::jsonb) || $3::jsonb where client_id = $1 and id = $2`,
      [clientId, p.id, JSON.stringify({ revisado_at: new Date().toISOString(),
        ...(conv.lastMessage?.direction === 'LEAD' && nuevoUltimo ? { ultimo_lead_at: nuevoUltimo } : {}) })]);
    return nuevos;
  });
}

function publico(r) {
  return {
    id: Number(r.id), origen: r.origen, texto: r.texto, enviado_at: r.enviado_at, recibido_at: r.creado_at, avisos: r.avisos,
    prospecto: { id: r.prospecto_id, nombre: r.p_nombre, cargo: r.p_cargo, estado: r.p_estado, linkedin_url: r.p_linkedin },
    cuenta: r.k_nombre ? { nombre: r.k_nombre } : null,
  };
}

export async function pendientes(clientId, limite = 20) {
  return asClient(clientId, async (c) => {
    const { rows } = await c.query(
      `select l.*, p.nombre as p_nombre, p.cargo as p_cargo, p.estado as p_estado, p.linkedin_url as p_linkedin, k.nombre as k_nombre
         from sdr.linkedin_respuesta l join sdr.prospecto p on p.id = l.prospecto_id left join sdr.cuenta k on k.id = p.cuenta_id
        where l.client_id = $1 and l.estado = 'nuevo' order by l.id limit $2`, [clientId, limite]);
    const { rows: n } = await c.query(`select count(*)::int as n from sdr.linkedin_respuesta where client_id = $1 and estado = 'nuevo'`, [clientId]);
    return { pendientes: rows.map(publico), total: n[0].n };
  });
}

export async function atendido(clientId, { ids, resultado }, meta) {
  return asClient(clientId, async (c) => {
    const { rows } = await c.query(
      `update sdr.linkedin_respuesta set estado = 'atendido', atendido_at = now(), atendido_por = $3, resultado = $4
        where client_id = $1 and id = any($2) and estado = 'nuevo' returning id`, [clientId, ids, meta.bot ?? null, resultado]);
    return { atendidos: rows.map((r) => Number(r.id)), ya_atendidos_o_inexistentes: ids.filter((i) => !rows.some((r) => Number(r.id) === i)) };
  });
}

// ¿El cliente tiene Dripify listo para que el reloj lo use?
export async function clientesConDripify() {
  const { rows } = await asOwner((c) => c.query(
    `select client_id from sdr.dripify_cuenta where activo and api_key_enc is not null and campana_id is not null order by client_id`));
  return rows.map((r) => r.client_id);
}
