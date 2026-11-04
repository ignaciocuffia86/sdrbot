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
