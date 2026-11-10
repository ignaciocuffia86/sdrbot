// WhatsApp de seguimiento (docs/22). El bot `whatsapp` manda desde WhatsApp Web, en el navegador de
// su asiento de Grok; el gateway no toca WhatsApp. Lo que hace el gateway es dar el turno de cada
// mensaje (whatsapp_turno) y registrarlo (whatsapp_resultado), y en el turno hace cumplir las
// reglas que no pueden depender de que el bot se acuerde:
//
//   - horario del cliente (por defecto de 8 a 24, todos los días);
//   - una pausa al azar entre dos envíos del cliente (por defecto 20 a 60 segundos), compartida
//     por todas las conversaciones, para que no salgan en ráfaga;
//   - topes por contacto y por día (8 y 60);
//   - sólo contactos tibios: alguien que ya respondió por algún canal o con quien ya hay chat;
//   - nada repetido: el mismo texto a la misma persona no sale dos veces en 24 horas;
//   - el primer mensaje a cada persona, con aprobación del operador (whatsapp_primero), y la
//     respuesta a un positivo, con respuesta_positivo;
//   - si WhatsApp avisa un bloqueo o un tope, todo frena hasta que Biguá lo reanude en el panel, y
//     el orquestador se lo cuenta al operador.

import crypto from 'node:crypto';
import { asRole, asOwner } from '../store.mjs';
import { GatewayError } from '../errors.mjs';
import { insertarEvento, aplicarEvento, versionActual, errorsSdr, prospectoDe, pedir, ESTADOS_POSITIVO } from './store.mjs';
import * as noContactar from './no_contactar.mjs';

const asClient = (clientId, fn) => asRole('mailgw_app', clientId, fn);
const err = (code, msg, status = 409) => new GatewayError(code, msg, status);
const normTexto = (s) => String(s ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
const hashTexto = (s) => crypto.createHash('sha256').update(normTexto(s).toLowerCase()).digest('hex');
const DIAS = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
// Un turno que el bot no usa en este tiempo vence y deja de contar para los topes.
const VIGENCIA_MIN = 10;
const CERRADOS = new Set(['baja', 'negativo', 'descartado']);

// Hora (0 a 23, con fracción) y día (1 lunes … 7 domingo) de una fecha en una zona horaria.
export function horaLocal(fecha, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', weekday: 'short',
  }).formatToParts(fecha).map((x) => [x.type, x.value]));
  const dia = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) + 1;
  return { hora: Number(p.hour) + Number(p.minute) / 60, dia };
}

export function enVentana(cfg, tz, fecha = new Date()) {
  const { hora, dia } = horaLocal(fecha, tz);
  return cfg.dias.includes(dia) && hora >= cfg.hora_desde && hora < cfg.hora_hasta;
}

const ventanaTexto = (cfg) => `de ${cfg.hora_desde} a ${cfg.hora_hasta} h` +
  (cfg.dias.length === 7 ? ', todos los días' : `, ${cfg.dias.map((d) => DIAS[d - 1]).join(', ')}`);

// Cuánto tiempo «escribiendo…» antes de mandar: proporcional al largo, con algo de azar, de 1 a 8 s.
export function escribiendoSeg(texto, azar = Math.random) {
  const base = normTexto(texto).length / 30;
  return Math.max(1, Math.min(8, Math.round(base + azar() * 2)));
}

async function configDe(c, clientId, { bloquear = false } = {}) {
  const { rows } = await c.query(
    `select w.*, coalesce(k.zona_horaria, 'America/Argentina/Buenos_Aires') as zona_horaria
       from sdr.whatsapp_config w left join sdr.cliente_config k on k.client_id = w.client_id
      where w.client_id = $1 ${bloquear ? 'for update of w' : ''}`, [clientId]);
  return rows[0] ?? null;
}

const inicioDelDia = `(date_trunc('day', now() at time zone $2) at time zone $2)`;

async function contar(c, clientId, tz, prospectoId) {
  const { rows } = await c.query(
    `select count(*) filter (where prospecto_id = $3)::int as contacto, count(*)::int as total
       from sdr.whatsapp_envio
      where client_id = $1 and creado_at >= ${inicioDelDia}
        and (estado = 'enviado' or (estado = 'turno' and vence_at > now()))`, [clientId, tz, prospectoId ?? null]);
  return rows[0];
}

const publico = (e) => ({
  envio_id: Number(e.id), estado: e.estado, enviar_desde: e.enviar_desde, vence_at: e.vence_at,
  espera_segundos: Math.max(0, Math.ceil((new Date(e.enviar_desde) - Date.now()) / 1000)),
});

// ---------------------------------------------------------------- turno

export async function turno(clientId, a, meta, { azar = Math.random } = {}) {
  return asClient(clientId, async (c) => {
    const cfg = await configDe(c, clientId, { bloquear: true });
    if (!cfg || !cfg.activo) {
      throw err('whatsapp_sin_configurar', 'WhatsApp no está activado para este cliente: no mandes nada por WhatsApp.', 503);
    }
    if (cfg.pausado) {
      throw err('whatsapp_pausado', `WhatsApp está pausado desde ${new Date(cfg.pausado_at).toISOString()}` +
        `${cfg.pausa_motivo ? ` (${cfg.pausa_motivo})` : ''}: no sale nada hasta que Biguá lo reanude en el panel.`, 423);
    }
    await c.query(`update sdr.whatsapp_envio set estado = 'vencido' where client_id = $1 and estado = 'turno' and vence_at <= now()`,
      [clientId]);

    // Idempotencia: la misma clave devuelve el mismo turno (o dice que ya salió).
    const { rows: prev } = await c.query(`select * from sdr.whatsapp_envio where client_id = $1 and clave = $2`,
      [clientId, a.idempotency_key]);
    if (prev[0] && ['turno', 'enviado'].includes(prev[0].estado)) {
      if (prev[0].prospecto_id !== a.prospecto_id || prev[0].texto_hash !== hashTexto(a.texto)) {
        throw err('invalid_request', 'Esa clave ya se usó para otro mensaje: usá una clave nueva.', 400);
      }
      return { ...publico(prev[0]), repetido: true,
        aviso: prev[0].estado === 'enviado' ? 'Ese mensaje ya salió: no lo mandes de nuevo.' : 'Es el mismo turno que ya tenías.' };
    }
    if (prev[0]?.estado === 'bloqueado') throw err('whatsapp_pausado', 'Ese mensaje terminó en un bloqueo de WhatsApp.', 423);

    // La persona: con número, no cerrada, fuera de las listas y sin respuestas sin leer.
    const p = await prospectoDe(c, clientId, a.prospecto_id);
    if (!p.whatsapp) throw err('whatsapp_sin_numero', 'La persona no tiene número de WhatsApp en el registro.');
    if (CERRADOS.has(p.estado)) throw err('prospecto_respondio', `La persona está en estado ${p.estado}: no se le escribe.`);
    const dominio = p.cuenta_id
      ? (await c.query(`select dominio from sdr.cuenta where client_id = $1 and id = $2`, [clientId, p.cuenta_id])).rows[0]?.dominio
      : null;
    const nc = await noContactar.coincidencias(c, clientId, [p.email, dominio]);
    if (nc.length) throw err('no_contactar', `El cliente pidió no escribirle a ${noContactar.describir(nc)}.`);
    if (p.email) {
      const { rowCount } = await c.query(`select 1 from sdr.supresion where client_id = $1 and email = $2`, [clientId, p.email]);
      if (rowCount) throw err('destinatario_suprimido', 'La persona pidió la baja o su mail rebotó: no se le escribe por ningún canal.');
    }
    const { rows: hist } = await c.query(
      `select exists (select 1 from sdr.evento where client_id = $1 and prospecto_id = $2 and tipo = 'respuesta') as respondio,
              exists (select 1 from sdr.whatsapp_envio where client_id = $1 and prospecto_id = $2 and estado = 'enviado') as con_chat,
              exists (select 1 from sdr.correo where client_id = $1 and prospecto_id = $2 and estado = 'nuevo')
                or exists (select 1 from sdr.linkedin_respuesta where client_id = $1 and prospecto_id = $2 and estado = 'nuevo') as sin_leer`,
      [clientId, p.id]);
    if (!hist[0].respondio && !hist[0].con_chat) {
      throw err('whatsapp_contacto_frio', 'Por WhatsApp sólo se le escribe a quien ya respondió por algún canal o ya tiene un chat ' +
        'con nosotros. Nunca a un número frío.');
    }
    if (hist[0].sin_leer) throw err('respuesta_sin_atender', 'La persona tiene una respuesta sin atender: la lee seguimiento antes.');

    // Nada repetido en 24 horas.
    const hash = hashTexto(a.texto);
    const { rowCount: repetido } = await c.query(
      `select 1 from sdr.whatsapp_envio where client_id = $1 and prospecto_id = $2 and texto_hash = $3
          and creado_at > now() - interval '24 hours' and (estado = 'enviado' or (estado = 'turno' and vence_at > now()))`,
      [clientId, p.id, hash]);
    if (repetido) throw err('whatsapp_repetido', 'Ese mismo texto ya le salió (o tiene turno) a esta persona en las últimas 24 horas.');

    // Topes del día.
    const tz = cfg.zona_horaria;
    const n = await contar(c, clientId, tz, p.id);
    if (n.contacto >= cfg.tope_contacto_dia) {
      throw err('whatsapp_tope', `Ya van ${n.contacto} mensajes hoy a esta persona (tope ${cfg.tope_contacto_dia}): seguí mañana.`, 429);
    }
    if (n.total >= cfg.tope_dia) throw err('whatsapp_tope', `Ya van ${n.total} mensajes hoy (tope del cliente ${cfg.tope_dia}): seguí mañana.`, 429);

    // Aprobación: el primer mensaje a cada persona y la respuesta a un positivo.
    const primero = !hist[0].con_chat;
    let necesita = null;
    if (ESTADOS_POSITIVO.includes(p.estado)) necesita = 'respuesta_positivo';
    else if (primero && cfg.aprobar_primero) necesita = 'whatsapp_primero';
    let aprobacion = null;
    if (necesita || a.aprobacion_id) {
      if (!a.aprobacion_id) {
        throw errorsSdr.aprobacionRequerida(necesita === 'whatsapp_primero'
          ? 'Es el primer WhatsApp a esta persona: necesita una aprobación whatsapp_primero con contenido.canal "whatsapp" y exactamente este texto.'
          : 'Es la respuesta a un positivo: necesita una aprobación respuesta_positivo con contenido.canal "whatsapp" y exactamente este texto.');
      }
      const { rows } = await c.query(`select * from sdr.aprobacion where client_id = $1 and id = $2`, [clientId, a.aprobacion_id]);
      aprobacion = rows[0];
      if (!aprobacion) throw errorsSdr.noExiste(`la aprobación ${a.aprobacion_id}`);
      if (necesita && aprobacion.tipo !== necesita) {
        throw errorsSdr.aprobacionRequerida(`La aprobación es de tipo ${aprobacion.tipo} y este mensaje necesita una de tipo ${necesita}.`);
      }
      if (!['respuesta_positivo', 'whatsapp_primero'].includes(aprobacion.tipo)) {
        throw errorsSdr.aprobacionRequerida(`La aprobación es de tipo ${aprobacion.tipo}: no habilita un WhatsApp.`);
      }
      if (aprobacion.estado !== 'aprobada') throw errorsSdr.aprobacionRequerida(`La aprobación está ${aprobacion.estado}: no se puede usar.`);
      const final = aprobacion.decision_contenido ?? aprobacion.contenido;
      const dif = [];
      if (final.canal !== 'whatsapp') dif.push(`el canal (la aprobación es para ${final.canal ?? 'mail'})`);
      if (normTexto(final.texto) !== normTexto(a.texto)) dif.push('el texto');
      if (aprobacion.prospecto_id !== p.id) dif.push('el prospecto');
      if (dif.length) {
        throw errorsSdr.aprobacionNoCoincide(`No coincide con lo aprobado: ${dif.join(', ')}. Mandá exactamente lo aprobado ` +
          '(si el operador lo editó, la versión editada está en decision_contenido).');
      }
    }

    // El turno: no antes del próximo libre, y dentro del horario.
    const ahora = new Date();
    const desde = cfg.proximo_turno_at && new Date(cfg.proximo_turno_at) > ahora ? new Date(cfg.proximo_turno_at) : ahora;
    if (!enVentana(cfg, tz, ahora) || !enVentana(cfg, tz, desde)) {
      throw err('whatsapp_fuera_de_horario', `Por WhatsApp se manda sólo ${ventanaTexto(cfg)} (hora del cliente). ` +
        'Dejalo para la próxima pasada dentro del horario.');
    }
    const pausa = cfg.pausa_min_seg + Math.round(azar() * (cfg.pausa_max_seg - cfg.pausa_min_seg));
    const proximo = new Date(desde.getTime() + pausa * 1000);
    const vence = new Date(desde.getTime() + VIGENCIA_MIN * 60_000);
    await c.query(`update sdr.whatsapp_config set proximo_turno_at = $2 where client_id = $1`, [clientId, proximo]);
    const valores = [clientId, a.idempotency_key, p.id, a.texto, hash, desde, vence, a.aprobacion_id ?? null];
    const { rows: env } = prev[0]
      ? await c.query(
        `update sdr.whatsapp_envio set prospecto_id = $3, texto = $4, texto_hash = $5, enviar_desde = $6, vence_at = $7,
                aprobacion_id = $8, estado = 'turno', resultado = null, creado_at = now()
          where client_id = $1 and clave = $2 returning *`, valores)
      : await c.query(
        `insert into sdr.whatsapp_envio (client_id, clave, prospecto_id, texto, texto_hash, enviar_desde, vence_at, aprobacion_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`, valores);
    return {
      ...publico(env[0]), repetido: false, numero: p.whatsapp, primero,
      ritual: {
        abrir_chat: 'Abrí el chat de ese número (queda en visto lo que haya escrito).',
        escribiendo_seg: escribiendoSeg(a.texto, azar),
        pasos: 'Esperá espera_segundos; abrí el chat; escribí el texto de a poco durante escribiendo_seg segundos; mandalo; ' +
          'después llamá whatsapp_resultado con este envio_id.',
      },
      hoy: { contacto: n.contacto + 1, total: n.total + 1, tope_contacto: cfg.tope_contacto_dia, tope_dia: cfg.tope_dia },
    };
  });
}

// ---------------------------------------------------------------- resultado

export async function resultado(clientId, a, meta) {
  const r = await asClient(clientId, async (c) => {
    const { rows } = await c.query(`select * from sdr.whatsapp_envio where client_id = $1 and id = $2 for update`, [clientId, a.envio_id]);
    const e = rows[0];
    if (!e) throw errorsSdr.noExiste(`el envío de WhatsApp ${a.envio_id}`);
    if (e.estado === a.resultado) return { envio: publico(e), repetido: true };
    if (e.estado !== 'turno') throw err('invalid_request', `Ese envío ya está ${e.estado}: no se puede cambiar.`, 409);
    const detalle = a.detalle ?? null;
    if (a.resultado === 'enviado') {
      if (new Date(e.enviar_desde) - Date.now() > 5000) {
        throw err('whatsapp_antes_de_turno', 'Todavía no era el turno de este mensaje: respetá espera_segundos antes de mandarlo.', 409);
      }
      const { rows: u } = await c.query(
        `update sdr.whatsapp_envio set estado = 'enviado', enviado_at = now(), resultado = $3 where client_id = $1 and id = $2 returning *`,
        [clientId, e.id, detalle]);
      const ev = { tipo: 'whatsapp.enviado', canal: 'whatsapp', prospecto_id: e.prospecto_id, ref: `whatsapp:${e.id}`,
        datos: { texto: e.texto, envio: Number(e.id), ...(e.aprobacion_id ? { aprobacion: e.aprobacion_id } : {}) } };
      await insertarEvento(c, clientId, ev, { ...meta, version: await versionActual(c, clientId) });
      await aplicarEvento(c, clientId, ev);
      if (e.aprobacion_id) {
        await c.query(`update sdr.aprobacion set estado = 'usada', usada_at = now(), usada_clave = $3
                        where client_id = $1 and id = $2 and estado = 'aprobada'`, [clientId, e.aprobacion_id, e.clave]);
      }
      return { envio: publico(u[0]), repetido: false };
    }
    if (a.resultado === 'fallido') {
      const { rows: u } = await c.query(`update sdr.whatsapp_envio set estado = 'fallido', resultado = $3 where client_id = $1 and id = $2 returning *`,
        [clientId, e.id, detalle]);
      return { envio: publico(u[0]), repetido: false };
    }
    // Bloqueo: se frena todo el WhatsApp del cliente, no sólo este chat.
    const { rows: u } = await c.query(`update sdr.whatsapp_envio set estado = 'bloqueado', resultado = $3 where client_id = $1 and id = $2 returning *`,
      [clientId, e.id, detalle]);
    await c.query(
      `update sdr.whatsapp_config set pausado = true, pausado_at = now(), pausa_motivo = $2 where client_id = $1`,
      [clientId, `WhatsApp avisó un bloqueo${detalle ? `: ${detalle}` : ''}`.slice(0, 500)]);
    await c.query(`update sdr.whatsapp_envio set estado = 'vencido' where client_id = $1 and estado = 'turno'`, [clientId]);
    return { envio: publico(u[0]), repetido: false, pausado: true };
  });
  if (r.pausado) {
    await pedir(clientId, {
      para_bot: 'orquestador',
      que: `WhatsApp quedó en pausa: al mandar un mensaje, WhatsApp avisó un bloqueo o un tope${a.detalle ? ` («${a.detalle}»)` : ''}. ` +
        'No sale nada más por WhatsApp hasta que Biguá lo revise y lo reanude en el panel (Canales → WhatsApp). ' +
        'Contáselo al operador en el chat ahora.',
      por_que: 'Bloqueo de WhatsApp detectado por el bot whatsapp.',
    }, { bot: meta?.bot ?? 'whatsapp' }).catch((e) => console.error('[mailgw] aviso de bloqueo de WhatsApp', e.message));
    r.aviso = 'WhatsApp quedó en pausa para todo el cliente y el orquestador le avisa al operador. No intentes por otro lado.';
  }
  return r;
}

// ---------------------------------------------------------------- estado

export async function estado(clientId) {
  return asClient(clientId, async (c) => {
    const cfg = await configDe(c, clientId);
    if (!cfg) return { activo: false };
    const n = await contar(c, clientId, cfg.zona_horaria, null);
    return {
      activo: cfg.activo, numero: cfg.numero, pausado: cfg.pausado, pausa_motivo: cfg.pausa_motivo, pausado_at: cfg.pausado_at,
      horario: ventanaTexto(cfg), en_horario: enVentana(cfg, cfg.zona_horaria), zona_horaria: cfg.zona_horaria,
      pausa_entre_envios_seg: [cfg.pausa_min_seg, cfg.pausa_max_seg],
      hoy: { enviados: n.total, tope_dia: cfg.tope_dia, tope_contacto: cfg.tope_contacto_dia },
      aprobar_primero: cfg.aprobar_primero, proximo_turno_at: cfg.proximo_turno_at,
    };
  });
}

// ---------------------------------------------------------------- panel (Biguá)

const CAMPOS = ['activo', 'numero', 'hora_desde', 'hora_hasta', 'dias', 'pausa_min_seg', 'pausa_max_seg', 'tope_contacto_dia',
  'tope_dia', 'aprobar_primero'];

export async function ver(c, clientId) {
  const { rows } = await c.query(`select * from sdr.whatsapp_config where client_id = $1`, [clientId]);
  return rows[0] ?? null;
}

export async function configurar(clientId, d) {
  return asOwner(async (c) => {
    const cols = CAMPOS.filter((k) => d[k] !== undefined);
    await c.query(`insert into sdr.whatsapp_config (client_id) values ($1) on conflict (client_id) do nothing`, [clientId]);
    if (cols.length) {
      await c.query(`update sdr.whatsapp_config set ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, actualizado_at = now()
                      where client_id = $1`, [clientId, ...cols.map((k) => d[k])]);
    }
    if (d.reanudar) {
      await c.query(`update sdr.whatsapp_config set pausado = false, pausa_motivo = null, pausado_at = null, actualizado_at = now()
                      where client_id = $1`, [clientId]);
    }
    return ver(c, clientId);
  });
}
