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
    h('p', { class: 'sub' }, 'Panel de buzones del SDR Bot.'),
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

async function renderClient(clientId, tab) {
  const data = await api('GET', `/clients/${enc(clientId)}`);
  const bigua = data.can_manage_access;
  const tabs = [['sdr', 'SDR'], ['buzones', 'Buzones'], ['dominios', 'Dominios'], ...(bigua ? [['usuarios', 'Usuarios'], ['tokens', 'Tokens de Grok Bot']] : []), ['actividad', 'Actividad']];
  if (!tabs.some(([k]) => k === tab)) tab = 'sdr';
  const base = `#/c/${enc(clientId)}`;
  const body = h('div');
  main.replaceChildren(
    ...(bigua ? [h('a', { href: '#/', class: 'small' }, '← Clientes')] : []),
    h('h1', {}, data.client.name),
    h('p', { class: 'sub mono' }, data.client.id),
    h('div', { class: 'tabs' }, tabs.map(([k, label]) => h('a', { href: `${base}/${k}`, class: k === tab ? 'on' : '' }, label))),
    body);
  const reload = () => renderClient(clientId, tab);
  if (tab === 'sdr') body.append(await sdrView(clientId, bigua));
  if (tab === 'buzones') body.append(mailboxesView(data, reload));
  if (tab === 'usuarios') body.append(usersView(data, reload));
  if (tab === 'tokens') body.append(tokensView(data, reload));
  if (tab === 'dominios') body.append(await domainsView(clientId, reload));
  if (tab === 'actividad') body.append(await activityView(clientId));
}

// ----- SDR: ajustes del cliente

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

function sdrTecnico(clientId, sdr, reload) {
  const t = sdr.tecnico;
  const form = h('form', { class: 'card' },
    h('h2', { class: 'first' }, 'Configuración técnica'),
    h('p', { class: 'muted small' }, 'Sólo la ven los operadores de Biguá.'),
    h('div', { class: 'cols2' },
      field('Canal de reglas', h('select', { name: 'canal' },
        ['estable', 'canario'].map((x) => h('option', { value: x, selected: t?.canal === x }, x)))),
      field('Zona horaria', h('input', { name: 'zona_horaria', value: t?.zona_horaria ?? 'America/Argentina/Buenos_Aires' }))),
    field('Calibración: mails nuevos que se aprueban en el chat', h('input', { name: 'calibracion_mails', type: 'number', min: 0, max: 500, value: t?.calibracion_mails ?? 20 }),
      t ? `Van ${t.calibracion_usadas} aprobados y enviados. En 0, los mails salen sin aprobación previa.` : 'Por defecto, 20.'),
    h('label', {}, 'Bots activos'),
    h('div', { class: 'row' }, sdr.bots.map((b) => h('label', { class: 'check' },
      h('input', { type: 'checkbox', name: 'bot', value: b, checked: t ? t.bots_activos.includes(b) : ['orquestador', 'prospector'].includes(b) }), b))),
    t?.version_fija ? h('p', { class: 'note' }, `Este cliente está fijado a la versión ${t.version_fija} de las reglas (se cambia por la CLI).`) : null);
  const err = h('p', { class: 'err', role: 'alert' });
  const btn = h('button', { type: 'submit', class: 'primary' }, t ? 'Guardar configuración' : 'Activar el SDR');
  form.append(err, h('div', { class: 'row' }, btn));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const body = {
      canal: fd.get('canal'), zona_horaria: String(fd.get('zona_horaria')).trim(),
      calibracion_mails: Number(fd.get('calibracion_mails')), bots_activos: fd.getAll('bot'),
    };
    const r = await busy(btn, () => api('PUT', `/clients/${enc(clientId)}/sdr/config`, body), err);
    if (r) { toast(t ? 'Configuración guardada.' : 'SDR activado.'); reload(); }
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

async function sdrView(clientId, bigua) {
  const sdr = await api('GET', `/clients/${enc(clientId)}/sdr`);
  const reload = () => renderClient(clientId, 'sdr');
  if (!sdr.activo) {
    if (!bigua) return h('div', { class: 'card empty' }, h('p', {}, 'El SDR todavía no está activado para esta cuenta. Lo activa Biguá.'));
    return h('div', {}, h('p', { class: 'muted' }, 'Este cliente no tiene el SDR activado. Elegí la configuración y activalo; después cargá los ajustes.'),
      sdrTecnico(clientId, sdr, reload));
  }
  const err = h('p', { class: 'err', role: 'alert' });
  const btn = h('button', { type: 'submit', class: 'primary' }, 'Guardar ajustes');
  const nota = h('input', { name: '_nota', maxlength: 300, placeholder: 'Opcional: por qué el cambio' });
  const form = h('form', { class: 'card' },
    h('h2', { class: 'first' }, 'Ajustes del SDR'),
    h('p', { class: 'muted small' }, bigua
      ? 'Lo que los bots leen como «Ajustes de este cliente». Los cambios valen desde la próxima corrida de cada bot.'
      : 'Cómo los bots presentan su empresa y a quién le escriben. Los cambios valen desde la próxima corrida de cada bot, y le avisamos al operador de Biguá.'),
    sdr.campos.map((c) => field(c.editable ? c.titulo : `${c.titulo} · lo cambia Biguá`, campoInput(c, sdr.ajustes[c.clave]), c.ayuda)),
    field('Nota del cambio', nota),
    err, h('div', { class: 'row' }, btn));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const body = { ajustes: leerCampos(form, sdr.campos), ...(nota.value.trim() ? { nota: nota.value.trim() } : {}) };
    const r = await busy(btn, () => api('PUT', `/clients/${enc(clientId)}/sdr/ajustes`, body), err);
    if (r) { toast(r.cambios.length ? 'Ajustes guardados.' : 'No había cambios.'); reload(); }
  });

  const otros = Object.keys(sdr.ajustes).filter((k) => !sdr.campos.some((c) => c.clave === k));
  const historial = sdr.historial.length
    ? h('table', {}, h('thead', {}, h('tr', {}, ['Cuándo', 'Quién', 'Qué cambió', 'Nota', ''].map((x) => h('th', {}, x)))),
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
        } }, 'Volver a esta'))))))
    : h('p', { class: 'muted small' }, 'Todavía no hay cambios registrados.');

  return h('div', { class: 'sdr' },
    h('div', { class: 'sdr-grid' },
      form,
      h('div', {},
        h('div', { class: 'card' },
          h('h2', { class: 'first' }, 'Así lo leen los bots'),
          h('pre', { class: 'record preview' }, sdr.vista_previa ?? ''),
          otros.length ? h('p', { class: 'small muted' }, `Además hay ajustes cargados por Biguá fuera del formulario: ${otros.join(', ')}.`) : null),
        bigua ? sdrTecnico(clientId, sdr, reload) : null,
        bigua && sdr.tecnico?.bots_activos.includes('orquestador') ? despertadorCard(clientId, sdr, reload, 'orquestador') : null,
        bigua && sdr.tecnico?.bots_activos.includes('seguimiento') ? despertadorCard(clientId, sdr, reload, 'seguimiento') : null,
        bigua ? dripifyCard(clientId, sdr, reload) : null)),
    h('h2', {}, 'Historial de cambios'),
    historial);
}

// ----- buzones

function mailboxesView(data, reload) {
  const cid = data.client.id;
  const add = h('button', { class: 'primary', onclick: () => mailboxDialog(cid, null, reload) }, 'Agregar buzón');
  if (!data.mailboxes.length) {
    return h('div', {}, h('div', { class: 'card empty' }, h('p', {}, 'Este cliente todavía no tiene buzones.'), add));
  }
  const rows = data.mailboxes.map((m) => h('tr', {},
    h('td', {}, h('strong', {}, m.email), m.display_name ? h('div', { class: 'small muted' }, m.display_name) : null),
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
  'admin.sdr.ajustes': 'cambio de ajustes del SDR', 'admin.sdr.restaurar': 'ajustes vueltos a una versión anterior',
  'admin.sdr.config': 'configuración técnica del SDR', 'admin.sdr.despertador': 'despertador de seguimiento',
  'admin.sdr.despertador.apagar': 'despertador apagado',
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
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  for (const a of document.querySelectorAll('nav a')) a.classList.toggle('on', a.dataset.nav === (parts[0] === 'equipo' ? 'equipo' : 'clientes'));
  main.replaceChildren(h('p', { class: 'muted' }, 'Cargando…'));
  try {
    if (parts[0] === 'c' && parts[1]) await renderClient(parts[1], parts[2]);
    else if (parts[0] === 'equipo' && me.role === 'bigua_admin') await renderTeam();
    else await renderClients();
  } catch (e) {
    if (e.status !== 401) main.replaceChildren(h('div', { class: 'card empty' }, h('p', { class: 'err' }, e.message), h('a', { href: '#/' }, 'Volver')));
  }
}

window.addEventListener('hashchange', route);
route();
