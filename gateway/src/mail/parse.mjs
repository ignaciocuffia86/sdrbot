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

// Detalle de un rebote, sin LLM: a quién no llegó, por qué, si es definitivo y qué mensaje
// nuestro rebotó. Sale del informe de entrega (RFC 3464: Final-Recipient, Status, Action) o,
// en los rebotes en texto libre, de las cabeceras del original citadas en el cuerpo.
export function bounceInfo(source, ownMessageId) {
  const raw = Buffer.isBuffer(source) ? source.toString('utf8', 0, Math.min(source.length, 300_000)) : String(source).slice(0, 300_000);
  const recipients = new Set();
  for (const m of raw.matchAll(/^(?:Final|Original)-Recipient:\s*rfc822;\s*<?([^\s<>;]+@[^\s<>;]+)>?/gim)) recipients.add(m[1].toLowerCase());
  for (const m of raw.matchAll(/^X-Failed-Recipients:\s*(.+)$/gim)) {
    for (const a of m[1].split(',')) if (/@/.test(a)) recipients.add(a.trim().replace(/^<|>$/g, '').toLowerCase());
  }
  const status = /^Status:\s*([245]\.\d{1,3}\.\d{1,3})/im.exec(raw)?.[1] ?? null;
  const action = /^Action:\s*([a-z]+)/im.exec(raw)?.[1]?.toLowerCase() ?? null;
  const diagnostic = /^Diagnostic-Code:\s*(.+)$/im.exec(raw)?.[1]?.trim().slice(0, 500) ?? null;
  // El Message-ID del original está en el cuerpo (la parte citada), no en las cabeceras del aviso.
  const corte = raw.search(/\r?\n\r?\n/);
  const cuerpo = corte >= 0 ? raw.slice(corte) : raw;
  const ids = [...cuerpo.matchAll(/^Message-ID:\s*(<[^>\s]+>)/gim)].map((m) => m[1]).filter((id) => id !== ownMessageId);
  const temporary = status ? status.startsWith('4') : action ? action === 'delayed' : /delayed|delay notification|retrasad|demorad/i.test(raw.slice(0, 4000));
  return {
    recipients: [...recipients],
    status, action, diagnostic,
    original_message_id: ids[0] ?? null,
    permanent: !temporary,
  };
}

export async function parseMessage(source, meta = {}) {
  const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true });
  const from = addr(parsed.from?.value?.[0]);
  let text = parsed.text ?? '';
  const truncated = text.length > limits.maxTextChars;
  if (truncated) text = text.slice(0, limits.maxTextChars);
  const bounce = isBounce(parsed, from);
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
    is_bounce: bounce,
    ...(bounce ? { bounce: bounceInfo(source, parsed.messageId ?? null) } : {}),
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
