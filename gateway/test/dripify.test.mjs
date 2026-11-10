// LinkedIn por Dripify (etapa 3): carga a la campaña esqueleto con los textos por persona,
// calibración, webhook de la campaña, conversación y respuesta por la API, lectura de
// conversaciones abiertas, freno cruzado mail → LinkedIn, cupo de la API, errores de Dripify y
// aislamiento entre clientes. Contra un Dripify simulado que sigue la especificación de su Open API.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as store from '../src/store.mjs';
import * as sdr from '../src/sdr/store.mjs';
import * as correo from '../src/sdr/correo.mjs';
import * as dripify from '../src/sdr/dripify.mjs';
import { newToken } from '../src/crypto.mjs';
import { startServer } from '../src/server.mjs';
import { gw } from './helpers.mjs';
import { normalizeLinkedin } from '../src/sdr/linkedin.mjs';

const C = 'dripify-c';
const D = 'dripify-d';
const KEY = 'clave-dripify-de-prueba-1234';
const CAMPANA = 77;
let server, api, base, mock;
const tok = {};
const P = {};
const META = { bot: 'prospector', tarea: 'diaria' };

// ---------------------------------------------------------------- Dripify simulado

function dripifyFalso() {
  const s = {
    pedidos: [], campanaEstado: 'ACTIVE', campos: [{ id: 11, name: 'sdr_nota' }, { id: 12, name: 'sdr_mensaje1' }, { id: 13, name: 'sdr_mensaje2' }, { id: 14, name: 'otro' }],
    leads: new Map(), // publicId → lead
    conversaciones: new Map(), // leadId → { id, mensajes: [] } (del más viejo al más nuevo)
    blacklist: new Set(), mensajesEnviados: [], cargas: [], proximoLead: 500,
  };
  const srv = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    const url = new URL(req.url, 'http://x');
    s.pedidos.push({ method: req.method, path: url.pathname, body });
    const json = (status, b, h = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...h }); res.end(b === undefined ? '' : JSON.stringify(b)); };
    const key = req.headers['x-api-key'];
    if (key === 'sin-api-0000000000') return json(403, { status: 403, error: 'Forbidden', message: 'Plan sin Open API' });
    if (key !== KEY) return json(401, { status: 401, error: 'Unauthorized', message: 'Invalid API key' });
    const p = url.pathname.replace('/v1/open-api', '');
    let m;
    if (req.method === 'GET' && p === '/campaigns') {
      return json(200, { items: [{ id: 76, name: 'Otra', status: 'ACTIVE' }, { id: CAMPANA, name: 'SDR esqueleto', status: s.campanaEstado, locked: false }], limit: 100 });
    }
    if (req.method === 'GET' && (m = /^\/campaigns\/(\d+)\/statistics$/.exec(p))) {
      return json(200, { totalLeads: s.leads.size, contactedLeads: 0, acceptanceRate: 0, replyRate: 0 });
    }
    if (req.method === 'GET' && p === '/custom-lead-fields') return json(200, s.campos);
    if (req.method === 'POST' && (m = /^\/campaigns\/(\d+)\/leads$/.exec(p))) {
      if (Number(m[1]) !== CAMPANA) return json(404, { status: 404, error: 'Not Found', message: 'Campaign not found' });
      for (const l of body.leads) {
        const publicId = l.linkedinUrl.split('/in/')[1];
        const id = s.proximoLead++;
        s.leads.set(publicId, { id, publicId, linkedinProfileUrl: `https://www.linkedin.com/in/${publicId}/`, customFields: l.customFields });
      }
      s.cargas.push(body);
      return json(200, { leadList: { id: 900 + s.cargas.length, name: body.name }, acceptedCount: body.leads.length, duplicateCount: 0 });
    }
    if (req.method === 'POST' && p === '/leads/search') {
      const publicId = String(body.linkedinUrl).split('/in/')[1]?.replace(/\/$/, '');
      const l = s.leads.get(publicId);
      return json(200, l ? [{ id: l.id, publicId: l.publicId, linkedinProfileUrl: l.linkedinProfileUrl }] : []);
    }
    if (req.method === 'GET' && (m = /^\/leads\/(\d+)\/conversation$/.exec(p))) {
      const conv = s.conversaciones.get(Number(m[1]));
      if (!conv) return json(404, { status: 404, error: 'Not Found', message: 'No conversation' });
      const ultimo = conv.mensajes.at(-1);
      return json(200, { conversationId: conv.id, unreadCount: 1, lastMessage: { direction: ultimo.direction, createdAt: ultimo.createdAt } });
    }
    if (req.method === 'GET' && (m = /^\/conversations\/([^/]+)\/messages$/.exec(p))) {
      const conv = [...s.conversaciones.values()].find((x) => x.id === decodeURIComponent(m[1]));
      return json(200, { items: [...conv.mensajes].reverse(), limit: 20 });
    }
    if (req.method === 'POST' && (m = /^\/leads\/(\d+)\/messages$/.exec(p))) {
      const conv = s.conversaciones.get(Number(m[1]));
      if (!conv) return json(404, { status: 404, error: 'Not Found', message: 'No conversation with this lead' });
      const eventId = `ev-${s.mensajesEnviados.length + 1}`;
      s.mensajesEnviados.push({ lead: Number(m[1]), message: body.message });
      conv.mensajes.push({ eventId, direction: 'SENDER', message: body.message, createdAt: new Date().toISOString() });
      return json(200, { eventId });
    }
    if ((m = /^\/leads\/(\d+)\/blacklist$/.exec(p))) {
      if (req.method === 'PUT') s.blacklist.add(Number(m[1])); else s.blacklist.delete(Number(m[1]));
      return json(204);
    }
    if (req.method === 'POST' && /^\/leads\/(\d+)\/resume$/.test(p)) return json(204);
    return json(404, { status: 404, error: 'Not Found', message: `sin ruta ${req.method} ${p}` });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ s, srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

// ---------------------------------------------------------------- ayudas

async function token(client, scopes) {
  const { token: t, hash } = newToken();
  await store.createToken(client, `dripify ${scopes.join('+')}`, hash, scopes, null);
  return t;
}
async function call(t, op, body = {}) {
  const r = await api.call(t, op, body);
  return { status: r.status, data: r.body.data, error: r.body.error };
}
const ok = async (t, op, body) => {
  const r = await call(t, op, body);
  assert.equal(r.status, 200, `${op}: ${JSON.stringify(r.error)}`);
  return r.data;
};
const textos = (n) => ({
  nota: `Hola ${n}, vi la búsqueda de QA que publicaron esta semana. ¿Conectamos?`,
  mensaje1: `Gracias por aceptar, ${n}. Trabajamos con equipos de QA tercerizado; ¿te sirve que te cuente cómo?`,
  mensaje2: `${n}, retomo por si quedó perdido: ¿hablamos 15 minutos esta semana?`,
});
const hook = async (ruta, e, cuerpo) => {
  const res = await fetch(`${base}${ruta}${e ? `?e=${e}` : ''}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cuerpo) });
  return { status: res.status, body: await res.json() };
};
const sql = (text, params) => store.asOwner((c) => c.query(text, params));

before(async () => {
  mock = await dripifyFalso();
  process.env.MAILGW_DRIPIFY_URL = mock.url;
  server = await startServer(0);
  base = `http://127.0.0.1:${server.address().port}`;
  api = gw(base);
  await store.upsertClient(C, 'Cliente Dripify C');
  await store.upsertClient(D, 'Cliente Dripify D');
  await sdr.setConfig(C, { calibracion_mails: 1, bots_activos: ['orquestador', 'prospector', 'seguimiento'] });
  await sdr.setConfig(D, { calibracion_mails: 0, bots_activos: ['orquestador', 'prospector'] });
  tok.c = await token(C, ['sdr']);
  tok.d = await token(D, ['sdr']);
  for (const [k, nombre, li] of [['ana', 'Ana', 'ana-qa'], ['beto', 'Beto', 'beto-ti'], ['caro', 'Caro', 'caro-cto'], ['sin', 'Sin LinkedIn', null]]) {
    P[k] = (await ok(tok.c, 'registro_guardar_prospecto', {
      nombre, email: `${k}@empresa.test`, ...(li ? { linkedin_url: `https://ar.linkedin.com/in/${li}/` } : {}), ...META,
    })).prospecto;
  }
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => mock.srv.close(r));
  delete process.env.MAILGW_DRIPIFY_URL;
  await store.closePool();
});

// ---------------------------------------------------------------- pruebas

test('sin configurar, las herramientas lo dicen; configurado, dripify_estado revisa campaña, campos y cupo', async () => {
  const r = await call(tok.c, 'dripify_estado', META);
  assert.equal(r.status, 503);
  assert.equal(r.error.code, 'dripify_sin_configurar');

  await dripify.configurar(C, { api_key: KEY, campana_id: CAMPANA });
  const e = await ok(tok.c, 'dripify_estado', META);
  assert.equal(e.listo, true, JSON.stringify(e.problemas));
  assert.equal(e.campana.nombre, 'SDR esqueleto');
  assert.deepEqual(e.campos, { sdr_nota: 11, sdr_mensaje1: 12, sdr_mensaje2: 13 });
  assert.equal(e.nota_max, 300);
  assert.ok(e.cupo.dia >= 2);
  // La key no vuelve nunca: ni en la base en claro ni en lo que ve el panel.
  const { rows } = await sql(`select api_key_enc from sdr.dripify_cuenta where client_id = $1`, [C]);
  assert.ok(!rows[0].api_key_enc.includes(KEY));
  const v = await store.asOwner((c) => dripify.ver(c, C));
  assert.equal(v.api_key, true);
  assert.ok(!JSON.stringify(v).includes(KEY));

  mock.s.campanaEstado = 'NOT_ACTIVE';
  const inactiva = await ok(tok.c, 'dripify_estado', META);
  assert.equal(inactiva.listo, false);
  assert.match(inactiva.problemas[0], /NOT_ACTIVE/);
  mock.s.campanaEstado = 'ACTIVE';
});

test('dripify_cargar: controles, calibración con el texto aprobado, carga con los campos e idempotencia', async () => {
  // En calibración, sin aprobación no carga; tampoco a quien no tiene LinkedIn.
  const sinAp = await call(tok.c, 'dripify_cargar', {
    prospectos: [{ prospecto_id: P.ana.id, ...textos('Ana') }, { prospecto_id: P.sin.id, ...textos('Sin') }], idempotency_key: 'carga-ana-1', ...META,
  });
  assert.equal(sinAp.status, 422);
  assert.equal(sinAp.error.code, 'dripify_carga_rechazada');
  assert.match(sinAp.error.errores.find((x) => x.prospecto_id === P.ana.id).error, /calibración/);
  assert.match(sinAp.error.errores.find((x) => x.prospecto_id === P.sin.id).error, /no tiene URL de LinkedIn/);
  assert.equal(mock.s.cargas.length, 0);

  // Marcadores sin completar o una nota demasiado larga no pasan.
  const marcas = await call(tok.c, 'dripify_cargar', {
    prospectos: [{ prospecto_id: P.ana.id, ...textos('Ana'), mensaje1: 'Hola {{first_name}}, ¿cómo va?' }], idempotency_key: 'carga-ana-x', ...META,
  });
  assert.match(marcas.error.errores[0].error, /marcadores/);

  // Nadie de la lista de no contactar del cliente entra a la campaña.
  await sql(`insert into sdr.no_contactar (client_id, valor, tipo, motivo) values ($1, 'caro@empresa.test', 'email', 'Cliente actual')`, [C]);
  const nc = await call(tok.c, 'dripify_cargar', { prospectos: [{ prospecto_id: P.caro.id, ...textos('Caro') }], idempotency_key: 'carga-caro-nc', ...META });
  assert.match(nc.error.errores[0].error, /no contactar.*Cliente actual/);
  await sql(`delete from sdr.no_contactar where client_id = $1`, [C]);

  // Aprobación sólo de LinkedIn: no pide buzón ni asunto.
  const ap = (await ok(tok.c, 'registro_pedir_aprobacion', {
    tipo: 'calibracion_mail', prospecto_id: P.ana.id, contenido: { linkedin: textos('Ana') }, ...META,
  })).aprobacion;
  const corregida = { ...textos('Ana'), mensaje2: 'Ana, retomo: ¿te sirve una llamada corta esta semana?' };
  // El operador corrige el mensaje 2 desde el chat del orquestador (la versión corregida queda en decision_contenido).
  await ok(tok.c, 'registro_aprobar', { id: ap.id, decision: 'aprobada', operador: 'Ignacio', linkedin: corregida, bot: 'orquestador' });

  const noCoincide = await call(tok.c, 'dripify_cargar', {
    prospectos: [{ prospecto_id: P.ana.id, ...textos('Ana'), aprobacion_id: ap.id }], idempotency_key: 'carga-ana-2', ...META,
  });
  assert.match(noCoincide.error.errores[0].error, /no coincide con lo aprobado: mensaje2/);

  const r = await ok(tok.c, 'dripify_cargar', {
    prospectos: [{ prospecto_id: P.ana.id, ...corregida, aprobacion_id: ap.id }], idempotency_key: 'carga-ana-3', ...META,
  });
  assert.equal(r.repetida, false);
  assert.equal(r.aceptados, 1);
  assert.equal(mock.s.cargas.length, 1);
  const lead = mock.s.cargas[0].leads[0];
  assert.equal(lead.linkedinUrl, 'https://www.linkedin.com/in/ana-qa');
  assert.deepEqual(lead.customFields, [
    { customLeadFieldId: 11, value: corregida.nota }, { customLeadFieldId: 12, value: corregida.mensaje1 },
    { customLeadFieldId: 13, value: corregida.mensaje2 }]);

  // Registro: evento con los textos, prospecto en contacto por LinkedIn, aprobación gastada.
  const h = await ok(tok.c, 'registro_historia', { prospecto_id: P.ana.id, ...META });
  const ev = h.eventos.find((x) => x.tipo === 'linkedin.cargado');
  assert.equal(ev.datos.mensaje2, corregida.mensaje2);
  assert.equal(h.prospecto.estado, 'en_contacto');
  assert.deepEqual(h.prospecto.canales, ['linkedin']);
  assert.equal(h.prospecto.dripify.estado, 'cargado');
  assert.equal(h.aprobaciones[0].estado, 'usada');

  // La misma clave devuelve lo mismo sin volver a llamar a Dripify; otra clave no la carga dos veces.
  const rep = await ok(tok.c, 'dripify_cargar', {
    prospectos: [{ prospecto_id: P.ana.id, ...corregida, aprobacion_id: ap.id }], idempotency_key: 'carga-ana-3', ...META,
  });
  assert.equal(rep.repetida, true);
  assert.equal(mock.s.cargas.length, 1);
  const otra = await call(tok.c, 'dripify_cargar', { prospectos: [{ prospecto_id: P.ana.id, ...corregida }], idempotency_key: 'carga-ana-4', ...META });
  assert.match(otra.error.errores[0].error, /ya se cargó/);

  // Una aprobación sólo de LinkedIn no habilita un mail.
  await assert.rejects(sdr.controlarEnvio(C, {
    mailbox: 'x@cliente.test', to: ['ana@empresa.test'], subject: 'Hola', text: 'Hola', prospecto_id: P.ana.id,
    aprobacion_id: ap.id, idempotency_key: 'mail-ana-1',
  }, 'send'), /La aprobación está usada|no trae un mail/);
});

test('webhook de la campaña: secreto en la URL, eventos por tipo y la respuesta frena los mails', async () => {
  const { ruta } = await dripify.generarWebhook(C);
  assert.match(ruta, /^\/hook\/dripify\/dripify-c\/[A-Za-z0-9_-]{30,}$/);
  const malo = await hook(`/hook/dripify/${C}/${'x'.repeat(32)}`, 'conexion', {});
  assert.equal(malo.status, 404);

  const cuerpo = { lead: { firstName: 'Ana', linkedinProfileUrl: 'https://www.linkedin.com/in/ana-qa/' }, campaign: { id: CAMPANA } };
  const inv = await hook(ruta, 'invitacion', cuerpo);
  assert.equal(inv.status, 200);
  assert.equal(inv.body.data.atado, true);
  await hook(ruta, 'conexion', cuerpo);
  const desconocido = await hook(ruta, null, { lead: cuerpo.lead });
  assert.equal(desconocido.body.data.tipo, 'desconocido');
  const ajeno = await hook(ruta, 'conexion', { lead: { linkedinProfileUrl: 'https://www.linkedin.com/in/nadie-sabe' } });
  assert.equal(ajeno.body.data.atado, false);

  // La URL de otra persona escrita en el texto de una respuesta no elige a quién se ata el evento.
  assert.deepEqual(dripify.urlsDe({
    lead: { linkedinProfileUrl: 'https://www.linkedin.com/in/ana-qa/' },
    linkedinConversation: [{ text: 'Mejor hablá con https://www.linkedin.com/in/beto-ti' }],
    nota: 'ver linkedin.com/in/caro-cto', perfil: 'Mi perfil: https://www.linkedin.com/in/caro-cto',
  }), [normalizeLinkedin('https://www.linkedin.com/in/ana-qa/')]);
  const sinPerfil = await hook(ruta, 'respuesta', { linkedinConversation: [{ text: 'Hablá con https://www.linkedin.com/in/beto-ti' }] });
  assert.equal(sinPerfil.body.data.atado, false, 'sólo con la URL del texto no se ata a nadie');
  // Con dos personas posibles en el cuerpo, no se adivina.
  const dos = await hook(ruta, 'conexion', { lead: { linkedinProfileUrl: 'https://www.linkedin.com/in/ana-qa/' },
    otro: { profileUrl: 'https://www.linkedin.com/in/beto-ti' } });
  assert.equal(dos.body.data.atado, false);
  const ev = (await sql(`select error from sdr.dripify_evento where id = $1`, [dos.body.data.evento])).rows[0];
  assert.match(ev.error, /más de un prospecto/);

  // La respuesta llega con la conversación: sin ?e= se reconoce igual.
  const resp = await hook(ruta, null, {
    ...cuerpo, linkedinConversation: [{ from: 'Ana', text: 'Hola, sí, contame más. ¿El martes?' }],
  });
  assert.equal(resp.body.data.tipo, 'respuesta');

  const h = await ok(tok.c, 'registro_historia', { prospecto_id: P.ana.id, ...META });
  assert.deepEqual(h.eventos.filter((x) => x.canal === 'linkedin').map((x) => x.tipo),
    ['linkedin.cargado', 'linkedin.invitacion', 'linkedin.conexion', 'respuesta']);
  assert.equal(h.prospecto.estado, 'respondio');
  assert.equal(h.prospecto.proximo_paso, 'seguimiento: leer la respuesta de LinkedIn');

  // Respondió por LinkedIn: no le sale otro mail de la secuencia.
  await assert.rejects(correo.controlarDestinatarios(C, ['ana@empresa.test'], 'send', P.ana.id), /respuesta sin atender|ya respondió/);

  // Queda para seguimiento, y el despertador lo incluye.
  const l = await ok(tok.c, 'linkedin_revisar', { sincronizar: false, bot: 'seguimiento', tarea: 'respuestas' });
  assert.equal(l.total, 1);
  assert.match(l.pendientes[0].texto, /contame más/);
  assert.equal(l.pendientes[0].prospecto.nombre, 'Ana');
  const c = await ok(tok.c, 'correo_revisar', { sincronizar: false, bot: 'seguimiento', tarea: 'respuestas' });
  assert.equal(c.linkedin_sin_atender, 1);

  await correo.configurarDespertador(C, 'seguimiento', { url: 'https://grok.test/webhook/seg', clave: 'clave-routine-1234', dias: [1, 2, 3, 4, 5, 6, 7], hora_desde: 0, hora_hasta: 24, espera_min: 1 });
  let cuerpoAviso;
  const fetchImpl = async (_url, init) => { cuerpoAviso = JSON.parse(init.body); return { ok: true, status: 200 }; };
  const d = await correo.despertar(C, 'seguimiento', { fetchImpl });
  assert.equal(d.despertado, true);
  assert.equal(cuerpoAviso.motivo, 'linkedin');
  assert.equal(cuerpoAviso.linkedin_nuevos, 1);
  assert.match(cuerpoAviso.instruccion, /linkedin_revisar/);
});

test('dripify_conversacion y dripify_responder: lee de Dripify, contesta y a un positivo sólo con aprobación', async () => {
  const leadAna = mock.s.leads.get('ana-qa').id;
  mock.s.conversaciones.set(leadAna, { id: 'conv-ana', mensajes: [
    { eventId: 'm1', direction: 'SENDER', message: 'Gracias por aceptar, Ana.', createdAt: '2026-11-04T12:00:00Z' },
    { eventId: 'm2', direction: 'LEAD', message: 'Hola, sí, contame más. ¿El martes?', createdAt: '2026-11-05T12:00:00Z' },
  ] });
  const conv = await ok(tok.c, 'dripify_conversacion', { prospecto_id: P.ana.id, bot: 'seguimiento', tarea: 'respuestas' });
  assert.equal(conv.lead_id, leadAna);
  assert.deepEqual(conv.mensajes.map((m) => m.de), ['nosotros', 'prospecto']);

  // Al de Beto todavía no lo cargamos: Dripify no lo tiene.
  const beto = await ok(tok.c, 'dripify_conversacion', { prospecto_id: P.beto.id, bot: 'seguimiento', tarea: 'respuestas' });
  assert.equal(beto.en_dripify, false);

  const r = await ok(tok.c, 'dripify_responder', {
    prospecto_id: P.ana.id, texto: 'Buenísimo, Ana. ¿Martes 11 h?', idempotency_key: 'resp-ana-1', bot: 'seguimiento', tarea: 'respuestas',
  });
  assert.equal(r.event_id, 'ev-1');
  const rep = await ok(tok.c, 'dripify_responder', {
    prospecto_id: P.ana.id, texto: 'Buenísimo, Ana. ¿Martes 11 h?', idempotency_key: 'resp-ana-1', bot: 'seguimiento', tarea: 'respuestas',
  });
  assert.equal(rep.repetido, true);
  assert.equal(mock.s.mensajesEnviados.length, 1);

  // Positivo: sin aprobación no sale; con una de LinkedIn y el mismo texto, sí.
  await ok(tok.c, 'registro_evento', { tipo: 'positivo', prospecto_id: P.ana.id, canal: 'linkedin', bot: 'seguimiento', tarea: 'respuestas' });
  const sinAp = await call(tok.c, 'dripify_responder', {
    prospecto_id: P.ana.id, texto: 'Te paso el link de la agenda.', idempotency_key: 'resp-ana-2', bot: 'seguimiento', tarea: 'respuestas',
  });
  assert.equal(sinAp.status, 409);
  assert.equal(sinAp.error.code, 'aprobacion_requerida');
  // Una aprobación de otra cosa no sirve: de otro tipo, para mail, o sin prospecto.
  const texto = 'Te paso el link de la agenda.';
  const aprobada = async (pedido) => {
    const x = (await ok(tok.c, 'registro_pedir_aprobacion', { ...pedido, bot: 'seguimiento' })).aprobacion;
    await ok(tok.c, 'registro_aprobar', { id: x.id, decision: 'aprobada', operador: 'Ignacio', bot: 'orquestador' });
    return x.id;
  };
  const conAp = (id, clave) => call(tok.c, 'dripify_responder', {
    prospecto_id: P.ana.id, texto, aprobacion_id: id, idempotency_key: clave, bot: 'seguimiento', tarea: 'respuestas' });
  const otra = await aprobada({ tipo: 'otro', prospecto_id: P.ana.id, contenido: { canal: 'linkedin', texto } });
  assert.equal((await conAp(otra, 'resp-ana-otra')).error.code, 'aprobacion_requerida');
  const deMail = await aprobada({ tipo: 'respuesta_positivo', prospecto_id: P.ana.id, contenido: { buzon: 'ventas@cliente.test', texto } });
  assert.match((await conAp(deMail, 'resp-ana-mail')).error.message, /el canal/);
  const sinPersona = await call(tok.c, 'registro_pedir_aprobacion', { tipo: 'respuesta_positivo', contenido: { canal: 'linkedin', texto }, bot: 'seguimiento' });
  assert.equal(sinPersona.status, 400, 'una respuesta a un positivo se pide para una persona');
  const deOtro = await aprobada({ tipo: 'respuesta_positivo', prospecto_id: P.beto.id, contenido: { canal: 'linkedin', texto } });
  assert.match((await conAp(deOtro, 'resp-ana-otro')).error.message, /el prospecto/);
  assert.equal(mock.s.mensajesEnviados.length, 1, 'no salió nada');

  const ap = (await ok(tok.c, 'registro_pedir_aprobacion', {
    tipo: 'respuesta_positivo', prospecto_id: P.ana.id, contenido: { canal: 'linkedin', texto: 'Te paso el link de la agenda.' }, bot: 'seguimiento',
  })).aprobacion;
  await ok(tok.c, 'registro_aprobar', { id: ap.id, decision: 'aprobada', operador: 'Ignacio', bot: 'orquestador' });
  const distinto = await call(tok.c, 'dripify_responder', {
    prospecto_id: P.ana.id, texto: 'Otro texto.', aprobacion_id: ap.id, idempotency_key: 'resp-ana-3', bot: 'seguimiento', tarea: 'respuestas',
  });
  assert.equal(distinto.error.code, 'aprobacion_no_coincide');
  await ok(tok.c, 'dripify_responder', {
    prospecto_id: P.ana.id, texto: 'Te paso el link de la agenda.', aprobacion_id: ap.id, idempotency_key: 'resp-ana-4', bot: 'seguimiento', tarea: 'respuestas',
  });
  assert.equal(mock.s.mensajesEnviados.length, 2);
  const h = await ok(tok.c, 'registro_historia', { prospecto_id: P.ana.id, ...META });
  assert.equal(h.eventos.filter((x) => x.tipo === 'linkedin.mensaje').length, 2);
  assert.equal(h.aprobaciones.find((x) => x.id === ap.id).estado, 'usada');
});

test('conversaciones abiertas: el reloj trae las respuestas que el webhook no avisa', async () => {
  const { rows } = await sql(`select id from sdr.linkedin_respuesta where client_id = $1 and estado = 'nuevo'`, [C]);
  await ok(tok.c, 'linkedin_atendido', { ids: rows.map((r) => Number(r.id)), resultado: 'positivo: agenda pedida', bot: 'seguimiento', tarea: 'respuestas' });

  const leadAna = mock.s.leads.get('ana-qa').id;
  mock.s.conversaciones.get(leadAna).mensajes.push(
    { eventId: 'm9', direction: 'LEAD', message: 'Perfecto, el martes a las 11 me sirve.', createdAt: new Date(Date.now() + 60_000).toISOString() });
  await sql(`update sdr.prospecto set dripify = dripify - 'revisado_at' where id = $1`, [P.ana.id]);
  const r = await dripify.revisarConversaciones(C);
  assert.equal(r.find((x) => x.prospecto_id === P.ana.id).nuevos, 1);
  const l = await ok(tok.c, 'linkedin_revisar', { sincronizar: true, bot: 'seguimiento', tarea: 'respuestas' });
  assert.equal(l.total, 1);
  assert.equal(l.pendientes[0].origen, 'api');
  assert.match(l.pendientes[0].texto, /martes a las 11/);
  // Releída enseguida, no se duplica.
  await sql(`update sdr.prospecto set dripify = dripify - 'revisado_at' where id = $1`, [P.ana.id]);
  await dripify.revisarConversaciones(C);
  assert.equal((await ok(tok.c, 'linkedin_revisar', { sincronizar: false, bot: 'seguimiento', tarea: 'respuestas' })).total, 1);
});

test('freno cruzado: si responde por mail o pide la baja, sale de la campaña de LinkedIn', async () => {
  await sdr.setConfig(C, { calibracion_mails: 0 });
  await ok(tok.c, 'dripify_cargar', {
    prospectos: [{ prospecto_id: P.beto.id, ...textos('Beto') }, { prospecto_id: P.caro.id, ...textos('Caro') }], idempotency_key: 'carga-beto-caro', ...META,
  });
  // Respuesta por mail de Beto (como la registra el correo) y baja de Caro.
  await ok(tok.c, 'registro_evento', { tipo: 'respuesta', canal: 'mail', prospecto_id: P.beto.id, bot: 'gateway', tarea: 'correo' });
  await ok(tok.c, 'registro_evento', { tipo: 'baja', canal: 'mail', prospecto_id: P.caro.id, bot: 'gateway', tarea: 'correo' });
  let { rows } = await sql(`select id, dripify from sdr.prospecto where id = any($1)`, [[P.beto.id, P.caro.id]]);
  assert.ok(rows.every((r) => r.dripify.freno?.pendiente === true));

  const f = await dripify.frenarPendientes(C);
  assert.equal(f.filter((x) => x.frenado).length, 2);
  assert.ok(mock.s.blacklist.has(mock.s.leads.get('beto-ti').id));
  assert.ok(mock.s.blacklist.has(mock.s.leads.get('caro-cto').id));
  ({ rows } = await sql(`select id, dripify from sdr.prospecto where id = any($1)`, [[P.beto.id, P.caro.id]]));
  assert.ok(rows.every((r) => r.dripify.estado === 'frenado' && !r.dripify.freno));
  const h = await ok(tok.c, 'registro_historia', { prospecto_id: P.beto.id, ...META });
  assert.equal(h.eventos.at(-1).tipo, 'linkedin.pausado');
  assert.match(h.eventos.at(-1).datos.motivo, /respondió por mail/);
  // No se vuelve a frenar.
  assert.deepEqual(await dripify.frenarPendientes(C), []);

  // Reanudar lo saca de la lista negra.
  await ok(tok.c, 'dripify_reanudar', { prospecto_id: P.beto.id, bot: 'seguimiento', tarea: 'respuestas' });
  assert.ok(!mock.s.blacklist.has(mock.s.leads.get('beto-ti').id));

  // A quien pidió la baja no se lo reanuda, ni aunque su estado se haya cambiado después.
  const conBaja = await call(tok.c, 'dripify_reanudar', { prospecto_id: P.caro.id, bot: 'seguimiento', tarea: 'respuestas' });
  assert.equal(conBaja.status, 409);
  assert.equal(conBaja.error.code, 'prospecto_cerrado');
  await sql(`update sdr.prospecto set estado = 'en_contacto' where id = $1`, [P.caro.id]);
  const igual = await call(tok.c, 'dripify_reanudar', { prospecto_id: P.caro.id, bot: 'seguimiento', tarea: 'respuestas' });
  assert.equal(igual.status, 409);
  assert.match(igual.error.message, /pidió la baja|supresión/);
  assert.ok(mock.s.blacklist.has(mock.s.leads.get('caro-cto').id), 'sigue en la lista negra de Dripify');
  await sql(`update sdr.prospecto set estado = 'baja' where id = $1`, [P.caro.id]);
});

test('errores de Dripify y cupo de la API', async () => {
  await sql(`update sdr.dripify_uso set n_dia = $2, dia = current_date where client_id = $1`, [C, dripify.CUPO.dia]);
  const lim = await call(tok.c, 'dripify_estado', META);
  assert.equal(lim.status, 429);
  assert.equal(lim.error.code, 'dripify_limite');
  await sql(`update sdr.dripify_uso set n_dia = 0 where client_id = $1`, [C]);

  await dripify.configurar(C, { api_key: 'sin-api-0000000000' });
  const sinApi = await call(tok.c, 'dripify_estado', META);
  assert.equal(sinApi.error.code, 'dripify_sin_api');
  await dripify.configurar(C, { api_key: 'otra-clave-equivocada-99' });
  const clave = await call(tok.c, 'dripify_estado', META);
  assert.equal(clave.error.code, 'dripify_clave');
  const v = await store.asOwner((c) => dripify.ver(c, C));
  assert.match(v.ultimo_error, /rechazó la API key/);
  await dripify.configurar(C, { api_key: KEY });
  await ok(tok.c, 'dripify_estado', META);
  assert.equal((await store.asOwner((c) => dripify.ver(c, C))).ultimo_error, null);
});

test('aislamiento: otro cliente no ve ni usa el Dripify ni las respuestas de este', async () => {
  const r = await call(tok.d, 'dripify_estado', META);
  assert.equal(r.error.code, 'dripify_sin_configurar');
  const l = await ok(tok.d, 'linkedin_revisar', { sincronizar: false, bot: 'seguimiento', tarea: 'respuestas' });
  assert.equal(l.total, 0);
  const conv = await call(tok.d, 'dripify_conversacion', { prospecto_id: P.ana.id, bot: 'seguimiento', tarea: 'respuestas' });
  assert.equal(conv.error.code, 'dripify_sin_configurar');
  // Con Dripify propio, el prospecto de C sigue sin existir para D.
  await dripify.configurar(D, { api_key: KEY, campana_id: CAMPANA });
  const conv2 = await call(tok.d, 'dripify_conversacion', { prospecto_id: P.ana.id, bot: 'seguimiento', tarea: 'respuestas' });
  assert.equal(conv2.error.code, 'no_existe');
  const at = await ok(tok.d, 'linkedin_atendido', { ids: [1, 2, 3], resultado: 'intento ajeno', bot: 'seguimiento', tarea: 'respuestas' });
  assert.deepEqual(at.atendidos, []);
  // El webhook de C con el secreto de C no sirve para D.
  const { ruta } = await dripify.generarWebhook(C);
  const secretoC = ruta.split('/').at(-1);
  const res = await hook(`/hook/dripify/${D}/${secretoC}`, 'conexion', {});
  assert.equal(res.status, 404);
});

test('dripify_cargar por campaña: la campaña de Dripify de la campaña, una campaña por carga, y nada si está en pausa', async () => {
  const k = (await sql(
    `insert into sdr.campana (client_id, clave, nombre, tipo, estado, cuentas_por_dia, calibracion_mails, dripify_campana_id)
     values ($1, 'li-dos', 'LinkedIn dos', 'prospeccion', 'activa', 3, 0, 76) returning *`, [C])).rows[0];
  const nuevo = async (n) => (await ok(tok.c, 'registro_guardar_prospecto', {
    nombre: n, email: `${n}@empresa-dos.test`, linkedin_url: `https://www.linkedin.com/in/${n}-qa/`, campana: 'li-dos', ...META })).prospecto;
  const dani = await nuevo('dani');
  const eli = await nuevo('eli');
  assert.equal(dani.campana_id, k.id);

  // No se mezclan campañas en una carga.
  const mezcla = await call(tok.c, 'dripify_cargar', {
    prospectos: [{ prospecto_id: dani.id, ...textos('Dani') }, { prospecto_id: P.sin.id, ...textos('Sin') }], idempotency_key: 'li-dos-mezcla', ...META });
  assert.equal(mezcla.error.code, 'dripify_carga_rechazada');
  assert.match(mezcla.error.message, /distintas campañas/);

  // Va a la campaña de Dripify de la campaña (76), no a la de la cuenta (77).
  const antes = mock.s.pedidos.length;
  const r = await call(tok.c, 'dripify_cargar', { prospectos: [{ prospecto_id: dani.id, ...textos('Dani') }], idempotency_key: 'li-dos-1', ...META });
  assert.ok(mock.s.pedidos.slice(antes).some((x) => x.method === 'POST' && x.path === '/v1/open-api/campaigns/76/leads'), JSON.stringify(r));
  const carga = (await sql(`select campana_id, dripify_campana_id from sdr.dripify_carga where client_id = $1 and clave = 'li-dos-1'`, [C])).rows[0];
  assert.equal(carga.campana_id, k.id);
  assert.equal(Number(carga.dripify_campana_id), 76);

  // En pausa, no se carga a nadie.
  await sql(`update sdr.campana set estado = 'pausada' where id = $1`, [k.id]);
  const pausa = await call(tok.c, 'dripify_cargar', { prospectos: [{ prospecto_id: eli.id, ...textos('Eli') }], idempotency_key: 'li-dos-2', ...META });
  assert.equal(pausa.status, 409);
  assert.equal(pausa.error.code, 'campana_inactiva');
});

test('dripify_estado revisa también la campaña de Dripify propia de cada campaña del SDR', async () => {
  // «LinkedIn dos» (de la prueba anterior) usa la 76, que existe y está activa.
  const bien = await ok(tok.c, 'dripify_estado', META);
  assert.equal(bien.listo, true, JSON.stringify(bien.problemas));
  assert.deepEqual(bien.campanas.find((x) => x.nombre === 'LinkedIn dos'),
    { nombre: 'LinkedIn dos', estado: 'pausada', dripify: 76, dripify_nombre: 'Otra', dripify_estado: 'ACTIVE' });

  // Una campaña con una campaña de Dripify que no existe en la cuenta: «Probar» lo dice antes de cargar.
  const k = (await sql(
    `insert into sdr.campana (client_id, clave, nombre, tipo, estado, cuentas_por_dia, calibracion_mails, dripify_campana_id)
     values ($1, 'li-mal', 'LinkedIn mal', 'prospeccion', 'borrador', 3, 0, 999) returning id`, [C])).rows[0];
  const mal = await ok(tok.c, 'dripify_estado', META);
  assert.equal(mal.listo, false);
  assert.ok(mal.problemas.some((x) => /«LinkedIn mal».*999.*no existe/.test(x)), JSON.stringify(mal.problemas));
  // Terminada, ya no cuenta.
  await sql(`update sdr.campana set estado = 'terminada', terminada_at = now() where id = $1`, [k.id]);
  assert.equal((await ok(tok.c, 'dripify_estado', META)).listo, true);
});
