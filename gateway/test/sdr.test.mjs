// Núcleo SDR (etapa 1 de docs/09): reglas publicadas desde el repo, registro de prospección,
// pedidos entre bots, aprobaciones, calibración exigida por el gateway y bitácora. Contra la
// base local, el SMTP de prueba y el Dovecot (para responder un mail real).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import pg from 'pg';
import * as store from '../src/store.mjs';
import * as sdr from '../src/sdr/store.mjs';
import { cargarPlaybooks } from '../src/sdr/playbooks.mjs';
import { normalizeLinkedin } from '../src/sdr/linkedin.mjs';
import { newToken, aadFor, encryptSecret } from '../src/crypto.mjs';
import { startServer } from '../src/server.mjs';
import { startSmtp, gw, runCli, appendTo, rfc822, HOST, PORTS, USERS } from './helpers.mjs';

const A = 'sdr-a';
const B = 'sdr-b';
const BUZON = 'carla@cliente.test';
let server, smtp, api;
const tok = {};

async function token(client, scopes) {
  const { token: t, hash } = newToken();
  await store.createToken(client, `sdr ${scopes.join('+')}`, hash, scopes, null);
  return t;
}

// Llama una herramienta y devuelve { status, data, error }.
async function call(t, op, body = {}) {
  const r = await api.call(t, op, body);
  return { status: r.status, data: r.body.data, error: r.body.error };
}
const ok = async (t, op, body) => {
  const r = await call(t, op, body);
  assert.equal(r.status, 200, `${op}: ${JSON.stringify(r.error)}`);
  return r.data;
};

const META = { bot: 'prospector', tarea: 'diaria' };

before(async () => {
  smtp = await startSmtp();
  server = await startServer(0);
  api = gw(`http://127.0.0.1:${server.address().port}`);
  await store.upsertClient(A, 'Cliente SDR A');
  await store.upsertClient(B, 'Cliente SDR B');
  await store.upsertAccount({
    client_id: A, email: BUZON, display_name: 'Carla', username: BUZON,
    secret_enc: encryptSecret(USERS[BUZON], aadFor(A, BUZON)),
    imap_host: HOST, imap_port: PORTS.imaps, imap_security: 'tls',
    smtp_host: HOST, smtp_port: PORTS.smtps, smtp_security: 'tls',
    timezone: 'America/Argentina/Buenos_Aires', daily_send_cap: 40, append_sent: false,
  });
  tok.a = await token(A, ['read', 'send', 'sdr']);
  tok.aSinSdr = await token(A, ['read', 'send']);
  tok.b = await token(B, ['read', 'send', 'sdr']);
});

after(async () => {
  await new Promise((r) => server.close(r));
  await smtp.close();
  await store.closePool();
});

// ---------------------------------------------------------------- reglas

test('playbooks del repo: se cargan, se publican por la CLI y quedan en el canal estable', async () => {
  const pb = cargarPlaybooks(path.resolve('../playbooks'));
  assert.ok(pb.secciones.some((s) => s.bot === 'prospector' && s.tarea === 'diaria'));
  const out = await runCli(['playbooks-publicar', '--version', 't1', '--canal', 'estable', '--notas', 'prueba']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /Versión t1 publicada/);
  const again = await runCli(['playbooks-publicar', '--version', 't1']);
  assert.notEqual(again.status, 0, 'una versión no se vuelve a publicar');
  const sql = await runCli(['playbooks-sql', '--version', 't9', '--canal', 'canario']);
  assert.equal(sql.status, 0, sql.stderr);
  assert.match(sql.stdout, /^begin;/);
  assert.match(sql.stdout, /insert into sdr.playbook_canal/);
});

test('sin configuración del cliente las reglas avisan que no prospecte; la CLI la carga', async () => {
  const sin = await ok(tok.a, 'reglas_manual', { bot: 'prospector', tarea: 'diaria', seccion: 'ajustes-cliente' });
  assert.match(sin.contenido, /todavía no tiene ajustes/);
  assert.equal((await call(tok.a, 'reglas_alta')).status, 404);

  const cfg = {
    calibracion_mails: 2,
    ajustes: { icp: 'Empresas de software de Argentina con avisos de QA', firma: 'Carla, Cliente SDR A', positivos: ['interesado', 'pide reunión'] },
  };
  const out = await runCli(['sdr-config', A], JSON.stringify(cfg));
  assert.equal(out.status, 0, out.stderr);
  const con = await ok(tok.a, 'reglas_manual', { bot: 'prospector', tarea: 'diaria', seccion: 'ajustes-cliente' });
  assert.match(con.contenido, /Empresas de software de Argentina/);
  assert.match(con.contenido, /primeros 2 mails nuevos necesitan aprobación/);
  assert.match(con.contenido, /- pide reunión/);
});

test('reglas_manual: índice con comunes, bot, tarea y cliente; secciones de a una', async () => {
  const idx = await ok(tok.a, 'reglas_manual', { bot: 'prospector', tarea: 'diaria' });
  assert.equal(idx.version, 't1');
  const alcances = new Set(idx.indice.map((s) => s.alcance));
  assert.deepEqual([...alcances].sort(), ['bot', 'cliente', 'comun', 'tarea']);
  assert.equal(idx.indice[0].seccion, 'quienes-somos', 'primero lo común');
  assert.equal(idx.indice.at(-1).seccion, 'ajustes-cliente', 'último lo del cliente');
  assert.ok(idx.indice.every((s) => s.titulo && s.resumen));
  assert.ok(!idx.indice.some((s) => s.seccion === 'plantilla'), 'la plantilla de routines no es parte del manual');

  const s = await ok(tok.a, 'reglas_manual', { bot: 'prospector', tarea: 'diaria', seccion: 'enviar-o-pedir-aprobacion' });
  assert.match(s.contenido, /registro_pedir_aprobacion/);
  assert.equal((await call(tok.a, 'reglas_manual', { bot: 'prospector', tarea: 'diaria', seccion: 'no-existe' })).status, 404);
  assert.equal((await call(tok.a, 'reglas_manual', { bot: 'nadie', tarea: 'diaria' })).status, 404);
  const sinPermiso = await call(tok.aSinSdr, 'reglas_manual', { bot: 'prospector', tarea: 'diaria' });
  assert.equal(sinPermiso.status, 403);
});

test('canal canario y versión fija', async () => {
  const pb = cargarPlaybooks(path.resolve('../playbooks'));
  const cambiada = pb.secciones.map((s) => (s.seccion === 'quienes-somos' ? { ...s, contenido: `${s.contenido}\n\nVERSIÓN CANARIO` } : s));
  await sdr.publicar({ version: 't2', secciones: cambiada, rutinas: pb.rutinas });
  await sdr.moverCanal('canario', 't2');

  const estable = await ok(tok.a, 'reglas_manual', { bot: 'prospector', tarea: 'diaria', seccion: 'quienes-somos' });
  assert.equal(estable.version, 't1');
  await sdr.setConfig(A, { canal: 'canario' });
  const canario = await ok(tok.a, 'reglas_manual', { bot: 'prospector', tarea: 'diaria', seccion: 'quienes-somos' });
  assert.equal(canario.version, 't2');
  assert.match(canario.contenido, /VERSIÓN CANARIO/);
  await sdr.setConfig(A, { version_fija: 't1' });
  assert.equal((await ok(tok.a, 'reglas_manual', { bot: 'prospector', tarea: 'diaria' })).version, 't1');
  await sdr.setConfig(A, { canal: 'estable', version_fija: null });
});

test('reglas_alta: las routines de los bots activos, con el prompt armado para el cliente', async () => {
  const r = await ok(tok.a, 'reglas_alta', { bot: 'orquestador', tarea: 'alta' });
  assert.equal(r.cliente, 'Cliente SDR A');
  assert.deepEqual([...new Set(r.rutinas.map((x) => x.bot))].sort(), ['orquestador', 'prospector']);
  assert.equal(r.rutinas.length, 6);
  for (const x of r.rutinas) {
    assert.match(x.prompt, /Cliente SDR A/);
    assert.match(x.prompt, /bitacora_inicio/);
    assert.ok(!/\{[a-z_]+\}/.test(x.prompt), `sin marcadores sin reemplazar: ${x.nombre}`);
  }
});

// ---------------------------------------------------------------- registro

test('URLs de LinkedIn: una sola forma; se rechaza lo cortado', () => {
  assert.equal(normalizeLinkedin('https://ar.linkedin.com/in/Juan-Perez-123/'), 'https://www.linkedin.com/in/juan-perez-123');
  assert.equal(normalizeLinkedin('linkedin.com/in/maria-gomez?trk=x'), 'https://www.linkedin.com/in/maria-gomez');
  for (const mal of ['https://www.linkedin.com/in/juan-', 'https://www.linkedin.com/company/acme', 'https://example.com/in/juan']) {
    assert.throws(() => normalizeLinkedin(mal), /LinkedIn/, mal);
  }
});

const ids = {};

test('cuentas y prospectos: sin duplicar, con sus eventos automáticos', async () => {
  const c1 = await ok(tok.a, 'registro_guardar_cuenta', {
    ...META, nombre: 'Acme SA', dominio: 'https://www.Acme.com.ar/contacto', pais: 'Argentina',
    senales: [{ tipo: 'aviso', fecha: '2026-11-02', evidencia: 'https://ejemplo.test/aviso', resumen: 'Busca QA Automation' }],
    tesis: 'Están armando QA desde cero',
  });
  assert.equal(c1.creada, true);
  assert.equal(c1.cuenta.dominio, 'acme.com.ar');
  ids.cuenta = c1.cuenta.id;
  const c2 = await ok(tok.a, 'registro_guardar_cuenta', { ...META, nombre: 'Acme', dominio: 'acme.com.ar', vertical: 'software' });
  assert.equal(c2.creada, false);
  assert.equal(c2.cuenta.id, ids.cuenta);
  assert.equal(c2.cuenta.vertical, 'software');

  const p1 = await ok(tok.a, 'registro_guardar_prospecto', {
    ...META, cuenta_id: ids.cuenta, nombre: 'Laura Gómez', cargo: 'Gerente de QA', linkedin_url: 'https://ar.linkedin.com/in/laura-gomez/',
    eleccion: { rol_compra: 'decisor', puntaje: 80, motivo: 'Gerente de QA, rol del cliente' },
  });
  assert.equal(p1.prospecto.linkedin_url, 'https://www.linkedin.com/in/laura-gomez');
  ids.laura = p1.prospecto.id;
  const p2 = await ok(tok.a, 'registro_guardar_prospecto', {
    ...META, nombre: 'Laura Gómez', linkedin_url: 'https://www.linkedin.com/in/laura-gomez', email: 'Laura@Prospecto.test', email_calidad: 'verificado',
  });
  assert.equal(p2.creado, false);
  assert.equal(p2.prospecto.id, ids.laura);
  assert.equal(p2.prospecto.email, 'laura@prospecto.test');
  const cortada = await call(tok.a, 'registro_guardar_prospecto', { ...META, nombre: 'X', linkedin_url: 'https://www.linkedin.com/in/x-' });
  assert.equal(cortada.status, 400);

  const h = await ok(tok.a, 'registro_historia', { prospecto_id: ids.laura });
  assert.deepEqual(h.eventos.map((e) => e.tipo), ['prospecto.revelado']);
  assert.equal(h.eventos[0].bot, 'prospector');
  assert.equal(h.eventos[0].version_reglas, 't1');
  assert.equal(h.cuenta.nombre, 'Acme');
  const hc = await ok(tok.a, 'registro_historia', { cuenta_id: ids.cuenta });
  assert.deepEqual(hc.eventos.map((e) => e.tipo), ['cuenta.investigada', 'prospecto.revelado']);

  for (const q of [{ email: 'LAURA@prospecto.test' }, { linkedin_url: 'mx.linkedin.com/in/laura-gomez' }, { dominio: 'www.acme.com.ar' }]) {
    const r = await ok(tok.a, 'registro_buscar', q);
    assert.equal(r.prospectos[0]?.id, ids.laura, JSON.stringify(q));
  }
});

test('un cliente no ve ni toca el registro de otro', async () => {
  const r = await ok(tok.b, 'registro_buscar', { email: 'laura@prospecto.test' });
  assert.deepEqual(r, { cuentas: [], prospectos: [] });
  assert.equal((await call(tok.b, 'registro_historia', { prospecto_id: ids.laura })).status, 404);
  assert.equal((await call(tok.b, 'registro_evento', { tipo: 'nota', prospecto_id: ids.laura })).status, 404);
  assert.equal((await call(tok.b, 'registro_guardar_prospecto', { id: ids.laura, nombre: 'pisado' })).status, 404);
  const mismo = await ok(tok.b, 'registro_guardar_prospecto', { ...META, nombre: 'Laura en B', email: 'laura@prospecto.test' });
  assert.equal(mismo.creado, true, 'la misma persona puede ser prospecto de otro cliente, por separado');
  assert.notEqual(mismo.prospecto.id, ids.laura);

  // Directo contra la base, con el rol de la aplicación y el cliente B fijado.
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const c = await pool.connect();
  try {
    const as = async (sql, params) => {
      await c.query('begin');
      await c.query(`select set_config('role', 'mailgw_app', true), set_config('mailgw.client_id', $1, true)`, [B]);
      try { return await c.query(sql, params); } finally { await c.query('rollback'); }
    };
    assert.equal((await as(`select * from sdr.prospecto where id = $1`, [ids.laura])).rowCount, 0);
    assert.equal((await as(`update sdr.prospecto set nombre = 'x' where id = $1`, [ids.laura])).rowCount, 0);
    assert.ok((await as(`select * from sdr.playbook_seccion limit 1`)).rowCount > 0, 'las reglas son de todos');
    await assert.rejects(as(`insert into sdr.evento (client_id, tipo) values ($1, 'nota')`, [A]), /row-level security/);
    await assert.rejects(as(`insert into sdr.playbook_version (version) values ('hack')`), /permission denied/);
  } finally {
    c.release();
    await pool.end();
  }
});

test('agenda: lo que toca hoy, sin los cerrados', async () => {
  const hoy = sdr.hoyEn('America/Argentina/Buenos_Aires');
  await ok(tok.a, 'registro_guardar_prospecto', { ...META, id: ids.laura, nombre: 'Laura Gómez', proximo_paso: 'mail 1', proximo_canal: 'mail', proximo_fecha: hoy });
  const p = await ok(tok.a, 'registro_guardar_prospecto', { ...META, nombre: 'Cerrado', email: 'cerrado@prospecto.test', estado: 'baja', proximo_fecha: hoy });
  const ag = await ok(tok.a, 'registro_agenda', { bot: 'orquestador' });
  assert.ok(ag.prospectos.some((x) => x.id === ids.laura));
  assert.ok(!ag.prospectos.some((x) => x.id === p.prospecto.id));
  assert.equal((await ok(tok.a, 'registro_agenda', { canal: 'whatsapp' })).prospectos.length, 0);
});

test('pedidos entre bots: pendientes, resolución y escalado después de tres idas y vueltas', async () => {
  const p1 = await ok(tok.a, 'registro_pedir', { bot: 'orquestador', para_bot: 'prospector', que: '10 cuentas nuevas de software' });
  assert.match(p1.aviso, /tenés un pedido en el registro/);
  const pend = await ok(tok.a, 'registro_pendientes', { bot: 'prospector' });
  assert.ok(pend.pedidos.some((x) => x.id === p1.pedido.id));
  await ok(tok.a, 'registro_resolver_pedido', { id: p1.pedido.id, estado: 'hecho', resultado: '10 cuentas, 14 personas' });
  assert.ok(!(await ok(tok.a, 'registro_pendientes', { bot: 'prospector' })).pedidos.some((x) => x.id === p1.pedido.id));

  let prev = await ok(tok.a, 'registro_pedir', { bot: 'seguimiento', para_bot: 'prospector', que: 'buscar a la persona derivada', prospecto_id: ids.laura });
  for (const [de, para] of [['prospector', 'seguimiento'], ['seguimiento', 'prospector']]) {
    prev = await ok(tok.a, 'registro_pedir', { bot: de, para_bot: para, que: 'sigue', relacionado_con: prev.pedido.id, prospecto_id: ids.laura });
    assert.equal(prev.pedido.escalado, false);
  }
  const cuarto = await ok(tok.a, 'registro_pedir', { bot: 'prospector', para_bot: 'seguimiento', que: 'otra vez', relacionado_con: prev.pedido.id });
  assert.equal(cuarto.pedido.escalado, true);
  assert.equal(cuarto.pedido.para_bot, 'orquestador');
  assert.match(cuarto.aviso, /escaló al orquestador/);
  const h = await ok(tok.a, 'registro_historia', { prospecto_id: ids.laura });
  assert.ok(h.eventos.some((e) => e.tipo === 'pedido' && e.interno));
});

// ---------------------------------------------------------------- aprobaciones y calibración

const MAIL = (extra = {}) => ({
  mailbox: BUZON, to: 'laura@prospecto.test', subject: 'QA para Acme', text: 'Hola Laura,\nvi el aviso de QA Automation.\n¿Hablamos?',
  prospecto_id: ids.laura, bot: 'prospector', tarea: 'diaria', ...extra,
});

test('calibración: el gateway no deja enviar sin una aprobación de exactamente ese mail', async () => {
  const sin = await call(tok.a, 'send', MAIL({ idempotency_key: `${ids.laura}:mail-1` }));
  assert.equal(sin.status, 409);
  assert.equal(sin.error.code, 'aprobacion_requerida');
  assert.match(sin.error.message, /calibración \(0 de 2/);

  const faltan = await call(tok.a, 'registro_pedir_aprobacion', { bot: 'prospector', tipo: 'calibracion_mail', contenido: { buzon: BUZON, texto: 'x' } });
  assert.equal(faltan.status, 400);

  const ap = await ok(tok.a, 'registro_pedir_aprobacion', {
    bot: 'prospector', tipo: 'calibracion_mail', prospecto_id: ids.laura,
    contenido: { buzon: BUZON, destinatario: 'laura@prospecto.test', asunto: 'QA para Acme', texto: 'Hola Laura,\nvi el aviso de QA Automation.\n¿Hablamos?', contexto: 'Aviso del 02/11' },
  });
  ids.ap1 = ap.aprobacion.id;
  const pendiente = await call(tok.a, 'send', MAIL({ idempotency_key: `${ids.laura}:mail-1`, aprobacion_id: ids.ap1 }));
  assert.equal(pendiente.error.code, 'aprobacion_requerida');
  assert.match(pendiente.error.message, /pendiente/);

  const orq = await ok(tok.a, 'registro_pendientes', { bot: 'orquestador' });
  assert.ok(orq.aprobaciones_por_decidir.some((x) => x.id === ids.ap1));
  const lista = await ok(tok.a, 'registro_aprobaciones', {});
  assert.equal(lista.aprobaciones.find((x) => x.id === ids.ap1).cuenta, 'Acme');

  // El operador aprueba con el texto corregido.
  const textoFinal = 'Hola Laura,\nvi que están buscando QA Automation en Acme.\n¿Te sirve una charla de 15 minutos?';
  const dec = await ok(tok.a, 'registro_aprobar', { id: ids.ap1, decision: 'aprobada', operador: 'Ignacio', texto: textoFinal, bot: 'orquestador' });
  assert.equal(dec.aprobacion.decision_contenido.texto, textoFinal);
  assert.equal((await call(tok.a, 'registro_aprobar', { id: ids.ap1, decision: 'rechazada', operador: 'Otro' })).error.code, 'ya_decidida');
  const pros = await ok(tok.a, 'registro_pendientes', { bot: 'prospector' });
  assert.ok(pros.aprobaciones_para_ejecutar.some((x) => x.id === ids.ap1));

  const original = await call(tok.a, 'send', MAIL({ idempotency_key: `${ids.laura}:mail-1`, aprobacion_id: ids.ap1 }));
  assert.equal(original.status, 422);
  assert.equal(original.error.code, 'aprobacion_no_coincide');
  assert.match(original.error.message, /el texto/);
  const otroDestino = await call(tok.a, 'send', MAIL({ to: 'otra@prospecto.test', text: textoFinal, idempotency_key: `${ids.laura}:mail-1`, aprobacion_id: ids.ap1 }));
  assert.match(otroDestino.error.message, /el destinatario/);

  // Con espacios distintos, igual coincide.
  const antes = smtp.received.length;
  const env = await ok(tok.a, 'send', MAIL({ text: textoFinal.replace('\n', '  \n'), idempotency_key: `${ids.laura}:mail-1`, aprobacion_id: ids.ap1 }));
  assert.equal(env.duplicate, false);
  assert.equal(smtp.received.length, antes + 1);
  assert.match(smtp.received.at(-1).raw, /buscando QA Automation en Acme/);

  const reintento = await ok(tok.a, 'send', MAIL({ text: textoFinal, idempotency_key: `${ids.laura}:mail-1`, aprobacion_id: ids.ap1 }));
  assert.equal(reintento.duplicate, true, 'reintento con la misma clave: el envío anterior');
  assert.equal(smtp.received.length, antes + 1);
  const reuso = await call(tok.a, 'send', MAIL({ text: textoFinal, idempotency_key: `${ids.laura}:mail-1b`, aprobacion_id: ids.ap1 }));
  assert.equal(reuso.error.code, 'aprobacion_requerida', 'una aprobación se usa una vez');

  const h = await ok(tok.a, 'registro_historia', { prospecto_id: ids.laura });
  const enviado = h.eventos.find((e) => e.tipo === 'mail.enviado');
  assert.equal(enviado.ref, env.message_id);
  assert.equal(enviado.datos.aprobacion, ids.ap1);
  assert.equal(h.prospecto.estado, 'en_contacto');
  assert.deepEqual(h.prospecto.canales, ['mail']);
  assert.equal(h.aprobaciones[0].estado, 'usada');

  const res = await ok(tok.a, 'registro_resumen', {});
  assert.equal(res.eventos['mail.enviado'], 1);
  assert.deepEqual(res.calibracion, { usados: 1, total: 2, terminada: false });
});

test('rechazada: no se puede usar; terminada la calibración, los mails salen sin aprobación', async () => {
  const otro = await ok(tok.a, 'registro_guardar_prospecto', { ...META, nombre: 'Pedro', email: 'pedro@prospecto.test' });
  const ap = await ok(tok.a, 'registro_pedir_aprobacion', {
    bot: 'prospector', tipo: 'calibracion_mail', prospecto_id: otro.prospecto.id,
    contenido: { buzon: BUZON, destinatario: 'pedro@prospecto.test', asunto: 'Hola', texto: 'Uno' },
  });
  await ok(tok.a, 'registro_aprobar', { id: ap.aprobacion.id, decision: 'rechazada', operador: 'Ignacio', nota: 'muy corto' });
  const rech = await call(tok.a, 'send', MAIL({ to: 'pedro@prospecto.test', subject: 'Hola', text: 'Uno', prospecto_id: otro.prospecto.id, idempotency_key: 'pedro:mail-1', aprobacion_id: ap.aprobacion.id }));
  assert.match(rech.error.message, /rechazada/);
  assert.ok((await ok(tok.a, 'registro_pendientes', { bot: 'prospector' })).aprobaciones_rechazadas.some((x) => x.id === ap.aprobacion.id));

  const ap2 = await ok(tok.a, 'registro_pedir_aprobacion', {
    bot: 'prospector', tipo: 'calibracion_mail', prospecto_id: otro.prospecto.id,
    contenido: { buzon: BUZON, destinatario: 'pedro@prospecto.test', asunto: 'Hola Pedro', texto: 'Dos líneas.\nMejor.' },
  });
  await ok(tok.a, 'registro_aprobar', { id: ap2.aprobacion.id, decision: 'aprobada', operador: 'Ignacio' });
  await ok(tok.a, 'send', MAIL({ to: 'Pedro <pedro@prospecto.test>', subject: 'Hola Pedro', text: 'Dos líneas.\nMejor.', prospecto_id: otro.prospecto.id, idempotency_key: 'pedro:mail-1', aprobacion_id: ap2.aprobacion.id }));

  // 2 de 2: la calibración terminó.
  assert.equal((await ok(tok.a, 'registro_resumen', {})).calibracion.terminada, true);
  const libre = await ok(tok.a, 'send', MAIL({ to: 'pedro@prospecto.test', subject: 'Seguimiento', text: 'Tres', prospecto_id: otro.prospecto.id, idempotency_key: 'pedro:mail-2' }));
  assert.equal(libre.duplicate, false);
  // Otro cliente sin configuración del SDR: el gateway funciona como antes.
  assert.equal((await call(tok.b, 'send', { mailbox: BUZON, to: 'x@y.test', subject: 's', text: 't', idempotency_key: 'b-sin-config-1' })).error.code, 'mailbox_not_found');
});

test('respuesta a un positivo: exige aprobación aunque la calibración haya terminado', async () => {
  await appendTo(BUZON, 'INBOX', rfc822({
    from: 'Laura Gómez <laura@prospecto.test>', to: BUZON, subject: 'Re: QA para Acme', messageId: '<resp-sdr-1@prospecto.test>',
    body: 'Sí, me interesa. ¿Hablamos el jueves?',
  }));
  const found = await ok(tok.a, 'search', { mailbox: BUZON, subject: 'Re: QA para Acme' });
  const uid = found.messages[0].uid;
  await ok(tok.a, 'registro_evento', { tipo: 'respuesta', canal: 'mail', prospecto_id: ids.laura, datos: { clasificacion: 'interesado' }, bot: 'seguimiento' });
  await ok(tok.a, 'registro_evento', { tipo: 'positivo', canal: 'mail', prospecto_id: ids.laura, bot: 'seguimiento' });

  const texto = 'Genial, Laura. El jueves a las 11 te va bien?';
  const sin = await call(tok.a, 'reply', { mailbox: BUZON, uid, text: texto, prospecto_id: ids.laura, idempotency_key: `${ids.laura}:respuesta-1` });
  assert.equal(sin.error.code, 'aprobacion_requerida');
  assert.match(sin.error.message, /positivo/);
  const ap = await ok(tok.a, 'registro_pedir_aprobacion', { bot: 'seguimiento', tipo: 'respuesta_positivo', prospecto_id: ids.laura, contenido: { buzon: BUZON, texto } });
  await ok(tok.a, 'registro_aprobar', { id: ap.aprobacion.id, decision: 'aprobada', operador: 'Ignacio' });
  const r = await ok(tok.a, 'reply', { mailbox: BUZON, uid, text: texto, prospecto_id: ids.laura, aprobacion_id: ap.aprobacion.id, idempotency_key: `${ids.laura}:respuesta-1` });
  assert.equal(r.duplicate, false);
  const h = await ok(tok.a, 'registro_historia', { prospecto_id: ids.laura });
  assert.equal(h.prospecto.estado, 'positivo');
  assert.ok(h.eventos.some((e) => e.tipo === 'mail.enviado' && e.datos.respuesta === true));
});

// ---------------------------------------------------------------- bitácora y pruebas

test('bitácora y prueba de carga', async () => {
  const ini = await ok(tok.a, 'bitacora_inicio', { bot: 'prospector', tarea: 'diaria' });
  assert.equal(ini.version_reglas, 't1');
  const fin = await ok(tok.a, 'bitacora_fin', { corrida: ini.corrida, estado: 'parcial', items: 3, resumen: 'cupo lleno' });
  assert.equal(fin.estado, 'parcial');
  assert.equal((await call(tok.b, 'bitacora_fin', { corrida: ini.corrida, estado: 'ok' })).status, 404);
  const res = await ok(tok.a, 'registro_resumen', {});
  assert.ok(res.corridas.some((x) => x.bot === 'prospector' && x.estado === 'parcial'));

  const carga = await ok(tok.a, 'prueba_carga', { kb: 64, segundos: 1 });
  assert.equal(carga.bytes, 64 * 1024);
  assert.equal(carga.fin, 'FIN-DE-LA-PRUEBA');
});

test('MCP: las herramientas del SDR aparecen sólo con el permiso sdr', async () => {
  const con = await api.mcp(tok.a, 'tools/list', {}, 1);
  const nombres = con.body.result.tools.map((t) => t.name);
  for (const n of ['reglas_manual', 'registro_pedir_aprobacion', 'registro_aprobar', 'bitacora_inicio', 'prueba_carga']) assert.ok(nombres.includes(n), n);
  const sin = await api.mcp(tok.aSinSdr, 'tools/list', {}, 2);
  assert.ok(!sin.body.result.tools.some((t) => t.name.startsWith('registro_')));
  const r = await api.mcp(tok.a, 'tools/call', { name: 'reglas_manual', arguments: { bot: 'orquestador', tarea: 'aprobaciones' } }, 3);
  const payload = JSON.parse(r.body.result.content[0].text);
  assert.ok(payload.indice.some((s) => s.seccion === 'registrar-lo-que-decide-el-operador'));
});
