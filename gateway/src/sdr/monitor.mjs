// El monitor de actividad de un cliente (pestaña Actividad del panel, docs/21 y docs/22): a la
// izquierda, cada canal o proceso con su modo (supervisado: hace falta el OK del operador; autónomo:
// sale solo); a la derecha, lo que pasó hoy, en orden, con su estado (ejecutado, esperando OK o
// error). Sólo lee; el modo se cambia donde siempre (calibración en Administración, aprobación del
// primer WhatsApp en Canales).

import { asRole } from '../store.mjs';
import * as whatsapp from './whatsapp.mjs';

const asClient = (clientId, fn) => asRole('mailgw_app', clientId, fn);
const MAX = 300;

const quien = (r) => (r.prospecto ? `${r.prospecto}${r.cuenta ? ` (${r.cuenta})` : ''}` : r.cuenta ?? 'sin nombre');
const CANAL_RESPUESTA = { mail: 'correo', linkedin: 'linkedin', whatsapp: 'whatsapp' };
const CANAL_APROBACION = { calibracion_mail: 'correo', respuesta_positivo: 'respuestas', whatsapp_primero: 'whatsapp',
  crm_mapeo: 'crm', crm_cambio: 'crm' };
const QUE_APROBACION = { calibracion_mail: 'primer contacto', respuesta_positivo: 'respuesta a un interesado',
  whatsapp_primero: 'primer WhatsApp', crm_mapeo: 'mapeo del CRM', crm_cambio: 'cambio en el CRM', otro: 'consulta' };

// Una fila de sdr.evento (con el nombre del prospecto y de la cuenta) → una línea del monitor.
// pendientes: ids de aprobaciones que siguen esperando.
export function linea(r, pendientes = new Set()) {
  const d = r.datos ?? {};
  const ok = (canal, texto) => ({ at: r.at, estado: 'ok', canal, texto });
  const mal = (canal, texto) => ({ at: r.at, estado: 'error', canal, texto });
  switch (r.tipo) {
    case 'cuenta.investigada': return ok('prospección', `cuenta investigada: ${d.nombre ?? r.cuenta ?? ''}`.trim());
    case 'cuenta.excluida': return ok('prospección', `cuenta excluida: ${r.cuenta ?? ''}${d.motivo ? ` · ${d.motivo}` : ''}`);
    case 'prospecto.revelado': return ok('prospección', `contacto revelado: ${quien(r)}`);
    case 'mail.enviado': return ok('correo', `${d.respuesta ? 'respuesta' : 'mail'} a ${quien(r)}${d.asunto ? ` · «${d.asunto}»` : ''}`);
    case 'mail.rebotado': return mal('correo', `rebotó el mail a ${quien(r)}`);
    case 'linkedin.cargado': return ok('linkedin', `${quien(r)} cargado en la campaña`);
    case 'linkedin.invitacion': return ok('linkedin', `invitación enviada a ${quien(r)}`);
    case 'linkedin.conexion': return ok('linkedin', `${quien(r)} aceptó la invitación`);
    case 'linkedin.mensaje': return ok('linkedin', `mensaje a ${quien(r)}`);
    case 'linkedin.pausado': return ok('linkedin', `${quien(r)} frenado en Dripify${d.motivo ? ` · ${d.motivo}` : ''}`);
    case 'linkedin.bloqueado': return mal('linkedin', `LinkedIn bloqueó a ${quien(r)}`);
    case 'whatsapp.enviado': return ok('whatsapp', `WhatsApp a ${quien(r)}`);
    case 'respuesta': return ok(CANAL_RESPUESTA[r.canal] ?? 'respuestas', `respondió ${quien(r)}`);
    case 'positivo': return ok('respuestas', `interesado: ${quien(r)}`);
    case 'crm.cargado': return ok('crm', `${quien(r)} cargado en el CRM`);
    case 'baja': return ok('respuestas', `pidió la baja: ${quien(r)}`);
    case 'aprobacion.pedida': {
      const canal = CANAL_APROBACION[d.tipo] ?? 'aprobaciones';
      const que = `${QUE_APROBACION[d.tipo] ?? 'aprobación'} a ${quien(r)}`;
      return pendientes.has(d.aprobacion)
        ? { at: r.at, estado: 'espera', canal, texto: `${que} · esperando OK` }
        : ok(canal, `${que} · pedido de OK`);
    }
    case 'aprobacion.decidida':
      return d.decision === 'aprobada'
        ? ok('aprobaciones', `aprobado${d.operador ? ` por ${d.operador}` : ''}${d.editada ? ' con cambios' : ''} · ${quien(r)}`)
        : mal('aprobaciones', `rechazado${d.operador ? ` por ${d.operador}` : ''} · ${quien(r)}`);
    case 'aviso.cliente': return ok('respuestas', `aviso al cliente sobre ${quien(r)}`);
    case 'nota': return ok('registro', `nota sobre ${quien(r)}`);
    default: return null;
  }
}

// Los procesos de la izquierda, con su modo.
export function canales({ cfg, calibracion, buzones, dripify, wa }) {
  const bots = cfg?.bots_activos ?? [];
  const calibrando = calibracion.total > calibracion.usados;
  const modoEnvio = calibrando ? 'supervisado' : 'autonomo';
  const calTexto = calibrando ? `calibración ${calibracion.usados} de ${calibracion.total}` : 'calibración terminada';
  const activos = buzones.filter((b) => b.status === 'active').length;
  const out = [
    { clave: 'prospeccion', titulo: 'Prospección', ruta: 'ASCI → registro', modo: bots.includes('prospector') ? 'autonomo' : 'apagado',
      detalle: cfg?.ajustes?.cuentas_por_dia ? `${cfg.ajustes.cuentas_por_dia} cuentas nuevas por día` : 'cuentas nuevas con aviso reciente' },
    { clave: 'correo', titulo: 'Correo', ruta: 'buzones → prospectos', modo: activos ? modoEnvio : 'apagado',
      detalle: activos ? `${activos} ${activos === 1 ? 'buzón' : 'buzones'} · ${calTexto}` : 'sin buzones activos' },
    { clave: 'linkedin', titulo: 'LinkedIn', ruta: 'Dripify → prospectos',
      modo: dripify?.cargado && dripify.activo ? modoEnvio : 'apagado',
      detalle: !dripify?.cargado ? 'sin cargar' : dripify.ultimo_error ? `con error: ${dripify.ultimo_error}` : calTexto },
    { clave: 'whatsapp', titulo: 'WhatsApp', ruta: 'WhatsApp Web · seguimiento',
      modo: !wa?.activo || !bots.includes('whatsapp') ? 'apagado' : wa.aprobar_primero ? 'supervisado' : 'autonomo',
      pausado: Boolean(wa?.pausado),
      detalle: !wa?.activo ? 'no activado' : wa.pausado ? `en pausa: ${wa.pausa_motivo ?? 'bloqueo'}`
        : `${wa.hoy.enviados} de ${wa.hoy.tope_dia} hoy · ${wa.aprobar_primero ? 'primer mensaje con OK' : 'sin OK previo'}` },
    { clave: 'respuestas', titulo: 'Respuesta a interesados', ruta: 'seguimiento → canal del prospecto',
      modo: bots.includes('seguimiento') ? 'supervisado' : 'apagado', detalle: 'siempre con el OK del operador' },
  ];
  return out;
}

// Todo lo del monitor que vive en el registro, leído con el rol de la aplicación.
export async function leer(clientId, { cfg, buzones }) {
  return asClient(clientId, async (c) => {
    const tz = cfg?.zona_horaria ?? 'America/Argentina/Buenos_Aires';
    const { rows: pend } = await c.query(`select id from sdr.aprobacion where client_id = $1 and estado = 'pendiente'`, [clientId]);
    const pendientes = new Set(pend.map((x) => x.id));
    const { rows } = await c.query(
      `select * from (
         select e.id, e.at, e.tipo, e.canal, e.datos, p.nombre as prospecto, coalesce(k.nombre, k2.nombre) as cuenta
           from sdr.evento e
           left join sdr.prospecto p on p.id = e.prospecto_id and p.client_id = e.client_id
           left join sdr.cuenta k on k.id = p.cuenta_id and k.client_id = e.client_id
           left join sdr.cuenta k2 on k2.id = e.cuenta_id and k2.client_id = e.client_id
          where e.client_id = $1 and not e.interno
            and e.at >= (date_trunc('day', now() at time zone $2) at time zone $2)
          order by e.id desc limit $3) x order by id`, [clientId, tz, MAX]);
    const { rows: usadas } = await c.query(
      `select count(*)::int as n from sdr.aprobacion where client_id = $1 and tipo = 'calibracion_mail' and estado = 'usada'`, [clientId]);
    const dripify = (await c.query(
      `select (api_key_enc is not null) as cargado, activo, ultimo_error from sdr.dripify_cuenta where client_id = $1`, [clientId])).rows[0] ?? null;
    return {
      zona_horaria: tz,
      eventos: rows.map((r) => linea(r, pendientes)).filter(Boolean),
      esperando_ok: pendientes.size,
      calibracion: { usados: Math.min(usadas[0].n, cfg?.calibracion_mails ?? 0), total: cfg?.calibracion_mails ?? 0 },
      dripify,
      buzones,
    };
  }).then(async (r) => ({ ...r, wa: await whatsapp.estado(clientId) }));
}
