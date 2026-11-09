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
- **Tokens con hash** (sha256) y permisos `read`, `draft`, `send` y `manage`.
- **Servidores de correo permitidos.** El gateway resuelve el servidor una vez, se conecta a esa IP (con el nombre como SNI para el certificado) y rechaza direcciones internas, de loopback, link-local y reservadas, y puertos que no sean de correo (25, 143, 465, 587, 993, 2525). Sin esto, el botón "Probar" del panel serviría para que el gateway abra conexiones a la red interna de Vercel.
- **Webhooks salientes (despertadores).** La URL va sólo por `https`, al puerto 443 y a un dominio público, sin usuario ni contraseña. El nombre se controla al cargarla y otra vez al conectar, y no se siguen redirecciones (`src/mail/net.mjs`).
- **Aislamiento entre clientes en la base**, no sólo en el código. Cada pedido corre en una transacción con el rol `mailgw_app` (sin `BYPASSRLS`, sin ser dueño de nada) y con el cliente del token fijado; las políticas de cada tabla dejan ver y escribir sólo las filas de ese cliente. Todas las tablas llevan `client_id`, y un envío no puede quedar a nombre de un buzón de otro cliente (clave foránea compuesta). Los tokens no se leen directo: `mailgw.autenticar(hash)` devuelve el cliente. Lo prueba `test/aislamiento.test.mjs` contra la base, sin pasar por el gateway.
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

2. **Vercel.** Proyecto nuevo desde el repo `sdrbot` con **Root Directory = `gateway`** (sin framework). Variables de entorno de producción: `MAILGW_ENC_KEYS` (la misma de arriba) y la conexión a la base: si se conecta el proyecto de Supabase desde Storage de Vercel, la integración carga `POSTGRES_URL` sola y el gateway la usa; si no, `DATABASE_URL`. Dominio: `sdrbot.bigua.lat`.

3. **Verificar:** `curl https://sdrbot.bigua.lat/health` devuelve `{"ok":true,...}`.

Desplegado el 04/11/2026 como proyecto `sdrbot-mail-gateway` de Vercel, en `https://sdrbot.bigua.lat`, región `gru1`, Node 22.

## Panel web: `https://sdrbot.bigua.lat/admin`

Donde se cargan clientes, buzones (servidor y puerto IMAP y SMTP, seguridad, usuario, contraseña, tope diario, zona horaria, carpetas), usuarios y tokens de Grok Bot.

| Rol | Ve y hace |
|---|---|
| `bigua_admin` (operador de Biguá) | Todos los clientes. Alta de clientes, buzones, usuarios de cada cliente, operadores de Biguá y tokens de Grok Bot; borrar buzones |
| `client_admin` (usuario de un cliente) | Sólo su cliente: alta y edición de buzones, contraseña, probar conexión, pausar y reactivar, y la actividad. No ve usuarios ni tokens; otro cliente le responde 404 |

- **Sin contraseñas por mail.** Un usuario nuevo recibe un enlace de activación (`/admin#activar=…`, 24 h, un solo uso) y elige su contraseña (mínimo 12 caracteres). El mismo mecanismo sirve para "olvidé mi contraseña": el operador genera un enlace nuevo, y la contraseña anterior deja de servir recién cuando se usa.
- **Contraseñas del panel** con scrypt. Cinco intentos fallidos bloquean la cuenta 15 minutos.
- **Sesiones** en la base (`mailgw.admin_session`, sólo el hash): cookie `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/admin`; vencen a las 12 horas o tras 2 horas sin uso. Desactivar un usuario corta sus sesiones.
- **CSRF:** además de `SameSite=Strict`, toda llamada a `/admin/api` exige la cabecera `X-Mailgw-Admin: 1` y un `Origin` igual al host.
- **Aislamiento en la base también para el panel.** Lo que hace un `client_admin` corre con el rol `mailgw_portal` y su cliente fijado, con políticas por cliente; ese rol no puede leer tokens, usuarios ni sesiones (`test/admin.test.mjs`).
- **La contraseña de un buzón nunca vuelve** al navegador: entra, se cifra y sólo se reemplaza. Los tokens se muestran una vez.
- **CSP estricta** (`default-src 'none'`, scripts y estilos sólo propios, sin marcos), sin dependencias de terceros. Todo lo que viene del servidor se inserta como texto.
- **Auditoría:** cada acción del panel queda en `mailgw.audit_log` con `actor_user_id`.

### La ficha de un cliente

Diseño en `docs/21-panel-canales-y-campanas.md` (etapas A y B, migración `010`):

| Pestaña | Qué tiene | Quién |
|---|---|---|
| **Resumen** | Lo que necesita atención (buzones bloqueados, dominio mal, aprobaciones y respuestas que esperan, Dripify con error, despertadores y corridas con error), los números de los últimos 7 días, la calibración y el estado de cada canal (`GET /clients/:id/resumen`) | Los dos roles; despertadores y corridas, sólo Biguá |
| **Empresa** | Los ajustes que leen los bots, en bloques (identidad y voz, a quién y con qué señal, conversación, operación), la vista previa, la lista de **no contactar** y el historial | Los dos roles |
| **Canales** | Correo (buzones, con su firma, y dominios), LinkedIn · Dripify, y WhatsApp y CRM como próximamente | Los dos roles; Dripify lo carga Biguá |
| **Actividad** | El monitor: a la izquierda los canales con su modo (supervisado o autónomo); a la derecha lo que pasó hoy, en orden, con su estado (`GET /clients/:id/monitor`, se actualiza cada 30 s). Debajo, la auditoría completa (`docs/22`) | Los dos roles |
| **⚙ Administración** | Operación (activar el SDR, canal de reglas, zona horaria, calibración, bots activos, modo de operación y tope), bots y despertadores, usuarios y tokens | Sólo Biguá |

Las direcciones viejas (`#/c/<id>/sdr`, `/buzones`, `/dominios`, `/usuarios`, `/tokens`) llevan a su lugar nuevo.

### Campañas (etapa C1, en construcción)

Migración `012_campanas` (`docs/21` §4.6 y §6.2): `sdr.campana` y `sdr.campana_buzon`. Cada cliente tiene su campaña «principal», creada con sus ajustes de hoy. Todo el registro (`cuenta`, `prospecto`, `evento`, `pedido`, `aprobacion` y `dripify_carga`) lleva `campana_id`. Mientras el código no lo mande, un disparador lo completa con la «principal». Los campos de Empresa y de campaña, con sus permisos, los estados, el tope y la herencia, están en `src/sdr/ajustes.mjs`.

La API del panel (`src/sdr/campanas.mjs`) es la misma para los dos roles; qué puede tocar cada uno lo decide el modo del cliente (`docs/21` §6.2, decisión 13):

| Ruta | Qué hace |
|---|---|
| `GET /clients/:id/sdr/campanas` | Las campañas con estado, buzones, volumen, personas, respuestas y pendientes para activar; el modo, el tope y cuántas cuentas por día suman las activas |
| `POST /clients/:id/sdr/campanas` | Crea una campaña en borrador (`nombre`, `tipo`, columnas y `ajustes`). Los dos roles, en los dos modos |
| `GET /clients/:id/sdr/campanas/:campana` | La campaña, sus campos y columnas con `editable`, lo que hereda de Empresa, los ajustes efectivos, lo que falta para activarla, los buzones del cliente y el historial |
| `PUT /clients/:id/sdr/campanas/:campana` | Cambia columnas y `ajustes` (y `nota`). Activar exige que no falte nada y que la suma de las activas no pase el tope. Una campaña activa no puede quedar con pendientes nuevos. Una terminada no se edita |
| `POST /clients/:id/sdr/campanas/:campana/duplicar` | Copia en borrador: ajustes, buzones, tipo y volumen. No copia las fechas ni la campaña de Dripify |

Cada cambio queda en `sdr.ajustes_historial` (con `campana_id`) y en la auditoría. Si lo hizo el cliente, el orquestador recibe un pedido para contárselo al operador.

**Pestaña Campañas** (entre Resumen y Empresa):
- **Lista:** estado, buzones, volumen, personas, respuestas y pendientes. Muestra cuánto suman las activas contra el tope y tiene el botón **Nueva campaña**, que crea un borrador con nombre y tipo.
- **Editor:** las secciones de `docs/21` §3.2, plegables y con un resumen de una línea cada una.
  - Lo que se hereda de Empresa se ve como «De Empresa: …», con **Cambiar para esta campaña** y **Usar lo de Empresa**.
  - Los casos se eligen de la biblioteca de Empresa.
  - Botones **Activar** (sólo sin pendientes), **Pausar**, **Terminar** y **Duplicar**.
  - Al costado, lo que falta para activar y «Así la van a leer los bots». Abajo, el historial.

Las herramientas MCP reciben `campana` (la clave, opcional) y el gateway hace cumplir cada campaña (`src/sdr/en_campana.mjs`, `docs/21` §7.2):
- **Campaña que no está activa:** no salen mails nuevos, no se carga a nadie en LinkedIn y no se toman cuentas ni personas nuevas (`campana_inactiva`).
- **Mails nuevos:** salen sólo por los buzones de la campaña (`buzon_fuera_de_campana`) y con sus links permitidos (`link_no_permitido`).
- **Personas y cuentas:** una persona está en una sola campaña activa, y una cuenta en contacto no entra en otra de prospección (`en_otra_campana`).
- **Calibración:** se cuenta por campaña.
- **Buzones nuevos:** entran solos en la «principal» (migración `013`).

Las reglas todavía no leen la campaña: los bots siguen escribiendo con los ajustes de Empresa. Por eso la pestaña la ve **sólo Biguá**, con un aviso de transición (`CAMPANAS_PARA_CLIENTES` en `static/app.js`). Se abre a los clientes cuando las reglas lean la campaña. La API ya responde a los dos roles.

Lo prueban:
- `test/campanas.test.mjs`: la base.
- `test/ajustes.test.mjs`: los ajustes.
- `test/campanas_panel.test.mjs`: la API.

### SDR: ajustes del cliente

La pestaña **Empresa** edita lo que los bots leen como «Ajustes de este cliente» (migraciones `007_ajustes_en_el_panel` y `010`):

- **El usuario del cliente** cambia oferta, tono, idioma, firma por defecto, casos que se pueden citar, ICP, cargos, exclusiones, qué le pedimos al prospecto, objeciones, qué cuenta como positivo, quién toma a los interesados y el link de agenda (sólo `https://`). Ve lo demás sin poder tocarlo (con un candado). Al guardar, el orquestador recibe un pedido para contarle el cambio al operador en el chat.
- **Un operador de Biguá** además cambia la señal en los avisos y, si el cliente es **operado**, la antigüedad del aviso, las cuentas por día, los buzones a usar y si se aceptan mails extrapolados. Si el cliente es **autogestionado** (`sdr.cliente_config.modo`, en Administración), esos cuatro los cambia el cliente, con las cuentas por día hasta el tope que fija Biguá (`tope_cuentas_dia`).
- **Firma por buzón** (`mailgw.account.firma`, Canales → Correo → Editar): los bots la ven en `buzones` y en la sección «Buzones y firmas» de sus ajustes; vacía, usan la firma por defecto.
- **No contactar** (`sdr.no_contactar`): dominios (con sus subdominios) y mails, uno por uno, pegados o por CSV (primera columna el dominio o el mail, segunda el motivo; hasta 5000 filas por carga). La cargan el cliente o Biguá; los bots sólo la leen. El gateway la hace cumplir: una cuenta de la lista queda `excluida` al guardarla, y una persona nueva, un mail (`enviar` o `responder`) o una carga en Dripify se rechazan con `no_contactar`.
- Se valida al guardar (largo, renglones, campos que existen) y se ve cómo lo van a leer los bots.
- Cada cambio queda en el historial con quién y cuándo, y se puede volver a una versión anterior.
- En la base, el rol del portal sólo puede actualizar los ajustes de su cliente: ni la calibración ni nada del registro.
- **LinkedIn · Dripify** (Canales, sólo Biguá): API key (cifrada, no vuelve), id de la campaña esqueleto, largo máximo de la nota, **Probar** (campaña activa, campos, números, cupo) y **Generar URL del webhook** (se muestra una vez).
- **Despertadores** (Administración → Bots y despertadores, sólo Biguá): el de `seguimiento` (webhook de «SDR · respuestas», avisa el correo nuevo) y el del `orquestador` (webhook de «SDR · aprobaciones», avisa las aprobaciones pendientes, primero las de un positivo; migración `008`). Con URL, clave, horario, días y minutos entre avisos. La clave se guarda cifrada y no se vuelve a mostrar; vacía, se conserva la guardada. Es lo mismo que `sdr-despertador` de la CLI.

### Dominios: SPF, DKIM, DMARC y MX

Pestaña «Canales», debajo de los buzones (la ven los dos roles). Los dominios salen de los buzones; «Verificar» consulta el DNS y guarda el resultado en `mailgw.domain_check` (migración `004_dominios`). No cambia nada en el DNS del cliente.

| | Qué mira |
|---|---|
| SPF | Que haya uno solo; que termine en `~all` o `-all` (`+all` es error); las consultas DNS de todo el árbol de `include` y `redirect` contra el límite de 10; include rotos; y si autoriza la IP del servidor SMTP del buzón (evaluación de RFC 7208 sin macros) |
| DKIM | Los selectores no se pueden listar por DNS, así que prueba tres fuentes: el selector real, sacado de la cabecera `DKIM-Signature` de los últimos mails del propio dominio en la bandeja y en enviados (sólo lectura, hasta dos buzones); los que cargue el cliente; y 20 habituales. Por cada clave: revocada, ilegible, RSA menor a 1024 (error) o a 2048 (aviso). Avisa si los mails los firma otro dominio (no cuenta para DMARC) |
| DMARC | Que exista (si no, el del dominio padre), uno solo, con política válida; `p=none` es aviso; sin `rua` es aviso; `pct` menor a 100 |
| MX | Que el dominio reciba correo: si no, las respuestas de los prospectos no llegan |

Un DNS que no responde da aviso de reintentar, nunca "no configurado".

Cada aviso y cada error trae «Cómo arreglarlo» (`src/dns/hints.mjs`): los pasos, y cuando el arreglo se puede calcular, el registro exacto a publicar (tipo, nombre y valor listo para copiar): el SPF con el `~all` agregado, dos SPF unificados en uno, la IP o el include del SMTP sumados antes del `all`, el DMARC inicial, el DMARC con `p=quarantine` conservando sus etiquetas. Lo que depende del proveedor de correo (activar DKIM, el include de SPF, los MX) sale con los pasos de ese proveedor, detectado por MX y SMTP: Google Workspace, Microsoft 365, Zoho o hosting con cPanel/Plesk, con el enlace a su guía. Si el buzón manda por Microsoft 365 o Google y el SPF incluye su include, no se marca la IP del SMTP como no autorizada: esos proveedores reciben en un servidor y entregan desde otros.

El primer operador se crea con la CLI, que imprime su enlace de activación:

```bash
node bin/admin.mjs add-admin operador@bigua.lat "Nombre"                    # operador de Biguá
node bin/admin.mjs add-admin admin@cliente.com "Nombre" --client bairesqa   # usuario de un cliente
```

Para probar el panel en local por HTTP, `MAILGW_INSECURE_COOKIES=1` saca el `Secure` de la cookie.

## Alta por línea de comandos

Lo mismo que el panel, desde la máquina de un operador con `DATABASE_URL` y `MAILGW_ENC_KEYS` en el entorno:

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

Otros comandos: `list`, `list-tokens`, `revoke-token`, `set-password` (también reactiva), `pause`, `reactivate`, `clear-send`, `rekey`, `add-admin`. `node bin/admin.mjs` sin argumentos los lista.

## Conectar Grok Bot

- **Bots (MCP):** agregar un MCP remoto con URL `https://sdrbot.bigua.lat/mcp` y cabecera fija `Authorization: Bearer <token>`. Lista sólo las tools que el token puede usar.
- **Scripts del box (REST):** secretos `MAILGW_URL=https://sdrbot.bigua.lat` y `MAILGW_TOKEN=<token>`, y el cliente `clients/python/mailgw.py` (sólo biblioteca estándar):

  ```bash
  python3 clients/python/mailgw.py search --json '{"mailbox":"ventas@cliente.com","not_keyword":"SDR_procesado","since":"2026-11-10"}'
  ```

  Sale con código 0 si funcionó, 3 si el gateway devolvió un error con código y 4 si no se pudo hablar con él.

## Núcleo SDR (etapas 1 a 3 de `docs/09`)

Con el permiso `sdr`, el mismo token y el mismo MCP suman 29 herramientas para los bots de Grok (`src/sdr/`, migraciones `005_sdr_nucleo`, `006_memoria_del_correo` y `009_dripify`):

| Grupo | Herramientas | Qué hacen |
|---|---|---|
| Reglas | `reglas_manual`, `reglas_alta` | Las reglas de operación de cada bot y tarea (índice y secciones), iguales para todos los clientes más los ajustes del cliente; las routines a crear en la cuenta de Grok |
| Registro | `registro_buscar`, `registro_guardar_cuenta`, `registro_guardar_prospecto`, `registro_evento`, `registro_agenda`, `registro_historia`, `registro_resumen` | La memoria de la prospección: cuentas, personas, línea de tiempo con tipos fijos, agenda del día y números |
| Pedidos | `registro_pedir`, `registro_pendientes`, `registro_resolver_pedido` | Pedidos entre bots; el mensaje de Grok sólo despierta. Tope de tres idas y vueltas, después al orquestador |
| Aprobaciones | `registro_pedir_aprobacion`, `registro_aprobaciones`, `registro_aprobar` | Aprobaciones como datos. El gateway las exige |
| Correo | `correo_revisar`, `correo_atendido`, `correo_sin_respuesta` | Lo que llegó, ya atado a su envío y a su prospecto; marcarlo atendido; quién no respondió hace N días |
| LinkedIn | `dripify_estado`, `dripify_cargar`, `dripify_conversacion`, `dripify_responder`, `dripify_frenar`, `dripify_reanudar`, `linkedin_revisar`, `linkedin_atendido` | La campaña esqueleto de Dripify del cliente: cargar personas con sus tres textos, leer y contestar la conversación, frenar o reanudar la secuencia, y las respuestas que esperan (`docs/20`) |
| Bitácora | `bitacora_inicio`, `bitacora_fin` | Cada corrida anota inicio y fin |
| Pruebas | `prueba_carga` | Devuelve N KB después de N segundos, para medir el MCP en Grok |

Lo que el gateway hace cumplir:

- **Calibración:** mientras un cliente no haya mandado `calibracion_mails` mails aprobados (20 por defecto), `enviar` exige `aprobacion_id` de una aprobación con **exactamente** ese buzón, destinatario, asunto y texto (espacios aparte). Una aprobación se usa una vez; un reintento con la misma clave de idempotencia devuelve el envío anterior.
- **Respuesta a un positivo:** `responder` con `prospecto_id` de un prospecto en estado `positivo` exige una aprobación de tipo `respuesta_positivo` con ese texto.
- **Registro automático:** `enviar` y `responder` con `prospecto_id` dejan el evento `mail.enviado` y actualizan al prospecto.
- **URLs de LinkedIn** normalizadas a `https://www.linkedin.com/in/<slug>`; las cortadas se rechazan.
- **Supresión:** nada sale a una dirección que rebotó o pidió la baja (`destinatario_suprimido`), desde ningún buzón del cliente.
- **LinkedIn:** `dripify_cargar` rechaza la tanda entera si alguien no tiene LinkedIn, ya respondió, está cerrado o suprimido, ya estaba cargado, tiene una respuesta sin atender o textos con marcadores o demasiado largos; en calibración exige la aprobación del primer contacto con esos mismos textos (`contenido.linkedin`). `dripify_responder` a un positivo exige `respuesta_positivo` con `canal: "linkedin"`. Cupo propio de 50 pedidos por minuto y 4500 por día a Dripify por cliente.
- **Freno cruzado:** una respuesta por mail o una baja saca a la persona de la campaña de LinkedIn (lista negra de Dripify, desde el reloj); una respuesta por LinkedIn la deja en `respondio` y ya no salen mails de la secuencia.
- **Quien respondió es de `seguimiento`:** `enviar` (un mail nuevo de la secuencia) se rechaza si la persona tiene una respuesta sin atender (`respuesta_sin_atender`) o ya respondió, es positivo, dijo que no, derivó o está en el CRM (`prospecto_respondio`). Se la encuentra por `prospecto_id` o por el destinatario. `responder` en el hilo sí se puede.

### Memoria del correo (etapa 2)

El gateway lee el INBOX de cada buzón con un cursor propio (`sdr.buzon_cursor`; la primera vez, los últimos 7 días) y, sin LLM, ata cada mensaje:

1. por el hilo: `In-Reply-To` / `References` (o el `Message-ID` del original que rebotó) contra lo que mandó el gateway;
2. por la dirección: el remitente, o el destinatario que falló, es un prospecto;
3. por el dominio: alguien de una cuenta que estamos trabajando escribió desde otra dirección (`de_cuenta`).

Clasifica en `respuesta`, `automatica` (fuera de oficina: `Auto-Submitted` y cabeceras de Exchange), `rebote` / `rebote_temporal` (informe de entrega RFC 3464 o remitente de sistema; definitivo si el estado es 5.x.x), `baja` (asunto o texto «BAJA», como el `List-Unsubscribe` del gateway) y `de_cuenta`. Lo que no se relaciona con la prospección no se guarda. Registra solo la respuesta, el rebote o la baja en la línea de tiempo, carga la supresión y deja el resto (qué contestar, si es positivo) para el bot, con `correo_revisar`.

**El reloj.** `POST /cron/correo` (con el secreto del reloj; en Supabase lo llama `pg_cron` cada 5 minutos, ver `db/supabase/reloj.sql`) lee los buzones de los clientes que tienen `seguimiento` en `bots_activos` y, si hay correo nuevo, **despierta** al bot por el webhook de su routine (`sdr.despertador`): un aviso con la lista, como mucho uno cada 10 minutos, dentro del horario del cliente; si el webhook falla, reintenta en el próximo tick con espera creciente; lo avisado y no atendido se vuelve a avisar después de 90 minutos, hasta tres veces.

```bash
node bin/admin.mjs sdr-despertador bairesqa seguimiento --url https://…   # la clave del webhook, por stdin
node bin/admin.mjs sdr-despertador bairesqa seguimiento --apagar
node bin/admin.mjs reloj-tick                                              # una vuelta a mano
```

### LinkedIn por Dripify (etapa 3)

Una campaña esqueleto por cliente (invitación con nota, mensaje 1, mensaje 2) cuyo texto son los campos personalizados `sdr_nota`, `sdr_mensaje1` y `sdr_mensaje2`; el bot los escribe por persona y `dripify_cargar` los sube con la Open API de Dripify (`https://api.dripify.com`, `X-Api-Key`; `MAILGW_DRIPIFY_URL` la reemplaza en las pruebas). Lo que pasa vuelve por el webhook de la campaña, `POST /hook/dripify/<cliente>/<secreto>?e=invitacion|conexion|mensaje|respuesta` (el secreto va en la URL porque Dripify no deja poner cabeceras; en la base, su hash; el cuerpo se guarda crudo en `sdr.dripify_evento`), y por la lectura de las conversaciones abiertas que hace el reloj, porque el webhook de respuesta sólo llega con la primera. La API key, la campaña y el webhook se cargan en el panel (pestaña Canales, sólo Biguá). Detalle y alta: `docs/20-etapa-3-linkedin-dripify.md`.

### WhatsApp de seguimiento (etapa 5)

El bot `whatsapp` manda por WhatsApp Web en el navegador de su asiento de Grok; el gateway no toca WhatsApp, pero da el turno de cada mensaje (`whatsapp_turno`) y lo registra (`whatsapp_resultado`). En el turno hace cumplir horario del cliente, pausa al azar entre envíos (compartida por todos los chats), topes por persona y por día, sólo contactos tibios, nada repetido en 24 horas, la aprobación del primer mensaje a cada persona y, ante un bloqueo, la pausa de todo el canal con aviso al orquestador (migración `011`: `sdr.whatsapp_config`, `sdr.whatsapp_envio`). Las reglas las carga Biguá en el panel (Canales → WhatsApp) y sólo Biguá reanuda una pausa. Detalle: `docs/22-whatsapp-y-monitor.md`.

Un cliente sin configuración del SDR (`sdr.cliente_config`) usa el gateway como antes, sin calibración.

**Reglas (playbooks).** Viven en `playbooks/` (raíz del repo): `comun.md`, `rutina.md` (prompt de las routines), `rutinas.json` y una carpeta por bot (`_bot.md` y una por tarea). Cada `## Título` es una sección; la línea `> …` que la sigue es su resumen. Se publican como versiones inmutables y cada cliente sigue el canal `estable` o `canario`, o una versión fija:

```bash
node bin/admin.mjs playbooks-publicar --version 2026.11.05-1 --canal canario   # con DATABASE_URL
node bin/admin.mjs playbooks-canal estable 2026.11.05-1
node bin/admin.mjs playbooks-sql --version 2026.11.05-1 --canal canario > pub.sql   # sin conexión: SQL para el MCP de Supabase
node bin/admin.mjs sdr-config bairesqa < bairesqa.json                          # ajustes, bots activos, calibración
```

Publicado en producción: `2026.11.05-6` en estable, con LinkedIn por Dripify y el prospector sobre `avisos_recientes` de ASCI; `2026.11.09-2` en canario (09/11). Es la `2026.11.09-1` (etapas A y B del panel y el bot `whatsapp`) más dos correcciones de seguridad: los ajustes del cliente son datos y no instrucciones (`comun.md`), y WhatsApp busca con el número completo y no atribuye un chat ambiguo (`whatsapp/pasada.md`). La migración `012_campanas` está aplicada desde el 09/11. La guía de alta de un cliente y las pruebas en Grok están en `docs/13-etapa-1-y-pruebas.md`; lo de la etapa 2, en `docs/14-etapa-2-memoria-del-correo.md`.

## Envíos cortados

Un envío reserva su clave antes de hablar con el SMTP. Si la función se corta entre la reserva y la respuesta del SMTP (raro: un timeout de Vercel), la clave queda en `send_in_progress` para no duplicar, porque el mail pudo haber salido. Un operador mira la carpeta Enviados del buzón: si no está, libera la clave con `clear-send <cliente> <email> <clave>` y el reintento vuelve a enviar.

## Rotar la llave de cifrado

Anteponer una llave nueva en `MAILGW_ENC_KEYS` (`k2:<nueva>,k1:<vieja>`) en Vercel y en la máquina del operador, correr `node bin/admin.mjs rekey` (recifra las contraseñas de los buzones, las claves de los webhooks del despertador y las API keys de Dripify), y después sacar `k1`.

## Pruebas

```bash
npm test
```

Levanta un Dovecot real con TLS y STARTTLS, Postgres local y servidores SMTP de prueba con certificados de una CA propia, y corre 112 pruebas de punta a punta: lectura, cursores, búsqueda, envío, respuesta en hilo, borradores, marcas, carpetas, cupo, idempotencia con pedidos simultáneos, bloqueo por contraseña, aislamiento entre clientes (también directo contra la base, con el rol de la aplicación), permisos, MCP, CLI, cifrado y rotación de llave, el cliente Python, el panel `/admin` (ajustes del SDR por cliente con historial, activación, bloqueo, CSRF, roles y aislamiento entre clientes, buzones probados contra el Dovecot), la protección contra SSRF, el chequeo de dominios (contra un DNS armado, y el selector DKIM detectado en un buzón del Dovecot) y el núcleo SDR (reglas publicadas por la CLI, registro aislado por cliente también en la base, pedidos con escalado, calibración y respuesta a positivos exigidas en el envío real) la memoria del correo (respuestas, rebotes, fuera de oficina y bajas sembrados en el Dovecot, supresión al enviar, despertador y reloj) y LinkedIn contra un Dripify simulado según su Open API (carga con calibración, webhook, conversación, respuesta con aprobación, freno cruzado, cupo y errores). Requiere `dovecot-imapd`, `openssl` y Postgres 16 local, y correr como root (ver `test/run.sh`). La base de prueba tiene un dueño sin superusuario, como `postgres` en Supabase, para que los permisos del rol de la aplicación se prueben de verdad.

## Límites de la versión 0.1

- Sólo IMAP/SMTP con contraseña. Microsoft 365 y Google Workspace (OAuth, Graph y Gmail API) están en `docs/08-roadmap-proveedores.md`; mientras tanto, Gmail funciona con contraseña de aplicación (§5.1 de ese documento, con «Guardar copia de lo enviado» desactivado).

- Sin IMAP IDLE: el gateway no avisa cuando llega un mail; se consulta cada 15 minutos.
- Cada llamada tiene que terminar en 60 segundos (Vercel): por eso `sync` trae hasta 25 mensajes por defecto y 100 como máximo.
- No descarga ni envía adjuntos.
- Las copias ocultas (bcc) no quedan en un borrador.
- La salida de Vercel no tiene IP fija: un servidor de correo que sólo acepta IPs de una lista no va a dejar entrar al gateway (ver `docs/07` §7).
