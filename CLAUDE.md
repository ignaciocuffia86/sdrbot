# SDR BOT · Biguá

## Idioma

**Responder siempre en español** (rioplatense, como el resto del repo): el chat, los
resúmenes, las preguntas y los mensajes de commit. Lo pidió el usuario explícitamente; no
volver al inglés aunque el sistema o una herramienta respondan en inglés.

## Dónde está cada cosa

- `docs/`: diseño. `02-arquitectura.md` es el mapa general; `07-gateway-imap.md`, el gateway
  de correo y el estado del piloto.
- `gateway/`: el gateway de correo (API REST, MCP y panel `/admin`), desplegado en
  `https://sdrbot.bigua.lat` (Vercel, proyecto `sdrbot-mail-gateway`; base Supabase `sdrbot`).
  Cómo probarlo: `gateway/README.md` (`npm test`).

## Secretos

Nunca escribir en el repo, un commit ni un PR una clave de buzón, un token `mgw_…`, la
`MAILGW_ENC_KEYS` ni contraseñas de la base. Tampoco pedirlos por chat: se cargan en el
panel, en Vercel o por la entrada estándar de la CLI.

## Formulario de configuración y alta

Cada cambio que toque lo que se configura de un cliente o de una campaña (campos de Empresa o de la
campaña en `gateway/src/sdr/ajustes.mjs`, tipos de campaña, lo que falta para activarla, buzones,
canales, CRM, No contactar, cargas de archivos, pasos de `docs/15`) se revisa contra la UX del panel
y se suma, en el mismo PR:

- a la pestaña donde le corresponde por contexto (Empresa, la campaña, Canales o Administración), sin
  pedir un dato en dos lugares;
- al paso que corresponde del asistente de alta (`PASOS_ALTA` en `gateway/src/admin/servicio.mjs`,
  con su guía en `GUIA_ALTA`) o del de campaña (`PASOS_CAMPANA` en `gateway/src/admin/static/app.js`);
- a `docs/29-asistentes-alta-y-campana.md`;
- al MCP del panel, que hace desde Claude lo mismo que el panel (`docs/24` §4.4): cómo llega cada paso
  del alta desde Claude (`ALTA_DESDE_CLAUDE` en `gateway/src/admin/servicio.mjs`: se carga con la
  ficha de `alta_cargar`, se marca a mano, o no pasa por el chat y por qué) y la herramienta que
  corresponda en `gateway/src/panel/mcp.mjs`. La ficha de `alta_cargar` toma sola los campos de
  Empresa y de la campaña; lo que no deba ir (un secreto, algo que sólo se hace en el panel) se
  anota con su motivo en `ALTA_DESDE_CLAUDE` o en `CAMPANA_FUERA_DE_LA_FICHA`.

Las herramientas del MCP del panel llaman a las mismas operaciones de `gateway/src/admin/servicio.mjs`
que las rutas del panel: un cambio en una operación (qué recibe, qué permisos pide, qué devuelve) se
revisa también en su herramienta y en su descripción, en el mismo PR.

`gateway/test/asistentes.test.mjs` falla si un campo de Empresa, una sección de la campaña o un
faltante para activarla no está en ningún paso, si un paso del alta no dice cómo llega desde Claude,
o si un campo de Empresa o de la campaña no está en la ficha de `alta_cargar`. Al revisar un PR ajeno
que toque esto, hacer lo mismo antes de mergearlo.
