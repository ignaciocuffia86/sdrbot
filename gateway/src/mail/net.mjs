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
    const lower = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateIp(mapped[1]);
    return lower === '::' || lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower)
      || lower.startsWith('2001:db8') || lower.startsWith('64:ff9b');
  }
  return true;
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
