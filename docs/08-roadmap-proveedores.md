# Roadmap: buzones en Microsoft 365 y Google Workspace

Estado: **propuesto, para después del piloto de BairesQA.** Escrito el 04/11/2026. Nada de esto
está construido; el gateway hoy habla sólo IMAP/SMTP con contraseña (`07-gateway-imap.md`).

Este documento dice qué hacer cuando entre un cliente con los buzones en Microsoft 365 (Office
365, Outlook) o en Google Workspace (Gmail): la decisión, por qué, qué se construye, en qué
orden, qué se le pide al cliente y qué falta confirmar. Los datos de Microsoft y Google que
dependen de anuncios de esos proveedores están marcados **(verificar al implementar)**: cambian
seguido y hay que confirmarlos contra la documentación vigente antes de escribir código.

## 1. La decisión

**Todos los proveedores de correo entran por el gateway de SDRBOT**, con un tipo de buzón por
proveedor: `imap` (lo de hoy), `microsoft` (Microsoft Graph) y `google` (Gmail API). El bot usa
las mismas herramientas MCP sea cual sea el proveedor; el gateway traduce.

Esto cambia el diseño anterior. `02-arquitectura.md` §4.2 ponía Gmail API y Graph en un módulo
de los scripts del box, con la credencial como secreto de Grok Bot (`MAIL_CREDENTIAL`). El
gateway, que nació para IMAP, resultó ser el mejor lugar para todos: ya tiene el cupo diario,
la idempotencia, el tope de destinatarios, la auditoría, el aislamiento por cliente en la base,
el panel y el chequeo de dominio. Duplicar eso en los scripts para cada proveedor sería
mantener dos implementaciones de las mismas reglas.

### 1.1 Por qué no los conectores de Grok Bot

| | Conector de Gmail u Outlook de Grok Bot | Gateway de SDRBOT |
|---|---|---|
| Tiempo para arrancar | Inmediato: cada dueño de buzón inicia sesión en la app | Hay que construir el adaptador y el administrador del cliente da un permiso una vez |
| Tope diario, sin envíos repetidos, máximo de destinatarios | No existen: dependen de que el bot obedezca el prompt | Los aplica el gateway en código |
| Registro de qué se envió | Nada propio | `mailgw.send_log` y `mailgw.audit_log`, por cliente y por buzón |
| Aislamiento | Todos los bots de la cuenta ven todos los conectores (`06` 5.1) | Un token por cliente, separado también en la base |
| Panel, chequeo de dominio, pausar un buzón | No aplican | Los mismos que BairesQA |
| Si se corta el acceso | Re-autorizar en la app, buzón por buzón | El gateway lo detecta, frena el buzón y lo muestra en el panel |
| Para Biguá | Un procedimiento por proveedor | Un solo modelo de operación |

El tope y el "no mandar dos veces" son lo que separa la prospección de quemar un dominio: no
pueden depender de un prompt. **El conector queda sólo como puente** para una demo o para un
cliente apurado mientras el adaptador no existe, y en ese caso **sólo con borradores**, sin
envío automático.

### 1.2 Por qué no IMAP/SMTP con contraseña en Microsoft y Google

- **Microsoft 365** apagó la autenticación básica (usuario y contraseña) para IMAP en 2022, y
  anunció el apagado de SMTP AUTH con contraseña entre marzo y abril de 2026 **(verificar al
  implementar)**. Lo que queda es OAuth. Cargar un buzón de Microsoft 365 en el panel como uno
  de IMAP no conecta.
- **Outlook.com y Hotmail** (cuentas personales) exigen OAuth desde 2024. Además no sirven
  para prospectar por ningún camino: no tienen dominio propio, tienen límites de envío bajos y
  las condiciones de Microsoft no lo permiten. Si el cliente sólo tiene eso, la respuesta es un
  dominio alternativo en Microsoft 365 o Google Workspace (`03` ítem 6).
- **Google Workspace** cortó el acceso de "apps menos seguras" con contraseña común en
  2024–2025 **(verificar al implementar)**. Siguen existiendo las **contraseñas de aplicación**
  para cuentas con verificación en dos pasos, si el administrador no las bloqueó. Con eso el
  gateway actual funciona contra Gmail sin una línea de código nueva: es el puente de §5.1.

## 2. Diseño común: un tipo de buzón por proveedor

Lo que se construye una vez y sirve para los dos proveedores (etapa 1 de §6).

### 2.1 Base

- `mailgw.account.provider`: `imap` (default, lo de hoy), `microsoft`, `google`.
- Tabla nueva `mailgw.provider_connection`: **la credencial es por cliente, no por buzón.**
  Una fila por (cliente, proveedor, organización del cliente) con el identificador de la
  organización (tenant de Microsoft o cliente de Workspace), el de la aplicación, la
  credencial cifrada con `MAILGW_ENC_KEYS` (igual que hoy las contraseñas, con su propio AAD),
  el estado y la fecha de la última verificación de alcance (§2.4).
- Los buzones `microsoft` y `google` apuntan a su conexión y no llevan contraseña ni
  servidores. Misma seguridad por filas por cliente que el resto (`002`, `003`).

### 2.2 Adaptadores

Un módulo por proveedor detrás de la misma interfaz que hoy implementa `src/mail/imap.mjs` +
`smtp.mjs`:

| Operación del bot | IMAP (hoy) | Microsoft Graph | Gmail API |
|---|---|---|---|
| `carpetas` | `LIST` con SPECIAL-USE | `mailFolders` (+ `childFolders`, nombres bien conocidos `inbox`, `sentitems`, `drafts`) | `labels.list` |
| `sincronizar` | UID desde un cursor | `messages/delta` por carpeta (el cursor es el `deltaLink`) | `history.list` desde un `historyId` |
| `buscar` | `SEARCH` | `$search` / `$filter` | `messages.list` con `q` |
| `leer_mensaje` | `FETCH` del MIME | `messages/{id}/$value` (MIME) | `messages.get` con `format=raw` |
| `enviar` | SMTP + copia en Enviados | `sendMail` (guarda en Enviados solo) | `messages.send` con el MIME que ya arma `compose.mjs` (guarda en Enviados solo) |
| `responder` | SMTP con `In-Reply-To` y `References` | `createReply` y `send` (mantiene el hilo) | `messages.send` con `threadId` y las mismas cabeceras |
| `crear_borrador` | `APPEND` en Borradores | `POST messages` (queda en Borradores) | `drafts.create` |
| `marcar` | flags y palabras clave (`SDR_procesado`) | `isRead`, `flag` y **categorías** para las palabras clave | etiqueta `UNREAD`, `STARRED` y **etiquetas propias** para las palabras clave |
| `mover` | `MOVE` (nunca a la papelera) | `messages/{id}/move` (nunca a `deleteditems`) | cambiar etiquetas (nunca `TRASH`) |
| `crear_carpeta` | `CREATE` | `childFolders` | `labels.create` |

Las reglas que hoy viven en `ops.mjs` (cupo, idempotencia, máximo de destinatarios, nada se
borra, auditoría sin contenido) quedan **arriba** de los adaptadores y no se tocan.

### 2.3 El contrato con el bot

Hoy los mensajes se identifican con `uid` (entero de IMAP) y el cursor es
`{ uidvalidity, last_uid }`. Graph y Gmail usan identificadores de texto y cursores propios.
Para que el bot no cambie según el proveedor:

- Cada mensaje devuelve además un **`id` opaco** (texto). Las operaciones aceptan `id` o, en
  buzones IMAP, `uid` como hasta ahora: lo que ya usa BairesQA sigue funcionando.
- El cursor de `sincronizar` pasa a ser **opaco**: el bot lo guarda y lo devuelve sin mirarlo.
  En IMAP sigue siendo el mismo objeto.
- Las palabras clave (`SDR_procesado`) se mapean a categorías (Graph) o etiquetas (Gmail) con
  el mismo nombre; el bot no se entera.
- `enviar` y `responder` siguen devolviendo el `Message-ID`: en Graph sale de
  `internetMessageId` y en Gmail del mensaje enviado.

### 2.4 Panel

- Al crear un buzón se elige el proveedor. Para `imap`, lo de hoy. Para `microsoft` y
  `google`, primero se da de alta la **conexión** del cliente con un asistente que muestra los
  pasos para su administrador (§4.3 y §5.3), y después se agregan los buzones (sólo email y
  nombre visible).
- **«Verificar alcance»**: comprueba que la conexión llega a los buzones del SDR **y que no
  llega a uno que no lo es** (el administrador da una dirección cualquiera de la empresa para
  la prueba negativa). Un buzón no se habilita hasta que esa prueba pasa. Es la defensa contra
  un permiso que, mal configurado, deja leer el correo de toda la empresa.
- «Probar», pausar, cupo, actividad y la pestaña «Dominios» funcionan igual. El chequeo de
  dominio ya detecta Microsoft 365 y Google y da los pasos de cada uno.

## 3. Lo que no cambia

El aislamiento por cliente en la base, los tokens de Grok Bot por cliente, las herramientas MCP,
el registro de envíos y la idempotencia, el panel y sus roles, y la regla de que nada se borra.
Un cliente con buzones en dos proveedores (por ejemplo, Microsoft 365 para el dominio principal
y un hosting para el alternativo) es un caso normal: buzones de distinto tipo bajo el mismo
cliente y el mismo token.

## 4. Microsoft 365 con Microsoft Graph

### 4.1 Cómo entra el gateway

Permisos **de aplicación** (sin usuario que inicie sesión): `Mail.ReadWrite` y `Mail.Send`.
`Mail.ReadWrite` cubre leer, crear borradores, mover y marcar; `Mail.Send`, enviar. No hacen
falta `Mail.Read` aparte ni permisos de calendario o contactos.

**Una aplicación por cliente, registrada en el Entra ID del cliente**, con autenticación por
**certificado**: el gateway genera el par de claves, el cliente sube sólo la parte pública a su
aplicación, y la privada queda cifrada en `provider_connection`. Así no viaja ningún secreto, y
si una credencial se filtra expone a un solo cliente.

La alternativa, una aplicación multi-tenant de Biguá con consentimiento de cada cliente, es más
rápida de dar de alta pero concentra el riesgo: una sola credencial para todos los clientes. Se
puede revisar si el volumen de clientes lo justifica (§7).

### 4.2 Acotar la aplicación a los buzones del SDR

**No es opcional.** Un permiso de aplicación de Graph, concedido sin más, deja leer y enviar
desde **todos** los buzones de la organización. Ninguna área de seguridad lo acepta, y no
debería.

Exchange Online lo acota con **RBAC para aplicaciones** (el reemplazo de las antiguas
*application access policies*) **(verificar al implementar)**:

```powershell
# En Exchange Online PowerShell, como administrador del cliente.
# 1. Marcar los buzones del SDR (o usar un grupo).
Set-Mailbox ventas1@dominio.com -CustomAttribute1 "sdrbot"
# 2. Dar de alta la aplicación en Exchange (AppId y ObjectId del service principal de Entra).
New-ServicePrincipal -AppId <app-id> -ObjectId <object-id> -DisplayName "SDRBOT Mail"
# 3. Un alcance con sólo esos buzones.
New-ManagementScope -Name "SDRBOT buzones" -RecipientRestrictionFilter "CustomAttribute1 -eq 'sdrbot'"
# 4. Los permisos, sólo dentro de ese alcance.
New-ManagementRoleAssignment -App <app-id> -Role "Application Mail.ReadWrite" -CustomResourceScope "SDRBOT buzones"
New-ManagementRoleAssignment -App <app-id> -Role "Application Mail.Send" -CustomResourceScope "SDRBOT buzones"
# 5. Comprobar.
Test-ServicePrincipalAuthorization -Identity <app-id> -Resource ventas1@dominio.com
```

Con RBAC para aplicaciones los permisos se asignan en Exchange, **no** se conceden en Entra ID:
si además se conceden en Entra para toda la organización, el acotamiento no sirve. El asistente
del panel lo tiene que decir en rojo, y «Verificar alcance» (§2.4) lo comprueba.

### 4.3 Qué se le pide al cliente

| # | Qué | Quién |
|---|---|---|
| 1 | Licencia de Exchange Online en cada buzón del SDR | TI del cliente |
| 2 | Registrar una aplicación en Entra ID y subir el certificado que genera el panel | Administrador de Entra ID |
| 3 | Los pasos de §4.2 con los buzones del SDR | Administrador de Exchange |
| 4 | Una dirección que **no** sea del SDR, para la prueba negativa de alcance | Administrador |
| 5 | SPF con `include:spf.protection.outlook.com`, DKIM activado en Defender, DMARC | TI del cliente (la pestaña «Dominios» lo verifica y da los pasos) |

Se hace en una videollamada de 30 a 45 minutos con un operador de Biguá, igual que hoy la carga
de contraseñas.

### 4.4 Límites a tener en cuenta

- Exchange Online limita a 30 mensajes por minuto y 10.000 destinatarios por día por buzón
  **(verificar al implementar)**; los cupos del SDR están muy por debajo.
- Graph limita pedidos por aplicación y por buzón. Si responde 429, hay que respetar el
  `Retry-After`. `sincronizar` con `delta` es barato.
- Microsoft anunció en su momento un límite de destinatarios externos por día y después lo
  postergó **(verificar al implementar)**. Si entra en vigor, el cupo del panel tiene que
  quedar por debajo.

### 4.5 Cómo se prueba

- Un servidor Graph de mentira en los tests (`test/`), igual que hoy Dovecot hace de servidor
  IMAP: endpoints mínimos de `mailFolders`, `messages`, `delta`, `sendMail`, `createReply`,
  `move` y respuestas 401, 403 y 429.
- Un tenant de desarrollo de Microsoft 365 para la prueba de punta a punta, incluida la prueba
  negativa de alcance. El programa de desarrolladores de Microsoft restringió quién accede
  **(verificar)**: si no se consigue, un tenant de prueba pago con una licencia.

## 5. Google Workspace

### 5.1 Puente sin código: IMAP con contraseña de aplicación

Para un cliente en Workspace que no puede esperar al adaptador:

- Servidores `imap.gmail.com` (993, TLS) y `smtp.gmail.com` (465, TLS). El usuario es la
  dirección completa; la contraseña, una **contraseña de aplicación** de esa cuenta (requiere
  verificación en dos pasos y que el administrador no las haya bloqueado).
- **Desactivar «Guardar copia de lo enviado»** en el buzón: Gmail guarda solo lo que se manda
  por SMTP, y con la opción activa cada mail quedaría dos veces en Enviados. (Pendiente de la
  etapa 1: que el panel la desactive solo cuando el servidor es de Gmail.)
- Las carpetas de Gmail son etiquetas: un mensaje puede estar en varias, y «mover» quita una
  etiqueta y pone otra. El gateway usa SPECIAL-USE, así que reconoce Enviados y Borradores
  aunque estén en español.
- Es un puente: una contraseña por buzón, que el administrador puede invalidar en cualquier
  momento. Pasar al adaptador (§5.2) cuando exista.

### 5.2 El definitivo: Gmail API

Dos formas de autorizar, y la elección depende de **dónde están los buzones**:

| | Cuenta de servicio con delegación de dominio | OAuth por buzón |
|---|---|---|
| Cómo | Una cuenta de servicio en un proyecto de Google Cloud **del cliente**, autorizada por el administrador de Workspace a actuar como cualquier usuario con el scope `gmail.modify` | Cada dueño de buzón autoriza una vez; el gateway guarda el token de actualización cifrado |
| Alcance | **Todos los usuarios de la cuenta de Workspace**: Google no permite acotarla a algunos buzones ni a un dominio secundario **(verificar al implementar)** | Sólo ese buzón |
| Credencial | Una por cliente | Una por buzón, que se renueva sola mientras se use |
| Verificación de Google | No hace falta | `gmail.modify` es un scope restringido: con un cliente OAuth **interno** en el proyecto de Google Cloud del cliente no hace falta verificación; con una aplicación externa de Biguá sí, con evaluación de seguridad anual **(verificar al implementar)** |
| Cuándo | Los buzones del SDR viven en **una cuenta de Workspace propia**, sólo para prospección (el dominio alternativo de `03` ítem 6 en su propia cuenta, no como dominio secundario de la principal) | Los buzones están en la cuenta de Workspace principal de la empresa |

Un único scope, `https://www.googleapis.com/auth/gmail.modify`, cubre leer, enviar, borradores y
etiquetas, sin borrado permanente. Es más chico que la suma `gmail.send` + `gmail.readonly` +
`gmail.modify` que proponía `02` §4.2.

**Recomendación:** que el dominio alternativo del SDR viva en su propia cuenta de Workspace y
usar la delegación de dominio. Así el alcance de la credencial es exactamente el SDR, que es el
mismo resultado que da Microsoft con §4.2. Si eso no es posible, OAuth por buzón con un cliente
OAuth interno en el proyecto del cliente.

### 5.3 Qué se le pide al cliente

| # | Qué | Quién |
|---|---|---|
| 1 | Con delegación: un proyecto de Google Cloud, una cuenta de servicio y su clave cargada en el panel (o generada por el panel), y la autorización en la consola de Workspace (Seguridad → Control de acceso y datos → Controles de API → Delegación de todo el dominio) con el scope `gmail.modify` | Administrador de Workspace |
| 1b | Con OAuth por buzón: un cliente OAuth interno en su proyecto de Google Cloud; después, cada dueño de buzón autoriza desde el enlace que da el panel | Administrador y cada dueño |
| 2 | La API de Gmail habilitada en el proyecto | Administrador |
| 3 | SPF con `include:_spf.google.com`, DKIM activado en la consola de Google (selector `google`), DMARC | TI del cliente (la pestaña «Dominios» lo verifica y da los pasos) |

### 5.4 Límites

- Workspace limita a 2.000 mensajes por día por usuario **(verificar al implementar)**; los
  cupos del SDR están muy por debajo.
- La API de Gmail mide cuota por unidades por usuario y por proyecto; `history.list` es barato,
  `messages.send` cuesta más. Con 429, reintentar con espera.

### 5.5 Cómo se prueba

Un servidor Gmail API de mentira en los tests (`labels`, `messages`, `history`, `send`,
`drafts`), y una cuenta de Workspace de prueba de Biguá para la prueba de punta a punta, con la
delegación configurada como la configuraría un cliente.

## 6. Etapas

Cada etapa se cierra con `npm test` en verde, el piloto de BairesQA intacto y la documentación
al día. El orden de 2 y 3 lo decide el primer cliente que llegue: si es de Google, la 3 va antes.

| Etapa | Qué | Sale cuando | Tamaño |
|---|---|---|---|
| **0** · hecho | Gateway IMAP/SMTP, panel, dominios, piloto BairesQA | — | — |
| **1** · base común | `provider` en `account`, tabla `provider_connection`, interfaz de adaptador con IMAP detrás sin cambiar su comportamiento, `id` y cursor opacos (§2.3) con compatibilidad, panel por proveedor, Gmail detectado para el puente (§5.1) | Las pruebas actuales pasan sin tocarlas y BairesQA sigue andando | Mediano |
| **2** · Microsoft 365 | Adaptador Graph, asistente de conexión con certificado, «Verificar alcance» con prueba negativa, servidor Graph de mentira, prueba en un tenant de desarrollo | Un buzón de un tenant de prueba lee, responde en hilo y respeta el cupo, y uno fuera del alcance da 403 | Grande |
| **3** · Google Workspace | Adaptador Gmail API, delegación de dominio y OAuth por buzón, servidor Gmail de mentira, prueba en una cuenta de Workspace | Lo mismo que la etapa 2, con Gmail | Grande |
| **4** · tiempo real | Suscripciones de Graph y `users.watch` de Gmail hacia el gateway, que dispara la routine por webhook (`06` 3.6) en vez de esperar al chequeo cada 15 minutos | Una respuesta de un prospecto dispara la routine en menos de un minuto | Mediano |

Mientras una etapa no esté, el camino para un cliente nuevo es:

| Cliente con buzones en | Hoy | Después de su etapa |
|---|---|---|
| Hosting genérico (cPanel, Plesk, Zimbra, DonWeb/Ferozo) | Gateway IMAP | Igual |
| Google Workspace | Gateway IMAP con contraseña de aplicación (§5.1) | Gateway con Gmail API |
| Microsoft 365 | Conector de Outlook de Grok Bot, **sólo borradores** | Gateway con Graph |
| Outlook.com o Hotmail personal | No: dominio alternativo en Microsoft 365 o Workspace | Igual |

## 7. Decisiones abiertas

| Tema | Opciones | Inclinación | Quién decide |
|---|---|---|---|
| Aplicación de Microsoft | Una por cliente (más alta, menos riesgo) o una multi-tenant de Biguá (alta en un clic, una credencial para todos) | Una por cliente hasta tener muchos clientes en Microsoft | Biguá |
| Google: delegación u OAuth por buzón | Depende de dónde estén los buzones (§5.2) | Cuenta de Workspace propia para el SDR + delegación | Biguá con el cliente, en el alta |
| Credenciales de correo en Biguá | `02` §5 decía que Biguá no guardaba la credencial de mail del cliente; con el gateway sí la guarda, cifrada | Ya pasa con IMAP: el DPA tiene que decirlo para todos los proveedores | Biguá (legal) |
| Quién configura del lado del cliente | El administrador del cliente solo, con el asistente, o en videollamada con Biguá | Videollamada las primeras veces; el asistente después | Biguá |
| Verificación de Google | Necesaria sólo si Biguá ofrece una aplicación OAuth propia a clientes externos | Evitarla: cliente OAuth interno en el proyecto del cliente | Biguá |

## 8. Cambios en otros documentos

Cuando arranque la etapa 1:

- `02-arquitectura.md` §4.2: el «módulo de mail por API» deja de vivir en los scripts del box;
  Gmail API y Graph van en el gateway. La credencial pasa de secreto de Grok Bot
  (`MAIL_CREDENTIAL`) a `provider_connection`, cifrada. §5: la fila «Casillas» y la regla de
  que Biguá no guarda la credencial de mail.
- `03-onboarding-y-prerrequisitos.md` ítem 6: el pedido al cliente según su proveedor (§4.3,
  §5.3).
- `tenant-manifest.example.yaml`, `channels.email`: `api_auth` y `api_credential_secret` se
  reemplazan por la conexión del gateway (`graph_app_rbac`, `google_dwd`, `google_oauth`).
- `07-gateway-imap.md`: deja de ser sólo IMAP; pasa a describir el gateway de correo con sus
  tres tipos de buzón.
