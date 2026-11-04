// Batería de punta a punta: gateway HTTP local → Dovecot (IMAP real con TLS y STARTTLS),
// servidores SMTP de prueba (TLS y STARTTLS) y Postgres. Correr con `npm test`.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/store.mjs';
import { aadFor, decryptSecret, encryptSecret, keyIdOf, newToken } from '../src/crypto.mjs';
import { parseKeys } from '../src/config.mjs';
import { startServer } from '../src/server.mjs';
import { startSmtp, gw, appendTo, flagsOf, listIn, rfc822, runCli, parseRaw, HOST, PORTS, USERS } from './helpers.mjs';

let server, smtp, api;
const tok = {};

const ANA = 'ana@cliente.test';
const BETO = 'beto@cliente.test';
const PROSPECTO = 'laura@prospecto.test';

async function account(client, email, password, { starttls = false, cap = 40 } = {}) {
  await store.upsertAccount({
    client_id: client, email, display_name: email === ANA ? 'Ana Pérez' : null, username: email,
    secret_enc: encryptSecret(password, aadFor(client, email)),
    imap_host: HOST, imap_port: starttls ? PORTS.imap : PORTS.imaps, imap_security: starttls ? 'starttls' : 'tls',
    smtp_host: HOST, smtp_port: starttls ? PORTS.submission : PORTS.smtps, smtp_security: starttls ? 'starttls' : 'tls',
    timezone: 'America/Argentina/Buenos_Aires', daily_send_cap: cap, append_sent: true,
  });
}

async function token(client, scopes) {
  const { token: t, hash } = newToken();
  await store.createToken(client, `prueba ${scopes.join('+')}`, hash, scopes, null);
  return t;
}

before(async () => {
  smtp = await startSmtp();
  await store.upsertClient('piloto', 'Cliente piloto');
  await store.upsertClient('otro', 'Otro cliente');
  await account('piloto', ANA, USERS[ANA]);
  await account('piloto', BETO, USERS[BETO], { starttls: true, cap: 2 });
  // Mismo servidor y usuario que beto, con la contraseña equivocada y de otro cliente.
  await account('otro', BETO, 'clave-mala');
  tok.full = await token('piloto', ['read', 'draft', 'send', 'manage']);
  tok.read = await token('piloto', ['read']);
  tok.otro = await token('otro', ['read', 'send']);

  // Buzón de Ana: una respuesta real con cita, un fuera de oficina, un rebote y uno sólo HTML.
  await appendTo(ANA, 'INBOX', rfc822({
    from: `Laura Gómez <${PROSPECTO}>`, to: ANA, subject: 'Re: QA para su equipo',
    messageId: '<resp-1@prospecto.test>', inReplyTo: '<salida-1@cliente.test>', references: '<salida-1@cliente.test>',
    body: 'Hola Ana, sí, me interesa. ¿Podemos hablar el jueves?\n\nEl lun, 2 nov 2026 a las 10:00, Ana Pérez <ana@cliente.test> escribió:\n> Hola Laura, te escribo por el aviso de QA.\n> Saludos',
  }));
  await appendTo(ANA, 'INBOX', rfc822({
    from: `Pedro <pedro@prospecto.test>`, to: ANA, subject: 'Fuera de la oficina',
    messageId: '<auto-1@prospecto.test>', headers: { 'Auto-Submitted': 'auto-replied' },
    body: 'Estoy de vacaciones hasta el 15.',
  }));
  await appendTo(ANA, 'INBOX', rfc822({
    from: 'MAILER-DAEMON@mx.prospecto.test', to: ANA, subject: 'Undelivered Mail Returned to Sender',
    messageId: '<bounce-1@mx.prospecto.test>', body: 'The mail system could not deliver your message.',
  }));
  await appendTo(ANA, 'INBOX', rfc822({
    from: `Marta <marta@prospecto.test>`, to: ANA, subject: 'Pedido de precios',
    messageId: '<html-1@prospecto.test>', html: true, body: '<p>Hola, ¿me pasan <b>precios</b>?</p>',
  }));

  server = await startServer(0);
  api = gw(`http://127.0.0.1:${server.address().port}`);
});

after(async () => {
  await new Promise((r) => server.close(r));
  await smtp.close();
  await store.closePool();
});

// ---------------------------------------------------------------- acceso

test('health responde sin token', async () => {
  const r = await api.health();
  assert.equal(r.status, 200);
  assert.equal(r.body.data.service, 'sdrbot-mail-gateway');
});

test('sin token, token inválido o ruta inexistente', async () => {
  assert.equal((await api.call(null, 'mailboxes')).status, 401);
  assert.equal((await api.call('mgw_falso', 'mailboxes')).body.error.code, 'unauthorized');
  assert.equal((await api.call(tok.full, 'inexistente')).status, 404);
});

test('cada cliente ve sólo sus buzones', async () => {
  const mine = await api.call(tok.full, 'mailboxes', null, 'GET');
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.body.data.mailboxes.map((m) => m.email), [ANA, BETO]);
  const other = await api.call(tok.otro, 'folders', { mailbox: ANA });
  assert.equal(other.status, 404);
  assert.equal(other.body.error.code, 'mailbox_not_found');
});

test('un token de lectura no puede enviar ni gestionar', async () => {
  const r = await api.call(tok.read, 'send', { mailbox: ANA, to: PROSPECTO, subject: 'x', text: 'x', idempotency_key: 'k-lectura-1' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'forbidden_scope');
  assert.equal((await api.call(tok.read, 'flags', { mailbox: ANA, uids: [1], add: ['\\Seen'] })).status, 403);
});

test('argumentos inválidos se rechazan antes de tocar el buzón', async () => {
  const r = await api.call(tok.full, 'sync', { mailbox: ANA, limit: 1000, extra: true });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'invalid_request');
});

// ---------------------------------------------------------------- lectura

test('carpetas con su uso especial', async () => {
  const r = await api.call(tok.full, 'folders', { mailbox: ANA });
  assert.equal(r.status, 200);
  const byUse = Object.fromEntries(r.body.data.folders.filter((f) => f.special_use).map((f) => [f.special_use, f.path]));
  assert.equal(byUse['\\Sent'], 'Sent');
  assert.equal(byUse['\\Drafts'], 'Drafts');
  assert.equal(r.body.data.folders.find((f) => f.path === 'INBOX').messages, 4);
});

test('sincronizar trae los mensajes nuevos, clasifica y avanza el cursor sin marcar leídos', async () => {
  const first = await api.call(tok.full, 'sync', { mailbox: ANA, limit: 3 });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const d = first.body.data;
  assert.equal(d.messages.length, 3);
  assert.equal(d.has_more, true);
  const [reply, auto, bounce] = d.messages;
  assert.equal(reply.from.address, PROSPECTO);
  assert.equal(reply.in_reply_to, '<salida-1@cliente.test>');
  assert.equal(reply.reply_text, 'Hola Ana, sí, me interesa. ¿Podemos hablar el jueves?');
  assert.match(reply.text, /escribió/);
  assert.equal(reply.is_auto_reply, false);
  assert.equal(auto.is_auto_reply, true);
  assert.equal(bounce.is_bounce, true);

  const second = await api.call(tok.full, 'sync', { mailbox: ANA, cursor: d.cursor });
  assert.equal(second.body.data.messages.length, 1);
  assert.match(second.body.data.messages[0].text, /precios/);
  assert.equal(second.body.data.has_more, false);

  const third = await api.call(tok.full, 'sync', { mailbox: ANA, cursor: second.body.data.cursor });
  assert.equal(third.body.data.messages.length, 0);
  assert.deepEqual(third.body.data.cursor, second.body.data.cursor);

  // Leer no deja marcas.
  assert.ok(!(await flagsOf(ANA, 'INBOX', reply.uid)).includes('\\Seen'));

  // Llega uno nuevo: sólo ese.
  await appendTo(ANA, 'INBOX', rfc822({ from: `Laura Gómez <${PROSPECTO}>`, to: ANA, subject: 'Otra cosa', messageId: '<resp-2@prospecto.test>', body: 'Y una consulta más.' }));
  const fourth = await api.call(tok.full, 'sync', { mailbox: ANA, cursor: third.body.data.cursor });
  assert.deepEqual(fourth.body.data.messages.map((m) => m.message_id), ['<resp-2@prospecto.test>']);

  // Si cambia UIDVALIDITY, se relee desde el principio y se avisa.
  const reset = await api.call(tok.full, 'sync', { mailbox: ANA, cursor: { uidvalidity: '1', last_uid: 999 }, limit: 1 });
  assert.equal(reset.body.data.reset, true);
  assert.equal(reset.body.data.messages[0].message_id, '<resp-1@prospecto.test>');
});

test('buscar y leer con marca de leído', async () => {
  const found = await api.call(tok.full, 'search', { mailbox: ANA, from: PROSPECTO, unseen: true });
  assert.equal(found.status, 200);
  assert.equal(found.body.data.total, 2);
  assert.deepEqual(found.body.data.messages.map((m) => m.subject), ['Otra cosa', 'Re: QA para su equipo']);
  const uid = found.body.data.messages[1].uid;
  const read = await api.call(tok.full, 'read', { mailbox: ANA, uid, mark_seen: true });
  assert.equal(read.body.data.subject, 'Re: QA para su equipo');
  assert.ok((await flagsOf(ANA, 'INBOX', uid)).includes('\\Seen'));
  const missing = await api.call(tok.full, 'read', { mailbox: ANA, uid: 9999 });
  assert.equal(missing.body.error.code, 'message_not_found');
  const noFolder = await api.call(tok.full, 'read', { mailbox: ANA, folder: 'NoExiste', uid: 1 });
  assert.equal(noFolder.body.error.code, 'folder_not_found');
});

// ---------------------------------------------------------------- envío

test('enviar: SMTP con TLS, copia en Enviados, baja y hilo', async () => {
  const before = smtp.received.length;
  const r = await api.call(tok.full, 'send', {
    mailbox: ANA, to: `Laura Gómez <${PROSPECTO}>`, subject: 'QA para su equipo', text: 'Hola Laura, ...',
    unsubscribe_mailto: true, idempotency_key: 'msg-0001-primer-toque',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.duplicate, false);
  assert.deepEqual(r.body.data.warnings, []);
  assert.equal(r.body.data.sent_folder, 'Sent');
  assert.equal(smtp.received.length, before + 1);
  const got = smtp.received.at(-1);
  assert.equal(got.user, ANA);
  assert.deepEqual(got.to, [PROSPECTO]);
  const parsed = await parseRaw(got.raw);
  assert.deepEqual(parsed.from.value[0], { name: 'Ana Pérez', address: ANA });
  assert.equal(parsed.to.value[0].name, 'Laura Gómez');
  assert.equal(parsed.messageId, r.body.data.message_id);
  assert.match(got.raw, /List-Unsubscribe: <mailto:ana@cliente\.test\?subject=BAJA>/);
  const sent = await listIn(ANA, 'Sent');
  const copy = sent.find((m) => m.uid === r.body.data.sent_uid);
  assert.ok(copy && copy.raw.includes(r.body.data.message_id) && copy.flags.includes('\\Seen'));
});

test('enviar con la misma clave no manda dos veces', async () => {
  const before = smtp.received.length;
  const again = await api.call(tok.full, 'send', {
    mailbox: ANA, to: PROSPECTO, subject: 'QA para su equipo', text: 'otro texto', idempotency_key: 'msg-0001-primer-toque',
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.data.duplicate, true);
  assert.equal(smtp.received.length, before);
});

test('un destinatario rechazado no consume cupo y la clave se puede reintentar', async () => {
  const before = (await api.call(tok.full, 'mailboxes', null, 'GET')).body.data.mailboxes.find((m) => m.email === ANA).sends_today;
  const bad = await api.call(tok.full, 'send', { mailbox: ANA, to: 'rechazo@prospecto.test', subject: 'x', text: 'x', idempotency_key: 'msg-rechazo-0001' });
  assert.equal(bad.status, 422, JSON.stringify(bad.body));
  assert.equal(bad.body.error.code, 'recipients_rejected');
  const after = (await api.call(tok.full, 'mailboxes', null, 'GET')).body.data.mailboxes.find((m) => m.email === ANA).sends_today;
  assert.equal(after, before);
  const retry = await api.call(tok.full, 'send', { mailbox: ANA, to: PROSPECTO, subject: 'x', text: 'x', idempotency_key: 'msg-rechazo-0001' });
  assert.equal(retry.status, 200);
  assert.equal(retry.body.data.duplicate, false);
});

test('más destinatarios que el límite se rechaza', async () => {
  const many = Array.from({ length: 11 }, (_, i) => `p${i}@prospecto.test`);
  const r = await api.call(tok.full, 'send', { mailbox: ANA, to: many, subject: 'x', text: 'x', idempotency_key: 'msg-masivo-0001' });
  assert.equal(r.body.error.code, 'not_allowed');
});

test('STARTTLS y cupo diario', async () => {
  const send = (k) => api.call(tok.full, 'send', { mailbox: BETO, to: PROSPECTO, subject: `Cupo ${k}`, text: 'x', idempotency_key: `msg-cupo-${k}-0001` });
  assert.equal((await send(1)).status, 200);
  assert.equal((await send(2)).status, 200);
  const third = await send(3);
  assert.equal(third.status, 429);
  assert.equal(third.body.error.code, 'cap_reached');
  assert.equal(third.body.error.cap, 2);
  const sync = await api.call(tok.full, 'sync', { mailbox: BETO, folder: 'Sent' });
  assert.equal(sync.body.data.messages.length, 2);
});

test('responder en el hilo, con cita, y marcar el original como respondido', async () => {
  const found = await api.call(tok.full, 'search', { mailbox: ANA, subject: 'QA para su equipo' });
  const original = found.body.data.messages.find((m) => m.message_id === '<resp-1@prospecto.test>');
  const before = smtp.received.length;
  const r = await api.call(tok.full, 'reply', {
    mailbox: ANA, uid: original.uid, text: 'Perfecto, el jueves a las 11 te llamo.', idempotency_key: 'reply-resp-1-0001',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(smtp.received.length, before + 1);
  const raw = smtp.received.at(-1).raw;
  assert.deepEqual(smtp.received.at(-1).to, [PROSPECTO]);
  assert.match(raw, /^Subject: Re: QA para su equipo$/m);
  assert.match(raw, /^In-Reply-To: <resp-1@prospecto\.test>$/m);
  assert.match(raw, /^References: <salida-1@cliente\.test> <resp-1@prospecto\.test>$/m);
  const parsed = await parseRaw(raw);
  assert.match(parsed.text, /^Perfecto, el jueves a las 11 te llamo\./);
  assert.match(parsed.text, /El 03\/11\/2026 10:00, Laura Gómez <laura@prospecto\.test> escribió:/);
  assert.match(parsed.text, /^> Hola Ana, sí, me interesa\./m);
  assert.ok((await flagsOf(ANA, 'INBOX', original.uid)).includes('\\Answered'));
});

test('borrador de respuesta en Borradores, sin enviar ni consumir cupo', async () => {
  const before = smtp.received.length;
  const found = await api.call(tok.full, 'search', { mailbox: ANA, subject: 'Pedido de precios' });
  const r = await api.call(tok.full, 'draft', {
    mailbox: ANA, reply_to: { uid: found.body.data.messages[0].uid }, text: 'Hola Marta, te paso la propuesta.',
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.data.folder, 'Drafts');
  assert.deepEqual(r.body.data.to, ['marta@prospecto.test']);
  assert.equal(smtp.received.length, before);
  const drafts = await listIn(ANA, 'Drafts');
  const d = drafts.find((m) => m.uid === r.body.data.uid);
  assert.ok(d.flags.includes('\\Draft'));
  assert.equal(d.subject, 'Re: Pedido de precios');
});

// ---------------------------------------------------------------- gestión

test('marcar con palabra clave y destacado; \\Deleted no', async () => {
  const r = await api.call(tok.full, 'flags', { mailbox: ANA, uids: [1, 2], add: ['SDR_procesado', '\\Flagged'] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (const m of r.body.data.messages) assert.ok(m.flags.includes('SDR_procesado') && m.flags.includes('\\Flagged'));
  const notYet = await api.call(tok.full, 'search', { mailbox: ANA, not_keyword: 'SDR_procesado' });
  assert.ok(notYet.body.data.messages.every((m) => ![1, 2].includes(m.uid)));
  const del = await api.call(tok.full, 'flags', { mailbox: ANA, uids: [1], add: ['\\Deleted'] });
  assert.equal(del.body.error.code, 'not_allowed');
});

test('crear carpeta y mover; a la papelera no', async () => {
  const c = await api.call(tok.full, 'create_folder', { mailbox: ANA, path: 'SDR/Procesados' });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const m = await api.call(tok.full, 'move', { mailbox: ANA, uids: [2], destination: 'SDR/Procesados' });
  assert.equal(m.status, 200, JSON.stringify(m.body));
  assert.equal(m.body.data.moved, 1);
  assert.equal((await listIn(ANA, 'SDR/Procesados')).length, 1);
  const trash = await api.call(tok.full, 'move', { mailbox: ANA, uids: [3], destination: 'Trash' });
  assert.equal(trash.body.error.code, 'not_allowed');
});

// ---------------------------------------------------------------- fallas de autenticación

test('tres contraseñas rechazadas bloquean el buzón y un operador lo reactiva', async () => {
  for (let i = 0; i < 3; i += 1) {
    const r = await api.call(tok.otro, 'folders', { mailbox: BETO });
    assert.equal(r.body.error.code, 'mail_auth_failed');
  }
  const blocked = await api.call(tok.otro, 'folders', { mailbox: BETO });
  assert.equal(blocked.status, 423);
  assert.equal(blocked.body.error.code, 'mailbox_blocked');
  // El buzón de beto del cliente piloto, con la contraseña buena, no se ve afectado.
  assert.equal((await api.call(tok.full, 'folders', { mailbox: BETO })).status, 200);

  const cli = await runCli(['set-password', 'otro', BETO], `${USERS[BETO]}\n`);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal((await api.call(tok.otro, 'folders', { mailbox: BETO })).status, 200);
});

// ---------------------------------------------------------------- MCP

test('MCP: sin token 401; listado filtrado por permisos; llamada a una tool', async () => {
  assert.equal((await api.mcp(null, 'tools/list', {})).status, 401);
  const init = await api.mcp(tok.read, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'prueba', version: '1' },
  });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.serverInfo.name, 'sdrbot-mail-gateway');

  const readList = await api.mcp(tok.read, 'tools/list', {}, 2);
  const names = readList.body.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['buscar', 'buzones', 'carpetas', 'leer_mensaje', 'sincronizar', 'verificar_buzon']);
  const fullList = await api.mcp(tok.full, 'tools/list', {}, 3);
  assert.equal(fullList.body.result.tools.length, 12);

  const call = await api.mcp(tok.full, 'tools/call', { name: 'sincronizar', arguments: { mailbox: ANA, limit: 1 } }, 4);
  const payload = JSON.parse(call.body.result.content[0].text);
  assert.equal(payload.messages.length, 1);
  const denied = await api.mcp(tok.read, 'tools/call', { name: 'enviar', arguments: { mailbox: ANA } }, 5);
  assert.equal(denied.body.result.isError, true);
  assert.equal(JSON.parse(denied.body.result.content[0].text).error.code, 'forbidden_scope');
});

// ---------------------------------------------------------------- administración y cifrado

test('verificar_buzon y check de la CLI prueban IMAP y SMTP', async () => {
  const r = await api.call(tok.full, 'check', { mailbox: ANA });
  assert.deepEqual([r.body.data.imap, r.body.data.smtp], ['ok', 'ok']);
  const cli = await runCli(['check', 'piloto', ANA]);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /IMAP ok/);
  assert.match(cli.stdout, /SMTP ok/);
});

test('add-account por CLI con la contraseña por stdin', async () => {
  const cli = await runCli(['add-account', 'otro', ANA,
    '--imap-host', HOST, '--imap-port', String(PORTS.imaps), '--smtp-host', HOST, '--smtp-port', String(PORTS.smtps),
    '--display-name', 'Ana Otro'], `${USERS[ANA]}\n`);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal((await api.call(tok.otro, 'folders', { mailbox: ANA })).status, 200);
});

test('el secreto queda atado a su buzón y rekey recifra con la clave actual', async () => {
  const keys = parseKeys(process.env.MAILGW_ENC_KEYS);
  const blob = encryptSecret('s3creto', aadFor('piloto', ANA), keys);
  assert.equal(decryptSecret(blob, aadFor('piloto', ANA), keys), 's3creto');
  assert.throws(() => decryptSecret(blob, aadFor('otro', ANA), keys));

  // Un buzón cifrado con la clave vieja (k1) sigue funcionando y rekey lo pasa a k2.
  const old = { current: ['k1', keys.byId.get('k1')], byId: keys.byId };
  const a = await store.getAccount('piloto', ANA);
  await store.setSecretById(a.id, encryptSecret(USERS[ANA], aadFor('piloto', ANA), old));
  assert.equal(keyIdOf((await store.getAccount('piloto', ANA)).secret_enc), 'k1');
  assert.equal((await api.call(tok.full, 'folders', { mailbox: ANA })).status, 200);
  const cli = await runCli(['rekey']);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(keyIdOf((await store.getAccount('piloto', ANA)).secret_enc), 'k2');
  assert.equal((await api.call(tok.full, 'folders', { mailbox: ANA })).status, 200);
});

test('la auditoría registra operaciones sin contenido de mensajes', async () => {
  const { rows } = await store.getPool().query(
    `select op, ok, error_code, detail from mailgw.audit_log where client_id = 'piloto' order by id`);
  assert.ok(rows.some((r) => r.op === 'send' && r.ok && r.detail.message_id));
  assert.ok(rows.some((r) => r.op === 'send' && !r.ok && r.error_code === 'cap_reached'));
  assert.ok(rows.every((r) => !JSON.stringify(r.detail ?? {}).includes('me interesa')));
});

// ---------------------------------------------------------------- concurrencia

test('dos envíos simultáneos con la misma clave salen una sola vez', async () => {
  const before = smtp.received.length;
  const body = { mailbox: ANA, to: PROSPECTO, subject: 'Carrera', text: 'x', idempotency_key: 'msg-carrera-0001' };
  const [a, b] = await Promise.all([api.call(tok.full, 'send', body), api.call(tok.full, 'send', body)]);
  assert.equal(smtp.received.length, before + 1);
  const outcomes = [a, b].map((r) => (r.status === 200 ? (r.body.data.duplicate ? 'duplicate' : 'sent') : r.body.error.code)).sort();
  assert.ok(outcomes[1] === 'sent' && ['send_in_progress', 'duplicate'].includes(outcomes[0]), outcomes.join(','));
});

test('envíos simultáneos contra el cupo: salen exactamente los que entran', async () => {
  await store.getPool().query(`update mailgw.account set daily_send_cap = 3 where client_id = 'otro' and email = $1`, [ANA]);
  const before = smtp.received.length;
  const rs = await Promise.all([1, 2, 3, 4, 5].map((i) => api.call(tok.otro, 'send', {
    mailbox: ANA, to: PROSPECTO, subject: `Cupo paralelo ${i}`, text: 'x', idempotency_key: `msg-paralelo-${i}-0001`,
  })));
  assert.equal(rs.filter((r) => r.status === 200).length, 3);
  assert.equal(rs.filter((r) => r.body.error?.code === 'cap_reached').length, 2);
  assert.equal(smtp.received.length, before + 3);
});

// ---------------------------------------------------------------- cliente Python del box

test('cliente Python: lista buzones y devuelve el error con código', async () => {
  const { spawn } = await import('node:child_process');
  const run = (args) => new Promise((resolve) => {
    const env = { ...process.env, MAILGW_URL: `http://127.0.0.1:${server.address().port}`, MAILGW_TOKEN: tok.full };
    const c = spawn('python3', ['-I', 'clients/python/mailgw.py', ...args], { env });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('close', (status) => resolve({ status, out }));
  });
  const ok = await run(['mailboxes']);
  assert.equal(ok.status, 0, ok.out);
  assert.deepEqual(JSON.parse(ok.out).mailboxes.map((m) => m.email), [ANA, BETO]);
  const sync = await run(['sync', '--json', JSON.stringify({ mailbox: ANA, limit: 1 })]);
  assert.equal(JSON.parse(sync.out).messages.length, 1);
  const bad = await run(['read', '--json', JSON.stringify({ mailbox: ANA, uid: 9999 })]);
  assert.equal(bad.status, 3);
  assert.equal(JSON.parse(bad.out).error.code, 'message_not_found');
});

test('primera sincronización: desde ahora o desde una fecha', async () => {
  const now = await api.call(tok.full, 'sync', { mailbox: ANA, start: 'now' });
  assert.equal(now.body.data.messages.length, 0);
  assert.ok(now.body.data.cursor.last_uid > 0);
  await appendTo(ANA, 'INBOX', rfc822({ from: PROSPECTO, to: ANA, subject: 'Llegó después', messageId: '<tarde-1@prospecto.test>', body: 'nuevo', date: new Date() }));
  const next = await api.call(tok.full, 'sync', { mailbox: ANA, cursor: now.body.data.cursor });
  assert.deepEqual(next.body.data.messages.map((m) => m.subject), ['Llegó después']);
  const today = new Date().toISOString().slice(0, 10);
  const since = await api.call(tok.full, 'sync', { mailbox: ANA, since: today, limit: 100 });
  assert.ok(since.body.data.messages.some((m) => m.subject === 'Llegó después'));
});

test('un envío cortado a mitad bloquea su clave hasta que un operador la libera', async () => {
  const a = await store.getAccount('piloto', ANA);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: a.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const r = await store.reserveSend(a, 'msg-cortado-0001', day, 'send');
  assert.equal(r.state, 'reserved');
  const blocked = await api.call(tok.full, 'send', { mailbox: ANA, to: PROSPECTO, subject: 'x', text: 'x', idempotency_key: 'msg-cortado-0001' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'send_in_progress');
  const cli = await runCli(['clear-send', 'piloto', ANA, 'msg-cortado-0001']);
  assert.equal(cli.status, 0, cli.stderr);
  const ok = await api.call(tok.full, 'send', { mailbox: ANA, to: PROSPECTO, subject: 'x', text: 'x', idempotency_key: 'msg-cortado-0001' });
  assert.equal(ok.status, 200);
});

test('un cuerpo que no es JSON devuelve 400', async () => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/v1/sync`, {
    method: 'POST', headers: { authorization: `Bearer ${tok.full}`, 'content-type': 'application/json' }, body: '{no es json',
  });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'invalid_request');
});
