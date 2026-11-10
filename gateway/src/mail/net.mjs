// Destinos permitidos para IMAP y SMTP.
//
// Desde el panel /admin un usuario de un cliente carga el servidor y el puerto de su buzón,
// y "Probar conexión" hace que el gateway se conecte ahí. Sin control, eso sirve para hacer
// que el gateway abra conexiones a direcciones internas (SSRF). Por eso:
//   - el nombre se resuelve una vez y se conecta a esa misma IP, con el nombre original como
//     SNI para validar el certificado (un DNS que cambia entre el chequeo y la conexión no
//     cambia el destino);
//   - se rechazan IPs privadas, de loopback, link-local y reservadas;
//   - sólo se aceptan los puertos de correo habituales.
// MAILGW_ALLOW_PRIVATE_HOSTS=1 levanta las dos restricciones (sólo para las pruebas locales).

import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import { errors } from '../errors.mjs';

export const MAIL_PORTS = new Set([25, 143, 465, 587, 993, 2525]);
const allowPrivate = () => process.env.MAILGW_ALLOW_PRIVATE_HOSTS === '1';

function v4ToInt(ip) {
  return ip.split('.').reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;
}

const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([base, bits]) => [v4ToInt(base), bits]);

export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const n = v4ToInt(ip);
    return V4_BLOCKED.some(([base, bits]) => (n >>> (32 - bits)) === (base >>> (32 - bits)));
  }
  if (net.isIPv6(ip)) {
    const g = v6Groups(ip);
    if (!g) return true;
    const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    const ceros = (n) => g.slice(0, n).every((x) => x === 0);
    // Las formas que llevan una IPv4 adentro se juzgan por esa IPv4, se escriban como se escriban
    // («::ffff:127.0.0.1» y «::ffff:7f00:1» son la misma): mapeada (::ffff:0:0/96), compatible
    // (::/96, que incluye :: y ::1), SIIT (::ffff:0:0:0/96) y 6to4 (2002::/16).
    if (ceros(5) && g[5] === 0xffff) return isPrivateIp(v4(g[6], g[7]));
    if (ceros(6)) return g[6] === 0 && g[7] <= 1 ? true : isPrivateIp(v4(g[6], g[7]));
    if (ceros(4) && g[4] === 0xffff && g[5] === 0) return isPrivateIp(v4(g[6], g[7]));
    if (g[0] === 0x2002) return isPrivateIp(v4(g[1], g[2]));
    return (g[0] & 0xfe00) === 0xfc00 // fc00::/7, red local única
      || (g[0] & 0xffc0) === 0xfe80 // fe80::/10, enlace local
      || (g[0] & 0xffc0) === 0xfec0 // fec0::/10, sitio local (obsoleta)
      || (g[0] & 0xff00) === 0xff00 // ff00::/8, multidifusión
      || (g[0] === 0x2001 && g[1] === 0x0db8) // documentación
      || (g[0] === 0x2001 && g[1] === 0) // Teredo: lleva una IPv4 ofuscada
      || (g[0] === 0x0064 && g[1] === 0xff9b) // NAT64 (64:ff9b::/96 y 64:ff9b:1::/48)
      || (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) // 100::/64, descarte
      || g[0] === 0; // el resto de ::/16, reservado
  }
  return true;
}

// Una IPv6 en sus 8 grupos de 16 bits, con «::» expandido y una IPv4 final pasada a dos grupos. Sin
// la zona («%eth0»). null si no se puede leer.
function v6Groups(ip) {
  let s = String(ip).toLowerCase().split('%')[0];
  const cola = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (cola) {
    if (!net.isIPv4(cola[1])) return null;
    const n = v4ToInt(cola[1]);
    s = `${s.slice(0, -cola[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const partes = s.split('::');
  if (partes.length > 2) return null;
  const lee = (x) => (x ? x.split(':').map((h) => parseInt(h, 16)) : []);
  const ini = lee(partes[0]);
  const fin = partes.length === 2 ? lee(partes[1]) : [];
  const faltan = 8 - ini.length - fin.length;
  if (partes.length === 1 ? ini.length !== 8 : faltan < 1) return null;
  const g = [...ini, ...Array(partes.length === 2 ? faltan : 0).fill(0), ...fin];
  return g.length === 8 && g.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? g : null;
}

export function validateHostSyntax(host) {
  const h = String(host ?? '').trim().toLowerCase();
  if (!h || h.length > 253 || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h) && !net.isIP(h)) {
    throw errors.invalid(`Servidor inválido: "${host}". Usar un nombre como mail.dominio.com.`);
  }
  return h;
}

export function validatePort(port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw errors.invalid(`Puerto inválido: ${port}.`);
  if (!allowPrivate() && !MAIL_PORTS.has(p)) {
    throw errors.notAllowed(`Puerto ${p} no permitido. Puertos de correo admitidos: ${[...MAIL_PORTS].join(', ')}.`);
  }
  return p;
}

// Resuelve el servidor y devuelve la IP a la que conectarse. El nombre se sigue usando como
// SNI y para validar el certificado.
export async function resolveTarget(host, port, proto) {
  const h = validateHostSyntax(host);
  validatePort(port);
  if (allowPrivate()) return { address: h, servername: net.isIP(h) ? undefined : h };
  let addrs;
  try {
    addrs = net.isIP(h) ? [{ address: h }] : await dns.lookup(h, { all: true, verbatim: true });
  } catch (e) {
    throw errors.unreachable(proto, `no se encontró el servidor ${h} (${e.code ?? e.message})`);
  }
  const ok = addrs.find((a) => !isPrivateIp(a.address));
  if (!ok || addrs.some((a) => isPrivateIp(a.address))) {
    throw errors.notAllowed(`El servidor ${h} apunta a una dirección interna o reservada; no se permite.`);
  }
  return { address: ok.address, servername: net.isIP(h) ? undefined : h };
}

// ---------------------------------------------------------------- webhooks salientes
//
// El despertador (src/sdr/correo.mjs) le hace un POST a una URL que carga Biguá en el panel, con la
// clave del webhook en la cabecera. Sin control, sirve para que el gateway llame a la red interna de
// Vercel o a la metadata del proveedor. Por eso, como con IMAP y SMTP:
//   - sólo https, puerto 443, sin usuario ni contraseña en la URL;
//   - el nombre se resuelve al conectar y se rechaza si alguna dirección es interna o reservada
//     (un DNS que cambia entre la carga y el aviso no cambia lo que se controla);
//   - no se siguen redirecciones.


export function validateWebhookUrl(raw) {
  let u = null;
  try { u = new URL(String(raw ?? '').trim()); } catch { /* inválida */ }
  if (!u || u.protocol !== 'https:') throw errors.invalid('La URL del webhook tiene que empezar con https://.');
  if (u.username || u.password) throw errors.invalid('La URL del webhook no puede llevar usuario ni contraseña.');
  if (u.port && u.port !== '443' && !allowPrivate()) throw errors.notAllowed('La URL del webhook va al puerto 443 (el de https).');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!allowPrivate()) {
    if (net.isIP(host)) {
      if (isPrivateIp(host)) throw errors.notAllowed('La URL del webhook apunta a una dirección interna o reservada; no se permite.');
    } else {
      validateHostSyntax(host);
      if (!host.includes('.') || /\.(local|internal|localhost|lan|home|corp)$/i.test(host) || host === 'localhost') {
        throw errors.notAllowed('La URL del webhook tiene que ser de un dominio público.');
      }
    }
  }
  return u;
}

// Resuelve y controla: lo usan la carga (para avisar enseguida) y cada conexión.
export async function publicAddresses(host) {
  if (net.isIP(host)) {
    if (!allowPrivate() && isPrivateIp(host)) throw errors.notAllowed(`${host} es una dirección interna o reservada; no se permite.`);
    return [{ address: host, family: net.isIPv6(host) ? 6 : 4 }];
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true, verbatim: true });
  } catch (e) {
    throw errors.invalid(`No se encontró ${host} (${e.code ?? e.message}).`);
  }
  if (!allowPrivate() && (!addrs.length || addrs.some((a) => isPrivateIp(a.address)))) {
    throw errors.notAllowed(`${host} apunta a una dirección interna o reservada; no se permite.`);
  }
  return addrs;
}

// Al cargar la URL: avisa enseguida si el dominio no resuelve o apunta adentro. Con
// MAILGW_ALLOW_PRIVATE_HOSTS=1 (pruebas locales) no se resuelve.
export async function checkWebhookHost(raw) {
  const u = validateWebhookUrl(raw);
  if (!allowPrivate()) await publicAddresses(u.hostname.replace(/^\[|\]$/g, ''));
  return u;
}

// POST con cuerpo JSON. Devuelve { ok, status } como fetch; una redirección cuenta como falla.
// timeoutMs es un plazo total (DNS, conexión, TLS y la respuesta): un servidor que manda la
// respuesta de a poco no lo estira, como sí estiraría el timeout de inactividad del socket. Los
// despertadores corren de a uno, así que uno lento no puede trabar a los de los demás clientes.
// signal: además, el corte de quien llama.
export async function postWebhook(raw, { headers = {}, body = '', timeoutMs = 10_000, signal } = {}) {
  const u = validateWebhookUrl(raw);
  const lookup = (hostname, opts, cb) => {
    publicAddresses(hostname.replace(/^\[|\]$/g, '')).then((addrs) => {
      if (opts?.all) cb(null, addrs);
      else cb(null, addrs[0].address, addrs[0].family);
    }, (e) => cb(e));
  };
  if (signal?.aborted) throw new Error('cortado antes de empezar');
  return new Promise((resolve, reject) => {
    let listo = false;
    const terminar = (fn, v) => {
      if (listo) return;
      listo = true;
      clearTimeout(reloj);
      signal?.removeEventListener('abort', alCortar);
      fn(v);
    };
    const req = https.request(u, {
      method: 'POST', lookup, timeout: timeoutMs,
      headers: { ...headers, 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      res.resume();
      const status = res.statusCode ?? 0;
      terminar(resolve, { ok: status >= 200 && status < 300, status });
    });
    const cortar = (motivo) => { req.destroy(new Error(motivo)); };
    const reloj = setTimeout(() => cortar(`sin respuesta completa en ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
    const alCortar = () => cortar('cortado por quien llamó');
    signal?.addEventListener('abort', alCortar, { once: true });
    req.on('timeout', () => cortar(`sin respuesta en ${Math.round(timeoutMs / 1000)} s`));
    req.on('error', (e) => terminar(reject, e));
    req.end(body);
  });
}
