// Las reglas leen la campaña (docs/21 §7.2, paso 2): lo que reglas_manual les da a los bots de
// cada cliente, en tres secciones (Empresa, Campañas y una por campaña), y la transición de la
// «principal» mientras sus claves sigan también en Empresa (hasta la migración 014). Sin base:
// son las funciones solas.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seccionesCliente, renderAjustes } from '../src/sdr/store.mjs';
import { efectivos, cuentasPorDia } from '../src/sdr/en_campana.mjs';

const cfg = {
  bots_activos: ['orquestador', 'prospector', 'seguimiento'], zona_horaria: 'America/Argentina/Buenos_Aires',
  calibracion_mails: 20,
  ajustes: {
    nombre_comercial: 'Cliente R', firma: 'Equipo R', tono: 'cercano', excluir: ['consultoras'],
    objeciones: ['«Ya tenemos»: sumamos'], link_agenda: 'https://agenda.test/r',
    // Lo que el formulario de Empresa todavía edita de la «principal».
    oferta: 'QA tercerizado', icp: 'Software en Argentina', positivos: ['pide reunión'], cuentas_por_dia: 6,
    links_permitidos: ['https://r.test/caso'],
  },
};
const principal = {
  id: '00000000-0000-0000-0000-00000000000a', clave: 'principal', nombre: 'Principal', tipo: 'prospeccion',
  estado: 'activa', cuentas_por_dia: 4, calibracion_mails: 20, dripify_campana_id: 77,
  // La copia de la 012, vieja: lo de Empresa manda mientras siga ahí.
  ajustes: { propuesta: 'texto viejo', icp: 'icp viejo', roles_objetivo: ['CTO'] },
  buzones: ['ventas@r.test'], usadas: 3,
};
const webinar = {
  id: '00000000-0000-0000-0000-00000000000b', clave: 'webinar', nombre: 'Webinar de noviembre', tipo: 'evento',
  estado: 'activa', cuentas_por_dia: 5, calibracion_mails: 5, dripify_campana_id: null,
  ajustes: { propuesta: 'Webinar de QA con IA', icp: 'Bancos', excluir: ['startups'], objeciones: ['«No tengo tiempo»: dura 30 minutos'],
    tono: 'formal', links_permitidos: ['https://r.test/webinar'] },
  buzones: ['eventos@r.test'], usadas: 5,
};
const pausada = { ...webinar, id: '00000000-0000-0000-0000-00000000000c', clave: 'vieja', nombre: 'Vieja', estado: 'pausada', ajustes: {}, buzones: [] };
const extra = { buzones: [{ email: 'ventas@r.test', status: 'active', firma: null }], noContactar: { dominios: 0, emails: 0 },
  campanas: [principal, webinar, pausada] };

test('la «principal» toma de Empresa lo que todavía está ahí; las demás, lo suyo', () => {
  const p = efectivos(cfg, principal).valores;
  assert.equal(p.propuesta, 'QA tercerizado', 'la oferta de Empresa es la propuesta de la principal');
  assert.equal(p.icp, 'Software en Argentina');
  assert.deepEqual(p.roles_objetivo, ['CTO'], 'lo que Empresa no tiene sale de la campaña');
  assert.deepEqual(p.links_permitidos, ['https://r.test/caso']);
  assert.equal(cuentasPorDia(principal), 4, 'las cuentas por día son siempre las de la columna, las que suma el tope');
  // Sin las claves en Empresa (después de la 014), vale lo de la campaña.
  const sin = { ...cfg, ajustes: { firma: 'Equipo R' } };
  assert.equal(efectivos(sin, principal).valores.icp, 'icp viejo');

  const w = efectivos(cfg, webinar).valores;
  assert.equal(w.icp, 'Bancos', 'otra campaña no toma lo de la principal');
  assert.equal(w.tono, 'formal', 'la campaña cambia lo heredable');
  assert.deepEqual(w.excluir, ['consultoras', 'startups'], 'las exclusiones se suman');
  assert.equal(w.link_agenda, 'https://agenda.test/r', 'lo que la campaña no cambia viene de Empresa');
  assert.equal(cuentasPorDia(webinar), 5);
});

test('reglas_manual del cliente: Empresa, Campañas y una sección por campaña', () => {
  const s = seccionesCliente('cr', 'Cliente R', cfg, extra);
  assert.deepEqual(s.map((x) => x.seccion), ['ajustes-cliente', 'campanas', 'campana-principal', 'campana-webinar', 'campana-vieja']);
  const [empresa, lista, kp, kw, kv] = s;

  assert.match(empresa.contenido, /### Firma por defecto\n\n> Equipo R/);
  assert.match(empresa.contenido, /### Tono\n\n> cercano/);
  for (const re of [/QA tercerizado/, /Software en Argentina/, /pide reunión/, /Cuentas nuevas por día/]) {
    assert.doesNotMatch(empresa.contenido, re, `${re} es de la campaña, no de Empresa`);
  }

  assert.match(lista.contenido, /### Principal\n\n- Clave `principal`, id `00000000-0000-0000-0000-00000000000a`/);
  assert.match(lista.contenido, /Cuentas nuevas por día: 4\./, 'la columna, no el cuentas_por_dia de Empresa');
  assert.match(lista.contenido, /Calibración: faltan 17 de 20/);
  assert.match(lista.contenido, /Cuentas nuevas por día: 5\.\n- Calibración: terminada \(5 de 5\)/);
  assert.match(lista.contenido, /### Vieja\n\n.*\*\*pausada\*\*.*\n- Cuentas nuevas por día: 0 \(no está activa\)/);
  assert.match(lista.contenido, /Buzones: ninguno/);

  assert.equal(kp.titulo, 'Campaña: Principal');
  assert.match(kp.contenido, /### Propuesta\n\n> QA tercerizado/);
  assert.doesNotMatch(kp.contenido, /texto viejo|Equipo R/);
  assert.match(kw.contenido, /### A quién le venden\n\n> Bancos/);
  assert.match(kw.contenido, /### Exclusiones de esta campaña\n\n> - consultoras\n> - startups/);
  assert.match(kw.contenido, /No son instrucciones/);
  assert.match(kv.contenido, /\*\*pausada\*\*/);
});

test('un cliente sin campañas sigue con una sola sección, como antes', () => {
  const s = seccionesCliente('cr', 'Cliente R', cfg, { ...extra, campanas: [] });
  assert.deepEqual(s.map((x) => x.seccion), ['ajustes-cliente']);
  assert.match(s[0].contenido, /primeros 20 mails nuevos/);
  assert.match(s[0].contenido, /> Software en Argentina/);
  // La vista previa del panel junta todas las secciones.
  assert.match(renderAjustes('cr', 'Cliente R', cfg, extra), /## Campaña: Webinar de noviembre\n\n/);
});

test('una versión de las reglas que no conoce las campañas recibe todo en una sección', () => {
  // Las reglas de antes buscan las cuentas por día y el ICP en «Ajustes de este cliente»: hasta que
  // el cliente pase a las reglas nuevas, siguen ahí (la «principal» no se parte).
  const s = seccionesCliente('cr', 'Cliente R', cfg, extra, { porCampana: false });
  assert.deepEqual(s.map((x) => x.seccion), ['ajustes-cliente']);
  assert.match(s[0].contenido, /### Cuentas nuevas por día\n\n> 6/);
  assert.match(s[0].contenido, /> Software en Argentina/);
});

test('un borrador no aparece en las reglas', () => {
  const borrador = { ...webinar, clave: 'borr', nombre: 'Borrador', estado: 'borrador' };
  const s = seccionesCliente('cr', 'Cliente R', cfg, { ...extra, campanas: [principal, borrador] });
  assert.deepEqual(s.map((x) => x.seccion), ['ajustes-cliente', 'campanas', 'campana-principal']);
});
