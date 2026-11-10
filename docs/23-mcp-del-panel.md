# MCP del panel: gestionar el SDR desde Claude

Estado al 10/11/2026: **diseño**, con la etapa M0 hecha (§9). Se apoya en el panel `/admin` (`15`, `16`, `21`)
y en el MCP de los bots (`07`, `09`, `13`). El OAuth sale del de ASCI (repo `locasci`, `docs/32-oauth-chatgpt.md`).

**Qué se busca.** Que una persona se conecte desde Claude (claude.ai, Claude Desktop o Claude Code)
y gestione su SDR conversando: ver cómo va, revisar y aprobar mensajes, armar y ajustar campañas,
cargar a quién no contactar. Un usuario de un cliente ve **sólo su cliente**. Un operador de
Biguá ve y gestiona **todos**.

**Decisión del 10/11:** el cliente **puede aprobar sus mensajes** (§5), desde Claude y desde el
panel web.

## 1. Lo que hay hoy

| Pieza | Para quién | Cómo entra | Qué puede hacer |
|---|---|---|---|
| MCP de los bots (`/mcp`, `src/mcp.mjs`) | Los bots de Grok | Token `mgw_…` de **un cliente**, con permisos `read`, `draft`, `send`, `manage` y `sdr` | Correo, registro de prospección, pedidos entre bots, aprobaciones (pedir, listar y registrar lo que dijo el operador), Dripify, WhatsApp y bitácora |
| Panel `/admin` (`src/admin/api.mjs`) | Personas | Usuario y contraseña, sesión por cookie de 12 h | Todo lo de gestión: clientes, usuarios, tokens, buzones, dominios, ajustes, campañas, no contactar, monitor y resumen |

El aislamiento entre clientes ya está resuelto y no cambia. El panel corre lo de un
`client_admin` con el rol `mailgw_portal` y su cliente fijado, mediante `scoped()`. Los bots
corren con `mailgw_app` y el cliente del token. En los dos casos, las políticas por cliente de la
base se cumplen aunque falle una consulta (`test/aislamiento.test.mjs`).

**Por qué no alcanza con darle al cliente un token de bot:**

1. Las herramientas están escritas para bots. Piden `bot`, `tarea` y `corrida`, y
   `registro_aprobar` dice que se use sólo con lo que el operador de Biguá escribió en el chat.
2. Un token es del cliente, no de una persona: la auditoría no sabría quién aprobó.
3. Los tokens los crea sólo Biguá y se muestran una vez: no es un login.
4. claude.ai conecta un MCP remoto con OAuth (CIMD o DCR), no con un token fijo en la cabecera.
   Lo confirmamos en ASCI, que lo usa desde el 05/11 (§3.1).
5. La gestión (campañas, ajustes, buzones) no está en el MCP: son rutas del panel.

## 2. Decisión: un segundo MCP, para personas

| | MCP de los bots | **MCP del panel (nuevo)** |
|---|---|---|
| Dirección | `https://sdrbot.bigua.lat/mcp` | `https://sdrbot.bigua.lat/mcp/panel` |
| Quién | Un bot de Grok | Una persona con usuario del panel |
| Identidad | El token (un cliente) | El usuario (`mailgw.admin_user`): `bigua_admin` o `client_admin` |
| Autenticación | Token `mgw_…` en `Authorization` | OAuth 2.1 con PKCE (CIMD o DCR), con login de los usuarios del panel, como en ASCI (§3) |
| Herramientas | Las de hoy, sin cambios | Las del panel (§4), filtradas por rol y modo |
| Alcance en la base | `mailgw_app` con el cliente del token | El mismo `scoped()` del panel: dueño para Biguá, `mailgw_portal` para el cliente |

**Por qué dos y no uno.** Los bots y las personas tienen permisos, textos y riesgos distintos. Si
se mezclan, una persona vería `bitacora_inicio` y un bot podría ver `campana_activar`. Separados,
el MCP de los bots no se toca y el del panel puede crecer sin pensar en los playbooks.

**Una sola lógica.** Las herramientas del MCP del panel no reimplementan nada. Desde la etapa M0
(hecha el 10/11), lo que hace cada ruta del panel está en `src/admin/servicio.mjs`: 39
operaciones (`clienteVer`, `campanaGuardar`, `noContactarAgregar`…) que reciben
`{ user, params, body }`, con el cliente en `params.client`, y pasan por `scoped()`.
`src/admin/api.mjs` quedó con lo de HTTP: la sesión por cookie, el CSRF y la tabla de rutas.
La ruta web y la herramienta MCP llaman a la misma función, así que los permisos, la auditoría y
las validaciones son los mismos en los dos (`test/servicio.test.mjs` las llama sin HTTP).

## 3. Autenticación

Se copia el OAuth que ya anda en ASCI (`mcp.bigua.lat`, repo `locasci`: `docs/32-oauth-chatgpt.md`,
`api/oauth.mjs`, `mcp/oauth.mjs` y `api/mcp.mjs`). Ahí está probado con Claude (claude.ai y
Claude Code), ChatGPT y Cursor, y cada tropiezo quedó documentado. Lo que cambia es **cómo entra
la persona**: en ASCI pone su email y recibe un código; acá usa su usuario y contraseña del panel.

### 3.1 Lo que aprendimos en ASCI

| Lección | Qué pasó en ASCI | Qué hacemos acá |
|---|---|---|
| **claude.ai conecta con OAuth y prefiere CIMD** | Con sólo DCR, claude.ai leía la metadata y no se registraba nunca. Cuando el servidor anuncia `client_id_metadata_document_supported`, Claude usa CIMD: su `client_id` es la URL de un documento que publica Claude | CIMD **y** DCR desde el principio |
| **El 401 tiene que llegar en el saludo** | Al contestar `initialize` sin clave, Claude creía que el servidor no pedía login, pedía `tools/list`, recibía 401 y abandonaba con «No se pudo conectar» (#113). ChatGPT necesita lo contrario: el saludo sin clave (sólo para `openai-mcp/…`) | `/mcp/panel` da 401 a todo lo que llegue sin token, saludo incluido. La excepción de ChatGPT se suma sólo si un cliente lo pide (decisión abierta 1) |
| **Los callbacks de Claude son dos** | Claude se registra con `claude.ai` y con `claude.com`; sin la segunda, el registro entero daba 400 (#114) | Lista cerrada con las dos (§3.3) |
| **No servir `openid-configuration`** | Con ese documento, ChatGPT ofrecía «OIDC habilitado» contra un servidor que no lo es | Sólo `oauth-authorization-server` |
| **`resource` igual a lo que cargó el usuario** | Los clientes piden la metadata del recurso con el mismo sufijo que la URL; si `resource` no coincide, no conectan | `/.well-known/oauth-protected-resource/mcp/panel` devuelve `resource: …/mcp/panel` |
| **`iss` en la respuesta de `/authorize`** (RFC 9207) | Sin él, ChatGPT usa otro callback; los clientes comparan `iss` con `issuer` sin normalizar | Se devuelve siempre, el mismo texto que `issuer` |
| **Sin estado donde se pueda** | El cliente DCR es un sobre firmado (no se guarda), y el estado del login viaja firmado en el formulario (15 min para el pedido, 10 para el login): sin cookies ni sesión | Igual. Lo único que va a la base es lo que tiene que ser de uso único o revocable: el código y los tokens |
| **Un token por conexión, visible y revocable** | Cada conexión crea su propia clave «OAuth · <cliente>», que se ve en `usuarios` y se corta con `revocar_clave` | Cada conexión es una fila de `mailgw.oauth_token` que se ve y se desconecta en el panel (§3.4) |
| **Logs que sirven** | Cada 401 deja el método JSON-RPC, si traía clave y el user-agent (nunca la clave). Con eso se reconstruyó cada falla | Lo mismo en `/mcp/panel` y `/oauth/*` |
| **«Conectado» sin herramientas en claude.ai** | El conector quedaba conectado pero sin consentimiento (`has_consent: false`) y nunca abría el login | Va al instructivo: **Desconectar y Conectar** en la tarjeta del conector (§3.6) |

### 3.2 Metadata y 401

- **El 401** de `/mcp/panel` lleva
  `WWW-Authenticate: Bearer realm="sdrbot-panel", resource_metadata="https://sdrbot.bigua.lat/.well-known/oauth-protected-resource/mcp/panel"`.
  El origen sale de `OAUTH_ISSUER` o del pedido (`x-forwarded-proto` + `host`), para que ande en
  previews y en local (como `emisor()` en ASCI).
- **Recurso protegido** (RFC 9728), `GET /.well-known/oauth-protected-resource/mcp/panel`:

```json
{
  "resource": "https://sdrbot.bigua.lat/mcp/panel",
  "authorization_servers": ["https://sdrbot.bigua.lat"],
  "bearer_methods_supported": ["header"],
  "scopes_supported": ["panel"]
}
```

- **Servidor de autorización** (RFC 8414), `GET /.well-known/oauth-authorization-server`:

```json
{
  "issuer": "https://sdrbot.bigua.lat",
  "authorization_endpoint": "https://sdrbot.bigua.lat/oauth/authorize",
  "token_endpoint": "https://sdrbot.bigua.lat/oauth/token",
  "registration_endpoint": "https://sdrbot.bigua.lat/oauth/register",
  "revocation_endpoint": "https://sdrbot.bigua.lat/oauth/revoke",
  "client_id_metadata_document_supported": true,
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"],
  "authorization_response_iss_parameter_supported": true,
  "scopes_supported": ["panel", "offline_access"]
}
```

  `offline_access` va en la lista porque Claude lo agrega al pedido sólo si el servidor lo
  publica, y es lo que le dice que va a recibir un refresh token. `none` es el único método del
  token: todos los clientes son públicos y los ata PKCE. No hay «cliente definido por el usuario»
  como en ASCI: acá no hay una clave de la persona para usar de secreto.

- **El MCP de los bots no cambia.** `/mcp` sigue con su 401 de hoy y sin metadata: un token
  `mgw_…` no pasa por OAuth.

### 3.3 Registro del cliente

- **CIMD:** el `client_id` es una URL `https` de un host de la lista `OAUTH_CIMD_HOSTS` (por
  defecto `claude.ai,claude.com,chatgpt.com,openai.com`). `/authorize` lee el documento con los
  topes de ASCI (sin IPs, 4 s, 16 kB, caché de 5 min), exige que su `client_id` sea esa misma
  URL y sólo acepta los `redirect_uri` que declara **y** que además están en la lista de abajo.
- **DCR** (RFC 7591), `POST /oauth/register`: no se guarda nada. El `client_id` es un sobre
  firmado con `OAUTH_FIRMA` que lleva el nombre del cliente y sus `redirect_uri`.
- **Lista de `redirect_uri`** (`OAUTH_REDIRECTS`), la misma de ASCI:

```
https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback,https://chatgpt.com/connector/oauth/,https://chatgpt.com/connector_platform_oauth_redirect,https://www.cursor.com/agents/mcp/oauth/callback
```

  Más loopback (`http://localhost`, `127.0.0.1` y `[::1]` con cualquier puerto, RFC 8252) para
  Claude Code, Claude Desktop y Cursor de escritorio. Una entrada que termina en `/` es un
  prefijo y exige algo después; las demás tienen que coincidir enteras. Se compara la URL ya
  normalizada (sin `..`), sólo `https`, sin fragmento ni usuario.
  **Esta lista es lo que impide el robo de cuentas.** Con login, un atacante que registrara su
  propio sitio podría mandarle el enlace a un usuario real; el usuario entraría con su
  contraseña y el código, con el `code_verifier` del atacante, le llegaría al atacante.

### 3.4 Autorizar, canjear y desconectar

1. **`GET /oauth/authorize`** valida `response_type=code`, PKCE `S256`, el cliente (CIMD o DCR)
   y el `redirect_uri`. Si el `redirect_uri` no vale, responde 400 con HTML y no redirige a
   ningún lado. Si falla otra cosa, redirige con `error` y el `state`. Toda respuesta lleva `iss`.
2. **La página de login** es la del panel, servida desde `/oauth/authorize`, con las mismas
   reglas: scrypt, bloqueo tras 5 intentos, usuario activo y activado. **No se aprovecha la
   sesión del panel:** la cookie es `SameSite=Strict` y `Path=/admin`, así que no llega cuando
   la página se abre desde claude.ai. Se entra siempre con usuario y contraseña. Igual que en
   ASCI, el mensaje no dice si el email existe.
3. **Consentimiento:** «Claude va a poder ver y gestionar **[cliente]** en tu nombre», con lo
   que puede hacer según el rol. Para un operador de Biguá dice «todos los clientes».
4. **Código:** 5 minutos y **de uso único**, en `mailgw.oauth_code` (en ASCI el primer código era
   sin estado, y el riesgo de canjearlo dos veces quedó anotado; con login pasó a la base).
5. **`POST /oauth/token`** sin secreto: PKCE, que el `client_id` y el `redirect_uri` (si viene)
   coincidan con los del código, y que el usuario siga activo. Devuelve un token de acceso
   opaco `mgp_…` de **1 hora** y uno de renovación de **30 días**, los dos como hash en
   `mailgw.oauth_token`.
6. **Renovación:** rota en cada uso. Si se usa uno ya rotado, se revoca toda la familia (alguien
   lo copió). Un usuario inactivo o con la contraseña reseteada da `invalid_grant`.
7. **Errores** como en ASCI (RFC 6749 §5.2), en JSON con `Cache-Control: no-store`.

**Por qué 1 hora y no 30 días como en ASCI.** En ASCI el token es una clave más del usuario, que
lee datos y gasta créditos. Acá un token puede aprobar mensajes que salen a nombre del cliente
(§5): conviene que uno copiado sirva poco tiempo. La renovación es transparente para Claude.

**Reglas de los tokens:**

- Si el usuario se desactiva, se le resetea la contraseña o se le cambia el rol, todos sus tokens
  quedan revocados en el acto.
- Un `mgp_…` no sirve en `/mcp` ni un `mgw_…` en `/mcp/panel`. El prefijo se chequea antes de ir
  a la base.
- En el panel, **Mi usuario → Conexiones** lista las conexiones de esa persona (cliente, alta,
  último uso) con un botón «Desconectar». Biguá ve y revoca las de todos.

### 3.5 Archivos, ruteo y configuración

Como en ASCI: un solo handler `api/oauth.mjs` que despacha por ruta, y lo que no necesita HTTP ni
base en `src/oauth.mjs` (`emisor()`, `firmar()`, `verificar()`, PKCE, la lista de redirects y
CIMD), que se puede llevar casi tal cual de `locasci/mcp/oauth.mjs`. En `vercel.json`, las
reglas de `/.well-known/*` y `/oauth/*` van **antes** de las que ya existen, y el sufijo de la
metadata del recurso viaja explícito en el destino (sin eso el handler no sabe qué `resource`
devolver).

Variables en Vercel (proyecto `sdrbot-mail-gateway`), sin valores en el repo:

| Variable | Qué es |
|---|---|
| `OAUTH_FIRMA` | 32 bytes aleatorios en base64, la clave HMAC. **Obligatoria**: sin ella `/authorize` y `/token` fallan. Distinta de la de ASCI. Rotarla invalida los clientes DCR y los sobres en vuelo; las conexiones siguen, porque los tokens están en la base |
| `OAUTH_ISSUER` | Opcional. Si no está, el origen sale del pedido |
| `OAUTH_REDIRECTS`, `OAUTH_CIMD_HOSTS` | Opcionales: si no están, rigen las listas por defecto del código |

CORS: `Access-Control-Allow-Origin: *` en `/.well-known/*` y `/oauth/token` (no hay cookies). La
página de `/oauth/authorize` lleva la CSP estricta del panel y `frame-ancestors 'none'`.

### 3.6 Instructivo para el cliente

En claude.ai: Configuración → Conectores → Agregar conector personalizado → URL
`https://sdrbot.bigua.lat/mcp/panel` → Conectar. Se abre la página del SDR: usuario,
contraseña y «Autorizar». En Claude Code:
`claude mcp add --transport http sdrbot https://sdrbot.bigua.lat/mcp/panel` y la primera vez
abre el navegador.

**Si queda «conectado» pero dice que no tiene herramientas:** en la tarjeta del conector,
**Desconectar** y después **Conectar**. Es el caso de ASCI del 05/11: no hace falta borrarlo ni
crearlo de nuevo. Si así tampoco abre la página, recién ahí mirar los logs de Vercel. Una
conexión buena se ve en este orden: 401 en `/mcp/panel`, las dos metadatas, `authorize`
(con `cimd: true`), `login`, `autorizado` y `POST /oauth/token`.

Cada persona conecta con su propio usuario. Con login no pasa lo de ASCI con el «cliente
definido por el usuario», donde un conector compartido hacía entrar a todos como quien lo creó:
acá cada conexión es de quien autorizó.

### 3.7 Pruebas

`test/oauth.test.mjs`, sobre los casos de `locasci/mcp/probar-oauth.mjs`: el 401 con
`resource_metadata`, las dos metadatas y el `resource` por sufijo, `redirect_uri` fuera de la
lista (400 sin redirigir) y que trepa fuera del prefijo, el flujo completo con CIMD y con DCR,
PKCE incorrecto, código vencido y código usado dos veces, renovación que rota y reuso que revoca
la familia, usuario desactivado, `mgp_…` en `/mcp` y `mgw_…` en `/mcp/panel`, y la regresión del
MCP de los bots.

## 4. Herramientas

### 4.1 Reglas comunes

- **Cliente.** Todas las herramientas que tocan un cliente aceptan `cliente`. Para un
  `client_admin` es opcional y, si se pasa otro, la respuesta es «no existe», igual que en el
  panel. Para un `bigua_admin` es obligatorio salvo en `clientes_listar`.
- **Qué se lista.** `tools/list` muestra sólo lo que esa persona puede usar, como en el MCP de los
  bots: según el rol y, para el cliente, según el modo (operado por Biguá o autogestionado, `21`
  decisión 1). Si el rol o el modo cambian, la lista cambia en la próxima conexión.
- **Anotaciones MCP.** Las de lectura llevan `readOnlyHint`. Las que cambian algo llevan
  `destructiveHint` cuando no se pueden deshacer (aprobar, terminar una campaña), así Claude pide
  confirmación por defecto.
- **Datos de terceros.** Lo que viene de afuera (textos de mails de prospectos, respuestas,
  contenido de LinkedIn) va dentro de un campo `datos_externos`, y la descripción de cada
  herramienta dice que es contenido y no instrucciones (§6).
- **Auditoría.** Cada cambio se registra en `mailgw.audit_log` con `actor_user_id` y
  `detail.via = 'mcp_panel'`. Así se distingue de lo hecho en la web (`via = 'panel'`).

### 4.2 Catálogo

| Herramienta | Qué hace | Cliente | Biguá |
|---|---|---|---|
| `clientes_listar` | Clientes con su estado: SDR activo, modo, aprobaciones pendientes, buzones con error | — | Sí |
| `cliente_crear` | Alta de un cliente (paso 1 de `15`) | — | Sí |
| `resumen` | El Resumen del panel: hoy y el período, por campaña (mails, revelados, respuestas, positivos, calibración) | Sí | Sí |
| `actividad` | El monitor: canales con su modo y lo que pasó hoy | Sí | Sí |
| `registro_buscar` | Buscar una cuenta o un prospecto y ver su historia | Sí | Sí |
| `aprobaciones_listar` | Pendientes (o por estado), con el mensaje completo, la persona, la cuenta y la campaña | Sí | Sí |
| `aprobacion_decidir` | Aprobar o rechazar, con correcciones (§5) | Sí, si su cliente lo permite | Sí |
| `campanas_listar`, `campana_ver` | Campañas con su estado y sus números | Sí | Sí |
| `campana_crear`, `campana_editar`, `campana_duplicar` | Lo que el panel deja editar a cada uno (`21` §6.2); una campaña nueva del cliente en modo operado queda en borrador | Sí, los campos de su rol | Sí, todos |
| `campana_estado` | Activar, pausar o terminar | En autogestionado | Sí |
| `ajustes_ver`, `ajustes_editar` | Empresa: oferta, ICP, tono, firma, objeciones, positivos… con el mismo historial y aviso al orquestador | Sí, los campos que no tienen candado | Sí |
| `ajustes_restaurar` | Volver a una versión del historial | Sí | Sí |
| `no_contactar_listar`, `no_contactar_agregar`, `no_contactar_quitar` | La lista de no contactar | Sí | Sí |
| `buzones_listar`, `buzon_probar`, `buzon_pausar` | Estado y prueba de los buzones. **Sin alta ni contraseña** (§4.3) | Sí | Sí |
| `dominios_ver`, `dominio_verificar` | SPF, DKIM y DMARC, con lo que hay que publicar | Sí | Sí |
| `usuarios_listar`, `usuario_crear` | Usuarios del cliente. El enlace de activación se manda por mail, no vuelve por el chat | — | Sí |
| `config_sdr`, `despertador`, `dripify_ver`, `whatsapp_ver` | Lo técnico de Administración, para mirar | — | Sí (sólo lectura) |

### 4.3 Lo que no pasa por el MCP

Ningún secreto entra ni sale por el chat (`CLAUDE.md`):

- Contraseñas de buzones: se cargan en el panel web. Por eso el alta de un buzón también queda en
  la web: sin contraseña no se puede probar.
- Tokens `mgw_…` de los bots: se crean y se ven una vez en el panel.
- API key de Dripify y secreto del webhook: en el panel.
- Enlaces de activación y reseteo: van por mail a la persona.
- `MAILGW_ENC_KEYS` y contraseñas de la base: nunca, por ningún lado.

Tampoco pasan los envíos. El MCP del panel **no manda mails ni mensajes**: decide aprobaciones y
los bots ejecutan lo aprobado, con todos los controles del gateway (§5.3).

## 5. Aprobaciones por el cliente

### 5.1 Qué cambia

Hoy el bot pide la aprobación (`registro_pedir_aprobacion`), el orquestador se la presenta al
operador de Biguá en su chat de Grok, y el orquestador registra lo que el operador dijo
(`registro_aprobar`, con `operador` como texto libre). Desde ahora, **el cliente también puede
decidir**, desde Claude (`aprobacion_decidir`) o desde una pestaña nueva **Aprobaciones** del
panel web. Las dos llaman a la misma función.

**Quién decide se configura por cliente** (Administración → Operación, lo fija Biguá):

| Valor de `sdr.cliente_config.aprueba` | Quién puede decidir |
|---|---|
| `bigua` | Sólo Biguá, como hasta hoy |
| `cliente_y_bigua` | El que llegue primero. **Por defecto para clientes nuevos** |
| `cliente` | Sólo el cliente. Biguá puede rechazar (frenar), pero no aprobar |

**Qué tipos puede decidir el cliente:** los mensajes (`calibracion_mail`, `respuesta_positivo` y
`whatsapp_primero`). `crm_mapeo`, `crm_cambio` y `otro` siguen siendo de Biguá mientras no se
decida otra cosa (decisión abierta 3).

### 5.2 Cómo se decide

`aprobacion_decidir` recibe `id`, `decision` (`aprobada` o `rechazada`), `nota` y, si corrige,
`asunto`, `texto` o `linkedin` (nota, mensaje1 y mensaje2). Reglas:

- **Quién decidió sale de la sesión, no de un parámetro.** No hay campo `operador`. Se guarda
  `decidida_por_usuario` (id), `decidida_por_rol` (`cliente` o `bigua`) y `decidida_via` (`chat`,
  `panel` o `mcp_panel`). `decidida_por` queda con el mail de la persona, para no romper lo que lo
  lee.
- **El cliente no cambia el destinatario.** Puede corregir el asunto y el texto, pero no a quién
  va. Si la persona no es la correcta, se rechaza con una nota y el bot propone otra. El cambio de
  destinatario sigue siendo de Biguá.
- **Primero gana.** La función ya bloquea la fila (`for update`) y responde `ya_decidida` (409) si
  otro decidió antes: si el operador y el cliente deciden a la vez, vale la primera decisión y la
  otra persona ve quién se le adelantó.
- **Las correcciones pasan por las mismas validaciones que el pedido** (largos y campos
  obligatorios por tipo), y al enviar, el gateway sigue exigiendo los links permitidos de la
  campaña.
- **Ver antes de decidir.** `aprobacion_decidir` sin `confirmar: true` devuelve cómo va a quedar
  el mensaje final (con las correcciones) y no cambia nada. Con `confirmar: true`, decide. Así
  Claude muestra el texto final antes de comprometerlo.

### 5.3 Después de decidir

- El bot que la pidió la encuentra en `registro_pendientes` como hoy (`aprobaciones_para_ejecutar`
  o rechazadas recientes) y la ejecuta. El gateway sigue dejando enviar **sólo** el contenido
  aprobado y sigue chequeando todo lo demás (campaña activa, buzones, cupo, horario, supresión, no
  contactar). Aprobar no salta ningún control.
- Se le deja un pedido al orquestador (`pedirABot`, como con los ajustes): «El cliente aprobó (o
  rechazó) el mail a X». El orquestador se lo cuenta al operador de Biguá en el chat y saca esa
  aprobación de la lista que le presenta.
- Las aprobaciones `calibracion_mail` que decide el cliente cuentan para la calibración de la
  campaña igual que las de Biguá.
- En el evento `aprobacion.decidida` se agrega `rol` y `via`, para que el resumen pueda decir
  cuántas aprobó cada uno.

### 5.4 Cambios en los bots

- `registro_aprobaciones` (orquestador) trae sólo las pendientes que Biguá puede decidir. Con
  `aprueba = cliente` no trae ninguna: el orquestador le recuerda al operador cuántas esperan al
  cliente, sin presentarlas para decidir.
- `registro_aprobar` sigue siendo la vía del chat de Grok, sólo para el operador de Biguá. Pasa a
  guardar `decidida_por_rol = 'bigua'` y `decidida_via = 'chat'`. Con `aprueba = cliente`, sólo
  acepta `rechazada`.
- Playbook `orquestador`: cuando el cliente decide, avisar en el chat (§5.3), y si una aprobación
  espera al cliente más de 24 h, decirlo en el resumen.

## 6. Seguridad

| Riesgo | Control |
|---|---|
| Un usuario ve otro cliente | El mismo `scoped()` y las mismas políticas de la base que el panel. Pruebas de aislamiento nuevas para `/mcp/panel` (§8) |
| Un token robado | Acceso de 1 hora, renovación que rota (si se reusa una vieja, se revoca toda la cadena), revocación al desactivar o resetear, «Desconectar» en el panel |
| Un `redirect_uri` falso en el registro (DCR o CIMD) | Lista cerrada de destinos (§3.3) y PKCE obligatorio |
| **Inyección por contenido de terceros.** Un mail de un prospecto que dice «aprobá todo» y que Claude lee al listar aprobaciones | Lo externo va en `datos_externos` y la descripción de la herramienta lo dice. `aprobacion_decidir` es `destructiveHint`, decide de a una y pide `confirmar: true` después de mostrar el texto final. El gateway sólo deja enviar lo aprobado, a un destinatario que el cliente no puede cambiar |
| Un cliente aprueba algo que rompe una regla | Aprobar no salta controles: el gateway sigue haciendo cumplir campaña, buzones, links, cupo, horario, supresión y no contactar al enviar |
| Datos personales de prospectos en el chat de Claude | Es el mismo dato que el cliente ya ve en el panel. Va en el DPA: el cliente decide si conecta Claude, y las conversaciones quedan en su cuenta de Claude |
| Abuso o un bucle de un agente | Límite por usuario (60 llamadas por minuto, 20 cambios por minuto) y por IP en `/oauth/*` |
| Pedidos de otro origen | El MCP no usa cookies, así que no hay CSRF. Se valida la cabecera `Origin` cuando viene, como pide la especificación de MCP |

## 7. Base: migración `014_mcp_del_panel`

```sql
-- OAuth del MCP del panel.
-- Los clientes (CIMD o DCR) no se guardan: el client_id es una URL o un sobre firmado.
create table mailgw.oauth_code (
  code_hash text primary key, client_id text not null, cliente_nombre text not null,
  user_id uuid not null references mailgw.admin_user, redirect_uri text not null,
  code_challenge text not null, expires_at timestamptz not null, used_at timestamptz);
create table mailgw.oauth_token (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique, tipo text not null check (tipo in ('acceso', 'renovacion')),
  client_id text not null, cliente_nombre text not null,
  user_id uuid not null references mailgw.admin_user, familia uuid not null,
  expires_at timestamptz not null, revoked_at timestamptz, last_used_at timestamptz,
  created_at timestamptz not null default now());
-- Sólo el dueño las toca (como admin_user y las sesiones): ni mailgw_app ni mailgw_portal.

-- Quién aprueba.
alter table sdr.cliente_config add column aprueba text not null default 'bigua'
  check (aprueba in ('bigua', 'cliente_y_bigua', 'cliente'));
alter table sdr.aprobacion
  add column decidida_por_usuario uuid references mailgw.admin_user,
  add column decidida_por_rol text check (decidida_por_rol in ('bigua', 'cliente')),
  add column decidida_via text check (decidida_via in ('chat', 'panel', 'mcp_panel'));

-- El portal (cliente) lee y decide aprobaciones de su cliente; no las crea ni las borra.
grant select, update on sdr.aprobacion to mailgw_portal;
grant select on sdr.prospecto, sdr.cuenta, sdr.evento to mailgw_portal;
grant insert on sdr.evento, sdr.pedido to mailgw_portal;
-- más una política por_cliente para mailgw_portal en cada tabla, como en 012.
```

El `default 'bigua'` deja a los clientes de hoy como están. Los nuevos se crean con
`cliente_y_bigua` desde el alta (`15`). El `update` del portal sobre `sdr.aprobacion` se limita
en la función, que es la única que lo hace: sólo pendientes, sólo de los tipos permitidos y sin
tocar el destinatario.

## 8. Pruebas

- **Aislamiento** (`test/mcp_panel_aislamiento.test.mjs`): un `client_admin` de A no ve ni toca
  nada de B, por ninguna herramienta, ni pasando `cliente: 'b'`. Mismo resultado que un cliente
  que no existe.
- **Lista por rol y modo:** `client_admin` no ve `clientes_listar` ni `usuario_crear`; en modo
  operado no ve `campana_estado`.
- **OAuth:** los casos de §3.7.
- **Aprobaciones:** cada valor de `aprueba`; el cliente no cambia el destinatario; doble decisión →
  `ya_decidida`; el mail aprobado por el cliente sale y uno corregido sale corregido; el resto de
  los controles del envío sigue andando; la calibración cuenta las del cliente.
- **Paridad:** cada herramienta y su ruta web dan el mismo resultado (llaman a la misma función).

## 9. Etapas

| Etapa | Qué | Toca |
|---|---|---|
| **M0 · Servicio** (hecha) | Sacar la lógica de las rutas de `admin/api.mjs` a `src/admin/servicio.mjs`; las rutas quedan finas. Sin cambios visibles | Gateway |
| **M1 · Conectar y mirar** | OAuth (§3, llevando `locasci/mcp/oauth.mjs`), `/mcp/panel` y las herramientas de lectura: `clientes_listar`, `resumen`, `actividad`, `registro_buscar`, `aprobaciones_listar`, `campanas_listar`, `campana_ver`, `ajustes_ver`, `buzones_listar`, `dominios_ver`. Conexiones en el panel. Probar primero con claude.ai y Claude Code en la cuenta de Biguá | Gateway, base, panel |
| **M2 · Aprobaciones del cliente** | `aprueba`, columnas nuevas, `aprobacion_decidir`, pestaña Aprobaciones en el panel web, cambios en `registro_aprobaciones` y `registro_aprobar`, playbook del orquestador | Gateway, base, panel, `playbooks/` |
| **M3 · Gestionar** | Campañas, ajustes, no contactar, prueba y pausa de buzones, verificación de dominios | Gateway |
| **M4 · Biguá** | `cliente_crear`, usuarios y lo técnico en lectura | Gateway |

M1 sola ya sirve: el cliente pregunta «¿cómo viene la campaña de webinar?» y Claude contesta con
los datos del panel.

## 10. Decisiones abiertas

1. **ChatGPT.** El 401 en el saludo (§3.1) es lo que necesita Claude; ChatGPT necesita el
   saludo sin token. Si algún cliente usa ChatGPT, se suma la excepción de ASCI (`initialize`,
   `notifications/initialized`, `ping` y `server/discover` sin token, sólo para `openai-mcp/…`).
   Hasta entonces, no.
2. **Valor por defecto de `aprueba`** para clientes nuevos: propuesto `cliente_y_bigua`. ¿O
   `bigua` hasta terminar la calibración y después `cliente_y_bigua`?
3. **CRM:** ¿el cliente aprueba también `crm_mapeo` y `crm_cambio`? Es su CRM, pero hoy el mapeo
   lo arma Biguá con él (`11`).
4. **Un usuario de sólo lectura** (`21` y `11` lo mencionan): si se crea, con el MCP del panel ve
   las herramientas de lectura y nunca `aprobacion_decidir`.
5. **Aviso al cliente cuando hay aprobaciones esperando** (mail diario o al momento). Sin aviso,
   el cliente sólo se entera si abre el panel o le pregunta a Claude.
