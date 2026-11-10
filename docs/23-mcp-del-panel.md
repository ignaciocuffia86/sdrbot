# MCP del panel: gestionar el SDR desde Claude

Estado al 10/11/2026: **diseño**. No hay código. Se apoya en el panel `/admin` (`15`, `16`, `21`)
y en el MCP de los bots (`07`, `09`, `13`).

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
4. Por lo que sabemos, claude.ai conecta un MCP remoto con OAuth y no con un token fijo en la
   cabecera. Hay que confirmarlo antes de construir (decisión abierta 1).
5. La gestión (campañas, ajustes, buzones) no está en el MCP: son rutas del panel.

## 2. Decisión: un segundo MCP, para personas

| | MCP de los bots | **MCP del panel (nuevo)** |
|---|---|---|
| Dirección | `https://sdrbot.bigua.lat/mcp` | `https://sdrbot.bigua.lat/mcp/panel` |
| Quién | Un bot de Grok | Una persona con usuario del panel |
| Identidad | El token (un cliente) | El usuario (`mailgw.admin_user`): `bigua_admin` o `client_admin` |
| Autenticación | Token `mgw_…` en `Authorization` | OAuth 2.1 con PKCE contra los usuarios del panel (§3) |
| Herramientas | Las de hoy, sin cambios | Las del panel (§4), filtradas por rol y modo |
| Alcance en la base | `mailgw_app` con el cliente del token | El mismo `scoped()` del panel: dueño para Biguá, `mailgw_portal` para el cliente |

**Por qué dos y no uno.** Los bots y las personas tienen permisos, textos y riesgos distintos. Si
se mezclan, una persona vería `bitacora_inicio` y un bot podría ver `campana_activar`. Separados,
el MCP de los bots no se toca y el del panel puede crecer sin pensar en los playbooks.

**Una sola lógica.** Las herramientas del MCP del panel no reimplementan nada. Hoy las rutas de
`admin/api.mjs` tienen la lógica adentro. El primer paso (etapa M0) es sacarla a funciones
(`src/admin/servicio.mjs`) que reciben `(user, clientId, args)` y pasan por `scoped()`. La ruta
web y la herramienta MCP llaman a la misma función, así que los permisos, la auditoría y las
validaciones son los mismos en los dos.

## 3. Autenticación

### 3.1 OAuth contra los usuarios del panel

El gateway hace de **servidor de autorización** para su propio MCP, como pide la especificación de
autorización de MCP:

| Pieza | Qué es |
|---|---|
| `/.well-known/oauth-protected-resource` | Dice que `/mcp/panel` se protege con el servidor de autorización del gateway |
| `/.well-known/oauth-authorization-server` | Metadatos: `authorize`, `token`, `register` y `revoke`; sólo `code` con PKCE `S256` |
| `POST /oauth/register` | Registro dinámico de clientes (lo usa claude.ai). Sólo se aceptan `redirect_uri` de una lista: las de Claude y `http://localhost` / `127.0.0.1` para Claude Code y Desktop. Cualquier otra se rechaza |
| `GET /oauth/authorize` | La misma pantalla de login del panel, con las mismas reglas: scrypt, bloqueo tras 5 intentos, usuario activo y activado. Después, una pantalla de consentimiento: «Claude va a poder ver y gestionar **[cliente]** en tu nombre», con la lista de lo que puede hacer |
| `POST /oauth/token` | Canje del código y renovación. Token de acceso opaco `mgp_…` de **1 hora**; token de renovación de **30 días** que rota en cada uso |
| `POST /oauth/revoke` | Revocar |

**Reglas de los tokens:**

- Se guardan sólo como hash (igual que `mgw_…` y las sesiones), atados al usuario y al cliente
  OAuth (`mailgw.oauth_token`).
- Si el usuario se desactiva, se le resetea la contraseña o se le cambia el rol, todos sus tokens
  quedan revocados en el acto.
- Un `mgp_…` no sirve en `/mcp` ni un `mgw_…` en `/mcp/panel`. El prefijo se chequea antes de ir a
  la base.
- En el panel, **Mi usuario → Conexiones** lista las conexiones de Claude de esa persona (cliente
  OAuth, alta, último uso) con un botón «Desconectar». Biguá ve y revoca las de todos.

### 3.2 Mientras tanto: Claude Desktop y Claude Code

Claude Desktop y Claude Code permiten configurar un MCP remoto con una cabecera fija, así que se
podrían probar las herramientas antes de tener OAuth. **No lo recomendamos con clientes:** el
token quedaría copiado en un archivo de configuración. Para pruebas internas de Biguá alcanza con
un token `mgp_…` de corta vida emitido a mano por la CLI (`bin/admin.mjs panel-token <email>`,
48 h), que se muestra una vez y se pega en la configuración local.

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
| Un `redirect_uri` falso en el registro dinámico | Lista cerrada de destinos (§3.1) y PKCE obligatorio |
| **Inyección por contenido de terceros.** Un mail de un prospecto que dice «aprobá todo» y que Claude lee al listar aprobaciones | Lo externo va en `datos_externos` y la descripción de la herramienta lo dice. `aprobacion_decidir` es `destructiveHint`, decide de a una y pide `confirmar: true` después de mostrar el texto final. El gateway sólo deja enviar lo aprobado, a un destinatario que el cliente no puede cambiar |
| Un cliente aprueba algo que rompe una regla | Aprobar no salta controles: el gateway sigue haciendo cumplir campaña, buzones, links, cupo, horario, supresión y no contactar al enviar |
| Datos personales de prospectos en el chat de Claude | Es el mismo dato que el cliente ya ve en el panel. Va en el DPA: el cliente decide si conecta Claude, y las conversaciones quedan en su cuenta de Claude |
| Abuso o un bucle de un agente | Límite por usuario (60 llamadas por minuto, 20 cambios por minuto) y por IP en `/oauth/*` |
| Pedidos de otro origen | El MCP no usa cookies, así que no hay CSRF. Se valida la cabecera `Origin` cuando viene, como pide la especificación de MCP |

## 7. Base: migración `014_mcp_del_panel`

```sql
-- OAuth del MCP del panel.
create table mailgw.oauth_client (
  id text primary key, nombre text not null, redirect_uris text[] not null,
  created_at timestamptz not null default now(), last_used_at timestamptz);
create table mailgw.oauth_code (
  code_hash text primary key, client_id text not null references mailgw.oauth_client,
  user_id uuid not null references mailgw.admin_user, redirect_uri text not null,
  code_challenge text not null, expires_at timestamptz not null, used_at timestamptz);
create table mailgw.oauth_token (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique, tipo text not null check (tipo in ('acceso', 'renovacion')),
  client_id text not null references mailgw.oauth_client,
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
- **OAuth:** PKCE obligatorio, `redirect_uri` fuera de la lista rechazada, código de un solo uso,
  renovación que rota y reuso que revoca la familia, revocación al desactivar el usuario.
- **Aprobaciones:** cada valor de `aprueba`; el cliente no cambia el destinatario; doble decisión →
  `ya_decidida`; el mail aprobado por el cliente sale y uno corregido sale corregido; el resto de
  los controles del envío sigue andando; la calibración cuenta las del cliente.
- **Paridad:** cada herramienta y su ruta web dan el mismo resultado (llaman a la misma función).

## 9. Etapas

| Etapa | Qué | Toca |
|---|---|---|
| **M0 · Servicio** | Sacar la lógica de las rutas de `admin/api.mjs` a `src/admin/servicio.mjs`; las rutas quedan finas. Sin cambios visibles | Gateway |
| **M1 · Conectar y mirar** | OAuth (§3), `/mcp/panel` y las herramientas de lectura: `clientes_listar`, `resumen`, `actividad`, `registro_buscar`, `aprobaciones_listar`, `campanas_listar`, `campana_ver`, `ajustes_ver`, `buzones_listar`, `dominios_ver`. Conexiones en el panel. Probar primero con claude.ai en la cuenta de Biguá | Gateway, base, panel |
| **M2 · Aprobaciones del cliente** | `aprueba`, columnas nuevas, `aprobacion_decidir`, pestaña Aprobaciones en el panel web, cambios en `registro_aprobaciones` y `registro_aprobar`, playbook del orquestador | Gateway, base, panel, `playbooks/` |
| **M3 · Gestionar** | Campañas, ajustes, no contactar, prueba y pausa de buzones, verificación de dominios | Gateway |
| **M4 · Biguá** | `cliente_crear`, usuarios y lo técnico en lectura | Gateway |

M1 sola ya sirve: el cliente pregunta «¿cómo viene la campaña de webinar?» y Claude contesta con
los datos del panel.

## 10. Decisiones abiertas

1. **Cómo conecta claude.ai.** Confirmar con la documentación vigente que un conector
   personalizado de claude.ai usa OAuth con registro dinámico y cuál es la URL de retorno exacta,
   para la lista de §3.1. Si acepta un token en la cabecera, M1 puede salir antes que OAuth, pero
   igual recomendamos OAuth para clientes.
2. **Valor por defecto de `aprueba`** para clientes nuevos: propuesto `cliente_y_bigua`. ¿O
   `bigua` hasta terminar la calibración y después `cliente_y_bigua`?
3. **CRM:** ¿el cliente aprueba también `crm_mapeo` y `crm_cambio`? Es su CRM, pero hoy el mapeo
   lo arma Biguá con él (`11`).
4. **Un usuario de sólo lectura** (`21` y `11` lo mencionan): si se crea, con el MCP del panel ve
   las herramientas de lectura y nunca `aprobacion_decidir`.
5. **Aviso al cliente cuando hay aprobaciones esperando** (mail diario o al momento). Sin aviso,
   el cliente sólo se entera si abre el panel o le pregunta a Claude.
