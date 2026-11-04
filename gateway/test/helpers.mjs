// Ayudas de la batería: servidores SMTP de prueba, cliente HTTP del gateway y acceso
// IMAP directo para sembrar y verificar buzones sin pasar por el gateway.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { ImapFlow } from 'imapflow';

export const T = process.env.MAILGW_TEST_DIR;
export const HOST = '127.0.0.1';
export const PORTS = { imaps: 11993, imap: 11143, smtps: 11465, submission: 11587 };
export const USERS = { 'ana@cliente.test': 'clave-ana-1', 'beto@cliente.test': 'clave-beto-2' };

export function startSmtp() {
  const received = [];
  const key = fs.readFileSync(path.join(T, 'server.key'));
  const cert = fs.readFileSync(path.join(T, 'server.pem'));
  const common = {
    key, cert, logger: false, authMethods: ['PLAIN', 'LOGIN'],
    onAuth(auth, _s, cb) {
      return USERS[auth.username] === auth.password ? cb(null, { user: auth.username }) : cb(new Error('535 Authentication failed'));
    },
    onRcptTo(address, _s, cb) {
      if (address.address.startsWith('rechazo@')) {
        const e = new Error('550 5.1.1 Mailbox does not exist');
        e.responseCode = 550;
        return cb(e);
      }
      return cb();
    },
    onData(stream, session, cb) {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        received.push({
          user: session.user,
          from: session.envelope.mailFrom.address,
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks).toString('utf8'),
        });
        cb();
      });
    },
  };
  const tls = new SMTPServer({ ...common, secure: true });
  const starttls = new SMTPServer({ ...common, secure: false });
  // Un cliente que corta a mitad del TLS no tiene que tumbar la batería.
  tls.on('error', () => {});
  starttls.on('error', () => {});
  return new Promise((resolve) => {
    tls.listen(PORTS.smtps, HOST, () => starttls.listen(PORTS.submission, HOST, () => resolve({
      received,
      close: () => Promise.all([new Promise((r) => tls.close(r)), new Promise((r) => starttls.close(r))]),
    })));
  });
}

export function gw(base) {
  return {
    async call(token, op, body, method = 'POST') {
      const res = await fetch(`${base}/v1/${op}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      });
      return { status: res.status, body: await res.json() };
    },
    async mcp(token, method, params, id = 1) {
      const res = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json', accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-06-18',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    async health() {
      const res = await fetch(`${base}/health`);
      return { status: res.status, body: await res.json() };
    },
  };
}

export async function imap(user, fn) {
  const c = new ImapFlow({ host: HOST, port: PORTS.imaps, secure: true, auth: { user, pass: USERS[user] }, logger: false });
  c.on('error', () => {});
  await c.connect();
  try { return await fn(c); } finally { await c.logout().catch(() => c.close()); }
}

export const appendTo = (user, folder, raw, flags = []) => imap(user, (c) => c.append(folder, raw, flags));

export async function flagsOf(user, folder, uid) {
  return imap(user, async (c) => {
    const lock = await c.getMailboxLock(folder, { readOnly: true });
    try {
      const m = await c.fetchOne(String(uid), { uid: true, flags: true }, { uid: true });
      return m ? [...m.flags] : null;
    } finally { lock.release(); }
  });
}

export async function listIn(user, folder) {
  return imap(user, async (c) => {
    const lock = await c.getMailboxLock(folder, { readOnly: true });
    try {
      const out = [];
      for await (const m of c.fetch('1:*', { uid: true, flags: true, envelope: true, source: true })) {
        out.push({ uid: m.uid, flags: [...m.flags], subject: m.envelope.subject, raw: m.source.toString('utf8') });
      }
      return out;
    } catch { return []; } finally { lock.release(); }
  });
}

// Un mensaje RFC 822 armado a mano, con CRLF.
export function rfc822({ from, to, subject, body, messageId, inReplyTo, references, headers = {}, html = false, date }) {
  const lines = [
    `From: ${from}`, `To: ${to}`, `Subject: ${subject}`,
    `Date: ${(date ?? new Date('2026-11-03T13:00:00Z')).toUTCString()}`,
    `Message-ID: ${messageId}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    'MIME-Version: 1.0',
    `Content-Type: ${html ? 'text/html' : 'text/plain'}; charset=utf-8`,
    'Content-Transfer-Encoding: 8bit',
    '',
    body,
  ];
  return lines.join('\r\n').replace(/\r?\n/g, '\r\n');
}

// La CLI corre en otro proceso. spawnSync no sirve: bloquearía el servidor SMTP de prueba,
// que corre en este mismo proceso.
export function runCli(args, input) {
  return new Promise((resolve) => {
    const child = spawn('node', ['bin/admin.mjs', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

export const parseRaw = (raw) => simpleParser(raw);
