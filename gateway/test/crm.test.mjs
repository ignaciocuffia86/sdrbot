// Carga en el CRM, capa 1 (docs/23): al aprobarse la respuesta a un positivo, la carga entra a la
// cola en la misma transacción; el worker escribe el mínimo en HubSpot (contacto, empresa, nota y
// tarea) paso a paso, sin duplicar si se corta; reintentos, token rechazado, bloqueos, tope por
// día, la vista previa y las rutas del panel, y el aislamiento entre clientes. Contra un HubSpot
// simulado que sigue la API v3/v4.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as store from '../src/store.mjs';
import * as sdr from '../src/sdr/store.mjs';
import * as crm from '../src/sdr/crm.mjs';
import { createUser } from '../src/admin/auth.mjs';
import { newToken } from '../src/crypto.mjs';
import { startServer } from '../src/server.mjs';
import { gw } from './helpers.mjs';

const C = 'crm-c';
const D = 'crm-d';
const TOKEN = 'pat-na1-token-de-prueba-0001';
const META = { bot: 'seguimiento', tarea: 'respuestas' };
let server, api, base, hs;
const tok = {};
const P = {};

// ---------------------------------------------------------------- HubSpot simulado

function hubspotFalso() {
  const s = {
    token: TOKEN, pedidos: [], contactos: new Map(), empresas: new Map(), notas: [], tareas: [], asociaciones: [],
    proximo: 1000, buscadorAtrasado: false, demora: 0, fallas: [], // [{ ruta: RegExp, status, veces }]
    duenos: [{ id: '101', email: 'vendedor@cliente.test', firstName: 'Vera', lastName: 'Vendedora' }, { id: '202', email: 'otra@cliente.test', firstName: 'Otra' }],
    propiedades: [
      { name: 'email', label: 'Email', type: 'string' }, { name: 'firstname', label: 'Nombre', type: 'string' },
      { name: 'lastname', label: 'Apellido', type: 'string' }, { name: 'jobtitle', label: 'Cargo', type: 'string' },
      { name: 'company', label: 'Empresa', type: 'string' }, { name: 'hubspot_owner_id', label: 'Dueño', type: 'enumeration', options: [] },
      { name: 'origen_lead', label: 'Origen del lead', type: 'enumeration', options: [{ value: 'web', label: 'Web' }, { value: 'sdr_bigua', label: 'SDR Biguá' }] },
      { name: 'segmento', label: 'Segmento', type: 'enumeration', options: [{ value: 'pyme', label: 'Pyme' }, { value: 'corp', label: 'Corporativo' }] },
      { name: 'hs_calculada', label: 'Calculada', type: 'string', calculated: true },
    ],
  };
  const enumeradas = () => new Map(s.propiedades.filter((p) => p.type === 'enumeration' && p.options.length).map((p) => [p.name, p.options.map((o) => o.value)]));
  const validar = (props) => {
    for (const [k, v] of Object.entries(props)) {
      if (!s.propiedades.some((p) => p.name === k)) return `Property "${k}" does not exist`;
      const ops = enumeradas().get(k);
      if (ops && !ops.includes(v)) return `${v} was not one of the allowed options: [${ops.join(', ')}]`;
    }
    return null;
  };
  const srv = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const ch of req) chunks.push(ch);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    s.pedidos.push({ method: req.method, path: p, body });
    if (s.demora) await new Promise((r) => { setTimeout(r, s.demora); });
    if (res.destroyed) return;
    const json = (status, b) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(b === undefined ? '' : JSON.stringify(b)); };
    if (req.headers.authorization !== `Bearer ${s.token}`) {
      return json(401, { status: 'error', category: 'INVALID_AUTHENTICATION', message: 'Authentication credentials not found.' });
    }
    const falla = s.fallas.find((f) => f.veces > 0 && f.ruta.test(`${req.method} ${p}`));
    if (falla) { falla.veces -= 1; return json(falla.status, { status: 'error', message: falla.mensaje ?? `falla simulada ${falla.status}` }); }
    let m;
    if (req.method === 'GET' && p === '/account-info/v3/details') return json(200, { portalId: 4242, timeZone: 'America/Argentina/Buenos_Aires' });
    if (req.method === 'GET' && p === '/crm/v3/owners') return json(200, { results: s.duenos });
    if (req.method === 'GET' && p === '/crm/v3/properties/contacts') return json(200, { results: s.propiedades });
    if (req.method === 'POST' && (m = /^\/crm\/v3\/objects\/(contacts|companies)\/search$/.exec(p))) {
      const f = body.filterGroups[0].filters[0];
      const coleccion = m[1] === 'contacts' ? s.contactos : s.empresas;
      const results = s.buscadorAtrasado && m[1] === 'contacts' ? []
        : [...coleccion.values()].filter((x) => String(x.properties[f.propertyName] ?? '').toLowerCase() === String(f.value).toLowerCase());
      return json(200, { total: results.length, results });
    }
    if (req.method === 'POST' && p === '/crm/v3/objects/contacts') {
      const ya = [...s.contactos.values()].find((x) => x.properties.email === body.properties.email);
      if (ya) return json(409, { status: 'error', category: 'CONFLICT', message: `Contact already exists. Existing ID: ${ya.id}` });
      const err = validar(body.properties);
      if (err) return json(400, { status: 'error', category: 'VALIDATION_ERROR', message: err });
      const c = { id: String(s.proximo++), properties: { ...body.properties } };
      s.contactos.set(c.id, c);
      return json(201, c);
    }
    if ((m = /^\/crm\/v3\/objects\/contacts\/(\d+)$/.exec(p))) {
      const c = s.contactos.get(m[1]);
      if (!c) return json(404, { status: 'error', message: 'Object not found' });
      if (req.method === 'GET') return json(200, c);
      if (req.method === 'PATCH') {
        const err = validar(body.properties);
        if (err) return json(400, { status: 'error', category: 'VALIDATION_ERROR', message: err });
        Object.assign(c.properties, body.properties);
        return json(200, c);
      }
    }
    if (req.method === 'POST' && p === '/crm/v3/objects/companies') {
      const e = { id: String(s.proximo++), properties: { ...body.properties } };
      s.empresas.set(e.id, e);
      return json(201, e);
    }
    if (req.method === 'PUT' && (m = /^\/crm\/v4\/objects\/contact\/(\d+)\/associations\/default\/company\/(\d+)$/.exec(p))) {
      s.asociaciones.push({ contacto: m[1], empresa: m[2] });
      return json(200, { status: 'COMPLETE' });
    }
    if (req.method === 'POST' && (p === '/crm/v3/objects/notes' || p === '/crm/v3/objects/tasks')) {
      const err = p.endsWith('tasks') && body.properties.hubspot_owner_id && !s.duenos.some((o) => o.id === body.properties.hubspot_owner_id)
        ? `Owner ${body.properties.hubspot_owner_id} does not exist` : null;
      if (err) return json(400, { status: 'error', category: 'VALIDATION_ERROR', message: err });
      const x = { id: String(s.proximo++), properties: body.properties, associations: body.associations };
      (p.endsWith('notes') ? s.notas : s.tareas).push(x);
      return json(201, x);
    }
    return json(404, { status: 'error', message: `sin ruta ${req.method} ${p}` });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ s, srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

// ---------------------------------------------------------------- ayudas

async function token(client) {
  const { token: t, hash } = newToken();
  await store.createToken(client, 'crm sdr', hash, ['sdr'], null);
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
const sql = async (text, params) => (await store.asOwner((c) => c.query(text, params))).rows;
const carga = async (prospectoId) => (await sql(`select * from sdr.crm_carga where prospecto_id = $1`, [prospectoId]))[0];
const yaToca = (prospectoId) => sql(`update sdr.crm_carga set proximo_intento = now() where prospecto_id = $1`, [prospectoId]);

// Un positivo completo: cuenta, persona, su respuesta por LinkedIn, el evento positivo y la
// aprobación de la respuesta. Devuelve la aprobación pendiente.
async function positivo(clave, { email = `${clave}@empresa-${clave}.test`, dominio = `empresa-${clave}.test`, nombre = 'Laura Gómez' } = {}) {
  const cuenta = (await ok(tok.c, 'registro_guardar_cuenta', { nombre: `Empresa ${clave}`, dominio, tesis: 'Buscan QA Automation.', ...META })).cuenta;
  const p = (await ok(tok.c, 'registro_guardar_prospecto', { nombre, cargo: 'Gerente de QA', cuenta_id: cuenta.id, ...(email ? { email } : {}), ...META })).prospecto;
  await sql(`insert into sdr.linkedin_respuesta (client_id, prospecto_id, texto, origen) values ($1, $2, $3, 'api')`,
    [C, p.id, 'Hola, sí <nos interesa>. ¿Hablamos el jueves?']);
  await ok(tok.c, 'registro_evento', { tipo: 'positivo', prospecto_id: p.id, canal: 'linkedin', datos: { resumen: 'Pide una reunión el jueves.' }, ...META });
  const ap = (await ok(tok.c, 'registro_pedir_aprobacion', {
    tipo: 'respuesta_positivo', prospecto_id: p.id, contenido: { canal: 'linkedin', texto: 'Gracias, Laura. ¿Te sirve el jueves a las 11?' }, ...META,
  })).aprobacion;
  return { p, cuenta, ap };
}
const aprobar = (ap) => ok(tok.c, 'registro_aprobar', { id: ap.id, decision: 'aprobada', operador: 'Ignacio', bot: 'orquestador' });

// Un navegador mínimo para el panel.
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
async function login(email, role, clientId) {
  const { setupToken } = await createUser({ email, name: email, role, clientId });
  const b = browser();
  const pw = 'clave-del-panel-larga-1';
  assert.equal((await b.call('POST', '/activate', { token: setupToken, password: pw })).status, 200);
  assert.equal((await b.call('POST', '/login', { email, password: pw })).status, 200);
  return b;
}

before(async () => {
  hs = await hubspotFalso();
  process.env.MAILGW_HUBSPOT_URL = hs.url;
  server = await startServer(0);
  base = `http://127.0.0.1:${server.address().port}`;
  api = gw(base);
  await store.upsertClient(C, 'Cliente CRM C');
  await store.upsertClient(D, 'Cliente CRM D');
  await sdr.setConfig(C, { calibracion_mails: 0, bots_activos: ['orquestador', 'prospector', 'seguimiento'] });
  await sdr.setConfig(D, { calibracion_mails: 0, bots_activos: ['orquestador'] });
  tok.c = await token(C);
  tok.d = await token(D);
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => hs.srv.close(r));
  delete process.env.MAILGW_HUBSPOT_URL;
  await store.closePool();
});

// ---------------------------------------------------------------- pruebas

test('sin CRM conectado: aprobar un positivo no encola nada y crm_cargar lo dice', async () => {
  const x = await positivo('sin');
  P.sin = x;
  const r = await aprobar(x.ap);
  assert.equal(r.crm, undefined);
  assert.equal(await carga(x.p.id), undefined);
  const c = await call(tok.c, 'crm_cargar', { prospecto_id: x.p.id, bot: 'orquestador' });
  assert.equal(c.status, 503);
  assert.equal(c.error.code, 'crm_sin_configurar');
});

test('conectar: el token queda cifrado, el origen y el dueño se validan contra el portal, probar los ofrece', async () => {
  await crm.configurar(C, { token: TOKEN });
  const [fila] = await sql(`select token_enc from sdr.crm_conexion where client_id = $1`, [C]);
  assert.ok(!fila.token_enc.includes(TOKEN));
  const v = await store.asOwner((c) => crm.ver(c, C));
  assert.equal(v.token, true);
  assert.ok(!JSON.stringify(v).includes(TOKEN));

  await assert.rejects(crm.configurar(C, { origen_campo: 'origen_lead', origen_valor: 'inventado' }), /no es un valor de «Origen del lead»/);
  await assert.rejects(crm.configurar(C, { origen_campo: 'no_existe', origen_valor: 'x' }), /no tiene la propiedad «no_existe»/);
  await assert.rejects(crm.configurar(C, { dueno_defecto: '999' }), /No hay un dueño con id 999/);
  await assert.rejects(crm.configurar(C, { campos_fijos: { hs_calculada: 'x' } }), /sólo lectura/);
  await assert.rejects(crm.configurar(C, { campos_fijos: { email: 'x' } }), /ya lo completa la carga/);
  // El origen no puede ser una propiedad del mínimo: pisaría el email (o el nombre) del prospecto.
  await assert.rejects(crm.configurar(C, { origen_campo: 'email', origen_valor: 'otro@ejemplo.com' }), /lo completa la carga/);
  // Y aunque una configuración vieja lo tuviera, armar no deja que pise el email.
  const a = crm.armar({ cliente: 'X', p: { id: 'p', nombre: 'Ana', email: 'ana@x.test' }, cuenta: null },
    { origen_campo: 'email', origen_valor: 'otro@ejemplo.com', campos_fijos: { firstname: 'Pisado', segmento: 'pyme' } });
  assert.equal(a.contacto.email, 'ana@x.test');
  assert.equal(a.contacto.firstname, 'Ana');
  assert.equal(a.contacto.segmento, 'pyme');
  // Un campo fijo (sólo Biguá) gana sobre el origen (lo puede elegir el cliente), aunque una
  // configuración guardada los hiciera chocar.
  const b = crm.armar({ cliente: 'X', p: { id: 'p', nombre: 'Ana', email: 'ana@x.test' }, cuenta: null },
    { origen_campo: 'segmento', origen_valor: 'corp', campos_fijos: { segmento: 'pyme' } });
  assert.equal(b.contacto.segmento, 'pyme');
  const ok1 = await crm.configurar(C, { origen_campo: 'origen_lead', origen_valor: 'sdr_bigua', dueno_defecto: '101' });
  assert.equal(ok1.portal_id, '4242');

  const pr = await crm.probar(C);
  assert.equal(pr.listo, true, JSON.stringify(pr.problemas));
  assert.deepEqual(pr.duenos.map((o) => o.id), ['101', '202']);
  assert.ok(pr.propiedades.some((p) => p.name === 'origen_lead' && p.options.length === 2));
  assert.ok(!pr.propiedades.some((p) => p.name === 'hs_calculada'));

  // Si la app no puede leer los datos de la cuenta, sólo falta el número de portal: no es un error.
  hs.s.fallas.push({ ruta: /^GET \/account-info\/v3\/details$/, status: 403, veces: 1 });
  const sinPortal = await crm.probar(C);
  assert.equal(sinPortal.listo, true, JSON.stringify(sinPortal.problemas));
  const [cx] = await sql(`select estado from sdr.crm_conexion where client_id = $1`, [C]);
  assert.equal(cx.estado, 'activa');
  // Un permiso que sí hace falta (los dueños) frena la prueba y marca la conexión.
  hs.s.fallas.push({ ruta: /^GET \/crm\/v3\/owners$/, status: 403, veces: 1, mensaje: 'This app hasn\'t been granted all required scopes' });
  const sinDuenos = await crm.probar(C);
  assert.equal(sinDuenos.listo, false);
  assert.match(sinDuenos.problemas[0], /le falta un permiso/);
  await crm.configurar(C, { estado: 'activa' });
});

test('positivo aprobado: entra a la cola al aprobar y el worker carga contacto, empresa, nota y tarea', async () => {
  const x = await positivo('uno', { nombre: 'Laura Gómez Paz' });
  P.uno = x;
  const r = await aprobar(x.ap);
  assert.equal(r.crm.estado, 'pendiente');
  assert.match(r.aviso, /entra solo al CRM/);
  const antes = await carga(x.p.id);
  assert.equal(antes.motivo, 'positivo');
  assert.equal(antes.aprobacion_id, x.ap.id);

  const vuelta = await crm.procesarCola();
  assert.deepEqual(vuelta.map((v) => [v.carga, v.estado]), [[Number(antes.id), 'hecha']]);

  const contacto = [...hs.s.contactos.values()].find((c) => c.properties.email === 'uno@empresa-uno.test');
  assert.deepEqual(contacto.properties, {
    email: 'uno@empresa-uno.test', firstname: 'Laura', lastname: 'Gómez Paz', jobtitle: 'Gerente de QA',
    company: 'Empresa uno', origen_lead: 'sdr_bigua', hubspot_owner_id: '101',
  });
  const empresa = [...hs.s.empresas.values()].find((e) => e.properties.domain === 'empresa-uno.test');
  assert.equal(empresa.properties.name, 'Empresa uno');
  assert.deepEqual(hs.s.asociaciones.at(-1), { contacto: contacto.id, empresa: empresa.id });

  const nota = hs.s.notas.at(-1);
  assert.match(nota.properties.hs_note_body, /Pide una reunión el jueves/);
  assert.match(nota.properties.hs_note_body, /sí &lt;nos interesa&gt;/, 'el texto del prospecto va escapado');
  assert.match(nota.properties.hs_note_body, /Te sirve el jueves a las 11/);
  assert.match(nota.properties.hs_note_body, new RegExp(x.p.id));
  assert.deepEqual(nota.associations.map((a) => [a.to.id, a.types[0].associationTypeId]), [[contacto.id, 202], [empresa.id, 190]]);
  const tarea = hs.s.tareas.at(-1);
  assert.equal(tarea.properties.hubspot_owner_id, '101');
  assert.match(tarea.properties.hs_task_subject, /Responder a Laura Gómez Paz \(Empresa uno\)/);
  assert.equal(tarea.properties.hs_task_status, 'NOT_STARTED');
  // El cuerpo de la tarea es HTML en HubSpot: lo que escribió el prospecto va escapado.
  assert.match(tarea.properties.hs_task_body, /sí &lt;nos interesa&gt;/);
  assert.ok(!tarea.properties.hs_task_body.includes('<nos interesa>'));

  const despues = await carga(x.p.id);
  assert.equal(despues.estado, 'hecha');
  assert.deepEqual(Object.keys(despues.crm_ids).sort(), ['contacto', 'contacto_nuevo', 'dueno', 'empresa', 'nota', 'tarea']);
  assert.deepEqual(despues.cambios.map((c) => `${c.objeto}:${c.accion}`), ['contacto:creado', 'empresa:creada', 'nota:creada', 'tarea:creada']);
  const [p] = await sql(`select estado, crm_id from sdr.prospecto where id = $1`, [x.p.id]);
  assert.deepEqual(p, { estado: 'en_crm', crm_id: contacto.id });
  const [ev] = await sql(`select datos, ref, bot, interno from sdr.evento where prospecto_id = $1 and tipo = 'crm.cargado'`, [x.p.id]);
  assert.equal(ev.ref, contacto.id);
  assert.equal(ev.datos.capa, 1);
  assert.equal(ev.datos.url, `https://app.hubspot.com/contacts/4242/record/0-1/${contacto.id}`);
  assert.equal(ev.bot, 'gateway');
  assert.equal(ev.interno, false);

  // No se repite: ni otra vuelta ni un pedido a mano.
  const n = hs.s.pedidos.length;
  assert.deepEqual(await crm.procesarCola(), []);
  const otra = await ok(tok.c, 'crm_cargar', { prospecto_id: x.p.id, bot: 'orquestador' });
  assert.match(otra.aviso, /Ya está cargado/);
  assert.equal(hs.s.pedidos.length, n);
});

test('contacto que ya existía: sólo completa lo vacío, no cambia el dueño y la tarea va al suyo', async () => {
  hs.s.contactos.set('77', { id: '77', properties: { email: 'dos@empresa-dos.test', jobtitle: 'Directora', hubspot_owner_id: '202', firstname: '' } });
  const empresa = { id: '78', properties: { name: 'Empresa Dos SA', domain: 'empresa-dos.test' } };
  hs.s.empresas.set('78', empresa);
  const x = await positivo('dos');
  await aprobar(x.ap);
  await crm.procesarCola();
  const c = hs.s.contactos.get('77');
  assert.equal(c.properties.jobtitle, 'Directora', 'no pisa un dato del cliente');
  assert.equal(c.properties.hubspot_owner_id, '202', 'no cambia el dueño');
  assert.equal(c.properties.firstname, 'Laura');
  assert.equal(c.properties.origen_lead, 'sdr_bigua');
  assert.equal([...hs.s.contactos.values()].filter((k) => k.properties.email === 'dos@empresa-dos.test').length, 1);
  assert.equal([...hs.s.empresas.values()].filter((e) => e.properties.domain === 'empresa-dos.test').length, 1, 'usa la empresa que había');
  assert.equal(hs.s.tareas.at(-1).properties.hubspot_owner_id, '202');
  const k = await carga(x.p.id);
  assert.equal(k.estado, 'hecha');
  assert.equal(k.crm_ids.contacto_nuevo, false);
  assert.deepEqual(k.cambios[0].antes, { firstname: '', lastname: null, company: null, origen_lead: null });
  assert.equal(k.cambios[1].accion, 'asociada');
});

test('el buscador de HubSpot atrasado: el alta da 409 y se usa el contacto que ya está, sin duplicar', async () => {
  hs.s.contactos.set('88', { id: '88', properties: { email: 'tres@empresa-tres.test' } });
  hs.s.buscadorAtrasado = true;
  const x = await positivo('tres');
  await aprobar(x.ap);
  await crm.procesarCola();
  hs.s.buscadorAtrasado = false;
  const k = await carga(x.p.id);
  assert.equal(k.estado, 'hecha', k.error);
  assert.equal(k.crm_ids.contacto, '88');
  assert.equal([...hs.s.contactos.values()].filter((c) => c.properties.email === 'tres@empresa-tres.test').length, 1);
});

test('se corta a mitad: reintenta con espera y sigue desde el paso que faltaba, sin duplicar', async () => {
  const x = await positivo('cuatro');
  await aprobar(x.ap);
  hs.s.fallas.push({ ruta: /^POST \/crm\/v3\/objects\/notes$/, status: 503, veces: 1 });
  const [v] = await crm.procesarCola();
  assert.equal(v.estado, 'pendiente');
  let k = await carga(x.p.id);
  assert.equal(k.intentos, 1);
  assert.ok(k.crm_ids.contacto && k.crm_ids.empresa && !k.crm_ids.nota);
  assert.match(k.error, /HTTP 503/);
  const espera = (new Date(k.proximo_intento) - Date.now()) / 60000;
  assert.ok(espera > 0.5 && espera <= 1.01, `espera ${espera}`);
  assert.deepEqual(await crm.procesarCola(), [], 'antes de la espera no se toma');

  await yaToca(x.p.id);
  await crm.procesarCola();
  k = await carga(x.p.id);
  assert.equal(k.estado, 'hecha');
  assert.equal(k.intentos, 2);
  assert.equal([...hs.s.contactos.values()].filter((c) => c.properties.email === 'cuatro@empresa-cuatro.test').length, 1);
  assert.equal(hs.s.notas.filter((n) => n.associations[0].to.id === k.crm_ids.contacto).length, 1);
});

test('token rechazado: pausa la conexión sin gastar intentos; al reconectar sigue sola', async () => {
  const x = await positivo('cinco');
  await aprobar(x.ap);
  hs.s.token = 'pat-otro-token-0000000000';
  await crm.procesarCola();
  let k = await carga(x.p.id);
  assert.equal(k.estado, 'pendiente');
  assert.equal(k.intentos, 0);
  let [cx] = await sql(`select estado, ultimo_error from sdr.crm_conexion where client_id = $1`, [C]);
  assert.equal(cx.estado, 'credencial_vencida');
  assert.match(cx.ultimo_error, /rechazó el token/);
  assert.deepEqual(await crm.procesarCola(), [], 'con la conexión caída no toma nada');
  const resumen = await crm.estado(C);
  assert.equal(resumen.estado, 'credencial_vencida');
  assert.equal(resumen.en_cola, 1);

  await crm.configurar(C, { token: hs.s.token });
  [cx] = await sql(`select estado from sdr.crm_conexion where client_id = $1`, [C]);
  assert.equal(cx.estado, 'activa');
  await crm.procesarCola();
  k = await carga(x.p.id);
  assert.equal(k.estado, 'hecha');
});

test('un dato que HubSpot no acepta bloquea la carga y le avisa al orquestador; se reintenta a mano', async () => {
  const x = await positivo('seis');
  await aprobar(x.ap);
  hs.s.fallas.push({ ruta: /^POST \/crm\/v3\/objects\/tasks$/, status: 400, veces: 1, mensaje: 'Property values were not valid' });
  await crm.procesarCola();
  let k = await carga(x.p.id);
  assert.equal(k.estado, 'bloqueada');
  assert.match(k.error, /HubSpot rechazó el dato \(HTTP 400\): Property values were not valid/);
  const pend = await ok(tok.c, 'registro_pendientes', { bot: 'orquestador' });
  assert.ok(pend.pedidos.some((p) => p.prospecto_id === x.p.id && /quedó bloqueada/.test(p.que)));
  assert.deepEqual(await crm.procesarCola(), []);

  await crm.reintentar(C, Number(k.id), 'operador@bigua.test');
  await crm.procesarCola();
  k = await carga(x.p.id);
  assert.equal(k.estado, 'hecha');
  assert.equal(hs.s.notas.filter((n) => n.associations[0].to.id === k.crm_ids.contacto).length, 1, 'la nota no se repite');
});

test('sin email se bloquea sin tocar HubSpot; después de todos los reintentos queda en error', async () => {
  const sin = await positivo('siete', { email: null });
  await aprobar(sin.ap);
  const n = hs.s.pedidos.length;
  await crm.procesarCola();
  const k = await carga(sin.p.id);
  assert.equal(k.estado, 'bloqueada');
  assert.match(k.error, /no tiene email/);
  assert.equal(hs.s.pedidos.length, n);

  const x = await positivo('ocho');
  await aprobar(x.ap);
  hs.s.fallas.push({ ruta: /^POST \/crm\/v3\/objects\/contacts\/search$/, status: 502, veces: 100 });
  for (let i = 0; i <= crm.ESPERAS_MIN.length; i++) {
    await yaToca(x.p.id);
    await crm.procesarCola();
  }
  hs.s.fallas.length = 0;
  const e = await carga(x.p.id);
  assert.equal(e.estado, 'error');
  assert.equal(e.intentos, crm.ESPERAS_MIN.length + 1);
  const r = await ok(tok.c, 'crm_cargas', { estado: 'error', bot: 'orquestador' });
  assert.deepEqual(r.cargas.map((c) => c.prospecto_id), [x.p.id]);
  // crm_cargar sobre una carga en error la vuelve a la cola.
  const otra = await ok(tok.c, 'crm_cargar', { prospecto_id: x.p.id, bot: 'orquestador' });
  assert.equal(otra.carga.estado, 'pendiente');
  await crm.procesarCola();
  assert.equal((await carga(x.p.id)).estado, 'hecha');
});

test('HubSpot lento: la vuelta respeta su tiempo, la carga sigue en la próxima sin gastar intento ni duplicar', async () => {
  const x = await positivo('lenta');
  await aprobar(x.ap);
  hs.s.demora = 2_500;
  const inicio = Date.now();
  const [v] = await crm.procesarCola({ hasta: inicio + 4_500 });
  const tardo = Date.now() - inicio;
  hs.s.demora = 0;
  assert.ok(tardo < 5_000, `la vuelta tardó ${tardo} ms`);
  assert.equal(v.estado, 'pendiente');
  let k = await carga(x.p.id);
  assert.equal(k.intentos, 0);
  assert.match(k.error, /tiempo de esta vuelta/);
  assert.deepEqual(await crm.procesarCola({ hasta: Date.now() + 2_000 }), [], 'con menos de 3 segundos no empieza otra');
  await crm.procesarCola();
  k = await carga(x.p.id);
  assert.equal(k.estado, 'hecha', k.error);
  assert.equal([...hs.s.contactos.values()].filter((c) => c.properties.email === 'lenta@empresa-lenta.test').length, 1);
});

test('tope por día: lo que pasa del tope espera sin gastar intentos', async () => {
  await sql(`update sdr.crm_conexion set tope_dia = 1 where client_id = $1`, [C]);
  const x = await positivo('nueve');
  await aprobar(x.ap);
  const [v] = await crm.procesarCola();
  assert.equal(v.estado, 'pendiente');
  const k = await carga(x.p.id);
  assert.equal(k.intentos, 0);
  assert.match(k.error, /tope de 1 cargas por día/);
  assert.ok(new Date(k.proximo_intento) > new Date(Date.now() + 50 * 60000));
  await sql(`update sdr.crm_conexion set tope_dia = 50 where client_id = $1`, [C]);
  await yaToca(x.p.id);
  await crm.procesarCola();
  assert.equal((await carga(x.p.id)).estado, 'hecha');
});

test('la vista previa arma lo mismo que se escribe, sin pedirle nada a HubSpot', async () => {
  const n = hs.s.pedidos.length;
  const v = await crm.vistaPrevia(C, P.uno.p.id);
  assert.equal(hs.s.pedidos.length, n);
  assert.equal(v.ejemplo, false);
  assert.equal(v.buscar_por, 'uno@empresa-uno.test');
  assert.deepEqual(v.contacto, { email: 'uno@empresa-uno.test', firstname: 'Laura', lastname: 'Gómez Paz', jobtitle: 'Gerente de QA',
    company: 'Empresa uno', origen_lead: 'sdr_bigua' });
  assert.deepEqual(v.empresa, { name: 'Empresa uno', domain: 'empresa-uno.test' });
  assert.match(v.nota.hs_note_body, /Pide una reunión/);
  // Un viernes vence el lunes.
  assert.equal(crm.vencimientoTarea(new Date('2026-11-13T15:00:00Z')).toISOString(), '2026-11-16T12:00:00.000Z');
});

test('panel: Biguá y el cliente conectan, ven las cargas y cargan a mano; el cliente no toca el tope', async () => {
  const bigua = await login('crm-op@bigua.test', 'bigua_admin');
  const cli = await login('admin@crm-c.test', 'client_admin', C);
  const otro = await login('admin@crm-d.test', 'client_admin', D);

  const g = await cli.call('GET', `/clients/${C}/crm`);
  assert.equal(g.status, 200);
  assert.equal(g.body.data.conexion.token, true);
  assert.ok(!JSON.stringify(g.body.data).includes(hs.s.token));
  assert.ok(g.body.data.cargas.some((k) => k.estado === 'hecha' && k.url?.startsWith('https://app.hubspot.com/contacts/4242/')));
  assert.ok(g.body.data.positivos_sin_cargar.some((p) => p.id === P.sin.p.id), 'el positivo de antes de conectar aparece');

  assert.equal((await cli.call('PUT', `/clients/${C}/crm`, { tope_dia: 900 })).status, 403);
  // El cliente no puede pisar un campo fijo de Biguá eligiéndolo como origen.
  assert.equal((await bigua.call('PUT', `/clients/${C}/crm`, { campos_fijos: { segmento: 'pyme' } })).status, 200);
  const choque = await cli.call('PUT', `/clients/${C}/crm`, { origen_campo: 'segmento', origen_valor: 'corp' });
  assert.equal(choque.status, 400);
  assert.match(choque.body.error.message, /campo fijo que carga Biguá/);
  const [fijo] = await sql(`select origen_campo, campos_fijos from sdr.crm_conexion where client_id = $1`, [C]);
  assert.equal(fijo.origen_campo, 'origen_lead');
  assert.deepEqual(fijo.campos_fijos, { segmento: 'pyme' });
  assert.equal((await bigua.call('PUT', `/clients/${C}/crm`, { campos_fijos: {} })).status, 200);
  assert.equal((await cli.call('PUT', `/clients/${C}/crm`, { origen_valor: 'x', origen_campo: 'origen_lead' })).status, 400);
  const pausa = await cli.call('PUT', `/clients/${C}/crm`, { estado: 'pausada' });
  assert.equal(pausa.body.data.conexion.estado, 'pausada');
  assert.equal((await bigua.call('PUT', `/clients/${C}/crm`, { estado: 'activa', tope_dia: 40 })).body.data.conexion.tope_dia, 40);

  const pr = await cli.call('POST', `/clients/${C}/crm/probar`);
  assert.equal(pr.body.data.prueba.listo, true);
  const vp = await cli.call('POST', `/clients/${C}/crm/vista-previa`, {});
  assert.equal(vp.status, 200);
  assert.ok(vp.body.data.vista.contacto.email);

  const cargar = await cli.call('POST', `/clients/${C}/crm/cargar`, { prospecto_id: P.sin.p.id });
  assert.equal(cargar.status, 200, JSON.stringify(cargar.body));
  assert.equal(cargar.body.data.carga.motivo, 'pedido');
  assert.equal(cargar.body.data.carga.pedida_por, 'admin@crm-c.test');
  await crm.procesarCola();
  assert.equal((await carga(P.sin.p.id)).estado, 'hecha');

  const res = await cli.call('GET', `/clients/${C}/resumen`);
  assert.equal(res.body.data.crm.estado, 'activa');
  assert.ok(res.body.data.crm.semana >= 1);

  // Otro cliente no ve nada de este.
  for (const [m, p, b] of [['GET', `/clients/${C}/crm`], ['POST', `/clients/${C}/crm/probar`], ['POST', `/clients/${C}/crm/cargar`, { prospecto_id: P.sin.p.id }]]) {
    assert.equal((await otro.call(m, p, b)).status, 404, `${m} ${p}`);
  }
  const act = await bigua.call('GET', `/clients/${C}/activity`);
  assert.ok(act.body.data.activity.some((a) => a.op === 'admin.sdr.crm.cargar'));
});

test('aislamiento: otro cliente no ve ni encola las cargas de este, tampoco desde la base', async () => {
  const r = await call(tok.d, 'crm_cargar', { prospecto_id: P.uno.p.id, bot: 'orquestador' });
  assert.equal(r.status, 503, 'D no tiene CRM');
  await crm.configurar(D, { token: TOKEN });
  const r2 = await call(tok.d, 'crm_cargar', { prospecto_id: P.uno.p.id, bot: 'orquestador' });
  assert.equal(r2.status, 404);
  const lista = await ok(tok.d, 'crm_cargas', { bot: 'orquestador' });
  assert.deepEqual(lista.cargas, []);
  const filas = await store.asRole('mailgw_app', D, (c) => c.query(`select count(*)::int as n from sdr.crm_carga where client_id = $1`, [C]));
  assert.equal(filas.rows[0].n, 0);
  const cx = await store.asRole('mailgw_app', D, (c) => c.query(`select count(*)::int as n from sdr.crm_conexion where client_id = $1`, [C]));
  assert.equal(cx.rows[0].n, 0);
  await assert.rejects(store.asRole('mailgw_app', D, (c) => c.query(
    `insert into sdr.crm_carga (client_id, prospecto_id, motivo) values ($1, $2, 'pedido')`, [C, P.uno.p.id])), /row-level security|violates/);
  // La aplicación no puede cambiarse el token ni el tope: eso es del panel.
  await assert.rejects(store.asRole('mailgw_app', C, (c) => c.query(`update sdr.crm_conexion set token_enc = 'x' where client_id = $1`, [C])), /permission denied/);
});
