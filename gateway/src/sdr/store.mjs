// Datos del núcleo SDR: reglas, registro de prospección, pedidos, aprobaciones y bitácora.
//
// Todo lo que es de un cliente corre con el rol mailgw_app y el cliente fijado (asRole): las
// políticas de la base (migración 005) dejan ver y escribir sólo las filas de ese cliente,
// aunque una consulta de acá se olvide de filtrar.

import { asRole, asOwner } from '../store.mjs';
import { errors, GatewayError } from '../errors.mjs';
import { ordenar, tituloDe } from './ajustes.mjs';

const asClient = (clientId, fn) => asRole('mailgw_app', clientId, fn);

export const INTERNOS = new Set(['pedido', 'decision']);
const SALIENTES = new Set(['mail.enviado', 'linkedin.cargado', 'linkedin.invitacion', 'linkedin.mensaje', 'whatsapp.enviado']);
const FINALES = ['descartado', 'baja', 'negativo', 'en_crm'];

export const errorsSdr = {
  sinReglas: () => new GatewayError('sin_reglas', 'No hay reglas publicadas para este cliente. Avisar a Biguá.', 503),
  noExiste: (que) => new GatewayError('no_existe', `No existe ${que} para este cliente.`, 404),
  aprobacionRequerida: (msg) => new GatewayError('aprobacion_requerida', msg, 409),
  aprobacionNoCoincide: (msg) => new GatewayError('aprobacion_no_coincide', msg, 422),
};

export function hoyEn(tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

// ---------------------------------------------------------------- configuración y versión

async function configDe(c, clientId) {
  const { rows } = await c.query(`select * from sdr.cliente_config where client_id = $1`, [clientId]);
  return rows[0] ?? null;
}

async function versionDe(c, cfg) {
  if (cfg?.version_fija) return cfg.version_fija;
  const { rows } = await c.query(`select version from sdr.playbook_canal where canal = $1`, [cfg?.canal ?? 'estable']);
  if (!rows.length) throw errorsSdr.sinReglas();
  return rows[0].version;
}

export async function config(clientId) {
  return asClient(clientId, (c) => configDe(c, clientId));
}

// ---------------------------------------------------------------- reglas

export function renderAjustes(clientId, nombreCliente, cfg) {
  const lineas = [`Cliente: ${nombreCliente} (\`${clientId}\`).`];
  if (!cfg) {
    lineas.push('', 'Este cliente todavía no tiene ajustes cargados. No prospectes ni envíes: avisá al orquestador.');
    return lineas.join('\n');
  }
  lineas.push(`Bots activos: ${cfg.bots_activos.join(', ')}. Zona horaria: ${cfg.zona_horaria}.`);
  lineas.push(cfg.calibracion_mails > 0
    ? `Calibración: los primeros ${cfg.calibracion_mails} mails nuevos necesitan aprobación registrada; el gateway los rechaza sin ella.`
    : 'Calibración: terminada. Los mails nuevos salen sin aprobación previa.');
  for (const [k, v] of Object.entries(ordenar(cfg.ajustes ?? {}))) {
    lineas.push('', `### ${tituloDe(k).replace(/_/g, ' ')}`, '');
    if (typeof v === 'string') lineas.push(v);
    else if (typeof v === 'number') lineas.push(String(v));
    else if (typeof v === 'boolean') lineas.push(v ? 'Sí' : 'No');
    else if (Array.isArray(v) && v.every((x) => typeof x === 'string')) lineas.push(...v.map((x) => `- ${x}`));
    else lineas.push('```json', JSON.stringify(v, null, 2), '```');
  }
  return lineas.join('\n');
}

export async function manual(clientId, bot, tarea, seccion) {
  return asClient(clientId, async (c) => {
    const cfg = await configDe(c, clientId);
    const version = await versionDe(c, cfg);
    const { rows: cli } = await c.query(`select name from mailgw.client where id = $1`, [clientId]);
    const { rows } = await c.query(
      `select bot, tarea, orden, seccion, titulo, resumen, contenido from sdr.playbook_seccion
        where version = $1 and bot in ('*', $2) and tarea in ('*', $3)
          and not (bot = '*' and tarea = 'rutina')
        order by (bot = '*') desc, (tarea = '*') desc, orden`, [version, bot, tarea]);
    const ajustes = {
      bot: '-', tarea: '-', seccion: 'ajustes-cliente', titulo: 'Ajustes de este cliente',
      resumen: 'ICP, oferta, tono, firma, campañas, calibración: lo propio de este cliente.',
      contenido: renderAjustes(clientId, cli[0]?.name ?? clientId, cfg),
    };
    const todas = [...rows, ajustes];
    if (seccion) {
      const s = todas.find((x) => x.seccion === seccion);
      if (!s) throw errorsSdr.noExiste(`la sección "${seccion}" para ${bot}/${tarea}`);
      return { version, bot, tarea, seccion: s.seccion, titulo: s.titulo, contenido: s.contenido };
    }
    if (!rows.some((r) => r.bot === bot)) throw errorsSdr.noExiste(`un manual para el bot "${bot}" (tarea "${tarea}")`);
    return {
      version, bot, tarea,
      instruccion: 'Este es el índice. Pedí cada sección que necesites con reglas_manual(bot, tarea, seccion), ' +
        'en orden. Las secciones «comunes» valen para todos los bots.',
      indice: todas.map((r) => ({
        seccion: r.seccion, titulo: r.titulo, resumen: r.resumen,
        alcance: r.bot === '*' ? 'comun' : r.bot === '-' ? 'cliente' : r.tarea === '*' ? 'bot' : 'tarea',
      })),
    };
  });
}

export async function alta(clientId) {
  return asClient(clientId, async (c) => {
    const cfg = await configDe(c, clientId);
    if (!cfg) throw errorsSdr.noExiste('la configuración del SDR (cargarla en el panel o con la CLI antes del alta)');
    const version = await versionDe(c, cfg);
    const { rows: cli } = await c.query(`select name from mailgw.client where id = $1`, [clientId]);
    const nombre = cli[0]?.name ?? clientId;
    const { rows: tpl } = await c.query(
      `select contenido from sdr.playbook_seccion where version = $1 and bot = '*' and tarea = 'rutina' and seccion = 'plantilla'`,
      [version]);
    if (!tpl.length) throw errorsSdr.sinReglas();
    const { rows } = await c.query(
      `select bot, nombre, tarea, cron, timing, disparo, descripcion, etapa from sdr.playbook_rutina
        where version = $1 and bot = any($2) order by bot, nombre`, [version, cfg.bots_activos]);
    const render = (r) => tpl[0].contenido
      .replaceAll('{bot}', r.bot).replaceAll('{tarea}', r.tarea).replaceAll('{cliente}', nombre)
      .replaceAll('{cliente_id}', clientId).replaceAll('{descripcion}', r.descripcion);
    return {
      version, cliente: nombre, cliente_id: clientId, zona_horaria: cfg.zona_horaria,
      instrucciones: 'Creá una routine por ítem en el bot indicado, con el cron en la zona horaria del cliente, ' +
        'el timing indicado y exactamente este prompt. Si una routine con ese nombre ya existe, actualizala en vez ' +
        'de duplicarla. Las de disparo webhook: anotá la URL y la clave que te dé Grok y pasáselas al operador.',
      rutinas: rows.map((r) => ({
        bot: r.bot, nombre: r.nombre, cron: r.cron, timing: r.timing, disparo: r.disparo, prompt: render(r),
      })),
    };
  });
}

// ---------------------------------------------------------------- eventos

export async function insertarEvento(c, clientId, e, meta = {}) {
  const { rows } = await c.query(
    `insert into sdr.evento (client_id, prospecto_id, cuenta_id, tipo, canal, datos, ref, interno, bot, tarea, corrida, version_reglas)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id, at`,
    [clientId, e.prospecto_id ?? null, e.cuenta_id ?? null, e.tipo, e.canal ?? null, JSON.stringify(e.datos ?? {}),
      e.ref ?? null, INTERNOS.has(e.tipo), meta.bot ?? null, meta.tarea ?? null, meta.corrida ?? null, meta.version ?? null]);
  return rows[0];
}

// Lo que un evento cambia en el prospecto, para que el estado y la agenda no dependan de que
// cada bot se acuerde de actualizarlos.
export async function aplicarEvento(c, clientId, e) {
  if (!e.prospecto_id) return;
  if (SALIENTES.has(e.tipo) || e.tipo === 'respuesta') {
    await c.query(
      `update sdr.prospecto
          set ultima_interaccion_at = now(), ultima_interaccion_canal = $3,
              canales = case when $3::text is null or $3 = any(canales) then canales else canales || $3::text end,
              estado = case when $4 and estado = 'investigado' then 'en_contacto'
                            when $5 and estado in ('en_contacto', 'sin_respuesta', 'en_pausa') then 'respondio'
                            else estado end,
              actualizado_at = now()
        where client_id = $1 and id = $2`,
      [clientId, e.prospecto_id, e.canal ?? null, SALIENTES.has(e.tipo), e.tipo === 'respuesta']);
  }
  const estado = { positivo: 'positivo', baja: 'baja', 'crm.cargado': 'en_crm' }[e.tipo];
  if (estado) {
    await c.query(`update sdr.prospecto set estado = $3, actualizado_at = now() where client_id = $1 and id = $2`,
      [clientId, e.prospecto_id, estado]);
  }
  // Una baja o un rebote: a esa dirección no se le escribe más desde ningún buzón del cliente.
  if (e.tipo === 'baja' || e.tipo === 'mail.rebotado') {
    await c.query(
      `insert into sdr.supresion (client_id, email, motivo, origen)
       select client_id, email, $3, $4 from sdr.prospecto where client_id = $1 and id = $2 and email is not null
       on conflict (client_id, email) do nothing`,
      [clientId, e.prospecto_id, e.tipo === 'baja' ? 'baja' : 'rebote', `evento ${e.tipo}`]);
  }
  // Freno cruzado: si responde por mail o pide la baja, LinkedIn no le sigue escribiendo. El
  // pedido a Dripify sale después de la transacción (dripify.frenarPendientes): acá sólo se marca.
  // Una respuesta por LinkedIn no hace falta: Dripify corta la secuencia solo.
  if ((e.tipo === 'respuesta' && e.canal !== 'linkedin') || e.tipo === 'baja') {
    await c.query(
      `update sdr.prospecto
          set dripify = dripify || jsonb_build_object('freno', jsonb_build_object('pendiente', true, 'motivo', $3::text, 'desde', now()))
        where client_id = $1 and id = $2 and dripify->>'estado' = 'cargado' and not (dripify ? 'freno')`,
      [clientId, e.prospecto_id, e.tipo === 'baja' ? 'pidió la baja' : `respondió por ${e.canal ?? 'otro canal'}`]);
  }
  if (e.tipo === 'crm.cargado' && e.ref) {
    await c.query(`update sdr.prospecto set crm_id = $3 where client_id = $1 and id = $2`, [clientId, e.prospecto_id, e.ref]);
  }
}

export async function versionActual(c, clientId) {
  try { return await versionDe(c, await configDe(c, clientId)); } catch { return null; }
}

export async function evento(clientId, e, meta) {
  return asClient(clientId, async (c) => {
    if (e.prospecto_id) await prospectoDe(c, clientId, e.prospecto_id);
    if (e.cuenta_id) await cuentaDe(c, clientId, e.cuenta_id);
    const r = await insertarEvento(c, clientId, e, { ...meta, version: await versionActual(c, clientId) });
    await aplicarEvento(c, clientId, e);
    return { id: Number(r.id), at: r.at };
  });
}

// Lo usa el gateway al enviar un mail con prospecto_id: documenta el envío sin depender del bot.
export async function registrarEnvio(clientId, prospectoId, datos, meta) {
  return evento(clientId, { tipo: 'mail.enviado', canal: 'mail', prospecto_id: prospectoId, ref: datos.message_id, datos }, meta);
}

// ---------------------------------------------------------------- cuentas y prospectos

async function cuentaDe(c, clientId, id) {
  const { rows } = await c.query(`select * from sdr.cuenta where client_id = $1 and id = $2`, [clientId, id]);
  if (!rows.length) throw errorsSdr.noExiste(`la cuenta ${id}`);
  return rows[0];
}

export async function prospectoDe(c, clientId, id) {
  const { rows } = await c.query(`select * from sdr.prospecto where client_id = $1 and id = $2`, [clientId, id]);
  if (!rows.length) throw errorsSdr.noExiste(`el prospecto ${id}`);
  return rows[0];
}

export async function prospecto(clientId, id) {
  return asClient(clientId, (c) => prospectoDe(c, clientId, id));
}

export async function buscar(clientId, q) {
  return asClient(clientId, async (c) => {
    const cuentas = [];
    const prospectos = [];
    if (q.dominio || q.asci_id || q.nombre) {
      const { rows } = await c.query(
        `select * from sdr.cuenta where client_id = $1
           and (($2::text is not null and dominio = $2) or ($3::text is not null and asci_id = $3)
                or ($4::text is not null and nombre ilike '%' || $4 || '%'))
         order by actualizado_at desc limit 20`,
        [clientId, q.dominio ?? null, q.asci_id ?? null, q.nombre ?? null]);
      cuentas.push(...rows);
    }
    if (q.email || q.linkedin_url || q.asci_id || q.nombre || q.dominio) {
      const { rows } = await c.query(
        `select p.* from sdr.prospecto p left join sdr.cuenta k on k.id = p.cuenta_id
          where p.client_id = $1
            and (($2::text is not null and p.email = $2) or ($3::text is not null and p.linkedin_url = $3)
                 or ($4::text is not null and p.asci_id = $4) or ($5::text is not null and p.nombre ilike '%' || $5 || '%')
                 or ($6::text is not null and (k.dominio = $6 or split_part(p.email, '@', 2) = $6)))
          order by p.actualizado_at desc limit 20`,
        [clientId, q.email ?? null, q.linkedin_url ?? null, q.asci_id ?? null, q.nombre ?? null, q.dominio ?? null]);
      prospectos.push(...rows);
    }
    return { cuentas, prospectos };
  });
}

const CAMPOS_CUENTA = ['asci_id', 'nombre', 'dominio', 'pais', 'vertical', 'tamano', 'senales', 'tesis', 'estado', 'estado_motivo', 'pausa_hasta'];

export async function guardarCuenta(clientId, a, meta) {
  return asClient(clientId, async (c) => {
    let actual = null;
    if (a.id) actual = await cuentaDe(c, clientId, a.id);
    else if (a.dominio || a.asci_id) {
      const { rows } = await c.query(
        `select * from sdr.cuenta where client_id = $1 and ((dominio = $2) or (asci_id = $3)) limit 1`,
        [clientId, a.dominio ?? null, a.asci_id ?? null]);
      actual = rows[0] ?? null;
    }
    const version = await versionActual(c, clientId);
    const val = (k) => (k === 'senales' ? JSON.stringify(a[k]) : a[k]);
    if (!actual) {
      if (!a.nombre) throw new GatewayError('invalid_request', 'Para crear una cuenta hace falta el nombre.', 400);
      const cols = CAMPOS_CUENTA.filter((k) => a[k] !== undefined);
      const { rows } = await c.query(
        `insert into sdr.cuenta (client_id, ${cols.join(', ')}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) returning *`,
        [clientId, ...cols.map(val)]);
      await insertarEvento(c, clientId, { tipo: 'cuenta.investigada', cuenta_id: rows[0].id, datos: { nombre: rows[0].nombre } }, { ...meta, version });
      if (rows[0].estado === 'excluida') {
        await insertarEvento(c, clientId, { tipo: 'cuenta.excluida', cuenta_id: rows[0].id, datos: { motivo: rows[0].estado_motivo } }, { ...meta, version });
      }
      return { creada: true, cuenta: rows[0] };
    }
    const cols = CAMPOS_CUENTA.filter((k) => a[k] !== undefined);
    if (!cols.length) return { creada: false, cuenta: actual };
    const { rows } = await c.query(
      `update sdr.cuenta set ${cols.map((k, i) => `${k} = $${i + 3}`).join(', ')}, actualizado_at = now()
        where client_id = $1 and id = $2 returning *`, [clientId, actual.id, ...cols.map(val)]);
    if (a.estado === 'excluida' && actual.estado !== 'excluida') {
      await insertarEvento(c, clientId, { tipo: 'cuenta.excluida', cuenta_id: actual.id, datos: { motivo: a.estado_motivo ?? null } }, { ...meta, version });
    }
    return { creada: false, cuenta: rows[0] };
  });
}

const CAMPOS_PROSPECTO = ['cuenta_id', 'asci_id', 'apollo_id', 'nombre', 'cargo', 'area', 'seniority', 'email', 'email_calidad',
  'linkedin_url', 'whatsapp', 'eleccion', 'estado', 'canales', 'dripify', 'proximo_paso', 'proximo_canal', 'proximo_fecha'];
const JSONB_PROSPECTO = new Set(['eleccion', 'dripify']);

export async function guardarProspecto(clientId, a, meta) {
  return asClient(clientId, async (c) => {
    if (a.cuenta_id) await cuentaDe(c, clientId, a.cuenta_id);
    let actual = null;
    if (a.id) actual = await prospectoDe(c, clientId, a.id);
    else if (a.email || a.linkedin_url || a.asci_id) {
      const { rows } = await c.query(
        `select * from sdr.prospecto where client_id = $1
           and ((email = $2) or (linkedin_url = $3) or (asci_id = $4)) limit 1`,
        [clientId, a.email ?? null, a.linkedin_url ?? null, a.asci_id ?? null]);
      actual = rows[0] ?? null;
    }
    const version = await versionActual(c, clientId);
    const val = (k) => (JSONB_PROSPECTO.has(k) ? JSON.stringify(a[k]) : a[k]);
    const cols = CAMPOS_PROSPECTO.filter((k) => a[k] !== undefined);
    let fila;
    let creado = false;
    if (!actual) {
      if (!a.nombre) throw new GatewayError('invalid_request', 'Para crear un prospecto hace falta el nombre.', 400);
      const { rows } = await c.query(
        `insert into sdr.prospecto (client_id, ${cols.join(', ')}) values ($1, ${cols.map((_, i) => `$${i + 2}`).join(', ')}) returning *`,
        [clientId, ...cols.map(val)]);
      fila = rows[0];
      creado = true;
    } else if (cols.length) {
      const { rows } = await c.query(
        `update sdr.prospecto set ${cols.map((k, i) => `${k} = $${i + 3}`).join(', ')}, actualizado_at = now()
          where client_id = $1 and id = $2 returning *`, [clientId, actual.id, ...cols.map(val)]);
      fila = rows[0];
    } else {
      fila = actual;
    }
    // Revelado = el email aparece por primera vez.
    if (fila.email && !actual?.email) {
      await insertarEvento(c, clientId, { tipo: 'prospecto.revelado', prospecto_id: fila.id, cuenta_id: fila.cuenta_id,
        datos: { email_calidad: fila.email_calidad } }, { ...meta, version });
    }
    if (actual && a.estado && a.estado !== actual.estado) {
      await insertarEvento(c, clientId, { tipo: 'decision', prospecto_id: fila.id,
        datos: { estado_anterior: actual.estado, estado: a.estado } }, { ...meta, version });
    }
    return { creado, prospecto: fila };
  });
}

export async function agenda(clientId, { fecha, canal, limite }) {
  return asClient(clientId, async (c) => {
    const cfg = await configDe(c, clientId);
    const dia = fecha ?? hoyEn(cfg?.zona_horaria ?? 'America/Argentina/Buenos_Aires');
    const { rows: prospectos } = await c.query(
      `select p.id, p.nombre, p.cargo, p.email, p.estado, p.proximo_paso, p.proximo_canal, p.proximo_fecha,
              p.ultima_interaccion_at, p.ultima_interaccion_canal, k.nombre as cuenta
         from sdr.prospecto p left join sdr.cuenta k on k.id = p.cuenta_id
        where p.client_id = $1 and p.proximo_fecha <= $2 and p.estado <> all($3)
          and ($4::text is null or p.proximo_canal = $4)
        order by p.proximo_fecha, p.actualizado_at limit $5`,
      [clientId, dia, FINALES, canal ?? null, limite]);
    const { rows: pedidos } = await c.query(
      `select para_bot, count(*)::int as n from sdr.pedido where client_id = $1 and estado in ('pendiente', 'en_curso') group by para_bot`,
      [clientId]);
    const { rows: aprob } = await c.query(
      `select estado, count(*)::int as n from sdr.aprobacion where client_id = $1 and estado in ('pendiente', 'aprobada') group by estado`,
      [clientId]);
    const { rows: correo } = await c.query(
      `select (select count(*)::int from sdr.correo where client_id = $1 and estado = 'nuevo') as n,
              (select count(*)::int from sdr.linkedin_respuesta where client_id = $1 and estado = 'nuevo') as li`, [clientId]);
    return {
      fecha: dia, prospectos, correo_sin_atender: correo[0].n, linkedin_sin_atender: correo[0].li,
      pedidos_pendientes: Object.fromEntries(pedidos.map((r) => [r.para_bot, r.n])),
      aprobaciones: { pendientes: aprob.find((r) => r.estado === 'pendiente')?.n ?? 0, aprobadas_sin_usar: aprob.find((r) => r.estado === 'aprobada')?.n ?? 0 },
    };
  });
}

export async function historia(clientId, { prospecto_id, cuenta_id, limite }) {
  return asClient(clientId, async (c) => {
    const out = {};
    if (prospecto_id) {
      out.prospecto = await prospectoDe(c, clientId, prospecto_id);
      if (out.prospecto.cuenta_id) out.cuenta = await cuentaDe(c, clientId, out.prospecto.cuenta_id);
    } else if (cuenta_id) {
      out.cuenta = await cuentaDe(c, clientId, cuenta_id);
      out.prospectos = (await c.query(`select * from sdr.prospecto where client_id = $1 and cuenta_id = $2 order by creado_at`,
        [clientId, cuenta_id])).rows;
    } else {
      throw new GatewayError('invalid_request', 'Pasar prospecto_id o cuenta_id.', 400);
    }
    const { rows } = await c.query(
      `select id, tipo, canal, datos, ref, interno, bot, tarea, version_reglas, at, prospecto_id from sdr.evento
        where client_id = $1 and (($2::uuid is not null and prospecto_id = $2) or ($3::uuid is not null and (cuenta_id = $3
              or prospecto_id in (select id from sdr.prospecto where client_id = $1 and cuenta_id = $3))))
        order by id desc limit $4`, [clientId, prospecto_id ?? null, prospecto_id ? null : cuenta_id, limite]);
    out.eventos = rows.reverse().map((r) => ({ ...r, id: Number(r.id) }));
    if (prospecto_id) {
      out.pedidos = (await c.query(`select * from sdr.pedido where client_id = $1 and prospecto_id = $2 order by creado_at`,
        [clientId, prospecto_id])).rows;
      out.aprobaciones = (await c.query(`select * from sdr.aprobacion where client_id = $1 and prospecto_id = $2 order by creado_at`,
        [clientId, prospecto_id])).rows;
    }
    return out;
  });
}

// Números de un período: eventos por tipo, corridas por bot y estado, y lo que espera. Lo usa el
// resumen del orquestador y, más adelante, el dashboard del cliente.
export async function resumen(clientId, { desde, hasta }) {
  return asClient(clientId, async (c) => {
    const cfg = await configDe(c, clientId);
    const tz = cfg?.zona_horaria ?? 'America/Argentina/Buenos_Aires';
    const d = desde ?? hoyEn(tz);
    const h = hasta ?? d;
    const rango = [clientId, d, h, tz];
    const { rows: eventos } = await c.query(
      `select tipo, count(*)::int as n from sdr.evento
        where client_id = $1 and (at at time zone $4)::date between $2 and $3 and not interno
        group by tipo order by tipo`, rango);
    const { rows: corridas } = await c.query(
      `select bot, estado, count(*)::int as n from sdr.corrida
        where client_id = $1 and (inicio at time zone $4)::date between $2 and $3 group by bot, estado order by bot, estado`, rango);
    const { rows: estados } = await c.query(
      `select estado, count(*)::int as n from sdr.prospecto where client_id = $1 group by estado order by estado`, [clientId]);
    const { rows: calib } = await c.query(
      `select count(*)::int as n from sdr.aprobacion where client_id = $1 and tipo = 'calibracion_mail' and estado = 'usada'`, [clientId]);
    return {
      desde: d, hasta: h,
      eventos: Object.fromEntries(eventos.map((r) => [r.tipo, r.n])),
      corridas,
      prospectos_por_estado: Object.fromEntries(estados.map((r) => [r.estado, r.n])),
      calibracion: cfg ? { usados: calib[0].n, total: cfg.calibracion_mails, terminada: calib[0].n >= cfg.calibracion_mails } : null,
    };
  });
}

// ---------------------------------------------------------------- pedidos entre bots

export const TOPE_IDAS = 3;

export async function pedir(clientId, a, meta) {
  return asClient(clientId, async (c) => {
    if (a.prospecto_id) await prospectoDe(c, clientId, a.prospecto_id);
    let idas = 1;
    if (a.relacionado_con) {
      const { rows } = await c.query(`select * from sdr.pedido where client_id = $1 and id = $2`, [clientId, a.relacionado_con]);
      if (!rows.length) throw errorsSdr.noExiste(`el pedido ${a.relacionado_con}`);
      idas = rows[0].idas + 1;
      await c.query(`update sdr.pedido set estado = 'hecho', resultado = coalesce(resultado, 'sigue en otro pedido'), actualizado_at = now()
                      where client_id = $1 and id = $2 and estado in ('pendiente', 'en_curso')`, [clientId, a.relacionado_con]);
    }
    const escalado = idas > TOPE_IDAS;
    const para = escalado ? 'orquestador' : a.para_bot;
    const { rows } = await c.query(
      `insert into sdr.pedido (client_id, de_bot, para_bot, prospecto_id, que, por_que, para_cuando, relacionado_con, idas, escalado)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
      [clientId, meta.bot, para, a.prospecto_id ?? null, a.que, a.por_que ?? null, a.para_cuando ?? null,
        a.relacionado_con ?? null, idas, escalado]);
    if (a.prospecto_id) {
      await insertarEvento(c, clientId, { tipo: 'pedido', prospecto_id: a.prospecto_id,
        datos: { pedido: rows[0].id, de: meta.bot, para, que: a.que, escalado } }, { ...meta, version: await versionActual(c, clientId) });
    }
    return {
      pedido: rows[0],
      aviso: escalado
        ? `Este tema ya fue y vino ${idas - 1} veces: se escaló al orquestador.`
        : `Pedido registrado. Si hace falta que ${para} actúe antes de su próxima routine, mandale un mensaje corto: «tenés un pedido en el registro».`,
    };
  });
}

export async function pendientes(clientId, bot) {
  return asClient(clientId, async (c) => {
    const { rows: pedidos } = await c.query(
      `select * from sdr.pedido where client_id = $1 and para_bot = $2 and estado in ('pendiente', 'en_curso')
        order by escalado desc, coalesce(para_cuando, creado_at), creado_at`, [clientId, bot]);
    const { rows: aprobadas } = await c.query(
      `select * from sdr.aprobacion where client_id = $1 and pedida_por = $2 and estado = 'aprobada' order by decidida_at`,
      [clientId, bot]);
    const { rows: rechazadas } = await c.query(
      `select * from sdr.aprobacion where client_id = $1 and pedida_por = $2 and estado = 'rechazada'
          and decidida_at > now() - interval '3 days' order by decidida_at`, [clientId, bot]);
    const out = { pedidos, aprobaciones_para_ejecutar: aprobadas, aprobaciones_rechazadas: rechazadas };
    if (bot === 'orquestador') {
      out.aprobaciones_por_decidir = (await c.query(
        `select * from sdr.aprobacion where client_id = $1 and estado = 'pendiente' order by creado_at`, [clientId])).rows;
    }
    return out;
  });
}

export async function resolverPedido(clientId, a) {
  return asClient(clientId, async (c) => {
    const { rows } = await c.query(
      `update sdr.pedido set estado = $3, resultado = coalesce($4, resultado), actualizado_at = now()
        where client_id = $1 and id = $2 returning *`, [clientId, a.id, a.estado, a.resultado ?? null]);
    if (!rows.length) throw errorsSdr.noExiste(`el pedido ${a.id}`);
    return { pedido: rows[0] };
  });
}

// ---------------------------------------------------------------- aprobaciones

export async function pedirAprobacion(clientId, a, meta) {
  return asClient(clientId, async (c) => {
    if (a.prospecto_id) await prospectoDe(c, clientId, a.prospecto_id);
    const { rows } = await c.query(
      `insert into sdr.aprobacion (client_id, tipo, prospecto_id, pedida_por, contenido) values ($1, $2, $3, $4, $5) returning *`,
      [clientId, a.tipo, a.prospecto_id ?? null, meta.bot, JSON.stringify(a.contenido)]);
    if (a.prospecto_id) {
      await insertarEvento(c, clientId, { tipo: 'aprobacion.pedida', prospecto_id: a.prospecto_id,
        datos: { aprobacion: rows[0].id, tipo: a.tipo } }, { ...meta, version: await versionActual(c, clientId) });
    }
    return { aprobacion: rows[0] };
  });
}

export async function aprobaciones(clientId, { estado, limite }) {
  return asClient(clientId, async (c) => ({
    aprobaciones: (await c.query(
      `select a.*, p.nombre as prospecto_nombre, p.email as prospecto_email, k.nombre as cuenta
         from sdr.aprobacion a left join sdr.prospecto p on p.id = a.prospecto_id left join sdr.cuenta k on k.id = p.cuenta_id
        where a.client_id = $1 and a.estado = $2 order by a.creado_at limit $3`, [clientId, estado, limite])).rows,
  }));
}

export async function aprobar(clientId, a, meta) {
  return asClient(clientId, async (c) => {
    const { rows: prev } = await c.query(`select * from sdr.aprobacion where client_id = $1 and id = $2 for update`, [clientId, a.id]);
    if (!prev.length) throw errorsSdr.noExiste(`la aprobación ${a.id}`);
    if (prev[0].estado !== 'pendiente') {
      throw new GatewayError('ya_decidida', `La aprobación ya está ${prev[0].estado}.`, 409);
    }
    const cambios = {};
    for (const k of ['asunto', 'texto', 'destinatario', 'linkedin']) if (a[k] !== undefined) cambios[k] = a[k];
    const final = a.decision === 'aprobada' ? { ...prev[0].contenido, ...cambios } : null;
    const { rows } = await c.query(
      `update sdr.aprobacion set estado = $3, decision_contenido = $4, decision_nota = $5, decidida_por = $6, decidida_at = now()
        where client_id = $1 and id = $2 returning *`,
      [clientId, a.id, a.decision, final ? JSON.stringify(final) : null, a.nota ?? null, a.operador]);
    if (prev[0].prospecto_id) {
      await insertarEvento(c, clientId, { tipo: 'aprobacion.decidida', prospecto_id: prev[0].prospecto_id,
        datos: { aprobacion: a.id, decision: a.decision, operador: a.operador, editada: Object.keys(cambios).length > 0 } },
      { ...meta, version: await versionActual(c, clientId) });
    }
    return { aprobacion: rows[0], aviso: `Avisale a ${prev[0].pedida_por} que la aprobación está decidida.` };
  });
}

const normTexto = (s) => String(s ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim();
const normMail = (s) => String(s ?? '').trim().toLowerCase();
const primerDestinatario = (to) => {
  const list = Array.isArray(to) ? to : String(to ?? '').split(',');
  const limpios = list.map((x) => normMail(/<([^>]+)>/.exec(x)?.[1] ?? x)).filter(Boolean);
  return limpios.length === 1 ? limpios[0] : null;
};

// Calibración y aprobaciones que el gateway exige antes de enviar (docs/09 §5.4). Devuelve la
// aprobación a marcar como usada, o null si el envío no la necesita.
export async function controlarEnvio(clientId, args, kind) {
  return asClient(clientId, async (c) => {
    const cfg = await configDe(c, clientId);
    let necesita = null;
    if (kind === 'send' && cfg?.calibracion_mails > 0) {
      const { rows } = await c.query(
        `select count(*)::int as n from sdr.aprobacion where client_id = $1 and tipo = 'calibracion_mail' and estado = 'usada'`, [clientId]);
      if (rows[0].n < cfg.calibracion_mails) necesita = { tipo: 'calibracion_mail', usadas: rows[0].n, total: cfg.calibracion_mails };
    }
    if (kind === 'reply' && args.prospecto_id) {
      const p = await prospectoDe(c, clientId, args.prospecto_id);
      if (p.estado === 'positivo') necesita = { tipo: 'respuesta_positivo' };
    }
    if (args.prospecto_id) await prospectoDe(c, clientId, args.prospecto_id);
    if (!necesita && !args.aprobacion_id) return null;
    if (!args.aprobacion_id) {
      throw errorsSdr.aprobacionRequerida(necesita.tipo === 'calibracion_mail'
        ? `Este cliente está en calibración (${necesita.usadas} de ${necesita.total} mails aprobados enviados): el mail necesita una aprobación. ` +
          'Pedila con registro_pedir_aprobacion (tipo calibracion_mail, con buzón, destinatario, asunto y texto) y enviá cuando esté aprobada, pasando aprobacion_id.'
        : 'Es la respuesta a un positivo: necesita una aprobación (registro_pedir_aprobacion, tipo respuesta_positivo). Enviá cuando esté aprobada, pasando aprobacion_id.');
    }
    const { rows } = await c.query(`select * from sdr.aprobacion where client_id = $1 and id = $2`, [clientId, args.aprobacion_id]);
    const ap = rows[0];
    if (!ap) throw errorsSdr.noExiste(`la aprobación ${args.aprobacion_id}`);
    if (necesita && ap.tipo !== necesita.tipo) {
      throw errorsSdr.aprobacionRequerida(`La aprobación es de tipo ${ap.tipo} y este envío necesita una de tipo ${necesita.tipo}.`);
    }
    const reintento = ap.estado === 'usada' && ap.usada_clave === args.idempotency_key;
    if (ap.estado !== 'aprobada' && !reintento) {
      throw errorsSdr.aprobacionRequerida(`La aprobación está ${ap.estado}: no se puede usar para enviar.`);
    }
    const final = ap.decision_contenido ?? ap.contenido;
    const diferencias = [];
    if (final.buzon && normMail(final.buzon) !== normMail(args.mailbox)) diferencias.push('el buzón');
    if (kind === 'send') {
      if (final.destinatario && normMail(final.destinatario) !== primerDestinatario(args.to)) diferencias.push('el destinatario');
      if (final.asunto !== undefined && normTexto(final.asunto) !== normTexto(args.subject)) diferencias.push('el asunto');
    }
    // Una aprobación sólo de LinkedIn (sin texto de mail) no habilita ningún mail.
    if (final.texto === undefined) diferencias.push('el texto (la aprobación no trae un mail)');
    else if (normTexto(final.texto) !== normTexto(args.text)) diferencias.push('el texto');
    if (final.canal && final.canal !== 'mail') diferencias.push(`el canal (la aprobación es para ${final.canal})`);
    if (ap.prospecto_id && args.prospecto_id && ap.prospecto_id !== args.prospecto_id) diferencias.push('el prospecto');
    if (diferencias.length) {
      throw errorsSdr.aprobacionNoCoincide(`No coincide con lo aprobado: ${diferencias.join(', ')}. Mandá exactamente lo aprobado ` +
        '(si el operador lo editó, la versión editada está en decision_contenido).');
    }
    return ap;
  });
}

export async function usarAprobacion(clientId, id, clave) {
  await asClient(clientId, (c) => c.query(
    `update sdr.aprobacion set estado = 'usada', usada_at = now(), usada_clave = $3
      where client_id = $1 and id = $2 and estado = 'aprobada'`, [clientId, id, clave]));
}

// ---------------------------------------------------------------- bitácora

export async function corridaInicio(clientId, meta) {
  return asClient(clientId, async (c) => {
    const version = await versionActual(c, clientId);
    // Una corrida del mismo bot y tarea que quedó abierta más de 3 horas se da por cortada.
    await c.query(
      `update sdr.corrida set estado = 'error', fin = now(), resumen = coalesce(resumen, 'Sin cierre: se dio por cortada')
        where client_id = $1 and bot = $2 and tarea = $3 and estado = 'corriendo' and inicio < now() - interval '3 hours'`,
      [clientId, meta.bot, meta.tarea]);
    const { rows } = await c.query(
      `insert into sdr.corrida (client_id, bot, tarea, version_reglas) values ($1, $2, $3, $4) returning id, inicio, version_reglas`,
      [clientId, meta.bot, meta.tarea, version]);
    return { corrida: rows[0].id, inicio: rows[0].inicio, version_reglas: rows[0].version_reglas };
  });
}

export async function corridaFin(clientId, a) {
  return asClient(clientId, async (c) => {
    const { rows } = await c.query(
      `update sdr.corrida set estado = $3, fin = now(), items = $4, resumen = $5
        where client_id = $1 and id = $2 returning id, inicio, fin, estado`,
      [clientId, a.corrida, a.estado, a.items ?? null, a.resumen ?? null]);
    if (!rows.length) throw errorsSdr.noExiste(`la corrida ${a.corrida}`);
    return rows[0];
  });
}

// ---------------------------------------------------------------- administración (CLI)

export async function setConfig(clientId, cfg) {
  return asOwner(async (c) => {
    const { rows } = await c.query(
      `insert into sdr.cliente_config (client_id, canal, version_fija, ajustes, bots_activos, zona_horaria, calibracion_mails)
       values ($1, coalesce($2::text, 'estable'), $3::text, coalesce($4::jsonb, '{}'::jsonb),
               coalesce($5::text[], '{orquestador,prospector}'::text[]),
               coalesce($6::text, 'America/Argentina/Buenos_Aires'), coalesce($7::int, 20))
       on conflict (client_id) do update set
         canal = coalesce($2::text, sdr.cliente_config.canal),
         version_fija = case when $8::boolean then $3::text else sdr.cliente_config.version_fija end,
         ajustes = coalesce($4::jsonb, sdr.cliente_config.ajustes),
         bots_activos = coalesce($5::text[], sdr.cliente_config.bots_activos),
         zona_horaria = coalesce($6::text, sdr.cliente_config.zona_horaria),
         calibracion_mails = coalesce($7::int, sdr.cliente_config.calibracion_mails),
         actualizado_at = now()
       returning *`,
      [clientId, cfg.canal ?? null, cfg.version_fija ?? null, cfg.ajustes ? JSON.stringify(cfg.ajustes) : null,
        cfg.bots_activos ?? null, cfg.zona_horaria ?? null, cfg.calibracion_mails ?? null, 'version_fija' in cfg]);
    if (cfg.ajustes) {
      await c.query(
        `insert into sdr.ajustes_historial (client_id, ajustes, cambios, por_rol, nota) values ($1, $2, $3, 'cli', 'Cargado con la CLI')`,
        [clientId, JSON.stringify(rows[0].ajustes), Object.keys(cfg.ajustes)]);
    }
    return rows[0];
  });
}

export async function publicar(pub) {
  return asOwner(async (c) => {
    const ex = await c.query(`select 1 from sdr.playbook_version where version = $1`, [pub.version]);
    if (ex.rowCount) throw new GatewayError('conflict', `La versión ${pub.version} ya existe: las versiones no se modifican.`, 409);
    await c.query(`insert into sdr.playbook_version (version, notas) values ($1, $2)`, [pub.version, pub.notas ?? null]);
    for (const s of pub.secciones) {
      await c.query(
        `insert into sdr.playbook_seccion (version, bot, tarea, orden, seccion, titulo, resumen, contenido)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`, [pub.version, s.bot, s.tarea, s.orden, s.seccion, s.titulo, s.resumen, s.contenido]);
    }
    for (const r of pub.rutinas) {
      await c.query(
        `insert into sdr.playbook_rutina (version, bot, nombre, tarea, cron, timing, disparo, descripcion, etapa)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [pub.version, r.bot, r.nombre, r.tarea, r.cron, r.timing ?? 'flexible', r.disparo ?? 'horario', r.descripcion ?? '', r.etapa ?? 1]);
    }
    return { version: pub.version, secciones: pub.secciones.length, rutinas: pub.rutinas.length };
  });
}

export async function moverCanal(canal, version) {
  return asOwner(async (c) => {
    const ex = await c.query(`select 1 from sdr.playbook_version where version = $1`, [version]);
    if (!ex.rowCount) throw new GatewayError('not_found', `No existe la versión ${version}.`, 404);
    await c.query(
      `insert into sdr.playbook_canal (canal, version) values ($1, $2)
       on conflict (canal) do update set version = excluded.version, cambiado_at = now()`, [canal, version]);
    return { canal, version };
  });
}
