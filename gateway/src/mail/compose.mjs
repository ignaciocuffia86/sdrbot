// Armado de mensajes: envíos nuevos, respuestas en el mismo hilo y borradores.
// El mensaje se arma una sola vez como RFC 822 crudo: ese mismo crudo se entrega por SMTP
// y se guarda en Enviados, así el Message-ID y el contenido son idénticos en los dos lados.

import crypto from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer';
import addressparser from 'nodemailer/lib/addressparser';
import { limits } from '../config.mjs';
import { errors } from '../errors.mjs';

function parseList(value, field) {
  if (value == null || value === '') return [];
  const raw = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of raw) {
    for (const a of addressparser(String(item), { flatten: true })) {
      const address = String(a.address ?? '').trim().toLowerCase();
      if (!/^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/.test(address)) {
        throw errors.invalid(`Dirección inválida en "${field}": ${item}`);
      }
      out.push({ name: a.name || '', address });
    }
  }
  return out;
}

const fmt = (a) => (a.name ? { name: a.name, address: a.address } : a.address);

export function newMessageId(fromEmail) {
  const domain = fromEmail.split('@')[1] || 'mailgw.local';
  return `<${crypto.randomUUID()}@${domain}>`;
}

export function buildMessage(account, m) {
  const to = parseList(m.to, 'to');
  const cc = parseList(m.cc, 'cc');
  const bcc = parseList(m.bcc, 'bcc');
  const all = [...to, ...cc, ...bcc];
  if (!all.length) throw errors.invalid('Falta al menos un destinatario.');
  if (all.length > limits.maxRecipients) {
    throw errors.notAllowed(`Más de ${limits.maxRecipients} destinatarios en un envío. El gateway es para mails uno a uno.`);
  }
  if (!m.text && !m.html) throw errors.invalid('Falta el cuerpo: text o html.');
  const messageId = newMessageId(account.email);
  const headers = {};
  if (m.unsubscribe_mailto) {
    headers['List-Unsubscribe'] = `<mailto:${account.email}?subject=${encodeURIComponent(m.unsubscribe_subject || 'BAJA')}>`;
  }
  const mail = new MailComposer({
    from: account.display_name ? { name: account.display_name, address: account.email } : account.email,
    to: to.map(fmt),
    cc: cc.map(fmt),
    // Bcc no va en las cabeceras del mensaje: sólo en el sobre SMTP.
    subject: m.subject ?? '',
    text: m.text || undefined,
    html: m.html || undefined,
    messageId,
    inReplyTo: m.in_reply_to || undefined,
    references: m.references?.length ? m.references : undefined,
    headers,
    date: m.date ?? new Date(),
  });
  return mail.compile().build().then((raw) => ({
    raw,
    messageId,
    subject: m.subject ?? '',
    envelope: { from: account.email, to: all.map((a) => a.address) },
    recipients: all.map((a) => a.address),
  }));
}

// "El 03/11/2026 10:00, Laura Gómez <laura@...> escribió:" en la zona del buzón, 24 horas.
function quoteBlock(original, timeZone) {
  let when = '';
  if (original.date) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(original.date)).map((x) => [x.type, x.value]));
    when = `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
  }
  const who = original.from?.name ? `${original.from.name} <${original.from.address}>` : (original.from?.address ?? '');
  const body = (original.text ?? '').split('\n').map((l) => `> ${l}`).join('\n');
  return `\n\nEl ${when}, ${who} escribió:\n${body}`;
}

// Campos de una respuesta a partir del original: destinatarios, asunto con "Re:", y las
// cabeceras In-Reply-To y References que mantienen el hilo en el cliente de correo de
// quien recibe.
export function replyFields(account, original, r) {
  const self = account.email.toLowerCase();
  const primary = original.reply_to?.length ? original.reply_to : (original.from ? [original.from] : []);
  let to = primary.filter((a) => a.address && a.address !== self);
  let cc = [];
  if (r.reply_all) {
    const seen = new Set([self, ...to.map((a) => a.address)]);
    cc = [...(original.to ?? []), ...(original.cc ?? [])].filter((a) => a.address && !seen.has(a.address) && seen.add(a.address));
  }
  if (!to.length) {
    // Respuesta a un mensaje que mandó el propio buzón: se responde a sus destinatarios.
    to = (original.to ?? []).filter((a) => a.address && a.address !== self);
  }
  if (!to.length) throw errors.notAllowed('El mensaje original no tiene a quién responder.');
  const subject = /^\s*(re|rv|fw|fwd)\s*:/i.test(original.subject ?? '') ? original.subject : `Re: ${original.subject ?? ''}`.trim();
  const references = [...(original.references ?? [])];
  if (original.message_id && !references.includes(original.message_id)) references.push(original.message_id);
  const quote = r.quote === false ? '' : quoteBlock(original, account.timezone ?? 'UTC');
  return {
    to: to.map((a) => (a.name ? `"${a.name.replace(/"/g, '')}" <${a.address}>` : a.address)),
    cc: cc.map((a) => a.address),
    subject,
    text: r.text ? `${r.text}${quote}` : undefined,
    html: r.html || undefined,
    in_reply_to: original.message_id || undefined,
    references,
  };
}
