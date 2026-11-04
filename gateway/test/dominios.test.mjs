// Chequeo de SPF, DKIM, DMARC y MX contra un DNS armado, y el endpoint del panel de punta a
// punta (con la detección del selector DKIM en los mails del buzón, contra el Dovecot).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as store from '../src/store.mjs';
import { startServer } from '../src/server.mjs';
import { createUser } from '../src/admin/auth.mjs';
import { useResolver } from '../src/admin/api.mjs';
import { checkDomain, spfCheckHost, signaturesFromHeaders } from '../src/dns/domain-check.mjs';
import { aadFor, encryptSecret } from '../src/crypto.mjs';
import { appendTo, rfc822, HOST, PORTS, USERS } from './helpers.mjs';

const pub = (bits) => crypto.generateKeyPairSync('rsa', { modulusLength: bits })
  .publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const KEY2048 = pub(2048);
const KEY1024 = pub(1024);

// DNS de mentira: { TXT: { nombre: [registros] }, A, AAAA, MX, FAIL: { nombre: 'ESERVFAIL' } }.
function fakeDns(zone) {
  const look = (type) => async (name) => {
    const n = name.toLowerCase();
    if (zone.FAIL?.[n]) throw Object.assign(new Error('fail'), { code: zone.FAIL[n] });
    const v = zone[type]?.[n];
    if (v === undefined) throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
    return type === 'TXT' ? v.map((r) => (Array.isArray(r) ? r : [r])) : v;
  };
  return { resolveTxt: look('TXT'), resolve4: look('A'), resolve6: look('AAAA'), resolveMx: look('MX') };
}

const GOOD = {
  TXT: {
    'bien.test': ['v=spf1 include:_spf.hosting.test a:web.bien.test -all', 'google-site-verification=abc'],
    '_spf.hosting.test': ['v=spf1 ip4:198.51.100.0/24 ip6:2001:db8:5::/48 ~all'],
    '_dmarc.bien.test': ['v=DMARC1; p=quarantine; rua=mailto:dmarc@bien.test'],
    // Un registro largo partido en pedazos, como lo devuelve el DNS.
    'default._domainkey.bien.test': [['v=DKIM1; k=rsa; p=', KEY2048]],
  },
  A: { 'smtp.hosting.test': ['198.51.100.7'], 'web.bien.test': ['192.0.2.10'] },
  MX: { 'bien.test': [{ priority: 10, exchange: 'mx.hosting.test' }] },
};

test('dominio bien configurado: todo en verde y el SMTP autorizado por un include', async () => {
  const r = await checkDomain('bien.test', { resolver: fakeDns(GOOD), smtpTargets: [{ host: 'smtp.hosting.test' }] });
  assert.equal(r.status, 'ok', JSON.stringify(r, null, 1));
  assert.equal(r.spf.lookups, 2);
  assert.equal(r.spf.smtp[0].result, 'pass');
  assert.equal(r.dmarc.policy, 'quarantine');
  assert.equal(r.dkim.selectors.find((s) => s.selector === 'default').bits, 2048);
  assert.deepEqual(r.mx.records, ['10 mx.hosting.test']);
});

test('evaluación SPF: ip4, ip6, a, include, redirect, softfail y fail', async () => {
  const zone = {
    TXT: {
      'x.test': ['v=spf1 a ip4:203.0.113.0/28 include:inc.test -all'],
      'inc.test': ['v=spf1 ip6:2001:db8::/32 ~all'],
      'red.test': ['v=spf1 redirect=x.test'],
      'soft.test': ['v=spf1 ip4:203.0.113.1 ~all'],
    },
    A: { 'x.test': ['192.0.2.1'] },
  };
  const d = (await import('../src/dns/domain-check.mjs'));
  const wrap = (z) => {
    const f = fakeDns(z);
    const j = async (n) => (await f.resolveTxt(n).catch((e) => { if (e.code === 'ENOTFOUND') return []; throw e; })).map((c) => c.join(''));
    const safe = (fn) => (n) => fn(n).catch((e) => { if (e.code === 'ENOTFOUND') return []; throw e; });
    return { txt: j, a: safe(f.resolve4), aaaa: safe(f.resolve6), mx: safe(f.resolveMx) };
  };
  const w = wrap(zone);
  assert.equal(await d.spfCheckHost(w, '192.0.2.1', 'x.test'), 'pass', 'a');
  assert.equal(await d.spfCheckHost(w, '203.0.113.9', 'x.test'), 'pass', 'ip4/28');
  assert.equal(await d.spfCheckHost(w, '203.0.113.20', 'x.test'), 'fail', 'fuera del /28');
  assert.equal(await d.spfCheckHost(w, '2001:db8::1', 'x.test'), 'pass', 'ip6 por include');
  assert.equal(await d.spfCheckHost(w, '2001:db8::1', 'red.test'), 'pass', 'redirect');
  assert.equal(await d.spfCheckHost(w, '8.8.8.8', 'soft.test'), 'softfail');
  assert.equal(await d.spfCheckHost(w, '8.8.8.8', 'nada.test'), 'none');
  assert.equal(spfCheckHost.length >= 3, true);
});

test('errores de SPF: ninguno, dos registros, +all, demasiadas consultas, SMTP no autorizado', async () => {
  const none = await checkDomain('a.test', { resolver: fakeDns({ MX: { 'a.test': [{ priority: 1, exchange: 'mx.a.test' }] } }) });
  assert.equal(none.spf.status, 'error');
  assert.match(none.spf.checks[0].text, /No hay registro SPF/);

  const two = await checkDomain('a.test', { resolver: fakeDns({ TXT: { 'a.test': ['v=spf1 -all', 'v=spf1 ~all'] } }) });
  assert.equal(two.spf.status, 'error');
  assert.match(two.spf.checks[0].text, /2 registros SPF/);

  const plus = await checkDomain('a.test', { resolver: fakeDns({ TXT: { 'a.test': ['v=spf1 +all'] } }) });
  assert.ok(plus.spf.checks.some((c) => c.level === 'error' && /\+all/.test(c.text)));

  const TXT = { 'a.test': [`v=spf1 ${Array.from({ length: 11 }, (_, i) => `include:i${i}.test`).join(' ')} -all`] };
  for (let i = 0; i < 11; i += 1) TXT[`i${i}.test`] = ['v=spf1 -all'];
  const many = await checkDomain('a.test', { resolver: fakeDns({ TXT }) });
  assert.ok(many.spf.checks.some((c) => c.level === 'error' && /11 consultas/.test(c.text)));

  const broken = await checkDomain('a.test', { resolver: fakeDns({ TXT: { 'a.test': ['v=spf1 include:noexiste.test -all'] } }) });
  assert.ok(broken.spf.checks.some((c) => /noexiste.test/.test(c.text)));

  const noAuth = await checkDomain('bien.test', {
    resolver: fakeDns({ ...GOOD, A: { ...GOOD.A, 'otro.smtp.test': ['203.0.113.50'] } }),
    smtpTargets: [{ host: 'otro.smtp.test' }],
  });
  assert.equal(noAuth.spf.status, 'warn');
  assert.ok(noAuth.spf.checks.some((c) => /203.0.113.50/.test(c.text)));
});

test('un dominio sin ningún registro no se evalúa: no se afirma que falte SPF', async () => {
  const r = await checkDomain('mal-escrito.test', { resolver: fakeDns({}) });
  assert.equal(r.status, 'warn');
  assert.equal(r.resolvable, false);
  assert.equal(r.spf, null);
  assert.match(r.checks[0].text, /no devolvió ningún registro/);
});

test('DMARC: falta, p=none, sin rua, heredado del dominio padre, duplicado', async () => {
  const base = { TXT: { 'a.test': ['v=spf1 -all'] }, MX: { 'a.test': [{ priority: 1, exchange: 'mx.a.test' }] } };
  const none = await checkDomain('a.test', { resolver: fakeDns(base) });
  assert.equal(none.dmarc.status, 'error');

  const monitor = await checkDomain('a.test', { resolver: fakeDns({ ...base, TXT: { ...base.TXT, '_dmarc.a.test': ['v=DMARC1; p=none'] } }) });
  assert.equal(monitor.dmarc.status, 'warn');
  assert.ok(monitor.dmarc.checks.some((c) => /p=none/.test(c.text)));
  assert.ok(monitor.dmarc.checks.some((c) => /rua/.test(c.text)));

  const sub = await checkDomain('ventas.a.test', { resolver: fakeDns({ TXT: { '_dmarc.a.test': ['v=DMARC1; p=reject; rua=mailto:x@a.test'] }, A: { 'ventas.a.test': ['192.0.2.1'] } }) });
  assert.equal(sub.dmarc.status, 'ok');
  assert.equal(sub.dmarc.inherited_from, 'a.test');

  const dup = await checkDomain('a.test', { resolver: fakeDns({ ...base, TXT: { '_dmarc.a.test': ['v=DMARC1; p=reject', 'v=DMARC1; p=none'] } }) });
  assert.equal(dup.dmarc.status, 'error');

  const noPolicy = await checkDomain('a.test', { resolver: fakeDns({ ...base, TXT: { '_dmarc.a.test': ['v=DMARC1; rua=mailto:x@a.test'] } }) });
  assert.equal(noPolicy.dmarc.status, 'error');
});

test('DKIM: sin selector conocido, cargado, detectado sin publicar, revocado, 1024 bits, firma ajena', async () => {
  const z = (extra) => fakeDns({ TXT: { ...extra }, MX: { 'a.test': [{ priority: 1, exchange: 'mx.a.test' }] } });
  const nada = await checkDomain('a.test', { resolver: z({}) });
  assert.equal(nada.dkim.status, 'warn');
  assert.match(nada.dkim.checks[0].text, /No se encontró ninguna clave DKIM/);

  const cargado = await checkDomain('a.test', { resolver: z({ 'propio._domainkey.a.test': [`v=DKIM1; p=${KEY2048}`] }), selectors: ['propio'] });
  assert.equal(cargado.dkim.status, 'ok');
  assert.equal(cargado.dkim.selectors[0].source, 'cargado');

  const faltante = await checkDomain('a.test', { resolver: z({}), detected: ['s2026'] });
  assert.equal(faltante.dkim.status, 'error');
  assert.match(faltante.dkim.checks[0].text, /no está publicada/);

  const revocado = await checkDomain('a.test', { resolver: z({ 'default._domainkey.a.test': ['v=DKIM1; p='] }) });
  assert.equal(revocado.dkim.status, 'error');
  assert.match(revocado.dkim.checks[0].text, /revocada/);

  const corta = await checkDomain('a.test', { resolver: z({ 'mail._domainkey.a.test': [`v=DKIM1; k=rsa; p=${KEY1024}`] }) });
  assert.equal(corta.dkim.status, 'warn');
  assert.match(corta.dkim.checks[0].text, /1024 bits/);

  const ajena = await checkDomain('a.test', { resolver: z({ 'default._domainkey.a.test': [`p=${KEY2048}`] }), foreign: ['hosting.test'] });
  assert.equal(ajena.dkim.status, 'warn');
  assert.match(ajena.dkim.checks[0].text, /d=hosting.test/);
});

test('un DNS que falla avisa para reintentar, no dice "no configurado"', async () => {
  const r = await checkDomain('a.test', { resolver: fakeDns({ FAIL: { 'a.test': 'ESERVFAIL', '_dmarc.a.test': 'ETIMEOUT' } }) });
  assert.equal(r.spf.status, 'warn');
  assert.match(r.spf.checks[0].text, /Reintentar/);
  assert.equal(r.dmarc.status, 'warn');
  assert.equal(r.mx.status, 'warn');
});

test('firmas DKIM en cabeceras: alineadas y ajenas, con cabeceras plegadas', () => {
  const h = 'From: Ana <ana@a.test>\r\nDKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed;\r\n d=a.test; s=sel1;\r\n\tbh=xx; b=yy\r\nDKIM-Signature: v=1; d=hosting.test; s=h1; b=zz\r\n';
  assert.deepEqual(signaturesFromHeaders(h, 'a.test'), { aligned: ['sel1'], foreign: ['hosting.test'] });
});

// ---------------------------------------------------------------- endpoint

let server, base;
const DOM = 'cliente.test';

function browser() {
  let cookie = null;
  return {
    async call(method, path, body) {
      const res = await fetch(`${base}/admin/api${path}`, {
        method,
        headers: { 'x-mailgw-admin': '1', ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      return { status: res.status, body: await res.json() };
    },
  };
}

async function loggedIn(email, role, clientId) {
  const { setupToken } = await createUser({ email, name: email, role, clientId });
  const b = browser();
  assert.equal((await b.call('POST', '/activate', { token: setupToken, password: 'clave-larga-de-prueba' })).status, 200);
  assert.equal((await b.call('POST', '/login', { email, password: 'clave-larga-de-prueba' })).status, 200);
  return b;
}

before(async () => {
  server = await startServer(0);
  base = `http://127.0.0.1:${server.address().port}`;
  await store.upsertClient('dom-a', 'Dominios A');
  await store.upsertClient('dom-b', 'Dominios B');
  // Buzón propio de esta batería, para no tocar los UID de los buzones de gateway.test.mjs.
  const buzon = 'carla@cliente.test';
  await store.upsertAccount({
    client_id: 'dom-a', email: buzon, display_name: null, username: buzon,
    secret_enc: encryptSecret(USERS[buzon], aadFor('dom-a', buzon)),
    imap_host: HOST, imap_port: PORTS.imaps, imap_security: 'tls',
    smtp_host: 'smtp.hosting.test', smtp_port: PORTS.smtps, smtp_security: 'tls',
    timezone: 'America/Argentina/Buenos_Aires', daily_send_cap: 40, append_sent: true,
  });
  // Un mail de un colega del mismo dominio, firmado por el servidor con el selector "sel2026",
  // y uno de afuera con otra firma que no tiene que contar.
  await appendTo(buzon, 'INBOX', rfc822({
    from: 'Colega <colega@cliente.test>', to: buzon, subject: 'Interno', messageId: '<interno-1@cliente.test>',
    headers: { 'DKIM-Signature': 'v=1; a=rsa-sha256; c=relaxed/relaxed; d=cliente.test; s=sel2026; bh=x; b=y' },
    body: 'Hola',
  }));
  await appendTo(buzon, 'INBOX', rfc822({
    from: 'Newsletter <news@otro.test>', to: buzon, subject: 'Promo', messageId: '<news-1@otro.test>',
    headers: { 'DKIM-Signature': 'v=1; d=otro.test; s=nl; b=z' },
    body: 'Oferta',
  }));
  useResolver(fakeDns({
    TXT: {
      [DOM]: ['v=spf1 include:_spf.hosting.test -all'],
      '_spf.hosting.test': ['v=spf1 ip4:198.51.100.0/24 -all'],
      [`_dmarc.${DOM}`]: ['v=DMARC1; p=none; rua=mailto:d@cliente.test'],
      [`sel2026._domainkey.${DOM}`]: [`v=DKIM1; k=rsa; p=${KEY2048}`],
    },
    A: { 'smtp.hosting.test': ['198.51.100.7'] },
    MX: { [DOM]: [{ priority: 10, exchange: 'mx.hosting.test' }] },
  }));
});

after(async () => {
  useResolver(null);
  await new Promise((r) => server.close(r));
  await store.closePool();
});

test('verificar desde el panel: detecta el selector en los mails, guarda y lo muestra', async () => {
  const cli = await loggedIn('dom@cliente-a.test', 'client_admin', 'dom-a');
  const before = await cli.call('GET', '/clients/dom-a/domains');
  assert.equal(before.status, 200);
  assert.deepEqual(before.body.data.domains.map((d) => [d.domain, d.status]), [[DOM, null]]);

  const r = await cli.call('POST', '/clients/dom-a/domains/check', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const d = r.body.data.domains[0];
  assert.equal(d.status, 'warn', 'p=none');
  assert.equal(d.result.spf.status, 'ok');
  assert.equal(d.result.spf.smtp[0].result, 'pass');
  const sel = d.result.dkim.selectors.find((s) => s.selector === 'sel2026');
  assert.equal(sel.source, 'detectado');
  assert.equal(sel.bits, 2048);
  assert.ok(!JSON.stringify(d).includes('otro.test'), 'la firma de un remitente ajeno no cuenta');
  assert.equal(JSON.stringify(r.body).includes('secret_enc'), false);

  const again = await cli.call('GET', '/clients/dom-a/domains');
  assert.equal(again.body.data.domains[0].status, 'warn');
  assert.ok(again.body.data.domains[0].checked_at);
});

test('selectores propios: se validan, se guardan y se usan; otro cliente no ve nada', async () => {
  const cli = await loggedIn('dom2@cliente-a.test', 'client_admin', 'dom-a');
  assert.equal((await cli.call('PUT', `/clients/dom-a/domains/${DOM}/selectors`, { selectors: ['mal selector'] })).status, 400);
  assert.equal((await cli.call('PUT', '/clients/dom-a/domains/ajeno.test/selectors', { selectors: ['x'] })).status, 404);
  const ok = await cli.call('PUT', `/clients/dom-a/domains/${DOM}/selectors`, { selectors: ['Propio'] });
  assert.deepEqual(ok.body.data.dkim_selectors, ['propio']);
  const r = await cli.call('POST', '/clients/dom-a/domains/check', { domain: DOM });
  const propio = r.body.data.domains[0].result.dkim.selectors.find((s) => s.selector === 'propio');
  assert.equal(propio.source, 'cargado');
  assert.equal(propio.found, false);
  assert.equal((await cli.call('POST', '/clients/dom-a/domains/check', { domain: 'ajeno.test' })).status, 404);

  const otro = await loggedIn('dom@cliente-b.test', 'client_admin', 'dom-b');
  assert.equal((await otro.call('GET', '/clients/dom-a/domains')).status, 404);
  assert.equal((await otro.call('POST', '/clients/dom-a/domains/check', {})).status, 404);
  assert.equal((await otro.call('PUT', `/clients/dom-a/domains/${DOM}/selectors`, { selectors: ['x'] })).status, 404);
  assert.deepEqual((await otro.call('GET', '/clients/dom-b/domains')).body.data.domains, []);
});
