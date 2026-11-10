// Panel /admin del gateway de correo. Sin dependencias ni compilación.
// Todo lo que viene del servidor se inserta como texto (textContent), nunca como HTML.

'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');
const dlg = $('#dlg');
const dlgForm = $('#dlg-form');
let me = null;

// ---------------------------------------------------------------- utilidades

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function api(method, path, body) {
  const res = await fetch(`/admin/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: { 'x-mailgw-admin': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* sin cuerpo */ }
  if (!res.ok || !json?.ok) {
    const err = new ApiError(res.status, json?.error?.code ?? 'error', json?.error?.message ?? `Error ${res.status}`);
    if (res.status === 401 && path !== '/login' && path !== '/activate' && path !== '/me/password') {
      me = null;
      renderLogin(err.message);
    }
    throw err;
  }
  return json.data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

const fmtDate = (v) => (v ? new Date(v).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const enc = encodeURIComponent;

function statusBadge(s) {
  const map = { active: ['activo', 'b-ok'], paused: ['pausado', 'b-mute'], auth_error: ['bloqueado: contraseña', 'b-err'] };
  const [label, cls] = map[s] ?? [s, 'b-mute'];
  return h('span', { class: `badge ${cls}` }, label);
}

// Ejecuta una acción de un botón: lo deshabilita mientras corre y muestra el error.
async function busy(btn, fn, errEl) {
  btn.disabled = true;
  if (errEl) errEl.textContent = '';
  try { return await fn(); } catch (e) {
    if (errEl) errEl.textContent = e.message; else toast(e.message);
    return undefined;
  } finally { btn.disabled = false; }
}

// ---------------------------------------------------------------- diálogo

function openDialog(title, body, { submit, submitLabel = 'Guardar', danger = false, cancelLabel = 'Cancelar' } = {}) {
  const err = h('p', { class: 'err', role: 'alert' });
  const ok = submit ? h('button', { type: 'submit', class: danger ? 'danger' : 'primary', value: 'ok' }, submitLabel) : null;
  dlgForm.replaceChildren(
    h('h2', {}, title),
    body,
    err,
    h('div', { class: 'dlg-actions' },
      h('button', { type: 'button', onclick: () => dlg.close() }, submit ? cancelLabel : 'Cerrar'),
      ok),
  );
  dlgForm.onsubmit = submit ? async (ev) => {
    ev.preventDefault();
    const done = await busy(ok, () => submit(new FormData(dlgForm)), err);
    if (done !== undefined && done !== false) dlg.close();
  } : null;
  dlg.showModal();
  const first = dlgForm.querySelector('input:not([type=hidden]), select');
  if (first) first.focus();
}

// Muestra un secreto que no se vuelve a ver.
function showSecret(title, value, explanation) {
  const input = h('input', { readonly: true, value });
  openDialog(title, h('div', {},
    h('p', {}, explanation),
    h('div', { class: 'secret' }, input,
      h('button', { type: 'button', onclick: async () => {
        try { await navigator.clipboard.writeText(value); toast('Copiado.'); } catch { input.select(); }
      } }, 'Copiar')),
    h('p', { class: 'note' }, 'Se muestra una sola vez: la base guarda sólo el hash. Si se pierde, hay que generar otro.')));
  input.select();
}

const activationLink = (token) => `${location.origin}/admin#activar=${token}`;

function field(label, input, hint) {
  return h('div', {}, h('label', {}, label), input, hint ? h('div', { class: 'small muted' }, hint) : null);
}

// ---------------------------------------------------------------- sesión

function renderShell() {
  const logged = Boolean(me);
  $('#nav').hidden = !logged || me.role !== 'bigua_admin';
  $('#who').hidden = !logged;
  if (logged) $('#who-name').textContent = `${me.name} · ${me.role === 'bigua_admin' ? 'Biguá' : me.client_id}`;
}

function renderLogin(message) {
  me = null;
  renderShell();
  const err = h('p', { class: 'err', role: 'alert' }, message ?? '');
  const btn = h('button', { type: 'submit', class: 'primary' }, 'Ingresar');
  const form = h('form', { class: 'card narrow' },
    h('h1', {}, 'Ingresar'),
    h('p', { class: 'sub' }, 'Panel del SDR Bot.'),
    field('Email', h('input', { name: 'email', type: 'email', autocomplete: 'username', required: true })),
    field('Contraseña', h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true })),
    err,
    h('div', { class: 'row' }, btn));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const r = await busy(btn, () => api('POST', '/login', { email: fd.get('email'), password: fd.get('password') }), err);
    if (r) { me = r.me; route(); }
  });
  main.replaceChildren(form);
  $('input', form).focus();
}

function renderActivate(token) {
  me = null;
  renderShell();
  const err = h('p', { class: 'err', role: 'alert' });
  const btn = h('button', { type: 'submit', class: 'primary' }, 'Activar cuenta');
  const form = h('form', { class: 'card narrow' },
    h('h1', {}, 'Elegí tu contraseña'),
    h('p', { class: 'sub' }, 'Mínimo 12 caracteres. Con esto queda activada tu cuenta del panel.'),
    field('Contraseña nueva', h('input', { name: 'p1', type: 'password', autocomplete: 'new-password', required: true, minlength: 12 })),
    field('Repetirla', h('input', { name: 'p2', type: 'password', autocomplete: 'new-password', required: true, minlength: 12 })),
    err,
    h('div', { class: 'row' }, btn));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    if (fd.get('p1') !== fd.get('p2')) { err.textContent = 'Las contraseñas no coinciden.'; return; }
    const r = await busy(btn, () => api('POST', '/activate', { token, password: fd.get('p1') }), err);
    if (r) {
      history.replaceState(null, '', '/admin#/');
      renderLogin();
      toast(`Cuenta ${r.email} activada. Ya podés ingresar.`);
    }
  });
  main.replaceChildren(form);
  $('input', form).focus();
}

$('#btn-logout').addEventListener('click', async () => {
  try { await api('POST', '/logout'); } catch { /* igual se sale */ }
  me = null;
  history.replaceState(null, '', '/admin#/');
  renderLogin();
});

$('#btn-password').addEventListener('click', () => {
  openDialog('Cambiar contraseña', h('div', {},
    field('Contraseña actual', h('input', { name: 'current', type: 'password', autocomplete: 'current-password', required: true })),
    field('Contraseña nueva', h('input', { name: 'next', type: 'password', autocomplete: 'new-password', required: true, minlength: 12 }),
      'Mínimo 12 caracteres.')), {
    submit: async (fd) => {
      await api('POST', '/me/password', { current: fd.get('current'), next: fd.get('next') });
      toast('Contraseña cambiada.');
      return true;
    },
  });
});

// Las conexiones de Claude con el MCP del panel (docs/24 §3.4): cada una es un cliente OAuth que
// autorizó una persona. Se ven y se desconectan acá; un operador de Biguá ve las de todos.
async function conexionesDialog() {
  const { conexiones } = await api('GET', '/me/conexiones');
  const bigua = me.role === 'bigua_admin';
  const lista = conexiones.length
    ? h('table', {}, h('thead', {}, h('tr', {},
      h('th', {}, 'Cliente'), bigua ? h('th', {}, 'Usuario') : null, h('th', {}, 'Conectada'), h('th', {}, 'Último uso'), h('th', {}, ''))),
    h('tbody', {}, conexiones.map((x) => h('tr', {},
      h('td', {}, x.cliente_oauth), bigua ? h('td', { class: 'small' }, x.email, x.client_id ? h('span', { class: 'muted' }, ` · ${x.client_id}`) : null) : null,
      h('td', { class: 'small' }, fmtDate(x.creada_at)), h('td', { class: 'small' }, fmtDate(x.usada_at)),
      h('td', {}, h('button', { type: 'button', class: 'danger', onclick: async (ev) => {
        await busy(ev.currentTarget, async () => {
          await api('POST', `/me/conexiones/${enc(x.id)}/revocar`);
          toast('Conexión desconectada.');
          dlg.close();
          await conexionesDialog();
        });
      } }, 'Desconectar'))))))
    : h('p', { class: 'muted' }, 'No hay conexiones activas.');
  openDialog('Conexiones con Claude', h('div', {},
    h('p', {}, 'Para gestionar el SDR desde Claude, agregá un conector con ', h('span', { class: 'mono' }, `${location.origin}/mcp/panel`),
      ' y entrá con tu usuario del panel.'),
    lista,
    h('p', { class: 'small muted' }, 'Si Claude muestra el conector conectado pero sin herramientas: Desconectar y Conectar en la tarjeta del conector.')));
}

$('#btn-conexiones').addEventListener('click', () => { conexionesDialog().catch((e) => toast(e.message)); });

// ---------------------------------------------------------------- clientes

async function renderClients() {
  const { clients } = await api('GET', '/clients');
  if (me.role !== 'bigua_admin') { location.hash = `#/c/${enc(me.client_id)}`; return; }
  const list = clients.length
    ? h('div', { class: 'grid' }, clients.map((c) => h('a', { class: 'card client-card', href: `#/c/${enc(c.id)}` },
      h('strong', {}, c.name), h('div', { class: 'mono muted' }, c.id),
      h('div', { class: 'small muted' }, `${c.mailboxes} buzón(es) · ${c.users} usuario(s)`))))
    : h('div', { class: 'card empty' }, 'Todavía no hay clientes.');
  main.replaceChildren(
    h('div', { class: 'row spread' },
      h('div', {}, h('h1', {}, 'Clientes'), h('p', { class: 'sub' }, 'Cada cliente tiene sus buzones, sus usuarios y sus tokens; nada se cruza entre clientes.')),
      h('button', { class: 'primary', onclick: newClientDialog }, 'Nuevo cliente')),
    list);
}

function newClientDialog() {
  openDialog('Nuevo cliente', h('div', {},
    field('Nombre', h('input', { name: 'name', required: true, maxlength: 120, placeholder: 'BairesQA' })),
    field('Identificador', h('input', { name: 'id', required: true, pattern: '[a-z0-9][a-z0-9\\-]{1,40}', placeholder: 'bairesqa' }),
      'Minúsculas, números y guiones. No se puede cambiar después.')), {
    submit: async (fd) => {
      const { client } = await api('POST', '/clients', { id: fd.get('id'), name: fd.get('name') });
      location.hash = `#/c/${enc(client.id)}/alta`;
      return true;
    },
  });
}

// ---------------------------------------------------------------- un cliente

// La ficha de un cliente (docs/21 §3): Resumen, Empresa, Canales y Actividad; Administración
// aparte, sólo para Biguá. Las direcciones de las pestañas viejas llevan a su lugar nuevo.
const VIEJAS = { sdr: ['empresa'], buzones: ['canales'], dominios: ['canales'], usuarios: ['admin', 'usuarios'], tokens: ['admin', 'tokens'] };
const TABS = [['resumen', 'Resumen'], ['aprobaciones', 'Aprobaciones'], ['campanas', 'Campañas'], ['empresa', 'Empresa'], ['canales', 'Canales'], ['actividad', 'Actividad']];

// La pestaña Campañas la ven también los clientes desde que las reglas leen la campaña (docs/21
// §7.2, paso 5). Qué puede tocar cada uno lo decide el gateway (ajustes.mjs).
const CAMPANAS_PARA_CLIENTES = true;

async function renderClient(clientId, tab, sub, resto = []) {
  if (VIEJAS[tab]) [tab, sub = sub] = VIEJAS[tab];
  const data = await api('GET', `/clients/${enc(clientId)}`);
  const bigua = data.can_manage_access;
  const tabs = TABS.filter(([k]) => k !== 'campanas' || bigua || CAMPANAS_PARA_CLIENTES);
  if (!tabs.some(([k]) => k === tab) && !(bigua && (tab === 'admin' || tab === 'alta'))) tab = 'resumen';
  const base = `#/c/${enc(clientId)}`;
  const body = h('div');
  main.replaceChildren(
    ...(bigua ? [h('a', { href: '#/', class: 'small' }, '← Clientes')] : []),
    h('h1', {}, data.client.name),
    h('p', { class: 'sub mono' }, data.client.id),
    h('nav', { class: 'tabs' },
      tabs.map(([k, label]) => h('a', { href: `${base}/${k}`, class: k === tab ? 'on' : '' }, label)),
      bigua ? h('a', { href: `${base}/alta`, class: `gear${tab === 'alta' ? ' on' : ''}` }, 'Alta') : null,
      bigua ? h('a', { href: `${base}/admin`, class: tab === 'admin' ? 'on' : '' }, '⚙ Administración') : null),
    body);
  const v = { clientId, data, bigua, base, reload: () => renderClient(clientId, tab, sub, resto) };
  if (tab === 'resumen') body.append(await resumenView(v));
  if (tab === 'aprobaciones') body.append(await aprobacionesView(v));
  if (tab === 'campanas') {
    body.append(await (!sub ? campanasView(v) : resto[0] === 'asistente' ? campanaAsistenteView(v, sub, resto[1]) : campanaView(v, sub)));
  }
  if (tab === 'alta') body.append(await altaView(v, sub));
  if (tab === 'empresa') body.append(await empresaView(v));
  if (tab === 'canales') body.append(await canalesView(v));
  if (tab === 'actividad') body.append(await monitorView(clientId));
  if (tab === 'admin') body.append(await adminView(v, sub));
}

// ----- aprobaciones (docs/24 §5): los mensajes que los bots quieren mandar. El cliente los decide si
// Biguá lo habilitó (Administración → Operación); si no, los ve y los decide Biguá en el chat.

const TIPO_APROBACION = {
  calibracion_mail: 'Primer contacto', respuesta_positivo: 'Respuesta a un positivo', whatsapp_primero: 'Primer WhatsApp',
  crm_mapeo: 'Mapeo del CRM', crm_cambio: 'Cambio en el CRM', otro: 'Otra',
};
const QUIEN_APRUEBA = {
  bigua: 'Los mensajes los aprueba Biguá en el chat del orquestador. Acá los ves.',
  cliente_y_bigua: 'Los mensajes los podés aprobar vos o Biguá: vale la primera decisión.',
  cliente: 'Los mensajes los aprobás vos. Biguá sólo puede frenarlos.',
};

function contenidoAprobacion(k) {
  const fila = (t, v) => (v ? h('div', {}, h('span', { class: 'small muted' }, `${t}: `), v) : null);
  return h('div', {},
    fila('Canal', k.canal), fila('Desde', k.buzon), fila('Para', k.destinatario),
    fila('Copia', Array.isArray(k.cc) && k.cc.length ? `${k.cc.join(', ')} (se le deriva el interesado)` : null), fila('Asunto', k.asunto),
    k.texto ? h('pre', { class: 'mensaje' }, k.texto) : null,
    k.linkedin ? h('div', {}, h('div', { class: 'small muted' }, 'LinkedIn'),
      h('pre', { class: 'mensaje' }, `Nota: ${k.linkedin.nota}\n\n1) ${k.linkedin.mensaje1}\n\n2) ${k.linkedin.mensaje2}`)) : null,
    k.contexto ? h('details', {}, h('summary', { class: 'small' }, 'Contexto'), h('pre', { class: 'mensaje small' }, k.contexto)) : null);
}

function decidirDialog(v, a, decision) {
  const k = a.contenido ?? {};
  const aprobar = decision === 'aprobada';
  const campos = aprobar ? [
    k.asunto !== undefined ? field('Asunto', h('input', { name: 'asunto', value: k.asunto ?? '', maxlength: 500 })) : null,
    k.texto !== undefined ? field('Texto', h('textarea', { name: 'texto', rows: 10, maxlength: 20000 }, k.texto ?? '')) : null,
    k.destinatario ? h('p', { class: 'small muted' }, `Va a ${k.destinatario}. El destinatario no se cambia desde acá: si no es la persona, rechazalo con una nota.`) : null,
    Array.isArray(k.cc) && k.cc.length ? h('p', { class: 'small muted' }, `Va con copia a ${k.cc.join(', ')}: desde ahí la conversación sigue con esa persona. La copia no se cambia desde acá: si no es la correcta, rechazalo con una nota.`) : null,
  ] : [];
  openDialog(aprobar ? 'Aprobar el mensaje' : 'Rechazar el mensaje', h('div', {},
    ...campos,
    field(aprobar ? 'Nota (opcional)' : 'Por qué se rechaza', h('textarea', { name: 'nota', rows: 3, maxlength: 2000, required: !aprobar }))), {
    submitLabel: aprobar ? 'Aprobar' : 'Rechazar', danger: !aprobar,
    submit: async (fd) => {
      const body = { decision, confirmar: true };
      const nota = String(fd.get('nota') ?? '').trim();
      if (nota) body.nota = nota;
      if (aprobar) {
        for (const c of ['asunto', 'texto']) {
          const x = fd.get(c);
          if (x !== null && String(x) !== String(k[c] ?? '')) body[c] = String(x);
        }
      }
      await api('POST', `/clients/${enc(v.clientId)}/aprobaciones/${enc(a.id)}/decidir`, body);
      toast(aprobar ? 'Aprobado. El bot lo manda en su próxima pasada.' : 'Rechazado.');
      v.reload();
      return true;
    },
  });
}

async function aprobacionesView(v) {
  const { aprueba, aprobaciones } = await api('GET', `/clients/${enc(v.clientId)}/aprobaciones`);
  const lista = aprobaciones.length ? aprobaciones.map((a) => h('div', { class: 'card' },
    h('div', { class: 'row spread' },
      h('div', {}, h('strong', {}, TIPO_APROBACION[a.tipo] ?? a.tipo),
        h('div', { class: 'small muted' }, [a.prospecto_nombre, a.cuenta].filter(Boolean).join(' · ') || '—',
          ` · pidió ${a.pedida_por} · ${fmtDate(a.creado_at)}`)),
      h('div', { class: 'row' },
        a.puede?.rechazar ? h('button', { type: 'button', onclick: () => decidirDialog(v, a, 'rechazada') }, 'Rechazar') : null,
        a.puede?.aprobar ? h('button', { type: 'button', class: 'primary', onclick: () => decidirDialog(v, a, 'aprobada') }, 'Aprobar') : null)),
    contenidoAprobacion(a.contenido ?? {}),
    a.puede && !a.puede.aprobar && a.puede.motivo ? h('p', { class: 'small muted' }, a.puede.motivo) : null))
    : [h('div', { class: 'card empty' }, 'No hay aprobaciones pendientes.')];
  return h('div', {}, h('p', { class: 'sub' }, QUIEN_APRUEBA[aprueba] ?? ''), ...lista);
}

// ----- resumen

const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

async function resumenView({ clientId, bigua, base }) {
  const [r, alta] = await Promise.all([api('GET', `/clients/${enc(clientId)}/resumen`),
    bigua ? api('GET', `/clients/${enc(clientId)}/asistente/alta`) : Promise.resolve(null)]);
  const avisos = [];
  const aviso = (nivel, texto, href, accion) => avisos.push({ nivel, texto, href, accion });
  if (alta && alta.listos < alta.total) {
    aviso(alta.esperando ? 'warn' : 'mute', `Alta: ${alta.listos} de ${alta.total} pasos listos` +
      `${alta.esperando ? ` · ${plural(alta.esperando, 'espera', 'esperan')} una definición` : ''}.`, `${base}/alta`, 'Seguir con el alta');
  }
  if (!r.sdr_activo) {
    aviso('mute', bigua ? 'El SDR no está activado para este cliente.' : 'El SDR todavía no está activado. Lo activa Biguá.',
      bigua ? `${base}/admin` : null, 'Activar');
  }
  if (!r.buzones.length) aviso('warn', 'Todavía no hay buzones: el SDR no puede mandar mails.', `${base}/canales`, 'Cargar un buzón');
  for (const b of r.buzones) {
    if (b.status === 'auth_error') aviso('err', `${b.email} está bloqueado: el servidor rechazó la contraseña.`, `${base}/canales`, 'Cargar la contraseña');
    else if (b.status === 'paused') aviso('mute', `${b.email} está pausado: el SDR no lo usa.`, `${base}/canales`, 'Ver');
  }
  for (const d of r.dominios) {
    if (d.status === 'error') aviso('err', `${d.domain} tiene SPF, DKIM o DMARC mal: los mails pueden ir a spam.`, `${base}/canales`, 'Ver cómo arreglarlo');
  }
  if (r.sdr_activo) {
    if (r.revisar_descripcion) {
      aviso('warn', 'Revisar la descripción de la empresa: arrancó como una copia de la oferta. Contá qué hace la empresa en general; lo de cada campaña va en su propuesta.',
        `${base}/empresa`, 'Revisarla');
    }
    if (r.aprobaciones_pendientes) {
      const delCliente = r.aprobaciones_del_cliente ?? 0;
      aviso('warn', delCliente && !bigua
        ? `${plural(delCliente, 'mensaje espera', 'mensajes esperan')} tu aprobación.`
        : `${plural(r.aprobaciones_pendientes, 'aprobación espera', 'aprobaciones esperan')}${r.aprueba === 'bigua' ? ' en el chat del orquestador' : ''}.`,
      `${base}/aprobaciones`, 'Ver');
    }
    const sinAtender = r.correo_sin_atender + r.linkedin_sin_atender;
    if (sinAtender) aviso('warn', `${plural(sinAtender, 'respuesta de un prospecto espera', 'respuestas de prospectos esperan')} al bot de seguimiento.`);
    if (r.dripify?.ultimo_error) aviso('err', `LinkedIn · Dripify: ${r.dripify.ultimo_error}`, bigua ? `${base}/admin/integraciones` : `${base}/canales`, 'Ver');
    if (r.crm?.estado === 'credencial_vencida') {
      aviso('err', `CRM: ${r.crm.proveedor === 'sheets' ? 'el gateway no puede escribir en la planilla' : 'HubSpot rechazó el token'}. Las cargas esperan en cola.${r.crm.ultimo_error ? ` ${r.crm.ultimo_error}` : ''}`, `${base}/canales`, 'Reconectar');
    }
    if (r.crm?.con_problema) aviso('err', `${plural(r.crm.con_problema, 'positivo no se pudo', 'positivos no se pudieron')} cargar en el CRM.`, `${base}/canales`, 'Ver');
    if (r.whatsapp?.pausado) aviso('err', `WhatsApp en pausa: ${r.whatsapp.pausa_motivo ?? 'bloqueo'}.`, bigua ? `${base}/admin/integraciones` : `${base}/canales`, bigua ? 'Revisar y reanudar' : 'Ver');
    for (const [bot, d] of Object.entries(r.despertadores ?? {})) {
      if (!d) aviso('mute', `El despertador de ${bot} no está cargado: el bot corre sólo en su horario.`, `${base}/admin/bots`, 'Cargarlo');
      else if (d.fallas) aviso('err', `El despertador de ${bot} falla (${d.fallas})${d.ultimo_error ? `: ${d.ultimo_error}` : ''}.`, `${base}/admin/bots`, 'Ver');
    }
    for (const c of r.corridas_con_error ?? []) {
      aviso('err', `${c.bot} · ${c.tarea} terminó con error (${fmtDate(c.inicio)})${c.resumen ? `: ${c.resumen}` : ''}.`);
    }
  }
  const atencion = h('section', { class: 'card' },
    h('h2', { class: 'first' }, 'Necesita atención'),
    avisos.length
      ? h('ul', { class: 'avisos' }, avisos.map((a) => h('li', {}, h('span', { class: `dot d-${a.nivel}`, 'aria-hidden': 'true' }),
        h('span', { class: 'aviso-texto' }, a.texto), a.href ? h('a', { href: a.href }, a.accion) : null)))
      : h('p', { class: 'muted' }, 'Nada pendiente.'));

  const stat = (n, label) => h('div', { class: 'stat' }, h('strong', {}, String(n)), h('span', {}, label));
  const semana = r.sdr_activo ? h('section', { class: 'card' },
    h('h2', { class: 'first' }, 'Últimos 7 días'),
    h('div', { class: 'stats' }, stat(r.semana.enviados, 'mails enviados'), stat(r.semana.linkedin, 'cargados en LinkedIn'),
      stat(r.semana.respuestas, 'respuestas'), stat(r.semana.positivos, 'positivos')),
    r.calibracion.total > r.calibracion.usados
      ? h('p', { class: 'small muted' }, `Calibración: ${r.calibracion.usados} de ${r.calibracion.total} mails aprobados y enviados. ` +
        'Hasta terminarla, cada mail nuevo se aprueba en el chat del orquestador.')
      : h('p', { class: 'small muted' }, 'Calibración terminada: los mails nuevos salen sin aprobación previa.')) : null;

  const activos = r.buzones.filter((b) => b.status === 'active');
  const envios = activos.reduce((n, b) => n + b.envios_hoy, 0);
  const tope = activos.reduce((n, b) => n + b.daily_send_cap, 0);
  const dom = r.dominios.length ? r.dominios.map((d) => `${d.domain} ${{ ok: 'bien', warn: 'revisar', error: 'mal' }[d.status] ?? 'sin verificar'}`).join(' · ')
    : 'Dominio sin verificar';
  const d = r.dripify;
  const li = !d?.cargado ? ['b-mute', 'sin cargar'] : !d.activo ? ['b-mute', 'apagado'] : d.ultimo_error ? ['b-err', 'con error'] : ['b-ok', 'cargado'];
  const canal = (titulo, [cls, estado], ...lineas) => h('a', { class: 'card canal-card', href: `${base}/canales` },
    h('div', { class: 'row spread' }, h('strong', {}, titulo), h('span', { class: `badge ${cls}` }, estado)),
    lineas.map((x) => h('div', { class: 'small muted' }, x)));
  const canales = h('div', { class: 'grid' },
    canal('Correo', activos.length ? (activos.length < r.buzones.length ? ['b-warn', 'revisar'] : ['b-ok', 'activo']) : ['b-err', 'sin buzones'],
      `${plural(activos.length, 'buzón activo', 'buzones activos')} · ${envios} de ${tope} envíos hoy`, dom),
    canal('LinkedIn · Dripify', li, d?.ultimo_ok_at ? `Última respuesta buena: ${fmtDate(d.ultimo_ok_at)}` : 'Va con la campaña de Dripify del cliente'),
    canal(`CRM · ${CRM_NOMBRE[r.crm?.proveedor] ?? 'HubSpot o planilla'}`, !r.crm?.conectado ? ['b-mute', 'sin conectar'] : r.crm.con_problema ? ['b-err', 'con problemas'] : crmEstado(r.crm),
      r.crm?.conectado ? `${plural(r.crm.semana, 'cargado', 'cargados')} en 7 días${r.crm.en_cola ? ` · ${r.crm.en_cola} en cola` : ''}` : 'Los positivos aprobados se cargan solos'),
    h('a', { class: 'card canal-card', href: `${base}/empresa#no-contactar` },
      h('div', { class: 'row spread' }, h('strong', {}, 'No contactar'), h('span', { class: 'badge b-mute' }, String(r.no_contactar.dominios + r.no_contactar.emails + (r.no_contactar.empresas ?? 0)))),
      h('div', { class: 'small muted' }, `${plural(r.no_contactar.dominios, 'dominio', 'dominios')} y ${plural(r.no_contactar.emails, 'mail', 'mails')} a los que el SDR no les escribe`)));
  // Las campañas activas y en pausa, con sus números de la semana (docs/21 §3.1). Mientras la pestaña
  // Campañas sea sólo de Biguá, el bloque también.
  const verCampanas = r.sdr_activo && (r.campanas?.length ?? 0) > 0 && (bigua || CAMPANAS_PARA_CLIENTES);
  const estadoCamp = { activa: ['b-ok', 'activa'], pausada: ['b-mute', 'en pausa'] };
  const calibTexto = (x) => (x.total > x.usados ? `${x.usados} de ${x.total}` : 'terminada');
  const campanas = verCampanas ? h('section', { class: 'card' },
    h('h2', { class: 'first' }, 'Campañas · últimos 7 días'),
    h('table', { class: 'campanas' },
      h('thead', {}, h('tr', {}, ['Campaña', 'Estado', 'Cuentas por día', 'Mails', 'LinkedIn', 'Respuestas', 'Positivos', 'Calibración']
        .map((x) => h('th', {}, x)))),
      h('tbody', {}, r.campanas.map((k) => {
        const [cls, txt] = estadoCamp[k.estado] ?? ['b-mute', k.estado];
        return h('tr', {},
          h('td', {}, h('a', { href: `${base}/campanas` }, k.nombre)),
          h('td', {}, h('span', { class: `badge ${cls}` }, txt)),
          h('td', {}, String(k.cuentas_por_dia)),
          h('td', {}, String(k.semana.enviados)), h('td', {}, String(k.semana.linkedin)),
          h('td', {}, String(k.semana.respuestas)), h('td', {}, String(k.semana.positivos)),
          h('td', {}, calibTexto(k.calibracion)));
      })))) : null;
  return h('div', { class: 'stack' }, atencion, semana, campanas, h('h2', {}, 'Canales'), canales);
}

// ----- empresa: los ajustes que leen los bots

function campoInput(c, valor) {
  const dis = !c.editable;
  if (c.tipo === 'parrafo') return h('textarea', { name: c.clave, rows: 4, maxlength: c.max, disabled: dis }, valor ?? '');
  if (c.tipo === 'lista') {
    return h('textarea', { name: c.clave, rows: Math.min(8, Math.max(3, (valor?.length ?? 0) + 1)), disabled: dis },
      Array.isArray(valor) ? valor.join('\n') : (valor ?? ''));
  }
  if (c.tipo === 'numero') return h('input', { name: c.clave, type: 'number', min: c.min, max: c.max, value: valor ?? '', disabled: dis });
  if (c.tipo === 'si_no') {
    return h('label', { class: 'check' }, h('input', { name: c.clave, type: 'checkbox', checked: valor === true, disabled: dis }), 'Sí');
  }
  if (c.tipo === 'url') return h('input', { name: c.clave, type: 'url', maxlength: c.max, value: valor ?? '', disabled: dis, placeholder: 'https://…' });
  if (c.tipo === 'email') return h('input', { name: c.clave, type: 'email', maxlength: c.max, value: valor ?? '', disabled: dis, placeholder: 'ana@empresa.com' });
  return h('input', { name: c.clave, maxlength: c.max, value: valor ?? '', disabled: dis });
}

function leerCampos(form, campos) {
  const out = {};
  for (const c of campos) {
    if (!c.editable) continue;
    const el = form.elements[c.clave];
    if (!el) continue;
    if (c.tipo === 'si_no') out[c.clave] = el.checked;
    else if (c.tipo === 'lista') out[c.clave] = el.value.split('\n').map((x) => x.trim()).filter(Boolean);
    else if (c.tipo === 'numero') out[c.clave] = el.value === '' ? null : Number(el.value);
    else out[c.clave] = el.value;
  }
  return out;
}

const conCandado = (c) => (c.editable ? c.titulo : h('span', {}, c.titulo, ' ', h('span', { class: 'lock' }, '🔒 lo cambia Biguá')));

function historialTabla(clientId, sdr, reload) {
  if (!sdr.historial.length) return h('p', { class: 'muted small' }, 'Todavía no hay cambios registrados.');
  return h('table', {}, h('thead', {}, h('tr', {}, ['Cuándo', 'Quién', 'Qué cambió', 'Nota', ''].map((x) => h('th', {}, x)))),
    h('tbody', {}, sdr.historial.map((v, i) => h('tr', {},
      h('td', { class: 'small' }, fmtDate(v.at)),
      h('td', { class: 'small' }, v.por_email ?? (v.por_rol === 'cli' ? 'CLI de Biguá' : '—')),
      h('td', { class: 'small' }, v.cambios_titulos.join(', ') || '—'),
      h('td', { class: 'small' }, v.nota ?? ''),
      h('td', {}, i === 0 ? h('span', { class: 'badge b-ok' }, 'vigente') : h('button', { class: 'sm', onclick: (ev) => {
        const b = ev.currentTarget;
        openDialog('Volver a esta versión', h('p', {}, `Los ajustes vuelven a como estaban el ${fmtDate(v.at)}. Queda en el historial y se puede deshacer.`), {
          submitLabel: 'Volver a esta versión',
          submit: async () => {
            const r = await api('POST', `/clients/${enc(clientId)}/sdr/historial/${v.id}/restaurar`);
            toast(r.cambios.length ? 'Listo: ajustes restaurados.' : 'Ya estaban así.');
            reload();
            return true;
          },
        });
        b.blur();
      } }, 'Volver a esta'))))));
}

async function empresaView({ clientId, bigua, base, reload }) {
  const sdr = await api('GET', `/clients/${enc(clientId)}/sdr`);
  if (!sdr.activo) {
    return h('div', { class: 'card empty' },
      h('p', {}, bigua ? 'El SDR no está activado para este cliente.' : 'El SDR todavía no está activado para esta cuenta. Lo activa Biguá.'),
      bigua ? h('a', { class: 'btn primary', href: `${base}/admin` }, 'Activarlo en Administración') : null);
  }
  const notaModo = 'A quién se le escribe, la propuesta, el volumen y los buzones son de cada campaña: se editan en su campaña. Esto vale para las campañas que no digan otra cosa.';
  const err = h('p', { class: 'err', role: 'alert' });
  const btn = h('button', { type: 'submit', class: 'primary' }, 'Guardar ajustes');
  const nota = h('input', { name: '_nota', maxlength: 300, placeholder: 'Opcional: por qué el cambio' });
  const form = h('form', { class: 'stack' },
    sdr.bloques.map((b) => h('section', { class: 'card bloque' },
      h('h2', { class: 'first' }, b.titulo),
      h('p', { class: 'muted small' }, b.ayuda),
      b.clave === 'operacion' ? h('p', { class: 'small' }, notaModo) : null,
      sdr.campos.filter((c) => c.bloque === b.clave).map((c) => field(conCandado(c), campoInput(c, sdr.ajustes[c.clave]), c.ayuda)))),
    h('div', { class: 'card guardar' },
      field('Nota del cambio', nota),
      err,
      h('div', { class: 'row' }, btn, h('span', { class: 'small muted' }, bigua
        ? 'Los cambios valen desde la próxima corrida de cada bot.'
        : 'Los cambios valen desde la próxima corrida de cada bot, y le avisamos al operador de Biguá.'))));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = { ajustes: leerCampos(form, sdr.campos), ...(nota.value.trim() ? { nota: nota.value.trim() } : {}) };
    const r = await busy(btn, () => api('PUT', `/clients/${enc(clientId)}/sdr/ajustes`, body), err);
    if (r) { toast(r.cambios.length ? 'Ajustes guardados.' : 'No había cambios.'); reload(); }
  });
  const otros = Object.keys(sdr.ajustes).filter((k) => !sdr.campos.some((c) => c.clave === k));
  const vista = h('section', { class: 'card' },
    h('h2', { class: 'first' }, 'Así lo leen los bots'),
    h('pre', { class: 'record preview' }, sdr.vista_previa ?? ''),
    otros.length ? h('p', { class: 'small muted' }, `Además hay ajustes cargados por Biguá fuera del formulario: ${otros.join(', ')}.`) : null);
  const nc = await noContactarCard(clientId);
  const out = h('div', { class: 'stack' },
    h('div', { class: 'sdr-grid' }, form, h('div', { class: 'stack sticky' }, vista)),
    nc,
    h('section', {}, h('h2', {}, 'Historial de cambios'), historialTabla(clientId, sdr, reload)));
  if (location.hash.endsWith('#no-contactar')) setTimeout(() => nc.scrollIntoView(), 0);
  return out;
}

// ----- campañas (docs/21 §3.2; etapa C1)

const ESTADO_CAMPANA = { borrador: ['borrador', 'b-mute'], activa: ['activa', 'b-ok'], pausada: ['pausada', 'b-warn'], terminada: ['terminada', 'b-mute'] };
const estadoBadge = (e) => { const [label, cls] = ESTADO_CAMPANA[e] ?? [e, 'b-mute']; return h('span', { class: `badge ${cls}` }, label); };

async function campanasView({ clientId, bigua, base, reload }) {
  let d;
  try { d = await api('GET', `/clients/${enc(clientId)}/sdr/campanas`); } catch (e) {
    if (e.status !== 404) throw e;
    return h('div', { class: 'card empty' }, h('p', {}, 'El SDR no está activado para este cliente.'),
      bigua ? h('a', { class: 'btn primary', href: `${base}/admin` }, 'Activarlo en Administración') : null);
  }
  const tipoDe = Object.fromEntries(d.tipos.map((t) => [t.clave, t.titulo]));
  const nueva = () => {
    const nombre = h('input', { name: 'nombre', required: true, maxlength: 120, placeholder: 'Por ejemplo: Webinar de automatización (28/11)' });
    const tipo = h('select', { name: 'tipo' }, d.tipos.map((t) => h('option', { value: t.clave }, t.titulo)));
    openDialog('Nueva campaña', h('div', {},
      field('Nombre', nombre), field('Tipo', tipo, 'Una vez activada, el tipo no cambia.'),
      h('p', { class: 'small muted' }, 'Arranca en borrador: se activa cuando no le falta nada.')), {
      submitLabel: 'Crear',
      submit: async (fd) => {
        const r = await api('POST', `/clients/${enc(clientId)}/sdr/campanas`, { nombre: fd.get('nombre'), tipo: fd.get('tipo') });
        location.hash = `${base}/campanas/${r.id}/asistente/objetivo`;
        return true;
      },
    });
  };
  const tope = d.tope_cuentas_dia;
  const volumen = tope === null
    ? `Las activas suman ${plural(d.cuentas_activas, 'cuenta nueva', 'cuentas nuevas')} por día. Sin tope cargado: puede haber una sola activa.`
    : `Las activas suman ${d.cuentas_activas} de ${tope} cuentas nuevas por día (el tope del cliente).`;
  const filas = d.campanas.map((k) => h('tr', {},
    h('td', {}, h('a', { href: `${base}/campanas/${k.id}` }, k.nombre), h('div', { class: 'small muted' }, tipoDe[k.tipo] ?? k.tipo,
      k.inicio || k.fin ? ` · ${k.inicio ?? '…'} → ${k.fin ?? '…'}` : '')),
    h('td', {}, estadoBadge(k.estado)),
    h('td', { class: 'small' }, k.buzones_emails.length ? k.buzones_emails.join(', ') : h('span', { class: 'muted' }, 'sin buzones')),
    h('td', { class: 'num' }, String(k.cuentas_por_dia)),
    h('td', { class: 'num' }, String(k.prospectos)),
    h('td', { class: 'num' }, String(k.respondieron)),
    h('td', {}, k.pendientes ? h('span', { class: 'badge b-warn' }, plural(k.pendientes, 'pendiente', 'pendientes')) : h('span', { class: 'muted small' }, '—'))));
  return h('div', { class: 'stack' },
    h('div', { class: 'row spread' },
      h('p', { class: 'muted small m0' }, volumen,
        d.puede_activar ? '' : ' Este cliente lo opera Biguá: el cliente arma borradores y Biguá los activa.'),
      h('button', { class: 'primary', onclick: nueva }, 'Nueva campaña')),
    h('table', { class: 'campanas' },
      h('thead', {}, h('tr', {}, ['Campaña', 'Estado', 'Buzones', 'Cuentas por día', 'Personas', 'Respondieron', 'Para activar'].map((x) => h('th', {}, x)))),
      h('tbody', {}, filas)));
}

const valorTexto = (v) => (v === undefined || v === null || v === '' ? '(vacío)'
  : Array.isArray(v) ? v.join(' · ') : typeof v === 'boolean' ? (v ? 'Sí' : 'No') : String(v));

// Un campo de la campaña. Los que se heredan de Empresa muestran el valor de Empresa hasta que se
// cambian para esta campaña; las listas que se suman muestran también las de Empresa.
function campoCampana(c, valor, d) {
  const empresa = d.empresa[c.clave];
  if (c.tipo === 'seleccion') {
    const lib = d.empresa[c.de] ?? [];
    if (!lib.length) return field(conCandado(c), h('p', { class: 'small muted' }, 'Empresa no tiene casos cargados.'), c.ayuda);
    const elegidos = new Set(valor ?? []);
    return field(conCandado(c), h('div', { class: 'opciones', 'data-campo': c.clave },
      lib.map((x) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: x, checked: elegidos.has(x), disabled: !c.editable }), x))), c.ayuda);
  }
  const input = campoInput({ ...c, tipo: c.tipo === 'urls' ? 'lista' : c.tipo }, valor);
  if (c.hereda) {
    const propio = valor !== undefined;
    const wrap = h('div', { class: 'hereda', 'data-campo': c.clave, 'data-modo': propio ? 'propio' : 'empresa' });
    const deEmpresa = h('div', { class: 'small muted de-empresa' }, `De Empresa: ${valorTexto(empresa)}`);
    const cambiar = h('button', { type: 'button', class: 'sm', onclick: () => {
      wrap.dataset.modo = 'propio';
      if (c.tipo === 'si_no') input.querySelector('input').checked = empresa === true;
      else if (!input.value) input.value = Array.isArray(empresa) ? empresa.join('\n') : (empresa ?? '');
      pintar();
    } }, 'Cambiar para esta campaña');
    const volver = h('button', { type: 'button', class: 'sm link', onclick: () => { wrap.dataset.modo = 'empresa'; pintar(); } }, 'Usar lo de Empresa');
    const pintar = () => {
      const p = wrap.dataset.modo === 'propio';
      input.hidden = !p; volver.hidden = !p || !c.editable; cambiar.hidden = p || !c.editable; deEmpresa.hidden = p;
    };
    wrap.append(deEmpresa, input, h('div', { class: 'row' }, cambiar, volver));
    pintar();
    return field(conCandado(c), wrap, c.ayuda);
  }
  const suma = Array.isArray(empresa) && empresa.length && (c.clave === 'excluir' || c.clave === 'objeciones')
    ? h('div', { class: 'small muted' }, `Además de las de Empresa: ${empresa.join(' · ')}`) : null;
  return field(conCandado(c), h('div', {}, input, suma), c.ayuda);
}

function leerCampana(form, campos) {
  const out = {};
  for (const c of campos) {
    if (!c.editable) continue;
    if (c.tipo === 'seleccion') {
      const box = form.querySelector(`[data-campo="${c.clave}"]`);
      if (box) out[c.clave] = [...box.querySelectorAll('input:checked')].map((x) => x.value);
      continue;
    }
    if (c.hereda && form.querySelector(`[data-campo="${c.clave}"]`)?.dataset.modo === 'empresa') { out[c.clave] = null; continue; }
    Object.assign(out, leerCampos(form, [{ ...c, tipo: c.tipo === 'urls' ? 'lista' : c.tipo }]));
  }
  return out;
}

// La ayuda de una columna de la campaña que depende de otros datos.
function pistaColumna(c, d) {
  if (c.clave === 'cuentas_por_dia' && d.tope_cuentas_dia !== null) {
    return `Las demás activas suman ${d.otras_activas}; el tope del cliente es ${d.tope_cuentas_dia}.`;
  }
  // Como lo que se hereda de Empresa: vacío, vale la de la cuenta de Dripify.
  if (c.clave === 'dripify_campana_id' && d.dripify_defecto !== undefined) {
    return d.dripify_defecto
      ? `Vacío: usa la campaña por defecto de la cuenta de Dripify (${d.dripify_defecto}). Se cambia sólo si esta campaña va a otra campaña de Dripify.`
      : 'La cuenta de Dripify no tiene campaña por defecto (Administración → LinkedIn y WhatsApp): sin una acá, esta campaña no carga a nadie en LinkedIn.';
  }
  return null;
}

function columnaInput(c, k, d) {
  const v = k[c.clave];
  const dis = !c.editable;
  if (c.clave === 'tipo') {
    return h('select', { name: 'tipo', disabled: dis }, d.tipos.map((t) => h('option', { value: t.clave, selected: t.clave === v }, t.titulo)));
  }
  if (c.tipo === 'fecha') return h('input', { name: c.clave, type: 'date', value: v ?? '', disabled: dis });
  if (c.tipo === 'ids') {
    if (!d.buzones_disponibles.length) return h('p', { class: 'small muted' }, 'El cliente no tiene buzones: se cargan en Canales.');
    const sel = new Set(v ?? []);
    return h('div', { class: 'opciones', 'data-col': 'buzones' }, d.buzones_disponibles.map((b) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', value: b.id, checked: sel.has(b.id), disabled: dis }), b.email,
      b.status !== 'active' ? h('span', { class: 'small muted' }, ` (${b.status === 'paused' ? 'pausado' : 'bloqueado'})`) : null)));
  }
  return campoInput({ ...c, editable: !dis }, v);
}

function leerColumnas(form, columnas) {
  const out = {};
  for (const c of columnas) {
    if (!c.editable || c.clave === 'estado') continue;
    if (c.tipo === 'ids') {
      const box = form.querySelector('[data-col="buzones"]');
      if (box) out.buzones = [...box.querySelectorAll('input:checked')].map((x) => x.value);
      continue;
    }
    const el = form.elements[c.clave];
    if (!el) continue;
    if (c.tipo === 'numero') out[c.clave] = el.value === '' ? null : Number(el.value);
    else if (c.tipo === 'fecha') out[c.clave] = el.value || null;
    else out[c.clave] = el.value;
  }
  return out;
}

// Una línea por sección, para leer la campaña entera sin abrir nada (docs/21 §3.2).
function resumenBloque(b, k, d) {
  const a = k.ajustes;
  const tipo = d.tipos.find((t) => t.clave === k.tipo)?.titulo ?? k.tipo;
  const corto = (t, n = 70) => (t && t.length > n ? `${t.slice(0, n)}…` : t);
  switch (b) {
    case 'objetivo': return [tipo, k.inicio || k.fin ? `${k.inicio ?? '…'} → ${k.fin ?? '…'}` : null].filter(Boolean).join(' · ');
    case 'propuesta': return corto(a.propuesta) ?? 'Sin propuesta';
    case 'audiencia': return [corto(a.icp, 40), a.roles_objetivo?.length ? plural(a.roles_objetivo.length, 'cargo', 'cargos') : null].filter(Boolean).join(' · ') || 'Sin audiencia';
    case 'mensajes': return corto(d.efectivos.valores.llamado_accion);
    case 'respuestas': return a.positivos?.length ? plural(a.positivos.length, 'positivo definido', 'positivos definidos') : 'Sin positivos propios';
    case 'ritmo': return `${plural(k.buzones.length, 'buzón', 'buzones')} · ${k.cuentas_por_dia} cuentas por día${k.dripify_campana_id ? ` · Dripify ${k.dripify_campana_id}` : d.dripify_defecto ? ` · Dripify por defecto (${d.dripify_defecto})` : ''}`;
    case 'avanzado': return `Calibra ${k.calibracion_mails} mails`;
    default: return '';
  }
}

const ORIGEN = { empresa: 'de Empresa', campana: 'de la campaña', ambas: 'Empresa + campaña', tipo: 'del tipo' };

async function campanaView({ clientId, bigua, base, reload }, id) {
  const path = `/clients/${enc(clientId)}/sdr/campanas/${enc(id)}`;
  const d = await api('GET', path);
  const k = d.campana;
  const err = h('p', { class: 'err', role: 'alert' });
  const errEstado = h('p', { class: 'err', role: 'alert' });
  const puedeEstado = d.columnas.find((c) => c.clave === 'estado')?.editable;
  const faltanEn = new Set(d.faltantes.map((f) => f.bloque));

  const cambiarEstado = (estado, btn) => busy(btn, async () => {
    const r = await api('PUT', path, { estado });
    toast({ activa: 'Campaña activada.', pausada: 'Campaña pausada.', terminada: 'Campaña terminada.' }[estado] ?? 'Listo.');
    reload();
    return r;
  }, errEstado);
  const acciones = [];
  if (puedeEstado && (k.estado === 'borrador' || k.estado === 'pausada')) {
    acciones.push(h('button', { class: 'primary', disabled: d.faltantes.length > 0,
      title: d.faltantes.length ? 'Falta completar lo que está marcado' : '', onclick: (ev) => cambiarEstado('activa', ev.currentTarget) }, 'Activar'));
  }
  if (puedeEstado && k.estado === 'activa') acciones.push(h('button', { onclick: (ev) => cambiarEstado('pausada', ev.currentTarget) }, 'Pausar'));
  if (puedeEstado && (k.estado === 'activa' || k.estado === 'pausada')) {
    acciones.push(h('button', { class: 'danger', onclick: () => openDialog('Terminar la campaña', h('p', {},
      `«${k.nombre}» deja de prospectar y no se puede reactivar: para repetirla, se duplica.`), {
      submitLabel: 'Terminar', danger: true,
      submit: async () => { await api('PUT', path, { estado: 'terminada' }); toast('Campaña terminada.'); reload(); return true; },
    }) }, 'Terminar'));
  }
  if (k.estado !== 'terminada') acciones.unshift(h('a', { class: 'btn', href: `${base}/campanas/${k.id}/asistente` }, 'Asistente'));
  acciones.push(h('button', { onclick: () => {
    const nombre = h('input', { name: 'nombre', maxlength: 120, value: `${k.nombre} (copia)` });
    openDialog('Duplicar la campaña', h('div', {}, field('Nombre de la copia', nombre),
      h('p', { class: 'small muted' }, 'Se copian los ajustes, los buzones, el tipo y el volumen, en un borrador nuevo. Las fechas y la campaña de Dripify no.')), {
      submitLabel: 'Duplicar',
      submit: async (fd) => { const r = await api('POST', `${path}/duplicar`, { nombre: fd.get('nombre') }); location.hash = `${base}/campanas/${r.id}`; return true; },
    });
  } }, 'Duplicar'));

  const terminada = k.estado === 'terminada';
  const nota = h('input', { name: '_nota', maxlength: 300, placeholder: 'Opcional: por qué el cambio' });
  const btn = h('button', { type: 'submit', class: 'primary' }, 'Guardar');
  const secciones = d.bloques.map((b) => {
    const cols = d.columnas.filter((c) => c.bloque === b.clave && c.clave !== 'estado');
    const campos = d.campos.filter((c) => c.bloque === b.clave);
    if (!cols.length && !campos.length) return null;
    return h('details', { class: 'card bloque campana-sec', open: faltanEn.has(b.clave) || k.estado === 'borrador' || null },
      h('summary', {}, h('strong', {}, b.titulo), faltanEn.has(b.clave) ? h('span', { class: 'dot d-warn', title: 'Falta completar' }) : null,
        h('span', { class: 'small muted resumen-sec' }, resumenBloque(b.clave, k, d))),
      h('p', { class: 'muted small' }, b.ayuda),
      cols.map((c) => field(conCandado(c), columnaInput(c, k, d), pistaColumna(c, d))),
      campos.map((c) => campoCampana(c, k.ajustes[c.clave], d)));
  });
  const form = h('form', { class: 'stack' }, secciones,
    terminada ? null : h('div', { class: 'card guardar' }, field('Nota del cambio', nota), err,
      h('div', { class: 'row' }, btn, h('span', { class: 'small muted' }, bigua ? '' : 'Le avisamos al operador de Biguá.'))));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = { ...leerColumnas(form, d.columnas), ajustes: leerCampana(form, d.campos), ...(nota.value.trim() ? { nota: nota.value.trim() } : {}) };
    const r = await busy(btn, () => api('PUT', path, body), err);
    if (r) { toast(r.cambios.length ? 'Campaña guardada.' : 'No había cambios.'); reload(); }
  });

  const faltan = d.faltantes.length ? h('section', { class: 'card' },
    h('h2', { class: 'first' }, 'Para activarla falta'),
    h('ul', { class: 'avisos' }, d.faltantes.map((f) => h('li', {}, h('span', { class: 'dot d-warn', 'aria-hidden': 'true' }),
      h('span', { class: 'aviso-texto' }, f.mensaje), f.bloque === 'empresa' ? h('a', { href: `${base}/empresa` }, 'Ir a Empresa') : null)))) : null;
  const vista = h('section', { class: 'card' },
    h('h2', { class: 'first' }, 'Así la van a leer los bots'),
    h('dl', { class: 'efectivos' }, Object.entries(d.efectivos.valores).map(([clave, v]) => [
      h('dt', {}, d.efectivos.titulos?.[clave] ?? clave, ' ', h('span', { class: 'small muted' }, `(${ORIGEN[d.efectivos.origen[clave]] ?? ''})`)),
      h('dd', {}, valorTexto(v))])));
  const volver = (v) => (ev) => {
    const b = ev.currentTarget;
    openDialog('Volver a esta versión', h('p', {}, `Los ajustes de la campaña vuelven a como estaban el ${fmtDate(v.at)}. ` +
      'El estado, el volumen y los buzones no cambian. Queda en el historial y se puede deshacer.'), {
      submitLabel: 'Volver a esta versión',
      submit: async () => {
        const r = await api('POST', `${path}/historial/${v.id}/restaurar`);
        toast(r.cambios.length ? 'Listo: campaña restaurada.' : 'Ya estaba así.');
        reload();
        return true;
      },
    });
    b.blur();
  };
  const historial = d.historial.length
    ? h('table', {}, h('thead', {}, h('tr', {}, ['Cuándo', 'Quién', 'Qué cambió', 'Nota', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, d.historial.map((v, i) => h('tr', {}, h('td', { class: 'small' }, fmtDate(v.at)),
        h('td', { class: 'small' }, v.por_email ?? (v.por_rol === 'cli' ? 'CLI de Biguá' : '—')), h('td', { class: 'small' }, v.cambios_titulos.join(', ') || '—'),
        h('td', { class: 'small' }, v.nota ?? ''),
        h('td', {}, i === 0 ? h('span', { class: 'badge b-ok' }, 'vigente')
          : terminada ? null : h('button', { class: 'sm', onclick: volver(v) }, 'Volver a esta'))))))
    : h('p', { class: 'muted small' }, 'Todavía no hay cambios registrados.');

  const semillas = await semillasCard({ clientId, path, k, terminada });
  return h('div', { class: 'stack' },
    h('a', { href: `${base}/campanas`, class: 'small' }, '← Campañas'),
    h('div', { class: 'row spread' },
      h('div', {}, h('h2', { class: 'first' }, k.nombre, ' ', estadoBadge(k.estado)),
        h('p', { class: 'small muted mono m0' }, k.clave)),
      h('div', { class: 'row' }, acciones)),
    terminada ? h('p', { class: 'note' }, `Terminada el ${fmtDate(k.terminada_at)}. No se edita ni se reactiva: para repetirla, duplicala.`) : null,
    errEstado,
    h('div', { class: 'sdr-grid' }, form, h('div', { class: 'stack sticky' }, faltan, vista)),
    semillas,
    h('section', {}, h('h2', {}, 'Historial de cambios'), historial));
}

// Las cuentas de la campaña que vienen de un archivo (docs/27): en una «Lista del cliente», las que
// el SDR prospecta en el orden del archivo; en cualquier campaña, las semillas del ICP (empresas
// modelo que no reciben nada).
// Las cargas de un destino, con su informe (30 días) y el botón para deshacerlas (docs/27 §4.1).
function resumenCarga(x) {
  const r = x.resumen ?? {};
  if (x.destino === 'no_contactar') {
    return [plural(r.nuevas ?? 0, 'fila nueva en la lista', 'filas nuevas en la lista'),
      r.ya_estaban ? `${plural(r.ya_estaban, 'ya estaba', 'ya estaban')}` : null].filter(Boolean).join(', ');
  }
  return [r.prospectar ? plural(r.prospectar, 'cuenta para prospectar', 'cuentas para prospectar') : null,
    semillasDe(r) ? plural(semillasDe(r), 'semilla', 'semillas') : null,
    r.personas ? plural(r.personas, 'persona', 'personas') : null,
    r.ya_en_registro ? `${plural(r.ya_en_registro, 'ya estaba', 'ya estaban')} en el registro` : null]
    .filter(Boolean).join(', ') || 'nada nuevo';
}

function tablaCargas(clientId, cargas, { vacio, alDeshacer }) {
  if (!cargas.length) return h('p', { class: 'muted small' }, vacio);
  const informe = (x) => async (ev) => {
    const r = await busy(ev.currentTarget, () => api('GET', `/clients/${enc(clientId)}/cargas/${enc(x.id)}/informe`));
    if (!r) return;
    const url = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv;charset=utf-8' }));
    const a = h('a', { href: url, download: r.nombre });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const deshacer = (x) => () => openDialog('Deshacer la carga', h('div', {},
    h('p', {}, x.destino === 'no_contactar'
      ? `Las filas que «${x.archivo}» agregó a No contactar salen de la lista. Lo que ya hicieron (cuentas excluidas, LinkedIn frenado) no vuelve atrás.`
      : `Las cuentas y personas que creó «${x.archivo}» salen del registro. Sólo se puede mientras nadie las haya trabajado ` +
        '(ningún mail, LinkedIn, aprobación ni próximo paso).'),
    h('p', { class: 'small muted' }, 'No se puede volver a hacer: para cargarlas de nuevo, se sube el archivo otra vez.')), {
    submitLabel: 'Deshacer', danger: true,
    submit: async () => {
      const r = await api('POST', `/clients/${enc(clientId)}/cargas/${enc(x.id)}/deshacer`);
      const d = r.deshecho;
      toast(d.destino === 'no_contactar' ? `Listo: ${plural(d.filas, 'fila salió', 'filas salieron')} de la lista.`
        : `Listo: ${plural(d.cuentas, 'cuenta salió', 'cuentas salieron')} del registro.`);
      alDeshacer?.(r);
      return true;
    },
  });
  return h('table', {}, h('thead', {}, h('tr', {}, ['Archivo', 'Cuándo', 'Quién', 'Resultado', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, cargas.map((x) => h('tr', {},
      h('td', {}, x.archivo, x.hoja ? h('div', { class: 'small muted' }, `hoja «${x.hoja}»`) : null),
      h('td', { class: 'small' }, fmtDate(x.creado_at)), h('td', { class: 'small' }, x.por_email),
      h('td', { class: 'small' }, x.estado === 'deshecho'
        ? [h('span', { class: 'badge b-mute' }, 'deshecha'), h('div', { class: 'muted' }, `${fmtDate(x.deshecho_at)}${x.deshecho_por ? ` · ${x.deshecho_por}` : ''}`)]
        : resumenCarga(x)),
      h('td', { class: 'acciones-carga' },
        x.tiene_informe ? h('button', { class: 'sm', type: 'button', onclick: informe(x) }, 'Informe') : null,
        x.estado === 'deshecho' ? null : h('button', { class: 'sm', type: 'button', onclick: deshacer(x) }, 'Deshacer'))))));
}

// Los lotes de la etapa 1 sólo traían semillas, contadas en «nuevas».
const semillasDe = (r) => r.semillas ?? (r.prospectar === undefined ? r.nuevas ?? 0 : 0);

async function semillasCard({ clientId, path, k, terminada }) {
  const card = h('section', { class: 'card' });
  const lista = h('div');
  const esLista = k.tipo === 'lista';
  const estado = h('div');
  const pintarEstado = async () => {
    if (!esLista) return;
    const { lista: x } = await api('GET', `${path}/lista`);
    estado.replaceChildren(...[h('ul', { class: 'carga-totales' },
      [[x.sin_trabajar, 'sin trabajar'], [x.en_curso, 'en curso'], [x.cerradas, 'excluida o descartada', 'excluidas o descartadas'],
        [x.semillas, 'semilla', 'semillas']]
        .map(([n, uno, varios]) => h('li', {}, h('strong', {}, String(n)), ' ', n === 1 || !varios ? uno : varios))),
    x.cargadas && !x.sin_trabajar ? h('p', { class: 'note' }, 'La lista se terminó: cargá más cuentas o terminá la campaña.') : null]
      .filter(Boolean));
  };
  const pintarLotes = async () => {
    const { cargas } = await api('GET', `/clients/${enc(clientId)}/cargas`);
    lista.replaceChildren(tablaCargas(clientId, cargas.filter((x) => x.campana_id === k.id), {
      vacio: 'Todavía no se cargó ningún archivo en esta campaña.', alDeshacer: () => { pintarLotes(); pintarEstado(); },
    }));
  };
  const subir = h('button', { type: 'button', disabled: terminada || null, onclick: () => cargaArchivoDialog({
    titulo: esLista ? `Subir cuentas a «${k.nombre}»` : `Subir semillas a «${k.nombre}»`, path: `${path}/cargas`, destino: 'campana',
    ayuda: esLista
      ? 'Cada fila es una empresa que el SDR va a prospectar, en el orden del archivo, con la persona de la fila si la trae (si no, busca a ' +
        'quien decide). La nota para el bot es el motivo del primer mail. Con la columna «Uso» en «semilla», la fila es una empresa modelo y ' +
        'no recibe nada. Una empresa que ya está en el registro no se mueve. Nada se guarda hasta confirmar.'
      : 'Empresas que son el modelo de lo que busca esta campaña (clientes o empresas ideales). Quedan en el registro con su rubro, tamaño ' +
        'y nota, marcadas como semillas: el SDR no les escribe. Una empresa que ya está en el registro no se toca. Nada se guarda hasta confirmar.',
    alTerminar: () => { pintarLotes(); pintarEstado(); },
  }) }, 'Subir Excel o CSV');
  card.append(
    h('div', { class: 'row spread' }, h('h2', { class: 'first' }, esLista ? 'Cuentas de la lista' : 'Semillas del ICP'), subir),
    h('p', { class: 'small muted' }, esLista
      ? 'Las empresas que esta campaña prospecta, cargadas desde un archivo. Para que el SDR no toque a una empresa en ninguna campaña ' +
        '(un cliente o un referido), va a Empresa → No contactar.'
      : 'Las cuentas modelo de esta campaña, cargadas desde un archivo. Para prospectar una lista dada, la campaña tiene que ser de tipo ' +
        '«Lista del cliente». Para que el SDR no toque a una empresa en ninguna campaña, va a Empresa → No contactar.'),
    estado, lista);
  await Promise.all([pintarLotes(), pintarEstado()]);
  return card;
}

// ----- carga de un archivo (docs/27): el mismo paso a paso para la lista de no contactar y para
// las semillas de una campaña. El archivo se lee en el servidor; la confirmación lo vuelve a mandar
// con la huella de la vista previa, así se aplica exactamente lo que se vio.

const MAX_ARCHIVO = 3 * 1024 * 1024;

function aBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const RESULTADO_CARGA = {
  nueva: ['entra', 'b-ok'], ya_estaba: ['ya estaba', 'b-mute'], repetida: ['repetida en el archivo', 'b-mute'],
  ya_en_registro: ['ya está en el registro', 'b-warn'], ya_era_semilla: ['ya era semilla', 'b-mute'],
  suma_contacto: ['otra persona de la misma empresa', 'b-ok'], suma_a_existente: ['ya estaba: suma el contacto', 'b-ok'],
  ya_existe: ['la persona ya está', 'b-mute'], no_contactar: ['en no contactar', 'b-err'], suprimida: ['pidió la baja', 'b-err'],
};
const USO_CARGA = { prospectar: 'prospectar', semilla: 'semilla' };
const resultadoBadge = (r) => { const [label, cls] = RESULTADO_CARGA[r] ?? [r ?? '—', 'b-mute']; return h('span', { class: `badge ${cls}` }, label); };
const ENTRA_COMO = { dominio: 'dominio', empresa: 'nombre', email: 'mail' };
const ESTADO_CUENTA = { en_investigacion: 'en investigación', en_contacto: 'en contacto', en_pausa: 'en pausa', excluida: 'excluida', descartada: 'descartada' };

// opciones: { titulo, path (sin /previa), destino: 'no_contactar' | 'campana', ayuda, alTerminar(r) }
function cargaArchivoDialog({ titulo, path, destino, ayuda, alTerminar }) {
  let estado = null; // { archivo, nombre, hoja, mapeo, previa }
  const errLocal = h('p', { class: 'err', role: 'alert' });
  const pasos = h('div', { class: 'stack' });
  const archivo = h('input', { type: 'file', accept: '.xlsx,.csv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

  const cuerpo = () => ({ archivo: estado.archivo, nombre: estado.nombre, ...(estado.hoja ? { hoja: estado.hoja } : {}),
    ...(estado.mapeo ? { mapeo: estado.mapeo } : {}) });

  async function previa() {
    errLocal.textContent = '';
    pasos.replaceChildren(h('p', { class: 'muted small' }, 'Leyendo el archivo…'));
    try {
      estado.previa = await api('POST', `${path}/previa`, cuerpo());
      estado.hoja = estado.previa.hoja;
      estado.mapeo = estado.previa.mapeo;
      pintar();
    } catch (e) { pasos.replaceChildren(); errLocal.textContent = e.message; }
  }

  archivo.addEventListener('change', async () => {
    const f = archivo.files?.[0];
    if (!f) return;
    if (f.size > MAX_ARCHIVO) { errLocal.textContent = 'El archivo pasa los 3 MB: partilo en dos o guardá sólo la hoja que se carga.'; return; }
    estado = { archivo: aBase64(await f.arrayBuffer()), nombre: f.name, hoja: null, mapeo: null, previa: null };
    await previa();
  });

  function mapeoUI(p) {
    const ejemplo = (i) => p.muestra.map((f) => f[i]).find((x) => x) ?? '';
    const filas = p.campos.map((c) => {
      const sel = h('select', { 'aria-label': c.titulo },
        c.obligatorio ? null : h('option', { value: '' }, '— no usar —'),
        p.encabezados.map((e, i) => h('option', { value: String(i), selected: p.mapeo[c.clave] === i || null },
          `${e}${ejemplo(i) ? ` (ej.: ${String(ejemplo(i)).slice(0, 40)})` : ''}`)));
      if (p.mapeo[c.clave] === undefined && !c.obligatorio) sel.value = '';
      sel.addEventListener('change', () => {
        const m = { ...estado.mapeo };
        if (sel.value === '') delete m[c.clave]; else m[c.clave] = Number(sel.value);
        // Una columna va a un solo campo: se saca de donde estaba.
        for (const [k, v] of Object.entries(m)) if (k !== c.clave && v === m[c.clave]) delete m[k];
        estado.mapeo = m;
        previa();
      });
      return field(`${c.titulo}${c.obligatorio ? ' *' : ''}`, sel);
    });
    const hoja = p.hojas.length > 1 ? field('Hoja', (() => {
      const sel = h('select', {}, p.hojas.map((x) => h('option', { value: x, selected: x === p.hoja || null }, x)));
      sel.addEventListener('change', () => { estado.hoja = sel.value; estado.mapeo = null; previa(); });
      return sel;
    })()) : null;
    return h('details', { class: 'card', open: true }, h('summary', {}, h('strong', {}, 'Columnas'),
      h('span', { class: 'small muted' }, ' · propuestas por el encabezado; corregilas si hace falta')),
    h('div', { class: 'carga-mapeo' }, hoja, filas));
  }

  function totalesUI(p) {
    const t = p.totales;
    const items = destino === 'no_contactar'
      ? [[t.nuevas, 'entra a la lista', 'entran a la lista'], [t.por_dominio, 'por dominio'], [t.por_nombre, 'por nombre, sin dominio'],
        [t.mails, 'mail de un contacto', 'mails de contactos'], [t.ya_estaban, 'ya estaba', 'ya estaban'],
        [t.repetidas, 'repetida en el archivo', 'repetidas en el archivo'], [t.invalidas, 'fila con errores', 'filas con errores']]
      : [[t.prospectar, 'cuenta para prospectar', 'cuentas para prospectar'], [t.semillas, 'semilla nueva', 'semillas nuevas'],
        [t.personas, 'persona nueva', 'personas nuevas'], [t.sin_dominio, 'sin dominio'],
        [t.suma_a_existente, 'ya estaba en investigación (suma sus contactos)', 'ya estaban en investigación (suman sus contactos)'],
        [t.ya_en_registro, 'ya está en el registro (no se toca)', 'ya están en el registro (no se tocan)'],
        [t.ya_eran_semilla, 'ya era semilla', 'ya eran semillas'], [t.repetidas, 'repetida en el archivo', 'repetidas en el archivo'],
        [t.personas_ya_existen, 'persona ya estaba', 'personas ya estaban'],
        [t.personas_bloqueadas, 'persona en no contactar o con baja', 'personas en no contactar o con baja'],
        [t.en_no_contactar, 'también en no contactar'], [t.invalidas, 'fila con errores', 'filas con errores']];
    const efecto = p.efecto && (p.efecto.cuentas_excluidas || p.efecto.cuentas_en_marcha || p.efecto.frenos) ? h('div', { class: 'note' },
      h('strong', {}, 'Al confirmar: '),
      [p.efecto.cuentas_excluidas ? `${plural(p.efecto.cuentas_excluidas, 'cuenta en investigación queda excluida', 'cuentas en investigación quedan excluidas')}` : null,
        p.efecto.cuentas_en_marcha ? `${plural(p.efecto.cuentas_en_marcha, 'cuenta ya en contacto deja', 'cuentas ya en contacto dejan')} de recibir mensajes nuevos` : null,
        p.efecto.frenos ? `${plural(p.efecto.frenos, 'persona cargada en Dripify se frena', 'personas cargadas en Dripify se frenan')}` : null]
        .filter(Boolean).join('; '), '.',
      p.efecto.cuentas?.length ? h('div', { class: 'small muted' }, p.efecto.cuentas.map((k) => `${k.nombre} (${ESTADO_CUENTA[k.estado] ?? k.estado})`).join(', ')) : null)
      : null;
    return h('div', { class: 'stack' },
      h('p', {}, `${plural(t.filas, 'fila', 'filas')} en «${estado.nombre}»${p.hoja ? `, hoja «${p.hoja}»` : ''}${p.campana ? `, para la campaña «${p.campana.nombre}»` : ''}.`),
      h('ul', { class: 'carga-totales' }, items.filter(([n]) => n).map(([n, uno, varios]) => h('li', {}, h('strong', {}, String(n)), ' ', n === 1 || !varios ? uno : varios))),
      efecto);
  }

  function filasUI(p) {
    const problemas = [...p.invalidas.map((x) => `renglón ${x.renglon}: ${x.motivo}`),
      ...p.avisos.map((x) => `renglón ${x.renglon}: ${x.avisos.join('; ')}`)];
    const cabeza = destino === 'no_contactar' ? ['Renglón', 'Empresa', 'Entra como', 'Motivo'] : ['Renglón', 'Empresa', 'Dominio', 'Uso', 'Contacto', 'Qué pasa'];
    const fila = (f) => (destino === 'no_contactar'
      ? h('tr', {}, h('td', { class: 'small' }, String(f.renglon)), h('td', {}, f.empresa ?? '—'),
        h('td', { class: 'small' }, f.error ? h('span', { class: 'badge b-err' }, f.error)
          : f.entradas.map((e) => h('div', {}, `${ENTRA_COMO[e.tipo]}: `, h('span', { class: 'mono' }, e.valor), ' ', resultadoBadge(e.resultado)))),
        h('td', { class: 'small' }, f.motivo ?? '—'))
      : h('tr', {}, h('td', { class: 'small' }, String(f.renglon)),
        h('td', {}, f.empresa ?? '—', f.vertical ? h('div', { class: 'small muted' }, f.vertical) : null), h('td', { class: 'small mono' }, f.dominio ?? '—'),
        h('td', { class: 'small' }, USO_CARGA[f.uso] ?? '—'),
        h('td', { class: 'small' }, f.persona ? [h('div', {}, f.persona.nombre, f.persona.cargo ? ` · ${f.persona.cargo}` : ''),
          f.persona.email ? h('div', { class: 'mono' }, f.persona.email) : null, f.persona.resultado ? resultadoBadge(f.persona.resultado) : null] : '—'),
        h('td', { class: 'small' }, f.error ? h('span', { class: 'badge b-err' }, f.error) : resultadoBadge(f.resultado),
          f.existente ? h('div', { class: 'muted' }, `${ESTADO_CUENTA[f.existente.estado] ?? f.existente.estado}${f.existente.campana ? `, campaña «${f.existente.campana}»` : ''}`) : null,
          f.en_no_contactar ? h('div', { class: 'muted' }, 'está en no contactar') : null)));
    return h('div', { class: 'stack' },
      problemas.length ? h('details', {}, h('summary', { class: 'small' }, `${plural(problemas.length, 'renglón para revisar', 'renglones para revisar')}`),
        h('ul', { class: 'small' }, problemas.slice(0, 50).map((x) => h('li', {}, x)))) : null,
      h('div', { class: 'carga-tabla' }, h('table', {}, h('thead', {}, h('tr', {}, cabeza.map((x) => h('th', {}, x)))),
        h('tbody', {}, p.filas.map(fila)))),
      p.totales.filas > p.filas.length ? h('p', { class: 'small muted' }, `Se muestran las primeras ${p.filas.length} filas.`) : null);
  }

  function pintar() {
    const p = estado.previa;
    pasos.replaceChildren(mapeoUI(p), totalesUI(p), filasUI(p));
  }

  dlg.classList.add('ancho');
  dlg.addEventListener('close', () => dlg.classList.remove('ancho'), { once: true });
  openDialog(titulo, h('div', { class: 'stack' },
    h('p', { class: 'small muted' }, ayuda),
    field('Archivo (Excel .xlsx o CSV, hasta 2.000 filas)', archivo),
    errLocal, pasos), {
    submitLabel: 'Confirmar la carga',
    submit: async () => {
      if (!estado?.previa) throw new Error('Elegí un archivo y revisá la vista previa antes de confirmar.');
      const r = await api('POST', path, { ...cuerpo(), huella: estado.previa.huella });
      toast(`Listo: ${plural(r.lote.resumen.nuevas, 'fila cargada', 'filas cargadas')}.`);
      alTerminar?.(r);
      return true;
    },
  });
}

// ----- no contactar

async function noContactarCard(clientId) {
  const card = h('section', { class: 'card', id: 'no-contactar' });
  const path = `/clients/${enc(clientId)}/no-contactar`;
  const salida = h('div', { class: 'small', role: 'status' });
  let lista = [];
  const filtro = h('input', { type: 'search', placeholder: 'Buscar en la lista', 'aria-label': 'Buscar en la lista' });
  const cuerpo = h('div');
  const pintarLista = () => {
    const q = filtro.value.trim().toLowerCase();
    const vistas = (q ? lista.filter((x) => x.valor.includes(q) || (x.nombre ?? '').toLowerCase().includes(q) || (x.motivo ?? '').toLowerCase().includes(q)) : lista);
    const muestra = vistas.slice(0, 200);
    cuerpo.replaceChildren(!lista.length ? h('p', { class: 'muted small' }, 'La lista está vacía.') : h('div', {},
      h('table', {}, h('thead', {}, h('tr', {}, ['Empresa, dominio o mail', 'Motivo', 'Cargado', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, muestra.map((x) => h('tr', {},
          h('td', {}, x.tipo === 'empresa' ? h('span', {}, x.nombre ?? x.valor) : h('span', { class: 'mono' }, x.valor),
            h('div', { class: 'small muted' }, { dominio: 'dominio y sus subdominios', email: 'mail', empresa: 'empresa por nombre, con cualquier forma societaria' }[x.tipo] ?? x.tipo)),
          h('td', { class: 'small' }, x.motivo ?? '—'),
          h('td', { class: 'small' }, fmtDate(x.at), x.por_email ? h('div', { class: 'muted' }, x.por_email) : null,
            x.lote_archivo ? h('div', { class: 'muted' }, `desde «${x.lote_archivo}»`) : null),
          h('td', {}, h('button', { class: 'sm', type: 'button', onclick: async (ev) => {
            const r = await busy(ev.currentTarget, () => api('POST', `${path}/quitar`, { valores: [x.valor] }));
            if (r) { pintar(r); toast(`${x.valor} salió de la lista.`); }
          } }, 'Quitar')))))),
      vistas.length > muestra.length ? h('p', { class: 'small muted' }, `Se muestran ${muestra.length} de ${vistas.length}: buscá para encontrar el resto.`) : null));
  };
  filtro.addEventListener('input', pintarLista);
  const totales = h('span', { class: 'badge b-mute' });
  const pintar = (r) => {
    lista = r.no_contactar;
    totales.textContent = `${plural(r.totales.dominios, 'dominio', 'dominios')} · ${plural(r.totales.emails, 'mail', 'mails')} · ${plural(r.totales.empresas ?? 0, 'empresa', 'empresas')}`;
    filtro.hidden = lista.length < 15;
    pintarLista();
  };
  const informar = (r) => {
    const partes = [`${plural(r.agregados, 'agregado', 'agregados')}`];
    if (r.ya_estaban) partes.push(`${r.ya_estaban} ya estaban`);
    salida.replaceChildren(h('p', {}, `${partes.join(', ')}.`),
      r.invalidas?.length ? h('div', { class: 'err' }, `${plural(r.invalidas.length, 'renglón no tiene', 'renglones no tienen')} un dominio, un mail o un nombre válido: `,
        r.invalidas.slice(0, 5).map((x) => `renglón ${x.renglon} («${x.texto}»)`).join(', '), r.invalidas.length > 5 ? '…' : '') : null);
  };
  const informarEfecto = (e) => {
    if (!e || !(e.cuentas_excluidas || e.cuentas_en_marcha || e.frenos)) return;
    salida.append(h('p', { class: 'small' }, [
      e.cuentas_excluidas ? plural(e.cuentas_excluidas, 'cuenta en investigación quedó excluida', 'cuentas en investigación quedaron excluidas') : null,
      e.cuentas_en_marcha ? `${plural(e.cuentas_en_marcha, 'cuenta en contacto ya no recibe', 'cuentas en contacto ya no reciben')} nada nuevo` : null,
      e.frenos ? `${plural(e.frenos, 'persona se frena', 'personas se frenan')} en Dripify en la próxima vuelta` : null].filter(Boolean).join('; ') + '.'));
  };
  const err = h('p', { class: 'err', role: 'alert' });
  const valor = h('input', { id: 'nc-valor', required: true, maxlength: 300, placeholder: 'empresa.com, persona@empresa.com o el nombre de la empresa' });
  const motivo = h('input', { id: 'nc-motivo', maxlength: 200, placeholder: 'Cliente actual, competidor, pidió que no…' });
  const agregar = h('button', { type: 'submit', class: 'primary' }, 'Agregar');
  const alta = h('form', { class: 'nc-alta' }, field('Dominio, mail o empresa', valor), field('Motivo', motivo), agregar);
  alta.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const r = await busy(agregar, () => api('POST', path, { valor: valor.value, ...(motivo.value.trim() ? { motivo: motivo.value.trim() } : {}) }), err);
    if (r) { pintar(r); informar(r); informarEfecto(r.efecto); valor.value = ''; motivo.value = ''; valor.focus(); }
  });
  const lotes = h('div');
  const pintarLotes = async () => {
    const { cargas } = await api('GET', `/clients/${enc(clientId)}/cargas`);
    const deLista = cargas.filter((x) => x.destino === 'no_contactar');
    lotes.replaceChildren(...(deLista.length ? [h('details', {}, h('summary', { class: 'small' }, `Cargas desde archivo (${deLista.length})`),
      tablaCargas(clientId, deLista, { alDeshacer: async () => { pintar(await api('GET', path)); pintarLotes(); } }))] : []));
  };
  const subir = h('button', { type: 'button', onclick: () => cargaArchivoDialog({
    titulo: 'Subir un Excel a no contactar', path: `${path}/cargas`, destino: 'no_contactar',
    ayuda: 'Clientes, referidos, partners: cada fila es una empresa que el SDR no toca en ninguna campaña. Con sitio web entra por dominio; ' +
      'sin sitio, por el nombre (sin importar la forma societaria). El motivo queda a la vista en la lista. Nada se guarda hasta confirmar.',
    alTerminar: (r) => { pintar(r); informarEfecto(r.efecto); pintarLotes(); },
  }) }, 'Subir Excel o CSV');
  const pegar = h('button', { type: 'button', onclick: () => openDialog('Pegar una lista', h('div', {},
    h('p', { class: 'small muted' }, 'Un dominio, un mail o el nombre de una empresa por renglón. Después de una coma, el motivo (opcional).'),
    h('textarea', { name: 'csv', rows: 10, required: true, placeholder: 'empresa.com, Cliente actual\npersona@otra.com, Pidió que no\nAgrícola Ortiz, Referido de Juan' })), {
    submitLabel: 'Agregar',
    submit: async (fd) => { const r = await api('POST', path, { csv: fd.get('csv') }); pintar(r); informar(r); informarEfecto(r.efecto); return true; },
  }) }, 'Pegar una lista');
  card.append(
    h('div', { class: 'row spread' }, h('h2', { class: 'first' }, 'No contactar'), totales),
    h('p', { class: 'small muted' }, 'Empresas y personas a las que el SDR no les escribe nunca, de ninguna campaña ni canal: clientes actuales, ' +
      'partners, competidores, quien pidió que no. El gateway la hace cumplir: una empresa de la lista queda excluida y nadie de ella ' +
      'recibe mails ni invitaciones de LinkedIn. Un dominio cubre también sus subdominios; una empresa por nombre vale con cualquier forma ' +
      'societaria («Ortiz y Cía. Ltda.» es «Ortiz»). Si alguien de esa empresa ya está en marcha, se frena.'),
    alta, err,
    h('div', { class: 'row' }, subir, pegar,
      h('span', { class: 'small muted' }, 'Un Excel con la columna de la empresa (y, si hay, sitio web, motivo y mail del contacto).')),
    salida, lotes, filtro, cuerpo);
  pintar(await api('GET', path));
  await pintarLotes();
  return card;
}

// ----- canales

// Canales (docs/29 §Pestañas): lo que el cliente conecta y ve. El correo y el CRM se cargan acá; de
// LinkedIn y WhatsApp se ve el estado, y su configuración técnica es de Biguá (Administración).
async function canalesView({ clientId, data, bigua, base, reload }) {
  const resumen = await api('GET', `/clients/${enc(clientId)}/resumen`);
  const configurar = bigua ? h('a', { class: 'btn', href: `${base}/admin/integraciones` }, 'Configurar') : null;
  const d = resumen.dripify;
  const linkedin = h('section', { class: 'card' },
    h('div', { class: 'row spread' }, h('h2', { class: 'first' }, 'LinkedIn · Dripify'),
      h('div', { class: 'row' }, !d?.cargado ? h('span', { class: 'badge b-mute' }, 'sin cargar') : d.ultimo_error ? h('span', { class: 'badge b-err' }, 'con error')
        : h('span', { class: 'badge b-ok' }, 'cargado'), configurar)),
    h('p', { class: 'small muted' }, bigua
      ? 'La cuenta de Dripify del cliente y su campaña: la API key, la campaña y el webhook se configuran en Administración.'
      : 'La cuenta de Dripify del cliente y su campaña. La conecta Biguá: si querés sumar LinkedIn, pedíselo.'),
    d?.ultimo_ok_at ? h('p', { class: 'small' }, `Última respuesta buena de Dripify: ${fmtDate(d.ultimo_ok_at)}`) : null,
    d?.ultimo_error ? h('p', { class: 'small err' }, d.ultimo_error) : null);
  const pronto = (titulo, texto) => h('div', { class: 'card' },
    h('div', { class: 'row spread' }, h('strong', {}, titulo), h('span', { class: 'badge b-mute' }, 'próximamente')),
    h('p', { class: 'small muted' }, texto));
  const w = resumen.whatsapp;
  const wa = h('section', { class: 'card' },
    h('div', { class: 'row spread' }, h('h2', { class: 'first' }, 'WhatsApp'), h('div', { class: 'row' }, whatsappBadge(w), configurar?.cloneNode(true) ?? null)),
    h('p', { class: 'small muted' }, 'Sólo para seguir una conversación con quien ya respondió o ya tiene chat con nosotros: nunca a números fríos. ' +
      (bigua ? 'El horario, las pausas y los topes se configuran en Administración.' : 'Lo activa Biguá.')),
    w?.activo ? h('p', { class: 'small' }, `Horario ${w.horario} · ${w.hoy.enviados} de ${w.hoy.tope_dia} mensajes hoy`) : null,
    w?.pausado ? h('p', { class: 'small err' }, w.pausa_motivo ?? 'En pausa.') : null);
  return h('div', { class: 'stack' },
    h('section', { class: 'stack' }, h('h2', { class: 'first' }, 'Correo'), mailboxesView(data, reload),
      h('h3', {}, 'Dominios'), await domainsView(clientId, reload)),
    h('section', { class: 'stack' }, h('h2', {}, 'CRM'), resumen.sdr_activo
      ? await crmView(clientId, bigua, reload)
      : pronto('CRM · HubSpot o planilla', 'Se conecta cuando el SDR esté activado: los positivos aprobados se cargan solos en HubSpot o en una planilla de Google Sheets.')),
    h('section', { class: 'stack' }, h('h2', {}, 'LinkedIn'), linkedin),
    h('section', { class: 'stack' }, h('h2', {}, 'WhatsApp'), wa));
}

// ----- CRM (docs/23): la conexión con HubSpot o con una planilla de Google Sheets (§14), la cola
// de cargas y la vista previa.

const CRM_ESTADO = {
  activa: ['b-ok', 'conectado'], pausada: ['b-mute', 'en pausa'], credencial_vencida: ['b-err', 'token rechazado'],
};
const CRM_NOMBRE = { hubspot: 'HubSpot', sheets: 'Google Sheets' };
const crmEstado = (cx) => (cx.proveedor === 'sheets' && cx.estado === 'credencial_vencida'
  ? ['b-err', 'sin acceso'] : CRM_ESTADO[cx.estado] ?? ['b-mute', cx.estado]);
const CARGA_ESTADO = {
  pendiente: ['b-mute', 'en cola'], en_curso: ['b-mute', 'cargando'], hecha: ['b-ok', 'cargado'],
  error: ['b-err', 'falló'], bloqueada: ['b-warn', 'bloqueada'],
};
const badge = ([cls, texto]) => h('span', { class: `badge ${cls}` }, texto);

async function crmView(clientId, bigua, reload) {
  const datos = await api('GET', `/clients/${enc(clientId)}/crm`);
  const wrap = h('div', { class: 'stack' });
  const pintar = (d) => wrap.replaceChildren(crmConexionCard(clientId, bigua, d.conexion, reload), ...(d.conexion ? crmCargasCards(clientId, d, pintar).filter(Boolean) : []));
  pintar(datos);
  return wrap;
}

// Dónde van los positivos: HubSpot o, si el cliente no tiene CRM, una planilla. Cambiar la opción
// sólo cambia el formulario; se guarda al conectar.
function crmConexionCard(clientId, bigua, cx, reload) {
  const caja = h('div', { class: 'stack' });
  const pintar = (proveedor) => {
    const selector = h('select', { name: 'proveedor', onchange: (ev) => pintar(ev.currentTarget.value) },
      h('option', { value: 'hubspot', selected: proveedor === 'hubspot' }, 'HubSpot'),
      h('option', { value: 'sheets', selected: proveedor === 'sheets' }, 'Una planilla de Google Sheets (sin CRM)'));
    const elegir = field('Dónde se cargan los positivos', selector,
      cx && proveedor !== cx.proveedor ? `Hoy se cargan en ${CRM_NOMBRE[cx.proveedor]}. Cambia al conectar; las cargas hechas quedan donde están.` : null);
    caja.replaceChildren(proveedor === 'sheets'
      ? crmPlanillaCard(clientId, bigua, cx?.proveedor === 'sheets' ? cx : null, cx, elegir, reload)
      : crmHubspotCard(clientId, bigua, cx?.proveedor === 'sheets' ? null : cx, cx, elegir, reload));
  };
  pintar(cx?.proveedor ?? 'hubspot');
  return caja;
}

// La planilla: la URL y el mail de la cuenta de servicio con el que el cliente la comparte.
function crmPlanillaCard(clientId, bigua, cx, guardado, elegir, reload) {
  const conectada = Boolean(cx?.conectado);
  const estado = badge(conectada ? crmEstado(cx) : ['b-mute', 'sin conectar']);
  const err = h('p', { class: 'err', role: 'alert' });
  const salida = h('div', {});
  const cuenta = guardado?.cuenta_google ?? null;
  const mail = cuenta ? h('input', { readonly: true, value: cuenta, class: 'mono' }) : null;
  const form = h('form', { class: 'card' },
    h('div', { class: 'row spread' }, h('h2', { class: 'first' }, 'Google Sheets'), estado),
    elegir,
    h('p', { class: 'muted small' }, 'Para el cliente que no tiene CRM y lleva su gestión en una planilla. Cuando el operador de ' +
      'Biguá aprueba la respuesta a un positivo, el gateway agrega una fila con la persona, la empresa, el canal, qué pide, lo que ' +
      'respondió y la respuesta aprobada. Nunca borra ni cambia una fila que ya estaba. Si la planilla ya tiene encabezados, usa ' +
      'los suyos (Nombre, Email, Empresa…) y agrega al final las columnas que falten.'),
    cuenta
      ? field('1. Compartí la planilla como Editor con este mail', h('div', { class: 'secret' }, mail,
        h('button', { type: 'button', onclick: async () => {
          try { await navigator.clipboard.writeText(cuenta); toast('Copiado.'); } catch { mail.select(); }
        } }, 'Copiar')), 'En Google Sheets: Compartir → pegar el mail → Editor. Sin esto, el gateway no puede escribir.')
      : h('p', { class: 'small err' }, 'El gateway todavía no tiene la cuenta de servicio de Google. La carga Biguá en Vercel ' +
        '(MAILGW_GOOGLE_SA); hasta entonces la planilla se puede guardar pero no probar.'),
    cx?.ultimo_error ? h('p', { class: 'small err' }, cx.ultimo_error) : null,
    cx?.ultimo_ok_at ? h('p', { class: 'small' }, `Última escritura buena en la planilla: ${fmtDate(cx.ultimo_ok_at)}`) : null,
    field('2. URL de la planilla', h('input', { name: 'planilla_url', type: 'url', required: true, value: cx?.planilla_url ?? '',
      placeholder: 'https://docs.google.com/spreadsheets/d/…/edit#gid=0' }),
    'Copiala del navegador con la pestaña donde van los positivos abierta: el #gid= del final dice cuál es.' +
      (cx?.planilla_hoja ? ` Hoy: pestaña «${cx.planilla_hoja}».` : '')),
    conectada && bigua ? field('Tope de cargas por día', h('input', { name: 'tope_dia', type: 'number', min: 1, max: 1000, value: cx.tope_dia }), 'Sólo Biguá.') : null);

  const btn = h('button', { type: 'submit', class: 'primary' }, conectada ? 'Guardar' : 'Conectar planilla');
  const probar = conectada ? h('button', { type: 'button', onclick: async (ev) => {
    const r = await busy(ev.currentTarget, () => api('POST', `/clients/${enc(clientId)}/crm/probar`), err);
    if (!r) return;
    const e = r.prueba;
    salida.replaceChildren(h('div', { class: 'small' },
      h('p', {}, e.listo ? badge(['b-ok', 'listo']) : badge(['b-err', 'falta algo']),
        e.planilla ? ` ${e.planilla}${e.hoja ? ` · pestaña «${e.hoja}»` : ''}.` : ''),
      e.problemas?.length ? h('ul', {}, e.problemas.map((x) => h('li', { class: 'err' }, x))) : null,
      e.avisos?.length ? h('ul', {}, e.avisos.map((x) => h('li', { class: 'muted' }, x))) : null,
      e.columnas?.length ? h('p', { class: 'muted' }, `Columnas: ${e.columnas.join(' · ')}`) : null));
  } }, 'Probar conexión') : null;
  const vista = conectada ? h('button', { type: 'button', onclick: async (ev) => {
    const r = await busy(ev.currentTarget, () => api('POST', `/clients/${enc(clientId)}/crm/vista-previa`, {}), err);
    if (r) salida.replaceChildren(crmVistaPrevia(r.vista));
  } }, 'Vista previa') : null;
  const pausa = conectada ? h('button', { type: 'button', onclick: async (ev) => {
    const r = await busy(ev.currentTarget, () => api('PUT', `/clients/${enc(clientId)}/crm`, { estado: cx.estado === 'pausada' ? 'activa' : 'pausada' }), err);
    if (r) { toast(cx.estado === 'pausada' ? 'Cargas reanudadas.' : 'Cargas en pausa: quedan en cola.'); reload(); }
  } }, cx.estado === 'pausada' ? 'Reanudar' : 'Pausar') : null;
  form.append(err, h('div', { class: 'row' }, btn, probar, vista, pausa), salida);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const body = { proveedor: 'sheets', planilla_url: String(fd.get('planilla_url') ?? '').trim() };
    if (conectada && bigua) body.tope_dia = Number(fd.get('tope_dia'));
    const r = await busy(btn, () => api('PUT', `/clients/${enc(clientId)}/crm`, body), err);
    if (r) { toast(conectada ? 'Planilla guardada.' : 'Planilla conectada. Compartila con el mail de la cuenta y probá la conexión.'); reload(); }
  });
  return form;
}

function crmHubspotCard(clientId, bigua, cx, guardado, elegir, reload) {
  const estado = !cx?.token ? badge(['b-mute', 'sin conectar']) : badge(CRM_ESTADO[cx.estado] ?? ['b-mute', cx.estado]);
  const err = h('p', { class: 'err', role: 'alert' });
  const salida = h('div', {});
  const campoSel = h('select', { name: 'origen_campo' },
    h('option', { value: '' }, '— sólo en la nota —'),
    cx?.origen_campo ? h('option', { value: cx.origen_campo, selected: true }, cx.origen_campo) : null);
  const valorSel = h('select', { name: 'origen_valor' },
    h('option', { value: '' }, '—'),
    cx?.origen_valor ? h('option', { value: cx.origen_valor, selected: true }, cx.origen_valor) : null);
  const duenoSel = h('select', { name: 'dueno_defecto' },
    h('option', { value: '' }, '— sin asignar —'),
    cx?.dueno_defecto ? h('option', { value: cx.dueno_defecto, selected: true }, `Dueño ${cx.dueno_defecto}`) : null);
  let propiedades = [];
  const llenarValores = () => {
    const p = propiedades.find((x) => x.name === campoSel.value);
    const actual = valorSel.value;
    if (p?.options?.length) {
      valorSel.replaceChildren(h('option', { value: '' }, '— elegí un valor —'),
        ...p.options.map((o) => h('option', { value: o.value, selected: o.value === actual }, `${o.label} (${o.value})`)));
    } else if (p) {
      valorSel.replaceChildren(h('option', { value: 'SDR Bot Biguá', selected: true }, 'SDR Bot Biguá'));
    }
  };
  campoSel.addEventListener('change', llenarValores);
  const fijos = h('textarea', { name: 'campos_fijos', rows: 3, class: 'mono', placeholder: 'propiedad=valor, una por renglón' });
  fijos.value = Object.entries(cx?.campos_fijos ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');

  const form = h('form', { class: 'card' },
    h('div', { class: 'row spread' }, h('h2', { class: 'first' }, 'HubSpot'), estado),
    elegir,
    h('p', { class: 'muted small' }, 'Cuando el operador de Biguá aprueba la respuesta a un positivo, el gateway lo carga solo en el ' +
      'HubSpot del cliente: el contacto (si ya existe, sólo completa lo vacío y no cambia el dueño), la empresa por dominio, una nota ' +
      'con lo que respondió y una tarea para el dueño. Nunca borra nada.'),
    cx?.ultimo_error ? h('p', { class: 'small err' }, cx.ultimo_error) : null,
    cx?.ultimo_ok_at ? h('p', { class: 'small' }, `Última respuesta buena de HubSpot: ${fmtDate(cx.ultimo_ok_at)}`) : null,
    field('Token de la app privada', h('input', { name: 'token', type: 'password', autocomplete: 'off', required: !guardado?.token, minlength: 20 }),
      guardado?.token ? 'Dejalo vacío para conservar el guardado. Se guarda cifrado y no se vuelve a mostrar.'
        : 'En HubSpot: Settings → Integrations → Private Apps → Create a private app. Scopes: crm.objects.contacts (read y write), ' +
          'crm.objects.companies (read y write), crm.objects.owners.read y crm.schemas.contacts.read. Se guarda cifrado y no se vuelve a mostrar.'),
    cx?.token ? h('div', { class: 'cols2' },
      field('Propiedad que dice que vino del SDR', campoSel, 'Apretá «Probar conexión» para elegir entre las del cliente.'),
      field('Con el valor', valorSel)) : null,
    cx?.token ? field('Dueño por defecto', duenoSel, 'A quién le llega la tarea si el contacto es nuevo. Si ya existía, la tarea va a su dueño.') : null,
    cx?.token && bigua ? h('div', { class: 'cols2' },
      field('Campos fijos', fijos, 'Propiedades que el CRM del cliente exige, con un valor fijo. Sólo Biguá.'),
      field('Tope de cargas por día', h('input', { name: 'tope_dia', type: 'number', min: 1, max: 1000, value: cx.tope_dia }), 'Sólo Biguá.')) : null);

  const btn = h('button', { type: 'submit', class: 'primary' }, cx?.token ? 'Guardar' : 'Conectar HubSpot');
  const probar = cx?.token ? h('button', { type: 'button', onclick: async (ev) => {
    const r = await busy(ev.currentTarget, () => api('POST', `/clients/${enc(clientId)}/crm/probar`), err);
    if (!r) return;
    const e = r.prueba;
    propiedades = e.propiedades ?? [];
    if (propiedades.length) {
      const actual = campoSel.value;
      campoSel.replaceChildren(h('option', { value: '' }, '— sólo en la nota —'),
        ...propiedades.map((p) => h('option', { value: p.name, selected: p.name === actual }, `${p.label} (${p.name})`)));
      llenarValores();
    }
    if (e.duenos?.length) {
      const actual = duenoSel.value;
      duenoSel.replaceChildren(h('option', { value: '' }, '— sin asignar —'),
        ...e.duenos.map((o) => h('option', { value: o.id, selected: o.id === actual }, `${o.nombre}${o.email ? ` · ${o.email}` : ''}`)));
    }
    salida.replaceChildren(h('div', { class: 'small' },
      h('p', {}, e.listo ? badge(['b-ok', 'listo']) : badge(['b-err', 'falta algo']), e.portal_id ? ` Portal ${e.portal_id}.` : ''),
      e.problemas?.length ? h('ul', {}, e.problemas.map((x) => h('li', { class: 'err' }, x))) : null,
      e.avisos?.length ? h('ul', {}, e.avisos.map((x) => h('li', { class: 'muted' }, x))) : null));
  } }, 'Probar conexión') : null;
  const vista = cx?.token ? h('button', { type: 'button', onclick: async (ev) => {
    const r = await busy(ev.currentTarget, () => api('POST', `/clients/${enc(clientId)}/crm/vista-previa`, {}), err);
    if (r) salida.replaceChildren(crmVistaPrevia(r.vista));
  } }, 'Vista previa') : null;
  const pausa = cx?.token ? h('button', { type: 'button', onclick: async (ev) => {
    const r = await busy(ev.currentTarget, () => api('PUT', `/clients/${enc(clientId)}/crm`, { estado: cx.estado === 'pausada' ? 'activa' : 'pausada' }), err);
    if (r) { toast(cx.estado === 'pausada' ? 'Cargas reanudadas.' : 'Cargas en pausa: quedan en cola.'); reload(); }
  } }, cx.estado === 'pausada' ? 'Reanudar' : 'Pausar') : null;
  form.append(err, h('div', { class: 'row' }, btn, probar, vista, pausa), salida);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const body = { proveedor: 'hubspot' };
    if (fd.get('token')) body.token = String(fd.get('token')).trim();
    if (cx?.token) {
      body.origen_campo = String(fd.get('origen_campo') ?? '') || null;
      body.origen_valor = body.origen_campo ? String(fd.get('origen_valor') ?? '') || null : null;
      body.dueno_defecto = String(fd.get('dueno_defecto') ?? '') || null;
      if (bigua) {
        body.tope_dia = Number(fd.get('tope_dia'));
        const pares = String(fd.get('campos_fijos') ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
        const mal = pares.filter((x) => !/^[a-z0-9_]+=.+$/.test(x));
        if (mal.length) { err.textContent = `Campos fijos: «${mal[0]}» no es propiedad=valor.`; return; }
        body.campos_fijos = Object.fromEntries(pares.map((x) => [x.slice(0, x.indexOf('=')).trim(), x.slice(x.indexOf('=') + 1).trim()]));
      }
    }
    const r = await busy(btn, () => api('PUT', `/clients/${enc(clientId)}/crm`, body), err);
    if (r) { toast(cx?.token ? 'CRM guardado.' : 'HubSpot conectado. Probá la conexión y elegí el dueño por defecto.'); reload(); }
  });
  return form;
}

function crmVistaPrevia(v) {
  if (v.proveedor === 'sheets') {
    return h('div', { class: 'stack small' },
      h('p', {}, v.ejemplo ? 'Con un positivo de ejemplo (todavía no hay uno real):' : `Con el último positivo: ${v.nombre}.`,
        ' Nada de esto se escribió en la planilla.'),
      h('p', {}, `Va una fila nueva al final${v.hoja ? ` de la pestaña «${v.hoja}»` : ''}. Si ya hay una con el mismo ID registro, no se repite.`),
      h('table', {}, h('tbody', {}, v.fila.map((c) => h('tr', {}, h('td', { class: 'small' }, c.columna), h('td', { class: 'celda' }, c.valor))))));
  }
  const filas = (o) => h('table', {}, h('tbody', {}, Object.entries(o).map(([k, x]) => h('tr', {}, h('td', { class: 'mono small' }, k), h('td', {}, String(x))))));
  // La nota y la tarea van a HubSpot como HTML; acá se muestran como texto, sin interpretarlas.
  const comoTexto = (html) => html.replace(/<br>/g, '\n').replace(/<\/(p|blockquote)>/g, '\n').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
  const nota = h('pre', { class: 'nota' });
  nota.textContent = comoTexto(v.nota.hs_note_body);
  return h('div', { class: 'stack small' },
    h('p', {}, v.ejemplo ? 'Con un positivo de ejemplo (todavía no hay uno real):' : `Con el último positivo: ${v.nombre}.`,
      ' Nada de esto se escribió en HubSpot.'),
    h('p', {}, `Se busca el contacto por email (${v.buscar_por ?? 'sin email: la carga se bloquearía'}). Si existe, sólo se completan las propiedades vacías.`),
    h('strong', {}, 'Contacto'), filas(v.contacto),
    v.empresa ? [h('strong', {}, 'Empresa (por dominio)'), filas(v.empresa)] : h('p', { class: 'muted' }, 'Sin dominio: no se asocia empresa.'),
    h('strong', {}, 'Nota'), nota,
    h('strong', {}, 'Tarea'), filas({ asunto: v.tarea.hs_task_subject, vence: fmtDate(v.tarea.hs_timestamp), detalle: comoTexto(v.tarea.hs_task_body) }));
}

function crmCargasCards(clientId, d, pintar) {
  const err = h('p', { class: 'err', role: 'alert' });
  const accion = (texto, path, body) => h('button', { type: 'button', class: 'small', onclick: async (ev) => {
    const r = await busy(ev.currentTarget, () => api('POST', path, body), err);
    if (r) { toast(r.aviso ?? 'Listo.'); pintar(r); }
  } }, texto);
  const sinCargar = d.positivos_sin_cargar.length ? h('section', { class: 'card' },
    h('h3', { class: 'first' }, 'Positivos sin cargar'),
    h('p', { class: 'small muted' }, 'Positivos que no tienen carga (por ejemplo, de antes de conectar el CRM).'),
    h('table', {}, h('tbody', {}, d.positivos_sin_cargar.map((p) => h('tr', {},
      h('td', {}, p.nombre, h('div', { class: 'small muted' }, [p.email, p.empresa].filter(Boolean).join(' · '))),
      h('td', { class: 'small' }, fmtDate(p.actualizado_at)),
      h('td', {}, accion('Cargar en el CRM', `/clients/${enc(clientId)}/crm/cargar`, { prospecto_id: p.id }))))))) : null;
  const detalle = (k) => {
    if (k.estado === 'hecha') return k.url ? h('a', { href: k.url, target: '_blank', rel: 'noopener noreferrer' }, d.proveedor === 'sheets' ? 'Ver la fila' : 'Ver en HubSpot') : fmtDate(k.hecha_at);
    if (k.error) return h('span', { class: k.estado === 'pendiente' ? 'muted' : 'err' }, k.error);
    if (k.proximo_intento) return `Próximo intento: ${fmtDate(k.proximo_intento)}`;
    return '—';
  };
  const cargas = h('section', { class: 'card' },
    h('h3', { class: 'first' }, 'Cargas'),
    d.cargas.length ? h('table', {},
      h('thead', {}, h('tr', {}, ['Persona', 'Por', 'Estado', 'Detalle', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, d.cargas.map((k) => h('tr', {},
        h('td', {}, k.nombre, h('div', { class: 'small muted' }, [k.email, k.empresa].filter(Boolean).join(' · '))),
        h('td', { class: 'small' }, k.motivo === 'positivo' ? 'positivo aprobado' : `pedido${k.pedida_por ? ` · ${k.pedida_por}` : ''}`),
        h('td', {}, badge(CARGA_ESTADO[k.estado] ?? ['b-mute', k.estado]), k.intentos > 1 ? h('div', { class: 'small muted' }, `${k.intentos} intentos`) : null),
        h('td', { class: 'small' }, detalle(k)),
        h('td', {}, ['error', 'bloqueada'].includes(k.estado) ? accion('Reintentar', `/clients/${enc(clientId)}/crm/cargas/${k.id}/reintentar`) : null)))))
      : h('p', { class: 'muted small' }, 'Todavía no hay cargas. Entran solas cuando se aprueba la respuesta a un positivo.'),
    err);
  return [sinCargar, cargas];
}

function whatsappBadge(w) {
  if (!w?.activo) return h('span', { class: 'badge b-mute' }, 'no activado');
  if (w.pausado) return h('span', { class: 'badge b-err' }, 'en pausa');
  return h('span', { class: 'badge b-ok' }, w.en_horario ? 'activo' : 'activo · fuera de horario');
}

// Las reglas del turno de WhatsApp (docs/22): las hace cumplir el gateway, no el bot.
function whatsappCard(clientId, sdr, w, reload) {
  const c = sdr.whatsapp ?? {};
  const num = (name, v, min, max) => h('input', { name, type: 'number', min, max, required: true, value: v });
  const form = h('form', { class: 'card' },
    h('div', { class: 'row spread' }, h('h2', { class: 'first' }, 'WhatsApp · seguimiento'), whatsappBadge(w)),
    h('p', { class: 'muted small' }, 'El bot whatsapp manda desde WhatsApp Web, en el navegador de su asiento de Grok. Antes de cada mensaje le pide ' +
      'el turno al gateway, que sólo se lo da dentro del horario, con una pausa al azar entre envíos, sin pasar los topes, a contactos ' +
      'tibios (ya respondieron o ya tienen chat) y sin repetir un texto en 24 horas. Si WhatsApp avisa un bloqueo, todo queda en pausa.'),
    w?.pausado ? h('div', { class: 'note' }, h('strong', {}, 'En pausa. '), w.pausa_motivo ?? '', ` (${fmtDate(w.pausado_at)}). `,
      'Revisá la sesión de WhatsApp Web en el asiento antes de reanudar.') : null,
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'activo', checked: Boolean(c.activo) }), 'WhatsApp activado para este cliente'),
    h('div', { class: 'cols2' },
      field('Número de la sesión', h('input', { name: 'numero', value: c.numero ?? '', placeholder: '+54 9 11 5555 5555' }), 'Sólo para mostrar.'),
      field('Primer mensaje a cada persona', h('label', { class: 'check' },
        h('input', { type: 'checkbox', name: 'aprobar_primero', checked: c.aprobar_primero ?? true }), 'Con el OK del operador'))),
    h('div', { class: 'cols2' },
      field('Desde (hora del cliente)', num('hora_desde', c.hora_desde ?? 8, 0, 23)),
      field('Hasta', num('hora_hasta', c.hora_hasta ?? 24, 1, 24))),
    h('label', {}, 'Días'),
    h('div', { class: 'row' }, DIAS.map((x, i) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', name: 'dia', value: i + 1, checked: (c.dias ?? [1, 2, 3, 4, 5, 6, 7]).includes(i + 1) }), x))),
    h('div', { class: 'cols2' },
      field('Pausa entre envíos: mínimo (segundos)', num('pausa_min_seg', c.pausa_min_seg ?? 20, 5, 600)),
      field('Máximo (segundos)', num('pausa_max_seg', c.pausa_max_seg ?? 60, 5, 1800))),
    h('div', { class: 'cols2' },
      field('Mensajes por persona por día', num('tope_contacto_dia', c.tope_contacto_dia ?? 8, 1, 50)),
      field('Mensajes por día en total', num('tope_dia', c.tope_dia ?? 60, 1, 500))));
  const err = h('p', { class: 'err', role: 'alert' });
  const btn = h('button', { type: 'submit', class: 'primary' }, 'Guardar');
  const reanudar = w?.pausado ? h('button', { type: 'button', onclick: async (ev) => {
    const r = await busy(ev.currentTarget, () => api('PUT', `/clients/${enc(clientId)}/sdr/whatsapp`, { reanudar: true }), err);
    if (r) { toast('WhatsApp reanudado.'); reload(); }
  } }, 'Reanudar') : null;
  form.append(err, h('div', { class: 'row' }, btn, reanudar));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const body = {
      activo: fd.get('activo') === 'on', aprobar_primero: fd.get('aprobar_primero') === 'on',
      numero: String(fd.get('numero') ?? '').trim() || null, dias: fd.getAll('dia').map(Number),
      ...Object.fromEntries(['hora_desde', 'hora_hasta', 'pausa_min_seg', 'pausa_max_seg', 'tope_contacto_dia', 'tope_dia']
        .map((k) => [k, Number(fd.get(k))])),
    };
    const r = await busy(btn, () => api('PUT', `/clients/${enc(clientId)}/sdr/whatsapp`, body), err);
    if (r) { toast('Reglas de WhatsApp guardadas.'); reload(); }
  });
  return form;
}

// ----- administración (sólo Biguá)

function sdrTecnico(clientId, sdr, reload) {
  const t = sdr.tecnico;
  const modo = t?.modo ?? 'operado';
  const form = h('form', { class: 'card' },
    h('h2', { class: 'first' }, t ? 'Configuración del SDR' : 'Activar el SDR'),
    h('div', { class: 'cols2' },
      field('Canal de reglas', h('select', { name: 'canal' },
        ['estable', 'canario'].map((x) => h('option', { value: x, selected: t?.canal === x }, x)))),
      field('Zona horaria', h('input', { name: 'zona_horaria', value: t?.zona_horaria ?? 'America/Argentina/Buenos_Aires' }))),
    field('Calibración: mails nuevos que se aprueban en el chat', h('input', { name: 'calibracion_mails', type: 'number', min: 0, max: 500, value: t?.calibracion_mails ?? 20 }),
      t ? `Van ${t.calibracion_usadas} aprobados y enviados. En 0, los mails salen sin aprobación previa.` : 'Por defecto, 20.'),
    h('label', {}, 'Bots activos'),
    h('div', { class: 'row' }, sdr.bots.map((b) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', name: 'bot', value: b, checked: t ? t.bots_activos.includes(b) : ['orquestador', 'prospector'].includes(b) }), b))),
    h('fieldset', {}, h('legend', {}, 'Modo de operación'),
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'modo', value: 'operado', checked: modo === 'operado' }),
        'Operado por Biguá: el volumen, los buzones y los mails extrapolados los decide Biguá'),
      h('label', { class: 'check' }, h('input', { type: 'radio', name: 'modo', value: 'autogestionado', checked: modo === 'autogestionado' }),
        'Autogestionado: los decide el cliente'),
      field('Tope de cuentas nuevas por día para el cliente', h('input', { name: 'tope_cuentas_dia', type: 'number', min: 0, max: 100, value: t?.tope_cuentas_dia ?? '' }),
        'Sólo cuenta en modo autogestionado. Vacío: sin tope (hasta 100).')),
    h('fieldset', {}, h('legend', {}, 'Quién aprueba los mensajes'),
      [['bigua', 'Biguá, en el chat del orquestador'], ['cliente_y_bigua', 'El cliente o Biguá: vale la primera decisión'],
        ['cliente', 'Sólo el cliente: Biguá puede rechazar, no aprobar']].map(([x, label]) => h('label', { class: 'check' },
        h('input', { type: 'radio', name: 'aprueba', value: x, checked: (t?.aprueba ?? 'cliente_y_bigua') === x }), label)),
      h('p', { class: 'small muted' }, 'Vale para los mails de primer contacto, las respuestas a positivos y el primer WhatsApp. Lo del CRM lo aprueba siempre Biguá.')),
    t?.version_fija ? h('p', { class: 'note' }, `Este cliente está fijado a la versión ${t.version_fija} de las reglas (se cambia por la CLI).`) : null);
  const err = h('p', { class: 'err', role: 'alert' });
  const btn = h('button', { type: 'submit', class: 'primary' }, t ? 'Guardar configuración' : 'Activar el SDR');
  form.append(err, h('div', { class: 'row' }, btn));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const tope = String(fd.get('tope_cuentas_dia') ?? '').trim();
    const body = {
      canal: fd.get('canal'), zona_horaria: String(fd.get('zona_horaria')).trim(),
      calibracion_mails: Number(fd.get('calibracion_mails')), bots_activos: fd.getAll('bot'),
      modo: fd.get('modo') ?? 'operado', tope_cuentas_dia: tope === '' ? null : Number(tope),
      aprueba: fd.get('aprueba') ?? 'cliente_y_bigua',
    };
    const r = await busy(btn, () => api('PUT', `/clients/${enc(clientId)}/sdr/config`, body), err);
    if (r) { toast(t ? 'Configuración guardada.' : 'SDR activado. Ahora cargá los ajustes en Empresa.'); reload(); }
  });
  return form;
}

const DIAS = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];

const AVISOS = {
  seguimiento: { titulo: 'Despertador de seguimiento', rutina: 'SDR · respuestas', bot: 'seguimiento',
    que: 'Cuando llega correo, el gateway despierta la routine «SDR · respuestas» del bot seguimiento por su webhook.' },
  orquestador: { titulo: 'Despertador del orquestador', rutina: 'SDR · aprobaciones', bot: 'orquestador',
    que: 'Cuando hay aprobaciones pendientes (por ejemplo, la respuesta a un positivo), el gateway despierta la routine «SDR · aprobaciones» del orquestador por su webhook, sin esperar a las 12 o las 16.' },
};

function despertadorCard(clientId, sdr, reload, bot = 'seguimiento') {
  const a = AVISOS[bot];
  const d = sdr.despertadores?.[bot] ?? (bot === 'seguimiento' ? sdr.despertador : null);
  const estado = !d ? h('span', { class: 'badge b-mute' }, 'sin cargar')
    : !d.activo ? h('span', { class: 'badge b-mute' }, 'apagado')
      : d.fallas ? h('span', { class: 'badge b-err' }, `falla (${d.fallas})`) : h('span', { class: 'badge b-ok' }, 'activo');
  const form = h('form', { class: 'card' },
    h('div', { class: 'row spread' }, h('h2', { class: 'first' }, a.titulo), estado),
    h('p', { class: 'muted small' }, `${a.que} Copiá la URL y la clave desde esa routine en la app de Grok.`),
    d?.ultimo_aviso_at ? h('p', { class: 'small' }, `Último aviso: ${fmtDate(d.ultimo_aviso_at)} · respuesta ${d.ultimo_estado ?? '—'}`,
      d.ultimo_error ? h('span', { class: 'err' }, ` · ${d.ultimo_error}`) : null) : null,
    field('URL del webhook', h('input', { name: 'url', type: 'url', required: true, value: d?.url ?? '', placeholder: 'https://…' })),
    field('Clave del webhook', h('input', { name: 'clave', type: 'password', autocomplete: 'off', required: !d, minlength: 8 }),
      d ? 'Dejala vacía para conservar la guardada. Se guarda cifrada y no se vuelve a mostrar.' : 'Se guarda cifrada y no se vuelve a mostrar.'),
    h('div', { class: 'cols2' },
      field('Desde (hora del cliente)', h('input', { name: 'hora_desde', type: 'number', min: 0, max: 23, value: d?.hora_desde ?? 8 })),
      field('Hasta', h('input', { name: 'hora_hasta', type: 'number', min: 1, max: 24, value: d?.hora_hasta ?? 20 }))),
    h('label', {}, 'Días'),
    h('div', { class: 'row' }, DIAS.map((x, i) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', name: 'dia', value: i + 1, checked: (d?.dias ?? [1, 2, 3, 4, 5]).includes(i + 1) }), x))),
    field('Minutos mínimos entre dos avisos', h('input', { name: 'espera_min', type: 'number', min: 1, max: 240, value: d?.espera_min ?? 10 }),
      'Los mails que llegan en ese lapso van juntos en un solo aviso.'));
  const err = h('p', { class: 'err', role: 'alert' });
  const btn = h('button', { type: 'submit', class: 'primary' }, d ? 'Guardar' : 'Cargar despertador');
  const off = d?.activo ? h('button', { type: 'button', class: 'danger', onclick: async (ev) => {
    const r = await busy(ev.currentTarget, () => api('PUT', `/clients/${enc(clientId)}/sdr/despertador`, { apagar: true, bot }), err);
    if (r) { toast(`Despertador apagado: ${bot} corre sólo en su horario.`); reload(); }
  } }, 'Apagar') : null;
  form.append(err, h('div', { class: 'row' }, btn, off));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const body = {
      bot, url: String(fd.get('url')).trim(), hora_desde: Number(fd.get('hora_desde')), hora_hasta: Number(fd.get('hora_hasta')),
      dias: fd.getAll('dia').map(Number), espera_min: Number(fd.get('espera_min')),
      ...(fd.get('clave') ? { clave: String(fd.get('clave')).trim() } : {}),
    };
    const r = await busy(btn, () => api('PUT', `/clients/${enc(clientId)}/sdr/despertador`, body), err);
    if (r) { toast('Despertador guardado.'); reload(); }
  });
  return form;
}

// LinkedIn por Dripify: la API key (no se muestra), la campaña esqueleto, probar y el webhook.
function dripifyCard(clientId, sdr, reload) {
  const d = sdr.dripify;
  const estado = !d?.api_key ? h('span', { class: 'badge b-mute' }, 'sin cargar')
    : !d.activo ? h('span', { class: 'badge b-mute' }, 'apagado')
      : d.ultimo_error ? h('span', { class: 'badge b-err' }, 'con error') : h('span', { class: 'badge b-ok' }, 'cargado');
  const form = h('form', { class: 'card' },
    h('div', { class: 'row spread' }, h('h2', { class: 'first' }, 'LinkedIn · Dripify'), estado),
    h('p', { class: 'muted small' }, 'La cuenta de Dripify del cliente y su campaña esqueleto (nota de invitación, mensaje 1 al aceptar y ' +
      'mensaje 2 después) con los campos sdr_nota, sdr_mensaje1 y sdr_mensaje2. Los textos los escribe el bot para cada persona.'),
    d?.ultimo_error ? h('p', { class: 'small err' }, d.ultimo_error) : null,
    d?.ultimo_ok_at ? h('p', { class: 'small' }, `Última respuesta buena de Dripify: ${fmtDate(d.ultimo_ok_at)}`) : null,
    field('API key de Dripify', h('input', { name: 'api_key', type: 'password', autocomplete: 'off', required: !d?.api_key, minlength: 10 }),
      d?.api_key ? 'Dejala vacía para conservar la guardada. Se guarda cifrada y no se vuelve a mostrar.'
        : 'En Dripify: Settings → Integrations → Open API. Se guarda cifrada y no se vuelve a mostrar.'),
    h('div', { class: 'cols2' },
      field('Campaña por defecto', h('input', { name: 'campana_id', type: 'number', min: 1, required: true, value: d?.campana_id ?? '' }),
        'El número de la URL de la campaña en Dripify. La usan las campañas del SDR que no eligen una propia (en cada campaña, Canales y ritmo).'),
      field('Largo máximo de la nota', h('input', { name: 'nota_max', type: 'number', min: 100, max: 300, value: d?.nota_max ?? 300 }),
        '300 con LinkedIn Premium, 200 sin.')));
  const err = h('p', { class: 'err', role: 'alert' });
  const salida = h('div', {});
  const btn = h('button', { type: 'submit', class: 'primary' }, d?.api_key ? 'Guardar' : 'Cargar Dripify');
  const probar = d?.api_key ? h('button', { type: 'button', onclick: async (ev) => {
    const r = await busy(ev.currentTarget, () => api('POST', `/clients/${enc(clientId)}/sdr/dripify/probar`), err);
    if (!r) return;
    const e = r.estado;
    salida.replaceChildren(h('div', { class: 'small' },
      h('p', {}, e.listo ? h('span', { class: 'badge b-ok' }, 'listo') : h('span', { class: 'badge b-err' }, 'falta algo'),
        e.campana ? ` Campaña «${e.campana.nombre}» (${e.campana.estado}).` : ''),
      e.problemas?.length ? h('ul', {}, e.problemas.map((x) => h('li', { class: 'err' }, x))) : null,
      e.campanas?.length ? h('p', { class: 'muted' }, 'Campañas con una campaña de Dripify propia: ',
        e.campanas.map((x) => `«${x.nombre}» → ${x.dripify_nombre ? `«${x.dripify_nombre}» (${x.dripify_estado})` : `${x.dripify} (no existe)`}`).join(' · ')) : null,
      e.estadisticas ? h('p', { class: 'muted' }, `Prospectos: ${e.estadisticas.prospectos ?? '—'} · contactados: ${e.estadisticas.contactados ?? '—'}` +
        ` · aceptación: ${e.estadisticas.aceptacion ?? '—'} · respuesta: ${e.estadisticas.respuesta ?? '—'}`) : null,
      e.cupo ? h('p', { class: 'muted' }, `Pedidos a la API hoy: ${e.cupo.dia} de ${e.cupo.tope_dia}.`) : null));
  } }, 'Probar') : null;
  const hook = h('button', { type: 'button', onclick: async (ev) => {
    if (d?.webhook && !window.confirm('Ya hay una URL de webhook. Si generás otra, la anterior deja de andar y hay que cambiarla en Dripify. ¿Seguir?')) return;
    const r = await busy(ev.currentTarget, () => api('POST', `/clients/${enc(clientId)}/sdr/dripify/webhook`), err);
    if (!r) return;
    const url = `${window.location.origin}${r.ruta}`;
    const campo = h('input', { readonly: true, value: url, class: 'mono', onfocus: (e) => e.currentTarget.select() });
    salida.replaceChildren(h('div', { class: 'small' },
      h('p', {}, 'URL del webhook (se muestra una sola vez). En la campaña de Dripify: Webhooks, una por disparador, ' +
        'agregando al final ?e=invitacion, ?e=conexion, ?e=mensaje o ?e=respuesta según el disparador:'), campo));
    campo.focus();
  } }, d?.webhook ? 'Generar otra URL del webhook' : 'Generar URL del webhook');
  form.append(err, h('div', { class: 'row' }, btn, probar, d?.api_key ? hook : null), salida);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const body = {
      campana_id: Number(fd.get('campana_id')), nota_max: Number(fd.get('nota_max')),
      ...(fd.get('api_key') ? { api_key: String(fd.get('api_key')).trim() } : {}),
    };
    const r = await busy(btn, () => api('PUT', `/clients/${enc(clientId)}/sdr/dripify`, body), err);
    if (r) { toast('Dripify guardado. Probalo para ver si la campaña y los campos están.'); reload(); }
  });
  return form;
}

const ADMIN = [['operacion', 'Operación'], ['bots', 'Bots y despertadores'], ['integraciones', 'LinkedIn y WhatsApp'], ['usuarios', 'Usuarios'], ['tokens', 'Tokens de Grok Bot']];

async function adminView({ clientId, data, base, reload }, sub) {
  if (!ADMIN.some(([k]) => k === sub)) sub = 'operacion';
  const nav = h('nav', { class: 'sidenav', 'aria-label': 'Administración' },
    ADMIN.map(([k, label]) => h('a', { href: `${base}/admin/${k}`, class: k === sub ? 'on' : '' }, label)));
  let contenido;
  if (sub === 'usuarios') contenido = usersView(data, reload);
  else if (sub === 'tokens') contenido = tokensView(data, reload);
  else {
    const sdr = await api('GET', `/clients/${enc(clientId)}/sdr`);
    if (sub === 'operacion') {
      contenido = h('div', { class: 'stack' },
        sdr.activo ? null : h('p', { class: 'muted' }, 'Este cliente no tiene el SDR activado. Elegí la configuración y activalo; después cargá los ajustes en Empresa.'),
        sdrTecnico(clientId, sdr, reload));
    } else if (!sdr.activo) {
      contenido = h('div', { class: 'card empty' }, sub === 'integraciones'
        ? 'Activá el SDR en Operación para configurar LinkedIn y WhatsApp.' : 'Activá el SDR en Operación para configurar los bots.');
    } else if (sub === 'integraciones') {
      // Lo técnico de los canales que opera Biguá (docs/29 §Pestañas); el cliente ve su estado en Canales.
      const r = await api('GET', `/clients/${enc(clientId)}/resumen`);
      contenido = h('div', { class: 'stack' },
        h('p', { class: 'small muted' }, 'La configuración técnica de LinkedIn y WhatsApp. El cliente ve el estado de cada uno en Canales.'),
        dripifyCard(clientId, sdr, reload), whatsappCard(clientId, sdr, r.whatsapp, reload));
    } else {
      const activos = sdr.tecnico.bots_activos;
      contenido = h('div', { class: 'stack' },
        h('p', { class: 'small muted' }, `Bots activos: ${activos.join(', ')}. Se cambian en Operación. Sin despertador, un bot corre sólo en su horario.`),
        activos.includes('orquestador') ? despertadorCard(clientId, sdr, reload, 'orquestador') : null,
        activos.includes('seguimiento') ? despertadorCard(clientId, sdr, reload, 'seguimiento') : null);
    }
  }
  return h('div', { class: 'side' }, nav, h('div', { class: 'stack' }, contenido));
}

// ----- buzones

function mailboxesView(data, reload) {
  const cid = data.client.id;
  const add = h('button', { class: 'primary', onclick: () => mailboxDialog(cid, null, reload) }, 'Agregar buzón');
  if (!data.mailboxes.length) {
    return h('div', {}, h('div', { class: 'card empty' }, h('p', {}, 'Este cliente todavía no tiene buzones.'), add));
  }
  const rows = data.mailboxes.map((m) => h('tr', {},
    h('td', {}, h('strong', {}, m.email), m.display_name ? h('div', { class: 'small muted' }, m.display_name) : null,
      h('div', { class: 'small muted' }, m.firma ? 'Firma propia' : 'Firma por defecto (Empresa)')),
    h('td', { class: 'small' },
      h('div', {}, `IMAP ${m.imap_host}:${m.imap_port} (${m.imap_security})`),
      h('div', {}, `SMTP ${m.smtp_host}:${m.smtp_port} (${m.smtp_security})`)),
    h('td', {}, statusBadge(m.status),
      m.last_error ? h('div', { class: 'small err' }, m.last_error) : null,
      h('div', { class: 'small muted' }, `último OK: ${fmtDate(m.last_ok_at)}`)),
    h('td', { class: 'small' }, `${m.sends_today} / ${m.daily_send_cap}`),
    h('td', {}, h('div', { class: 'actions' },
      h('button', { class: 'sm', onclick: (ev) => checkMailbox(ev.currentTarget, cid, m, reload) }, 'Probar'),
      h('button', { class: 'sm', onclick: () => mailboxDialog(cid, m, reload) }, 'Editar'),
      h('button', { class: 'sm', onclick: () => passwordDialog(cid, m, reload) }, 'Contraseña'),
      m.status === 'paused' || m.status === 'auth_error'
        ? (m.status === 'paused' ? h('button', { class: 'sm', onclick: (ev) => setStatus(ev.currentTarget, cid, m, 'active', reload) }, 'Reactivar') : null)
        : h('button', { class: 'sm', onclick: (ev) => setStatus(ev.currentTarget, cid, m, 'paused', reload) }, 'Pausar'),
      data.can_manage_access ? h('button', { class: 'sm danger', onclick: () => deleteMailbox(cid, m, reload) }, 'Eliminar') : null))));
  return h('div', {},
    h('div', { class: 'row spread' }, h('p', { class: 'muted small' },
      'Las contraseñas se guardan cifradas y no se vuelven a mostrar. Un buzón bloqueado por contraseña se reactiva cargando la correcta.'), add),
    h('table', {}, h('thead', {}, h('tr', {}, ['Buzón', 'Servidores', 'Estado', 'Envíos hoy', ''].map((t) => h('th', {}, t)))), h('tbody', {}, rows)));
}

const PRESETS = { tls: { imap: 993, smtp: 465 }, starttls: { imap: 143, smtp: 587 } };

function mailboxDialog(clientId, m, reload) {
  const isNew = !m;
  const v = m ?? { imap_security: 'tls', smtp_security: 'tls', imap_port: 993, smtp_port: 465, timezone: 'America/Argentina/Buenos_Aires', daily_send_cap: 40, append_sent: true };
  const sec = (name, value) => h('select', { name }, h('option', { value: 'tls', selected: value === 'tls' }, 'TLS'), h('option', { value: 'starttls', selected: value === 'starttls' }, 'STARTTLS'));
  const imapSec = sec('imap_security', v.imap_security);
  const smtpSec = sec('smtp_security', v.smtp_security);
  const imapPort = h('input', { name: 'imap_port', type: 'number', min: 1, max: 65535, required: true, value: v.imap_port });
  const smtpPort = h('input', { name: 'smtp_port', type: 'number', min: 1, max: 65535, required: true, value: v.smtp_port });
  imapSec.addEventListener('change', () => { imapPort.value = PRESETS[imapSec.value].imap; });
  smtpSec.addEventListener('change', () => { smtpPort.value = PRESETS[smtpSec.value].smtp; });
  const imapHost = h('input', { name: 'imap_host', required: true, value: v.imap_host ?? '', placeholder: 'mail.dominio.com' });
  const smtpHost = h('input', { name: 'smtp_host', required: true, value: v.smtp_host ?? '', placeholder: 'mail.dominio.com' });
  imapHost.addEventListener('change', () => { if (!smtpHost.value) smtpHost.value = imapHost.value; });
  const email = h('input', { name: 'email', type: 'email', required: isNew, disabled: !isNew, value: v.email ?? '' });
  const username = h('input', { name: 'username', value: v.username ?? '', placeholder: 'igual al email' });

  const body = h('div', {},
    h('div', { class: 'cols2' },
      field('Email del buzón', email, isNew ? null : 'El email no se cambia: para otro, crear otro buzón.'),
      field('Nombre que ve el destinatario', h('input', { name: 'display_name', value: v.display_name ?? '', placeholder: 'Ana Pérez' }))),
    h('div', { class: 'cols2' },
      field('Usuario de login', username, 'Casi siempre es el email.'),
      isNew ? field('Contraseña del buzón', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'new-password' }),
        'Se guarda cifrada; no se vuelve a mostrar.') : h('div')),
    field('Firma', h('textarea', { name: 'firma', rows: 3, maxlength: 600, placeholder: 'Ana Pérez · Directora Comercial · Empresa' }, v.firma ?? ''),
      'Va al pie de cada mail que sale de este buzón. Vacía: la firma por defecto de Empresa.'),
    h('fieldset', {}, h('legend', {}, 'Entrada (IMAP)'),
      h('div', { class: 'cols' }, field('Servidor', imapHost), field('Seguridad', imapSec), field('Puerto', imapPort))),
    h('fieldset', {}, h('legend', {}, 'Salida (SMTP)'),
      h('div', { class: 'cols' }, field('Servidor', smtpHost), field('Seguridad', smtpSec), field('Puerto', smtpPort))),
    h('fieldset', {}, h('legend', {}, 'Comportamiento'),
      h('div', { class: 'cols2' },
        field('Tope de envíos por día', h('input', { name: 'daily_send_cap', type: 'number', min: 0, max: 1000, required: true, value: v.daily_send_cap })),
        field('Zona horaria', h('input', { name: 'timezone', required: true, value: v.timezone }))),
      h('div', { class: 'cols2' },
        field('Carpeta de enviados', h('input', { name: 'sent_folder', value: v.sent_folder ?? '', placeholder: 'automática' })),
        field('Carpeta de borradores', h('input', { name: 'drafts_folder', value: v.drafts_folder ?? '', placeholder: 'automática' }))),
      h('label', { class: 'check' }, h('input', { name: 'append_sent', type: 'checkbox', checked: v.append_sent }),
        'Guardar copia de lo enviado en la carpeta de enviados')));

  openDialog(isNew ? 'Agregar buzón' : `Editar ${m.email}`, body, {
    submitLabel: isNew ? 'Agregar' : 'Guardar',
    submit: async (fd) => {
      const payload = {
        display_name: fd.get('display_name').trim() || null,
        username: fd.get('username').trim() || undefined,
        imap_host: fd.get('imap_host').trim(), imap_port: Number(fd.get('imap_port')), imap_security: fd.get('imap_security'),
        smtp_host: fd.get('smtp_host').trim(), smtp_port: Number(fd.get('smtp_port')), smtp_security: fd.get('smtp_security'),
        daily_send_cap: Number(fd.get('daily_send_cap')), timezone: fd.get('timezone').trim(),
        sent_folder: fd.get('sent_folder').trim() || null, drafts_folder: fd.get('drafts_folder').trim() || null,
        append_sent: fd.get('append_sent') === 'on',
        firma: String(fd.get('firma') ?? '').trim() || null,
      };
      if (isNew) {
        payload.email = fd.get('email').trim();
        payload.password = fd.get('password');
        if (!payload.username) delete payload.username;
        await api('POST', `/clients/${enc(clientId)}/mailboxes`, payload);
        toast(`Buzón ${payload.email} agregado. Probá la conexión.`);
      } else {
        if (!payload.username) delete payload.username;
        await api('PATCH', `/clients/${enc(clientId)}/mailboxes/${enc(m.email)}`, payload);
        toast('Cambios guardados.');
      }
      reload();
      return true;
    },
  });
}

function passwordDialog(clientId, m, reload) {
  openDialog(`Contraseña de ${m.email}`, h('div', {},
    h('p', { class: 'muted' }, 'Reemplaza la guardada y, si el buzón estaba bloqueado por contraseña, lo reactiva.'),
    field('Contraseña nueva del buzón', h('input', { name: 'password', type: 'password', required: true, autocomplete: 'new-password' }))), {
    submit: async (fd) => {
      await api('POST', `/clients/${enc(clientId)}/mailboxes/${enc(m.email)}/password`, { password: fd.get('password') });
      toast('Contraseña actualizada. Probá la conexión.');
      reload();
      return true;
    },
  });
}

async function checkMailbox(btn, clientId, m, reload) {
  const label = btn.textContent;
  btn.textContent = 'Probando…';
  const r = await busy(btn, () => api('POST', `/clients/${enc(clientId)}/mailboxes/${enc(m.email)}/check`));
  btn.textContent = label;
  if (!r) { reload(); return; }
  const line = (name, v) => h('li', {}, h('strong', {}, `${name}: `), v === 'ok' ? h('span', { class: 'badge b-ok' }, 'conecta') : h('span', { class: 'err' }, v));
  openDialog(`Prueba de ${m.email}`, h('div', { class: 'result' },
    h('ul', {}, line('IMAP (leer)', r.imap), line('SMTP (enviar)', r.smtp)),
    r.folders.length ? h('div', {}, h('p', { class: 'muted small' }, 'Carpetas:'),
      h('ul', { class: 'small' }, r.folders.map((f) => h('li', {}, f.path, f.special_use ? h('span', { class: 'muted' }, ` ${f.special_use}`) : null,
        f.messages !== null ? h('span', { class: 'muted' }, ` · ${f.messages} msj.`) : null)))) : null));
  reload();
}

async function setStatus(btn, clientId, m, status, reload) {
  const r = await busy(btn, () => api('POST', `/clients/${enc(clientId)}/mailboxes/${enc(m.email)}/status`, { status }));
  if (r) { toast(status === 'paused' ? 'Buzón pausado: el bot no lo usa hasta reactivarlo.' : 'Buzón reactivado.'); reload(); }
}

function deleteMailbox(clientId, m, reload) {
  openDialog(`Eliminar ${m.email}`, h('div', {},
    h('p', {}, 'Se borra el buzón del gateway con su contraseña cifrada y su historial de envíos. El correo en el servidor no se toca.'),
    h('p', { class: 'note' }, 'Para dejar de usarlo un tiempo, mejor pausarlo.')), {
    submitLabel: 'Eliminar', danger: true,
    submit: async () => {
      await api('DELETE', `/clients/${enc(clientId)}/mailboxes/${enc(m.email)}`);
      toast('Buzón eliminado.');
      reload();
      return true;
    },
  });
}

// ----- usuarios

function userRows(users, reload) {
  return users.map((u) => h('tr', {},
    h('td', {}, h('strong', {}, u.name), h('div', { class: 'small muted' }, u.email)),
    h('td', {}, !u.active ? h('span', { class: 'badge b-mute' }, 'desactivado')
      : u.activated ? h('span', { class: 'badge b-ok' }, 'activo') : h('span', { class: 'badge b-warn' }, 'falta activar')),
    h('td', { class: 'small' }, fmtDate(u.last_login_at)),
    h('td', {}, h('div', { class: 'actions' },
      h('button', { class: 'sm', onclick: async (ev) => {
        const r = await busy(ev.currentTarget, () => api('POST', `/users/${enc(u.id)}/reset`));
        if (r) showSecret(`Enlace para ${u.email}`, activationLink(r.setup_token),
          'Mandale este enlace por un canal seguro. Sirve 24 horas, una vez, para elegir una contraseña nueva.');
      } }, u.activated ? 'Nueva contraseña' : 'Nuevo enlace'),
      u.id === me.id ? null : h('button', { class: 'sm', onclick: async (ev) => {
        const r = await busy(ev.currentTarget, () => api('POST', `/users/${enc(u.id)}/status`, { active: !u.active }));
        if (r) reload();
      } }, u.active ? 'Desactivar' : 'Activar')))));
}

function newUserDialog(title, path, reload) {
  openDialog(title, h('div', {},
    field('Nombre', h('input', { name: 'name', required: true, maxlength: 120 })),
    field('Email', h('input', { name: 'email', type: 'email', required: true }))), {
    submitLabel: 'Crear',
    submit: async (fd) => {
      const r = await api('POST', path, { name: fd.get('name').trim(), email: fd.get('email').trim() });
      reload();
      setTimeout(() => showSecret(`Enlace de activación para ${r.user.email}`, activationLink(r.setup_token),
        'Mandale este enlace por un canal seguro. Sirve 24 horas y una sola vez: con él elige su contraseña.'), 0);
      return true;
    },
  });
}

function usersView(data, reload) {
  const add = h('button', { class: 'primary', onclick: () => newUserDialog(`Nuevo usuario de ${data.client.name}`, `/clients/${enc(data.client.id)}/users`, reload) }, 'Agregar usuario');
  return h('div', {},
    h('div', { class: 'row spread' }, h('p', { class: 'muted small' },
      'Los usuarios de un cliente sólo ven y administran los buzones de ese cliente.'), add),
    data.users.length
      ? h('table', {}, h('thead', {}, h('tr', {}, ['Usuario', 'Estado', 'Último ingreso', ''].map((t) => h('th', {}, t)))), h('tbody', {}, userRows(data.users, reload)))
      : h('div', { class: 'card empty' }, 'Sin usuarios todavía.'));
}

// ----- tokens

function tokensView(data, reload) {
  const cid = data.client.id;
  const add = h('button', { class: 'primary', onclick: () => {
    openDialog('Nuevo token para Grok Bot', h('div', {},
      field('Nombre', h('input', { name: 'name', required: true, placeholder: 'grok-bot SDR' })),
      h('label', {}, 'Permisos'),
      ['read', 'draft', 'send', 'manage', 'sdr'].map((s) => h('label', { class: 'check' },
        h('input', { type: 'checkbox', name: 'scopes', value: s, checked: s !== 'manage' }),
        { read: 'read — leer y sincronizar', draft: 'draft — crear borradores', send: 'send — enviar y responder', manage: 'manage — marcar, mover, crear carpetas', sdr: 'sdr — reglas, registro, pedidos y aprobaciones (bots del SDR v2)' }[s])),
      field('Vence en (días)', h('input', { name: 'days', type: 'number', min: 1, max: 730, value: 120, required: true }))), {
      submitLabel: 'Generar',
      submit: async (fd) => {
        const r = await api('POST', `/clients/${enc(cid)}/tokens`, { name: fd.get('name').trim(), scopes: fd.getAll('scopes'), days: Number(fd.get('days')) });
        reload();
        setTimeout(() => showSecret(`Token ${r.token.name}`, r.secret,
          'Cargalo como secreto en la cuenta de Grok Bot del cliente (cabecera Authorization: Bearer). No lo pegues en chats ni en el repo.'), 0);
        return true;
      },
    });
  } }, 'Generar token');
  const rows = data.tokens.map((t) => {
    const expired = t.expires_at && new Date(t.expires_at) < new Date();
    const state = t.revoked_at ? h('span', { class: 'badge b-mute' }, 'revocado')
      : expired ? h('span', { class: 'badge b-warn' }, 'vencido') : h('span', { class: 'badge b-ok' }, 'vigente');
    return h('tr', {},
      h('td', {}, h('strong', {}, t.name), h('div', { class: 'mono muted' }, t.id.slice(0, 8))),
      h('td', { class: 'small' }, t.scopes.join(', ')),
      h('td', {}, state),
      h('td', { class: 'small' }, `vence ${fmtDate(t.expires_at)}`, h('div', { class: 'muted' }, `último uso ${fmtDate(t.last_used_at)}`)),
      h('td', {}, t.revoked_at ? null : h('button', { class: 'sm danger', onclick: () => openDialog(`Revocar ${t.name}`,
        h('p', {}, 'El bot que use este token deja de tener acceso en el acto.'), {
          submitLabel: 'Revocar', danger: true,
          submit: async () => { await api('POST', `/clients/${enc(cid)}/tokens/${enc(t.id)}/revoke`); reload(); return true; },
        }) }, 'Revocar')));
  });
  return h('div', {},
    h('div', { class: 'row spread' }, h('p', { class: 'muted small' },
      'El token es lo que usa la cuenta de Grok Bot del cliente para llegar a sus buzones. Sólo ve los buzones de este cliente.'), add),
    rows.length
      ? h('table', {}, h('thead', {}, h('tr', {}, ['Token', 'Permisos', 'Estado', 'Vigencia', ''].map((x) => h('th', {}, x)))), h('tbody', {}, rows))
      : h('div', { class: 'card empty' }, 'Sin tokens todavía.'));
}

// ----- dominios

const LEVEL = { ok: ['bien', 'b-ok'], warn: ['revisar', 'b-warn'], error: ['mal', 'b-err'] };
const levelBadge = (s) => {
  const [label, cls] = LEVEL[s] ?? ['sin verificar', 'b-mute'];
  return h('span', { class: `badge ${cls}` }, label);
};
const ICON = { ok: '✓', warn: '!', error: '✕' };

function copyButton(value) {
  return h('button', { type: 'button', class: 'sm', onclick: async (ev) => {
    try { await navigator.clipboard.writeText(value); toast('Copiado.'); } catch {
      const r = document.createRange(); r.selectNodeContents(ev.currentTarget.previousSibling);
      getSelection().removeAllRanges(); getSelection().addRange(r);
    }
  } }, 'Copiar');
}

// Qué hacer con un aviso: pasos, el registro listo para publicar y la guía del proveedor.
function hintBox(hint) {
  const r = hint.record;
  return h('details', { class: 'hint' },
    h('summary', {}, 'Cómo arreglarlo'),
    h('ol', {}, hint.steps.map((step) => h('li', {}, step))),
    r ? h('div', { class: 'hint-record' },
      h('div', { class: 'small' },
        h('strong', {}, 'Registro a publicar'), ` · tipo ${r.type} · nombre «${r.host}»`,
        r.host !== '@' && r.fqdn !== r.host ? h('span', { class: 'muted' }, ` (en algunos paneles va completo: ${r.fqdn})`) : null,
        r.host === '@' ? h('span', { class: 'muted' }, ` (el dominio raíz; algunos paneles piden dejarlo vacío o poner ${r.fqdn})`) : null),
      r.value
        ? h('div', { class: 'secret' }, h('pre', { class: 'record' }, r.value), copyButton(r.value))
        : h('p', { class: 'small muted' }, 'El valor lo genera el proveedor de correo al activar DKIM: copiarlo de ahí.')) : null,
    hint.links?.length ? h('p', { class: 'small' }, hint.links.map((l) => h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, `${l.label} ↗`))) : null);
}

function checkList(checks) {
  return h('ul', { class: 'checks' }, (checks ?? []).map((c) => h('li', { class: `c-${c.level}` },
    h('span', { class: 'c-icon', 'aria-hidden': 'true' }, ICON[c.level]),
    h('div', { class: 'c-body' }, h('span', {}, c.text), c.hint ? hintBox(c.hint) : null))));
}

function section(title, part, extra) {
  if (!part) return null;
  return h('div', { class: 'dns-part' },
    h('div', { class: 'row spread' }, h('strong', {}, title), levelBadge(part.status)),
    part.record ? h('pre', { class: 'record' }, part.record) : null,
    extra ?? null,
    checkList(part.checks));
}

function domainCard(clientId, d, reload) {
  const r = d.result;
  const selInput = h('input', { value: (d.dkim_selectors ?? []).join(', '), placeholder: 'ej.: default, selector1' });
  const saveSel = h('button', { class: 'sm', type: 'button', onclick: async (ev) => {
    const selectors = selInput.value.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
    const ok = await busy(ev.currentTarget, () => api('PUT', `/clients/${enc(clientId)}/domains/${enc(d.domain)}/selectors`, { selectors }));
    if (ok) toast('Selectores guardados. Verificá de nuevo para usarlos.');
  } }, 'Guardar');
  const recheck = h('button', { class: 'sm', type: 'button', onclick: async (ev) => {
    ev.currentTarget.textContent = 'Verificando…';
    const ok = await busy(ev.currentTarget, () => api('POST', `/clients/${enc(clientId)}/domains/check`, { domain: d.domain }));
    if (ok) reload();
  } }, 'Verificar');
  const dkimSelectors = r?.dkim?.selectors?.length
    ? h('div', { class: 'small muted' }, 'Selectores probados: ', r.dkim.selectors.map((s) => `${s.selector} (${s.source}${s.found ? '' : ', no existe'})`).join(' · '))
    : null;
  return h('div', { class: 'card domain' },
    h('div', { class: 'row spread' },
      h('div', {}, h('h2', { class: 'domain-name' }, d.domain),
        h('div', { class: 'small muted' }, `${d.mailboxes.length} buzón(es) · ${d.checked_at ? `verificado ${fmtDate(d.checked_at)}` : 'sin verificar'}`
          + (r?.provider ? ` · correo en ${r.provider}` : ''))),
      h('div', { class: 'row' }, levelBadge(d.status), recheck)),
    r?.checks?.length ? checkList(r.checks) : null,
    r && r.resolvable !== false ? h('div', { class: 'dns-grid' },
      section('SPF', r.spf),
      section('DKIM', r.dkim, dkimSelectors),
      section('DMARC', r.dmarc),
      section('MX', r.mx ? { ...r.mx, record: r.mx.records?.join('\n') || null } : null))
      : r ? null : h('p', { class: 'muted' }, 'Todavía no se verificó. «Verificar» consulta el DNS y busca la firma DKIM en los últimos mails del buzón.'),
    h('div', { class: 'selectors' },
      h('label', {}, 'Selectores DKIM propios (si el proveedor usa uno que no se detecta solo)'),
      h('div', { class: 'secret' }, selInput, saveSel)));
}

async function domainsView(clientId, reload) {
  const { domains } = await api('GET', `/clients/${enc(clientId)}/domains`);
  if (!domains.length) return h('div', { class: 'card empty' }, 'Los dominios salen de los buzones: cargá un buzón primero.');
  const all = h('button', { class: 'primary', onclick: async (ev) => {
    ev.currentTarget.textContent = 'Verificando…';
    const ok = await busy(ev.currentTarget, () => api('POST', `/clients/${enc(clientId)}/domains/check`, {}));
    if (ok) reload();
  } }, domains.length > 1 ? 'Verificar todos' : 'Verificar');
  return h('div', {},
    h('div', { class: 'row spread' }, h('p', { class: 'muted small' },
      'SPF, DKIM y DMARC deciden si los mails del bot llegan a la bandeja o a spam. Se consultan por DNS; nada se cambia.'), all),
    domains.map((d) => domainCard(clientId, d, reload)));
}

// ----- actividad

const OPS = {
  'admin.mailbox.create': 'alta de buzón', 'admin.mailbox.update': 'edición de buzón', 'admin.mailbox.password': 'cambio de contraseña',
  'admin.mailbox.check': 'prueba de conexión', 'admin.mailbox.pause': 'pausa', 'admin.mailbox.activate': 'reactivación',
  'admin.mailbox.delete': 'baja de buzón', 'admin.client.create': 'alta del cliente', 'admin.user.create': 'alta de usuario',
  'admin.token.create': 'token generado', 'admin.token.revoke': 'token revocado',
  'admin.domain.check': 'verificación de dominio', 'admin.domain.selectors': 'selectores DKIM',
  'admin.sdr.ajustes': 'cambio de ajustes del SDR', 'admin.sdr.campana.crear': 'campaña creada',
  'admin.sdr.campana.guardar': 'campaña cambiada', 'admin.sdr.campana.duplicar': 'campaña duplicada', 'admin.sdr.restaurar': 'ajustes vueltos a una versión anterior',
  'admin.sdr.config': 'configuración técnica del SDR', 'admin.sdr.despertador': 'despertador de seguimiento',
  'admin.sdr.despertador.apagar': 'despertador apagado',
  'admin.sdr.dripify': 'cuenta de Dripify', 'admin.sdr.dripify.webhook': 'URL del webhook de Dripify',
  'admin.sdr.no_contactar': 'alta en no contactar', 'admin.sdr.no_contactar.quitar': 'baja de no contactar',
  'admin.sdr.whatsapp': 'reglas de WhatsApp', 'admin.sdr.whatsapp.reanudar': 'WhatsApp reanudado',
  'admin.sdr.crm': 'conexión con el CRM', 'admin.sdr.crm.cargar': 'carga en el CRM pedida',
  'admin.sdr.crm.reintentar': 'carga en el CRM reintentada',
};

async function activityView(clientId) {
  const { activity } = await api('GET', `/clients/${enc(clientId)}/activity`);
  if (!activity.length) return h('div', { class: 'card empty' }, 'Sin actividad registrada.');
  return h('table', {}, h('thead', {}, h('tr', {}, ['Cuándo', 'Qué', 'Buzón', 'Quién', 'Resultado'].map((t) => h('th', {}, t)))),
    h('tbody', {}, activity.map((a) => h('tr', {},
      h('td', { class: 'small' }, fmtDate(a.at)),
      h('td', {}, OPS[a.op] ?? a.op),
      h('td', { class: 'small' }, a.mailbox ?? a.detail?.mailbox ?? a.detail?.domain ?? (a.detail?.domains ? Object.keys(a.detail.domains).join(', ') : '—')),
      h('td', { class: 'small' }, a.actor ?? 'bot'),
      h('td', {}, a.ok ? h('span', { class: 'badge b-ok' }, 'ok') : h('span', { class: 'badge b-err' }, a.error_code ?? 'error'))))));
}

// ----- monitor: a la izquierda los canales con su modo; a la derecha, lo que pasó hoy

const ICONO = { ok: '✓', espera: '◐', error: '✕' };
const MODO = { supervisado: 'Supervisado', autonomo: 'Autónomo' };

async function monitorView(clientId) {
  const reloj = h('span', {});
  const procesos = h('div', { class: 'mon-procesos' });
  const lista = h('div', { class: 'mon-lista', role: 'log', 'aria-live': 'polite' });
  const espera = h('span', {});
  const caja = h('section', { class: 'monitor' },
    h('div', { class: 'mon-izq' },
      h('div', { class: 'mon-cab' }, h('span', {}, 'Canales'), h('span', {}, 'Modo')),
      procesos),
    h('div', { class: 'mon-der' },
      h('div', { class: 'mon-cab' }, reloj,
        h('span', { class: 'mon-leyenda' }, h('span', {}, '✓ ejecutado'), h('span', {}, '◐ espera OK'), espera)),
      h('div', { class: 'mon-marco' }, lista)));
  let ultimo = '';
  async function pintar() {
    const r = await api('GET', `/clients/${enc(clientId)}/monitor`);
    const hora = (v, seg = true) => new Date(v).toLocaleTimeString('es-AR', { timeZone: r.zona_horaria, hour: '2-digit', minute: '2-digit',
      ...(seg ? { second: '2-digit' } : {}), hourCycle: 'h23' });
    reloj.textContent = `Hoy · ${hora(r.ahora, false)}`;
    espera.textContent = r.esperando_ok ? `${r.esperando_ok} esperando` : '';
    procesos.replaceChildren(...(r.canales.length ? r.canales.map((p) => h('div', { class: `mon-proc${p.modo === 'apagado' ? ' off' : ''}` },
      h('div', { class: 'mon-proc-txt' },
        h('div', { class: 'mon-proc-nombre' }, p.titulo, p.pausado ? h('span', { class: 'mon-pausa' }, 'en pausa') : null),
        h('div', { class: 'mon-ruta' }, p.ruta),
        h('div', { class: 'mon-det' }, p.detalle)),
      p.modo === 'apagado'
        ? h('span', { class: 'mon-off' }, 'apagado')
        : h('div', { class: 'mon-seg', role: 'img', 'aria-label': `Modo: ${MODO[p.modo]}` },
          ['supervisado', 'autonomo'].map((m) => h('span', { class: m === p.modo ? 'on' : '' }, MODO[m])))))
      : [h('p', { class: 'mon-vacio' }, 'El SDR no está activado.')]));
    const firma = JSON.stringify(r.eventos.map((e) => [e.at, e.estado, e.texto]));
    if (firma === ultimo) return;
    ultimo = firma;
    const abajo = lista.scrollHeight - lista.scrollTop - lista.clientHeight < 40;
    lista.replaceChildren(...(r.eventos.length ? r.eventos.map((e) => h('div', { class: `mon-ev ev-${e.estado}` },
      h('span', { class: 'mon-hora' }, hora(e.at)),
      h('span', { class: 'mon-ico', 'aria-label': e.estado }, ICONO[e.estado]),
      h('span', { class: 'mon-canal' }, e.canal),
      h('span', { class: 'mon-texto' }, e.texto)))
      : [h('p', { class: 'mon-vacio' }, 'Todavía no pasó nada hoy.')]));
    if (abajo || !lista.dataset.listo) { lista.scrollTop = lista.scrollHeight; lista.dataset.listo = '1'; }
  }
  await pintar();
  // Se actualiza solo cada 30 segundos mientras la pestaña esté a la vista.
  const timer = setInterval(() => {
    if (!caja.isConnected) { clearInterval(timer); return; }
    if (!document.hidden) pintar().catch(() => {});
  }, 30_000);
  const registro = h('details', { class: 'mon-registro' }, h('summary', {}, 'Registro completo del panel'));
  registro.addEventListener('toggle', async () => {
    if (registro.open && registro.children.length === 1) registro.append(await activityView(clientId));
  });
  return h('div', { class: 'stack' }, caja, registro);
}

// ---------------------------------------------------------------- equipo de Biguá

async function renderTeam() {
  const { users } = await api('GET', '/team');
  const reload = () => renderTeam();
  main.replaceChildren(
    h('div', { class: 'row spread' },
      h('div', {}, h('h1', {}, 'Equipo Biguá'), h('p', { class: 'sub' }, 'Operadores con acceso a todos los clientes.')),
      h('button', { class: 'primary', onclick: () => newUserDialog('Nuevo operador de Biguá', '/team', reload) }, 'Agregar operador')),
    h('table', {}, h('thead', {}, h('tr', {}, ['Usuario', 'Estado', 'Último ingreso', ''].map((t) => h('th', {}, t)))), h('tbody', {}, userRows(users, reload))));
}

// ---------------------------------------------------------------- asistentes (docs/29)
//
// El alta de un cliente (la hace Biguá en la llamada de inicio) y el armado de cada campaña, paso a
// paso. Cada paso usa los mismos formularios y tarjetas del resto del panel y guarda donde ya se
// guardaba; el asistente sólo agrega el orden, qué falta y la pausa: un paso o un campo puede quedar
// «esperando una definición», con qué falta y quién lo define.

const ESTADO_PASO = {
  listo: ['✓', 'listo', 'b-ok'], esperando: ['◐', 'espera una definición', 'b-warn'],
  no_aplica: ['–', 'no aplica', 'b-mute'], por_hacer: ['○', 'por hacer', 'b-mute'],
};
const pasoBadge = (e) => { const [, t, cls] = ESTADO_PASO[e] ?? ESTADO_PASO.por_hacer; return h('span', { class: `badge ${cls}` }, t); };
const pasoIcono = (e) => h('span', { class: `paso-ico p-${e}`, 'aria-hidden': 'true' }, (ESTADO_PASO[e] ?? ESTADO_PASO.por_hacer)[0]);

const marcarPaso = (clientId, ambito, paso, body) => api('PUT', `/clients/${enc(clientId)}/asistente/${enc(ambito)}/${enc(paso)}`, body);

// «Lo definimos después»: qué falta y quién lo define. antes() guarda lo que se estaba cargando.
function pausaDialog(clientId, ambito, paso, titulo, { antes, despues }) {
  openDialog(`Lo definimos después: ${titulo}`, h('div', {},
    field('Qué falta definir', h('textarea', { name: 'que', required: true, maxlength: 500, rows: 3,
      placeholder: 'Por ejemplo: quién toma a los interesados de Chile' })),
    field('Quién lo define', h('input', { name: 'quien', maxlength: 120, placeholder: 'El cliente, Augusto, Biguá…' })),
    h('p', { class: 'small muted' }, 'Queda en el resumen del alta (o de la campaña) hasta que se defina. Lo demás se puede seguir cargando.')), {
    submitLabel: 'Dejarlo pendiente',
    submit: async (fd) => {
      if (antes) await antes();
      await marcarPaso(clientId, ambito, paso, { estado: 'esperando', que: String(fd.get('que')).trim(), quien: String(fd.get('quien')).trim() });
      toast('Queda pendiente.');
      despues();
      return true;
    },
  });
}

const textoPendiente = (x) => `${x.que}${x.quien ? ` · lo define ${x.quien}` : ''}`;

// Un campo con su «lo definimos después» (o su pendiente, si ya lo tiene).
function campoConPausa(nodo, c, pendiente, { clientId, ambito, antes, despues }) {
  const pie = pendiente
    ? h('p', { class: 'note small pendiente' }, h('strong', {}, 'Pendiente: '), textoPendiente(pendiente), ' ',
      h('button', { type: 'button', class: 'sm link', onclick: async (ev) => {
        const ok = await busy(ev.currentTarget, async () => { if (antes) await antes(); return marcarPaso(clientId, ambito, `campo:${c.clave}`, { estado: null }); });
        if (ok) despues();
      } }, 'Ya está definido'))
    : h('button', { type: 'button', class: 'sm link pausa', onclick: () => pausaDialog(clientId, ambito, `campo:${c.clave}`, c.titulo, { antes, despues }) },
      'Lo definimos después');
  return h('div', { class: `campo-asistente${pendiente ? ' con-pendiente' : ''}` }, nodo, pie);
}

// La barra de un paso: estado, lo que espera, y las acciones de pausa.
function cabeceraPaso({ etapa, n, total, titulo, estado, guia, falta, espera, acciones }) {
  return h('section', { class: 'card paso-cab' },
    h('div', { class: 'small muted' }, `${etapa} · paso ${n} de ${total}`),
    h('div', { class: 'row spread' }, h('h2', { class: 'first m0' }, titulo), pasoBadge(estado)),
    guia ? h('p', { class: 'guia' }, guia) : null,
    falta && estado !== 'listo' && estado !== 'no_aplica' ? h('p', { class: 'small falta' }, falta) : null,
    espera ? h('p', { class: 'note' }, h('strong', {}, 'Espera una definición: '), textoPendiente(espera)) : null,
    acciones?.length ? h('div', { class: 'row' }, acciones) : null);
}

function pieNavegacion(anterior, siguiente, extra = []) {
  return h('div', { class: 'row spread asistente-pie' },
    anterior ? h('a', { class: 'btn', href: anterior }, '← Anterior') : h('span'),
    h('div', { class: 'row' }, extra, siguiente ? h('a', { class: 'btn primary', href: siguiente.href }, siguiente.label ?? 'Siguiente →') : null));
}

// ----- el alta de un cliente

// Lo que se habla con el cliente en cada paso.
const GUIA_ALTA = {
  sdr: 'Antes de cargar nada: si lo opera Biguá o el cliente, quién aprueba los mensajes y cuántos mails se calibran.',
  usuario: 'Quién del cliente entra al panel. Recibe un enlace de un solo uso para elegir su contraseña.',
  empresa: 'Cómo se presenta la empresa y qué hace en general (lo de cada campaña va en su asistente). El tono, el idioma y la firma de los buzones que no tengan una propia.',
  casos: 'Los resultados que se pueden citar, con su fuente, y las objeciones de siempre con su respuesta. Los bots no citan nada que no esté acá.',
  interesados: 'A quién se le pasa un interesado: su nombre y su casilla del dominio principal, que va en copia en la respuesta (docs/26), y el link de agenda.',
  exclusiones: 'Los tipos de empresa y los cargos a evitar en todas las campañas, si se escribe a mails deducidos, y las empresas o personas puntuales a las que no se les escribe nunca.',
  buzones: 'Las casillas de los dominios secundarios, cada una a nombre de una persona real del equipo del cliente, con su firma. Se prueban acá mismo.',
  dominios: 'SPF, DKIM y DMARC de cada dominio de envío: deciden si los mails llegan a la bandeja. Si algo está mal, la ayuda dice qué registro cargar.',
  linkedin: 'Si se suma LinkedIn: la API key de Dripify del cliente, la prueba de conexión y la URL del webhook para su campaña.',
  whatsapp: 'Sólo para seguir conversaciones con quien ya respondió: número, horario y tope del día.',
  crm: 'Dónde entran solos los positivos: en HubSpot (el token de la app privada, la propiedad de origen y el dueño) o, si no tiene CRM, en una planilla de Google Sheets (la URL, compartida como Editor con el mail de la cuenta de servicio). Después, «Probar conexión» y la vista previa.',
  asci: 'El usuario de ASCI con el que el prospector busca cuentas y decisores.',
  token: 'El token con el que la cuenta de Grok del cliente llega al gateway.',
  grok: 'La cuenta de Grok Bot del cliente: los bots, los conectores y la revisión automática.',
  routines: 'Las routines de los tres bots, creadas por el orquestador.',
  despertadores: 'La URL y la clave del webhook de cada routine con despertador, copiadas desde la app de Grok.',
};
// Lo que se hace fuera del panel, para tildar.
const LISTA_ALTA = {
  asci: [
    'Desde un cliente MCP conectado a ASCI como administrador, crear_usuario con un email propio del bot (no de una persona), nombre «Bot <Cliente>», rol operador y 365 días.',
    'La clave se muestra una sola vez: va directo al conector de ASCI en Grok, nunca por chat ni mail.',
  ],
  grok: [
    'Tres bots con estos nombres exactos: orquestador, prospector y seguimiento.',
    'Conector SDRBOT (https://sdrbot.bigua.lat/mcp, cabecera Authorization: Bearer con el token del paso anterior) en los tres; ASCI (https://mcp.bigua.lat/mcp) en el prospector.',
    'Revisión automática: Allow para todo SDRBOT salvo registro_aprobar, que va en Ask first, y las herramientas de ASCI que usa el prospector (docs/15 §8).',
    'Privacy Mode prendido en la cuenta y notificaciones prendidas en el orquestador.',
  ],
  routines: [
    'En el chat del orquestador: «Hacé el alta: pedí tus reglas con reglas_manual (bot orquestador, tarea alta) y seguilas».',
    'Tienen que quedar siete routines habilitadas, en la zona horaria del cliente (docs/15 §9). Si un bot no contesta, escribile directo.',
  ],
};
// Los pasos que un cliente puede no usar.
const PUEDE_NO_APLICAR = new Set(['usuario', 'casos', 'exclusiones', 'linkedin', 'whatsapp', 'crm']);

function navAlta(alta, base, actual) {
  const nav = h('nav', { class: 'sidenav pasos', 'aria-label': 'Pasos del alta' },
    h('a', { href: `${base}/alta`, class: actual ? '' : 'on' }, 'Resumen del alta'));
  let etapa = null;
  for (const p of alta.pasos) {
    if (p.etapa !== etapa) { etapa = p.etapa; nav.append(h('div', { class: 'etapa' }, etapa)); }
    nav.append(h('a', { href: `${base}/alta/${p.clave}`, class: p.clave === actual ? 'on' : '' }, pasoIcono(p.estado), p.titulo));
  }
  return nav;
}

function progreso(listos, total, esperando) {
  // El ancho va por el CSSOM: la política del panel no deja estilos en línea.
  const barra = h('span');
  barra.style.width = `${Math.round((listos / Math.max(total, 1)) * 100)}%`;
  return h('div', { class: 'progreso-wrap' },
    h('div', { class: 'progreso', role: 'progressbar', 'aria-valuenow': listos, 'aria-valuemin': 0, 'aria-valuemax': total }, barra),
    h('div', { class: 'small muted' }, `${listos} de ${total} pasos listos`, esperando ? ` · ${plural(esperando, 'espera', 'esperan')} una definición` : ''));
}

async function altaView(v, sub) {
  const { clientId, base } = v;
  const [alta, sdr] = await Promise.all([
    api('GET', `/clients/${enc(clientId)}/asistente/alta`), api('GET', `/clients/${enc(clientId)}/sdr`)]);
  const i = alta.pasos.findIndex((p) => p.clave === sub);
  const contenido = i < 0 ? await altaResumen(v, alta, sdr) : await altaPaso(v, alta, sdr, i);
  return h('div', { class: 'side asistente' }, navAlta(alta, base, i < 0 ? null : sub), h('div', { class: 'stack' }, contenido));
}

async function altaResumen({ clientId, base }, alta, sdr) {
  const esperan = alta.pasos.filter((p) => p.estado === 'esperando');
  const porHacer = alta.pasos.filter((p) => p.estado === 'por_hacer');
  const seguir = esperan[0] ?? porHacer[0];
  const item = (p, texto) => h('li', {}, pasoIcono(p.estado), h('span', { class: 'aviso-texto' }, h('strong', {}, p.titulo), texto ? ` · ${texto}` : ''),
    h('a', { href: `${base}/alta/${p.clave}` }, 'Ir'));
  const pendientes = esperan.flatMap((p) => [
    ...(p.que ? [item(p, textoPendiente(p))] : []),
    ...p.campos_pendientes.map((x) => item(p, `${x.titulo}: ${textoPendiente(x)}`)),
  ]);
  let campana = null;
  if (!seguir && sdr.activo) {
    const { campanas } = await api('GET', `/clients/${enc(clientId)}/sdr/campanas`);
    campana = campanas.find((k) => k.estado === 'borrador') ?? null;
  }
  return [
    h('section', { class: 'card' },
      h('h2', { class: 'first' }, 'Alta del cliente'),
      h('p', { class: 'muted small' }, 'Se completa con el cliente en la llamada de inicio. Cada paso guarda donde corresponde (Empresa, Canales, Administración): ',
        'lo que no se pueda definir en el momento queda pendiente, y se retoma desde acá.'),
      progreso(alta.listos, alta.total, alta.esperando),
      h('div', { class: 'row' }, seguir
        ? h('a', { class: 'btn primary', href: `${base}/alta/${seguir.clave}` }, alta.listos ? `Seguir: ${seguir.titulo}` : 'Empezar')
        : h('span', { class: 'badge b-ok' }, 'Alta completa'),
      !seguir && campana ? h('a', { class: 'btn primary', href: `${base}/campanas/${campana.id}/asistente` }, `Armar la campaña «${campana.nombre}»`) : null,
      !seguir && !campana ? h('a', { class: 'btn', href: `${base}/campanas` }, 'Ir a Campañas') : null)),
    h('section', { class: 'card' },
      h('h2', { class: 'first' }, 'Esperan una definición'),
      pendientes.length ? h('ul', { class: 'avisos' }, pendientes) : h('p', { class: 'muted small' }, 'Nada pendiente de definir.')),
    porHacer.length ? h('section', { class: 'card' },
      h('h2', { class: 'first' }, 'Por hacer'),
      h('ul', { class: 'avisos' }, porHacer.map((p) => item(p, p.falta)))) : null,
  ];
}

async function altaPaso(v, alta, sdr, i) {
  const { clientId, base, reload } = v;
  const p = alta.pasos[i];
  const ir = (k) => `${base}/alta/${k}`;
  const siguiente = i + 1 < alta.pasos.length ? { href: ir(alta.pasos[i + 1].clave) } : { href: `${base}/alta`, label: 'Terminar →' };
  const accion = (label, body, cls = '') => h('button', { class: `sm ${cls}`, onclick: async (ev) => {
    const ok = await busy(ev.currentTarget, () => marcarPaso(clientId, 'alta', p.clave, body));
    if (ok) reload();
  } }, label);
  const formulario = {};
  const contenido = await contenidoAlta(v, alta, sdr, p, siguiente, formulario);
  const acciones = [];
  if (p.estado === 'esperando' && p.que) acciones.push(accion('Ya está definido', { estado: null }));
  if (p.estado !== 'esperando' && p.estado !== 'no_aplica') {
    // Si el paso tiene formulario, lo que se cargó se guarda antes de pausar.
    acciones.push(h('button', { class: 'sm', onclick: () => pausaDialog(clientId, 'alta', p.clave, p.titulo,
      { antes: () => formulario.guardar?.(), despues: reload }) }, 'Lo definimos después'));
  }
  if (PUEDE_NO_APLICAR.has(p.clave)) acciones.push(p.estado === 'no_aplica' ? accion('Vuelve a aplicar', { estado: null }) : accion('No aplica', { estado: 'no_aplica' }));
  const total = alta.pasos.length;
  const cab = cabeceraPaso({ etapa: p.etapa, n: i + 1, total, titulo: p.titulo, estado: p.estado, guia: GUIA_ALTA[p.clave],
    falta: p.falta, espera: p.que ? p : null, acciones });
  const extra = [];
  if (p.manual && !p.campos.length) {
    extra.push(p.estado === 'listo' ? accion('Desmarcar', { estado: null }) : accion('Marcar hecho', { estado: 'listo' }, 'primary'));
  }
  return [cab, contenido, pieNavegacion(i ? ir(alta.pasos[i - 1].clave) : `${base}/alta`, siguiente, extra)];
}

const faltaSdr = (base) => h('div', { class: 'card empty' }, h('p', {}, 'Primero hay que activar el SDR.'),
  h('a', { class: 'btn primary', href: `${base}/alta/sdr` }, 'Ir a «Activar el SDR»'));

async function contenidoAlta(v, alta, sdr, p, siguiente, formulario = {}) {
  const { clientId, data, base, reload } = v;
  if (p.campos.length) {
    if (!sdr.activo) return faltaSdr(base);
    const form = camposAlta(v, alta, sdr, p, siguiente, formulario);
    return p.clave === 'exclusiones' ? h('div', { class: 'stack' }, form, await noContactarCard(clientId)) : form;
  }
  if (LISTA_ALTA[p.clave]) {
    return h('section', { class: 'card' }, h('ol', { class: 'lista-alta' }, LISTA_ALTA[p.clave].map((x) => h('li', {}, x))),
      h('p', { class: 'small muted' }, 'Se hace fuera del panel. Cuando esté, «Marcar hecho».'));
  }
  switch (p.clave) {
    case 'sdr': return sdrTecnico(clientId, sdr, reload);
    case 'usuario': return h('section', { class: 'card' }, usersView(data, reload));
    case 'buzones': return h('section', { class: 'card' }, mailboxesView(data, reload));
    case 'dominios': return h('section', { class: 'card' }, await domainsView(clientId, reload));
    case 'token':
      return h('section', { class: 'card' }, h('p', { class: 'small' }, 'Nombre «GrokBot <Cliente>», permisos read, draft, send y sdr (sin manage), 120 días. ',
        'Se pega directo en el conector de Grok del paso «Cuenta de Grok Bot».'), tokensView(data, reload));
    case 'linkedin': return sdr.activo ? dripifyCard(clientId, sdr, reload) : faltaSdr(base);
    case 'whatsapp': {
      if (!sdr.activo) return faltaSdr(base);
      const r = await api('GET', `/clients/${enc(clientId)}/resumen`);
      return whatsappCard(clientId, sdr, r.whatsapp, reload);
    }
    case 'crm': return sdr.activo ? crmView(clientId, true, reload) : faltaSdr(base);
    case 'despertadores': {
      if (!sdr.activo) return faltaSdr(base);
      const activos = sdr.tecnico.bots_activos;
      return h('div', { class: 'stack' },
        activos.includes('orquestador') ? despertadorCard(clientId, sdr, reload, 'orquestador') : null,
        activos.includes('seguimiento') ? despertadorCard(clientId, sdr, reload, 'seguimiento') : null);
    }
    default: return h('div');
  }
}

// Los ajustes de Empresa de un paso, cada uno con su «lo definimos después».
function camposAlta(v, alta, sdr, p, siguiente, formulario = {}) {
  const { clientId, reload } = v;
  const campos = sdr.campos.filter((c) => p.campos.includes(c.clave));
  const pend = new Map(alta.campos_pendientes.map((x) => [x.clave, x]));
  const err = h('p', { class: 'err', role: 'alert' });
  const form = h('form', { class: 'card stack' });
  const guardar = async () => {
    const r = await api('PUT', `/clients/${enc(clientId)}/sdr/ajustes`, { ajustes: leerCampos(form, campos), nota: `Alta: ${p.titulo}` });
    return r;
  };
  formulario.guardar = guardar;
  const ctx = { clientId, ambito: 'alta', antes: guardar, despues: reload };
  form.append(...campos.map((c) => campoConPausa(field(conCandado(c), campoInput(c, sdr.ajustes[c.clave]), c.ayuda), c, pend.get(c.clave), ctx)));
  const btnGuardar = h('button', { type: 'submit', value: 'guardar' }, 'Guardar');
  const btnSeguir = h('button', { type: 'submit', value: 'seguir', class: 'primary' }, 'Guardar y seguir');
  form.append(err, h('div', { class: 'row' }, btnSeguir, btnGuardar));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const seguir = ev.submitter?.value === 'seguir';
    const r = await busy(seguir ? btnSeguir : btnGuardar, async () => {
      const x = await guardar();
      // Un paso sin campos obligatorios (casos, exclusiones) queda listo al guardarlo, salvo que
      // espere una definición.
      if (p.manual && !p.que) await marcarPaso(clientId, 'alta', p.clave, { estado: 'listo' });
      return x;
    }, err);
    if (!r) return;
    toast(r.cambios.length ? 'Guardado.' : 'No había cambios.');
    if (seguir) location.hash = siguiente.href; else reload();
  });
  return form;
}

// ----- el armado de una campaña

const PASOS_CAMPANA = [
  { clave: 'objetivo', titulo: 'Objetivo', bloques: ['objetivo'],
    guia: 'Qué se busca con esta campaña: prospectar por una señal, invitar a un evento o reactivar contactos viejos. El nombre y, si tiene, las fechas.' },
  { clave: 'audiencia', titulo: 'Para quién', bloques: ['audiencia'],
    guia: 'A quién se le escribe: país, industrias, tamaño, los cargos y la señal que dispara el primer contacto. Lo que se evita, además de lo de Empresa.' },
  // Las cuentas que vienen de un archivo (docs/27): en una «Lista del cliente», las que se prospectan
  // (obligatorio); en las demás, las cuentas modelo del ICP (opcional).
  { clave: 'cuentas', titulo: 'Cuentas', bloques: ['lista'], archivo: true,
    guia: 'Las empresas que el cliente ya tiene identificadas, desde un Excel o un CSV.' },
  { clave: 'propuesta', titulo: 'Qué ofrecemos', bloques: ['propuesta'],
    guia: 'Qué se ofrece en esta campaña, para qué sirve y por qué ahora, y qué casos de Empresa se pueden citar.' },
  { clave: 'mensajes', titulo: 'Mensaje y llamado a la acción', bloques: ['mensajes'],
    guia: 'Qué se le pide al prospecto al final del primer mail, qué links pueden ir y si el tono o el idioma cambian para esta campaña.' },
  { clave: 'respuestas', titulo: 'Respuestas e interesados', bloques: ['respuestas'],
    guia: 'Qué cuenta como positivo en esta campaña, sus objeciones propias y, si no es el de Empresa, quién toma a los interesados.' },
  { clave: 'canales', titulo: 'Canales y ritmo', bloques: ['ritmo', 'avanzado'],
    guia: 'Por qué buzones sale, cuántas cuentas nuevas por día y la campaña de Dripify si va también por LinkedIn.' },
];

function navCampana(pasos, base, actual, revisar) {
  return h('nav', { class: 'sidenav pasos', 'aria-label': 'Pasos de la campaña' },
    pasos.map((p) => h('a', { href: `${base}/${p.clave}`, class: p.clave === actual ? 'on' : '' }, pasoIcono(p.estado), p.titulo)),
    h('a', { href: `${base}/revisar`, class: actual === 'revisar' ? 'on' : '' }, pasoIcono(revisar), 'Revisar y activar'));
}

async function campanaAsistenteView(v, id, pasoPedido) {
  let sub = pasoPedido;
  const { clientId, bigua, base, reload } = v;
  const path = `/clients/${enc(clientId)}/sdr/campanas/${enc(id)}`;
  const ambito = `campana:${id}`;
  const [d, asis] = await Promise.all([api('GET', path), api('GET', `/clients/${enc(clientId)}/asistente/${enc(ambito)}`)]);
  const k = d.campana;
  const baseA = `${base}/campanas/${id}/asistente`;
  const filas = new Map(asis.pasos.map((r) => [r.paso, r]));
  const camposDe = (p) => d.campos.filter((c) => p.bloques.includes(c.bloque));
  const columnasDe = (p) => d.columnas.filter((c) => p.bloques.includes(c.bloque) && c.clave !== 'estado');
  const esLista = k.tipo === 'lista';
  const pasos = PASOS_CAMPANA.map((p) => (p.clave !== 'cuentas' ? p : {
    ...p, titulo: esLista ? 'Lista de cuentas' : 'Cuentas modelo (opcional)',
    guia: esLista
      ? 'Las empresas que esta campaña prospecta, en el orden del archivo, con la persona de cada fila si la trae. Sin la lista no se activa.'
      : 'Si el cliente tiene clientes o empresas ideales para tomar de modelo, se cargan acá como semillas del ICP: el SDR no les escribe.',
  })).map((p) => {
    const pendientes = camposDe(p).filter((c) => filas.get(`campo:${c.clave}`)).map((c) => ({ ...filas.get(`campo:${c.clave}`), clave: c.clave, titulo: c.titulo }));
    const faltan = d.faltantes.filter((f) => p.bloques.includes(f.bloque));
    const fila = filas.get(p.clave);
    const estado = fila?.estado === 'esperando' || pendientes.length ? 'esperando' : faltan.length ? 'por_hacer' : fila?.estado === 'listo' ? 'listo' : 'por_hacer';
    return { ...p, estado, faltan, pendientes, espera: fila?.estado === 'esperando' ? fila : null };
  });
  const listos = pasos.filter((p) => p.estado === 'listo').length;
  const revisar = d.faltantes.length ? 'por_hacer' : k.estado === 'activa' ? 'listo' : 'por_hacer';
  if (!sub) sub = pasos.find((p) => p.estado !== 'listo')?.clave ?? 'revisar';
  const i = pasos.findIndex((p) => p.clave === sub);
  const cabecera = h('div', { class: 'stack' },
    h('a', { href: `${base}/campanas/${id}`, class: 'small' }, '← Ver la campaña entera'),
    h('div', { class: 'row spread' }, h('h2', { class: 'first m0' }, k.nombre, ' ', estadoBadge(k.estado)),
      progreso(listos, pasos.length, pasos.filter((p) => p.estado === 'esperando').length)));
  let cuerpo;
  if (sub === 'revisar' || i < 0) cuerpo = campanaRevisar(v, d, pasos, baseA, path);
  else cuerpo = await campanaPaso(v, d, pasos, i, { baseA, path, ambito, camposDe, columnasDe });
  return h('div', { class: 'stack' }, cabecera,
    h('div', { class: 'side asistente' }, navCampana(pasos, baseA, i < 0 ? 'revisar' : sub, revisar), h('div', { class: 'stack' }, cuerpo)));
}

async function campanaPaso(v, d, pasos, i, { baseA, path, ambito, camposDe, columnasDe }) {
  const { clientId, reload } = v;
  const p = pasos[i];
  const k = d.campana;
  const siguiente = { href: `${baseA}/${pasos[i + 1]?.clave ?? 'revisar'}` };
  if (p.archivo) return campanaPasoArchivo(v, d, pasos, i, { baseA, path, ambito, siguiente });
  const cols = columnasDe(p);
  // «Acepta los mails del archivo» es sólo de una «Lista del cliente».
  const campos = camposDe(p).filter((c) => c.clave !== 'acepta_mails_del_cliente' || k.tipo === 'lista');
  const err = h('p', { class: 'err', role: 'alert' });
  const form = h('form', { class: 'card stack' });
  const guardar = () => api('PUT', path, { ...leerColumnas(form, cols), ajustes: leerCampana(form, campos), nota: `Asistente: ${p.titulo}` });
  const pend = new Map(p.pendientes.map((x) => [x.clave, x]));
  const ctx = { clientId, ambito, antes: guardar, despues: reload };
  form.append(
    ...cols.map((c) => field(conCandado(c), columnaInput(c, k, d), pistaColumna(c, d))),
    ...campos.map((c) => campoConPausa(campoCampana(c, k.ajustes[c.clave], d), c, pend.get(c.clave), ctx)));
  if (p.clave === 'canales') {
    form.append(h('p', { class: 'small muted' }, 'Los buzones se cargan y se prueban en Canales; acá se elige cuáles usa esta campaña.'));
  }
  const terminada = k.estado === 'terminada';
  const btnSeguir = h('button', { type: 'submit', value: 'seguir', class: 'primary' }, 'Guardar y seguir');
  const btnGuardar = h('button', { type: 'submit', value: 'guardar' }, 'Guardar');
  if (!terminada) form.append(err, h('div', { class: 'row' }, btnSeguir, btnGuardar));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const seguir = ev.submitter?.value === 'seguir';
    const r = await busy(seguir ? btnSeguir : btnGuardar, async () => {
      const x = await guardar();
      // El paso queda listo cuando no le falta nada; si espera una definición, sigue esperando.
      if (!p.espera) await marcarPaso(clientId, ambito, p.clave, { estado: 'listo' });
      return x;
    }, err);
    if (!r) return;
    toast(r.cambios.length ? 'Guardado.' : 'No había cambios.');
    if (seguir) location.hash = siguiente.href; else reload();
  });
  const acciones = [];
  if (p.espera) {
    acciones.push(h('button', { class: 'sm', onclick: async (ev) => {
      if (await busy(ev.currentTarget, () => marcarPaso(clientId, ambito, p.clave, { estado: null }))) reload();
    } }, 'Ya está definido'));
  } else if (!terminada) {
    acciones.push(h('button', { class: 'sm', onclick: () => pausaDialog(clientId, ambito, p.clave, p.titulo, { antes: guardar, despues: reload }) }, 'Lo definimos después'));
  }
  const cab = cabeceraPaso({ etapa: 'Campaña', n: i + 1, total: pasos.length + 1, titulo: p.titulo, estado: p.estado, guia: p.guia,
    falta: p.faltan.map((f) => f.mensaje).join(' ') || null, espera: p.espera, acciones });
  return [cab, form, pieNavegacion(i ? `${baseA}/${pasos[i - 1].clave}` : null, siguiente)];
}

// El paso de las cuentas: la misma tarjeta de carga de la campaña (docs/27), y «Listo» a mano porque
// no hay un formulario que guardar. En una lista, queda por hacer mientras no haya cuentas cargadas.
async function campanaPasoArchivo(v, d, pasos, i, { baseA, path, ambito, siguiente }) {
  const { clientId, reload } = v;
  const p = pasos[i];
  const k = d.campana;
  const terminada = k.estado === 'terminada';
  const acciones = [];
  if (p.espera) {
    acciones.push(h('button', { class: 'sm', onclick: async (ev) => {
      if (await busy(ev.currentTarget, () => marcarPaso(clientId, ambito, p.clave, { estado: null }))) reload();
    } }, 'Ya está definido'));
  } else if (!terminada) {
    acciones.push(h('button', { class: 'sm', onclick: () => pausaDialog(clientId, ambito, p.clave, p.titulo, { despues: reload }) }, 'Lo definimos después'));
  }
  const cab = cabeceraPaso({ etapa: 'Campaña', n: i + 1, total: pasos.length + 1, titulo: p.titulo, estado: p.estado, guia: p.guia,
    falta: p.faltan.map((f) => f.mensaje.replace(' (Subir Excel o CSV, abajo)', '')).join(' ') || null, espera: p.espera, acciones });
  const listo = terminada ? [] : [h('button', { class: 'primary', onclick: async (ev) => {
    const ok = await busy(ev.currentTarget, async () => (p.espera ? true : marcarPaso(clientId, ambito, p.clave, { estado: 'listo' })));
    if (ok) location.hash = siguiente.href;
  } }, 'Listo, seguir →')];
  return [cab, await semillasCard({ clientId, path, k, terminada }), pieNavegacion(i ? `${baseA}/${pasos[i - 1].clave}` : null, null, listo)];
}

function campanaRevisar(v, d, pasos, baseA, path) {
  const { base, reload } = v;
  const k = d.campana;
  const pasoDe = (bloque) => pasos.find((p) => p.bloques.includes(bloque));
  const errEstado = h('p', { class: 'err', role: 'alert' });
  const puedeEstado = d.columnas.find((c) => c.clave === 'estado')?.editable;
  const pendientes = pasos.flatMap((p) => [
    ...(p.espera ? [{ p, texto: textoPendiente(p.espera) }] : []),
    ...p.pendientes.map((x) => ({ p, texto: `${x.titulo}: ${textoPendiente(x)}` }))]);
  const faltan = d.faltantes.length ? h('ul', { class: 'avisos' }, d.faltantes.map((f) => {
    const p = pasoDe(f.bloque);
    return h('li', {}, h('span', { class: 'dot d-warn', 'aria-hidden': 'true' }), h('span', { class: 'aviso-texto' }, f.mensaje),
      f.bloque === 'empresa' ? h('a', { href: `${base}/empresa` }, 'Ir a Empresa') : p ? h('a', { href: `${baseA}/${p.clave}` }, 'Ir') : null);
  })) : h('p', { class: 'small' }, 'No le falta nada para activarla.');
  const activar = puedeEstado && ['borrador', 'pausada'].includes(k.estado)
    ? h('button', { class: 'primary', disabled: d.faltantes.length > 0, onclick: async (ev) => {
      const r = await busy(ev.currentTarget, () => api('PUT', path, { estado: 'activa' }), errEstado);
      if (r) { toast('Campaña activada.'); reload(); }
    } }, 'Activar la campaña') : null;
  return [
    cabeceraPaso({ etapa: 'Campaña', n: pasos.length + 1, total: pasos.length + 1, titulo: 'Revisar y activar',
      estado: d.faltantes.length ? 'por_hacer' : k.estado === 'activa' ? 'listo' : 'por_hacer',
      guia: 'Cómo la van a leer los bots, lo que falta para activarla y lo que quedó pendiente de definir.' }),
    h('section', { class: 'card' }, h('h2', { class: 'first' }, 'Para activarla'), faltan,
      pendientes.length ? h('div', {}, h('h3', {}, 'Esperan una definición'),
        h('ul', { class: 'avisos' }, pendientes.map((x) => h('li', {}, pasoIcono('esperando'),
          h('span', { class: 'aviso-texto' }, h('strong', {}, x.p.titulo), ` · ${x.texto}`), h('a', { href: `${baseA}/${x.p.clave}` }, 'Ir'))))) : null,
      errEstado,
      h('div', { class: 'row' }, activar,
        k.estado === 'activa' ? h('span', { class: 'badge b-ok' }, 'Activa') : null,
        !puedeEstado && k.estado !== 'activa' ? h('span', { class: 'small muted' }, 'La activa Biguá.') : null)),
    h('section', { class: 'card' },
      h('h2', { class: 'first' }, 'Así la van a leer los bots'),
      h('dl', { class: 'efectivos' }, Object.entries(d.efectivos.valores).map(([clave, val]) => [
        h('dt', {}, d.efectivos.titulos?.[clave] ?? clave, ' ', h('span', { class: 'small muted' }, `(${ORIGEN[d.efectivos.origen[clave]] ?? ''})`)),
        h('dd', {}, valorTexto(val))]))),
    pieNavegacion(`${baseA}/${pasos.at(-1).clave}`, null),
  ];
}

// ---------------------------------------------------------------- navegación

async function route() {
  const hash = location.hash;
  const act = /^#activar=([A-Za-z0-9_-]+)$/.exec(hash);
  if (act) return renderActivate(act[1]);
  if (!me) {
    try { me = (await api('GET', '/me')).me; } catch { return; }
  }
  renderShell();
  const parts = hash.replace(/^#\/?/, '').split('#')[0].split('/').filter(Boolean).map(decodeURIComponent);
  for (const a of document.querySelectorAll('nav a')) a.classList.toggle('on', a.dataset.nav === (parts[0] === 'equipo' ? 'equipo' : 'clientes'));
  main.replaceChildren(h('p', { class: 'muted' }, 'Cargando…'));
  try {
    if (parts[0] === 'c' && parts[1]) await renderClient(parts[1], parts[2], parts[3], parts.slice(4));
    else if (parts[0] === 'equipo' && me.role === 'bigua_admin') await renderTeam();
    else await renderClients();
  } catch (e) {
    if (e.status !== 401) main.replaceChildren(h('div', { class: 'card empty' }, h('p', { class: 'err' }, e.message), h('a', { href: '#/' }, 'Volver')));
  }
}

window.addEventListener('hashchange', route);
route();
