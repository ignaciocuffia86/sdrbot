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
- a `docs/29-asistentes-alta-y-campana.md`.

`gateway/test/asistentes.test.mjs` falla si un campo de Empresa, una sección de la campaña o un
faltante para activarla no está en ningún paso. Al revisar un PR ajeno que toque esto, hacer lo
mismo antes de mergearlo.
