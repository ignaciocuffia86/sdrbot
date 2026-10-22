# Preguntas a Grok Bot para cerrar el diseño

Lo que necesitamos confirmar con producto o soporte de Grok Bot antes de la fase 1. Cada pregunta dice por qué importa, qué asume el diseño hoy y qué cambia si la respuesta es no. La prioridad es sobre el diseño: **B** bloquea la fase 1, **I** cambia cómo se construye algo, **D** es deseable.

Referencias: `02-arquitectura.md` §4 (kit de tenant), §4.1 (box), §5.1 (propiedad de la cuenta), §7 (contratos), §8 (versionado); `03-onboarding-y-prerrequisitos.md` §2.2 (pedidos externos).

## 1. Cuentas, miembros y propiedad

| # | Pregunta | Prio | Por qué importa | Supuesto hoy | Si la respuesta es no |
|---|---|---|---|---|---|
| 1.1 | ¿Una cuenta puede tener varios miembros con roles distintos (administrador, operador, sólo aprobador)? ¿Cuáles son los roles? | B | El cliente tiene que poder aprobar sin administrar; Biguá tiene que administrar sin que el cliente vea secretos | Sí, al menos administrador y miembro | El cliente aprueba sólo por mail y nunca entra a la cuenta; Biguá es el único usuario |
| 1.2 | ¿Qué ve un miembro no administrador: bots, routines, box, secretos, historial de corridas? | B | Un aprobador no debe ver `.env` ni secretos ni el box | Los secretos sólo los ve el administrador | Igual que 1.1: el cliente fuera de la cuenta |
| 1.3 | ¿Se puede transferir la propiedad de una cuenta entera a otra persona u organización, con bots, routines, box y secretos? | I | Modelo fábrica y baja con entrega de la cuenta | Sí | El modelo fábrica arranca con la cuenta creada por el cliente y Biguá invitada; la baja es cierre, no entrega |
| 1.4 | ¿Una persona puede ser miembro de muchas cuentas y cambiar entre ellas sin cerrar sesión? | I | Nicolás e Ignacio operan N cuentas | Sí | Un usuario de Biguá por tenant, o el tablero central reemplaza el acceso directo |
| 1.5 | ¿Existe el concepto de organización que agrupe cuentas (facturación, miembros, plantillas compartidas)? | D | Gestión centralizada y facturación por tenant | No se asume | Nada cambia |
| 1.6 | ¿Cómo se factura: por cuenta, por bot, por corrida, por tokens? ¿Hay plan por volumen para N cuentas? | I | Costo por tenant y decisión operado vs fábrica | Por cuenta | Se modela el costo en la propuesta comercial |

## 2. Box (la computadora virtual de la cuenta)

| # | Pregunta | Prio | Por qué importa | Supuesto hoy | Si la respuesta es no |
|---|---|---|---|---|---|
| 2.1 | ¿Las sesiones de Chrome (WhatsApp Web, LinkedIn, Sales Navigator, Dripify) persisten entre reinicios del box y entre corridas? | B | WhatsApp y LinkedIn dependen de una sesión viva | Sí | El QR y los logins se repiten a diario; WhatsApp Web deja de ser viable y queda sólo mail y LinkedIn con reingreso manual |
| 2.2 | ¿Los archivos persisten (clon del repo, `.env`, perfil de Chrome, logs)? ¿Cuánto espacio hay? | B | Los scripts y las credenciales de casillas viven en el box | Sí, varios GB | Los scripts se reinstalan al inicio de cada routine desde el tag; las credenciales pasan a secretos de la cuenta |
| 2.3 | ¿Qué sistema operativo tiene el box y qué viene instalado (Python, Node, git, Chrome)? ¿Se puede instalar software? | B | El port de PasQAlito es Python; el instalador del repo necesita git | Linux o Windows con Python 3 y git | Se empaqueta el runtime dentro del repo o se reescribe en el lenguaje disponible |
| 2.4 | ¿El box tiene salida a internet sin restricción: SMTP 587/465, IMAP 993, HTTPS a `mcp.bigua.lat` y a Supabase? | B | Envío y lectura de casillas por script, ASCI y base de control | Sí | Mail por el conector de Gmail de la cuenta; ASCI y Supabase por conector MCP en vez de script |
| 2.5 | ¿Una persona del cliente puede entrar al escritorio del box (RDP, VNC, pantalla compartida) para escanear el QR y resolver 2FA? | B | Logins y QR los hace el dueño de cada sesión, nunca Biguá | Sí | Biguá hace los logins con el cliente al lado por videollamada, y se documenta en el DPA |
| 2.6 | ¿Un box es exclusivo de una cuenta? ¿Hay algún recurso compartido entre cuentas (disco, perfil de Chrome, red)? | B | Aislamiento entre tenants | Exclusivo | Una cuenta por cliente no alcanza; hay que revisar el aislamiento con Grok Bot antes de seguir |
| 2.7 | ¿El box corre sólo durante una routine o está encendido siempre? ¿Se puede mantener Chrome abierto y adelante entre corridas? | I | Heartbeat, lectura de WhatsApp Web, "dejar Chrome adelante" | Encendido en horario de routines | Heartbeat sólo al inicio de cada routine; detección de corridas ausentes por pg_cron |
| 2.8 | ¿Se puede fijar la zona horaria del box y de las routines por cuenta? | I | Horarios de envío por mercado | Sí | Los scripts convierten desde UTC con `clients.timezone` |
| 2.9 | ¿Hay límite de duración por corrida y de CPU o memoria? ¿Qué pasa si una routine se pasa? | I | Corridas de envío de hasta 40 minutos (lotes de 6 con 20 s entre mails; WhatsApp 45 a 90 s por mensaje) | 60 minutos o más | Las corridas se parten en pasadas más cortas y reanudan por `run_key` |
| 2.10 | ¿Se puede reiniciar, reinstalar o reemplazar el box sin perder la cuenta? ¿Hay snapshot o backup? | D | Recuperación ante un box roto | Reemplazo posible | El instalador del repo deja el box listo en una corrida; las sesiones se rehacen a mano |

## 3. Routines y ejecución

| # | Pregunta | Prio | Por qué importa | Supuesto hoy | Si la respuesta es no |
|---|---|---|---|---|---|
| 3.1 | ¿Una routine puede ejecutar un script del box (no sólo un prompt a un bot) y leer su salida? | B | El camino routine → script → RPC de §7.1 | Sí | El bot ejecuta el script por una herramienta de terminal del box y lee stdout |
| 3.2 | ¿Las routines corren a una hora fija con precisión de minutos, días hábiles, y con calendario de feriados? | I | Agenda de la sección 4 del documento v1.1 (09:52, 18:50, etc.) | Hora fija diaria; feriados no | Los feriados y los días hábiles los decide el script contra `schedule.holidays_calendar` y sale sin hacer nada |
| 3.3 | ¿Dos routines de la misma cuenta pueden correr en paralelo? ¿Se puede impedir? | I | Regla: nunca dos corridas de envío en paralelo | Pueden; la base lo impide con `run_key` y `SKIP LOCKED` | Nada cambia: la base ya lo resuelve |
| 3.4 | ¿Qué pasa si el box está apagado o una routine falla: reintento automático, aviso, nada? | I | Detección de corridas ausentes y alertas | Nada automático | pg_cron detecta `run_stale`; el notificador avisa |
| 3.5 | ¿Cuál es la frecuencia mínima de una routine (5, 15, 60 minutos)? | I | Heartbeat del box y lectura de aprobaciones | 15 minutos | Heartbeat al inicio de cada routine; las aprobaciones se leen en los tres monitoreos diarios y antes de cada pasada de WhatsApp |
| 3.6 | ¿Se puede disparar una routine desde afuera (webhook, API) o sólo por horario y por chat? | D | Ruteo inmediato de urgentes y re-lectura de aprobaciones al llegar un mail | Sólo horario | Monitoreo más frecuente en las horas de más respuestas |
| 3.7 | ¿Hay registro de cada corrida (inicio, fin, error, costo) accesible por API o exportable? | D | Cruzar `run_log` con lo que Grok Bot cobró | Sólo en la interfaz | `run_log` es la única fuente; el costo se estima |

## 4. Bots, skills y plantilla

| # | Pregunta | Prio | Por qué importa | Supuesto hoy | Si la respuesta es no |
|---|---|---|---|---|---|
| 4.1 | ¿Un bot puede cargar su skill desde un archivo del box en cada corrida, o el prompt vive sólo en la configuración del bot? | B | Mantener la plantilla fina y versionar los prompts en el repo (§8) | Puede leer archivos del box | Los prompts viven en el bot; cada release es un cambio manual en N cuentas, y se documenta un checklist |
| 4.2 | ¿Qué exporta `export-bot-template`: bots, routines, secretos (nombres), conectores? ¿Se importa en otra cuenta con un comando? | B | Alta de un tenant desde la plantilla | Bots y routines, sin secretos | Alta a mano con checklist; el instalador del repo cubre lo que la plantilla no exporta |
| 4.3 | ¿Hay API para crear cuentas, importar plantillas, cargar secretos y crear routines? | I | Automatizar el alta (`provision`) y los releases | No | Alta y releases por checklist; se vuelve a pedir al tercer tenant |
| 4.4 | ¿Cuántos bots y routines admite una cuenta? ¿Hay límite de tamaño de prompt o de archivos leídos? | I | Seis bots y doce routines por tenant | Suficiente | Se fusionan bots (por ejemplo `message` dentro de `outreach`) |
| 4.5 | ¿Un bot puede llamar a otro (orquestación) o sólo el usuario y las routines? | I | `sdr-lead` orquesta `qualify → message → outreach` | Sí, por subagente | Una routine por paso, encadenadas por horario y por estado en la base |
| 4.6 | ¿Se puede fijar el modelo y el presupuesto de tokens por bot o por routine? | D | Costo previsible por tenant | Sí | Se mide por corrida en `run_log.credits` y se ajustan prompts |
| 4.7 | ¿Las salidas de un bot pueden exigirse en JSON con esquema, o se valida afuera? | D | §8.2 del documento: la IA devuelve JSON con esquema fijo | Se valida afuera, en el script | Nada cambia: el script valida siempre |

## 5. Conectores, MCP y secretos

| # | Pregunta | Prio | Por qué importa | Supuesto hoy | Si la respuesta es no |
|---|---|---|---|---|---|
| 5.1 | ¿Un conector (Gmail, HubSpot) se puede limitar a un bot o a un equipo dentro de la cuenta? | I | Punto abierto 1 del documento v1.1 | No | Una cuenta por cliente, que ya es la decisión; no cambia nada |
| 5.2 | ¿Se puede conectar un MCP remoto con cabecera `Authorization: Bearer` (el de ASCI en `mcp.bigua.lat`) y asignarle un secreto de la cuenta? | B | Los bots consultan ASCI con la clave del tenant | Sí | Los scripts del box llaman al MCP por HTTP y los bots no lo tocan directo; funciona igual, con menos comodidad |
| 5.3 | ¿Los secretos de la cuenta llegan al box como variables de entorno de los scripts, o sólo a los bots? | B | `ASCI_KEY`, `SDR_BOT_PASSWORD`, etc. los leen los scripts | Como entorno del script | El bot pasa los secretos al script por argumentos, lo que los expone en logs; o se guardan en un `.env` del box con permisos restringidos |
| 5.4 | ¿Los secretos se pueden rotar sin reiniciar bots ni routines? ¿Quedan en el historial de chat o en logs? | I | Rotación anual de la clave de ASCI; nunca un secreto en un log | Rotación en caliente; no se loguean | Rotación en ventana de mantenimiento; auditar logs antes de compartir una cuenta |
| 5.5 | ¿El conector de Gmail puede leer casillas que no son de Google (IMAP genérico)? | I | Casillas del dominio alternativo en el proveedor que tenga el cliente | No; por eso IMAP por script | Nada cambia |
| 5.6 | ¿Un bot puede enviar mails desde una casilla SMTP arbitraria, o sólo por el conector de Gmail? | I | Rotación de 5 casillas con cupo por casilla | Sólo por script SMTP | Nada cambia: el envío es por script |
| 5.7 | ¿El subagente de navegador puede operar en el Chrome del box con las sesiones ya iniciadas (WhatsApp Web, Sales Navigator, Dripify)? | B | Lectura y envío de WhatsApp, InMails, carga en Dripify | Sí | WhatsApp pasa a envío manual con la tanda aprobada por mail; LinkedIn sólo por Dripify |
| 5.8 | ¿El subagente de navegador puede verificar el DOM antes de actuar (chat abierto correcto, texto del mensaje) y abortar? | I | Verificación de chat y texto antes de cada envío de WhatsApp | Sí | Verificación por captura y comparación visual, más lenta; se baja el volumen diario |

## 6. Datos, privacidad y cumplimiento

| # | Pregunta | Prio | Por qué importa | Supuesto hoy | Si la respuesta es no |
|---|---|---|---|---|---|
| 6.1 | ¿Dónde se procesan y guardan los datos de la cuenta (región)? ¿Hay DPA de Grok Bot y lista de subencargados? | B | El DPA de Biguá con cada cliente tiene que nombrar a Grok Bot como subencargado | Hay DPA | Sin DPA no se puede ofrecer a clientes de España ni a empresas reguladas; se evalúa otro runtime |
| 6.2 | ¿El contenido de chats, archivos del box y corridas se usa para entrenar modelos? ¿Se puede desactivar? | B | Mails de prospectos y respuestas de leads pasan por los bots | Se puede desactivar | Se minimiza lo que el bot ve: los scripts resumen y anonimizan antes de pasar texto al modelo |
| 6.3 | ¿Cuánto tiempo retiene Grok Bot historial de chats, logs y archivos? ¿Se puede borrar por cuenta? | I | Retención por tenant (12 y 24 meses) y baja con borrado | Borrado al cerrar la cuenta | La baja incluye borrado manual de historial antes del cierre |
| 6.4 | ¿Hay registro de auditoría de quién entró a la cuenta, cambió un secreto o corrió un bot a mano? | D | Trazabilidad ante un incidente | No | `run_log` y `notifications` son la auditoría del lado de Biguá; se limita quién es administrador |
| 6.5 | ¿Qué pasa con el box y los datos si se suspende la cuenta por falta de pago o por política? | D | Continuidad del servicio al cliente | Período de gracia | La base de control permite rearmar el tenant en otra cuenta desde el manifiesto |

## 7. Operación y soporte

| # | Pregunta | Prio | Por qué importa | Supuesto hoy | Si la respuesta es no |
|---|---|---|---|---|---|
| 7.1 | ¿Hay estado de servicio público y aviso de incidentes y mantenimientos? | I | Explicar al cliente una corrida ausente | Sí | El resumen de las 18:50 y las alertas de `run_stale` son el único aviso |
| 7.2 | ¿Hay soporte con tiempo de respuesta definido para cuentas de uso comercial? | I | SLA de Biguá hacia el cliente | Soporte por mail sin SLA | El SLA de Biguá excluye las caídas de Grok Bot y lo dice el contrato |
| 7.3 | ¿Qué límites de uso hay por cuenta (corridas por día, tokens, mensajes del subagente de navegador)? | I | Doce routines diarias y navegación intensiva en WhatsApp y LinkedIn | Dentro del plan | Se reparten routines o se sube de plan; se mide en el tenant canario |
| 7.4 | ¿Se notifica cuando una routine falla o un conector se desconecta, y por qué canal? | D | Alertas en el momento | Sólo en la interfaz | El notificador de Biguá cubre el aviso desde `run_log` y `boxes` |
| 7.5 | ¿Hay roadmap conocido para: scope de conectores por bot, API de cuentas, organizaciones, boxes aislados? | D | Decidir qué construir ahora y qué esperar | Sin fecha | Se construye lo de fase 1 sin depender de nada de esto |

## 8. Cómo validar las respuestas

No alcanza con la respuesta escrita: las preguntas marcadas **B** se prueban en una cuenta de Grok Bot de Biguá (el tenant canario) antes de la fase 1, con un script de verificación del repo que recorra 2.1 a 2.9, 3.1, 4.1, 5.2, 5.3 y 5.7 y deje el resultado en un archivo que acompañe la v1.2 del documento. Orden sugerido: primero 2.1 y 2.6 (si fallan, cambia el plano de ejecución entero), después 2.4 y 5.3 (definen si hay scripts o sólo conectores), después el resto.
