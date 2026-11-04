// Operaciones IMAP. Cada pedido abre una conexión, hace lo suyo y la cierra: corre en una
// función serverless que no puede mantener conexiones vivas entre invocaciones.

import { ImapFlow } from 'imapflow';
import { limits } from '../config.mjs';
import { errors, GatewayError } from '../errors.mjs';
import { parseMessage, summaryFromEnvelope } from './parse.mjs';

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT', 'ETIMEOUT', 'NoConnection']);

export function classifyImapError(e) {
  if (e instanceof GatewayError) return e;
  if (e?.authenticationFailed) return errors.authFailed('IMAP');
  const code = e?.code ?? '';
  if (NETWORK_CODES.has(code) || /timeout|certificate|self.signed|ECONN|TLS|socket/i.test(`${code} ${e?.message}`)) {
    return errors.unreachable('IMAP', e?.message ?? code);
  }
  return errors.mailServer('IMAP', e?.responseText || e?.message || String(e));
}

export async function withImap(account, password, fn) {
  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure: account.imap_security === 'tls',
    // Con starttls la contraseña nunca viaja sin cifrar: si el servidor no ofrece
    // STARTTLS la conexión falla en vez de autenticar en claro.
    doSTARTTLS: account.imap_security === 'starttls' ? true : undefined,
    auth: { user: account.username, pass: password },
    logger: false,
    connectionTimeout: limits.connectionTimeoutMs,
    greetingTimeout: limits.connectionTimeoutMs,
    socketTimeout: limits.socketTimeoutMs,
    disableAutoIdle: true,
  });
  client.on('error', () => {});
  try {
    await client.connect();
  } catch (e) {
    throw classifyImapError(e);
  }
  try {
    return await fn(client);
  } catch (e) {
    throw classifyImapError(e);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

// ---------------------------------------------------------------- carpetas

export async function listFolders(client) {
  const list = await client.list({ statusQuery: { messages: true, unseen: true, uidNext: true } });
  return list.map((f) => ({
    path: f.path,
    name: f.name,
    delimiter: f.delimiter,
    special_use: f.specialUse ?? null,
    subscribed: Boolean(f.subscribed),
    messages: f.status?.messages ?? null,
    unseen: f.status?.unseen ?? null,
  }));
}

const FALLBACK_NAMES = {
  '\\Sent': ['Sent', 'Sent Items', 'Sent Messages', 'INBOX.Sent', 'INBOX/Sent', 'Enviados',
    'Elementos enviados', 'INBOX.Enviados'],
  '\\Drafts': ['Drafts', 'INBOX.Drafts', 'INBOX/Drafts', 'Borradores', 'INBOX.Borradores'],
  '\\Trash': ['Trash', 'INBOX.Trash', 'Papelera', 'Deleted Items', 'Elementos eliminados'],
};

// La carpeta de un uso especial: la configurada en el buzón, la marcada con SPECIAL-USE
// por el servidor, o la primera que exista entre los nombres habituales. Si no hay
// ninguna y se pide crear, crea la del primer nombre.
export async function specialFolder(client, use, configured, { create = false } = {}) {
  const list = await client.list();
  const paths = new Set(list.map((f) => f.path));
  if (configured) {
    if (paths.has(configured)) return configured;
    throw errors.folderNotFound(configured);
  }
  const marked = list.find((f) => f.specialUse === use);
  if (marked) return marked.path;
  const lower = new Map(list.map((f) => [f.path.toLowerCase(), f.path]));
  for (const name of FALLBACK_NAMES[use] ?? []) {
    const hit = lower.get(name.toLowerCase());
    if (hit) return hit;
  }
  if (!create) return null;
  const created = await client.mailboxCreate(FALLBACK_NAMES[use][0]);
  return created.path;
}

async function lockFolder(client, folder, readOnly) {
  try {
    return await client.getMailboxLock(folder, { readOnly });
  } catch (e) {
    if (/nonexistent|doesn't exist|does not exist|not found|no such|NONEXISTENT/i.test(`${e?.responseText} ${e?.message}`)) {
      throw errors.folderNotFound(folder);
    }
    throw e;
  }
}

export async function createFolder(client, path) {
  const r = await client.mailboxCreate(path);
  return { path: r.path, created: Boolean(r.created) };
}

// ---------------------------------------------------------------- lectura

// Mensajes nuevos de una carpeta desde un cursor { uidvalidity, last_uid }.
// El cursor lo guarda quien llama (la base de control): el gateway no guarda estado de
// lectura. Si UIDVALIDITY cambió, el servidor renumeró la carpeta y se relee desde cero
// con reset = true.
// Sin cursor: start "oldest" empieza por el primer mensaje de la carpeta; start "now"
// no trae nada y devuelve el cursor parado en el último mensaje actual, para leer sólo lo
// que llegue de acá en adelante; since (AAAA-MM-DD) limita a lo recibido desde esa fecha.
export async function syncFolder(client, folder, cursor, limit, { start = 'oldest', since } = {}) {
  const lock = await lockFolder(client, folder, true);
  try {
    const uidValidity = String(client.mailbox.uidValidity);
    let lastUid = Number(cursor?.last_uid ?? 0);
    let reset = false;
    if (cursor?.uidvalidity && String(cursor.uidvalidity) !== uidValidity) {
      lastUid = 0;
      reset = true;
    }
    if (!cursor && start === 'now') {
      const top = Math.max(Number(client.mailbox.uidNext ?? 1) - 1, 0);
      return { folder, messages: [], cursor: { uidvalidity: uidValidity, last_uid: top }, has_more: false, reset: false };
    }
    // "N:*" en IMAP siempre incluye el último mensaje aunque su uid sea menor que N:
    // por eso se filtra después.
    const query = { uid: `${lastUid + 1}:*` };
    if (since) query.since = isoDate(since);
    const found = (await client.search(query, { uid: true })) || [];
    const pending = found.filter((u) => u > lastUid).sort((a, b) => a - b);
    const take = pending.slice(0, limit);
    const messages = await fetchParsed(client, folder, take);
    const newLast = take.length ? take[take.length - 1] : lastUid;
    return {
      folder,
      messages,
      cursor: { uidvalidity: uidValidity, last_uid: newLast },
      has_more: pending.length > take.length,
      reset,
    };
  } finally {
    lock.release();
  }
}

async function fetchParsed(client, folder, uids) {
  if (!uids.length) return [];
  const meta = new Map();
  for await (const m of client.fetch(uids.join(','), { uid: true, size: true, flags: true, envelope: true }, { uid: true })) {
    meta.set(m.uid, m);
  }
  const out = [];
  for (const uid of uids) {
    const m = meta.get(uid);
    if (!m) continue;
    if (m.size > limits.maxMessageBytes) {
      out.push({ ...summaryFromEnvelope(m, folder), too_large: true, text: null, reply_text: null, attachments: [] });
      continue;
    }
    const full = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
    out.push(await parseMessage(full.source, { uid, folder, flags: m.flags, size: m.size }));
  }
  return out;
}

export async function readMessage(client, folder, uid, markSeen) {
  const lock = await lockFolder(client, folder, !markSeen);
  try {
    const m = await client.fetchOne(String(uid), { uid: true, flags: true, size: true, source: true }, { uid: true });
    if (!m) throw errors.messageNotFound(folder, uid);
    if (markSeen) await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
    const flags = new Set(m.flags ?? []);
    if (markSeen) flags.add('\\Seen');
    return await parseMessage(m.source, { uid, folder, flags, size: m.size });
  } finally {
    lock.release();
  }
}

const isoDate = (s) => (s ? new Date(`${s}T00:00:00Z`) : undefined);

export async function searchFolder(client, folder, c, limit) {
  const lock = await lockFolder(client, folder, true);
  try {
    const query = {};
    if (c.since) query.since = isoDate(c.since);
    if (c.before) query.before = isoDate(c.before);
    if (c.from) query.from = c.from;
    if (c.to) query.to = c.to;
    if (c.subject) query.subject = c.subject;
    if (c.text) query.body = c.text;
    if (c.unseen === true) query.seen = false;
    if (c.unanswered === true) query.answered = false;
    if (c.flagged === true) query.flagged = true;
    if (c.keyword) query.keyword = c.keyword;
    if (c.not_keyword) query.unKeyword = c.not_keyword;
    if (!Object.keys(query).length) query.all = true;
    const uids = ((await client.search(query, { uid: true })) || []).sort((a, b) => b - a);
    const take = uids.slice(0, limit);
    const out = [];
    if (take.length) {
      for await (const m of client.fetch(take.join(','), { uid: true, flags: true, size: true, envelope: true }, { uid: true })) {
        out.push(summaryFromEnvelope(m, folder));
      }
    }
    out.sort((a, b) => b.uid - a.uid);
    return { folder, total: uids.length, messages: out };
  } finally {
    lock.release();
  }
}

// Lo que hace falta del original para responder: cabeceras de hilo, remitentes y texto.
export async function originalForReply(client, folder, uid) {
  const lock = await lockFolder(client, folder, true);
  try {
    const m = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
    if (!m) throw errors.messageNotFound(folder, uid);
    return await parseMessage(m.source, { uid, folder });
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------- gestión

const SYSTEM_FLAGS = new Set(['\\Seen', '\\Answered', '\\Flagged']);
const KEYWORD = /^[A-Za-z0-9_$.-]{1,40}$/;

export function validateFlags(list) {
  for (const f of list ?? []) {
    if (f.startsWith('\\')) {
      if (!SYSTEM_FLAGS.has(f)) {
        throw errors.notAllowed(`La marca ${f} no está permitida. Sólo \\Seen, \\Answered, \\Flagged o palabras clave propias.`);
      }
    } else if (!KEYWORD.test(f)) {
      throw errors.invalid(`Palabra clave inválida: "${f}". Letras, números y _ $ . - hasta 40.`);
    }
  }
}

export async function setFlags(client, folder, uids, add, remove) {
  validateFlags(add);
  validateFlags(remove);
  const lock = await lockFolder(client, folder, false);
  try {
    const range = uids.join(',');
    if (add?.length) await client.messageFlagsAdd(range, add, { uid: true });
    if (remove?.length) await client.messageFlagsRemove(range, remove, { uid: true });
    const result = [];
    for await (const m of client.fetch(range, { uid: true, flags: true }, { uid: true })) {
      result.push({ uid: m.uid, flags: [...(m.flags ?? [])] });
    }
    const permanent = client.mailbox.permanentFlags;
    const keywordsAllowed = !permanent || permanent.has('\\*');
    return { folder, messages: result.sort((a, b) => a.uid - b.uid), keywords_allowed: keywordsAllowed };
  } finally {
    lock.release();
  }
}

// Mover a la papelera es borrar, y borrar lo hace una persona (diseño §2.4): no se permite.
export async function moveMessages(client, folder, uids, destination) {
  const list = await client.list();
  const dest = list.find((f) => f.path === destination);
  if (!dest) throw errors.folderNotFound(destination);
  if (dest.specialUse === '\\Trash' || /^(trash|papelera|deleted items|elementos eliminados)$/i.test(dest.name)) {
    throw errors.notAllowed('Mover a la papelera equivale a borrar y lo hace una persona, no el bot.');
  }
  const lock = await lockFolder(client, folder, false);
  try {
    const r = await client.messageMove(uids.join(','), destination, { uid: true });
    const map = r?.uidMap ? Object.fromEntries([...r.uidMap.entries()].map(([a, b]) => [String(a), b])) : null;
    return { folder, destination, moved: uids.length, uid_map: map };
  } finally {
    lock.release();
  }
}

export async function appendMessage(client, folder, raw, flags) {
  const r = await client.append(folder, raw, flags);
  return { folder, uid: r?.uid ?? null };
}

export async function markAnswered(client, folder, uid) {
  const lock = await lockFolder(client, folder, false);
  try {
    await client.messageFlagsAdd(String(uid), ['\\Answered'], { uid: true });
  } finally {
    lock.release();
  }
}
