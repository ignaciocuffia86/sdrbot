// Envío por SMTP con las credenciales del buzón. Una conexión por envío.

import nodemailer from 'nodemailer';
import { limits } from '../config.mjs';
import { errors, GatewayError } from '../errors.mjs';
import { resolveTarget } from './net.mjs';

async function transport(account, password) {
  const target = await resolveTarget(account.smtp_host, account.smtp_port, 'SMTP');
  return nodemailer.createTransport({
    host: target.address,
    tls: target.servername ? { servername: target.servername } : undefined,
    port: account.smtp_port,
    secure: account.smtp_security === 'tls',
    // Con starttls se exige la actualización a TLS antes de autenticar.
    requireTLS: account.smtp_security === 'starttls',
    auth: { user: account.username, pass: password },
    connectionTimeout: limits.connectionTimeoutMs,
    greetingTimeout: limits.connectionTimeoutMs,
    socketTimeout: limits.socketTimeoutMs,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
}

export function classifySmtpError(e) {
  if (e instanceof GatewayError) return e;
  const code = e?.code ?? '';
  if (code === 'EAUTH' || e?.responseCode === 535) return errors.authFailed('SMTP');
  if (code === 'EENVELOPE') return errors.recipientsRejected(e?.rejected ?? []);
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ETLS', 'ECONNREFUSED'].includes(code)) {
    return errors.unreachable('SMTP', e?.message ?? code);
  }
  return errors.mailServer('SMTP', e?.response || e?.message || String(e));
}

export async function sendRaw(account, password, { envelope, raw }) {
  const t = await transport(account, password);
  try {
    const info = await t.sendMail({ envelope, raw });
    if (!info.accepted?.length) throw errors.recipientsRejected(info.rejected ?? []);
    return { accepted: info.accepted, rejected: info.rejected ?? [], response: info.response ?? null };
  } catch (e) {
    throw classifySmtpError(e);
  } finally {
    t.close();
  }
}

export async function verifySmtp(account, password) {
  const t = await transport(account, password);
  try {
    await t.verify();
    return true;
  } catch (e) {
    throw classifySmtpError(e);
  } finally {
    t.close();
  }
}
