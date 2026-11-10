# Alta de un cliente: el procedimiento de Biguá

Paso a paso para dar de alta un cliente nuevo en el SDR de Biguá. Lo hace un **operador de Biguá**;
no hace falta ser desarrollador ni tener acceso a Supabase. Escrito el 05/11/2026 a partir del alta
de BairesQA, el primer cliente.

Los tres documentos del alta:

| Documento | Para quién | Qué cubre |
|---|---|---|
| **15 · este** | Operador de Biguá | Todo lo que configura Biguá: panel, ASCI, token, cuenta de Grok, routines y despertador |
| [16 · Guía del cliente](16-guia-del-cliente.md) | El cliente | Su usuario, sus buzones, su dominio y los ajustes de su SDR (oferta, tono, firma…) |
| [17 · Puesta en marcha, operación y baja](17-puesta-en-marcha-operacion-y-baja.md) | Operador de Biguá y equipo técnico | Pruebas de arranque, calibración, lanzamiento, el día a día, renovaciones, baja y lo que todavía hace el equipo técnico |

Este documento reemplaza a `13` §2 y, para el SDR v2, al runbook de `03` §3.

## Resumen del orden

```
Reunión de inicio  →  1. Cliente en el panel  →  2. Usuario del cliente  →  3. Buzones (el cliente)
→  4. Dominio  →  5. Activar el SDR  →  6. Usuario de ASCI  →  7. Token del gateway
→  8. Cuenta de Grok Bot  →  9. Routines  →  10. Despertador  →  11. LinkedIn (Dripify)  →  11b. CRM (HubSpot)
→  12. Comprobar  →  doc 17
```

Los pasos 3 y 4 y los ajustes del SDR los hace el cliente con la guía `16`, en paralelo con los
pasos 6 a 8. El tiempo total, con el cliente disponible, es de una o dos horas, más lo que tarde el
cambio de DNS si hace falta.

## 0. Antes de empezar: la reunión de inicio

Lo que hay que tener del cliente:

| Qué | Para qué | Ejemplo (BairesQA) |
|---|---|---|
| Nombre e **identificador** del cliente | El id va en todo y no se cambia: minúsculas, números y guiones | `bairesqa` |
| Quién va a usar el panel (nombre y email) | Su usuario para cargar buzones y ajustes | Una o dos personas |
| Qué buzones va a usar el SDR y dónde están (hosting, Google, Microsoft) | Hoy el gateway habla IMAP y SMTP. Google Workspace y Microsoft 365 están en `08` | `augonzalez@bairesqa.net`, en un hosting con IMAP |
| Quién tiene la contraseña de cada buzón | La carga esa persona en el panel; no viaja por mail ni por chat | El cliente |
| Quién administra el DNS del dominio | Para SPF, DKIM y DMARC (paso 4) | TI del cliente o el proveedor |
| A quién le venden, qué ofrecen, tono y firma | Los ajustes del SDR; los carga el cliente (`16` §4) | — |
| A quién no escribirle nunca: clientes actuales, partners, competidores | La lista de no contactar; la carga el cliente, también por CSV (`16` §5) | Exportación de clientes del CRM |
| Si se autogestiona o lo opera Biguá | El modo de operación (paso 5) | Operado por Biguá |
| Cuántos mails por día puede mandar cada buzón | El cupo del gateway va por debajo del límite del hosting | 40 |

**Cobertura de ASCI.** Los bots no scrapean avisos: los toman de ASCI, que los ingiere una vez por
día (`09` §6.1). Antes de comprometer el arranque, confirmar con el equipo de ASCI que haya avisos
recientes de los **mercados y verticales del cliente**. Un mercado que ASCI no cubre (hoy España y
EE. UU.) necesita un trabajo de Apify propio hacia la ingesta de ASCI antes del lanzamiento.

Decisiones de Biguá para este cliente:

- **Dónde corre la cuenta de Grok Bot.** Por defecto, una cuenta de Biguá por cliente, con su asiento
  (`03` §6, decisión 2).
- **Volumen inicial:** cuántas cuentas nuevas por día durante la calibración (sugerido: 5).

## 1. Crear el cliente en el panel

`https://sdrbot.bigua.lat/admin` → **Clientes** → **Nuevo cliente**.

- **Nombre:** cómo se ve en el panel (por ejemplo «BairesQA»).
- **Identificador:** el id (por ejemplo `bairesqa`). **No se puede cambiar después.**

## 2. Crear el usuario del cliente

Cliente → **⚙ Administración** → **Usuarios** → **Agregar usuario**, con nombre y email de la persona.

El panel muestra un **enlace de activación** que sirve una sola vez y por 24 horas. Mandáselo por
un canal seguro (no en un grupo). Con ese enlace elige su contraseña (mínimo 12 caracteres). Si
vence, «Nuevo enlace» en el mismo lugar.

Ese usuario ve y administra **sólo su cliente**: sus buzones, su dominio, los ajustes de su SDR y la
actividad. No ve tokens, ni usuarios, ni lo técnico del SDR.

## 3. Buzones (los carga el cliente)

Lo ideal es que el cliente cargue sus buzones con la guía `16` §2: así la contraseña no pasa por
nadie de Biguá. Si lo hace Biguá en una llamada, que sea el cliente quien escriba la contraseña.

Lo que revisa Biguá en la pestaña **Canales** → **Correo**:

- **«Probar»** da IMAP y SMTP «conecta».
- **Tope de envíos por día** por debajo del límite del hosting. Para empezar, entre 20 y 40.
- **Nombre que ve el destinatario** con el nombre de la persona que firma.

Un buzón **bloqueado por contraseña** (tres fallas seguidas) se reactiva cargando la correcta.

## 4. Dominio: SPF, DKIM y DMARC

Pestaña **Canales**, debajo de los buzones → **Verificar**. Cada aviso trae «Cómo arreglarlo» con el registro listo para
copiar. Lo publica quien administra el DNS del cliente (`16` §3) y se vuelve a verificar.

No arrancar los envíos con SPF o DKIM en rojo: los mails van a spam.

## 5. Activar el SDR

**⚙ Administración** → **Operación**. Si el cliente no lo tiene activado, aparece **Activar el SDR**:

| Campo | Valor para arrancar |
|---|---|
| Canal de reglas | `estable` (el `canario` es para probar reglas nuevas) |
| Zona horaria | La del cliente (`America/Argentina/Buenos_Aires`) |
| Calibración | **20**: los primeros 20 mails nuevos se aprueban uno por uno en el chat |
| Bots activos | `orquestador`, `prospector` y `seguimiento` (`whatsapp` todavía no) |
| Modo de operación | **Operado por Biguá**, salvo que el cliente se autogestione: entonces el volumen, los buzones y los mails extrapolados los decide el cliente, con un tope de cuentas por día |

**Activar el SDR.** Después, en la pestaña **Empresa**, bloque **Operación**, los campos que son de
Biguá (en un cliente autogestionado, los carga el cliente):

- **Qué buzón usar para qué**, si hay más de uno (por ejemplo «ventas@ para Argentina, info@ para
  Chile»).
- **Cuentas nuevas por día:** 5 durante la calibración; después, según el cupo de los buzones.
- **Acepta mails extrapolados:** «no» salvo que el cliente lo pida.

El resto de los ajustes (oferta, ICP, cargos, tono, firma, casos citables, qué le pedimos al
prospecto, objeciones, positivos, quién toma a los interesados, link de agenda) y la lista de **no
contactar** los carga el cliente (`16` §4 y §5). Biguá los revisa antes del primer envío. La
**señal en los avisos** (cómo se le piden los avisos a ASCI) la carga siempre Biguá.

## 6. Usuario de ASCI para el bot

El `prospector` busca cuentas y decisores en ASCI con un usuario propio del cliente. Desde un
cliente MCP conectado a ASCI como administrador (por ejemplo Claude), con la herramienta
`crear_usuario`:

| Campo | Valor |
|---|---|
| `email` | Uno propio del bot, que no sea de una persona (por ejemplo `bigua.<cliente>@gmail.com`) |
| `nombre` | `Bot <Cliente>` |
| `rol` | **`operador`** por ahora (ver abajo) |
| `dias_de_validez` | 365 |

La clave se muestra **una sola vez**; la base guarda sólo el hash. Se conecta en Grok en el paso 8.

**Sobre el rol.** El rol `sdr_bot` (`04`), con tope diario de créditos y sin herramientas de
curación, todavía no existe en ASCI. Mientras tanto el bot usa `operador`, que además puede curar
cuentas y cargar archivos. Por eso en el paso 8 esas herramientas no van en «Allow». Cuando exista
`sdr_bot`, se le cambia el rol al usuario con `actualizar_usuario` (`17` §8).

## 7. Token del gateway para Grok

Cliente → **⚙ Administración** → **Tokens de Grok Bot** → **Generar token**:

- **Nombre:** `GrokBot <Cliente>`.
- **Permisos:** `read`, `draft`, `send` y **`sdr`**. Sin `manage`.
- **Vence en:** 120 días. Se renueva antes (`17` §6).

El token se muestra **una sola vez**. Se pega directo en el conector de Grok (paso 8), sin pasar
por un chat ni un mail.

## 8. Cuenta de Grok Bot

En la cuenta de Grok Bot del cliente:

1. **Tres bots**, con estos nombres exactos: `orquestador`, `prospector`, `seguimiento`.
2. **Conectores:**

   | Conector | Dirección | Autenticación | En qué bots |
   |---|---|---|---|
   | SDRBOT | `https://sdrbot.bigua.lat/mcp` | Cabecera `Authorization: Bearer <token del paso 7>` | Los tres |
   | ASCI | `https://mcp.bigua.lat/mcp` | OAuth entrando con el email del usuario del paso 6, o la cabecera `Authorization: Bearer <clave del paso 6>` | `prospector` |

3. **Revisión automática:**
   - **Allow:** todas las herramientas de SDRBOT salvo `registro_aprobar`, y las de ASCI que usa el
     `prospector`: `prospectar`, `resolver_cuentas`, `novedades`, `rotacion`, `presencia`,
     `evidencia`, `productos`, `roles_objetivo`, `tomadores_de_decision`, `buscar_contactos`,
     `revelar_lote`, `revelar_contacto` y `hallazgos`.
   - **Ask first:** `registro_aprobar` (así nadie aprueba algo solo, ni engañado por un mail) y las
     de ASCI que el bot no necesita: `confirmar_cuenta`, `revertir_cuenta`, `guardar_contactos`,
     `guardar_hallazgos`, `radiografia`, `cargar_archivo`, `estado_carga`, `personas`,
     `personas_por_texto` y `personas_por_mail`.

   Una herramienta en «Ask first» dentro de una routine vence a los 30 minutos y la tarea no sale
   (`12` A.2): por eso todo lo que los bots usan en sus routines va en «Allow».
4. **Privacy Mode** prendido en la cuenta.
5. **Notificaciones** prendidas en el `orquestador`: es por donde le llegan al operador las
   aprobaciones.

## 9. Alta de las routines

En el chat del `orquestador`:

> Sos el orquestador del SDR de Biguá para <Cliente>. Hacé el alta: pedí tus reglas con
> reglas_manual (bot orquestador, tarea alta) y seguilas.

El orquestador crea sus cuatro routines y les pide a los otros dos bots que creen las suyas: en
Grok cada bot crea sólo sus propias routines. Si un bot no contesta, escribile directo:

> Creá tus routines del SDR: llamá reglas_alta y creá o actualizá sólo las tuyas, con el cron, el
> timing y el prompt tal cual.

Tienen que quedar **siete**, en la zona horaria del cliente:

| Bot | Routine | Cuándo |
|---|---|---|
| `orquestador` | SDR · plan del día | Lunes a viernes 8:45 |
| `orquestador` | SDR · aprobaciones | Lunes a viernes 12:00 y 16:00, **más webhook** |
| `orquestador` | SDR · resumen | Lunes a viernes 18:30 |
| `orquestador` | SDR · memorias | Viernes 17:00 |
| `prospector` | SDR · tanda | Lunes a viernes 9:15 |
| `prospector` | SDR · aprobados | Lunes a viernes 11:30 y 15:30 |
| `seguimiento` | SDR · respuestas | Lunes a viernes 10, 13, 16 y 19, **más webhook** |

Fijate en la app de Grok que estén las siete y habilitadas.

## 10. Los dos despertadores

El gateway despierta a dos bots por el webhook de su routine, sin esperar a su horario:

| Despertador | Routine en Grok | Cuándo avisa |
|---|---|---|
| **De seguimiento** | «SDR · respuestas» del bot `seguimiento` | Llegó correo para atender (una respuesta, un rebote, una baja) |
| **Del orquestador** | «SDR · aprobaciones» del bot `orquestador` | Hay aprobaciones pendientes; primero la respuesta a un positivo |

Para cada uno:

1. En la app de Grok, abrí esa routine y copiá la **URL** y la **clave** del webhook.
2. Panel → cliente → **⚙ Administración** → **Bots y despertadores** → el de ese bot: pegá las dos. El horario por
   defecto (8 a 20 h, lunes a viernes, 10 minutos entre avisos) sirve para arrancar.
3. **Cargar despertador.**

La clave se guarda cifrada y no se vuelve a mostrar. Si sólo cambiás el horario, dejala vacía. Sin
despertador el bot corre igual, pero sólo en su horario: una respuesta a un positivo puede esperar
hasta la routine de las 12 o de las 16.

## 11. LinkedIn por Dripify

Si el cliente va también por LinkedIn. Lo que se arma en Dripify (plan con Open API, los campos
`sdr_nota`, `sdr_mensaje1` y `sdr_mensaje2`, la campaña esqueleto activa) y el detalle están en
[`20`](20-etapa-3-linkedin-dripify.md) §2 y §3. En el panel:

1. Pestaña **Canales** → **LinkedIn · Dripify**: la API key (la pega el cliente o Biguá ahí, nunca por
   chat), el id de la campaña y el largo máximo de la nota (300 con LinkedIn Premium, 200 sin).
2. **Probar:** tiene que decir «listo».
3. **Generar URL del webhook** y cargarla en la campaña de Dripify, una por disparador, con
   `?e=invitacion`, `?e=conexion`, `?e=mensaje` y `?e=respuesta` al final.

Sin Dripify, el SDR va sólo por mail: los bots lo ven en `dripify_estado` y no cargan nada.

## 11b. CRM: HubSpot

Si el cliente quiere que los interesados entren solos a su HubSpot (`23`). Lo conecta el cliente
(guía `16` §7.1) o Biguá con él:

1. En HubSpot, una **app privada** con los scopes de `23` §13.2. El token se pega en el panel
   (pestaña **Canales** → **CRM**), nunca por chat.
2. **Probar conexión:** tiene que decir «listo». Después elegir la **propiedad de origen** (si el
   cliente tiene una, por ejemplo «Origen del lead», con un valor que diga SDR) y el **dueño por
   defecto**, y **Guardar**.
3. Si el CRM del cliente exige propiedades propias para crear un contacto, cargarlas en **Campos
   fijos** (sólo Biguá).
4. **Vista previa:** revisar con el cliente cómo va a quedar un positivo (no escribe nada).

Desde ahí, cada respuesta a un positivo que el operador aprueba entra sola al CRM en el próximo
minuto. Sin CRM conectado no pasa nada: el positivo queda en el registro, como hasta ahora.

## 12. Comprobar

- En el chat del `orquestador`: «Llamá registro_agenda y decime qué ves». Tiene que contestar con
  la agenda (vacía) sin errores.
- Panel → pestaña **Actividad**: aparecen las llamadas de los bots.
- Pestaña **Empresa**: la vista previa «Así lo leen los bots» muestra los ajustes del cliente.
- Pestaña **Resumen**: «Necesita atención» no muestra nada en rojo.
- Con LinkedIn: «Llamá dripify_estado y decime qué ves» tiene que decir `listo`.
- Con CRM: en **Canales → CRM**, «Probar conexión» dice «listo».

Con eso el alta está hecha. Lo que sigue (pruebas de arranque, calibración, lanzamiento) está en
[`17`](17-puesta-en-marcha-operacion-y-baja.md).

## Lista para tildar

| # | Paso | Quién | Listo |
|---|---|---|---|
| 1 | Cliente creado en el panel | Biguá | ☐ |
| 2 | Usuario del cliente activado | Biguá → cliente | ☐ |
| 3 | Buzones cargados y «Probar» en verde, con cupo | Cliente (Biguá revisa) | ☐ |
| 4 | Dominio verificado: SPF y DKIM sin rojo | Cliente (Biguá revisa) | ☐ |
| 5 | SDR activado: canal, calibración 20, bots, zona horaria, cuentas por día | Biguá | ☐ |
| 5b | Ajustes del cliente cargados y revisados | Cliente → Biguá | ☐ |
| 6 | Usuario de ASCI del bot creado | Biguá | ☐ |
| 7 | Token del gateway con `read`, `draft`, `send` y `sdr` | Biguá | ☐ |
| 8 | Cuenta de Grok: tres bots, conectores, Allow y Ask first, Privacy Mode, notificaciones | Biguá | ☐ |
| 9 | Siete routines creadas y habilitadas | Biguá (con los bots) | ☐ |
| 10 | Despertadores de seguimiento y del orquestador cargados | Biguá | ☐ |
| 11 | Con LinkedIn: Dripify cargado, «Probar» listo y webhooks en la campaña | Biguá (con el cliente) | ☐ |
| 11b | Con CRM: HubSpot conectado, «Probar» listo, origen y dueño elegidos, vista previa revisada | Cliente (Biguá revisa) | ☐ |
| 12 | Comprobado: agenda sin errores y llamadas en Actividad | Biguá | ☐ |
