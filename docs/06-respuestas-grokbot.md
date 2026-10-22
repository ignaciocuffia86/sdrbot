# Respuestas de Grok Bot e impacto en el diseño

Las respuestas a `05-preguntas-grokbot.md`, recibidas el 22/10/2026 (parte B, textual), y lo que cambian en el diseño (parte A). Las decisiones de la parte A ya están aplicadas en `02-arquitectura.md`, `03-onboarding-y-prerrequisitos.md` y el manifiesto; este documento explica por qué.

Fuente de cada respuesta: **Probado** (verificado desde el box de una cuenta de Biguá), **Producto** (comportamiento documentado) o **Sin dato** (hay que preguntar a soporte).

---

## Parte A · Impacto en el diseño

### A.1 Lo que cambia

| # | Respuesta | Cambio en el diseño | Dónde |
|---|---|---|---|
| 1 | **SMTP 587/465 e IMAP 993 bloqueados desde el box; HTTPS abierto** (2.4, 5.5, 5.6, A1) | El mail deja de ir por script SMTP/IMAP. Las casillas del dominio alternativo tienen que estar en **Google Workspace** (estándar) o **Microsoft 365** (alternativa), y los scripts envían y leen por **Gmail API** o **Microsoft Graph** sobre HTTPS, con una credencial de aplicación por tenant (delegación a nivel de dominio o permisos de aplicación), no una contraseña por casilla. Se mantienen rotación, cupos, lotes, deduplicación y pie de baja; cambia sólo el transporte. Los `.env` de casillas desaparecen: hay un secreto por tenant | `02` §4.2, §7.3; manifiesto `channels.email` |
| 2 | **Todos los bots de una cuenta comparten box, archivos y sesiones; un agente de navegador por bot; dos bots en la misma sesión se pisan** (2.6, A2, 5.7) | Un único bot dueño de cada sesión de navegador: `whatsapp` para WhatsApp Web y `linkedin` para LinkedIn, Sales Navigator y Dripify. Los demás bots no abren Chrome. `message` se funde en `outreach`. Quedan **siete bots** | `02` §4, §7.4 |
| 3 | **Una routine es un prompt que despierta al bot; el bot ejecuta el script por terminal** (3.1, 2.9) | El contrato routine → script pasa a ser routine → prompt corto → skill del repo → script. Un comando bloquea hasta 13 minutos, así que las corridas largas corren en segundo plano y escriben un archivo de estado que el bot lee hasta que termina. Las corridas siguen siendo reanudables por `run_key` | `02` §7.1 |
| 4 | **Por defecto el bot no envía sin que una persona apruebe; las routines no heredan permisos del chat; hay una revisión automática que puede bloquear acciones** (A3, A4) | Los prompts de las routines de envío dicen con todas las letras que la aprobación ya está en la base y que no muestren borradores. Un bloqueo en corrida desatendida deja la corrida en `partial` con alerta `run_blocked`. Se prueba en el canario con los envíos reales antes de la fase 1 | `02` §7.1; `03` §5 fase 0 |
| 5 | **Skills como archivos del box en `/home/box/agent-data/workflows/<slug>/SKILL.md`, compartidos por todos los bots de la cuenta** (4.1) | Los prompts de los bots viven en el repo como `skills/<slug>/SKILL.md` y el instalador los copia a esa ruta. La routine dice "seguí el skill X". Un release es cambiar el tag y correr el instalador | `02` §8 |
| 6 | **Las plantillas son por bot, no exportan secretos ni MCP personalizados, y son públicas sin equipo** (4.2, A7, 1.3) | Biguá crea un **equipo** en Grok Bot para que las plantillas sean privadas. Siete plantillas más un skill de primeros pasos. El alta incluye a mano: conector MCP de ASCI con la clave del tenant, secretos, instalador. No existe transferencia de cuentas: el modelo fábrica se hace importando las plantillas en la cuenta del cliente y rehaciendo sesiones y secretos, no transfiriendo | `02` §5.1; `03` §3 |
| 7 | **Routines cada 5 minutos como mínimo, por cron en hora local con días hábiles, timing exacto a pedido, y disparables por webhook o mail** (3.2, 3.5, 3.6) | El monitoreo de casillas pasa de 3 veces por día a **cada 15 minutos en horario hábil**: los urgentes y las aprobaciones se procesan en menos de 15 minutos sin webhook. El heartbeat corre cada 15 minutos. Timing `exact` sólo para la tanda de WhatsApp, las pasadas de envío y el resumen. Los feriados los decide el script. El disparo por webhook queda para fase 2 (push de Gmail) | `02` §4.1, §7.2, §9; manifiesto `schedule` |
| 8 | **Los secretos llegan como variables de entorno y los scripts las heredan; el MCP remoto lleva la clave en la configuración del conector** (5.2, 5.3, 5.4) | La clave de ASCI vive en dos lugares de la cuenta: el conector (para los bots) y el secreto `ASCI_KEY` (para los scripts). La rotación toca los dos. Se valida en el canario que el script hereda el entorno | `02` §5 |
| 9 | **Tras "Update Bot's Computer" los archivos y logins quedan, el software instalado no** (2.2, 2.10) | El instalador es idempotente y el heartbeat verifica dependencias y lo vuelve a correr si faltan | `02` §4.1 |
| 10 | **El cliente entra al escritorio del box sólo desde la app, con acceso al bot** (2.5, 1.1 sin dato) | Hasta que soporte confirme roles de miembro, el QR y los 2FA se hacen en una videollamada: el operador de Biguá abre la vista en vivo del escritorio y el dueño de la sesión escanea o dicta el código. Nadie del cliente necesita acceso a la cuenta en fase 1 | `03` §1, §3 |
| 11 | **13 de 15 GB de RAM usados con varios bots** (A6) | Sólo dos bots abren Chrome; el instalador no instala nada que no se use; se mide en el canario con WhatsApp Web, Sales Navigator y Dripify abiertos | `02` §4.1 |
| 12 | **Zona horaria por cuenta** (2.8) | `grokbot.timezone` del manifiesto es la del tenant y se fija en el alta | manifiesto |

### A.2 Lo que se confirma sin cambios

- Una cuenta de Grok Bot por cliente (2.6, 5.1): el aislamiento es entre cuentas, no entre bots ni conectores.
- Sesiones de Chrome y archivos persistentes (2.1, 2.2): WhatsApp Web y LinkedIn son viables. WhatsApp desvincula si el teléfono queda unos 14 días sin conexión: entra en el chequeo de las 07:30 y en el playbook de incidentes.
- Debian con Python 3, Node, git y Chrome, 125 GB de disco (2.3): el port de PasQAlito en Python sigue.
- HTTPS a Supabase y a `mcp.bigua.lat` (2.4): base de control y ASCI por script, como estaba.
- `run_key` + `SKIP LOCKED` para evitar envíos en paralelo (3.3) y `run_stale` por pg_cron (3.4): la base sigue siendo la que hace cumplir.
- Validación de JSON de la IA en el script (4.7).
- Un bot puede llamar a otros y delegar en subagentes (4.5): `sdr-lead` orquesta como estaba previsto.
- El navegador trabaja por visión, no por DOM (5.8): la verificación de chat y texto antes de cada envío de WhatsApp se hace por lectura visual, más lenta; el volumen diario arranca en 10.
- Si LinkedIn o WhatsApp muestran un desafío, el bot se detiene y avisa (A5): es lo que el diseño quiere; el riesgo de restricción de la cuenta es del titular y va en el contrato.

### A.3 Canal de mail: decisión

Opciones que dejan las respuestas, y por qué se elige la primera.

| Opción | Cómo | A favor | En contra | Decisión |
|---|---|---|---|---|
| **Google Workspace + Gmail API con delegación de dominio** | El cliente (o Biguá como servicio gestionado) pone el dominio alternativo en Workspace. Una cuenta de servicio con delegación a nivel de dominio (scopes de Gmail) actúa en nombre de cada casilla. Un JSON de credencial por tenant como secreto. Envío con `messages.send`, lectura con `messages.list` por `historyId`, hilos por `threadId` | Casillas reales con reputación propia, que es lo que exige la prospección en frío; una sola credencial por tenant; HTTPS; hilos y `Message-ID` recuperables; push por Pub/Sub en fase 2 | Obliga a Workspace (hoy BairesQA está ahí, a confirmar); la delegación la autoriza el administrador del Workspace del cliente | **Estándar** |
| Microsoft 365 + Graph API | Permisos de aplicación `Mail.Send` y `Mail.Read` acotados a las casillas del tenant con una política de acceso | Equivalente para clientes en Microsoft | Dos implementaciones del módulo de mail | **Alternativa** para clientes en Microsoft |
| Conectores Gmail/Outlook de Grok Bot, una casilla por conector | El bot envía y lee por el conector según lo que decide el script | Sin credencial de aplicación ni código de mail | El envío lo hace el bot y no el script: lotes, cupos y `Message-ID` quedan fuera del control programático; cinco conectores por tenant; los conectores los ven todos los bots | **Respaldo** para un tenant chico |
| API transaccional (Resend, SendGrid, Postmark, Mailgun) con webhook de entrada | Envío por API desde un dominio del tenant; respuestas por MX hacia el proveedor | Simple y con webhooks | Reputación compartida, políticas de uso que excluyen la prospección en frío, MX del dominio alternativo al proveedor | **No** para prospección. Sí para el notificador de Biguá |

Lo que no cambia con la decisión: una casilla sigue siendo una casilla (`mailboxes`, warm-up, cupo, `send_counters`), el ledger sigue guardando `external_ref` (el `id` del mensaje de Gmail) y el `Message-ID` leído después del envío, y la lectura de respuestas sigue cruzando `In-Reply-To` y `References` contra el ledger.

### A.4 Lo que queda para soporte de Grok Bot

Un solo mail, con estas preguntas, antes de firmar el DPA con el primer cliente:

1. Roles de miembro en una cuenta y qué ve cada uno (bots, routines, box, secretos, historial). (1.1, 1.2)
2. Una persona en varias cuentas, y si existe organización o equipo con facturación centralizada. (1.4, 1.5)
3. Precio por volumen para N cuentas y límites duros por corrida y por agente de navegador. (1.6, 7.3)
4. Región de procesamiento y almacenamiento, DPA y lista de subencargados. (6.1)
5. Si el contenido de chats, archivos y corridas se usa para entrenar y cómo se desactiva. (6.2)
6. Retención de historial, logs y archivos, y borrado por cuenta. (6.3)
7. Registro de auditoría de accesos y cambios de secretos. (6.4)
8. Qué pasa con el box y los datos ante suspensión de la cuenta. (6.5)
9. Si el box está encendido 24 h y si Chrome queda abierto entre corridas. (2.7)
10. Si dos routines de la misma cuenta pueden correr en paralelo y si hay reintento ante falla. (3.3, 3.4)
11. Estado de servicio, aviso de incidentes y soporte con SLA. (7.1, 7.2)
12. Aviso nativo cuando falla una routine o se cae un conector. (7.4)

### A.5 Lo que se prueba en el canario antes de la fase 1

En la cuenta de Biguá, con el instalador del repo:

1. Un script lanzado en segundo plano por el bot, que corre 20 minutos y escribe su estado, con el bot esperando y leyendo el resultado (3.1, 2.9).
2. Un secreto cargado por el campo enmascarado que un script lee como variable de entorno sin imprimirla (5.3).
3. Una routine de envío con el prompt estándar que envía un mail de prueba por Gmail API sin pedir confirmación, y la revisión automática no la bloquea (A3, A4).
4. Gmail API con delegación de dominio sobre dos casillas de un dominio de prueba de Biguá: envío, lectura por `historyId`, `Message-ID` recuperado (A.3).
5. WhatsApp Web y Sales Navigator abiertos en los bots `whatsapp` y `linkedin` a la vez, con la RAM medida (A6).
6. Heartbeat cada 15 minutos durante un día hábil, con "Update Bot's Computer" en el medio y el instalador volviendo a dejar el box listo (2.2, 3.5).
7. Importar las siete plantillas en una segunda cuenta de Biguá y completar el checklist de alta midiendo el tiempo (4.2).

---

## Parte B · Respuestas (textual)

Versión respondida del documento de preguntas. Se agregan dos columnas: **Respuesta** y **Fuente**. La fuente es una de tres:

- **Probado**: verificado hoy (22/10/2026) desde el box de una cuenta de Biguá.
- **Producto**: así funciona Grok Bot hoy según su comportamiento documentado, sin prueba específica para este caso.
- **Sin dato**: no se puede confirmar desde adentro de la cuenta; hay que preguntarlo a soporte. Se mantiene el supuesto y el plan B.

Al final hay una sección de **aclaraciones** con cosas que el documento original no pregunta pero cambian el diseño.

### B.1 Cuentas, miembros y propiedad

| # | Pregunta | Prio | Respuesta | Fuente |
|---|---|---|---|---|
| 1.1 | ¿Varios miembros con roles distintos? | B | Existen bots de equipo (un bot convertido a equipo que otros miembros pueden usar) y chats grupales con miembros. No hay confirmación de un rol "sólo aprobador" ni de la lista exacta de roles. | Sin dato |
| 1.2 | ¿Qué ve un miembro no administrador? | B | Lo confirmado: los secretos nunca aparecen en el chat; se cargan por un campo enmascarado y quedan como variable de entorno. Qué ve un miembro del box, routines e historial, no está confirmado. | Sin dato |
| 1.3 | ¿Transferir la propiedad de una cuenta entera? | I | No hay función conocida. La alternativa real es la plantilla de bot (ver 4.2), que rearma el bot en otra cuenta pero no mueve box, sesiones ni secretos. | Sin dato |
| 1.4 | ¿Una persona en muchas cuentas sin cerrar sesión? | I | No confirmado. La app tiene un único bloque de cuenta en Ajustes > General con "Sign In" / "Sign Out". | Sin dato |
| 1.5 | ¿Organización que agrupe cuentas? | D | Hay concepto de equipo (plantillas "Team", bots de equipo). Su alcance para facturación y miembros no está confirmado. | Sin dato |
| 1.6 | ¿Cómo se factura? | I | La cuenta tiene uso incluido más uso a demanda (Ajustes > Usage & Billing). El precio por volumen para N cuentas hay que pedirlo. | Producto / Sin dato |

### B.2 El box

| # | Pregunta | Prio | Respuesta | Fuente |
|---|---|---|---|---|
| 2.1 | ¿Persisten las sesiones de Chrome? | B | Sí. Archivos, herramientas instaladas y logins del navegador persisten entre corridas. "Update Bot's Computer" mueve el box a una instancia nueva **conservando archivos y logins**. Ojo: la expiración la decide cada sitio (WhatsApp Web desvincula si el teléfono queda offline ~14 días). | Producto |
| 2.2 | ¿Persisten los archivos? ¿Espacio? | B | Sí. Disco de 125 GB con 119 GB libres hoy. Salvedad: tras "Update Bot's Computer" el **software instalado** hay que reinstalarlo (los archivos sí quedan): el instalador del repo tiene que ser idempotente. | Probado |
| 2.3 | ¿SO y software? | B | Debian 13 (trixie), x86_64, 8 núcleos, 15 GB RAM. Vienen Python 3, Node, git y Google Chrome. Se puede instalar software. | Probado |
| 2.4 | ¿Salida a internet sin restricción? | B | **No.** HTTPS sale bien (Supabase y `mcp.bigua.lat` responden). **SMTP 587/465 e IMAP 993 están bloqueados** hacia Gmail. Aplica el plan B: mail por conector (Gmail/Outlook) o por API HTTPS de un proveedor de envío. Ver aclaración A1. | Probado |
| 2.5 | ¿El cliente puede entrar al escritorio del box? | B | Sí, pero no por RDP/VNC: desde la app, en el panel del bot hay una vista en vivo del escritorio que se abre a pantalla completa, y el bot puede ceder el escritorio para un login, 2FA o QR. Requiere que esa persona use la app con acceso a ese bot (depende de 1.1). | Producto |
| 2.6 | ¿El box es exclusivo de una cuenta? | B | Un box por usuario/cuenta, **compartido por todos los bots de esa cuenta** (mismo disco, mismos logins de navegador). Cada bot tiene su propio escritorio y ventana de navegador. Entre cuentas distintas no hay nada compartido conocido. Confirma la decisión "una cuenta por cliente". Ver A2. | Producto |
| 2.7 | ¿Encendido siempre? | I | Es una máquina persistente, pero no está confirmado que esté encendida 24 h ni que Chrome quede abierto entre corridas. Mantener el supuesto: heartbeat al inicio de cada routine. | Sin dato |
| 2.8 | ¿Zona horaria por cuenta? | I | Sí. La zona horaria se configura en Ajustes > General; el reloj del box y el cron de las routines usan esa zona. | Producto |
| 2.9 | ¿Límite de duración por corrida? | I | Un comando de terminal bloquea hasta 13 min por llamada, pero puede correr en segundo plano sin ese límite. El tope total de una corrida no está confirmado. Mantener corridas partidas y reanudables por `run_key`. | Producto / Sin dato |
| 2.10 | ¿Reiniciar o reemplazar el box? | D | Sí: "Update Bot's Computer" (instancia nueva, conserva archivos y logins) y "Reset Bot's Computer" (restaura el último snapshot; último recurso, puede perder trabajo reciente). | Producto |

### B.3 Routines

| # | Pregunta | Prio | Respuesta | Fuente |
|---|---|---|---|---|
| 3.1 | ¿Una routine ejecuta un script del box? | B | No directamente: una routine es un **prompt** que despierta al bot. El bot ejecuta el script por terminal y lee stdout. Es exactamente el plan B, y funciona. El prompt debe decir qué script correr y qué hacer con la salida. | Producto |
| 3.2 | ¿Hora fija, días hábiles, feriados? | I | Cron de 5 campos en hora local; días hábiles sí (`52 9 * * 1-5`). Feriados no. Por defecto el arranque es "flexible" (±15 min); para 09:52 exacto hay que pedir timing "exact", y aun así puede arrancar unos minutos tarde. Los feriados los resuelve el script. | Producto |
| 3.3 | ¿Dos routines en paralelo? | I | No confirmado. Mantener `run_key` + `SKIP LOCKED`. | Sin dato |
| 3.4 | ¿Qué pasa si falla o el box está apagado? | I | No hay reintento automático confirmado. Mantener `run_stale` por pg_cron. | Sin dato |
| 3.5 | ¿Frecuencia mínima? | I | **5 minutos.** | Producto |
| 3.6 | ¿Disparo desde afuera? | D | **Sí.** Además de horario, una routine puede dispararse por webhook, email, Slack, Microsoft Teams, GitHub, Linear, Sentry y PagerDuty. Permite ruteo inmediato de urgentes al llegar un mail. | Producto |
| 3.7 | ¿Registro de corridas por API? | D | Hay historial de las conversaciones de las corridas dentro de la app; no se conoce API pública ni export. `run_log` sigue siendo la fuente. | Sin dato |

### B.4 Bots, plantillas y versionado

| # | Pregunta | Prio | Respuesta | Fuente |
|---|---|---|---|---|
| 4.1 | ¿El bot carga su skill desde un archivo del box? | B | Sí: puede leer cualquier archivo del box en cada corrida. Además hay **skills**: biblioteca compartida por todos los bots de la cuenta, guardadas como archivos en `/home/box/agent-data/workflows/<slug>/SKILL.md`. El prompt de la routine puede ser corto ("seguí el skill X") y el skill versionarse en el repo. | Producto |
| 4.2 | ¿Qué exporta la plantilla? | B | Perfil (nombre, descripción), memorias de trabajo, skills, routines y plugins del catálogo. **No** exporta secretos ni MCP personalizados (el de ASCI se reconecta a mano). Puede incluir un skill de "primeros pasos" que guía al nuevo dueño. Se importa con un link. Sin equipo, las plantillas son públicas. Es por bot, no por cuenta: 6 bots son 6 plantillas. | Producto |
| 4.3 | ¿API para crear cuentas, plantillas, secretos, routines? | I | No hay API pública conocida. Alta por checklist, como asume el plan B. | Sin dato |
| 4.4 | ¿Límites de bots, routines y tamaño? | I | No confirmado. Las plantillas tienen un tope de tamaño (no publicado). | Sin dato |
| 4.5 | ¿Un bot puede llamar a otro? | I | **Sí.** Un bot puede mandar mensajes a otros bots de la misma cuenta y también delegar trabajo a subagentes propios en segundo plano. Un bot puede incluso crear bots nuevos. | Producto |
| 4.6 | ¿Modelo y presupuesto por bot? | D | No se elige el modelo por bot. No hay presupuesto de tokens configurable conocido. Medir en `run_log.credits`. | Sin dato |
| 4.7 | ¿Salida en JSON con esquema? | D | No hay validación de esquema nativa. Validar en el script, como asume el diseño. | Producto |

### B.5 Conectores, secretos y navegador

| # | Pregunta | Prio | Respuesta | Fuente |
|---|---|---|---|---|
| 5.1 | ¿Conector limitado a un bot? | I | No: los conectores son de la cuenta y los ven todos sus bots. Sí se pueden conectar varias cuentas del mismo servicio (por ejemplo dos casillas de Gmail). | Producto |
| 5.2 | ¿MCP remoto con `Authorization: Bearer`? | B | **Sí.** Se agrega un MCP remoto por URL con cabeceras fijas (`Authorization: Bearer …`). El valor se carga en la configuración del conector, no como "secreto de cuenta" referenciado. En esta cuenta ya hay conectores de ASCI funcionando. | Producto |
| 5.3 | ¿Secretos como variables de entorno? | B | Sí: un secreto pedido por el campo enmascarado queda como `process.env.NOMBRE` para el bot, y los scripts que el bot corre por terminal lo heredan. Validar en el canario con un script que imprima sólo si la variable existe. | Producto (probar) |
| 5.4 | ¿Rotación y logs? | I | Se rota volviendo a pedir el secreto con el mismo nombre. El valor nunca pasa por el chat. Que un script no lo imprima es responsabilidad del script. | Producto |
| 5.5 | ¿Gmail lee IMAP genérico? | I | No: el conector de Gmail es sólo Google. Existe conector de Outlook. **Y el IMAP por script no sale (puerto 993 bloqueado, ver 2.4).** Ver A1. | Probado / Producto |
| 5.6 | ¿Enviar desde SMTP arbitrario? | I | Por SMTP no (puertos bloqueados). Sí por conector de Gmail u Outlook (varias casillas conectadas) o por API HTTPS. El bot también puede tener su propia casilla. Ver A1 y A3. | Probado |
| 5.7 | ¿El navegador del bot usa las sesiones iniciadas? | B | Sí: opera el Chrome del box con las sesiones ya iniciadas. Un solo subagente de navegador a la vez por bot. Se frena ante un login, 2FA o QR y lo pide a una persona. | Producto |
| 5.8 | ¿Verifica el DOM antes de actuar? | I | Trabaja por capturas de pantalla y clics (visión), no por consultas al DOM. Puede verificar que el chat y el texto son los correctos antes de enviar y abortar, pero por lectura visual: más lento, como dice el plan B. | Producto |

### B.6 Datos y cumplimiento

| # | Pregunta | Prio | Respuesta | Fuente |
|---|---|---|---|---|
| 6.1 | ¿Región, DPA, subencargados? | B | Hay que pedirlo a soporte. | Sin dato |
| 6.2 | ¿Se entrena con los datos? | B | Hay que pedirlo a soporte. | Sin dato |
| 6.3 | ¿Retención y borrado por cuenta? | I | Se puede borrar un bot con su historial (permanente). Retención general: pedir a soporte. | Producto / Sin dato |
| 6.4 | ¿Auditoría de accesos? | D | No conocida. | Sin dato |
| 6.5 | ¿Suspensión de la cuenta? | D | Hay que pedirlo a soporte. | Sin dato |

### B.7 Servicio y soporte

| # | Pregunta | Prio | Respuesta | Fuente |
|---|---|---|---|---|
| 7.1 | ¿Estado de servicio público? | I | Hay que pedirlo a soporte. | Sin dato |
| 7.2 | ¿Soporte con SLA? | I | Hay que pedirlo a soporte. | Sin dato |
| 7.3 | ¿Límites de uso por cuenta? | I | Se ven en Ajustes > Usage & Billing (incluido y a demanda). Límites duros por corrida o por navegador: pedir a soporte. | Producto / Sin dato |
| 7.4 | ¿Aviso si falla una routine o se cae un conector? | D | Avisos dentro de la app (con sonido configurable). El bot puede conectarse a canales externos (por ejemplo Slack) y avisar por ahí si la routine se lo indica. Aviso nativo de falla: no confirmado. | Producto / Sin dato |
| 7.5 | ¿Roadmap? | D | No hay roadmap público conocido. | Sin dato |

### B.8 Aclaraciones que el documento no preguntaba

**A1. El mail no puede ir por SMTP/IMAP desde el box.** Probado: 587, 465 y 993 cierran por timeout. HTTPS funciona. Opciones: (a) conectar las 5 casillas como conectores Gmail/Outlook (sólo si son Google o Microsoft); (b) enviar por API HTTPS de un proveedor (Resend, SendGrid, Postmark, Mailgun) y leer respuestas con su webhook de entrada, que además puede disparar una routine (3.6); (c) Gmail API por HTTPS con OAuth propio. Esto cambia la rotación de casillas y la lectura de respuestas del diseño actual.

**A2. Todos los bots de una cuenta comparten box y logins.** Si un tenant tiene seis bots, los seis ven el mismo `.env`, los mismos archivos y las mismas sesiones de WhatsApp y LinkedIn. El aislamiento es entre cuentas, no entre bots. Además, cada bot tiene su propio escritorio, pero sólo puede correr un agente de navegador a la vez por bot: dos bots usando WhatsApp Web al mismo tiempo pueden pisarse la sesión. Conviene que un único bot sea dueño de cada sesión de navegador.

**A3. Política de envío de Grok Bot.** Por defecto, un bot no manda mails ni mensajes por su cuenta: arma un borrador que una persona aprueba. Puede enviar sin borrador cuando el prompt guardado de la routine lo dice explícitamente (por ejemplo "enviá la tanda aprobada sin mostrarla"). Las routines **no** heredan permisos dados en el chat. Los prompts de las routines de envío tienen que decirlo con todas las letras, y conviene que la aprobación humana viva en la base (como ya plantea el diseño).

**A4. Controles de seguridad automáticos.** Algunas acciones (terminal, navegador, MCP, crear routines) pasan por una revisión automática que puede bloquearlas y pedir aprobación manual. En una corrida desatendida, un bloqueo deja la acción sin hacer. Probarlo en el canario con las acciones reales de envío.

**A5. Sitios que detectan automatización.** Si LinkedIn o WhatsApp muestran un desafío o bloquean, el bot se detiene y avisa; no intenta esquivarlo. El riesgo de restricción de cuenta por volumen es del titular de la sesión y conviene decirlo en el contrato con el cliente.

**A6. Recursos del box compartidos.** Hoy el box de esta cuenta usa 13 de 15 GB de RAM con varios bots. Un Chrome con WhatsApp Web, Sales Navigator y Dripify abiertos más los scripts puede quedar justo. Medir en el canario.

**A7. Plantilla sin MCP propio.** La plantilla no lleva el conector de ASCI (`mcp.bigua.lat`) porque es un MCP personalizado: el alta de cada tenant incluye agregarlo a mano con la clave del tenant.
