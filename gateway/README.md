# Gateway IMAP/SMTP del SDR BOT

Servicio HTTPS que le da al bot y a los scripts del box de Grok Bot acceso a buzones IMAP/SMTP de cualquier proveedor. Existe porque el box no deja salir SMTP (587/465) ni IMAP (993), y HTTPS sí. El diseño y el plan del piloto están en [`docs/07-gateway-imap.md`](../docs/07-gateway-imap.md).

```
bot de Grok Bot ── MCP (HTTPS, Bearer) ──┐
script del box ─── REST (HTTPS, Bearer) ─┼─► gateway (Vercel) ─┬─ IMAP ─► servidor del cliente
                                         │                     └─ SMTP ─► servidor del cliente
                                         └─ estado: Supabase (esquema mailgw)
```

## Qué hace

| Operación REST (`POST /v1/<op>`) | Tool MCP | Permiso | Qué hace |
|---|---|---|---|
| `mailboxes` (también `GET`) | `buzones` | read | Buzones del cliente con estado, cupo diario y envíos de hoy |
| `check` | `verificar_buzon` | read | Entra por IMAP y valida el usuario en SMTP, sin enviar nada |
| `folders` | `carpetas` | read | Carpetas con uso especial (`\Sent`, `\Drafts`...), mensajes y no leídos |
| `sync` | `sincronizar` | read | Mensajes nuevos desde un cursor `{uidvalidity, last_uid}`; `start: "now"` o `since` para la primera vez |
| `search` | `buscar` | read | Búsqueda por fecha, remitente, asunto, texto, no leídos, no respondidos, palabra clave |
| `read` | `leer_mensaje` | read | Un mensaje completo; `mark_seen` opcional |
| `send` | `enviar` | send | Envío nuevo por el SMTP del buzón, con copia en Enviados |
| `reply` | `responder` | send | Respuesta en el mismo hilo (Re:, In-Reply-To, References), con cita y marca `\Answered` |
| `draft` | `crear_borrador` | draft | Borrador en la carpeta Borradores, para que una persona lo revise y lo mande |
| `flags` | `marcar` | manage | `\Seen`, `\Answered`, `\Flagged` y palabras clave propias (por ejemplo `SDR_procesado`) |
| `move` | `mover` | manage | Mover a otra carpeta existente |
| `create_folder` | `crear_carpeta` | manage | Crear una carpeta |

Cada mensaje vuelve como JSON con `text` (el cuerpo en texto, también si el original era sólo HTML), `reply_text` (lo que escribió quien responde, sin la cita), `in_reply_to` y `references` para cruzar con lo enviado, e `is_auto_reply` e `is_bounce` para separar fuera de oficina y rebotes. Los adjuntos vuelven sólo con nombre, tipo y tamaño.

Respuesta REST: `{"ok": true, "data": ...}` o `{"ok": false, "error": {"code": "...", "message": "..."}}`. Los códigos de error son estables y son lo que el script tiene que mirar:

| Código | HTTP | Qué hacer |
|---|---|---|
| `unauthorized` | 401 | Token ausente, vencido o revocado |
| `forbidden_scope` | 403 | El token no tiene ese permiso |
| `invalid_request` | 400 | Argumentos inválidos; el mensaje dice cuáles |
| `mailbox_not_found`, `folder_not_found`, `message_not_found` | 404 | No existe para este cliente |
| `mailbox_paused`, `mailbox_blocked` | 423 | Pausado por un operador, o bloqueado tras tres contraseñas rechazadas |
| `mail_auth_failed` | 502 | El servidor del cliente rechazó la contraseña (suma al bloqueo) |
| `mail_server_unreachable`, `mail_server_error` | 504/502 | Problema de red o del servidor del cliente; reintentar más tarde |
| `cap_reached` | 429 | Se llegó al cupo diario del buzón |
| `send_in_progress` | 409 | Esa clave de idempotencia tiene un envío en curso o cortado; ver "Envíos cortados" |
| `recipients_rejected` | 422 | El SMTP rechazó todos los destinatarios; no consume cupo |
| `not_allowed` | 422 | Algo que el gateway no hace a propósito: borrar, mover a la papelera, más de 10 destinatarios |

## Salvaguardas

- **Idempotencia.** Todo envío lleva `idempotency_key`. Un reintento con la misma clave devuelve el resultado anterior y no manda otro mail, también si los dos pedidos llegan a la vez.
- **Cupo diario por buzón** (`daily_send_cap`, en la zona del buzón), contado en la base de forma atómica. Un envío que el SMTP rechaza no consume cupo.
- **Bloqueo por contraseña rechazada.** Tres fallas seguidas pasan el buzón a `auth_error` y el gateway deja de intentar, para no disparar el bloqueo por intentos fallidos de los hostings (cPanel/cPHulk, fail2ban). Lo reactiva un operador.
- **Nada se borra.** Ni `\Deleted` ni mover a la papelera: borrar lo hace una persona.
- **Máximo 10 destinatarios** por envío: es para mails uno a uno.
- **Contraseñas cifradas** con AES-256-GCM. La clave vive sólo en la variable de entorno `MAILGW_ENC_KEYS` de Vercel; la base guarda el texto cifrado, atado a su buzón. Un volcado de la base sola no expone contraseñas.
- **Tokens con hash** (sha256) y permisos `read`, `draft`, `send` y `manage`. No hay endpoints de administración: el alta se hace con la CLI.
- **Auditoría** por operación (`mailgw.audit_log`): quién, qué buzón, resultado y conteos, sin contenido de mensajes.

## Desplegar

Requisitos: un proyecto de Supabase (el de la base de control del SDR BOT) y un proyecto de Vercel.

1. **Base.** En el proyecto de Supabase, tomar la cadena de conexión del pooler (modo transacción, puerto 6543) y correr las migraciones desde una máquina de operador:

   ```bash
   cd gateway && npm ci
   export DATABASE_URL='postgres://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres'
   export MAILGW_ENC_KEYS="k1:$(openssl rand -base64 32)"   # guardar este valor: es la llave de las contraseñas
   node bin/admin.mjs migrate
   ```

2. **Vercel.** Proyecto nuevo desde el repo `sdrbot` con **Root Directory = `gateway`** (sin framework). Variables de entorno de producción: `MAILGW_ENC_KEYS` (la misma de arriba) y la conexión a la base: si se conecta el proyecto de Supabase desde Storage de Vercel, la integración carga `POSTGRES_URL` sola y el gateway la usa; si no, `DATABASE_URL`. Dominio sugerido: `mail.bigua.lat`.

3. **Verificar:** `curl https://mail.bigua.lat/health` devuelve `{"ok":true,...}`.

## Alta de un cliente y sus buzones

Con `DATABASE_URL` y `MAILGW_ENC_KEYS` en el entorno:

```bash
node bin/admin.mjs add-client piloto "Cliente piloto"

# La contraseña se pide sin mostrarla (o se pasa por stdin). Nunca por argumento.
node bin/admin.mjs add-account piloto ventas@cliente.com \
  --imap-host mail.cliente.com --imap-port 993 --imap-security tls \
  --smtp-host mail.cliente.com --smtp-port 465 --smtp-security tls \
  --display-name "Ana Pérez" --daily-cap 30

node bin/admin.mjs check piloto ventas@cliente.com      # prueba IMAP y SMTP y lista carpetas

# Token para la cuenta de Grok Bot del cliente. Se muestra una sola vez.
node bin/admin.mjs add-token piloto "grokbot piloto" --scopes read,draft,manage --days 120
```

Con STARTTLS: `--imap-port 143 --imap-security starttls --smtp-port 587 --smtp-security starttls`. Si el servidor ya guarda una copia de lo enviado, `--no-append-sent`. Si las carpetas no son las estándar, `--sent-folder` y `--drafts-folder`.

Otros comandos: `list`, `list-tokens`, `revoke-token`, `set-password` (también reactiva), `pause`, `reactivate`, `clear-send`, `rekey`. `node bin/admin.mjs` sin argumentos los lista.

## Conectar Grok Bot

- **Bots (MCP):** agregar un MCP remoto con URL `https://mail.bigua.lat/mcp` y cabecera fija `Authorization: Bearer <token>`. Lista sólo las tools que el token puede usar.
- **Scripts del box (REST):** secretos `MAILGW_URL=https://mail.bigua.lat` y `MAILGW_TOKEN=<token>`, y el cliente `clients/python/mailgw.py` (sólo biblioteca estándar):

  ```bash
  python3 clients/python/mailgw.py search --json '{"mailbox":"ventas@cliente.com","not_keyword":"SDR_procesado","since":"2026-11-10"}'
  ```

  Sale con código 0 si funcionó, 3 si el gateway devolvió un error con código y 4 si no se pudo hablar con él.

## Envíos cortados

Un envío reserva su clave antes de hablar con el SMTP. Si la función se corta entre la reserva y la respuesta del SMTP (raro: un timeout de Vercel), la clave queda en `send_in_progress` para no duplicar, porque el mail pudo haber salido. Un operador mira la carpeta Enviados del buzón: si no está, libera la clave con `clear-send <cliente> <email> <clave>` y el reintento vuelve a enviar.

## Rotar la llave de cifrado

Anteponer una llave nueva en `MAILGW_ENC_KEYS` (`k2:<nueva>,k1:<vieja>`) en Vercel y en la máquina del operador, correr `node bin/admin.mjs rekey`, y después sacar `k1`.

## Pruebas

```bash
npm test
```

Levanta un Dovecot real con TLS y STARTTLS, Postgres local y servidores SMTP de prueba con certificados de una CA propia, y corre 29 pruebas de punta a punta: lectura, cursores, búsqueda, envío, respuesta en hilo, borradores, marcas, carpetas, cupo, idempotencia con pedidos simultáneos, bloqueo por contraseña, aislamiento entre clientes, permisos, MCP, CLI, cifrado y rotación de llave, y el cliente Python. Requiere `dovecot-imapd`, `openssl` y Postgres 16 local, y correr como root (ver `test/run.sh`).

## Límites de la versión 0.1

- Sin IMAP IDLE: el gateway no avisa cuando llega un mail; se consulta cada 15 minutos.
- Cada llamada tiene que terminar en 60 segundos (Vercel): por eso `sync` trae hasta 25 mensajes por defecto y 100 como máximo.
- No descarga ni envía adjuntos.
- Las copias ocultas (bcc) no quedan en un borrador.
- La salida de Vercel no tiene IP fija: un servidor de correo que sólo acepta IPs de una lista no va a dejar entrar al gateway (ver `docs/07` §7).
