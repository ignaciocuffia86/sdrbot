// Mensaje crudo (RFC 822) → JSON que el script o el bot pueden usar sin parsear MIME.

import { simpleParser } from 'mailparser';
import { limits } from '../config.mjs';

const addr = (a) => (a ? { name: a.name || null, address: (a.address || '').toLowerCase() || null } : null);
const addrs = (field) => (field?.value ?? []).map(addr).filter((x) => x?.address);

function refsOf(parsed) {
  const r = parsed.references;
  if (!r) return [];
  return (Array.isArray(r) ? r : String(r).split(/\s+/)).filter(Boolean);
}

function header(parsed, name) {
  const v = parsed.headers?.get(name);
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && 'value' in v) return String(v.value);
  return String(v);
}

// Respuestas automáticas (fuera de oficina, acuses) que no cuentan como respuesta de una
// persona: RFC 3834 (Auto-Submitted) y las cabeceras de Exchange y de los autoresponders
// comunes.
function isAutoReply(parsed) {
  const autoSubmitted = header(parsed, 'auto-submitted');
  if (autoSubmitted && autoSubmitted.toLowerCase() !== 'no') return true;
  if (header(parsed, 'x-autoreply') || header(parsed, 'x-autorespond')) return true;
  const suppress = header(parsed, 'x-auto-response-suppress');
  if (suppress && /oof|autoreply|all/i.test(suppress)) return true;
  const precedence = header(parsed, 'precedence');
  if (precedence && /auto_reply|bulk|junk/i.test(precedence)) return true;
  return false;
}

// Rebotes: informe de entrega (RFC 3464) o remitentes de sistema.
function isBounce(parsed, from) {
  const ct = header(parsed, 'content-type') ?? '';
  if (/multipart\/report/i.test(ct) && /delivery-status/i.test(ct)) return true;
  const a = from?.address ?? '';
  return /^(mailer-daemon|postmaster)@/i.test(a);
}

// Lo que escribió la persona, sin la historia citada debajo. Heurística: corta en la
// primera línea que abre una cita en castellano, inglés o portugués, o en el primer bloque
// de líneas con ">". Para clasificar una respuesta alcanza; el texto completo va en `text`.
const QUOTE_START = [
  /^\s*El .{3,120}(escribió|escribio)\s*:\s*$/im,
  /^\s*On .{3,160}wrote\s*:\s*$/im,
  /^\s*Em .{3,160}escreveu\s*:\s*$/im,
  /^\s*-{2,}\s*(Original Message|Mensaje original|Mensagem original)\s*-{2,}\s*$/im,
  /^\s*_{10,}\s*$/m,
  /^\s*(De|From)\s*:\s.+\n\s*(Enviado|Sent|Fecha|Date)\s*:/im,
];

export function stripQuoted(text) {
  if (!text) return '';
  let cut = text.length;
  for (const re of QUOTE_START) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  const lines = text.slice(0, cut).split('\n');
  const firstQuoted = lines.findIndex((l) => /^\s*>/.test(l));
  const kept = firstQuoted >= 0 ? lines.slice(0, firstQuoted) : lines;
  return kept.join('\n').trim();
}

export async function parseMessage(source, meta = {}) {
  const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true });
  const from = addr(parsed.from?.value?.[0]);
  let text = parsed.text ?? '';
  const truncated = text.length > limits.maxTextChars;
  if (truncated) text = text.slice(0, limits.maxTextChars);
  return {
    uid: meta.uid ?? null,
    folder: meta.folder ?? null,
    flags: meta.flags ? [...meta.flags] : [],
    size: meta.size ?? null,
    message_id: parsed.messageId ?? null,
    in_reply_to: parsed.inReplyTo ?? null,
    references: refsOf(parsed),
    date: parsed.date ? parsed.date.toISOString() : null,
    from,
    reply_to: addrs(parsed.replyTo),
    to: addrs(parsed.to),
    cc: addrs(parsed.cc),
    subject: parsed.subject ?? '',
    text,
    text_truncated: truncated,
    reply_text: stripQuoted(text),
    has_html: Boolean(parsed.html),
    attachments: (parsed.attachments ?? []).map((a) => ({
      filename: a.filename ?? null, content_type: a.contentType ?? null, size: a.size ?? null,
    })),
    is_auto_reply: isAutoReply(parsed),
    is_bounce: isBounce(parsed, from),
  };
}

// Resumen sin cuerpo, a partir del sobre IMAP: para listados y búsquedas.
export function summaryFromEnvelope(msg, folder) {
  const env = msg.envelope ?? {};
  const one = (list) => (list?.[0] ? { name: list[0].name || null, address: (list[0].address || '').toLowerCase() || null } : null);
  const many = (list) => (list ?? []).map((a) => ({ name: a.name || null, address: (a.address || '').toLowerCase() || null }));
  return {
    uid: msg.uid,
    folder,
    flags: msg.flags ? [...msg.flags] : [],
    size: msg.size ?? null,
    message_id: env.messageId ?? null,
    in_reply_to: env.inReplyTo ?? null,
    date: env.date ? new Date(env.date).toISOString() : null,
    from: one(env.from),
    to: many(env.to),
    cc: many(env.cc),
    subject: env.subject ?? '',
  };
}
