// API del panel /admin. Todas las rutas cuelgan de /admin/api y responden JSON. Acá queda sólo
// lo de HTTP (sesión por cookie, CSRF, ruteo); lo que hace cada ruta está en servicio.mjs, con
// los permisos de cada rol.
//
// Protección contra CSRF: la cookie es SameSite=Strict y además toda llamada tiene que traer
// la cabecera X-Mailgw-Admin, que un formulario de otro sitio no puede mandar. Sin CORS.

import Ajv from 'ajv';
import { errors, GatewayError } from '../errors.mjs';
import {
  activate, changePassword, clearCookie, cookieFor, login, logout, sessionUser, tokenFromCookie,
} from './auth.mjs';
import * as S from './servicio.mjs';

const ajv = new Ajv({ allErrors: true, useDefaults: true, strict: false });
const forbidden = () => new GatewayError('forbidden', 'No tenés permiso para esto.', 403);
const notFound = (what = 'No existe.') => new GatewayError('not_found', what, 404);

function validator(schema) {
  const v = ajv.compile(schema);
  return (body) => {
    const copy = structuredClone(body ?? {});
    if (!v(copy)) throw errors.invalid(`Datos inválidos: ${v.errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')}`);
    return copy;
  };
}

const V = {
  login: validator({ type: 'object', required: ['email', 'password'], additionalProperties: false,
    properties: { email: { type: 'string', maxLength: 254 }, password: { type: 'string', maxLength: 200 } } }),
  activate: validator({ type: 'object', required: ['token', 'password'], additionalProperties: false,
    properties: { token: { type: 'string', maxLength: 200 }, password: { type: 'string', maxLength: 200 } } }),
  changePassword: validator({ type: 'object', required: ['current', 'next'], additionalProperties: false,
    properties: { current: { type: 'string', maxLength: 200 }, next: { type: 'string', maxLength: 200 } } }),
};

// ---------------------------------------------------------------- rutas

const routes = [];
const route = (method, pattern, handler, { auth = true } = {}) => routes.push({
  method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler, auth,
});

// ----- sesión

route('POST', '/login', async ({ body, req, res, secure }) => {
  const b = V.login(body);
  const token = await login(b.email, b.password, { ip: req.headers['x-forwarded-for']?.split(',')[0] ?? null, userAgent: req.headers['user-agent'] });
  res.setHeader('Set-Cookie', cookieFor(token, { secure }));
  return { me: await sessionUser(token) };
}, { auth: false });

route('POST', '/activate', async ({ body }) => {
  const b = V.activate(body);
  const u = await activate(b.token, b.password);
  return { email: u.email };
}, { auth: false });

route('POST', '/logout', async ({ req, res, secure }) => {
  await logout(tokenFromCookie(req));
  res.setHeader('Set-Cookie', clearCookie({ secure }));
  return {};
});

route('GET', '/me', async ({ user }) => ({ me: user }));

route('POST', '/me/password', async ({ user, body }) => {
  const b = V.changePassword(body);
  await changePassword(user.id, b.current, b.next);
  return {};
});

// ----- operaciones (servicio.mjs)

route('GET', '/me/conexiones', S.conexionesListar);
route('POST', '/me/conexiones/:id/revocar', S.conexionRevocar);
route('GET', '/clients', S.clientesListar);
route('POST', '/clients', S.clienteCrear);
route('GET', '/clients/:client', S.clienteVer);
route('GET', '/clients/:client/activity', S.actividad);
route('POST', '/clients/:client/mailboxes', S.buzonCrear);
route('PATCH', '/clients/:client/mailboxes/:email', S.buzonEditar);
route('POST', '/clients/:client/mailboxes/:email/password', S.buzonContrasena);
route('POST', '/clients/:client/mailboxes/:email/status', S.buzonEstado);
route('POST', '/clients/:client/mailboxes/:email/check', S.buzonProbar);
route('DELETE', '/clients/:client/mailboxes/:email', S.buzonEliminar);
route('POST', '/clients/:client/users', S.usuarioClienteCrear);
route('GET', '/team', S.equipoListar);
route('POST', '/team', S.equipoCrear);
route('POST', '/users/:id/reset', S.usuarioReset);
route('POST', '/users/:id/status', S.usuarioEstado);
route('POST', '/clients/:client/tokens', S.tokenCrear);
route('POST', '/clients/:client/tokens/:id/revoke', S.tokenRevocar);
route('GET', '/clients/:client/sdr', S.sdrVer);
route('PUT', '/clients/:client/sdr/ajustes', S.ajustesGuardar);
route('POST', '/clients/:client/sdr/historial/:id/restaurar', S.ajustesRestaurar);
route('PUT', '/clients/:client/sdr/config', S.sdrConfig);
route('PUT', '/clients/:client/sdr/despertador', S.despertadorGuardar);
route('PUT', '/clients/:client/sdr/dripify', S.dripifyGuardar);
route('POST', '/clients/:client/sdr/dripify/probar', S.dripifyProbar);
route('POST', '/clients/:client/sdr/dripify/webhook', S.dripifyWebhook);
route('GET', '/clients/:client/aprobaciones', S.aprobacionesListar);
route('POST', '/clients/:client/aprobaciones/:id/decidir', S.aprobacionDecidir);
route('GET', '/clients/:client/crm', S.crmVer);
route('PUT', '/clients/:client/crm', S.crmGuardar);
route('POST', '/clients/:client/crm/probar', S.crmProbar);
route('POST', '/clients/:client/crm/vista-previa', S.crmVistaPrevia);
route('POST', '/clients/:client/crm/cargar', S.crmCargar);
route('POST', '/clients/:client/crm/cargas/:id/reintentar', S.crmReintentar);
route('PUT', '/clients/:client/sdr/whatsapp', S.whatsappGuardar);
route('GET', '/clients/:client/sdr/campanas', S.campanasListar);
route('POST', '/clients/:client/sdr/campanas', S.campanaCrear);
route('GET', '/clients/:client/sdr/campanas/:id', S.campanaVer);
route('PUT', '/clients/:client/sdr/campanas/:id', S.campanaGuardar);
route('POST', '/clients/:client/sdr/campanas/:id/historial/:hid/restaurar', S.campanaRestaurar);
route('POST', '/clients/:client/sdr/campanas/:id/duplicar', S.campanaDuplicar);
route('GET', '/clients/:client/monitor', S.monitorVer);
route('GET', '/clients/:client/no-contactar', S.noContactarListar);
route('POST', '/clients/:client/no-contactar', S.noContactarAgregar);
route('POST', '/clients/:client/no-contactar/quitar', S.noContactarQuitar);
route('POST', '/clients/:client/no-contactar/cargas/previa', S.noContactarCargaPrevia);
route('POST', '/clients/:client/no-contactar/cargas', S.noContactarCargaAplicar);
route('POST', '/clients/:client/sdr/campanas/:id/cargas/previa', S.campanaCargaPrevia);
route('POST', '/clients/:client/sdr/campanas/:id/cargas', S.campanaCargaAplicar);
route('GET', '/clients/:client/sdr/campanas/:id/lista', S.campanaListaVer);
route('GET', '/clients/:client/cargas', S.cargasListar);
route('GET', '/clients/:client/cargas/:id/informe', S.cargaInforme);
route('POST', '/clients/:client/cargas/:id/deshacer', S.cargaDeshacer);
route('GET', '/clients/:client/resumen', S.resumenVer);
route('GET', '/clients/:client/domains', S.dominiosVer);
route('POST', '/clients/:client/domains/check', S.dominiosVerificar);
route('PUT', '/clients/:client/domains/:domain/selectors', S.dominioSelectores);

// ---------------------------------------------------------------- despacho

export async function handleAdminApi(req, res, path, body) {
  // Toda llamada al panel trae esta cabecera: un formulario o una imagen de otro sitio no la
  // puede mandar, y sin CORS un script de otro origen tampoco.
  if (req.headers['x-mailgw-admin'] !== '1') throw forbidden();
  const origin = req.headers.origin;
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch { /* origen ilegible */ }
    if (host !== req.headers.host) throw forbidden();
  }
  const secure = process.env.MAILGW_INSECURE_COOKIES !== '1';
  const sub = path.slice('/admin/api'.length) || '/';
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = r.re.exec(sub);
    if (!m) continue;
    let user = null;
    if (r.auth) {
      user = await sessionUser(tokenFromCookie(req));
      if (!user) throw new GatewayError('unauthorized', 'La sesión venció. Ingresá de nuevo.', 401);
    }
    const params = {};
    for (const [k, v] of Object.entries(m.groups ?? {})) {
      try { params[k] = decodeURIComponent(v); } catch { throw errors.invalid('Ruta mal formada.'); }
    }
    return r.handler({ req, res, body, user, params, secure });
  }
  throw notFound('Ruta inexistente.');
}
