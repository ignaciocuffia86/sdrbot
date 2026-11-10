// Registro único de operaciones del gateway. Cada operación declara su permiso, su esquema
// de argumentos y su manejador. La API REST (POST /v1/<op>) y el servidor MCP (tool <mcp>)
// salen de esta misma lista: una operación nueva aparece en los dos lados o en ninguno.

import Ajv from 'ajv';
import * as store from './store.mjs';
import { aadFor, decryptSecret } from './crypto.mjs';
import { errors, GatewayError } from './errors.mjs';
import {
  withImap, listFolders, syncFolder, searchFolder, readMessage, originalForReply,
  setFlags, moveMessages, createFolder, appendMessage, markAnswered, specialFolder,
} from './mail/imap.mjs';
import { buildMessage, replyFields } from './mail/compose.mjs';
import { sendRaw, verifySmtp } from './mail/smtp.mjs';
import { SDR_OPS } from './sdr/ops.mjs';
import * as sdr from './sdr/store.mjs';
import { controlarDestinatarios } from './sdr/correo.mjs';

// ---------------------------------------------------------------- esquemas comunes

const mailbox = { type: 'string', minLength: 3, maxLength: 254, description: 'Dirección del buzón, tal como figura en "buzones".' };
const folder = { type: 'string', minLength: 1, maxLength: 200, default: 'INBOX', description: 'Ruta de la carpeta, como la devuelve "carpetas". Por defecto INBOX.' };
const uid = { type: 'integer', minimum: 1, description: 'UID del mensaje en esa carpeta.' };
const uids = { type: 'array', items: { type: 'integer', minimum: 1 }, minItems: 1, maxItems: 100, description: 'UIDs de los mensajes en esa carpeta.' };
const addressList = {
  anyOf: [{ type: 'string', maxLength: 2000 }, { type: 'array', items: { type: 'string', maxLength: 320 }, maxItems: 20 }],
};
const day = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const text = { type: 'string', maxLength: 100_000 };
const idem = {
  type: 'string', minLength: 8, maxLength: 200,
  description: 'Clave única de este envío (por ejemplo el id del mensaje en la base de control). ' +
    'Un reintento con la misma clave devuelve el resultado anterior y no manda otro mail.',
};

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

// Lo que vincula un envío con el registro de prospección (docs/09 §5.2 y §5.4).
const sdrSend = {
  prospecto_id: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$', description: 'Prospecto del registro: el envío queda en su línea de tiempo.' },
  aprobacion_id: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$', description: 'Aprobación registrada para este envío (calibración o respuesta a un positivo).' },
  bot: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,30}$' },
  tarea: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,40}$' },
  corrida: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' },
};

// ---------------------------------------------------------------- utilidades

const dayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const publicAccount = (a, sendsToday) => ({
  email: a.email,
  display_name: a.display_name,
  firma: a.firma ?? null,
  status: a.status,
  imap: `${a.imap_host}:${a.imap_port} (${a.imap_security})`,
  smtp: `${a.smtp_host}:${a.smtp_port} (${a.smtp_security})`,
  timezone: a.timezone,
  daily_send_cap: a.daily_send_cap,
  sends_today: sendsToday,
  last_ok_at: a.last_ok_at,
  last_error: a.status === 'active' ? null : a.last_error,
});

async function loadAccount(ctx, email) {
  const account = await store.getAccount(ctx.clientId, email);
  if (!account) throw errors.mailboxNotFound(email);
  if (account.status === 'auth_error') throw errors.mailboxBlocked(account.email);
  if (account.status === 'paused') throw errors.mailboxPaused(account.email);
  const password = decryptSecret(account.secret_enc, aadFor(account.client_id, account.email));
  return { account, password };
}

// Corre una operación contra un buzón y registra el resultado de la autenticación: una
// falla de usuario o contraseña suma al contador que bloquea el buzón; un éxito lo pone en
// cero.
async function onMailbox(ctx, email, fn) {
  const { account, password } = await loadAccount(ctx, email);
  ctx.accountId = account.id;
  try {
    const r = await fn(account, password);
    await store.recordAuth(account, true);
    return r;
  } catch (e) {
    if (e instanceof GatewayError && e.code === 'mail_auth_failed') await store.recordAuth(account, false, e.message);
    else if (e instanceof GatewayError && ['mail_server_unreachable', 'mail_server_error'].includes(e.code)) {
      await store.recordError(account, e.message);
    }
    throw e;
  }
}

// Envío con idempotencia y cupo. La reserva se libera sólo si el servidor SMTP no aceptó
// el mensaje: después de eso el envío existe y un reintento devuelve el mismo resultado.
async function sendFlow(ctx, args, kind) {
  // Calibración y aprobaciones exigidas: se controla antes de tocar el buzón. La supresión y el
  // estado de quien recibe se controlan con los destinatarios ya armados, antes del SMTP.
  const aprobacion = await sdr.controlarEnvio(ctx.clientId, args, kind);
  return onMailbox(ctx, args.mailbox, async (account, password) => {
    const today = dayIn(account.timezone);
    const res = await store.reserveSend(account, args.idempotency_key, today, kind);
    if (res.state === 'duplicate') {
      return {
        duplicate: true, message_id: res.row.message_id, recipients: res.row.recipients,
        subject: res.row.subject, sent_folder: res.row.sent_folder, sent_uid: res.row.sent_uid, sent_at: res.row.sent_at,
      };
    }
    if (res.state === 'in_progress') throw errors.inProgress();
    if (res.state === 'cap_reached') throw errors.capReached(account.daily_send_cap, today);

    let smtpDone = false;
    const warnings = [];
    let built;
    let smtp;
    let sent = { folder: null, uid: null };

    const afterSend = async (client) => {
      if (account.append_sent) {
        try {
          const f = await specialFolder(client, '\\Sent', account.sent_folder, { create: true });
          sent = await appendMessage(client, f, built.raw, ['\\Seen']);
        } catch (e) {
          warnings.push(`El mail salió pero no se pudo guardar una copia en Enviados: ${e.message}`);
        }
      }
      if (kind === 'reply' && args.mark_answered !== false) {
        try { await markAnswered(client, args.folder, args.uid); } catch (e) {
          warnings.push(`El mail salió pero no se pudo marcar el original como respondido: ${e.message}`);
        }
      }
    };

    try {
      if (kind === 'reply') {
        await withImap(account, password, async (client) => {
          const original = await originalForReply(client, args.folder, args.uid);
          built = await buildMessage(account, replyFields(account, original, args));
          await controlarDestinatarios(ctx.clientId, built.recipients, kind, args.prospecto_id);
          smtp = await sendRaw(account, password, built);
          smtpDone = true;
          await afterSend(client);
        });
      } else {
        built = await buildMessage(account, args);
        await controlarDestinatarios(ctx.clientId, built.recipients, kind, args.prospecto_id);
        smtp = await sendRaw(account, password, built);
        smtpDone = true;
        if (account.append_sent) {
          await withImap(account, password, afterSend).catch((e) => {
            warnings.push(`El mail salió pero no se pudo guardar una copia en Enviados: ${e.message}`);
          });
        }
      }
    } catch (e) {
      if (!smtpDone) await store.releaseSend(account, res.id, today);
      if (!smtpDone) throw e;
      warnings.push(`El mail salió; falló un paso posterior: ${e.message}`);
    }

    await store.completeSend(account, res.id, {
      message_id: built.messageId, recipients: built.recipients, subject: built.subject,
      smtp_response: smtp?.response ?? null, sent_folder: sent.folder, sent_uid: sent.uid,
    });
    // El mail ya salió: lo que sigue no puede hacer fallar el envío.
    if (aprobacion) {
      await sdr.usarAprobacion(ctx.clientId, aprobacion.id, args.idempotency_key).catch((e) => {
        warnings.push(`El mail salió pero no se pudo marcar la aprobación como usada: ${e.message}`);
      });
    }
    if (args.prospecto_id) {
      await sdr.registrarEnvio(ctx.clientId, args.prospecto_id, {
        message_id: built.messageId, asunto: built.subject, buzon: account.email, respuesta: kind === 'reply',
        idempotency_key: args.idempotency_key, aprobacion: aprobacion?.id ?? null,
      }, { bot: args.bot, tarea: args.tarea, corrida: args.corrida }).catch((e) => {
        warnings.push(`El mail salió pero no se pudo registrar en la línea de tiempo: ${e.message}`);
      });
    }
    return {
      duplicate: false,
      message_id: built.messageId,
      accepted: smtp.accepted,
      rejected: smtp.rejected,
      subject: built.subject,
      sent_folder: sent.folder,
      sent_uid: sent.uid,
      sends_today: await store.sendsToday(account, today),
      daily_send_cap: account.daily_send_cap,
      warnings,
    };
  });
}

// ---------------------------------------------------------------- operaciones

const MAIL_OPS = [
  {
    op: 'mailboxes', mcp: 'buzones', scope: 'read',
    description: 'Lista los buzones IMAP de este cliente con su estado, su firma (null: usar la firma por defecto de los ajustes), ' +
      'su cupo diario de envíos y cuántos van hoy. ' +
      'Un buzón en auth_error quedó bloqueado por contraseña rechazada y lo reactiva un operador.',
    schema: obj({}),
    handler: async (ctx) => {
      const list = await store.listAccounts(ctx.clientId);
      return {
        mailboxes: await Promise.all(list.map(async (a) => publicAccount(a, await store.sendsToday(a, dayIn(a.timezone))))),
      };
    },
  },
  {
    op: 'check', mcp: 'verificar_buzon', scope: 'read',
    description: 'Prueba el acceso a un buzón: entra por IMAP y valida el usuario en SMTP sin mandar nada. ' +
      'Para el chequeo de sesiones de la mañana.',
    schema: obj({ mailbox }, ['mailbox']),
    handler: (ctx, a) => onMailbox(ctx, a.mailbox, async (account, password) => {
      const folders = await withImap(account, password, (c) => listFolders(c));
      await verifySmtp(account, password);
      return { mailbox: account.email, imap: 'ok', smtp: 'ok', folders: folders.length };
    }),
  },
  {
    op: 'folders', mcp: 'carpetas', scope: 'read',
    description: 'Carpetas del buzón con su uso especial (\\Sent, \\Drafts, \\Junk, \\Trash), mensajes y no leídos.',
    schema: obj({ mailbox }, ['mailbox']),
    handler: (ctx, a) => onMailbox(ctx, a.mailbox, (account, password) =>
      withImap(account, password, async (c) => ({ folders: await listFolders(c) }))),
  },
  {
    op: 'sync', mcp: 'sincronizar', scope: 'read',
    description: 'Mensajes nuevos de una carpeta desde un cursor, en orden de llegada, con cuerpo en texto ' +
      '(text), la parte escrita por quien responde sin la cita (reply_text) y marcas de respuesta automática ' +
      'y rebote. Devuelve el cursor siguiente: guardarlo y pasarlo en la próxima llamada. La primera vez, sin ' +
      'cursor: start "now" deja el cursor en el último mensaje actual sin traer nada (para leer sólo lo que ' +
      'llegue desde ahora), start "oldest" empieza por el primer mensaje, y since limita a una fecha. ' +
      'No marca nada como leído.',
    schema: obj({
      mailbox, folder,
      cursor: obj({ uidvalidity: { type: 'string', maxLength: 40 }, last_uid: { type: 'integer', minimum: 0 } }, ['last_uid']),
      start: { type: 'string', enum: ['oldest', 'now'], default: 'oldest' },
      since: { ...day, description: 'Sólo mensajes recibidos desde esta fecha (AAAA-MM-DD).' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
    }, ['mailbox']),
    handler: (ctx, a) => onMailbox(ctx, a.mailbox, (account, password) =>
      withImap(account, password, (c) => syncFolder(c, a.folder, a.cursor, a.limit, { start: a.start, since: a.since }))),
    summary: (r) => ({ folder: r.folder, count: r.messages.length, has_more: r.has_more, reset: r.reset }),
  },
  {
    op: 'search', mcp: 'buscar', scope: 'read',
    description: 'Busca mensajes en una carpeta por fecha, remitente, destinatario, asunto, texto, no leídos, ' +
      'no respondidos, destacados o palabra clave. Devuelve resúmenes sin cuerpo, del más nuevo al más viejo; ' +
      'el cuerpo se pide con leer_mensaje.',
    schema: obj({
      mailbox, folder,
      since: { ...day, description: 'Desde esta fecha (AAAA-MM-DD), inclusive.' },
      before: { ...day, description: 'Antes de esta fecha (AAAA-MM-DD).' },
      from: { type: 'string', maxLength: 320 }, to: { type: 'string', maxLength: 320 },
      subject: { type: 'string', maxLength: 300 }, text: { type: 'string', maxLength: 300 },
      unseen: { type: 'boolean' }, unanswered: { type: 'boolean' }, flagged: { type: 'boolean' },
      keyword: { type: 'string', maxLength: 40 }, not_keyword: { type: 'string', maxLength: 40 },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
    }, ['mailbox']),
    handler: (ctx, a) => onMailbox(ctx, a.mailbox, (account, password) =>
      withImap(account, password, (c) => searchFolder(c, a.folder, a, a.limit))),
    summary: (r) => ({ folder: r.folder, total: r.total, returned: r.messages.length }),
  },
  {
    op: 'read', mcp: 'leer_mensaje', scope: 'read',
    description: 'Un mensaje completo: remitente, destinatarios, cabeceras de hilo, texto, texto sin la cita y ' +
      'adjuntos (sólo nombre y tamaño). Con mark_seen lo marca como leído.',
    schema: obj({ mailbox, folder, uid, mark_seen: { type: 'boolean', default: false } }, ['mailbox', 'uid']),
    handler: (ctx, a) => onMailbox(ctx, a.mailbox, (account, password) =>
      withImap(account, password, (c) => readMessage(c, a.folder, a.uid, a.mark_seen))),
    summary: (r) => ({ folder: r.folder, uid: r.uid }),
  },
  {
    op: 'send', mcp: 'enviar', scope: 'send',
    description: 'Envía un mail nuevo desde el buzón por su SMTP y guarda la copia en Enviados. Respeta el cupo ' +
      'diario del buzón y la clave de idempotencia. Para seguir un hilo pasar in_reply_to y references; para ' +
      'contestar un mensaje recibido usar responder. Con prospecto_id el envío queda en el registro, y el mail de esa ' +
      'persona tiene que estar entre los destinatarios (destinatario_no_coincide). La campaña sale de los destinatarios ' +
      'que son prospectos, que tienen que ser de una misma campaña: tiene que estar activa, el buzón tiene que ser de la ' +
      'campaña y los links, de los permitidos (campana_inactiva, buzon_fuera_de_campana, link_no_permitido, ' +
      'en_otra_campana). Si la campaña está en calibración, exige aprobacion_id con una aprobación de exactamente este mail.',
    schema: obj({
      mailbox, to: addressList, cc: addressList, bcc: addressList,
      subject: { type: 'string', maxLength: 500 }, text, html: text,
      in_reply_to: { type: 'string', maxLength: 500 },
      references: { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 50 },
      unsubscribe_mailto: { type: 'boolean', default: false, description: 'Agrega List-Unsubscribe con un mailto al buzón y asunto BAJA.' },
      idempotency_key: idem, ...sdrSend,
    }, ['mailbox', 'to', 'subject', 'idempotency_key']),
    handler: (ctx, a) => sendFlow(ctx, a, 'send'),
    summary: (r) => ({ message_id: r.message_id, duplicate: r.duplicate, recipients: r.accepted?.length ?? null }),
  },
  {
    op: 'reply', mcp: 'responder', scope: 'send',
    description: 'Responde un mensaje recibido en el mismo hilo (Re:, In-Reply-To, References), desde el mismo ' +
      'buzón, con la cita del original salvo quote=false, guarda la copia en Enviados y marca el original como ' +
      'respondido. Respeta el cupo diario y la clave de idempotencia. Sólo enviar lo que ya está aprobado. Si la ' +
      'respuesta va a alguien del registro, exige su prospecto_id (prospecto_requerido, destinatario_no_coincide); a un ' +
      'positivo, con su aprobación respuesta_positivo.',
    schema: obj({
      mailbox, folder, uid, text, html: text,
      reply_all: { type: 'boolean', default: false },
      quote: { type: 'boolean', default: true },
      mark_answered: { type: 'boolean', default: true },
      idempotency_key: idem, ...sdrSend,
    }, ['mailbox', 'uid', 'idempotency_key']),
    handler: (ctx, a) => {
      if (!a.text && !a.html) throw errors.invalid('Falta el cuerpo: text o html.');
      return sendFlow(ctx, a, 'reply');
    },
    summary: (r) => ({ message_id: r.message_id, duplicate: r.duplicate }),
  },
  {
    op: 'draft', mcp: 'crear_borrador', scope: 'draft',
    description: 'Guarda un borrador en la carpeta Borradores del buzón, sin enviarlo: una persona lo revisa y lo ' +
      'manda desde su programa de correo. Con reply_to arma la respuesta a un mensaje recibido (destinatarios, ' +
      'asunto e hilo). No consume cupo de envío. Las copias ocultas (bcc) no se guardan en un borrador.',
    schema: obj({
      mailbox,
      reply_to: obj({ folder, uid, reply_all: { type: 'boolean', default: false }, quote: { type: 'boolean', default: true } }, ['uid']),
      to: addressList, cc: addressList, subject: { type: 'string', maxLength: 500 }, text, html: text,
    }, ['mailbox']),
    handler: (ctx, a) => onMailbox(ctx, a.mailbox, (account, password) =>
      withImap(account, password, async (c) => {
        let fields = a;
        if (a.reply_to) {
          const original = await originalForReply(c, a.reply_to.folder, a.reply_to.uid);
          fields = replyFields(account, original, { ...a.reply_to, text: a.text, html: a.html });
        } else if (!a.to) {
          throw errors.invalid('Falta "to" (o "reply_to" para responder un mensaje).');
        }
        if (!fields.text && !fields.html) throw errors.invalid('Falta el cuerpo: text o html.');
        const built = await buildMessage(account, fields);
        const f = await specialFolder(c, '\\Drafts', account.drafts_folder, { create: true });
        const r = await appendMessage(c, f, built.raw, ['\\Draft', '\\Seen']);
        return { folder: r.folder, uid: r.uid, message_id: built.messageId, to: built.recipients, subject: built.subject };
      })),
    summary: (r) => ({ folder: r.folder, uid: r.uid }),
  },
  {
    op: 'flags', mcp: 'marcar', scope: 'manage',
    description: 'Agrega o quita marcas a mensajes: \\Seen (leído), \\Answered (respondido), \\Flagged ' +
      '(destacado) o palabras clave propias, por ejemplo SDR_procesado para no volver a tomar un mensaje. ' +
      'No permite \\Deleted: borrar lo hace una persona.',
    schema: obj({
      mailbox, folder, uids,
      add: { type: 'array', items: { type: 'string', maxLength: 41 }, maxItems: 10 },
      remove: { type: 'array', items: { type: 'string', maxLength: 41 }, maxItems: 10 },
    }, ['mailbox', 'uids']),
    handler: (ctx, a) => {
      if (!a.add?.length && !a.remove?.length) throw errors.invalid('Pasar "add" o "remove".');
      return onMailbox(ctx, a.mailbox, (account, password) =>
        withImap(account, password, (c) => setFlags(c, a.folder, a.uids, a.add, a.remove)));
    },
    summary: (r) => ({ folder: r.folder, count: r.messages.length }),
  },
  {
    op: 'move', mcp: 'mover', scope: 'manage',
    description: 'Mueve mensajes a otra carpeta existente del buzón (por ejemplo SDR/Procesados). No permite ' +
      'mover a la papelera: borrar lo hace una persona.',
    schema: obj({ mailbox, folder, uids, destination: { type: 'string', minLength: 1, maxLength: 200 } },
      ['mailbox', 'uids', 'destination']),
    handler: (ctx, a) => onMailbox(ctx, a.mailbox, (account, password) =>
      withImap(account, password, (c) => moveMessages(c, a.folder, a.uids, a.destination))),
    summary: (r) => ({ folder: r.folder, destination: r.destination, moved: r.moved }),
  },
  {
    op: 'create_folder', mcp: 'crear_carpeta', scope: 'manage',
    description: 'Crea una carpeta en el buzón, por ejemplo SDR/Procesados. Usar el separador que muestra "carpetas".',
    schema: obj({ mailbox, path: { type: 'string', minLength: 1, maxLength: 200 } }, ['mailbox', 'path']),
    handler: (ctx, a) => onMailbox(ctx, a.mailbox, (account, password) =>
      withImap(account, password, (c) => createFolder(c, a.path))),
  },
];

export const OPS = [...MAIL_OPS, ...SDR_OPS];

// ---------------------------------------------------------------- despacho

const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });
const BY_OP = new Map();
const BY_MCP = new Map();
for (const o of OPS) {
  o.validate = ajv.compile(o.schema);
  BY_OP.set(o.op, o);
  BY_MCP.set(o.mcp, o);
}

export const opByName = (name) => BY_OP.get(name) ?? null;
export const opByMcp = (name) => BY_MCP.get(name) ?? null;
export const opsForScopes = (scopes) => OPS.filter((o) => scopes.includes(o.scope));

export async function runOp(ctx, o, rawArgs) {
  const args = structuredClone(rawArgs ?? {});
  const started = Date.now();
  try {
    if (!ctx.scopes.includes(o.scope)) throw errors.scope(o.scope);
    if (!o.validate(args)) {
      const detail = o.validate.errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
      throw errors.invalid(`Argumentos inválidos: ${detail}`);
    }
    const result = await o.handler(ctx, args);
    await store.audit({
      clientId: ctx.clientId, tokenId: ctx.tokenId, accountId: ctx.accountId, op: o.op, ok: true,
      detail: { mailbox: args.mailbox ?? null, ms: Date.now() - started, ...(o.summary ? o.summary(result) : {}) },
    });
    return result;
  } catch (e) {
    const err = e instanceof GatewayError ? e : new GatewayError('internal', 'Error interno del gateway.', 500);
    if (!(e instanceof GatewayError)) console.error('[mailgw]', o.op, e);
    await store.audit({
      clientId: ctx.clientId, tokenId: ctx.tokenId, accountId: ctx.accountId, op: o.op, ok: false,
      errorCode: err.code, detail: { mailbox: args.mailbox ?? null, ms: Date.now() - started },
    });
    throw err;
  }
}
