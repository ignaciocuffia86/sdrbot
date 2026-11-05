// Enrutador HTTP del gateway. Lo usan el adaptador de Vercel (api/index.mjs) y el
// servidor local (src/server.mjs).
//
//   GET  /health            sin token: vivo y versión
//   GET  /v1/mailboxes      atajo de POST /v1/mailboxes
//   POST /v1/<op>           una operación (ver src/ops.mjs), cuerpo JSON
//   POST /mcp               MCP (streamable HTTP, sin sesión)
//   POST /cron/correo       el reloj (pg_cron en Supabase): lee los buzones y despierta a seguimiento
//   GET  /admin             panel web (src/admin/static) · /admin/api/* su API (src/admin/api.mjs)
//
// Toda respuesta REST es { ok: true, data } o { ok: false, error: { code, message } }.

import { authenticate } from './auth.mjs';
import { errors, GatewayError } from './errors.mjs';
import { limits, VERSION } from './config.mjs';
import { opByName, runOp } from './ops.mjs';
import { handleMcp } from './mcp.mjs';
import { handleAdminApi } from './admin/api.mjs';
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { hashToken } from './crypto.mjs';
import { tick, hashReloj } from './sdr/correo.mjs';

// Cabeceras del panel: sin scripts ni estilos de terceros ni en línea, sin marcos.
const ADMIN_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
    + "img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000',
  'Cache-Control': 'no-store',
};

const STATIC = {
  '/admin': ['index.html', 'text/html; charset=utf-8'],
  '/admin/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/admin/app.css': ['app.css', 'text/css; charset=utf-8'],
};
const staticCache = new Map();

async function serveStatic(res, [file, type]) {
  if (!staticCache.has(file)) staticCache.set(file, await readFile(new URL(`./admin/static/${file}`, import.meta.url)));
  res.statusCode = 200;
  for (const [k, v] of Object.entries(ADMIN_HEADERS)) res.setHeader(k, v);
  res.setHeader('Content-Type', type);
  res.end(staticCache.get(file));
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

const fail = (res, e) => send(res, e.status ?? 500, { ok: false, error: { code: e.code, message: e.message, ...(e.extra ?? {}) } });

async function readBody(req) {
  // Vercel ya parsea el JSON en req.body (y tira una excepción al leerlo si no es JSON
  // válido); el servidor local no lo parsea.
  let parsed;
  try {
    parsed = req.body;
    if (typeof parsed === 'string') parsed = JSON.parse(parsed || '{}');
  } catch {
    throw errors.invalid('El cuerpo no es JSON válido.');
  }
  if (parsed !== undefined) return parsed ?? {};
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limits.maxBodyBytes) throw errors.tooLarge();
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw errors.invalid('El cuerpo no es JSON válido.');
  }
}

export async function handle(req, res) {
  const path = new URL(req.url ?? '/', 'http://local').pathname.replace(/\/+$/, '') || '/';
  try {
    if (path === '/health' && req.method === 'GET') {
      return send(res, 200, { ok: true, data: { service: 'sdrbot-mail-gateway', version: VERSION } });
    }

    if (path === '/cron/correo') {
      if (req.method !== 'POST') throw new GatewayError('method_not_allowed', 'Usar POST.', 405);
      const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
      const esperado = await hashReloj();
      const dado = m ? hashToken(m[1]) : '';
      if (!esperado || dado.length !== esperado.length
          || !crypto.timingSafeEqual(Buffer.from(dado), Buffer.from(esperado))) {
        throw new GatewayError('unauthorized', 'Secreto del reloj inválido.', 401);
      }
      return send(res, 200, { ok: true, data: await tick({ hasta: Date.now() + 40_000 }) });
    }

    if (path === '/admin' || path.startsWith('/admin/')) {
      for (const [k, v] of Object.entries(ADMIN_HEADERS)) res.setHeader(k, v);
      if (path.startsWith('/admin/api/') || path === '/admin/api') {
        const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
        const data = await handleAdminApi(req, res, path, body);
        return send(res, 200, { ok: true, data: data ?? {} });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new GatewayError('method_not_allowed', 'Usar GET.', 405);
      if (STATIC[path]) return await serveStatic(res, STATIC[path]);
      throw errors.notFound();
    }

    if (path === '/mcp') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return send(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Sólo POST.' }, id: null });
      }
      let ctx;
      try {
        ctx = await authenticate(req);
      } catch (e) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="sdrbot-mail-gateway"');
        return send(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: e.message }, id: null });
      }
      const body = await readBody(req);
      return await handleMcp(ctx, req, res, body);
    }

    const m = /^\/v1\/([a-z_]+)$/.exec(path);
    if (!m) throw errors.notFound();
    const o = opByName(m[1]);
    if (!o) throw errors.notFound();
    if (!(req.method === 'POST' || (req.method === 'GET' && o.op === 'mailboxes'))) {
      res.setHeader('Allow', 'POST');
      throw new GatewayError('method_not_allowed', 'Usar POST.', 405);
    }
    const ctx = await authenticate(req);
    const args = req.method === 'GET' ? {} : await readBody(req);
    const data = await runOp(ctx, o, args);
    return send(res, 200, { ok: true, data });
  } catch (e) {
    if (e instanceof GatewayError) return fail(res, e);
    console.error('[mailgw]', e);
    if (!res.headersSent) return fail(res, new GatewayError('internal', 'Error interno del gateway.', 500));
  }
}
