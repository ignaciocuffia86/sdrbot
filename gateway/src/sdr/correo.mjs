// Memoria del correo (etapa 2 de docs/09): leer los INBOX de los buzones del cliente, atar cada
// respuesta, respuesta automática, rebote y baja a su envío y a su prospecto, documentarlo en el
// registro y despertar al bot `seguimiento` por el webhook de su routine.
//
// Sin LLM: lo que se puede decidir con cabeceras (el hilo, el informe de entrega, Auto-Submitted)
// lo decide el gateway; lo que hay que leer (qué quiso decir la persona) lo decide el bot.
//
// Dos caminos llegan acá:
//   - el reloj (POST /cron/correo, pg_cron en Supabase): todos los clientes con `seguimiento`
//     activo, cada pocos minutos, y después el despertador;
//   - la herramienta correo_revisar: un bot lee en el momento los buzones de su cliente.
// Los dos usan el mismo cursor por buzón y el mismo permiso de unos segundos (ocupado_hasta).

import * as store from '../store.mjs';
import { asRole, asOwner } from '../store.mjs';
import { aadFor, decryptSecret, encryptSecret } from '../crypto.mjs';
import { GatewayError } from '../errors.mjs';
import { withImap, syncFolder } from '../mail/imap.mjs';
import { insertarEvento, aplicarEvento, versionActual } from './store.mjs';

const asClient = (clientId, fn) => asRole('mailgw_app', clientId, fn);

const CARPETA = 'INBOX';
const LOTE = 25;
const LOTES_POR_BUZON = 3;
// La primera lectura de un buzón (o después de que el servidor renumeró la carpeta) mira
// hasta esta cantidad de días para atrás.
const DIAS_PRIMERA_LECTURA = 7;
const TEXTO_MAX = 8000;
// Un correo avisado que sigue sin atender se vuelve a avisar después de esto, hasta tres veces.
const REAVISO_MIN = 90;
const AVISOS_MAX = 3;

const diaHace = (dias) => new Date(Date.now() - dias * 86_400_000).toISOString().slice(0, 10);

// Pedido de baja por la cabecera List-Unsubscribe (asunto BAJA) o un mail que sólo dice eso.
const BAJA_ASUNTO = /^\s*((re|rv|fw|fwd)\s*:\s*)*(baja|darme de baja|unsubscribe|remove me|remover)\s*$/i;
const BAJA_TEXTO = /^\s*(baja|darme de baja|unsubscribe|remove me)[\s.!]*$/i;
export const esBaja = (m) => BAJA_ASUNTO.test(m.subject ?? '') || BAJA_TEXTO.test(m.reply_text ?? '');

export function tipoDe(m) {
  if (m.is_bounce) return m.bounce?.permanent === false ? 'rebote_temporal' : 'rebote';
  if (esBaja(m)) return 'baja';
  if (m.is_auto_reply) return 'automatica';
  return 'respuesta';
}

// ---------------------------------------------------------------- un mensaje

// Ata un mensaje al registro y lo guarda. Devuelve la fila de sdr.correo, o null si el mensaje
// no tiene que ver con la prospección o ya estaba.
async function procesar(c, clientId, account, uidvalidity, m) {
  const de = m.from?.address ?? null;
  if (!de || de === account.email) return null;
  if (m.message_id) {
    const { rowCount } = await c.query(`select 1 from sdr.correo where client_id = $1 and message_id = $2`, [clientId, m.message_id]);
    if (rowCount) return null;
  }
  let tipo = tipoDe(m);
  const rebote = tipo === 'rebote' || tipo === 'rebote_temporal';
  const datos = {};
  if (rebote) {
    Object.assign(datos, {
      destinatarios: m.bounce?.recipients ?? [], status: m.bounce?.status ?? null,
      accion: m.bounce?.action ?? null, diagnostico: m.bounce?.diagnostic ?? null,
    });
  }
  if (m.too_large) datos.demasiado_grande = true;

  // 1. Por el hilo: In-Reply-To / References (o el Message-ID del original que rebotó) contra lo
  //    que mandó el gateway.
  const ids = [...new Set([m.bounce?.original_message_id, m.in_reply_to, ...(m.references ?? [])].filter(Boolean))].slice(0, 50);
  let enviado = null;
  let prospectoId = null;
  let cuentaId = null;
  let como = null;
  if (ids.length) {
    const { rows } = await c.query(
      `select l.message_id,
              (select e.prospecto_id from sdr.evento e
                where e.client_id = l.client_id and e.tipo = 'mail.enviado' and e.ref = l.message_id
                order by e.id desc limit 1) as prospecto_id
         from mailgw.send_log l
        where l.client_id = $1 and l.message_id = any($2) and l.status = 'sent'
        order by l.id desc limit 1`, [clientId, ids]);
    if (rows.length) {
      enviado = rows[0].message_id;
      prospectoId = rows[0].prospecto_id;
      como = 'hilo';
    }
  }
  // 2. Por la dirección: el remitente (o, en un rebote, el destinatario que falló) es un prospecto.
  if (!prospectoId) {
    const direcciones = rebote ? (m.bounce?.recipients ?? []) : [de, ...(m.reply_to ?? []).map((a) => a.address)];
    if (direcciones.length) {
      const { rows } = await c.query(
        `select id from sdr.prospecto where client_id = $1 and email = any($2) order by actualizado_at desc limit 1`,
        [clientId, direcciones.filter(Boolean)]);
      if (rows.length) {
        prospectoId = rows[0].id;
        como ??= rebote ? 'destinatario' : 'remitente';
      }
    }
  }
  // 3. Por el dominio: alguien de una cuenta que estamos trabajando escribió desde otra dirección.
  if (!prospectoId && !enviado && !rebote) {
    const dominio = de.split('@')[1];
    const { rows } = await c.query(
      `select id from sdr.cuenta where client_id = $1 and dominio = $2 and estado <> 'descartada' limit 1`, [clientId, dominio]);
    if (rows.length) {
      cuentaId = rows[0].id;
      como = 'dominio';
      if (tipo === 'respuesta') tipo = 'de_cuenta';
    }
  }
  // Un mail que no se relaciona con nada no se guarda, salvo un pedido de baja: ése se respeta
  // venga de quien venga.
  if (!enviado && !prospectoId && !cuentaId && tipo !== 'baja') return null;

  let prospecto = null;
  if (prospectoId) {
    const { rows } = await c.query(`select id, cuenta_id, email, nombre, estado from sdr.prospecto where client_id = $1 and id = $2`,
      [clientId, prospectoId]);
    prospecto = rows[0] ?? null;
    cuentaId = prospecto?.cuenta_id ?? cuentaId;
  }

  const texto = m.reply_text ? m.reply_text.slice(0, TEXTO_MAX) : null;
  const ins = await c.query(
    `insert into sdr.correo (client_id, account_id, carpeta, uidvalidity, uid, message_id, de, de_nombre, asunto, fecha,
                             tipo, prospecto_id, cuenta_id, enviado_message_id, como, texto, datos, estado, atendido_at, atendido_por, resultado)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     on conflict (account_id, uidvalidity, uid) do nothing
     returning *`,
    [clientId, account.id, CARPETA, uidvalidity, m.uid, m.message_id, de, m.from?.name ?? null, (m.subject ?? '').slice(0, 500),
      m.date, tipo, prospecto?.id ?? null, cuentaId, enviado, como, texto, JSON.stringify(datos),
      // Un rebote temporal no pide nada: el servidor del destinatario reintenta solo.
      tipo === 'rebote_temporal' ? 'atendido' : 'nuevo',
      tipo === 'rebote_temporal' ? new Date() : null,
      tipo === 'rebote_temporal' ? 'gateway' : null,
      tipo === 'rebote_temporal' ? 'Rebote temporal: el servidor de destino sigue intentando.' : null]);
  if (!ins.rows.length) return null;
  const fila = ins.rows[0];

  // Lo que el gateway documenta solo. Lo demás (qué responder, si es positivo) lo decide el bot.
  const meta = { bot: 'gateway', tarea: 'correo', version: await versionActual(c, clientId) };
  const base = { correo: Number(fila.id), buzon: account.email, asunto: fila.asunto };
  if (tipo === 'rebote' || tipo === 'baja') {
    const direcciones = tipo === 'rebote' ? (m.bounce?.recipients?.length ? m.bounce.recipients : prospecto?.email ? [prospecto.email] : []) : [de];
    for (const email of direcciones) {
      await c.query(
        `insert into sdr.supresion (client_id, email, motivo, origen) values ($1, $2, $3, $4) on conflict (client_id, email) do nothing`,
        [clientId, email, tipo === 'rebote' ? 'rebote' : 'baja', `correo ${fila.id}`]);
    }
  }
  if (prospecto) {
    const e = {
      rebote: { tipo: 'mail.rebotado', datos: { ...base, ...datos } },
      baja: { tipo: 'baja', datos: { ...base, por: 'mail' } },
      respuesta: { tipo: 'respuesta', datos: { ...base, como } },
      automatica: { tipo: 'nota', datos: { ...base, respuesta_automatica: true } },
    }[tipo];
    if (e) {
      const ev = { ...e, canal: 'mail', prospecto_id: prospecto.id, ref: m.message_id };
      await insertarEvento(c, clientId, ev, meta);
      await aplicarEvento(c, clientId, ev);
    }
    if (tipo === 'respuesta') {
      // El próximo paso con esta persona lo decide `seguimiento`, no la secuencia de mails.
      await c.query(
        `update sdr.prospecto set proximo_paso = 'seguimiento: leer la respuesta', proximo_canal = null, proximo_fecha = null,
                actualizado_at = now() where client_id = $1 and id = $2`, [clientId, prospecto.id]);
    }
  } else if (cuentaId && tipo !== 'rebote_temporal') {
    await insertarEvento(c, clientId, { tipo: 'nota', canal: 'mail', cuenta_id: cuentaId, ref: m.message_id,
      datos: { ...base, de, tipo_correo: tipo } }, meta);
  }
  return fila;
}

// ---------------------------------------------------------------- un buzón

async function tomarCursor(clientId, account) {
  return asClient(clientId, async (c) => {
    await c.query(`insert into sdr.buzon_cursor (account_id, client_id) values ($1, $2) on conflict (account_id) do nothing`,
      [account.id, clientId]);
    const { rows } = await c.query(
      `update sdr.buzon_cursor set ocupado_hasta = now() + interval '55 seconds'
        where account_id = $1 and client_id = $2 and (ocupado_hasta is null or ocupado_hasta < now())
        returning *`, [account.id, clientId]);
    return rows[0] ?? null;
  });
}

async function guardarCursor(clientId, accountId, cursor, error) {
  await asClient(clientId, (c) => c.query(
    `update sdr.buzon_cursor
        set uidvalidity = coalesce($3, uidvalidity), last_uid = coalesce($4, last_uid), ocupado_hasta = null,
            revisado_at = case when $5::text is null then now() else revisado_at end,
            ultimo_error = $5, ultimo_error_at = case when $5::text is null then ultimo_error_at else now() end
      where account_id = $1 and client_id = $2`,
    [accountId, clientId, cursor?.uidvalidity ?? null, cursor?.last_uid ?? null, error ?? null]));
}

// Lee lo nuevo de un buzón. Devuelve { buzon, leidos, guardados, error? }.
export async function revisarBuzon(clientId, email, { hasta } = {}) {
  const account = await store.getAccount(clientId, email);
  if (!account || account.status !== 'active') return { buzon: email, leidos: 0, guardados: 0, salteado: account?.status ?? 'no existe' };
  const cur = await tomarCursor(clientId, account);
  if (!cur) return { buzon: account.email, leidos: 0, guardados: 0, salteado: 'otra lectura en curso' };
  let cursor = cur.uidvalidity ? { uidvalidity: cur.uidvalidity, last_uid: Number(cur.last_uid) } : null;
  let leidos = 0;
  let guardados = 0;
  let error = null;
  try {
    const password = decryptSecret(account.secret_enc, aadFor(account.client_id, account.email));
    await withImap(account, password, async (client) => {
      for (let lote = 0; lote < LOTES_POR_BUZON; lote += 1) {
        if (hasta && Date.now() > hasta) break;
        // Con un cursor, la fecha sólo importa si el servidor renumeró la carpeta (reset).
        const r = await syncFolder(client, CARPETA, cursor, LOTE, { start: 'oldest', since: diaHace(DIAS_PRIMERA_LECTURA) });
        let ultimo = cursor?.uidvalidity === r.cursor.uidvalidity ? cursor.last_uid : 0;
        for (const m of r.messages) {
          try {
            const fila = await asClient(clientId, (c) => procesar(c, clientId, account, r.cursor.uidvalidity, m));
            if (fila) guardados += 1;
            leidos += 1;
            ultimo = m.uid;
          } catch (e) {
            // Se corta acá: el cursor queda antes de este mensaje y la próxima lectura lo reintenta.
            error = `Mensaje ${m.uid}: ${e.message}`;
            break;
          }
        }
        cursor = { uidvalidity: r.cursor.uidvalidity, last_uid: error ? ultimo : r.cursor.last_uid };
        if (error || !r.has_more) break;
      }
    });
    await store.recordAuth(account, true);
  } catch (e) {
    error = e.message;
    if (e instanceof GatewayError && e.code === 'mail_auth_failed') await store.recordAuth(account, false, e.message);
    else if (e instanceof GatewayError) await store.recordError(account, e.message);
  }
  await guardarCursor(clientId, account.id, cursor, error);
  return { buzon: account.email, leidos, guardados, ...(error ? { error } : {}) };
}

export async function revisarCliente(clientId, { hasta } = {}) {
  const out = [];
  for (const a of await store.listAccounts(clientId)) {
    if (a.status !== 'active') continue;
    if (hasta && Date.now() > hasta) { out.push({ buzon: a.email, leidos: 0, guardados: 0, salteado: 'sin tiempo: queda para la próxima' }); continue; }
    out.push(await revisarBuzon(clientId, a.email, { hasta }));
  }
  return out;
}

// ---------------------------------------------------------------- lo que espera al bot

function publico(r) {
  return {
    id: Number(r.id), tipo: r.tipo, buzon: r.buzon, carpeta: r.carpeta, uid: Number(r.uid),
    de: r.de, de_nombre: r.de_nombre, asunto: r.asunto, fecha: r.fecha, texto: r.texto,
    como: r.como, enviado_message_id: r.enviado_message_id, message_id: r.message_id, datos: r.datos,
    prospecto: r.prospecto_id ? { id: r.prospecto_id, nombre: r.p_nombre, cargo: r.p_cargo, email: r.p_email, estado: r.p_estado } : null,
    cuenta: r.cuenta_id ? { id: r.cuenta_id, nombre: r.k_nombre } : null,
    avisos: r.avisos, estado: r.estado,
  };
}

export async function pendientes(clientId, limite) {
  return asClient(clientId, async (c) => {
    const { rows } = await c.query(
      `select x.*, a.email as buzon, p.nombre as p_nombre, p.cargo as p_cargo, p.email as p_email, p.estado as p_estado,
              k.nombre as k_nombre
         from sdr.correo x join mailgw.account a on a.id = x.account_id
         left join sdr.prospecto p on p.id = x.prospecto_id left join sdr.cuenta k on k.id = x.cuenta_id
        where x.client_id = $1 and x.estado = 'nuevo'
        order by case x.tipo when 'respuesta' then 0 when 'de_cuenta' then 1 when 'baja' then 2 when 'rebote' then 3 else 4 end, x.id
        limit $2`, [clientId, limite]);
    const { rows: n } = await c.query(`select count(*)::int as n from sdr.correo where client_id = $1 and estado = 'nuevo'`, [clientId]);
    return { pendientes: rows.map(publico), total: n[0].n };
  });
}

export async function atendido(clientId, { ids, resultado }, meta) {
  return asClient(clientId, async (c) => {
    const { rows } = await c.query(
      `update sdr.correo set estado = 'atendido', atendido_at = now(), atendido_por = $3, resultado = $4
        where client_id = $1 and id = any($2) and estado = 'nuevo' returning id`,
      [clientId, ids, meta.bot ?? null, resultado]);
    return { atendidos: rows.map((r) => Number(r.id)), ya_atendidos_o_inexistentes: ids.filter((i) => !rows.some((r) => Number(r.id) === i)) };
  });
}

// Prospectos en contacto cuyo último mail salió hace más de N días y no tienen respuesta después.
export async function sinRespuesta(clientId, { dias, limite }) {
  return asClient(clientId, async (c) => {
    const { rows } = await c.query(
      `with ultimo as (
         select e.prospecto_id, max(e.at) as at, count(*)::int as mails,
                (array_agg(e.ref order by e.id desc))[1] as message_id
           from sdr.evento e where e.client_id = $1 and e.tipo = 'mail.enviado' and e.prospecto_id is not null
          group by e.prospecto_id)
       select p.id, p.nombre, p.cargo, p.email, p.estado, p.proximo_paso, p.proximo_fecha, k.nombre as cuenta,
              u.at as ultimo_mail_at, u.mails, u.message_id as ultimo_message_id
         from ultimo u join sdr.prospecto p on p.id = u.prospecto_id left join sdr.cuenta k on k.id = p.cuenta_id
        where p.client_id = $1 and p.estado in ('en_contacto', 'sin_respuesta')
          and u.at < now() - make_interval(days => $2)
          and not exists (select 1 from sdr.evento r where r.client_id = $1 and r.prospecto_id = p.id
                            and r.tipo in ('respuesta', 'baja', 'mail.rebotado', 'positivo') and r.at > u.at)
          and not exists (select 1 from sdr.correo x where x.client_id = $1 and x.prospecto_id = p.id and x.estado = 'nuevo')
        order by u.at limit $3`, [clientId, dias, limite]);
    return { dias, prospectos: rows };
  });
}

// ---------------------------------------------------------------- reglas al enviar

const CERRADOS = { respondio: 'ya respondió', positivo: 'es un positivo', derivo: 'derivó a otra persona',
  negativo: 'dijo que no', baja: 'pidió la baja', en_crm: 'ya está en el CRM', descartado: 'está descartado' };

// Antes de que salga un mail: nadie de la supresión; y un mail nuevo (no una respuesta en el
// hilo) no va a quien ya respondió o tiene una respuesta sin leer: eso lo decide `seguimiento`.
export async function controlarDestinatarios(clientId, recipients, kind, prospectoId) {
  const emails = [...new Set((recipients ?? []).map((r) => String(r).toLowerCase()))];
  return asClient(clientId, async (c) => {
    const { rows: sup } = await c.query(
      `select email, motivo from sdr.supresion where client_id = $1 and email = any($2)`, [clientId, emails]);
    if (sup.length) {
      throw new GatewayError('destinatario_suprimido',
        `No se le escribe más a ${sup.map((s) => `${s.email} (${s.motivo})`).join(', ')}: está en la supresión del cliente.`, 409);
    }
    if (kind !== 'send') return;
    const { rows } = await c.query(
      `select p.id, p.email, p.estado,
              exists (select 1 from sdr.correo x where x.client_id = p.client_id and x.prospecto_id = p.id and x.estado = 'nuevo') as sin_leer
         from sdr.prospecto p where p.client_id = $1 and (p.email = any($2) or p.id = $3::uuid)`,
      [clientId, emails, prospectoId ?? null]);
    for (const p of rows) {
      if (p.sin_leer) {
        throw new GatewayError('respuesta_sin_atender',
          `${p.email ?? 'Esta persona'} tiene una respuesta sin atender: la lee seguimiento (correo_revisar) antes de escribirle otra cosa.`, 409);
      }
      if (CERRADOS[p.estado]) {
        throw new GatewayError('prospecto_respondio',
          `${p.email ?? 'Esta persona'} ${CERRADOS[p.estado]} (estado ${p.estado}): no va otro mail de la secuencia. ` +
          'Lo que sigue lo decide seguimiento, y se contesta con responder en el hilo.', 409);
      }
    }
  });
}

// ---------------------------------------------------------------- despertador (dueño)

export async function configurarDespertador(clientId, bot, d) {
  return asOwner(async (c) => {
    if (d.apagar) {
      const { rowCount } = await c.query(`update sdr.despertador set activo = false, actualizado_at = now() where client_id = $1 and bot = $2`, [clientId, bot]);
      return { apagado: rowCount > 0 };
    }
    if (!/^https:\/\/[^\s]+$/.test(d.url ?? '')) throw new GatewayError('invalid_request', 'La URL del webhook tiene que empezar con https://.', 400);
    let enc = null;
    if (d.clave) {
      enc = encryptSecret(d.clave, aadDespertador(clientId, bot));
    } else {
      // Sin clave nueva se conserva la guardada (por ejemplo, para cambiar sólo el horario).
      const { rows } = await c.query(`select clave_enc from sdr.despertador where client_id = $1 and bot = $2`, [clientId, bot]);
      if (!rows.length) throw new GatewayError('invalid_request', 'Falta la clave del webhook.', 400);
      enc = rows[0].clave_enc;
    }
    await c.query(
      `insert into sdr.despertador (client_id, bot, url, clave_enc, hora_desde, hora_hasta, dias, espera_min)
       values ($1, $2, $3, $4, coalesce($5, 8), coalesce($6, 20), coalesce($7::int[], '{1,2,3,4,5}'), coalesce($8, 10))
       on conflict (client_id, bot) do update set url = excluded.url, clave_enc = excluded.clave_enc, activo = true,
         hora_desde = coalesce($5, sdr.despertador.hora_desde), hora_hasta = coalesce($6, sdr.despertador.hora_hasta),
         dias = coalesce($7::int[], sdr.despertador.dias), espera_min = coalesce($8, sdr.despertador.espera_min),
         fallas = 0, ultimo_error = null, actualizado_at = now()`,
      [clientId, bot, d.url, enc, d.hora_desde ?? null, d.hora_hasta ?? null, d.dias ?? null, d.espera_min ?? null]);
    return { client_id: clientId, bot, url: d.url };
  });
}

export const aadDespertador = (clientId, bot) => `despertador:${clientId}:${bot}`;

// Lo que el panel muestra de un despertador: nunca la clave.
export async function verDespertador(c, clientId, bot = 'seguimiento') {
  const { rows } = await c.query(
    `select bot, url, activo, hora_desde, hora_hasta, dias, espera_min, ultimo_aviso_at, ultimo_estado, ultimo_error, fallas, actualizado_at
       from sdr.despertador where client_id = $1 and bot = $2`, [clientId, bot]);
  return rows[0] ?? null;
}

export async function clavesDespertador() {
  return (await asOwner((c) => c.query(`select client_id, bot, clave_enc from sdr.despertador`))).rows;
}

export async function setClaveDespertador(clientId, bot, enc) {
  await asOwner((c) => c.query(`update sdr.despertador set clave_enc = $3 where client_id = $1 and bot = $2`, [clientId, bot, enc]));
}

function enHorario(d, tz, ahora = new Date()) {
  const partes = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(ahora).map((p) => [p.type, p.value]));
  const dia = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[partes.weekday];
  const hora = Number(partes.hour);
  return d.dias.includes(dia) && hora >= d.hora_desde && hora < d.hora_hasta;
}

// Despierta al bot de un cliente si hay correo nuevo sin avisar. Agrupa: un aviso con la lista,
// a lo sumo uno cada espera_min minutos; si el webhook falla, reintenta en el próximo tick con
// una espera que crece (2, 4, 8… hasta 60 minutos).
export async function despertar(clientId, bot = 'seguimiento', { fetchImpl = fetch, ahora = new Date() } = {}) {
  const { rows } = await asOwner((c) => c.query(
    `select d.*, coalesce(k.zona_horaria, 'America/Argentina/Buenos_Aires') as zona_horaria
       from sdr.despertador d left join sdr.cliente_config k on k.client_id = d.client_id
      where d.client_id = $1 and d.bot = $2 and d.activo`, [clientId, bot]));
  const d = rows[0];
  if (!d) return { despertado: false, motivo: 'sin despertador' };
  if (!enHorario(d, d.zona_horaria, ahora)) return { despertado: false, motivo: 'fuera de horario' };
  const desde = d.ultimo_aviso_at ? (ahora - new Date(d.ultimo_aviso_at)) / 60_000 : Infinity;
  const espera = d.fallas > 0 ? Math.min(2 ** d.fallas, 60) : d.espera_min;
  if (desde < espera) return { despertado: false, motivo: 'esperando para agrupar' };
  const { rows: nuevos } = await asClient(clientId, (c) => c.query(
    `select id, tipo, de, asunto from sdr.correo
      where client_id = $1 and estado = 'nuevo' and avisos < $2
        and (avisado_at is null or avisado_at < now() - make_interval(mins => $3))
      order by id limit 50`, [clientId, AVISOS_MAX, REAVISO_MIN]));
  if (!nuevos.length) return { despertado: false, motivo: 'nada nuevo' };
  const cuerpo = {
    motivo: 'correo',
    cliente: clientId,
    correos_nuevos: nuevos.length,
    correos: nuevos.slice(0, 20).map((r) => ({ id: Number(r.id), tipo: r.tipo, de: r.de, asunto: r.asunto })),
    instruccion: 'Llegó correo para atender. Seguí tus reglas de la tarea respuestas: correo_revisar te da el detalle.',
  };
  let estado = null;
  let error = null;
  try {
    const clave = decryptSecret(d.clave_enc, aadDespertador(clientId, bot));
    const res = await fetchImpl(d.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${clave}`, 'content-type': 'application/json' },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(10_000),
    });
    estado = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (e) {
    error = e.message;
  }
  await asOwner(async (c) => {
    await c.query(
      `update sdr.despertador set ultimo_aviso_at = now(), ultimo_estado = $3, ultimo_error = $4,
              fallas = case when $4::text is null then 0 else fallas + 1 end
        where client_id = $1 and bot = $2`, [clientId, bot, estado, error]);
    if (!error) {
      await c.query(`update sdr.correo set avisado_at = now(), avisos = avisos + 1 where client_id = $1 and id = any($2)`,
        [clientId, nuevos.map((r) => r.id)]);
    }
  });
  return { despertado: !error, correos: nuevos.length, estado, ...(error ? { error } : {}) };
}

// ---------------------------------------------------------------- reloj (dueño)

export async function setSecretoReloj(hash) {
  await asOwner((c) => c.query(
    `insert into sdr.reloj (id, secreto_hash) values (true, $1) on conflict (id) do update set secreto_hash = excluded.secreto_hash`, [hash]));
}

export async function hashReloj() {
  const { rows } = await asOwner((c) => c.query(`select secreto_hash from sdr.reloj where id`));
  return rows[0]?.secreto_hash ?? null;
}

// Una vuelta del reloj: lee los buzones de los clientes con `seguimiento` activo, del que hace
// más tiempo que no se lee al más reciente, hasta el tiempo disponible; después despierta.
export async function tick({ hasta = Date.now() + 40_000, fetchImpl } = {}) {
  const inicio = Date.now();
  const { rows } = await asOwner((c) => c.query(
    `select a.client_id, a.email from mailgw.account a
       join sdr.cliente_config k on k.client_id = a.client_id and 'seguimiento' = any(k.bots_activos)
       left join sdr.buzon_cursor b on b.account_id = a.id
      where a.status = 'active'
      order by b.revisado_at nulls first`));
  const buzones = [];
  for (const r of rows) {
    if (Date.now() > hasta) { buzones.push({ cliente: r.client_id, buzon: r.email, salteado: 'sin tiempo' }); continue; }
    buzones.push({ cliente: r.client_id, ...(await revisarBuzon(r.client_id, r.email, { hasta })) });
  }
  const despertados = [];
  for (const clientId of [...new Set(rows.map((r) => r.client_id))]) {
    try {
      despertados.push({ cliente: clientId, ...(await despertar(clientId, 'seguimiento', { fetchImpl })) });
    } catch (e) {
      despertados.push({ cliente: clientId, despertado: false, error: e.message });
    }
  }
  const resultado = { ms: Date.now() - inicio, buzones, despertados };
  await asOwner((c) => c.query(`update sdr.reloj set ultimo_tick_at = now(), ultimo_resultado = $1 where id`, [JSON.stringify(resultado)]));
  return resultado;
}

