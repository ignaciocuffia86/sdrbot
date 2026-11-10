// La campaña de cada cosa del registro y lo que el gateway hace cumplir por campaña (docs/21 §4.3
// y §6.2; etapa C1). Las herramientas MCP reciben `campana` (la clave, «principal»,
// «webinar-2026-11»…) como opcional: sin ella vale la campaña del prospecto o, si no hay
// prospecto, la «principal». Así los bots que todavía no conocen las campañas siguen andando.
//
// Todas las funciones reciben la conexión de quien llama (el rol de la aplicación con el cliente
// fijado): las políticas de la base ya dejan ver sólo las campañas de ese cliente.

import { GatewayError } from '../errors.mjs';
import { ajustesEfectivos } from './ajustes.mjs';

export const errorsCampana = {
  noExiste: (clave) => new GatewayError('no_existe', `No existe la campaña «${clave}» para este cliente.`, 404),
  inactiva: (k, que) => new GatewayError('campana_inactiva',
    `La campaña «${k.nombre}» está ${k.estado}: ${que}. Si tiene que seguir, la activa Biguá en el panel.`, 409),
  otra: (msg) => new GatewayError('en_otra_campana', msg, 409),
  buzon: (email, k) => new GatewayError('buzon_fuera_de_campana',
    `El buzón ${email} no es de la campaña «${k.nombre}»: usá uno de sus buzones (los ves en «Buzones y firmas»).`, 422),
  links: (urls, k) => new GatewayError('link_no_permitido',
    `El mail lleva links que la campaña «${k.nombre}» no permite: ${urls.join(', ')}. Sacalos: sólo van los links ` +
    'permitidos de la campaña, el link de agenda (en la respuesta a un positivo) y los de las firmas.', 422),
};

const COLS = `id, client_id, clave, nombre, tipo, estado, ajustes, dripify_campana_id, cuentas_por_dia, calibracion_mails`;

export async function porClave(c, clientId, clave) {
  const { rows } = await c.query(`select ${COLS} from sdr.campana where client_id = $1 and clave = $2`, [clientId, clave]);
  if (!rows.length) throw errorsCampana.noExiste(clave);
  return rows[0];
}

export async function porId(c, clientId, id) {
  const { rows } = await c.query(`select ${COLS} from sdr.campana where client_id = $1 and id = $2`, [clientId, id]);
  if (!rows.length) throw errorsCampana.noExiste(id);
  return rows[0];
}

// La «principal» del cliente (la crea si falta: sdr.campana_principal, migración 012).
export async function principal(c, clientId) {
  const { rows } = await c.query(`select sdr.campana_principal($1) as id`, [clientId]);
  return porId(c, clientId, rows[0].id);
}

// La campaña de un pedido o una herramienta: la clave que mandó el bot, la del prospecto o la
// «principal». Si el bot mandó una clave y el prospecto es de otra campaña, es un error: una
// persona está en una sola campaña.
export async function resolver(c, clientId, { clave, prospecto } = {}) {
  if (clave) {
    const k = await porClave(c, clientId, clave);
    if (prospecto && prospecto.campana_id && prospecto.campana_id !== k.id) {
      const suya = await porId(c, clientId, prospecto.campana_id);
      throw errorsCampana.otra(`${prospecto.nombre ?? 'Esta persona'} es de la campaña «${suya.nombre}», no de «${k.nombre}».`);
    }
    return k;
  }
  if (prospecto?.campana_id) return porId(c, clientId, prospecto.campana_id);
  return principal(c, clientId);
}

// ---------------------------------------------------------------- los ajustes de una campaña

// Las claves de la campaña que, hasta la migración 014, también siguen en Empresa: el formulario de
// Empresa del panel las edita ahí. Mientras estén, la «principal» las toma de Empresa (lo que el
// cliente ve y edita hoy); cuando la 014 las saque, vale lo de la campaña sin tocar este código.
// «oferta» de Empresa es la «propuesta» de la principal.
const LEGADO_EMPRESA = ['icp', 'roles_objetivo', 'senal_avisos', 'dias_aviso', 'llamado_accion', 'links_permitidos', 'positivos'];

function deLaCampana(cfg, k) {
  if (k.clave !== 'principal') return k.ajustes ?? {};
  const e = cfg?.ajustes ?? {};
  const legado = Object.fromEntries(LEGADO_EMPRESA.filter((x) => e[x] !== undefined).map((x) => [x, e[x]]));
  if (e.oferta !== undefined) legado.propuesta = e.oferta;
  return { ...(k.ajustes ?? {}), ...legado };
}

// Los ajustes con los que trabaja la campaña: los mismos para las reglas que leen los bots y para
// lo que hace cumplir el gateway.
export const efectivos = (cfg, k) => ajustesEfectivos(cfg?.ajustes ?? {}, deLaCampana(cfg, k), k.tipo);

// Las cuentas nuevas por día de la campaña. La «principal», mientras Empresa tenga
// cuentas_por_dia (hasta la 014), usa ése: es el que edita el formulario de Empresa.
export const cuentasPorDia = (cfg, k) => (k.clave === 'principal' && Number.isInteger(cfg?.ajustes?.cuentas_por_dia)
  ? cfg.ajustes.cuentas_por_dia : k.cuentas_por_dia);

export function exigirActiva(k, que) {
  if (k.estado !== 'activa') throw errorsCampana.inactiva(k, que);
}

// Calibración por campaña (decisión 4). La «principal» sigue con la calibración del cliente
// (Administración → Operación), como hasta ahora; las demás, con la suya.
export async function calibracion(c, clientId, k, cfg) {
  const total = k.clave === 'principal' ? (cfg?.calibracion_mails ?? k.calibracion_mails) : k.calibracion_mails;
  const { rows } = await c.query(
    `select count(*)::int as n from sdr.aprobacion
      where client_id = $1 and campana_id = $2 and tipo = 'calibracion_mail' and estado = 'usada'`, [clientId, k.id]);
  return { usadas: rows[0].n, total, calibrando: rows[0].n < total };
}

// Si el buzón no existe, no es asunto de la campaña: el envío lo rechaza después con
// mailbox_not_found.
export async function buzonEnCampana(c, clientId, k, email) {
  const { rowCount: existe } = await c.query(`select 1 from mailgw.account where client_id = $1 and email = lower($2)`, [clientId, email]);
  if (!existe) return true;
  const { rowCount } = await c.query(
    `select 1 from sdr.campana_buzon b join mailgw.account a on a.id = b.account_id and a.client_id = b.client_id
      where b.client_id = $1 and b.campana_id = $2 and a.email = lower($3)`, [clientId, k.id, email]);
  return rowCount > 0;
}

// ---------------------------------------------------------------- links

const URL_EN_TEXTO = /\b(?:https?:\/\/|www\.)[^\s<>"'()[\]{}]+/gi;
const limpiar = (u) => u.replace(/[.,;:!?»”’]+$/, '');

function normalizar(u) {
  try {
    const x = new URL(/^www\./i.test(u) ? `https://${u}` : u);
    return { host: x.hostname.toLowerCase().replace(/^www\./, ''), url: `${x.hostname.toLowerCase().replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}${x.search}` };
  } catch {
    return null;
  }
}

export function linksDe(texto) {
  return [...new Set((String(texto ?? '').match(URL_EN_TEXTO) ?? []).map(limpiar))];
}

// Los links de un mail que la campaña no permite. Valen: los links permitidos de la campaña
// (exactos o algo debajo de ellos), el link de agenda que le corresponde a la campaña y cualquier
// link de los dominios que aparecen en las firmas (la del buzón y la de Empresa).
export async function linksNoPermitidos(c, clientId, k, cfg, { textos, buzon }) {
  const encontrados = textos.flatMap(linksDe);
  if (!encontrados.length) return [];
  const { valores } = efectivos(cfg, k);
  const permitidos = [...(valores.links_permitidos ?? []), ...(valores.link_agenda ? [valores.link_agenda] : [])]
    .map(normalizar).filter(Boolean);
  const { rows } = await c.query(`select firma from mailgw.account where client_id = $1 and email = lower($2)`, [clientId, buzon ?? '']);
  const firmas = [rows[0]?.firma, cfg?.ajustes?.firma].filter(Boolean);
  const hostsFirma = new Set(firmas.flatMap(linksDe).map(normalizar).filter(Boolean).map((x) => x.host));
  return encontrados.filter((u) => {
    const n = normalizar(u);
    if (!n) return true;
    if (hostsFirma.has(n.host)) return false;
    return !permitidos.some((p) => n.url === p.url || n.url.startsWith(`${p.url}/`) || n.url.startsWith(`${p.url}?`));
  });
}

// ---------------------------------------------------------------- una persona, una campaña

// Estados en los que una persona todavía no está en contacto activo: se la puede pasar a otra
// campaña. Las demás, sólo si su campaña ya no está activa.
const LIBRES = new Set(['investigado', 'descartado', 'sin_respuesta']);

export async function controlarCambio(c, clientId, prospecto, destino) {
  if (!prospecto.campana_id || prospecto.campana_id === destino.id) return;
  const actual = await porId(c, clientId, prospecto.campana_id);
  if (actual.estado === 'activa' && !LIBRES.has(prospecto.estado)) {
    throw errorsCampana.otra(`${prospecto.nombre ?? 'Esta persona'} ya está en contacto por la campaña «${actual.nombre}» ` +
      `(estado ${prospecto.estado}): no se la pasa a «${destino.nombre}». Una persona está en una sola campaña activa.`);
  }
}

// Una cuenta en contacto por una campaña de prospección activa no entra en otra de prospección
// (§4.3). Las de evento pueden escribirle a otra persona de esa cuenta.
export async function controlarCuenta(c, clientId, cuenta, destino) {
  if (!cuenta?.campana_id || cuenta.campana_id === destino.id || destino.tipo !== 'prospeccion') return;
  if (cuenta.estado !== 'en_contacto') return;
  const actual = await porId(c, clientId, cuenta.campana_id);
  if (actual.estado === 'activa' && actual.tipo === 'prospeccion') {
    throw errorsCampana.otra(`La cuenta ${cuenta.nombre} está en contacto por la campaña «${actual.nombre}»: no entra en ` +
      `«${destino.nombre}» hasta que esa termine con ella.`);
  }
}
