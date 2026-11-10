// WhatsApp de seguimiento (docs/22): el gateway da el turno de cada mensaje y hace cumplir horario,
// pausa entre envíos, topes, contactos tibios, nada repetido, aprobación del primer mensaje y la
// pausa ante un bloqueo. El bot manda por WhatsApp Web; acá se prueba lo que hace el gateway.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as store from '../src/store.mjs';
import * as sdr from '../src/sdr/store.mjs';
import * as whatsapp from '../src/sdr/whatsapp.mjs';
import * as monitor from '../src/sdr/monitor.mjs';
import { newToken } from '../src/crypto.mjs';
import { startServer } from '../src/server.mjs';
import { gw } from './helpers.mjs';

const W = 'whatsapp-w';
const X = 'whatsapp-x';
const TZ = 'America/Argentina/Buenos_Aires';
const META = { bot: 'whatsapp', tarea: 'pasada' };
let server, api;
const tok = {};
const P = {};

async function token(client) {
  const { token: t, hash } = newToken();
  await store.createToken(client, 'whatsapp sdr', hash, ['sdr'], null);
  return t;
}
const call = async (t, op, body = {}) => {
  const r = await api.call(t, op, { ...META, ...body });
  return { status: r.status, data: r.body.data, error: r.body.error };
};
const ok = async (t, op, body) => {
  const r = await call(t, op, body);
  assert.equal(r.status, 200, `${op}: ${JSON.stringify(r.error)}`);
  return r.data;
};
const sql = (text, params) => store.asOwner((c) => c.query(text, params));
// Las pruebas no esperan la pausa entre envíos: adelantan el turno.
const adelantar = (id) => sql(`update sdr.whatsapp_envio set enviar_desde = now() where id = $1`, [id]);
const libre = () => sql(`update sdr.whatsapp_config set proximo_turno_at = null where client_id = $1`, [W]);

before(async () => {
  server = await startServer(0);
  api = gw(`http://127.0.0.1:${server.address().port}`);
  await store.upsertClient(W, 'Cliente WhatsApp W');
  await store.upsertClient(X, 'Cliente WhatsApp X');
  await sdr.setConfig(W, { calibracion_mails: 0, bots_activos: ['orquestador', 'seguimiento', 'whatsapp'], zona_horaria: TZ });
  await sdr.setConfig(X, { calibracion_mails: 0, bots_activos: ['orquestador', 'whatsapp'] });
  tok.w = await token(W);
  tok.x = await token(X);
  for (const [k, nombre, wa] of [['frio', 'Fría', '+54 9 11 4000 0001'], ['tibio', 'Tibio', '+54 9 11 4000 0002'],
    ['otro', 'Otro', '+54 9 11 4000 0003'], ['sin', 'Sin número', null]]) {
    P[k] = (await ok(tok.w, 'registro_guardar_prospecto', { nombre, email: `${k}@empresa-w.test`, ...(wa ? { whatsapp: wa } : {}) })).prospecto;
  }
  for (const k of ['tibio', 'otro']) {
    await ok(tok.w, 'registro_evento', { tipo: 'respuesta', canal: 'mail', prospecto_id: P[k].id, datos: { texto: 'Escribime por WhatsApp' } });
  }
});

after(async () => {
  await new Promise((r) => server.close(r));
  await store.closePool();
});

test('horario y ritual: cálculos puros', () => {
  const cfg = { hora_desde: 8, hora_hasta: 24, dias: [1, 2, 3, 4, 5] };
  // Lunes 3/11/2026 a las 10:00 y a las 7:59 de Buenos Aires (UTC−3), y un sábado.
  assert.equal(whatsapp.enVentana(cfg, TZ, new Date('2026-11-02T13:00:00Z')), true);
  assert.equal(whatsapp.enVentana(cfg, TZ, new Date('2026-11-02T10:59:00Z')), false);
  assert.equal(whatsapp.enVentana(cfg, TZ, new Date('2026-11-07T15:00:00Z')), false);
  assert.equal(whatsapp.enVentana({ ...cfg, dias: [6] }, TZ, new Date('2026-11-07T15:00:00Z')), true);
  assert.equal(whatsapp.escribiendoSeg('hola', () => 0), 1);
  assert.equal(whatsapp.escribiendoSeg('x'.repeat(2000), () => 1), 8);
  assert.equal(whatsapp.escribiendoSeg('x'.repeat(120), () => 0.5), 5);
});

test('sin activar no hay turno; el bot no puede registrar un WhatsApp por su cuenta', async () => {
  const r = await call(tok.w, 'whatsapp_turno', { prospecto_id: P.tibio.id, texto: 'Hola', idempotency_key: 'tibio:whatsapp-0' });
  assert.equal(r.status, 503);
  assert.equal(r.error.code, 'whatsapp_sin_configurar');
  const ev = await call(tok.w, 'registro_evento', { tipo: 'whatsapp.enviado', canal: 'whatsapp', prospecto_id: P.tibio.id });
  assert.equal(ev.status, 400);
  assert.match(ev.error.message, /whatsapp_turno/);
  assert.equal((await ok(tok.w, 'whatsapp_estado')).activo, false);
});

test('turno: contactos tibios, primer mensaje aprobado, pausa entre envíos, idempotencia y registro', async () => {
  await whatsapp.configurar(W, { activo: true, hora_desde: 0, hora_hasta: 24, pausa_min_seg: 20, pausa_max_seg: 60 });

  const frio = await call(tok.w, 'whatsapp_turno', { prospecto_id: P.frio.id, texto: 'Hola', idempotency_key: 'frio:whatsapp-1' });
  assert.equal(frio.error.code, 'whatsapp_contacto_frio');
  const sin = await call(tok.w, 'whatsapp_turno', { prospecto_id: P.sin.id, texto: 'Hola', idempotency_key: 'sin:whatsapp-1' });
  assert.equal(sin.error.code, 'whatsapp_sin_numero');

  const texto = 'Hola Tibio, te escribo por acá como pediste. ¿Te sirve el jueves a las 11?';
  const sinAp = await call(tok.w, 'whatsapp_turno', { prospecto_id: P.tibio.id, texto, idempotency_key: 'tibio:whatsapp-1' });
  assert.equal(sinAp.error.code, 'aprobacion_requerida');
  assert.match(sinAp.error.message, /whatsapp_primero/);

  const malCanal = await call(tok.w, 'registro_pedir_aprobacion', { tipo: 'whatsapp_primero', prospecto_id: P.tibio.id, contenido: { texto } });
  assert.equal(malCanal.status, 400);
  const ap = (await ok(tok.w, 'registro_pedir_aprobacion', {
    tipo: 'whatsapp_primero', prospecto_id: P.tibio.id, contenido: { canal: 'whatsapp', texto, contexto: 'Pidió seguir por WhatsApp' }, bot: 'seguimiento',
  })).aprobacion;
  const pendiente = await call(tok.w, 'whatsapp_turno', { prospecto_id: P.tibio.id, texto, aprobacion_id: ap.id, idempotency_key: 'tibio:whatsapp-1' });
  assert.equal(pendiente.error.code, 'aprobacion_requerida');
  await ok(tok.w, 'registro_aprobar', { id: ap.id, decision: 'aprobada', operador: 'Ignacio', bot: 'orquestador' });
  const otroTexto = await call(tok.w, 'whatsapp_turno', { prospecto_id: P.tibio.id, texto: 'Otra cosa', aprobacion_id: ap.id, idempotency_key: 'tibio:whatsapp-1' });
  assert.equal(otroTexto.error.code, 'aprobacion_no_coincide');

  const t1 = await ok(tok.w, 'whatsapp_turno', { prospecto_id: P.tibio.id, texto, aprobacion_id: ap.id, idempotency_key: 'tibio:whatsapp-1' });
  assert.equal(t1.repetido, false);
  assert.equal(t1.primero, true);
  assert.equal(t1.numero, '+5491140000002', 'el número como lo guarda el registro');
  assert.equal(t1.espera_segundos, 0, 'el primero del día sale ya');
  assert.ok(t1.ritual.escribiendo_seg >= 1 && t1.ritual.escribiendo_seg <= 8);
  const rep = await ok(tok.w, 'whatsapp_turno', { prospecto_id: P.tibio.id, texto, aprobacion_id: ap.id, idempotency_key: 'tibio:whatsapp-1' });
  assert.equal(rep.repetido, true);
  assert.equal(rep.envio_id, t1.envio_id);

  // El siguiente, a otra persona, espera entre 20 y 60 segundos: la pausa es del cliente, no del chat.
  const t2 = await ok(tok.w, 'whatsapp_turno', {
    prospecto_id: P.otro.id, texto: 'Hola Otro, sigo por acá.', idempotency_key: 'otro:whatsapp-1',
    aprobacion_id: (await (async () => {
      const a = (await ok(tok.w, 'registro_pedir_aprobacion', { tipo: 'whatsapp_primero', prospecto_id: P.otro.id,
        contenido: { canal: 'whatsapp', texto: 'Hola Otro, sigo por acá.' }, bot: 'seguimiento' })).aprobacion;
      await ok(tok.w, 'registro_aprobar', { id: a.id, decision: 'aprobada', operador: 'Ignacio', bot: 'orquestador' });
      return a.id;
    })()),
  });
  assert.ok(t2.espera_segundos >= 19 && t2.espera_segundos <= 61, `espera ${t2.espera_segundos}`);
  const antes = await call(tok.w, 'whatsapp_resultado', { envio_id: t2.envio_id, resultado: 'enviado' });
  assert.equal(antes.error.code, 'whatsapp_antes_de_turno');

  const r1 = await ok(tok.w, 'whatsapp_resultado', { envio_id: t1.envio_id, resultado: 'enviado' });
  assert.equal(r1.envio.estado, 'enviado');
  const h = await ok(tok.w, 'registro_historia', { prospecto_id: P.tibio.id });
  const ev = h.eventos.find((x) => x.tipo === 'whatsapp.enviado');
  assert.equal(ev.datos.texto, texto);
  assert.ok(h.prospecto.canales.includes('whatsapp'));
  assert.equal(h.aprobaciones.find((x) => x.id === ap.id).estado, 'usada');
  const otra = await ok(tok.w, 'whatsapp_resultado', { envio_id: t1.envio_id, resultado: 'enviado' });
  assert.equal(otra.repetido, true);
  await adelantar(t2.envio_id);
  await ok(tok.w, 'whatsapp_resultado', { envio_id: t2.envio_id, resultado: 'enviado' });

  // Con chat abierto, el segundo mensaje ya no pide aprobación; el mismo texto en 24 h, sí se frena.
  await libre();
  const dup = await call(tok.w, 'whatsapp_turno', { prospecto_id: P.tibio.id, texto: `  ${texto} `, idempotency_key: 'tibio:whatsapp-2' });
  assert.equal(dup.error.code, 'whatsapp_repetido');
  const t3 = await ok(tok.w, 'whatsapp_turno', { prospecto_id: P.tibio.id, texto: '¿Pudiste verlo?', idempotency_key: 'tibio:whatsapp-2' });
  assert.equal(t3.primero, false);
  await adelantar(t3.envio_id);
  await ok(tok.w, 'whatsapp_resultado', { envio_id: t3.envio_id, resultado: 'enviado' });

  const busca = await ok(tok.w, 'registro_buscar', { whatsapp: '11 4000-0002' });
  assert.deepEqual(busca.prospectos.map((p) => p.id), [P.tibio.id]);
});

test('topes del día, horario y nadie de las listas', async () => {
  await libre();
  await whatsapp.configurar(W, { tope_contacto_dia: 2 });
  const tope = await call(tok.w, 'whatsapp_turno', { prospecto_id: P.tibio.id, texto: 'Un tercero', idempotency_key: 'tibio:whatsapp-3' });
  assert.equal(tope.status, 429);
  assert.equal(tope.error.code, 'whatsapp_tope');
  await whatsapp.configurar(W, { tope_contacto_dia: 8, tope_dia: 3 });
  const total = await call(tok.w, 'whatsapp_turno', { prospecto_id: P.otro.id, texto: 'Otro más', idempotency_key: 'otro:whatsapp-2' });
  assert.equal(total.error.code, 'whatsapp_tope');
  await whatsapp.configurar(W, { tope_dia: 60 });

  // Un horario que no incluye la hora actual del cliente.
  const { hora } = whatsapp.horaLocal(new Date(), TZ);
  const h = Math.floor(hora);
  const fuera = h >= 12 ? { hora_desde: 0, hora_hasta: Math.max(1, h - 1) } : { hora_desde: h + 2, hora_hasta: 24 };
  await whatsapp.configurar(W, fuera);
  const cerrado = await call(tok.w, 'whatsapp_turno', { prospecto_id: P.otro.id, texto: 'Fuera de hora', idempotency_key: 'otro:whatsapp-3' });
  assert.equal(cerrado.error.code, 'whatsapp_fuera_de_horario');
  assert.equal((await ok(tok.w, 'whatsapp_estado')).en_horario, false);
  await whatsapp.configurar(W, { hora_desde: 0, hora_hasta: 24 });

  await sql(`insert into sdr.no_contactar (client_id, valor, tipo, motivo) values ($1, 'empresa-w.test', 'dominio', 'Cliente actual')`, [W]);
  const nc = await call(tok.w, 'whatsapp_turno', { prospecto_id: P.otro.id, texto: 'Hola de nuevo', idempotency_key: 'otro:whatsapp-4' });
  assert.equal(nc.error.code, 'no_contactar');
  await sql(`delete from sdr.no_contactar where client_id = $1`, [W]);
});

test('un bloqueo pausa todo el canal, avisa al orquestador y sólo Biguá lo reanuda', async () => {
  await libre();
  const t = await ok(tok.w, 'whatsapp_turno', { prospecto_id: P.otro.id, texto: 'Te escribo de nuevo por acá', idempotency_key: 'otro:whatsapp-5' });
  const b = await ok(tok.w, 'whatsapp_resultado', { envio_id: t.envio_id, resultado: 'bloqueado', detalle: 'No podés enviar mensajes a contactos nuevos por un tiempo' });
  assert.equal(b.pausado, true);
  assert.match(b.aviso, /pausa/);
  const e = await ok(tok.w, 'whatsapp_estado');
  assert.equal(e.pausado, true);
  assert.match(e.pausa_motivo, /contactos nuevos/);
  const frenado = await call(tok.w, 'whatsapp_turno', { prospecto_id: P.tibio.id, texto: 'Hola otra vez', idempotency_key: 'tibio:whatsapp-9' });
  assert.equal(frenado.status, 423);
  assert.equal(frenado.error.code, 'whatsapp_pausado');
  const pend = await sdr.pendientes(W, 'orquestador');
  assert.ok(pend.pedidos.some((p) => /WhatsApp quedó en pausa/.test(p.que)), 'el orquestador recibe el aviso');

  // La aplicación no puede reanudar sola: el permiso es sólo sobre las columnas de la pausa, y reanudar es del panel.
  await assert.rejects(store.asRole('mailgw_app', W, (c) => c.query(`update sdr.whatsapp_config set tope_dia = 500 where client_id = $1`, [W])),
    /permission denied/);
  await whatsapp.configurar(W, { reanudar: true });
  assert.equal((await ok(tok.w, 'whatsapp_estado')).pausado, false);
});

test('aislamiento: otro cliente no usa los prospectos ni el WhatsApp de este', async () => {
  await whatsapp.configurar(X, { activo: true, hora_desde: 0, hora_hasta: 24 });
  const r = await call(tok.x, 'whatsapp_turno', { prospecto_id: P.tibio.id, texto: 'Hola', idempotency_key: 'cruce:whatsapp-1' });
  assert.equal(r.status, 404);
  const ver = await store.asRole('mailgw_app', X, (c) => c.query(`select * from sdr.whatsapp_envio`));
  assert.equal(ver.rows.length, 0);
});

test('monitor: los textos de cada línea y el modo de cada canal', () => {
  const fila = (tipo, datos = {}, extra = {}) => ({ at: '2026-11-06T13:00:00Z', tipo, datos, prospecto: 'Ana Pérez', cuenta: 'Banco X', ...extra });
  assert.deepEqual(monitor.linea(fila('mail.enviado', { asunto: 'QA para el puesto' })),
    { at: '2026-11-06T13:00:00Z', estado: 'ok', canal: 'correo', texto: 'mail a Ana Pérez (Banco X) · «QA para el puesto»' });
  assert.equal(monitor.linea(fila('aprobacion.pedida', { aprobacion: 'a1', tipo: 'respuesta_positivo' }), new Set(['a1'])).estado, 'espera');
  assert.match(monitor.linea(fila('aprobacion.pedida', { aprobacion: 'a1', tipo: 'calibracion_mail' })).texto, /pedido de OK/);
  assert.equal(monitor.linea(fila('mail.rebotado')).estado, 'error');
  assert.equal(monitor.linea(fila('respuesta', {}, { canal: 'whatsapp' })).canal, 'whatsapp');
  assert.equal(monitor.linea(fila('pedido')), null);
  const c = monitor.canales({
    cfg: { bots_activos: ['prospector', 'seguimiento', 'whatsapp'], ajustes: { cuentas_por_dia: 8 } },
    calibracion: { usados: 14, total: 20 }, buzones: [{ status: 'active' }, { status: 'paused' }],
    dripify: null, wa: { activo: true, aprobar_primero: true, pausado: false, hoy: { enviados: 3, tope_dia: 60 } },
  });
  const por = Object.fromEntries(c.map((x) => [x.clave, x]));
  assert.equal(por.correo.modo, 'supervisado');
  assert.match(por.correo.detalle, /1 buzón · calibración 14 de 20/);
  assert.equal(por.linkedin.modo, 'apagado');
  assert.equal(por.whatsapp.modo, 'supervisado');
  assert.equal(por.prospeccion.modo, 'autonomo');
  assert.equal(por.respuestas.modo, 'supervisado');
});

test('buscar por WhatsApp: números de países distintos con el mismo final no son la misma persona', async () => {
  // Las formas del mismo número se igualan; dos códigos de país distintos, no.
  assert.equal(sdr.mismoWhatsapp('+54 9 11 4000-0002', '+54 11 4000 0002'), true);
  assert.equal(sdr.mismoWhatsapp('+52 1 55 1234 5678', '+52 55 1234 5678'), true);
  assert.equal(sdr.mismoWhatsapp('+1 555 123 4567', '+52 555 123 4567'), false);
  // Un número local se completa con el país del cliente; nunca se cruza por el final.
  assert.equal(sdr.mismoWhatsapp('011 4000-0002', '+54 9 11 4000 0002', '54'), true);
  assert.equal(sdr.mismoWhatsapp('555 123 4567', '+52 555 123 4567', '52'), true);
  assert.equal(sdr.mismoWhatsapp('555 123 4567', '+52 555 123 4567', '54'), false);
  assert.equal(sdr.mismoWhatsapp('11 4000 0002', '+1 114 000 0002', '54'), false, 'el ataque del hallazgo: mismo final, otro país');
  assert.equal(sdr.mismoWhatsapp('555 123 4567', '+52 555 123 4567'), false, 'sin país del cliente, un local no se iguala');
  assert.equal(sdr.paisDeZona('America/Argentina/Buenos_Aires'), '54');

  const us = (await ok(tok.w, 'registro_guardar_prospecto', { nombre: 'Pat US', email: 'pat@us-w.test', whatsapp: '+1 555 123 4567' })).prospecto;
  const mx = (await ok(tok.w, 'registro_guardar_prospecto', { nombre: 'Paty MX', email: 'paty@mx-w.test', whatsapp: '+52 555 123 4567' })).prospecto;
  assert.deepEqual((await ok(tok.w, 'registro_buscar', { whatsapp: '+1 (555) 123-4567' })).prospectos.map((p) => p.id), [us.id]);
  assert.deepEqual((await ok(tok.w, 'registro_buscar', { whatsapp: '+52 1 555 123 4567' })).prospectos.map((p) => p.id), [mx.id]);
  assert.deepEqual((await ok(tok.w, 'registro_buscar', { whatsapp: '+44 555 123 4567' })).prospectos, [], 'otro país: nadie');
  // Sin código de país, el número se completa con el del cliente (Argentina): no es ninguno de los dos.
  const local = await ok(tok.w, 'registro_buscar', { whatsapp: '555 123 4567' });
  assert.deepEqual(local.prospectos, []);
  // Un prospecto cargado con número local argentino no se iguala con uno extranjero del mismo final.
  const loc = (await ok(tok.w, 'registro_guardar_prospecto', { nombre: 'Local AR', email: 'local@ar-w.test', whatsapp: '11 4000 0099' })).prospecto;
  assert.deepEqual((await ok(tok.w, 'registro_buscar', { whatsapp: '+1 114 000 0099' })).prospectos, []);
  assert.deepEqual((await ok(tok.w, 'registro_buscar', { whatsapp: '+54 9 11 4000 0099' })).prospectos.map((p) => p.id), [loc.id]);
  // El mismo número en dos personas: no se elige ninguna.
  await ok(tok.w, 'registro_guardar_prospecto', { nombre: 'Pat bis', email: 'pat.bis@us-w.test', whatsapp: '+1 555 123 4567' });
  const dos = await ok(tok.w, 'registro_buscar', { whatsapp: '+1 555 123 4567' });
  assert.deepEqual(dos.prospectos, []);
  assert.match(dos.aviso, /está cargado en 2 personas/);
});
