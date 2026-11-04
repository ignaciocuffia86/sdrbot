# Preguntas a Grok Bot · arquitectura v2 (Grok orquesta)

Para validar `09-arquitectura-v2.md`, donde Grok Bot orquesta: los bots conversan entre sí,
deciden el próximo paso y usan como herramientas el MCP de ASCI y el MCP de Biguá
(`sdrbot.bigua.lat`: gateway de correo, reglas de operación, registro de prospección y CRM).
Las aprobaciones se hacen en el chat de Grok con el `orquestador`. Complementa a `05-preguntas-grokbot.md`: lo ya respondido
en `06-respuestas-grokbot.md` no se repite, salvo cuando este modelo lo vuelve crítico. Lo que
quedó pendiente para soporte en `06` A.4 (miembros, datos, DPA, SLA) sigue vigente.

Cada pregunta dice por qué importa, qué supone el diseño y qué se hace si la respuesta es no.
Prioridad: **B** bloquea el modelo · **I** importante · **D** deseable. Formato de respuesta,
igual que en `06`: respuesta + fuente (**Probado**, **Producto** o **Sin dato**).

## 1. Conversación entre bots y concurrencia

Es lo central del modelo: si los bots no pueden pedirse cosas de forma confiable, el plan B
deja los pedidos como eventos pendientes en el registro de prospección (`09` §4.3).

| # | Pregunta | Prio | Por qué importa | Supuesto | Si no |
|---|---|---|---|---|---|
| 1.1 | ¿Pueden correr **al mismo tiempo dos bots distintos** de la misma cuenta? (`06` 3.3 quedó sin dato) | B | `seguimiento` tiene que atender a un interesado mientras `prospector` trabaja | Sí | Juntar bots: tres en vez de cinco |
| 1.2 | Cuando un bot le **manda un mensaje a otro**, ¿el receptor se despierta y lo procesa aunque no tenga una routine en ese momento? ¿Cuánto tarda? | B | Es el mecanismo de orquestación | Sí, en menos de un minuto | Pedidos como eventos pendientes en el registro que cada bot lee en su routine |
| 1.3 | ¿El que manda **puede esperar la respuesta** dentro de su corrida, o es «mandar y seguir»? | B | Define si el `prospector` puede preguntar y seguir con la respuesta | Mandar y seguir; la respuesta llega como otro mensaje | Pedidos sin respuesta inmediata; el estado se lee en el registro |
| 1.4 | ¿Los mensajes entre bots **quedan registrados** y se pueden ver o exportar? | I | Auditoría de un proceso no lineal | Quedan en el historial de cada bot | Cada pedido deja un evento en el registro (ya previsto) |
| 1.5 | Si un bot recibe un mensaje **mientras está corriendo** otra tarea, ¿se encola, lo interrumpe o se pierde? | B | Pedidos que llegan en medio de una tanda | Se encola | Routines cortas y pedidos por el registro |
| 1.6 | Si una routine dispara mientras **la anterior del mismo bot sigue corriendo**, ¿se encola, se saltea o corre en paralelo? | I | Routines cada 15 minutos | Se saltea | Corridas acotadas por tiempo en el manual |
| 1.7 | ¿Hay **límites o protección contra bucles** de mensajes entre bots? ¿Cómo se cobran esos mensajes? | I | Dos bots que se pasan un tema sin cerrarlo | Sin límite; se cobra como uso normal | Tope de idas y vueltas en el manual (`09` §4.3) |
| 1.8 | **Disparo por webhook**: ¿qué URL y qué autenticación (secreto o firma)? ¿El cuerpo le llega al prompt? ¿Latencia y límite de disparos? | I | El gateway despierta a `seguimiento` cuando llega una respuesta | URL con secreto; el cuerpo llega; menos de un minuto | Routine de `seguimiento` cada 5 minutos en horario hábil |
| 1.9 | Los **subagentes** de un bot, ¿usan los mismos conectores? ¿Cuentan para la concurrencia y el costo? | D | Paralelizar dentro del `prospector` | Mismos conectores | No usarlos |

## 2. Estandarización del comportamiento

| # | Pregunta | Prio | Por qué importa | Supuesto | Si no |
|---|---|---|---|---|---|
| 2.1 | ¿Las **memorias de trabajo** se crean solas? ¿Se pueden apagar, fijar (sólo lectura) o borrar por bot? | B | Si cada bot acumula memorias propias, dos clientes con las mismas reglas se comportan distinto sin que se vea | Se pueden apagar o borrar | Instrucción de no guardar memorias de comportamiento + revisión semanal y borrado manual |
| 2.2 | ¿Qué largo máximo tiene el **perfil** de un bot? ¿Se edita sin reimportar la plantilla? ¿Queda historial? | I | El arranque de cada bot vive ahí | Unos miles de caracteres, editable | Perfil corto y todo lo demás en `reglas.manual` |
| 2.3 | ¿Un **skill** se aplica sólo si el prompt lo nombra o el bot lo elige por relevancia? Si se edita el archivo, ¿la próxima corrida usa la versión nueva? | D | Usar skills como copia local de las reglas si el MCP tuviera límites | Sólo si se nombra | No usar skills |
| 2.4 | ¿Se puede **actualizar una plantilla ya importada** en todas las cuentas, o hay que reimportar? Al reimportar, ¿qué pasa con routines, memorias y conectores? | I | Cambiar el arranque en N clientes | Reimportar a mano | Arranque que cambie lo menos posible |
| 2.5 | ¿Qué **modelo** usan los bots? ¿Avisan cuando cambia? ¿Se puede fijar? | I | Un cambio de modelo cambia el comportamiento con las mismas reglas | No se puede fijar | Casos de prueba corridos seguido en el cliente canario |

## 3. Conectores y MCP

| # | Pregunta | Prio | Por qué importa | Supuesto | Si no |
|---|---|---|---|---|---|
| 3.1 | ¿Hay **conectores nativos de HubSpot y de Dynamics 365**? | D | El diseño los usa a través del MCP de Biguá (`crm.*`, `11` §7) para que las reglas sean iguales con cualquier CRM; un conector nativo sólo serviría para consultas manuales en el chat | — | Nada: `crm.*` ya cubre |
| 3.2 | ¿Se puede conectar un **MCP remoto que pide OAuth**, o sólo con cabecera fija (`06` 5.2)? | D | Para conectores de terceros en el futuro | Sólo cabecera fija | Todo por el MCP de Biguá |
| 3.3 | ¿Límites de **cantidad de herramientas** por conector, **tamaño de respuesta** y **tiempo** por llamada? | B | `reglas.manual` devuelve instrucciones largas | Decenas de KB y 60 s | Reglas partidas por sección |
| 3.4 | ¿Las llamadas a herramientas MCP **pasan por la revisión automática** (`06` A4) en corridas desatendidas? ¿Se puede marcar un conector como confiable? | B | Todo el modelo son llamadas MCP sin una persona mirando | No se bloquean las de un conector ya agregado | Probar en el canario qué se bloquea y ajustar nombres y descripciones de las herramientas |
| 3.5 | Ante un 429 o 5xx del servidor MCP, ¿el bot **reintenta** solo? | I | El gateway limita por cupo y por cliente | Reintenta alguna vez | Las herramientas dicen en el texto cuándo reintentar |
| 3.6 | ¿Se puede **apagar un conector o una herramienta para un bot** en particular? (`06` 5.1 dice que son de la cuenta) | I | Que `seguimiento`, que lee texto de terceros, no vea herramientas que no usa | No | Las reglas duras del gateway como red (`09` §6) |
| 3.7 | ¿El conector manda alguna **identificación del bot** que llama? | D | Saber en el gateway qué bot hizo cada envío | No | El bot se identifica con un parámetro |

## 4. Routines

| # | Pregunta | Prio | Por qué importa | Supuesto | Si no |
|---|---|---|---|---|---|
| 4.1 | ¿Cuánto puede durar una **corrida** y cuántas llamadas a herramientas aguanta antes de que el contexto se degrade o se compacte? | I | El `prospector` trabaja tandas de 10 a 20 cuentas | Decenas de llamadas | Tandas más chicas y más routines |
| 4.2 | ¿Hay **límite de routines** por bot y por cuenta? | D | Cinco bots con dos a cuatro routines | Sin límite práctico | Juntar routines |
| 4.3 | ¿Grok **avisa cuando una routine falla** o no corre? (`06` 7.4, sin dato) | I | Saber que el proceso se cortó | No | Bitácora en el gateway con alerta (`09` §8) |

## 5. Navegador (Dripify, LinkedIn, WhatsApp)

| # | Pregunta | Prio | Por qué importa | Supuesto | Si no |
|---|---|---|---|---|---|
| 5.1 | ¿El navegador puede **subir un archivo del box** a una página (un CSV de leads a Dripify)? ¿Y descargar? | I | Cargar leads por URL en lote | Sí | Cargar de a uno pegando la URL |
| 5.2 | ¿El agente puede **leer el texto** de la página (mensajes en Dripify o WhatsApp) para devolverlo completo? | I | Pasar las respuestas a `seguimiento` y a HubSpot tal cual | Lee el texto visible | Transcripción por visión, con verificación |
| 5.3 | ¿Cuántas acciones de navegador por hora son razonables antes de que la corrida se vuelva lenta o cara? | I | Volumen de carga en Dripify y de WhatsApp | 20 a 40 por hora | Lotes por CSV |
| 5.4 | ¿El box está **encendido 24 h** y Chrome queda abierto entre corridas? (`06` 2.7, sin dato) | I | Lectura de respuestas de LinkedIn y WhatsApp | Sí | Lecturas sólo en horario hábil |

## 6. Costo

| # | Pregunta | Prio | Por qué importa | Supuesto | Si no |
|---|---|---|---|---|---|
| 6.1 | ¿**Cómo se mide el uso**: por token, por minuto de navegador, por corrida, por mensaje entre bots? ¿Se ve por bot? | B | Costo por cliente; la conversación entre bots agrega uso | Por cuenta, sin detalle | Estimarlo en el piloto por corridas |
| 6.2 | ¿Hay **API o exportación** del consumo? | I | Llevarlo al panel de Biguá | No | Carga manual mensual |
| 6.3 | Precio por volumen para N cuentas (`06` A.4 #3, pendiente) | B | Modelo de negocio | — | — |

## 7. Personas del cliente

| # | Pregunta | Prio | Por qué importa | Supuesto | Si no |
|---|---|---|---|---|---|
| 7.1 | ¿Un usuario del cliente puede **chatear sólo con el `orquestador`** sin ver los otros bots, el box, los secretos ni el historial de las routines? | D | Hoy aprueba un operador de Biguá; serviría si más adelante el cliente quiere hablar con el bot | No confirmado (`06` 1.1) | La capa de integración (Teams, Slack, mail) de `09` etapa 8 |
| 7.2 | ¿El `orquestador` puede **avisarle al operador de Biguá** que hay una aprobación pendiente (notificación de la app, mail, Slack), o el líder tiene que entrar a mirar? | B | Un positivo no puede esperar a que alguien abra la app | Notificación de la app | Aviso por mail desde el gateway con un enlace al chat |
| 7.3 | Si el líder contesta en el chat horas después, ¿el `orquestador` retoma con el contexto de la aprobación pedida? | I | Aprobaciones que no son inmediatas | Sí, es el mismo chat | El `orquestador` relee lo pendiente en el registro |
