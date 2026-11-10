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
      location.hash = `#/c/${enc(client.id)}`;
      return true;
    },
  });
}

// ---------------------------------------------------------------- un cliente

// La ficha de un cliente (docs/21 §3): Resumen, Empresa, Canales y Actividad; Administración
// aparte, sólo para Biguá. Las direcciones de las pestañas viejas llevan a su lugar nuevo.
const VIEJAS = { sdr: ['empresa'], buzones: ['canales'], dominios: ['canales'], usuarios: ['admin', 'usuarios'], tokens: ['admin', 'tokens'] };
const TABS = [['resumen', 'Resumen'], ['campanas', 'Campañas'], ['empresa', 'Empresa'], ['canales', 'Canales'], ['actividad', 'Actividad']];

// Mientras los bots no lean las campañas (etapa C1, docs/21 §7), lo que se cambia en la pestaña
// Campañas no cambia lo que hacen: la ve sólo Biguá. Pasa a true cuando las reglas lean la campaña.
const CAMPANAS_PARA_CLIENTES = false;

async function renderClient(clientId, tab, sub) {
  if (VIEJAS[tab]) [tab, sub = sub] = VIEJAS[tab];
  const data = await api('GET', `/clients/${enc(clientId)}`);
  const bigua = data.can_manage_access;
  const tabs = TABS.filter(([k]) => k !== 'campanas' || bigua || CAMPANAS_PARA_CLIENTES);
  if (!tabs.some(([k]) => k === tab) && !(bigua && tab === 'admin')) tab = 'resumen';
  const base = `#/c/${enc(clientId)}`;
  const body = h('div');
  main.replaceChildren(
    ...(bigua ? [h('a', { href: '#/', class: 'small' }, '← Clientes')] : []),
    h('h1', {}, data.client.name),
    h('p', { class: 'sub mono' }, data.client.id),
    h('nav', { class: 'tabs' },
      tabs.map(([k, label]) => h('a', { href: `${base}/${k}`, class: k === tab ? 'on' : '' }, label)),
      bigua ? h('a', { href: `${base}/admin`, class: `gear${tab === 'admin' ? ' on' : ''}` }, '⚙ Administración') : null),
    body);
  const v = { clientId, data, bigua, base, reload: () => renderClient(clientId, tab, sub) };
  if (tab === 'resumen') body.append(await resumenView(v));
  if (tab === 'campanas') body.append(await (sub ? campanaView(v, sub) : campanasView(v)));
  if (tab === 'empresa') body.append(await empresaView(v));
  if (tab === 'canales') body.append(await canalesView(v));
  if (tab === 'actividad') body.append(await monitorView(clientId));
  if (tab === 'admin') body.append(await adminView(v, sub));
}

// ----- resumen

const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

async function resumenView({ clientId, bigua, base }) {
  const r = await api('GET', `/clients/${enc(clientId)}/resumen`);
  const avisos = [];
  const aviso = (nivel, texto, href, accion) => avisos.push({ nivel, texto, href, accion });
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
    if (r.aprobaciones_pendientes) aviso('warn', `${plural(r.aprobaciones_pendientes, 'aprobación espera', 'aprobaciones esperan')} en el chat del orquestador.`);
    const sinAtender = r.correo_sin_atender + r.linkedin_sin_atender;
    if (sinAtender) aviso('warn', `${plural(sinAtender, 'respuesta de un prospecto espera', 'respuestas de prospectos esperan')} al bot de seguimiento.`);
    if (r.dripify?.ultimo_error) aviso('err', `LinkedIn · Dripify: ${r.dripify.ultimo_error}`, `${base}/canales`, 'Ver');
    if (r.crm?.estado === 'credencial_vencida') aviso('err', `CRM: HubSpot rechazó el token. Las cargas esperan en cola.${r.crm.ultimo_error ? ` ${r.crm.ultimo_error}` : ''}`, `${base}/canales`, 'Reconectar');
    if (r.crm?.con_problema) aviso('err', `${plural(r.crm.con_problema, 'positivo no se pudo', 'positivos no se pudieron')} cargar en el CRM.`, `${base}/canales`, 'Ver');
    if (r.whatsapp?.pausado) aviso('err', `WhatsApp en pausa: ${r.whatsapp.pausa_motivo ?? 'bloqueo'}.`, `${base}/canales`, bigua ? 'Revisar y reanudar' : 'Ver');
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
    canal('CRM · HubSpot', !r.crm?.token ? ['b-mute', 'sin conectar'] : r.crm.con_problema ? ['b-err', 'con problemas'] : CRM_ESTADO[r.crm.estado] ?? ['b-mute', r.crm.estado],
      r.crm?.token ? `${plural(r.crm.semana, 'cargado', 'cargados')} en 7 días${r.crm.en_cola ? ` · ${r.crm.en_cola} en cola` : ''}` : 'Los positivos aprobados se cargan solos'),
    h('a', { class: 'card canal-card', href: `${base}/empresa#no-contactar` },
      h('div', { class: 'row spread' }, h('strong', {}, 'No contactar'), h('span', { class: 'badge b-mute' }, String(r.no_contactar.dominios + r.no_contactar.emails))),
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
  const auto = sdr.modo === 'autogestionado';
  const notaModo = sdr.formulario === 'empresa'
    ? 'A quién se le escribe, la propuesta, el volumen y los buzones son de cada campaña: se editan en su campaña. Esto vale para las campañas que no digan otra cosa.'
    : auto
    ? `Este cliente es autogestionado: el volumen y los buzones los decide el cliente${sdr.tope_cuentas_dia !== null ? `, hasta ${sdr.tope_cuentas_dia} cuentas nuevas por día` : ''}.`
    : 'Este cliente lo opera Biguá: el volumen y los buzones los decide Biguá.';
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

function transicionNota() {
  return h('p', { class: 'note' }, 'Transición: los bots todavía escriben con los ajustes de Empresa y no reparten el volumen por campaña. ',
    'El gateway ya hace cumplir cada campaña: en una que no está activa no salen mails nuevos, no se carga a nadie en LinkedIn ',
    'ni se toman personas nuevas; los mails salen sólo por sus buzones y con sus links permitidos.');
}

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
        location.hash = `${base}/campanas/${r.id}`;
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
    transicionNota(),
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
    case 'ritmo': return `${plural(k.buzones.length, 'buzón', 'buzones')} · ${k.cuentas_por_dia} cuentas por día${k.dripify_campana_id ? ` · Dripify ${k.dripify_campana_id}` : ''}`;
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
      cols.map((c) => field(conCandado(c), columnaInput(c, k, d), c.clave === 'cuentas_por_dia' && d.tope_cuentas_dia !== null
        ? `Las demás activas suman ${d.otras_activas}; el tope del cliente es ${d.tope_cuentas_dia}.` : null)),
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
  const historial = d.historial.length
    ? h('table', {}, h('thead', {}, h('tr', {}, ['Cuándo', 'Quién', 'Qué cambió', 'Nota'].map((x) => h('th', {}, x)))),
      h('tbody', {}, d.historial.map((v) => h('tr', {}, h('td', { class: 'small' }, fmtDate(v.at)),
        h('td', { class: 'small' }, v.por_email ?? '—'), h('td', { class: 'small' }, v.cambios_titulos.join(', ') || '—'),
        h('td', { class: 'small' }, v.nota ?? '')))))
    : h('p', { class: 'muted small' }, 'Todavía no hay cambios registrados.');

  return h('div', { class: 'stack' },
    h('a', { href: `${base}/campanas`, class: 'small' }, '← Campañas'),
    h('div', { class: 'row spread' },
      h('div', {}, h('h2', { class: 'first' }, k.nombre, ' ', estadoBadge(k.estado)),
        h('p', { class: 'small muted mono m0' }, k.clave)),
      h('div', { class: 'row' }, acciones)),
    transicionNota(),
    terminada ? h('p', { class: 'note' }, `Terminada el ${fmtDate(k.terminada_at)}. No se edita ni se reactiva: para repetirla, duplicala.`) : null,
    errEstado,
    h('div', { class: 'sdr-grid' }, form, h('div', { class: 'stack sticky' }, faltan, vista)),
    h('section', {}, h('h2', {}, 'Historial de cambios'), historial));
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
    const vistas = (q ? lista.filter((x) => x.valor.includes(q) || (x.motivo ?? '').toLowerCase().includes(q)) : lista);
    const muestra = vistas.slice(0, 200);
    cuerpo.replaceChildren(!lista.length ? h('p', { class: 'muted small' }, 'La lista está vacía.') : h('div', {},
      h('table', {}, h('thead', {}, h('tr', {}, ['Dominio o mail', 'Motivo', 'Cargado', ''].map((x) => h('th', {}, x)))),
        h('tbody', {}, muestra.map((x) => h('tr', {},
          h('td', {}, h('span', { class: 'mono' }, x.valor), h('div', { class: 'small muted' }, x.tipo === 'dominio' ? 'dominio y sus subdominios' : 'mail')),
          h('td', { class: 'small' }, x.motivo ?? '—'),
          h('td', { class: 'small' }, fmtDate(x.at), x.por_email ? h('div', { class: 'muted' }, x.por_email) : null),
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
    totales.textContent = `${plural(r.totales.dominios, 'dominio', 'dominios')} · ${plural(r.totales.emails, 'mail', 'mails')}`;
    filtro.hidden = lista.length < 15;
    pintarLista();
  };
  const informar = (r) => {
    const partes = [`${plural(r.agregados, 'agregado', 'agregados')}`];
    if (r.ya_estaban) partes.push(`${r.ya_estaban} ya estaban`);
    salida.replaceChildren(h('p', {}, `${partes.join(', ')}.`),
      r.invalidas?.length ? h('div', { class: 'err' }, `${plural(r.invalidas.length, 'renglón no tiene', 'renglones no tienen')} un dominio o un mail válido: `,
        r.invalidas.slice(0, 5).map((x) => `renglón ${x.renglon} («${x.texto}»)`).join(', '), r.invalidas.length > 5 ? '…' : '') : null);
  };
  const err = h('p', { class: 'err', role: 'alert' });
  const valor = h('input', { id: 'nc-valor', required: true, maxlength: 300, placeholder: 'empresa.com o persona@empresa.com' });
  const motivo = h('input', { id: 'nc-motivo', maxlength: 200, placeholder: 'Cliente actual, competidor, pidió que no…' });
  const agregar = h('button', { type: 'submit', class: 'primary' }, 'Agregar');
  const alta = h('form', { class: 'nc-alta' }, field('Dominio o mail', valor), field('Motivo', motivo), agregar);
  alta.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const r = await busy(agregar, () => api('POST', path, { valor: valor.value, ...(motivo.value.trim() ? { motivo: motivo.value.trim() } : {}) }), err);
    if (r) { pintar(r); informar(r); valor.value = ''; motivo.value = ''; valor.focus(); }
  });
  const archivo = h('input', { type: 'file', accept: '.csv,.txt,text/csv,text/plain', id: 'nc-csv', class: 'visually-hidden' });
  archivo.addEventListener('change', async () => {
    const f = archivo.files?.[0];
    if (!f) return;
    if (f.size > 400_000) { err.textContent = 'El archivo pasa los 400 KB: partilo en dos.'; return; }
    err.textContent = '';
    const texto = await f.text();
    try { const r = await api('POST', path, { csv: texto }); pintar(r); informar(r); } catch (e) { err.textContent = e.message; }
    archivo.value = '';
  });
  const pegar = h('button', { type: 'button', onclick: () => openDialog('Pegar una lista', h('div', {},
    h('p', { class: 'small muted' }, 'Un dominio o un mail por renglón. Después de una coma, el motivo (opcional).'),
    h('textarea', { name: 'csv', rows: 10, required: true, placeholder: 'empresa.com, Cliente actual\npersona@otra.com, Pidió que no' })), {
    submitLabel: 'Agregar',
    submit: async (fd) => { const r = await api('POST', path, { csv: fd.get('csv') }); pintar(r); informar(r); return true; },
  }) }, 'Pegar una lista');
  card.append(
    h('div', { class: 'row spread' }, h('h2', { class: 'first' }, 'No contactar'), totales),
    h('p', { class: 'small muted' }, 'Empresas y personas a las que el SDR no les escribe nunca, de ninguna campaña ni canal: clientes actuales, ' +
      'partners, competidores, quien pidió que no. El gateway la hace cumplir: una empresa de la lista queda excluida y nadie de ella ' +
      'recibe mails ni invitaciones de LinkedIn. Un dominio cubre también sus subdominios.'),
    alta, err,
    h('div', { class: 'row' }, h('label', { for: 'nc-csv', class: 'btn' }, 'Cargar CSV'), archivo, pegar,
      h('span', { class: 'small muted' }, 'CSV: primera columna el dominio o el mail, segunda el motivo.')),
    salida, filtro, cuerpo);
  pintar(await api('GET', path));
  return card;
}

// ----- canales

async function canalesView({ clientId, data, bigua, reload }) {
  const [resumen, sdr] = await Promise.all([
    api('GET', `/clients/${enc(clientId)}/resumen`),
    bigua ? api('GET', `/clients/${enc(clientId)}/sdr`) : Promise.resolve(null),
  ]);
  const d = resumen.dripify;
  const linkedin = bigua && sdr?.activo
    ? dripifyCard(clientId, sdr, reload)
    : h('section', { class: 'card' },
      h('div', { class: 'row spread' }, h('h2', { class: 'first' }, 'LinkedIn · Dripify'),
        !d?.cargado ? h('span', { class: 'badge b-mute' }, 'sin cargar') : d.ultimo_error ? h('span', { class: 'badge b-err' }, 'con error')
          : h('span', { class: 'badge b-ok' }, 'cargado')),
      h('p', { class: 'small muted' }, 'La cuenta de Dripify del cliente y su campaña. La conecta Biguá: si querés sumar LinkedIn, pedíselo.'),
      d?.ultimo_error ? h('p', { class: 'small err' }, d.ultimo_error) : null);
  const pronto = (titulo, texto) => h('div', { class: 'card' },
    h('div', { class: 'row spread' }, h('strong', {}, titulo), h('span', { class: 'badge b-mute' }, 'próximamente')),
    h('p', { class: 'small muted' }, texto));
  const w = resumen.whatsapp;
  const wa = bigua && sdr?.activo
    ? whatsappCard(clientId, sdr, w, reload)
    : h('section', { class: 'card' },
      h('div', { class: 'row spread' }, h('h2', { class: 'first' }, 'WhatsApp'), whatsappBadge(w)),
      h('p', { class: 'small muted' }, 'Sólo para seguir una conversación con quien ya respondió o ya tiene chat con nosotros: nunca a números fríos. ' +
        'Lo activa Biguá.'),
      w?.activo ? h('p', { class: 'small' }, `Horario ${w.horario} · ${w.hoy.enviados} de ${w.hoy.tope_dia} mensajes hoy`) : null,
      w?.pausado ? h('p', { class: 'small err' }, w.pausa_motivo ?? 'En pausa.') : null);
  return h('div', { class: 'stack' },
    h('section', { class: 'stack' }, h('h2', { class: 'first' }, 'Correo'), mailboxesView(data, reload),
      h('h3', {}, 'Dominios'), await domainsView(clientId, reload)),
    h('section', { class: 'stack' }, h('h2', {}, 'LinkedIn'), linkedin),
    h('section', { class: 'stack' }, h('h2', {}, 'WhatsApp'), wa),
    h('section', { class: 'stack' }, h('h2', {}, 'CRM'), resumen.sdr_activo
      ? await crmView(clientId, bigua, reload)
      : pronto('CRM · HubSpot', 'Se conecta cuando el SDR esté activado: los positivos aprobados se cargan solos.')));
}

// ----- CRM (docs/23): la conexión con HubSpot, la cola de cargas y la vista previa.

const CRM_ESTADO = {
  activa: ['b-ok', 'conectado'], pausada: ['b-mute', 'en pausa'], credencial_vencida: ['b-err', 'token rechazado'],
};
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

function crmConexionCard(clientId, bigua, cx, reload) {
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
    h('p', { class: 'muted small' }, 'Cuando el operador de Biguá aprueba la respuesta a un positivo, el gateway lo carga solo en el ' +
      'HubSpot del cliente: el contacto (si ya existe, sólo completa lo vacío y no cambia el dueño), la empresa por dominio, una nota ' +
      'con lo que respondió y una tarea para el dueño. Nunca borra nada.'),
    cx?.ultimo_error ? h('p', { class: 'small err' }, cx.ultimo_error) : null,
    cx?.ultimo_ok_at ? h('p', { class: 'small' }, `Última respuesta buena de HubSpot: ${fmtDate(cx.ultimo_ok_at)}`) : null,
    field('Token de la app privada', h('input', { name: 'token', type: 'password', autocomplete: 'off', required: !cx?.token, minlength: 20 }),
      cx?.token ? 'Dejalo vacío para conservar el guardado. Se guarda cifrado y no se vuelve a mostrar.'
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
    const body = {};
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
  const filas = (o) => h('table', {}, h('tbody', {}, Object.entries(o).map(([k, x]) => h('tr', {}, h('td', { class: 'mono small' }, k), h('td', {}, String(x))))));
  const nota = h('pre', { class: 'nota' });
  // La nota va a HubSpot como HTML; acá se muestra como texto, sin interpretarlo.
  nota.textContent = v.nota.hs_note_body.replace(/<br>/g, '\n').replace(/<\/(p|blockquote)>/g, '\n').replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  return h('div', { class: 'stack small' },
    h('p', {}, v.ejemplo ? 'Con un positivo de ejemplo (todavía no hay uno real):' : `Con el último positivo: ${v.nombre}.`,
      ' Nada de esto se escribió en HubSpot.'),
    h('p', {}, `Se busca el contacto por email (${v.buscar_por ?? 'sin email: la carga se bloquearía'}). Si existe, sólo se completan las propiedades vacías.`),
    h('strong', {}, 'Contacto'), filas(v.contacto),
    v.empresa ? [h('strong', {}, 'Empresa (por dominio)'), filas(v.empresa)] : h('p', { class: 'muted' }, 'Sin dominio: no se asocia empresa.'),
    h('strong', {}, 'Nota'), nota,
    h('strong', {}, 'Tarea'), filas({ asunto: v.tarea.hs_task_subject, vence: fmtDate(v.tarea.hs_timestamp), detalle: v.tarea.hs_task_body }));
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
    if (k.estado === 'hecha') return k.url ? h('a', { href: k.url, target: '_blank', rel: 'noopener noreferrer' }, 'Ver en HubSpot') : fmtDate(k.hecha_at);
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
      field('Id de la campaña', h('input', { name: 'campana_id', type: 'number', min: 1, required: true, value: d?.campana_id ?? '' }),
        'El número de la URL de la campaña en Dripify.'),
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

const ADMIN = [['operacion', 'Operación'], ['bots', 'Bots y despertadores'], ['usuarios', 'Usuarios'], ['tokens', 'Tokens de Grok Bot']];

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
      contenido = h('div', { class: 'card empty' }, 'Activá el SDR en Operación para configurar los bots.');
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
    if (parts[0] === 'c' && parts[1]) await renderClient(parts[1], parts[2], parts[3]);
    else if (parts[0] === 'equipo' && me.role === 'bigua_admin') await renderTeam();
    else await renderClients();
  } catch (e) {
    if (e.status !== 401) main.replaceChildren(h('div', { class: 'card empty' }, h('p', { class: 'err' }, e.message), h('a', { href: '#/' }, 'Volver')));
  }
}

window.addEventListener('hashchange', route);
route();
