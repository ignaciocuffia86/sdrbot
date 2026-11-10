// Protección contra SSRF: a qué servidores y puertos puede conectarse el gateway.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import { isPrivateIp, resolveTarget, validateHostSyntax, validatePort, validateWebhookUrl, postWebhook, checkWebhookHost } from '../src/mail/net.mjs';

let saved;
beforeEach(() => { saved = process.env.MAILGW_ALLOW_PRIVATE_HOSTS; delete process.env.MAILGW_ALLOW_PRIVATE_HOSTS; });
afterEach(() => { if (saved === undefined) delete process.env.MAILGW_ALLOW_PRIVATE_HOSTS; else process.env.MAILGW_ALLOW_PRIVATE_HOSTS = saved; });

test('direcciones internas y reservadas', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1',
    // La IPv4 adentro de una IPv6, en cualquiera de sus formas (hallazgo de SSRF: la URL normaliza
    // «[::ffff:127.0.0.1]» a «[::ffff:7f00:1]»).
    '::ffff:7f00:1', '::ffff:a9fe:a9fe', '0:0:0:0:0:ffff:7f00:1', '::7f00:1', '::ffff:0:7f00:1', '2002:7f00:1::',
    '2001::1', '64:ff9b::a9fe:a9fe', 'fe80::1%eth0']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '200.45.1.1', '2800:3f0:4002:80b::200e', '::ffff:8.8.8.8', '::ffff:808:808', '2002:808:808::1']) {
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

test('webhooks salientes (despertador): sólo https al 443 de un dominio público', async () => {
  assert.equal(validateWebhookUrl('https://hooks.grok.test/r/abc?x=1').hostname, 'hooks.grok.test');
  for (const [url, re] of [
    ['http://hooks.grok.test/r', /https:\/\//], ['ftp://x.com', /https:\/\//], ['no es una url', /https:\/\//],
    ['https://user:pass@hooks.grok.test/r', /usuario ni contraseña/], ['https://hooks.grok.test:8443/r', /puerto 443/],
    ['https://169.254.169.254/latest/meta-data', /interna/], ['https://127.0.0.1/', /interna/], ['https://[::1]/', /interna/],
    ['https://10.0.0.5/hook', /interna/], ['https://localhost/hook', /dominio público/], ['https://metadata.internal/x', /dominio público/],
    ['https://intranet/x', /dominio público/], ['https://[::ffff:127.0.0.1]/', /interna/], ['https://[::ffff:a9fe:a9fe]/x', /interna/],
  ]) {
    assert.throws(() => validateWebhookUrl(url), re, url);
  }
  // Al conectar también se controla (aunque la URL se haya cargado antes con otro DNS).
  await assert.rejects(postWebhook('https://169.254.169.254/latest', { body: '{}' }), /interna/);
  await assert.rejects(checkWebhookHost('https://10.1.2.3/x'), /interna/);
});

test('webhooks salientes: un servidor que manda la respuesta de a poco no estira el plazo total', async (t) => {
  const dir = process.env.MAILGW_TEST_DIR;
  if (!dir || !fs.existsSync(`${dir}/server.pem`)) { t.skip('sin el certificado de prueba de run.sh'); return; }
  process.env.MAILGW_ALLOW_PRIVATE_HOSTS = '1';
  const goteos = [];
  // Responde las cabeceras de a un byte cada 100 ms, sin terminarlas nunca: el socket nunca queda
  // inactivo, así que sólo un plazo total lo corta.
  const srv = https.createServer({ cert: fs.readFileSync(`${dir}/server.pem`), key: fs.readFileSync(`${dir}/server.key`) }, (req) => {
    const s = req.socket;
    let i = 0;
    const cab = 'HTTP/1.1 200 OK\r\nX-Lento: ' + 'a'.repeat(1000);
    const t = setInterval(() => { if (s.destroyed || i >= cab.length) { clearInterval(t); return; } s.write(cab[i++]); }, 100);
    goteos.push(t);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const inicio = Date.now();
    await assert.rejects(postWebhook(`https://127.0.0.1:${srv.address().port}/hook`, { body: '{}', timeoutMs: 800 }), /sin respuesta completa/);
    assert.ok(Date.now() - inicio < 3000, `tardó ${Date.now() - inicio} ms`);

    // La señal de quien llama también corta.
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const inicio2 = Date.now();
    await assert.rejects(postWebhook(`https://127.0.0.1:${srv.address().port}/hook`, { body: '{}', timeoutMs: 10_000, signal: ac.signal }), /cortado/);
    assert.ok(Date.now() - inicio2 < 3000);
  } finally {
    for (const t of goteos) clearInterval(t);
    srv.closeAllConnections?.();
    await new Promise((r) => srv.close(r));
  }
});

test('webhooks salientes: una redirección no se sigue', async (t) => {
  const dir = process.env.MAILGW_TEST_DIR;
  if (!dir || !fs.existsSync(`${dir}/server.pem`)) { t.skip('sin el certificado de prueba de run.sh'); return; }
  process.env.MAILGW_ALLOW_PRIVATE_HOSTS = '1';
  const pedidos = [];
  const srv = https.createServer({ cert: fs.readFileSync(`${dir}/server.pem`), key: fs.readFileSync(`${dir}/server.key`) }, (req, res) => {
    pedidos.push(req.url);
    if (req.url === '/hook') { res.writeHead(302, { location: 'https://127.0.0.1:1/adentro' }); res.end(); return; }
    res.end('ok');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await postWebhook(`https://127.0.0.1:${srv.address().port}/hook`, { headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.deepEqual(r, { ok: false, status: 302 });
    assert.deepEqual(pedidos, ['/hook']);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
