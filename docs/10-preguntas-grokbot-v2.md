# Consulta a Grok Bot · SDR multicliente de Biguá (v2)

Hola. Este documento es para vos, Grok Bot. Te explicamos qué estamos armando sobre Grok Bot, qué
damos por hecho sobre cómo funcionás, y qué necesitamos que nos confirmes o corrijas. Ya nos
respondiste una primera tanda de preguntas el 22/10/2026; acá van las que salen del diseño nuevo.

**Lo que más nos importa:** que nos digas si algo de lo que suponemos (parte C) es falso o
impreciso, aunque no te lo preguntemos de forma directa. Si ves una forma mejor de hacer algo con
funciones de Grok Bot que no estamos usando, decínosla.

---

## Parte A · Qué estamos construyendo

### A.1 El servicio

Biguá ofrece a sus clientes un **SDR (prospector comercial) operado por bots de Grok Bot**. El
SDR busca empresas con señales de compra (avisos de empleo, cambios de tecnología, decisores
nuevos), encuentra a los tomadores de decisión, los contacta por mail, LinkedIn y WhatsApp, hace
el seguimiento de las conversaciones y le pasa al cliente los interesados.

- **Una cuenta de Grok Bot por cliente.** Cada cliente tiene su cuenta, su box y sus bots. Nada se
  comparte entre clientes. Biguá administra todas las cuentas.
- **El primer cliente (piloto) es BairesQA.** Ya tiene un bot en su cuenta que lee su buzón y deja
  borradores a través de nuestro gateway de correo.
- Queremos que el comportamiento de los bots sea **el mismo para todos los clientes**, cambiando
  sólo lo propio de cada uno (a quién se le vende, qué se ofrece, el tono, la firma).

### A.2 Las piezas

```
Cuenta de Grok Bot del cliente (una por cliente)
 ├─ orquestador ── líder: arma el plan del día, reparte, pide aprobaciones en su chat
 ├─ prospector  ── cuentas y decisores en ASCI, contactos, escribe y envía mails
 ├─ seguimiento ── lee respuestas de mail, LinkedIn y WhatsApp, decide qué sigue, carga positivos en el CRM
 ├─ linkedin    ── único bot que usa el navegador para Dripify (sesión de LinkedIn del vendedor)
 └─ whatsapp    ── único bot que usa el navegador para WhatsApp Web
        │
        ├── conector MCP remoto: ASCI (mcp.bigua.lat) ── empresas, señales, decisores, Apollo
        └── conector MCP remoto: SDRBOT (sdrbot.bigua.lat/mcp)
                ├─ gateway.*   correo: enviar, responder, leer, borradores, con cupos e idempotencia
                ├─ reglas.*    las instrucciones de cada bot y tarea, guardadas en Supabase
                ├─ registro.*  memoria de la prospección: cuentas, personas, línea de tiempo
                └─ crm.*       HubSpot o Dynamics 365 del cliente, con límites
```

| Pieza | Qué es | Estado hoy |
|---|---|---|
| **ASCI** | Plataforma de Biguá con el universo de empresas, señales y decisores de LATAM. Expone un MCP remoto (`mcp.bigua.lat`) con autenticación por cabecera `Authorization: Bearer`. Por detrás usa Apollo para buscar y revelar contactos, con presupuesto diario por usuario | En producción. Ya hay conectores de ASCI funcionando en cuentas de Grok Bot |
| **Gateway de correo** | Servicio de Biguá en Vercel (`sdrbot.bigua.lat`). Habla IMAP y SMTP con los buzones del cliente (porque el box no puede: puertos bloqueados) y expone herramientas MCP y una API. Hace cumplir el cupo diario por buzón, exige una clave de idempotencia por envío, limita destinatarios, nunca borra y registra todo. Tokens por cliente con permisos (`read`, `draft`, `send`, `manage`) | En producción con BairesQA |
| **Supabase** (proyecto `sdrbot`) | Base de datos de Biguá. Guarda el gateway (buzones con contraseñas cifradas, envíos, auditoría), las **reglas de operación** de los bots y el **registro de prospección**. Cada cliente ve sólo lo suyo (seguridad por filas) | El gateway, en producción. Reglas y registro, a construir |
| **Panel** (`sdrbot.bigua.lat/admin`) | Web para Biguá y para el cliente: buzones, chequeo de SPF/DKIM/DMARC, tokens, y más adelante el dashboard de la prospección | En producción (buzones y dominios) |
| **Dripify** | Herramienta de prospección en LinkedIn. Las campañas las arma una persona; el bot `linkedin` les importa leads por CSV con las URL de LinkedIn. Dripify avisa por webhook (por campaña) cuando se envía una invitación, se acepta, se manda el primer mensaje y llega una respuesta; esos webhooks van al gateway | Campañas existentes; integración a construir |
| **WhatsApp Web** | Seguimiento por WhatsApp a personas de las que tenemos el número (el consentimiento ya está resuelto). Lo opera el bot `whatsapp` en el Chrome del box | A construir |
| **CRM del cliente** | HubSpot (primero) o Dynamics 365. Sólo se cargan las **respuestas positivas** o lo que el operador pida. El bot mira cómo tiene armado el CRM el cliente y decide qué campos completar, dentro de límites que pone nuestro MCP (no borra, no pisa datos, sólo ciertas entidades) | A construir |

### A.3 Cómo trabajan los bots

**Grok Bot orquesta.** Los bots conversan entre ellos sobre sus tareas y deciden el próximo paso
con criterio: el proceso no es una secuencia fija. Por ejemplo, si alguien responde un mail, el
bot `seguimiento` le pide a `linkedin` que lo saque de la campaña de Dripify, le propone al
`orquestador` la respuesta, y el `orquestador` pide la aprobación en su chat.

**El comportamiento viene de afuera, para que sea igual en todos los clientes:**

| Capa | Dónde vive | Qué tiene |
|---|---|---|
| Arranque | En Grok Bot: el perfil de cada bot y routines de una línea | Quién es el bot, con quién habla, y que sus instrucciones las pide con la herramienta `reglas.manual(bot, tarea)`. Ejemplo de routine: «Tarea `prospector.diaria`: pedí tus reglas con `reglas.manual` y seguilas» |
| Reglas | En Supabase, servidas por MCP | Instrucciones por bot y por tarea, con versión, más los ajustes del cliente |
| Memoria | En Supabase (`registro.*`) | A quién se contactó, por qué canal, qué respondió, cuál es el próximo paso. **No en las memorias de Grok Bot** |

**Reglas de conversación entre bots** (las tienen en sus reglas): cada pedido nombra a la persona
por su id en el registro; antes de actuar, el bot lee el registro (si otro ya lo hizo, no lo
repite); cada pedido deja un evento en el registro; si un tema va y viene más de tres veces, va al
`orquestador`.

**Aprobaciones:** las pide el `orquestador` en su chat y las da un operador de Biguá. Por ahora:
la respuesta a cada interesado, los primeros 20 mails de cada cliente nuevo, la primera carga en
el CRM de cada cliente y lo que los bots no resuelvan entre ellos.

**Lo que no depende del bot:** el cupo de mails, no enviar dos veces, no escribir a quien pidió la
baja (lo hace el gateway), el presupuesto de contactos (ASCI) y los límites de LinkedIn (Dripify).
Si un bot se equivoca, esos sistemas lo frenan.

### A.4 Un recorrido de ejemplo

1. A las 9:00, la routine del `orquestador` pide la agenda del día al registro y le dice al
   `prospector`: «15 cuentas nuevas de tal vertical y 8 seguimientos por mail».
2. El `prospector` busca cuentas y decisores en ASCI, revisa en el CRM que no sean clientes, revela
   los contactos, guarda todo en el registro, escribe y envía el primer mail por el gateway, y le
   pide a `linkedin` que cargue a 6 de esas personas en una campaña de Dripify.
3. `linkedin` arma un CSV con las URL de LinkedIn, lo importa en la campaña desde el navegador y lo
   registra.
4. Una persona responde el mail. El gateway lo detecta, lo registra y **despierta a `seguimiento`
   con el webhook de la routine**.
5. `seguimiento` lee la historia, le pide a `linkedin` que la saque de Dripify y le pasa al
   `orquestador` una respuesta propuesta.
6. El `orquestador` pregunta en su chat; un operador de Biguá aprueba (puede ser horas después).
7. `seguimiento` responde por el gateway en el mismo hilo y carga a la persona en el CRM.

---

## Parte B · Lo que ya nos confirmaste el 22/10

Lo seguimos usando así. **Si algo cambió, avisanos.**

| # | Lo que nos dijiste | Cómo lo usamos |
|---|---|---|
| B1 | Un box por cuenta, compartido por todos sus bots; nada compartido entre cuentas | Una cuenta por cliente |
| B2 | Desde el box sale HTTPS; SMTP (587/465) e IMAP (993) están bloqueados | El correo va por nuestro gateway |
| B3 | Una routine es un prompt que despierta al bot; cron de 5 campos en hora local, mínimo cada 5 minutos, timing flexible (±15 min) o exacto | Routines cortas que mandan a pedir las reglas |
| B4 | Una routine se puede disparar por webhook, mail, Slack, Teams y otros | El gateway despierta a `seguimiento` |
| B5 | Se puede agregar un MCP remoto por URL con cabecera fija `Authorization: Bearer …` | Los conectores de ASCI y SDRBOT |
| B6 | Los conectores son de la cuenta: los ven todos sus bots | Las reglas duras las pone nuestro MCP, no la falta de una herramienta |
| B7 | Un bot puede mandarle mensajes a otros bots de la misma cuenta y delegar en subagentes | Es la base de la orquestación |
| B8 | El navegador trabaja por visión; un solo agente de navegador por bot; dos bots en la misma sesión se pisan; se frena ante un QR, 2FA o desafío | Un dueño por sesión: `linkedin` y `whatsapp` |
| B9 | Por defecto un bot no envía mails ni mensajes sin aprobación de una persona; puede hacerlo si el prompt guardado de la routine lo dice explícitamente; las routines no heredan permisos del chat | Los prompts de las routines lo dicen |
| B10 | Hay una revisión automática que puede bloquear acciones de terminal, navegador o MCP y pedir aprobación manual | Ver pregunta 3.4 |
| B11 | Las plantillas son por bot, exportan perfil, memorias, skills y routines, no exportan secretos ni MCP personalizados; sin equipo son públicas | Plantillas en un equipo de Biguá |
| B12 | «Update Bot's Computer» conserva archivos y logins, no el software instalado | No instalamos nada en el box |

---

## Parte C · Lo que suponemos y necesitamos que confirmes

Estas son las cosas que el diseño da por ciertas sin que nos lo hayas confirmado. **Si alguna es
falsa, el diseño cambia.** Para cada una, decinos si es cierta y, si podés, probala (parte E).

| # | Suponemos que… | Dónde lo usamos | Pregunta |
|---|---|---|---|
| S1 | Un mensaje de un bot a otro **despierta al receptor** aunque no tenga una routine en ese momento, en menos de un minuto | Toda la orquestación | 1.2 |
| S2 | **Dos bots distintos** de la misma cuenta pueden correr al mismo tiempo | `seguimiento` atiende a un interesado mientras el `prospector` trabaja | 1.1 |
| S3 | Si un bot recibe un mensaje mientras está corriendo, el mensaje **se encola** y lo procesa después | Pedidos que llegan en medio de una tanda | 1.5 |
| S4 | Los mensajes entre bots **quedan registrados** en el historial | Auditoría | 1.4 |
| S5 | La **revisión automática no bloquea** las llamadas a herramientas de un conector MCP ya agregado cuando corre una routine sin nadie mirando | Todo el trabajo son llamadas MCP desatendidas | 3.4 |
| S6 | La regla de «no enviar sin aprobación» (B9) **también aplica a herramientas MCP** que envían (por ejemplo `gateway.enviar`), y alcanza con que el prompt de la routine lo autorice | El `prospector` envía mails por el gateway | 3.8 |
| S7 | Una herramienta MCP puede devolver **decenas de KB** de texto y tardar hasta **60 segundos** sin problema | `reglas.manual` devuelve instrucciones largas | 3.3 |
| S8 | Las **memorias de trabajo** se pueden apagar o borrar | Que todos los clientes se comporten igual | 2.1 |
| S9 | Si el operador contesta en el chat del `orquestador` **horas después**, el bot retoma con el contexto de lo que había pedido | Aprobaciones | 7.3 |
| S10 | El operador recibe una **notificación** cuando el `orquestador` le pide una aprobación | Que un interesado no espere | 7.2 |
| S11 | El **webhook de una routine** tiene una URL con secreto, el cuerpo del pedido le llega al prompt y dispara en menos de un minuto | El gateway despierta a `seguimiento` | 1.8 |
| S12 | Un bot puede **escribir un archivo en el box** (un CSV) y el navegador puede **subirlo** a una página | Importar leads en Dripify | 5.1 |
| S13 | El navegador puede **leer el texto** de una página, no sólo verla | Pasar respuestas de WhatsApp al registro | 5.2 |
| S14 | El box está **encendido las 24 horas** y Chrome sigue con la sesión abierta entre corridas | Lecturas de WhatsApp fuera de horario | 5.4 |
| S15 | No se puede fijar el **modelo**, pero cambia pocas veces | Comportamiento estable con las mismas reglas | 2.5 |

---

## Parte D · Preguntas

Prioridad: **B** bloquea el diseño · **I** importante · **D** deseable. La última columna es lo
que haríamos si la respuesta es no; si tenés una alternativa mejor, decínosla.

### 1. Conversación entre bots y concurrencia

| # | Pregunta | Prio | Si la respuesta es no |
|---|---|---|---|
| 1.1 | ¿Pueden correr **al mismo tiempo dos bots distintos** de la misma cuenta? | B | Juntar bots: tres en vez de cinco |
| 1.2 | Cuando un bot le **manda un mensaje a otro**, ¿el receptor se despierta y lo procesa aunque no tenga una routine en ese momento? ¿Cuánto tarda? | B | Los pedidos quedan en el registro y cada bot los lee en su routine |
| 1.3 | ¿El que manda **puede esperar la respuesta** dentro de su corrida, o es «mandar y seguir»? | B | Pedidos sin respuesta inmediata; el estado se lee en el registro |
| 1.4 | ¿Los mensajes entre bots **quedan registrados** y se pueden ver o exportar? | I | Cada pedido deja un evento en el registro (ya previsto) |
| 1.5 | Si un bot recibe un mensaje **mientras está corriendo** otra tarea, ¿se encola, lo interrumpe o se pierde? | B | Routines cortas y pedidos por el registro |
| 1.6 | Si una routine dispara mientras **la anterior del mismo bot sigue corriendo**, ¿se encola, se saltea o corre en paralelo? | I | Corridas acotadas por tiempo |
| 1.7 | ¿Hay **protección contra bucles** de mensajes entre bots? ¿Cómo se cobran esos mensajes? | I | Tope de idas y vueltas en las reglas |
| 1.8 | **Webhook de una routine**: ¿qué URL y qué autenticación (secreto o firma)? ¿El cuerpo del pedido le llega al prompt? ¿Latencia y límite de disparos? | I | Routine de `seguimiento` cada 5 minutos en horario hábil |
| 1.9 | Los **subagentes** de un bot, ¿usan los mismos conectores? ¿Cuentan para la concurrencia y el costo? | D | No usarlos |
| 1.10 | ¿Grok Bot tiene alguna función pensada para **coordinar varios bots** (tablero de tareas compartido, memoria compartida, bot de equipo) que nos convenga usar en lugar de mensajes sueltos? | I | Nuestro registro en Supabase |

### 2. Estandarización del comportamiento

| # | Pregunta | Prio | Si la respuesta es no |
|---|---|---|---|
| 2.1 | ¿Las **memorias de trabajo** se crean solas? ¿Se pueden apagar, fijar (sólo lectura) o borrar por bot? | B | Instrucción de no guardar memorias de comportamiento y revisión semanal |
| 2.2 | ¿Qué largo máximo tiene el **perfil** de un bot? ¿Se edita sin reimportar la plantilla? ¿Queda historial de cambios? | I | Perfil corto y todo lo demás en `reglas.manual` |
| 2.3 | ¿Un **skill** se aplica sólo si el prompt lo nombra o el bot lo elige por relevancia? Si se edita el archivo, ¿la próxima corrida usa la versión nueva? | D | No usar skills |
| 2.4 | ¿Se puede **actualizar una plantilla ya importada** en todas las cuentas, o hay que reimportar? Al reimportar, ¿qué pasa con routines, memorias y conectores? | I | Arranque que cambie lo menos posible |
| 2.5 | ¿Qué **modelo** usan los bots? ¿Avisan cuando cambia? ¿Se puede fijar? | I | Casos de prueba corridos seguido |

### 3. Conectores y MCP

| # | Pregunta | Prio | Si la respuesta es no |
|---|---|---|---|
| 3.1 | ¿Hay **conectores nativos de HubSpot y de Dynamics 365**? (Los usamos a través de nuestro MCP para tener límites; un conector nativo serviría para consultas manuales) | D | Nuestro MCP alcanza |
| 3.2 | ¿Se puede conectar un **MCP remoto que pide OAuth**, o sólo con cabecera fija? | D | Todo por nuestro MCP |
| 3.3 | ¿Límites de **cantidad de herramientas** por conector, **tamaño de respuesta** y **tiempo** por llamada? | B | Reglas partidas por sección |
| 3.4 | ¿Las llamadas a herramientas MCP **pasan por la revisión automática** en corridas desatendidas? ¿Se puede marcar un conector como confiable? | B | Ajustar nombres y descripciones de las herramientas hasta que no se bloqueen |
| 3.5 | Ante un 429 o 5xx del servidor MCP, ¿el bot **reintenta** solo? | I | Las herramientas dicen en el texto cuándo reintentar |
| 3.6 | ¿Se puede **apagar un conector o una herramienta para un bot** en particular? | I | Las reglas duras del gateway como red |
| 3.7 | ¿El conector manda alguna **identificación del bot** que llama (cabecera)? | D | El bot se identifica con un parámetro |
| 3.8 | La regla de no enviar sin aprobación (B9), ¿se aplica a **herramientas MCP que envían**? ¿Alcanza con que la routine lo autorice, o se dispara la revisión de todas formas? | B | El bot deja borradores y una persona los envía |

### 4. Routines

| # | Pregunta | Prio | Si la respuesta es no |
|---|---|---|---|
| 4.1 | ¿Cuánto puede durar una **corrida** y cuántas llamadas a herramientas aguanta antes de que el contexto se degrade o se compacte? | I | Tandas más chicas |
| 4.2 | ¿Hay **límite de routines** por bot y por cuenta? | D | Juntar routines |
| 4.3 | ¿Grok Bot **avisa cuando una routine falla** o no corre? | I | Cada routine anota inicio y fin en nuestra bitácora y alertamos nosotros |

### 5. Navegador (Dripify y WhatsApp Web)

| # | Pregunta | Prio | Si la respuesta es no |
|---|---|---|---|
| 5.1 | ¿El bot puede **escribir un archivo en el box** y el navegador **subirlo** a una página (un CSV a Dripify)? ¿Y descargar? | I | Cargar leads de a uno pegando la URL |
| 5.2 | ¿El agente puede **leer el texto** de la página para devolverlo completo? | I | Transcripción por visión, con verificación |
| 5.3 | ¿Cuántas acciones de navegador por hora son razonables antes de que la corrida se vuelva lenta o cara? | I | Lotes por CSV |
| 5.4 | ¿El box está **encendido 24 h** y Chrome queda abierto entre corridas? | I | Lecturas sólo en horario hábil |

### 6. Costo

| # | Pregunta | Prio | Si la respuesta es no |
|---|---|---|---|
| 6.1 | ¿**Cómo se mide el uso**: por token, por minuto de navegador, por corrida, por mensaje entre bots? ¿Se ve por bot? | B | Estimarlo en el piloto |
| 6.2 | ¿Hay **API o exportación** del consumo? | I | Carga manual mensual |
| 6.3 | ¿Hay **precio por volumen** para N cuentas (una por cliente)? | B | — |

### 7. Personas

| # | Pregunta | Prio | Si la respuesta es no |
|---|---|---|---|
| 7.1 | ¿Un usuario externo puede **chatear sólo con el `orquestador`** sin ver los otros bots, el box, los secretos ni el historial? (Hoy aprueba Biguá; serviría para que el cliente hable con el bot más adelante) | D | Una capa propia para hablar con el bot desde Teams, Slack o mail |
| 7.2 | ¿El `orquestador` puede **avisarle al operador** que hay una aprobación pendiente (notificación de la app, mail, Slack), o el operador tiene que entrar a mirar? | B | Aviso por mail desde nuestro gateway |
| 7.3 | Si el operador contesta en el chat **horas después**, ¿el `orquestador` retoma con el contexto de la aprobación pedida? | I | El `orquestador` relee lo pendiente en el registro |

### 8. Pendientes de la consulta anterior

Seguimos sin respuesta de soporte sobre: roles de miembro y qué ve cada uno; región de
procesamiento y almacenamiento, DPA y subencargados; si el contenido de chats y corridas se usa
para entrenar y cómo se desactiva; retención y borrado por cuenta; registro de auditoría; qué pasa
con el box ante una suspensión; estado del servicio y soporte con SLA. Si podés averiguarlo o
decirnos a quién preguntarlo, mejor.

---

## Parte E · Pruebas que te pedimos, si podés hacerlas en la cuenta de Biguá

Una respuesta probada vale más que una de documentación. Si alguna se puede hacer, hacela y
contanos qué pasó:

1. **Mensaje entre bots** (S1, S3, S4): con dos bots de prueba, que uno le mande un mensaje al
   otro mientras el segundo no tiene ninguna routine corriendo. ¿Se despertó? ¿Cuánto tardó? Repetir
   mientras el segundo está ocupado en otra tarea larga.
2. **Concurrencia** (S2): dos bots con routines a la misma hora, cada una con una tarea de 5
   minutos. ¿Corrieron a la vez o una esperó a la otra?
3. **MCP desatendido** (S5, S6): una routine que llama a una herramienta de un conector MCP ya
   agregado (por ejemplo una búsqueda en el conector de ASCI) y otra que llama a una herramienta que
   envía o escribe. ¿Alguna quedó esperando aprobación?
4. **Archivo y subida** (S12): que un bot escriba un CSV en el box y el navegador lo suba en
   cualquier página que acepte archivos.
5. **Memorias** (S8): ¿dónde se ven las memorias de un bot y qué opciones hay para apagarlas o
   borrarlas?
6. **Webhook** (S11): crear una routine con disparo por webhook y contarnos qué URL y qué
   autenticación da, y si el cuerpo del pedido aparece en el prompt.

No uses datos reales de clientes en las pruebas.

---

## Formato de respuesta

Para cada supuesto (S1 a S15) y cada pregunta, por favor:

- **Respuesta**, corta.
- **Fuente:** **Probado** (lo verificaste hoy en la cuenta), **Producto** (así funciona según la
  documentación o el comportamiento conocido) o **Sin dato** (hay que preguntarlo a soporte).
- Si la respuesta cambia algo de lo que contamos en la parte A, una línea diciendo qué.

Gracias.
