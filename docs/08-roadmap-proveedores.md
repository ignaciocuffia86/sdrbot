# Buzones de Microsoft 365 y Google Workspace

Estado: **es la etapa F del plan del panel (`21` §7).** Escrito el 04/11/2026 y reescrito el
10/11/2026 con el enfoque de «un clic». **F1 (el puente con el conector) está construido** (§13);
F0 son trámites de Biguá, con su lista en §14; F2 a F4 siguen propuestos. Para los buzones con
contraseña, el gateway sigue como en `07-gateway-imap.md`.

Los datos de Microsoft y Google que dependen de sus políticas están marcados **(verificar al
implementar)**: cambian seguido y hay que confirmarlos contra la documentación vigente antes de
escribir código.

## 1. Resumen

- **El camino definitivo es «un clic»**, como Woodpecker, Apollo o Klenty: el dueño de cada buzón
  aprieta «Conectar con Google» o «Conectar con Microsoft» en un enlace del panel, inicia sesión
  y acepta. Biguá tiene **una aplicación por proveedor** para todos sus clientes. El gateway
  guarda un token de ese buzón (cifrado) y sigue leyendo y enviando por **IMAP y SMTP**, pero con
  el token en lugar de la contraseña (XOAUTH2). Las reglas del gateway (cupo, idempotencia,
  campañas, aprobaciones) no cambian.
- **El cuello de botella no es el código: es la autorización de Google** (la verificación de la
  aplicación, con una evaluación de seguridad) y, en menor medida, la de Microsoft. Se pide en
  paralelo, desde el primer día.
- **Mientras tanto, para no quedar parados:**
  - **Google Workspace:** IMAP con **contraseña de aplicación** (§6.1). Funciona hoy, sin código.
  - **Microsoft 365, o Google con las contraseñas de aplicación bloqueadas:** el **conector de
    Gmail u Outlook de Grok Bot** (§7). El bot lee y escribe por el conector, y el gateway sigue
    decidiendo cupo, calibración y campañas con una reserva antes de cada envío.

## 2. Por qué «un clic» y no lo que decía la versión anterior

La versión del 04/11 proponía permisos **de aplicación** (Microsoft Graph con una aplicación por
cliente, acotada en Exchange; Google con delegación de dominio). Funcionan, pero:

| | Permisos de aplicación (versión anterior) | OAuth por buzón, «un clic» |
|---|---|---|
| Alcance de la credencial | Toda la organización del cliente, salvo que se acote (RBAC de Exchange; en Google no se puede acotar) | **Sólo ese buzón**: es un permiso delegado del usuario que se conectó |
| Qué hace el cliente | Su administrador registra una aplicación, sube un certificado, corre PowerShell, prueba el alcance; en Google crea un proyecto y una cuenta de servicio | Cada dueño de buzón hace clic y acepta. A veces el administrador da un consentimiento o habilita la aplicación, también con un clic (§4.3, §5.3) |
| Qué construye Biguá | Adaptadores de Microsoft Graph y Gmail API | El flujo OAuth y el guardado de tokens; **IMAP y SMTP siguen igual** |
| Trámite con el proveedor | Ninguno | Verificación de la aplicación de Biguá (§3) |

La versión anterior queda como **camino del administrador** (§8), para un cliente cuya área de
seguridad no acepte el OAuth por buzón.

## 3. La aplicación de Biguá y su autorización

| | Google | Microsoft |
|---|---|---|
| Aplicación | Un cliente OAuth **externo** en un proyecto de Google Cloud de Biguá | Una aplicación **multi-tenant** en el Entra ID de Biguá |
| Permisos (scopes) | `https://mail.google.com/` (lo que pide IMAP/SMTP con XOAUTH2) | `IMAP.AccessAsUser.All`, `SMTP.Send`, `offline_access` (delegados) |
| Trámite | **Verificación de la aplicación.** Los scopes de Gmail son **restringidos**: piden una evaluación de seguridad externa (CASA) que se renueva cada año, con costo y semanas de plazo **(verificar al implementar)** | **Verificación del editor** (Microsoft Partner Center, MPN ID). Más liviana **(verificar)** |
| Mientras no esté | Modo prueba: hasta 100 usuarios agregados a mano, con pantalla de advertencia, y los tokens vencen a los 7 días **(verificar)**. Sirve para Biguá y un piloto, no para clientes | Funciona; sin editor verificado, muchas organizaciones no dejan que el usuario la acepte solo y hace falta el consentimiento del administrador |
| Quién la tramita | Biguá (política de privacidad, dominio verificado, video de uso, evaluación) | Biguá (cuenta de Partner Center) |

**Se arranca con la verificación de Google apenas se decida la etapa**: es lo que más tarda y no
depende del código. Hacen falta la página de privacidad y los términos en un dominio de Biguá, y
la pantalla de consentimiento con el logo y la descripción del SDR.

## 4. Microsoft 365

### 4.1 El clic

1. En el panel, Canales → Correo → «Agregar buzón de Microsoft 365». El panel da un **enlace de
   un solo uso** para el dueño del buzón (no necesita usuario del panel).
2. El dueño inicia sesión con su cuenta de Microsoft 365 y acepta los permisos de §3.
3. Microsoft vuelve al gateway (`https://sdrbot.bigua.lat/oauth/microsoft/callback`) con un código;
   el gateway lo cambia por los tokens, comprueba que la cuenta que aceptó es la del buzón
   pedido, y lo activa.

### 4.2 Cómo trabaja el gateway

- IMAP en `outlook.office365.com:993` y SMTP en `smtp.office365.com:587`, con XOAUTH2 y el token de
  acceso (dura alrededor de una hora; el gateway lo renueva con el de actualización antes de usarlo).
- Si Microsoft rechaza la renovación (la contraseña cambió, el administrador revocó, la cuenta se
  desactivó), el buzón pasa a `auth_error`, se frena y el panel muestra «Volver a conectar», como
  hoy con una contraseña rechazada.

### 4.3 Qué se le pide al cliente

| # | Qué | Quién |
|---|---|---|
| 1 | Licencia de Exchange Online en cada buzón del SDR | TI del cliente |
| 2 | **SMTP con OAuth habilitado en cada buzón del SDR.** En muchas organizaciones viene apagado: `Set-CASMailbox <buzón> -SmtpClientAuthenticationDisabled $false` **(verificar)** | Administrador de Exchange |
| 3 | Si la organización no deja que los usuarios acepten aplicaciones: **consentimiento del administrador** para la aplicación de Biguá, una vez, desde el enlace que da el panel | Administrador de Entra ID |
| 4 | Cada dueño de buzón: el clic de §4.1 | Cada dueño |
| 5 | SPF con `include:spf.protection.outlook.com`, DKIM activado, DMARC (la pestaña «Dominios» lo verifica y da los pasos) | TI del cliente |

Outlook.com y Hotmail personales no sirven para prospectar (sin dominio propio, límites bajos):
la respuesta es un dominio alternativo en Microsoft 365 o Workspace (`03` ítem 6).

### 4.4 Límites

Exchange Online limita a 30 mensajes por minuto y 10.000 destinatarios por día por buzón
**(verificar)**; los cupos del SDR están muy por debajo. Microsoft anunció en su momento un límite
de destinatarios externos por día y lo postergó **(verificar)**: si entra en vigor, el cupo del
panel tiene que quedar por debajo.

## 5. Google Workspace

### 5.1 El clic

Igual que §4.1, con «Conectar con Google» y el callback `https://sdrbot.bigua.lat/oauth/google/callback`.
IMAP en `imap.gmail.com:993` y SMTP en `smtp.gmail.com:465`, con XOAUTH2.

### 5.2 Detalles de Gmail

- **Desactivar «Guardar copia de lo enviado»** en esos buzones: Gmail guarda solo lo que se manda
  por SMTP, y con la opción activa cada mail quedaría dos veces en Enviados. El panel la apaga sola
  cuando el buzón es de Google.
- Las carpetas son etiquetas: un mensaje puede estar en varias, y «mover» quita una y pone otra.
  El gateway usa SPECIAL-USE, así que reconoce Enviados y Borradores aunque estén en español.

### 5.3 Qué se le pide al cliente

| # | Qué | Quién |
|---|---|---|
| 1 | Si la consola de Workspace restringe las aplicaciones de terceros: **habilitar la aplicación de Biguá** (Seguridad → Controles de API → Acceso de aplicaciones de terceros) **(verificar)** | Administrador de Workspace |
| 2 | Cada dueño de buzón: el clic de §5.1 | Cada dueño |
| 3 | SPF con `include:_spf.google.com`, DKIM activado (selector `google`), DMARC | TI del cliente |

### 5.4 Límites

Workspace limita a 2.000 mensajes por día por usuario **(verificar)**; los cupos del SDR están muy
por debajo.

## 6. Mientras la aplicación no está verificada

### 6.1 Google: contraseña de aplicación (hoy, sin código)

Para un cliente en Workspace:

- El buzón se carga como uno IMAP de hoy, con `imap.gmail.com` (993, TLS) y `smtp.gmail.com`
  (465, TLS), el usuario con la dirección completa y una **contraseña de aplicación** de esa cuenta
  (requiere verificación en dos pasos y que el administrador no las haya bloqueado).
- Con «Guardar copia de lo enviado» apagado (§5.2).
- Cuando la aplicación de Biguá esté verificada, el buzón pasa a «un clic» sin perder su
  historial: es la misma fila de `mailgw.account`, cambia la credencial.

### 6.2 Microsoft, o Google sin contraseñas de aplicación

No hay forma de entrar al gateway sin OAuth: Microsoft apagó la contraseña para IMAP en 2022 y
para SMTP en 2026 **(verificar)**. El puente es el conector de Grok Bot (§7).

## 7. Salida rápida: Grok Bot con el conector del buzón

### 7.1 Por qué sirve

Los conectores de Gmail y Outlook de Grok Bot se autorizan con la aplicación **de Grok**, que ya
está verificada por Google y Microsoft: el dueño del buzón lo conecta en la cuenta de Grok del
cliente con un clic, hoy. Los tokens quedan en el backend de Grok y el bot usa las herramientas
del conector sin verlos (`12` 3.2).

Lo que se pierde, y por qué la versión anterior lo descartaba como definitivo: **el gateway no
está en el camino del envío**. Lo manda el bot por el conector. El cupo, la idempotencia, la
calibración y las campañas dejarían de estar en código. Por eso el puente se arma así:

### 7.2 Cómo se arma: el gateway reserva, el bot envía, el gateway concilia

Un tipo de buzón nuevo, **`conector`**: una fila de `mailgw.account` sin credenciales ni
servidores, con su cupo, su campaña y su estado como cualquier otro. Tres herramientas MCP nuevas:

| Herramienta | Qué hace |
|---|---|
| `correo_conector_reservar` | Antes de cada envío. Recibe lo mismo que `enviar` (buzón, destinatarios, asunto, texto, `prospecto_id`, aprobación, clave de idempotencia) y corre **los mismos controles** que `enviar`: cupo del día, idempotencia, campaña activa y buzón de la campaña, calibración y aprobación, no contactar, supresiones, links permitidos, prospecto que ya respondió. Si pasa, reserva el lugar en `mailgw.send_log` y devuelve un `permiso`. Si no, el error de siempre (`cap_reached`, `aprobacion_requerida`…) |
| `correo_conector_confirmar` | Después de enviar por el conector: el `permiso` y el `Message-ID` (o el id del conector). Cierra la reserva y registra `mail.enviado` en el registro, como hoy hace `enviar` |
| `correo_conector_recibido` | `seguimiento` le pasa al gateway lo que leyó por el conector (remitente, asunto, texto, fecha, ids del hilo). Entra en la memoria del correo (`sdr.correo`) y sigue el mismo camino que lo que hoy lee el reloj: respuestas, rebotes, bajas, freno de la secuencia |

Las reglas de los bots, para un buzón `conector`:

- `prospector`: «Un mail por conector: primero `correo_conector_reservar`; si no da permiso, no
  lo mandes. Con el permiso, mandalo por el conector **exactamente** como lo reservaste, y
  `correo_conector_confirmar`. Nunca mandes por el conector sin permiso».
- `seguimiento`: lee el buzón por el conector en cada corrida, pasa cada mail nuevo con
  `correo_conector_recibido` y responde con la misma pareja reservar/confirmar.

### 7.3 Lo que el gateway no puede impedir, y cómo se controla

- **Un envío sin reserva.** El gateway no está en el medio. Se controla por conciliación: una vez
  por día el bot lista lo enviado por el conector (`Enviados` del día) y lo pasa al gateway, que
  compara con las reservas. **Un envío sin reserva pausa el buzón** (estado `paused`, alerta en el
  panel) hasta que Biguá lo revise.
- **Un envío distinto de lo reservado** (otro destinatario, otro texto): la conciliación compara
  destinatarios y un hash del texto; si no coinciden, lo mismo.
- **Los conectores los ven todos los bots de la cuenta** (`06` 5.1, `12` 3.6): una cuenta de Grok
  por cliente (ya es así), y las reglas dicen qué bot usa el conector y para qué. La revisión
  automática de Grok (Auto Review) con la herramienta de enviar del conector en «Ask first» para
  los bots que no la usan **(verificar si se puede por herramienta)**.
- **Cupo conservador:** un buzón `conector` arranca con un cupo bajo (10 por día, hasta 40) y en
  calibración propia: sus primeros 5 mails nuevos (`mailgw.account.calibracion`) salen con
  aprobación, aunque la campaña ya haya terminado la suya.

### 7.4 Modo borradores, para arrancar el primer día

Con un cliente desconfiado, o el primer día: el bot **sólo crea borradores** por el conector y una
persona del cliente los manda. Es lento pero no tiene riesgo de envío. Es un modo del buzón
(`mailgw.account.conector_modo`: `borradores`, el valor con que nace, o `envio`), que cambia
Biguá en el panel:

- el bot reserva igual (mismos controles y cupo), pero la respuesta dice `modo: "borradores"`:
  crea el borrador exactamente con lo reservado y **no confirma** (si lo intenta,
  `buzon_en_borradores`);
- la conciliación diaria encuentra el mail entre los enviados cuando la persona lo manda, aunque
  sea días después, y lo confirma; la reserva de un borrador que no se mandó se libera a los 7
  días;
- un mail que la persona manda sin reserva pausa el buzón, igual que en el modo envío.

### 7.5 Cuándo se sale del puente

Cuando la aplicación de Biguá del proveedor está verificada (§3): el dueño del buzón hace el clic
de «un clic», el buzón pasa de `conector` a `oauth` (misma fila, mismo historial y mismo cupo), se
desconecta el conector de Grok y las reglas vuelven a `enviar` y al reloj.

## 8. Camino del administrador (alternativa)

Para un cliente cuya seguridad no acepte que cada usuario autorice una aplicación externa, o que
prefiera que la credencial sea de la organización:

- **Microsoft:** una aplicación registrada en el Entra ID del cliente, con certificado, permisos de
  aplicación `Mail.ReadWrite` y `Mail.Send` **acotados en Exchange con RBAC para aplicaciones** a
  los buzones del SDR, y una prueba negativa de alcance en el panel (un buzón fuera del SDR tiene
  que dar 403). Sin acotar, ese permiso deja leer el correo de toda la empresa.
- **Google:** cuenta de servicio con delegación de dominio en un proyecto del cliente, sólo si los
  buzones del SDR viven en una cuenta de Workspace propia (la delegación no se puede acotar a
  algunos buzones **(verificar)**). Si no, OAuth por buzón con un cliente OAuth **interno** en el
  proyecto del cliente, que no necesita la verificación de Google.

Necesita los adaptadores de Microsoft Graph y Gmail API (permisos de aplicación no sirven para
IMAP con XOAUTH2 en Google; en Microsoft sí con `IMAP.AccessAsUser.All` de aplicación
**(verificar)**). Se construye sólo si un cliente lo pide.

## 9. Cambios en el gateway

### 9.1 Base

- `mailgw.account.auth`: `password` (lo de hoy), `oauth` o `conector`. Con `oauth` y `conector`,
  `secret_enc`, `username` y servidores no aplican (los servidores de Google y Microsoft son fijos).
- `mailgw.account.provider`: `imap`, `google` o `microsoft`.
- Tabla nueva `mailgw.oauth_token`: una fila por buzón con el token de actualización **cifrado con
  `MAILGW_ENC_KEYS`** (AAD propio, como las contraseñas), el de acceso y su vencimiento, los scopes
  concedidos, la cuenta que aceptó y el estado. Misma seguridad por filas por cliente que el resto.
- Tabla `mailgw.oauth_estado` para el flujo: el `state` y el verificador PKCE de cada enlace de un
  solo uso, con vencimiento corto.

### 9.2 Código

- `src/mail/oauth.mjs`: armar el enlace (código de autorización con PKCE y `state`), el callback,
  el cambio de código por tokens, la renovación con un candado por buzón (dos pedidos a la vez no
  renuevan dos veces) y la revocación al dar de baja un buzón.
- `src/mail/imap.mjs` y `smtp.mjs`: con `auth = 'oauth'`, `accessToken` en lugar de la contraseña
  (imapflow y nodemailer lo aceptan **(verificar en el código)**). Un 401 de renovación es un
  `auth_error`, como hoy una contraseña rechazada.
- El panel: el alta por proveedor, el enlace para el dueño, «Volver a conectar», el estado del
  token.
- Las herramientas del §7.2 y la conciliación, para el puente.

### 9.3 Lo que no cambia

Las herramientas MCP de correo (`enviar`, `responder`, `buscar`…), el cupo, la idempotencia, el
registro de envíos, las campañas y sus buzones (`sdr.campana_buzon` apunta a `mailgw.account`), la
memoria del correo y el reloj para los buzones `oauth` (siguen con `uid` de IMAP, que XOAUTH2
mantiene), y las reglas de los bots para los buzones que no son `conector`.

Los buzones `conector` no tienen `uid`: lo que entra por `correo_conector_recibido` se guarda en
`sdr.correo` con el id del conector y el `Message-ID`, y `seguimiento` responde con ese id. Es el
primer paso del `id` opaco que necesitarán los adaptadores de API (F4).

### 9.4 Cómo se prueba

- Un servidor OAuth de mentira en los tests (autorización, cambio de código, renovación,
  revocación, errores) y Dovecot con XOAUTH2 contra ese servidor, o un IMAP de mentira que acepte
  el token **(a definir al implementar)**.
- Un Workspace y un tenant de Microsoft 365 de prueba de Biguá, con la aplicación en modo prueba,
  para la prueba de punta a punta.
- El puente: las tres herramientas y la conciliación con envíos reservados, sin reservar y
  distintos de lo reservado.

## 10. Etapas

| Etapa | Qué | Sale cuando | Tamaño |
|---|---|---|---|
| **F0 · Trámites** (en paralelo, desde ya) | Verificación de la aplicación de Google; verificación de editor de Microsoft; página de privacidad y términos | Las dos aplicaciones aprobadas | Trámite, semanas |
| **F1 · Puente con conector** | Tipo `conector`, `correo_conector_reservar`/`confirmar`/`recibido`, conciliación diaria, reglas para buzones `conector`, modo borradores | Un buzón de Microsoft 365 conectado en Grok manda un mail reservado, se registra, y un envío sin reserva pausa el buzón | Mediano |
| **F2 · Un clic** | `oauth_token`, flujo OAuth, IMAP/SMTP con XOAUTH2, panel, renovación y revocación | Un buzón de Workspace y uno de Microsoft 365 conectados con un clic leen, responden en hilo y respetan el cupo, con la aplicación en modo prueba | Mediano |
| **F3 · Pasar del puente a un clic** | Con las aplicaciones verificadas: los buzones `conector` pasan a `oauth` | Ningún buzón queda en el puente | Chico |
| **F4 · Tiempo real y camino del administrador** | Adaptadores de Microsoft Graph y Gmail API, avisos al instante (suscripciones de Graph, `users.watch` de Gmail), permisos de aplicación (§8) | Sólo si un cliente lo pide o el chequeo cada 15 minutos no alcanza | Grande |

Qué usa un cliente nuevo según dónde están sus buzones:

| Buzones en | Hoy | Con F1 | Con F2 y F3 |
|---|---|---|---|
| Hosting genérico (cPanel, Plesk, Zimbra, DonWeb/Ferozo) | Gateway IMAP | Igual | Igual |
| Google Workspace | IMAP con contraseña de aplicación (§6.1) | Igual, o conector si están bloqueadas | Un clic |
| Microsoft 365 | Conector de Outlook, sólo borradores (§7.4) | Conector con reserva (§7.2) | Un clic |
| Outlook.com o Hotmail personal | No: dominio alternativo en Microsoft 365 o Workspace | Igual | Igual |

## 11. Decisiones abiertas

| Tema | Opciones | Inclinación | Quién decide |
|---|---|---|---|
| ¿Pedir ya la verificación de Google? | Ahora (semanas de plazo, costo anual de la evaluación) o cuando llegue un cliente de Google | Ahora: es lo único que no se acelera con trabajo | Biguá |
| ¿El puente manda o sólo hace borradores? | Borradores siempre, o envío con reserva y conciliación | Envío con reserva, con cupo bajo y calibración; borradores el primer día | Biguá con cada cliente |
| Tokens de muchos clientes en Biguá | Ya pasa con las contraseñas IMAP; los tokens se revocan al dar de baja | El DPA lo tiene que decir para todos los proveedores | Biguá (legal) |
| Camino del administrador | Construirlo de entrada o a pedido | A pedido | Biguá |

## 12. Cambios en otros documentos

Con F1 se actualizaron `07` (la nota sobre los buzones por conector) y `15` §3 (el alta). Quedan
para F2, cuando el correo de Google y Microsoft vaya por el gateway:

- `02-arquitectura.md` §4.2 y §5: el correo de Google y Microsoft va por el gateway; el conector de
  Grok queda sólo como puente con reserva.
- `03-onboarding-y-prerrequisitos.md` ítem 6: lo que se le pide al cliente según su proveedor
  (§4.3, §5.3).
- `07-gateway-imap.md`: deja de ser sólo IMAP con contraseña; describe los tres tipos de
  credencial (`password`, `oauth`, `conector`).
- `15-alta-de-un-cliente.md`: el alta de buzones por proveedor.

## 13. F1: lo construido

| Pieza | Dónde |
|---|---|
| El buzón por conector: `auth = 'conector'`, `provider`, sin credencial ni servidores; `calibracion` y `conector_modo` | `gateway/db/migrations/017_buzon_por_conector.sql` |
| El libro de envíos: `send_log.via` (`gateway` o `conector`) y `send_log.conector` (lo reservado: destinatarios, asunto, huella del texto, aprobación, prospecto, campaña, hilo) | La misma migración |
| `correo_conector_reservar`, `confirmar`, `recibido` y `conciliar` | `gateway/src/sdr/conector.mjs`, en `src/ops.mjs` (REST y MCP) |
| `enviar`, `responder`, «Probar» y la contraseña rechazan un buzón por conector (`buzon_por_conector`); el reloj no lo lee | `src/ops.mjs`, `src/sdr/correo.mjs`, `src/admin/servicio.mjs` |
| El alta en el panel (sólo Biguá): **Canales** → **Correo** → «Buzón por conector», con el modo, el cupo (1 a 40) y la calibración | `src/admin/static/app.js`, `POST /admin/api/clients/:client/mailboxes/conector` |
| Las reglas: «Buzones por conector» en `comun.md`; el envío en `prospector` (diaria y aprobados); la lectura y las respuestas en `seguimiento`; la conciliación en el resumen del `orquestador` | `playbooks/` |
| Las pruebas: reservar y confirmar, idempotencia, destinatario que no coincide, recibido y respuesta, cupo, conciliación que confirma, pausa y libera, calibración del buzón, modo borradores, el alta del panel | `gateway/test/conector.test.mjs` |

Cómo funciona `correo_conector_conciliar`: empareja cada mail enviado por `Message-ID` o id del
conector y, si no, por destinatarios y asunto; confirma las reservas que todavía no se habían
confirmado; avisa (`texto_distinto`) si el texto no es el reservado, sin pausar; libera las
reservas de un día que ya pasó que no salieron (en borradores, a los 7 días), y **pausa el buzón**
y le avisa al orquestador si hay mails sin reserva.

Para salir con un cliente: aplicar la migración 017 en producción, publicar las reglas, dar de
alta el buzón en borradores, conectar el buzón en la cuenta de Grok del cliente y, en la
revisión automática de Grok, dejar la herramienta de enviar del conector en «Ask first» para los
bots que no la usan **(verificar si se puede por herramienta)**. Con unos días sin sorpresas en
la conciliación, Biguá lo pasa a envío.

## 14. F0: los trámites, paso a paso

Los hace Biguá; no dependen del código. Conviene arrancar ya con Google, que es lo que más tarda.
Lo marcado **(verificar)** cambia seguido: confirmarlo contra la documentación vigente al
iniciar cada trámite.

**Lo común a los dos**

- [ ] Dominio de Biguá con una página pública del producto (qué hace el SDR, para quién).
- [ ] **Política de privacidad** en ese dominio: qué datos del correo se leen, para qué, dónde se
      guardan (Supabase, Vercel), cuánto tiempo, cómo se borran y cómo se revoca el acceso. Tiene
      que decir que los datos de Gmail no se usan para entrenar modelos ni para publicidad
      (política de «Limited Use» de Google) **(verificar redacción)**.
- [ ] **Términos del servicio** en el mismo dominio.
- [ ] Un correo de soporte y un responsable con nombre.
- [ ] Logo cuadrado y nombre de la aplicación iguales en las dos consolas.
- [ ] El DPA de los clientes menciona a Google y Microsoft como proveedores de buzones (§11).

**Google (verificación de la aplicación)**

- [ ] Proyecto de Google Cloud de Biguá, con facturación, a nombre de la empresa.
- [ ] Dominio verificado en Google Search Console con la cuenta dueña del proyecto.
- [ ] Pantalla de consentimiento: tipo **externo**, nombre, logo, dominios autorizados, enlaces a
      privacidad y términos, correo de soporte.
- [ ] Cliente OAuth (aplicación web) con el `redirect_uri` del gateway
      (`https://sdrbot.bigua.lat/…`, se define en F2).
- [ ] Scope `https://mail.google.com/` (IMAP y SMTP con XOAUTH2), con una justificación escrita
      de por qué no alcanza uno menor.
- [ ] Video en YouTube (no listado) que muestre el flujo completo: el clic, la pantalla de
      consentimiento con el `client_id` visible y qué hace la aplicación con el correo.
- [ ] Enviar a verificación. Al ser un scope **restringido**, Google pide además la
      **evaluación de seguridad CASA** con un evaluador autorizado: costo anual y semanas de
      plazo, renovación cada 12 meses **(verificar costo y nivel)**.
- [ ] Mientras tanto, modo prueba con los buzones de Biguá y del piloto agregados como usuarios
      de prueba (sirve para F2).

**Microsoft (verificación del editor)**

- [ ] Cuenta en **Microsoft Partner Center** de la empresa (Microsoft AI Cloud Partner Program),
      con su identificador de partner (antes MPN ID).
- [ ] Aplicación **multi-tenant** registrada en el Entra ID de Biguá, con el `redirect_uri` del
      gateway, los permisos delegados `IMAP.AccessAsUser.All`, `SMTP.Send` y `offline_access`.
- [ ] Dominio del editor verificado en la aplicación (el mismo de la política de privacidad).
- [ ] Asociar el identificador de partner a la aplicación: queda como **editor verificado** (el
      tilde azul en la pantalla de consentimiento) **(verificar requisitos vigentes)**.
- [ ] Enlaces a privacidad y términos en la «Marca» de la aplicación.
- [ ] Probar con un tenant de Microsoft 365 de Biguá: un usuario común puede aceptar, o hace falta
      el consentimiento del administrador según la política del tenant (§4.3).

Sale cuando las dos aplicaciones están aprobadas: ahí arranca F3 (pasar los buzones del puente a
un clic).
