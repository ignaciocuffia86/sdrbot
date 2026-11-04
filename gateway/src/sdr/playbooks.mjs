// Lee los playbooks del repo (carpeta playbooks/) y los arma para publicar en Supabase.
//
//   playbooks/comun.md              bot '*', tarea '*'   (vale para todos los bots)
//   playbooks/rutina.md             bot '*', tarea 'rutina', sección 'plantilla' (prompt de las routines)
//   playbooks/<bot>/_bot.md         bot <bot>, tarea '*' (vale para todas las tareas del bot)
//   playbooks/<bot>/<tarea>.md      bot <bot>, tarea <tarea>
//   playbooks/rutinas.json          las routines de cada bot
//
// Cada archivo se parte en secciones por los títulos «## ». La primera línea de una sección
// que empieza con «> » es su resumen (lo que se ve en el índice).

import fs from 'node:fs';
import path from 'node:path';

const slug = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

export function parseSecciones(md, { bot, tarea }) {
  const out = [];
  let actual = null;
  const cerrar = () => {
    if (!actual) return;
    const lineas = actual.lineas;
    while (lineas.length && !lineas[0].trim()) lineas.shift();
    let resumen = '';
    if (lineas[0]?.startsWith('> ')) resumen = lineas.shift().slice(2).trim();
    actual.contenido = lineas.join('\n').trim();
    actual.resumen = resumen;
    delete actual.lineas;
    if (!actual.contenido) throw new Error(`Sección vacía: ${bot}/${tarea}/${actual.seccion}`);
    out.push(actual);
  };
  for (const linea of md.split('\n')) {
    const m = /^## (.+?)\s*$/.exec(linea);
    if (m) {
      cerrar();
      actual = { bot, tarea, orden: out.length + 1, seccion: slug(m[1]), titulo: m[1], lineas: [] };
    } else if (actual) {
      actual.lineas.push(linea);
    }
  }
  cerrar();
  const vistos = new Set();
  for (const s of out) {
    if (vistos.has(s.seccion)) throw new Error(`Sección repetida: ${bot}/${tarea}/${s.seccion}`);
    vistos.add(s.seccion);
  }
  return out;
}

export function cargarPlaybooks(dir) {
  const secciones = [];
  const leer = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
  secciones.push(...parseSecciones(leer('comun.md'), { bot: '*', tarea: '*' }));
  secciones.push({ bot: '*', tarea: 'rutina', orden: 1, seccion: 'plantilla', titulo: 'Prompt de las routines', resumen: '',
    contenido: leer('rutina.md').trim() });
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const bot = ent.name;
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(bot)) throw new Error(`Nombre de bot inválido: ${bot}`);
    for (const f of fs.readdirSync(path.join(dir, bot)).filter((x) => x.endsWith('.md')).sort()) {
      const tarea = f === '_bot.md' ? '*' : f.slice(0, -3);
      if (tarea !== '*' && !/^[a-z][a-z0-9_]{1,40}$/.test(tarea)) throw new Error(`Nombre de tarea inválido: ${bot}/${f}`);
      secciones.push(...parseSecciones(leer(path.join(bot, f)), { bot, tarea }));
    }
  }
  // El índice de un bot junta comunes, _bot y su tarea: un mismo id en dos niveles sería ambiguo.
  const bots = [...new Set(secciones.filter((s) => s.bot !== '*').map((s) => s.bot))];
  for (const bot of bots) {
    const tareas = [...new Set(secciones.filter((s) => s.bot === bot && s.tarea !== '*').map((s) => s.tarea))];
    for (const tarea of tareas) {
      const ids = secciones.filter((s) => (s.bot === '*' && s.tarea === '*') || (s.bot === bot && (s.tarea === '*' || s.tarea === tarea)))
        .map((s) => s.seccion);
      const rep = ids.find((x, i) => ids.indexOf(x) !== i);
      if (rep) throw new Error(`La sección "${rep}" aparece dos veces en el índice de ${bot}/${tarea}: cambiarle el título a una`);
    }
  }
  const rutinas = JSON.parse(leer('rutinas.json'));
  for (const r of rutinas) {
    for (const k of ['bot', 'nombre', 'tarea', 'cron', 'descripcion']) if (!r[k]) throw new Error(`Routine sin ${k}: ${JSON.stringify(r)}`);
    if (r.cron.split(/\s+/).length !== 5) throw new Error(`Cron inválido en ${r.bot}/${r.nombre}: ${r.cron}`);
    const tieneManual = secciones.some((s) => s.bot === r.bot && s.tarea === r.tarea);
    if (!tieneManual) throw new Error(`La routine ${r.bot}/${r.nombre} usa la tarea ${r.tarea}, que no tiene manual`);
  }
  return { secciones, rutinas };
}

// SQL para publicar una versión en producción por el MCP de Supabase (sin conexión directa).
const lit = (v) => (v === null || v === undefined ? 'null' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

export function sqlPublicacion({ version, notas, canal }, { secciones, rutinas }) {
  const lineas = ['begin;', `insert into sdr.playbook_version (version, notas) values (${lit(version)}, ${lit(notas)});`];
  for (const s of secciones) {
    lineas.push(`insert into sdr.playbook_seccion (version, bot, tarea, orden, seccion, titulo, resumen, contenido) values (${
      [version, s.bot, s.tarea, s.orden, s.seccion, s.titulo, s.resumen, s.contenido].map(lit).join(', ')});`);
  }
  for (const r of rutinas) {
    lineas.push(`insert into sdr.playbook_rutina (version, bot, nombre, tarea, cron, timing, disparo, descripcion, etapa) values (${
      [version, r.bot, r.nombre, r.tarea, r.cron, r.timing ?? 'flexible', r.disparo ?? 'horario', r.descripcion, r.etapa ?? 1].map(lit).join(', ')});`);
  }
  if (canal) {
    lineas.push(`insert into sdr.playbook_canal (canal, version) values (${lit(canal)}, ${lit(version)}) ` +
      'on conflict (canal) do update set version = excluded.version, cambiado_at = now();');
  }
  lineas.push('commit;');
  return lineas.join('\n');
}
