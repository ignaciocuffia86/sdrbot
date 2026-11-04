// Protección contra SSRF: a qué servidores y puertos puede conectarse el gateway.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp, resolveTarget, validateHostSyntax, validatePort } from '../src/mail/net.mjs';

let saved;
beforeEach(() => { saved = process.env.MAILGW_ALLOW_PRIVATE_HOSTS; delete process.env.MAILGW_ALLOW_PRIVATE_HOSTS; });
afterEach(() => { if (saved === undefined) delete process.env.MAILGW_ALLOW_PRIVATE_HOSTS; else process.env.MAILGW_ALLOW_PRIVATE_HOSTS = saved; });

test('direcciones internas y reservadas', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '200.45.1.1', '2800:3f0:4002:80b::200e', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test('sintaxis del servidor y puertos de correo', () => {
  assert.equal(validateHostSyntax(' Mail.Dominio.COM '), 'mail.dominio.com');
  for (const bad of ['', 'mail dominio.com', 'http://x.com', 'x.com/ruta', 'usuario@x.com', '-x.com', 'x.com:993']) {
    assert.throws(() => validateHostSyntax(bad), /Servidor inválido/, bad);
  }
  for (const p of [25, 143, 465, 587, 993, 2525]) assert.equal(validatePort(p), p);
  for (const p of [22, 80, 443, 5432, 6379, 11993]) assert.throws(() => validatePort(p), /no permitido/, String(p));
  assert.throws(() => validatePort(0), /inválido/);
});

test('no se conecta a una IP interna, ni literal ni por DNS', async () => {
  await assert.rejects(resolveTarget('127.0.0.1', 993, 'IMAP'), /interna o reservada/);
  await assert.rejects(resolveTarget('169.254.169.254', 993, 'IMAP'), /interna o reservada/);
  await assert.rejects(resolveTarget('localhost', 993, 'IMAP'), /interna o reservada/);
  await assert.rejects(resolveTarget('mail.example.com', 22, 'SMTP'), /no permitido/);
});

test('MAILGW_ALLOW_PRIVATE_HOSTS=1 lo levanta para las pruebas locales', async () => {
  process.env.MAILGW_ALLOW_PRIVATE_HOSTS = '1';
  assert.deepEqual(await resolveTarget('127.0.0.1', 11993, 'IMAP'), { address: '127.0.0.1', servername: undefined });
  assert.deepEqual(await resolveTarget('localhost', 993, 'IMAP'), { address: 'localhost', servername: 'localhost' });
});
