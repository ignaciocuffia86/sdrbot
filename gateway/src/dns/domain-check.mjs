// Chequeo de la configuración de correo de un dominio por DNS: SPF, DKIM, DMARC y MX.
//
// Para un SDR esto decide si los mails llegan a la bandeja o a spam. Sin SPF y DKIM
// alineados con DMARC, Gmail y Microsoft rechazan o mandan a spam a los remitentes que
// envían volumen desde 2024.
//
// Sólo lee DNS: no se conecta a nada. El resolver se inyecta para poder probarlo sin red.
//
// Cada sección devuelve { status: 'ok' | 'warn' | 'error', record, checks: [{ level, text }] }.

import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import { detectProvider, dkimHints, dmarcHints, mxHints, providerOfHost, spfHints, unresolvableHint } from './hints.mjs';

const SPF_MAX_LOOKUPS = 10;
const DNS_TIMEOUT_MS = 4000;

// Selectores DKIM habituales. DKIM no permite listar selectores: hay que adivinarlos, por eso
// el chequeo también los toma de los mails del buzón y de los que cargue el cliente.
export const COMMON_SELECTORS = [
  'default', 'dkim', 'mail', 'selector1', 'selector2', 'google', 'k1', 'k2', 's1', 's2',
  'smtp', 'x', 'mx', 'zoho', 'zmail', 'key1', 'dkim1', 'sig1', 'email', 'mta',
];

export function systemResolver() {
  const r = new dns.Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 });
  return {
    resolveTxt: (n) => r.resolveTxt(n),
    resolve4: (n) => r.resolve4(n),
    resolve6: (n) => r.resolve6(n),
    resolveMx: (n) => r.resolveMx(n),
  };
}

const EMPTY = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENONAME']);

class TempError extends Error {}

// Envuelve el resolver: "no existe" es una respuesta vacía; un timeout o SERVFAIL es un
// error temporal que no hay que confundir con "no está configurado". Cachea por consulta.
function wrap(resolver) {
  const cache = new Map();
  const call = (kind, name) => {
    const key = `${kind}:${name.toLowerCase()}`;
    if (!cache.has(key)) {
      cache.set(key, resolver[kind](name).catch((e) => {
        if (EMPTY.has(e?.code)) return [];
        throw new TempError(`${e?.code ?? 'error'} al consultar ${name}`);
      }));
    }
    return cache.get(key);
  };
  return {
    txt: async (n) => (await call('resolveTxt', n)).map((chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks))),
    a: (n) => call('resolve4', n),
    aaaa: (n) => call('resolve6', n),
    mx: (n) => call('resolveMx', n),
  };
}

const RANK = { ok: 0, warn: 1, error: 2 };
const worst = (...s) => s.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'ok');
const statusOf = (checks) => worst(...checks.map((c) => c.level));
const ok = (text) => ({ level: 'ok', text });
const warn = (text, hint) => ({ level: 'warn', text, ...(hint ? { hint } : {}) });
const err = (text, hint) => ({ level: 'error', text, ...(hint ? { hint } : {}) });

// ---------------------------------------------------------------- SPF

function parseSpf(record) {
  const terms = record.trim().split(/\s+/).slice(1);
  const mechanisms = [];
  const modifiers = {};
  for (const t of terms) {
    const mod = /^([a-z][a-z0-9_.-]*)=(.*)$/i.exec(t);
    if (mod) { modifiers[mod[1].toLowerCase()] = mod[2]; continue; }
    const m = /^([+\-~?]?)([a-z0-9]+)(?::([^/]+))?(\/\d+)?(\/\/\d+)?$/i.exec(t);
    if (!m) { mechanisms.push({ invalid: t }); continue; }
    const [, q, name, arg, c4, c6] = m;
    mechanisms.push({
      qualifier: q || '+', name: name.toLowerCase(), arg: arg ?? null,
      cidr4: c4 ? Number(c4.slice(1)) : null, cidr6: c6 ? Number(c6.slice(2)) : null, raw: t,
    });
  }
  return { mechanisms, modifiers };
}

async function spfRecordsOf(d, name) {
  return (await d.txt(name)).filter((t) => /^v=spf1(\s|$)/i.test(t.trim()));
}

const QUALIFIER = { '+': 'pass', '-': 'fail', '~': 'softfail', '?': 'neutral' };
const LOOKUP_MECHS = new Set(['include', 'a', 'mx', 'ptr', 'exists']);

function inRange(ip, addr, prefix) {
  const fam = net.isIPv4(ip) ? 'ipv4' : 'ipv6';
  if ((net.isIPv4(addr) ? 'ipv4' : 'ipv6') !== fam) return false;
  const bl = new net.BlockList();
  bl.addSubnet(addr, prefix ?? (fam === 'ipv4' ? 32 : 128), fam);
  return bl.check(ip, fam);
}

// Recorre el árbol entero (includes y redirect) para contar consultas: es lo que miran los
// receptores y los verificadores. Pasar de 10 es un error permanente: el SPF no sirve.
async function spfTree(d, domain, state, depth = 0) {
  if (depth > 10) { state.loop = true; return; }
  const recs = await spfRecordsOf(d, domain);
  if (recs.length !== 1) { if (depth > 0) state.brokenIncludes.push(domain); return; }
  const { mechanisms, modifiers } = parseSpf(recs[0]);
  for (const m of mechanisms) {
    if (m.invalid) { state.invalid.push(m.invalid); continue; }
    const before = state.lookups;
    if (LOOKUP_MECHS.has(m.name)) state.lookups += 1;
    if (m.name === 'ptr') state.ptr = true;
    if (m.name === 'include' && m.arg) await spfTree(d, m.arg, state, depth + 1);
    if (depth === 0 && state.lookups > before) state.breakdown.push({ term: m.raw, lookups: state.lookups - before });
  }
  if (modifiers.redirect) {
    const before = state.lookups;
    state.lookups += 1;
    await spfTree(d, modifiers.redirect, state, depth + 1);
    if (depth === 0) state.breakdown.push({ term: `redirect=${modifiers.redirect}`, lookups: state.lookups - before });
  }
}

// Evaluación de RFC 7208 para una IP, sin macros. Devuelve pass, fail, softfail, neutral,
// none, permerror o temperror.
export async function spfCheckHost(d, ip, domain, depth = 0) {
  if (depth > 10) return 'permerror';
  let recs;
  try { recs = await spfRecordsOf(d, domain); } catch { return 'temperror'; }
  if (recs.length === 0) return 'none';
  if (recs.length > 1) return 'permerror';
  const { mechanisms, modifiers } = parseSpf(recs[0]);
  const v6 = net.isIPv6(ip);
  try {
    for (const m of mechanisms) {
      if (m.invalid) return 'permerror';
      const target = m.arg ?? domain;
      if (target.includes('%')) continue; // macros: no se evalúan
      let match = false;
      switch (m.name) {
        case 'all': match = true; break;
        case 'ip4': match = !v6 && inRange(ip, m.arg, m.cidr4); break;
        case 'ip6': match = v6 && inRange(ip, m.arg, m.cidr4 ?? m.cidr6); break;
        case 'a': {
          const addrs = v6 ? await d.aaaa(target) : await d.a(target);
          match = addrs.some((x) => inRange(ip, x, v6 ? m.cidr6 : m.cidr4));
          break;
        }
        case 'mx': {
          const mxs = (await d.mx(target)).slice(0, 10);
          for (const mx of mxs) {
            const addrs = v6 ? await d.aaaa(mx.exchange) : await d.a(mx.exchange);
            if (addrs.some((x) => inRange(ip, x, v6 ? m.cidr6 : m.cidr4))) { match = true; break; }
          }
          break;
        }
        case 'include': {
          const r = await spfCheckHost(d, ip, m.arg, depth + 1);
          if (r === 'temperror') return 'temperror';
          if (r === 'permerror' || r === 'none') return 'permerror';
          match = r === 'pass';
          break;
        }
        case 'exists': match = (await d.a(target)).length > 0; break;
        default: break; // ptr y desconocidos: no coinciden
      }
      if (match) return QUALIFIER[m.qualifier];
    }
    if (modifiers.redirect) {
      const r = await spfCheckHost(d, ip, modifiers.redirect, depth + 1);
      return r === 'none' ? 'permerror' : r;
    }
  } catch (e) {
    if (e instanceof TempError) return 'temperror';
    throw e;
  }
  return 'neutral';
}

async function checkSpf(d, domain, smtpTargets, provider) {
  const checks = [];
  let recs;
  try { recs = await spfRecordsOf(d, domain); } catch (e) {
    return { status: 'warn', record: null, checks: [warn(`No se pudo consultar el DNS (${e.message}). Reintentar.`, spfHints.temp())] };
  }
  if (recs.length === 0) {
    const ips = [];
    for (const t of smtpTargets) {
      if (providerOfHost(t.host)) continue;
      try { ips.push(...(net.isIP(t.host) ? [t.host] : await d.a(t.host))); } catch { /* sin IP */ }
    }
    return { status: 'error', record: null, checks: [err('No hay registro SPF (TXT "v=spf1 …"). Los proveedores van a tratar los mails como no autorizados.',
      spfHints.missing(domain, provider, [...new Set(ips)].slice(0, 3)))] };
  }
  if (recs.length > 1) {
    return { status: 'error', record: recs.join('\n'), checks: [err(`Hay ${recs.length} registros SPF. Tiene que haber uno solo: con más de uno el SPF entero se invalida. Unificarlos en uno.`,
      spfHints.multiple(domain, recs))] };
  }
  const record = recs[0];
  const { mechanisms, modifiers } = parseSpf(record);
  const all = [...mechanisms].reverse().find((m) => m.name === 'all');
  if (!all && !modifiers.redirect) checks.push(warn('No termina en "all": lo que no está listado queda neutro. Agregar "~all" o "-all" al final.', spfHints.noAll(domain, record)));
  else if (all?.qualifier === '+') checks.push(err('"+all" autoriza a cualquier servidor del mundo a mandar en nombre del dominio. Cambiar por "~all" o "-all".', spfHints.weakAll(domain, record)));
  else if (all?.qualifier === '?') checks.push(warn('"?all" no protege: lo que no está listado queda neutro. Usar "~all" o "-all".', spfHints.weakAll(domain, record)));
  else if (all) checks.push(ok(`Termina en "${all.raw}".`));

  const state = { lookups: 0, invalid: [], brokenIncludes: [], ptr: false, loop: false, breakdown: [] };
  try { await spfTree(d, domain, state); } catch (e) {
    checks.push(warn(`No se pudo recorrer todo el SPF (${e.message}).`, spfHints.temp()));
  }
  if (state.invalid.length) checks.push(err(`Términos inválidos: ${state.invalid.join(', ')}.`, spfHints.invalid(domain, record, state.invalid)));
  if (state.brokenIncludes.length) {
    checks.push(err(`Incluye dominios sin un SPF válido: ${state.brokenIncludes.join(', ')}.`, spfHints.broken(domain, record, state.brokenIncludes)));
  }
  if (state.loop) checks.push(err('Los include se llaman en bucle.', spfHints.loop(domain)));
  if (state.lookups > SPF_MAX_LOOKUPS) {
    checks.push(err(`Hace ${state.lookups} consultas DNS; el máximo es ${SPF_MAX_LOOKUPS}. Pasado el límite el SPF falla entero.`,
      spfHints.tooManyLookups(domain, state.lookups, state.breakdown)));
  } else {
    checks.push(ok(`${state.lookups} de ${SPF_MAX_LOOKUPS} consultas DNS.`));
  }
  if (state.ptr) checks.push(warn('Usa "ptr", que está desaconsejado y muchos receptores ignoran.', spfHints.ptr(domain, record)));

  // ¿Autoriza al servidor SMTP con el que manda el buzón?
  const smtp = [];
  for (const t of smtpTargets) {
    let ips = [];
    try {
      ips = net.isIP(t.host) ? [t.host] : [...await d.a(t.host), ...await d.aaaa(t.host)];
    } catch { /* se informa abajo */ }
    if (!ips.length) {
      smtp.push({ host: t.host, ip: null, result: 'unresolved' });
      continue;
    }
    for (const ip of ips.slice(0, 4)) smtp.push({ host: t.host, ip, result: await spfCheckHost(d, ip, domain) });
  }
  const byHost = new Map();
  for (const s of smtp) byHost.set(s.host, [...(byHost.get(s.host) ?? []), s]);
  for (const [host, rows] of byHost) {
    const hostProvider = providerOfHost(host);
    const hasInclude = hostProvider && new RegExp(`include:${hostProvider.spfInclude.replace(/\./g, '\\.')}(\\s|$)`, 'i').test(record);
    if (rows.some((r) => r.result === 'pass')) checks.push(ok(`Autoriza al servidor SMTP del buzón (${host}).`));
    else if (hasInclude) {
      // Google y Microsoft reciben en un servidor y entregan desde otros: lo que cuenta es el include.
      checks.push(ok(`El buzón manda por ${hostProvider.name} y el SPF incluye «${hostProvider.spfInclude}».`));
    } else if (hostProvider) {
      checks.push(err(`El buzón manda por ${hostProvider.name} (${host}), pero el SPF no incluye «${hostProvider.spfInclude}».`,
        spfHints.smtpProviderMissing(domain, record, host, hostProvider)));
    } else if (rows[0].result === 'unresolved') checks.push(warn(`No se pudo resolver el servidor SMTP ${host}.`, spfHints.temp()));
    else {
      checks.push(warn(`La IP de ${host} (${rows.map((r) => r.ip).join(', ')}) no está autorizada en el SPF.`,
        spfHints.smtpIpMissing(domain, record, host, rows.map((r) => r.ip))));
    }
  }
  return { status: statusOf(checks), record, lookups: state.lookups, smtp, checks };
}

// ---------------------------------------------------------------- DMARC

function parseTags(record) {
  const tags = {};
  for (const part of record.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    tags[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return tags;
}

async function dmarcAt(d, name) {
  return (await d.txt(`_dmarc.${name}`)).filter((t) => /^v=DMARC1\s*(;|$)/i.test(t.trim()));
}

async function checkDmarc(d, domain, provider, ready) {
  const checks = [];
  let found = null;
  let at = domain;
  try {
    // Si el subdominio no tiene, rige el del dominio padre (dominio organizacional).
    const labels = domain.split('.');
    for (let i = 0; i <= labels.length - 2; i += 1) {
      at = labels.slice(i).join('.');
      const recs = await dmarcAt(d, at);
      if (recs.length) { found = recs; break; }
    }
  } catch (e) {
    return { status: 'warn', record: null, checks: [warn(`No se pudo consultar el DNS (${e.message}). Reintentar.`, dmarcHints.temp())] };
  }
  if (!found) {
    return { status: 'error', record: null, checks: [err(`No hay registro DMARC en _dmarc.${domain}. Gmail y Microsoft lo exigen a quien envía volumen.`,
      dmarcHints.missing(domain, provider))] };
  }
  if (found.length > 1) {
    return { status: 'error', record: found.join('\n'), checks: [err('Hay más de un registro DMARC: los receptores lo ignoran. Dejar uno solo.', dmarcHints.duplicate(at, found))] };
  }
  const record = found[0];
  const tags = parseTags(record);
  if (at !== domain) checks.push(ok(`Lo hereda de ${at}.`));
  const policy = tags.p?.toLowerCase();
  if (!['none', 'quarantine', 'reject'].includes(policy)) {
    checks.push(err('Falta la política (p=none, quarantine o reject) o es inválida: el registro no tiene efecto.', dmarcHints.noPolicy(at, tags)));
  } else if (policy === 'none') {
    checks.push(warn('Política "p=none": sólo monitorea. Sirve para empezar, pero no frena suplantaciones y pesa menos para la entrega.',
      dmarcHints.monitorOnly(at, tags, ready)));
  } else {
    checks.push(ok(`Política "p=${policy}".`));
  }
  if (tags.pct && Number(tags.pct) < 100) checks.push(warn(`Se aplica sólo al ${tags.pct}% de los mails (pct).`, dmarcHints.pct(at, tags)));
  if (!tags.rua) checks.push(warn('Sin "rua": no llegan reportes, así que no hay forma de ver quién manda en nombre del dominio.', dmarcHints.noRua(at, tags)));
  else checks.push(ok('Recibe reportes (rua).'));
  return { status: statusOf(checks), record, policy: policy ?? null, inherited_from: at !== domain ? at : null, checks };
}

// ---------------------------------------------------------------- DKIM

function keyInfo(record) {
  const tags = parseTags(record);
  if (tags.v && tags.v !== 'DKIM1') return { error: `Versión desconocida "${tags.v}".` };
  const p = (tags.p ?? '').replace(/\s+/g, '');
  if (!p) return { error: 'La clave está dada de baja (p= vacío).', revoked: true };
  const k = (tags.k ?? 'rsa').toLowerCase();
  if (k === 'ed25519') return { type: 'ed25519', bits: 256 };
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(p, 'base64'), format: 'der', type: 'spki' });
    return { type: key.asymmetricKeyType, bits: key.asymmetricKeyDetails?.modulusLength ?? null };
  } catch {
    return { error: 'La clave pública no se puede leer (p= mal copiado o cortado).' };
  }
}

async function checkDkim(d, domain, { configured = [], detected = [], foreign = [], scanned = false }, provider) {
  const checks = [];
  if (foreign.length) {
    checks.push(warn(`Hay mails firmados con d=${foreign.join(', ')}, que no es el dominio: esa firma no cuenta para DMARC.`, dkimHints.foreign(domain, foreign, provider)));
  }
  const sources = new Map();
  for (const s of COMMON_SELECTORS) sources.set(s, 'común');
  for (const s of configured) sources.set(s, 'cargado');
  for (const s of detected) sources.set(s, 'detectado');
  const results = await Promise.all([...sources].map(async ([selector, source]) => {
    try {
      const txt = (await d.txt(`${selector}._domainkey.${domain}`)).filter((t) => /(^|;)\s*p=/i.test(t) || /v=DKIM1/i.test(t));
      if (!txt.length) return { selector, source, found: false };
      return { selector, source, found: true, ...keyInfo(txt[0]) };
    } catch (e) {
      return { selector, source, found: false, temp: e.message };
    }
  }));
  const found = results.filter((r) => r.found);
  const anyValid = found.some((r) => !r.error && !(r.type === 'rsa' && r.bits < 1024));
  const strong = found.filter((r) => !r.error && (r.type !== 'rsa' || r.bits >= 2048)).map((r) => r.selector);
  const weakContext = (sel) => ({ strongOthers: strong.filter((x) => x !== sel), detected });
  // Los comunes sólo se informan si existen; los cargados y detectados, siempre.
  const shown = results.filter((r) => r.found || r.source !== 'común');
  for (const r of shown) {
    const label = `Selector "${r.selector}" (${r.source})`;
    if (!r.found) {
      checks.push(r.source === 'común' ? null
        : r.temp ? warn(`${label}: no se pudo consultar (${r.temp}).`, dkimHints.temp())
          : r.source === 'detectado'
            ? err(`${label}: no existe ${r.selector}._domainkey.${domain}. Los mails salen firmados con una clave que no está publicada: fallan DKIM.`,
              dkimHints.notPublished(domain, r.selector, provider))
            : err(`${label}: no existe ${r.selector}._domainkey.${domain}. Revisar el nombre.`, dkimHints.configuredMissing(domain, r.selector)));
      continue;
    }
    if (r.revoked) {
      // Una clave dada de baja es normal si hay otra válida: así se retira un selector viejo.
      const msg = `${label}: ${r.error}`;
      checks.push(anyValid ? warn(msg, dkimHints.revoked(domain, r.selector, provider, true)) : err(msg, dkimHints.revoked(domain, r.selector, provider, false)));
    } else if (r.error) checks.push(err(`${label}: ${r.error}`, dkimHints.unreadable(domain, r.selector)));
    else if (r.type === 'rsa' && r.bits < 1024) checks.push(err(`${label}: clave RSA de ${r.bits} bits; los receptores la rechazan.`, dkimHints.weakKey(domain, r.selector, provider, weakContext(r.selector))));
    else if (r.type === 'rsa' && r.bits < 2048) checks.push(warn(`${label}: clave RSA de ${r.bits} bits. Funciona, pero 2048 es lo recomendado.`, dkimHints.weakKey(domain, r.selector, provider, weakContext(r.selector))));
    else checks.push(ok(`${label}: clave ${r.type.toUpperCase()}${r.bits ? ` de ${r.bits} bits` : ''}.`));
  }
  const cleaned = checks.filter(Boolean);
  if (!found.length && !cleaned.length) {
    cleaned.push(warn(`No se encontró ninguna clave DKIM en los selectores habituales${scanned ? ' ni en los mails del buzón' : ''}. `
      + 'DKIM no se puede listar por DNS: si el dominio ya firma, cargar el selector (lo dice el proveedor de correo o la cabecera DKIM-Signature, en "s=").',
    dkimHints.missing(domain, provider)));
  }
  return {
    status: statusOf(cleaned),
    // Hay al menos una clave publicada que los receptores aceptan.
    valid: anyValid,
    selectors: results.filter((r) => r.found || r.source !== 'común').map(({ temp: _t, ...r }) => r),
    checks: cleaned,
  };
}

// ---------------------------------------------------------------- MX

async function checkMx(d, domain, provider) {
  let mxs;
  try { mxs = await d.mx(domain); } catch (e) {
    return { status: 'warn', records: [], checks: [warn(`No se pudo consultar el DNS (${e.message}).`, mxHints.temp())] };
  }
  if (!mxs.length) {
    return { status: 'error', records: [], checks: [err('El dominio no tiene MX: no puede recibir las respuestas de los prospectos.', mxHints.missing(domain, provider))] };
  }
  const records = mxs.sort((a, b) => a.priority - b.priority).map((m) => `${m.priority} ${m.exchange}`);
  return { status: 'ok', records, checks: [ok(`${mxs.length} servidor(es) de entrada.`)] };
}

// ---------------------------------------------------------------- todo junto

export async function checkDomain(domain, { resolver = systemResolver(), smtpTargets = [], selectors = [], detected = [], foreign = [], scanned = false } = {}) {
  const d = wrap(resolver);
  // Un dominio sin ningún registro es un dominio mal escrito o un DNS que no responde (algunos
  // entornos contestan "no existe" a todo). En los dos casos no se puede evaluar, y decir "no
  // tiene SPF" sería falso: se informa eso solo.
  const probes = await Promise.allSettled([d.txt(domain), d.mx(domain), d.a(domain), d.aaaa(domain)]);
  if (probes.every((p) => p.status === 'fulfilled' && p.value.length === 0)) {
    return {
      domain, status: 'warn', resolvable: false, spf: null, dkim: null, dmarc: null, mx: null,
      checks: [warn(`El DNS no devolvió ningún registro para ${domain} (ni TXT, ni MX, ni A). `
        + 'O el dominio está mal escrito, o el DNS no respondió: no se puede evaluar.', unresolvableHint(domain))],
    };
  }
  const mxHosts = probes[1].status === 'fulfilled' ? probes[1].value.map((m) => m.exchange) : [];
  const provider = detectProvider(mxHosts, smtpTargets.map((t) => t.host));
  const [spf, dkim, mx] = await Promise.all([
    checkSpf(d, domain, smtpTargets, provider),
    checkDkim(d, domain, { configured: selectors, detected, foreign, scanned }, provider),
    checkMx(d, domain, provider),
  ]);
  // DMARC va después: el consejo de subir la política depende de que SPF y DKIM estén bien.
  // "Listo para subir DMARC" mira si SPF pasa y si hay una clave DKIM válida, no si cada
  // sección está en verde: una clave vieja de 1024 bits de más no cambia la respuesta.
  const dmarc = await checkDmarc(d, domain, provider, {
    spfOk: spf.status === 'ok',
    dkimOk: dkim.valid && !dkim.checks.some((c) => c.level === 'error'),
  });
  return {
    domain, status: worst(spf.status, dmarc.status, dkim.status, mx.status), resolvable: true,
    provider: provider.id === 'hosting' ? null : provider.name, spf, dkim, dmarc, mx, checks: [],
  };
}

// Firmas DKIM de cabeceras DKIM-Signature: selectores del propio dominio (alineados con
// DMARC) y dominios ajenos que firman en su nombre (un hosting que firma con su dominio).
export function signaturesFromHeaders(headerText, domain) {
  const aligned = new Set();
  const foreign = new Set();
  const unfolded = String(headerText).replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    if (!/^dkim-signature:/i.test(line)) continue;
    const tags = parseTags(line.slice(line.indexOf(':') + 1));
    const d = tags.d?.toLowerCase();
    if (!tags.s || !d) continue;
    if (d === domain || domain.endsWith(`.${d}`) || d.endsWith(`.${domain}`)) aligned.add(tags.s);
    else foreign.add(d);
  }
  return { aligned: [...aligned], foreign: [...foreign] };
}
