// Buzones por conector de Grok (docs/08 §7, etapa F1): el puente para Google y Microsoft mientras
// las aplicaciones de Biguá no están verificadas.
//
// El buzón está conectado en la cuenta de Grok del cliente y el bot manda y lee por el conector.
// El gateway no está en el camino del envío, así que el control va antes y después:
//   - reservar: los mismos controles que `enviar` (cupo, idempotencia, campaña y buzón de la
//     campaña, calibración y aprobación, supresiones, no contactar, links permitidos, prospecto
//     que ya respondió). Si pasa, queda una reserva en mailgw.send_log y el bot recibe un permiso
//     con el mail exacto que puede mandar.
//   - confirmar: el bot avisa que lo mandó; se cierra la reserva y se registra como cualquier envío.
//   - recibido: lo que `seguimiento` leyó por el conector entra a la memoria del correo.
//   - conciliar: una vez por día el bot pasa lo enviado por el conector; un envío sin reserva (o a
//     otros destinatarios, o con otro asunto) pausa el buzón y le avisa al orquestador.

import crypto from 'node:crypto';
import * as store from '../store.mjs';
import { asRole } from '../store.mjs';
import { errors, GatewayError } from '../errors.mjs';
import { buildMessage } from '../mail/compose.mjs';
import { stripQuoted } from '../mail/parse.mjs';
import * as sdr from './store.mjs';
import { controlarDestinatarios, guardarDelConector } from './correo.mjs';

const asClient = (clientId, fn) => asRole('mailgw_app', clientId, fn);
const dayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export const errorsConector = {
  noEsConector: (email) => new GatewayError('buzon_no_es_conector',
    `${email} no es un buzón por conector: se manda con enviar y se lee con correo_revisar.`, 409),
  esConector: (email) => new GatewayError('buzon_por_conector',
    `${email} es un buzón por el conector de Grok: no tiene IMAP ni SMTP en el gateway. ` +
    'Para mandar: correo_conector_reservar, el conector y correo_conector_confirmar. Para leer: el conector y correo_conector_recibido.', 409),
  permiso: (id) => new GatewayError('permiso_no_existe', `No hay una reserva ${id} pendiente para este cliente.`, 404),
  borradores: (email) => new GatewayError('buzon_en_borradores',
    `${email} está en modo borradores: el bot no confirma, lo manda una persona y lo confirma la conciliación diaria.`, 409),
};

// Cuántos días espera la reserva de un borrador a que una persona lo mande.
const DIAS_BORRADOR = 7;

// ---------------------------------------------------------------- utilidades

// La huella del texto: sin diferencias de saltos de línea ni espacios al final.
export function huella(texto) {
  const t = String(texto ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return crypto.createHash('sha256').update(t).digest('hex').slice(0, 32);
}

const asuntoNormal = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const destinatariosNormales = (l) => [...new Set((l ?? []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))].sort();
const mismos = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// Un uid estable para sdr.correo a partir del id del conector (la clave única es por buzón).
const uidDe = (conectorId) => Number.parseInt(crypto.createHash('sha256').update(String(conectorId)).digest('hex').slice(0, 13), 16);

async function cuentaConector(clientId, email) {
  const account = await store.getAccount(clientId, email);
  if (!account) throw errors.mailboxNotFound(email);
  if (account.auth !== 'conector') throw errorsConector.noEsConector(account.email);
  if (account.status === 'paused') throw errors.mailboxPaused(account.email);
  if (account.status === 'auth_error') throw errors.mailboxBlocked(account.email);
  return account;
}

async function filaReserva(clientId, id) {
  if (!/^\d{1,18}$/.test(String(id))) throw errorsConector.permiso(id);
  const { rows } = await asClient(clientId, (c) => c.query(
    `select l.*, a.email as buzon, a.conector_modo from mailgw.send_log l join mailgw.account a on a.id = l.account_id
      where l.client_id = $1 and l.id = $2 and l.via = 'conector'`, [clientId, id]));
  if (!rows.length) throw errorsConector.permiso(id);
  return rows[0];
}

// ---------------------------------------------------------------- reservar

// args: lo mismo que `enviar` (mailbox, to, cc, bcc, subject, text, prospecto_id, aprobacion_id,
// idempotency_key, bot, tarea, corrida), o `correo` (el id de sdr.correo) para responder.
export async function reservar(ctx, a) {
  const account = await cuentaConector(ctx.clientId, a.mailbox);
  ctx.accountId = account.id;
  let kind = 'send';
  let campos = { to: a.to, cc: a.cc, bcc: a.bcc, subject: a.subject, text: a.text };
  let responderA = null;
  if (a.correo) {
    const { rows } = await asClient(ctx.clientId, (c) => c.query(
      `select * from sdr.correo where client_id = $1 and id = $2 and account_id = $3`, [ctx.clientId, a.correo, account.id]));
    const orig = rows[0];
    if (!orig) throw errors.invalid(`No hay un correo ${a.correo} de ${account.email}.`);
    kind = 'reply';
    const asunto = /^\s*(re|rv|fw|fwd)\s*:/i.test(orig.asunto ?? '') ? orig.asunto : `Re: ${orig.asunto ?? ''}`.trim();
    campos = {
      to: a.to ?? orig.de, cc: a.cc, subject: a.subject ?? asunto, text: a.text,
      in_reply_to: orig.message_id || undefined, references: orig.message_id ? [orig.message_id] : [],
    };
    responderA = orig.datos?.conector_id ?? null;
  }
  if (!campos.text) throw errors.invalid('Falta el texto del mail.');
  const args = { ...a, ...campos, mailbox: account.email };
  // Los mismos controles que `enviar`, antes y con los destinatarios ya normalizados.
  // El buzón calibra por su cuenta: sus primeros mails nuevos confirmados van con aprobación.
  const { rows: [cal] } = await asClient(ctx.clientId, (c) => c.query(
    `select count(*)::int as usadas from mailgw.send_log
      where client_id = $1 and account_id = $2 and via = 'conector' and status = 'sent'
        and conector->>'kind' = 'send' and conector->>'aprobacion_id' is not null`, [ctx.clientId, account.id]));
  const { aprobacion, campanaId } = await sdr.controlarEnvio(ctx.clientId, args, kind,
    { calibracion: { usadas: cal.usadas, total: account.calibracion ?? 0 } });
  const built = await buildMessage(account, campos);
  await controlarDestinatarios(ctx.clientId, built.recipients, kind, a.prospecto_id, campanaId);

  const today = dayIn(account.timezone);
  const conector = {
    huella: huella(campos.text), kind, destinatarios: destinatariosNormales(built.recipients), asunto: built.subject,
    aprobacion_id: aprobacion?.id ?? null, prospecto_id: a.prospecto_id ?? null, campana_id: campanaId ?? null,
    in_reply_to: campos.in_reply_to ?? null, responder_a: responderA,
    meta: { bot: a.bot ?? null, tarea: a.tarea ?? null, corrida: a.corrida ?? null },
  };
  const res = await store.reserveSend(account, a.idempotency_key, today, kind);
  if (res.state === 'cap_reached') throw errors.capReached(account.daily_send_cap, today);
  let id = res.id;
  if (res.state === 'duplicate') {
    return { duplicate: true, message_id: res.row.message_id, recipients: res.row.recipients, subject: res.row.subject, sent_at: res.row.sent_at };
  }
  if (res.state === 'in_progress') {
    // Una reserva por conector con la misma clave y el mismo mail: el bot la pidió dos veces.
    const { rows } = await asClient(ctx.clientId, (c) => c.query(
      `select id, via, conector from mailgw.send_log where account_id = $1 and idempotency_key = $2`, [account.id, a.idempotency_key]));
    const prev = rows[0];
    if (prev?.via !== 'conector' || prev.conector?.huella !== conector.huella
        || !mismos(prev.conector?.destinatarios ?? [], conector.destinatarios)) throw errors.inProgress();
    id = prev.id;
  } else {
    await asClient(ctx.clientId, (c) => c.query(
      `update mailgw.send_log set via = 'conector', recipients = $3, subject = $4, conector = $5
        where client_id = $1 and id = $2`, [ctx.clientId, id, built.recipients, built.subject, JSON.stringify(conector)]));
  }
  const borradores = account.conector_modo === 'borradores';
  return {
    permiso: String(id),
    modo: borradores ? 'borradores' : 'envio',
    enviar: {
      desde: account.email, para: built.recipients.filter((x) => !parseBcc(a.bcc).includes(x)), cco: parseBcc(a.bcc),
      asunto: built.subject, texto: campos.text, in_reply_to: campos.in_reply_to ?? null, responder_a: responderA,
    },
    instruccion: borradores
      ? 'Este buzón está en modo borradores: NO lo mandes. Creá por el conector un borrador exactamente así (mismos ' +
        'destinatarios, asunto y texto; si es una respuesta, en el hilo) y no confirmes: lo manda una persona del cliente y ' +
        'la conciliación diaria lo confirma cuando aparece entre los enviados.'
      : 'Mandalo por el conector exactamente así (mismos destinatarios, asunto y texto) y después ' +
      'correo_conector_confirmar con este permiso y el Message-ID del mail enviado (o el id que da el conector). ' +
      'Si no lo mandás, no confirmes: la reserva se libera sola al día siguiente.',
    sends_today: await store.sendsToday(account, today),
    daily_send_cap: account.daily_send_cap,
  };
}

function parseBcc(bcc) {
  if (!bcc) return [];
  return (Array.isArray(bcc) ? bcc : String(bcc).split(',')).map((x) => (/<([^>]+)>/.exec(x)?.[1] ?? x).trim().toLowerCase()).filter(Boolean);
}

// ---------------------------------------------------------------- confirmar

async function cerrarReserva(clientId, fila, { messageId, conectorId }, warnings) {
  const account = await store.getAccount(clientId, fila.buzon);
  const k = fila.conector ?? {};
  const mid = messageId || (conectorId ? `<conector:${conectorId}>` : `<conector:permiso-${fila.id}>`);
  await store.completeSend(account, fila.id, {
    message_id: mid, recipients: fila.recipients, subject: fila.subject, smtp_response: 'conector', sent_folder: null, sent_uid: null,
  });
  if (conectorId) {
    await asClient(clientId, (c) => c.query(
      `update mailgw.send_log set conector = conector || jsonb_build_object('conector_id', $3::text) where client_id = $1 and id = $2`,
      [clientId, fila.id, conectorId]));
  }
  if (k.aprobacion_id) {
    await sdr.usarAprobacion(clientId, k.aprobacion_id, fila.idempotency_key).catch((e) => {
      warnings.push(`Quedó confirmado pero no se pudo marcar la aprobación como usada: ${e.message}`);
    });
  }
  if (k.prospecto_id) {
    await sdr.registrarEnvio(clientId, k.prospecto_id, {
      message_id: mid, asunto: fila.subject, buzon: fila.buzon, respuesta: k.kind === 'reply',
      idempotency_key: fila.idempotency_key, aprobacion: k.aprobacion_id ?? null, via: 'conector',
    }, { bot: k.meta?.bot ?? 'gateway', tarea: k.meta?.tarea ?? 'conector', corrida: k.meta?.corrida ?? null }).catch((e) => {
      warnings.push(`Quedó confirmado pero no se pudo registrar en la línea de tiempo: ${e.message}`);
    });
  }
  return mid;
}

export async function confirmar(ctx, a) {
  const fila = await filaReserva(ctx.clientId, a.permiso);
  ctx.accountId = fila.account_id;
  if (fila.status === 'sent') return { duplicate: true, message_id: fila.message_id, sent_at: fila.sent_at };
  // En borradores lo manda una persona: no lo confirma el bot, lo confirma la conciliación.
  if (fila.conector_modo === 'borradores') throw errorsConector.borradores(fila.buzon);
  const warnings = [];
  const mid = await cerrarReserva(ctx.clientId, fila, { messageId: a.message_id, conectorId: a.conector_id }, warnings);
  return { confirmado: true, message_id: mid, warnings };
}

// ---------------------------------------------------------------- recibido

// mensajes: [{ conector_id, message_id, de, de_nombre, asunto, texto, fecha, in_reply_to,
// references, automatica, rebote: { destinatarios, permanente } }]
export async function recibido(ctx, a) {
  const account = await store.getAccount(ctx.clientId, a.mailbox);
  if (!account) throw errors.mailboxNotFound(a.mailbox);
  if (account.auth !== 'conector') throw errorsConector.noEsConector(account.email);
  ctx.accountId = account.id;
  const correos = [];
  let guardados = 0;
  for (const x of a.mensajes) {
    const m = {
      uid: uidDe(x.conector_id), conector_id: x.conector_id, message_id: x.message_id ?? null,
      from: { address: String(x.de).trim().toLowerCase(), name: x.de_nombre ?? null }, reply_to: [],
      subject: x.asunto ?? '', date: x.fecha ? new Date(x.fecha) : new Date(),
      reply_text: stripQuoted(x.texto ?? ''), in_reply_to: x.in_reply_to ?? null, references: x.references ?? [],
      is_auto_reply: Boolean(x.automatica), is_bounce: Boolean(x.rebote),
      bounce: x.rebote ? { recipients: (x.rebote.destinatarios ?? []).map((d) => String(d).toLowerCase()), permanent: x.rebote.permanente !== false } : null,
    };
    const fila = await guardarDelConector(ctx.clientId, account, m);
    if (fila) {
      guardados += 1;
      correos.push({ id: Number(fila.id), tipo: fila.tipo, prospecto_id: fila.prospecto_id, conector_id: x.conector_id });
    }
  }
  return {
    recibidos: a.mensajes.length, guardados, correos,
    instruccion: guardados ? 'Ahora atendelos como siempre: correo_revisar te los da, primero las respuestas.' : 'Nada nuevo para el SDR.',
  };
}

// ---------------------------------------------------------------- conciliar

// Lo que el bot mandó por el conector un día contra las reservas de ese día.
// enviados: [{ message_id, conector_id, para: [..], asunto, texto }]
export async function conciliar(ctx, a) {
  const account = await store.getAccount(ctx.clientId, a.mailbox);
  if (!account) throw errors.mailboxNotFound(a.mailbox);
  if (account.auth !== 'conector') throw errorsConector.noEsConector(account.email);
  ctx.accountId = account.id;
  const hoy = dayIn(account.timezone);
  const { rows: filas } = await asClient(ctx.clientId, (c) => c.query(
    `select l.*, $3::text as buzon, l.day = $4::date as del_dia, l.day <= $4::date - ${DIAS_BORRADOR} as vencida, to_char(l.day, 'YYYY-MM-DD') as dia_txt
       from mailgw.send_log l
      where l.client_id = $1 and l.account_id = $2 and l.via = 'conector'
        and (l.day = $4::date or (l.status = 'reserved' and l.day between $4::date - 30 and $4::date))
      order by l.day, l.id`,
    [ctx.clientId, account.id, account.email, a.dia]));
  const usadas = new Set();
  const out = { dia: a.dia, enviados: a.enviados.length, conciliados: 0, confirmados_ahora: 0, liberados: 0, sin_reserva: [], texto_distinto: [], pausado: false, warnings: [] };

  for (const e of a.enviados) {
    const para = destinatariosNormales(e.para);
    const asunto = asuntoNormal(e.asunto);
    const ids = [e.message_id, e.conector_id ? `<conector:${e.conector_id}>` : null].filter(Boolean);
    let fila = filas.find((f) => !usadas.has(f.id) && (ids.includes(f.message_id) || (e.conector_id && f.conector?.conector_id === e.conector_id)));
    fila ??= filas.find((f) => !usadas.has(f.id) && mismos(f.conector?.destinatarios ?? [], para) && asuntoNormal(f.subject) === asunto);
    if (!fila) {
      out.sin_reserva.push({ para, asunto: e.asunto ?? '' });
      continue;
    }
    usadas.add(fila.id);
    out.conciliados += 1;
    if (e.texto && fila.conector?.huella && huella(e.texto) !== fila.conector.huella) {
      out.texto_distinto.push({ permiso: String(fila.id), para, asunto: e.asunto ?? '' });
    }
    if (fila.status === 'reserved') {
      await cerrarReserva(ctx.clientId, fila, { messageId: e.message_id, conectorId: e.conector_id }, out.warnings);
      out.confirmados_ahora += 1;
    }
  }
  // Reservas de un día que ya pasó que no aparecen entre lo enviado: no salieron, se libera el cupo.
  // Un borrador espera hasta DIAS_BORRADOR días a que la persona lo mande.
  if (a.dia < hoy) {
    const borradores = account.conector_modo === 'borradores';
    for (const f of filas) {
      if (f.status === 'reserved' && !usadas.has(f.id) && (borradores ? f.vencida : f.del_dia)) {
        await store.releaseSend(account, f.id, f.dia_txt);
        out.liberados += 1;
      }
    }
  }
  if (out.sin_reserva.length) {
    const motivo = `Conciliación del ${a.dia}: ${out.sin_reserva.length} mail(s) salieron por el conector sin reserva del gateway ` +
      `(${out.sin_reserva.map((x) => x.para.join(', ')).join('; ')}). El buzón queda en pausa hasta que Biguá lo revise.`;
    await asClient(ctx.clientId, (c) => c.query(
      `update mailgw.account set status = 'paused', last_error = $3, last_error_at = now(), updated_at = now()
        where client_id = $1 and id = $2`, [ctx.clientId, account.id, motivo]));
    out.pausado = true;
    await sdr.pedir(ctx.clientId, {
      para_bot: 'orquestador',
      que: `${motivo} Avisale al operador de Biguá en el chat. No mandes nada más por ${account.email} hasta que lo reactive.`,
      por_que: 'Conciliación de un buzón por conector.',
    }, { bot: 'gateway' }).catch((e) => out.warnings.push(`No se pudo avisar al orquestador: ${e.message}`));
  }
  return out;
}
