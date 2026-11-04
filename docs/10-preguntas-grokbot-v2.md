# Preguntas a Grok Bot · arquitectura v2

Para validar `09-arquitectura-v2.md`. Complementa a `05-preguntas-grokbot.md`: lo ya respondido
en `06-respuestas-grokbot.md` no se repite, salvo cuando la v2 lo vuelve crítico. Lo que quedó
pendiente para soporte en `06` A.4 (miembros, datos, DPA, SLA) sigue vigente.

Cada pregunta dice por qué importa, qué supone el diseño hoy y qué se hace si la respuesta es no.
Prioridad: **B** bloquea la v2 · **I** importante · **D** deseable.

Formato de respuesta sugerido, igual que en `06`: respuesta + fuente (**Probado**, **Producto**
o **Sin dato**).

## 1. Perfil, skills y memorias (estandarización)

| # | Pregunta | Prio | Por qué importa | Supuesto | Si no |
|---|---|---|---|---|---|
| 1.1 | ¿Las **memorias de trabajo** se crean solas? ¿Se pueden apagar, fijar (sólo lectura) o borrar por bot, a mano o por archivo? | B | Si cada bot acumula memorias propias, dos clientes con el mismo manual se comportan distinto sin que se vea | Se pueden apagar o al menos borrar | Instrucción en el perfil de no guardar memorias de comportamiento + revisión semanal y borrado manual |
| 1.2 | ¿Qué largo máximo tiene el **perfil** (instrucciones permanentes) de un bot? ¿Se puede editar sin reimportar la plantilla? ¿Queda historial de cambios? | I | El arranque de cada bot vive ahí | Unos miles de caracteres, editable a mano | Perfil más corto y todo lo demás en el manual |
| 1.3 | ¿Un **skill** se aplica sólo cuando el prompt lo nombra, o el bot lo elige solo por relevancia? Si se edita el archivo, ¿la próxima corrida usa la versión nueva? | I | Define si los skills sirven como copia local del manual (§4.3 de `09`) | Sólo si se nombra; la edición se toma en la próxima corrida | No usar skills |
| 1.4 | ¿Se puede **actualizar una plantilla ya importada** en todas las cuentas, o hay que reimportar? Al reimportar, ¿qué pasa con las routines, las memorias y los conectores de esa cuenta? | I | Cambiar el arranque en N clientes | Hay que reimportar a mano | El arranque se diseña para cambiar lo menos posible |
| 1.5 | ¿Qué **modelo** usan los bots? ¿Avisan cuando cambia? ¿Se puede fijar una versión? | I | Un cambio de modelo cambia el comportamiento con el mismo manual | No se puede fijar | Banco de pruebas corrido seguido en el tenant canario (`09` §4.2) |

## 2. Herramientas MCP remotas

| # | Pregunta | Prio | Por qué importa | Supuesto | Si no |
|---|---|---|---|---|---|
| 2.1 | ¿Hay límites de **cantidad de herramientas** por conector, de **tamaño de respuesta** y de **tiempo** por llamada? | B | `sdr.manual` devuelve instrucciones largas; `sdr.siguiente` trae contexto | Respuestas de hasta decenas de KB y 60 s por llamada | Manual partido en secciones, o copia local como skill |
| 2.2 | ¿El conector soporta **prompts y recursos MCP** además de herramientas? | D | El manual podría servirse como prompt MCP nativo | Sólo herramientas | `sdr.manual` como herramienta |
| 2.3 | ¿Se puede **apagar un conector o una herramienta para un bot** en particular? (`06` 5.1 dice que los conectores son de la cuenta) | I | Que `bandeja`, que lee texto de terceros, no vea herramientas que no usa | No se puede | Todas las reglas de envío y gasto en la plataforma (ya es así en `09` §10) |
| 2.4 | ¿Las llamadas a herramientas MCP **pasan por la revisión automática** (`06` A4)? ¿Se puede marcar un conector como confiable para que las routines no queden bloqueadas? | B | Toda la v2 son llamadas MCP en corridas desatendidas | No se bloquean las de un conector ya agregado | Probar en el canario qué se bloquea y ajustar los nombres y descripciones de las herramientas |
| 2.5 | Si el servidor MCP responde 429 o 5xx, ¿el bot **reintenta** solo? ¿Cada cuánto? | I | La plataforma limita pedidos por cliente | Reintenta alguna vez | Las herramientas devuelven «reintentá en N segundos» en el texto |
| 2.6 | ¿El conector manda alguna **identificación del bot** que llama (nombre, id) en cabeceras? | D | Saber qué bot hizo cada llamada sin confiar en un parámetro | No | El bot se identifica con un parámetro y se cruza con el tipo de tarea |

## 3. Routines, concurrencia y despertar

| # | Pregunta | Prio | Por qué importa | Supuesto | Si no |
|---|---|---|---|---|---|
| 3.1 | ¿Pueden correr **al mismo tiempo dos bots distintos** de la misma cuenta? (`06` 3.3 quedó sin dato) | B | `bandeja` tiene que poder correr mientras `investigador` trabaja | Sí | Un solo bot trabajador que toma cualquier tipo de ítem por prioridad |
| 3.2 | Si una routine de un bot dispara mientras **la anterior del mismo bot sigue corriendo**, ¿se encola, se saltea o corre en paralelo? | B | Routines cada 15 minutos con corridas que pueden durar más | Se saltea | Corridas acotadas por tiempo en el manual |
| 3.3 | **Disparo por webhook:** ¿qué URL y qué autenticación (secreto, firma)? ¿El cuerpo del pedido le llega al prompt? ¿Qué latencia y qué límite de disparos hay? | I | La plataforma despierta a `bandeja` cuando llega un interesado | URL con secreto, el cuerpo llega al prompt, menos de un minuto | Routine de `bandeja` cada 5 minutos en horario hábil |
| 3.4 | ¿Cuánto puede durar una **corrida** y cuántas llamadas a herramientas puede hacer antes de que el contexto se degrade o se compacte? | I | Un `investigador` que procesa 20 cuentas por corrida | Decenas de ítems | Corridas de N ítems y salida; la routine vuelve a disparar |
| 3.5 | ¿Hay **límite de routines** por bot y por cuenta? | D | Cinco bots con dos a cuatro routines cada uno | Sin límite práctico | Juntar routines |

## 4. Bots entre sí

| # | Pregunta | Prio | Por qué importa | Supuesto | Si no |
|---|---|---|---|---|---|
| 4.1 | Un **mensaje de un bot a otro**: ¿despierta al receptor aunque no tenga routine? ¿Es asincrónico? ¿Queda registrado? | D | El `coordinador` pide «corré ahora» a otro bot | Despierta y queda en el historial | Sólo routines y webhook |
| 4.2 | Los **subagentes** de un bot, ¿usan los mismos conectores? ¿Cuentan como otra corrida a efectos de concurrencia y costo? | D | Paralelizar dentro de `investigador` | Mismos conectores | No usar subagentes |

## 5. Navegador (LinkedIn, Dripify, WhatsApp)

| # | Pregunta | Prio | Por qué importa | Supuesto | Si no |
|---|---|---|---|---|---|
| 5.1 | ¿El navegador puede **subir un archivo del box** a una página (por ejemplo un CSV a Dripify)? ¿Y descargar? | I | Cargar listas en campañas de Dripify | Sí, ambos | Cargar contactos de a uno, o por una URL de búsqueda de Sales Navigator |
| 5.2 | ¿El agente puede **leer el texto** de la página (mensajes de LinkedIn o WhatsApp) para devolverlo completo, o sólo lo que ve en capturas? | I | Subir las respuestas a la plataforma tal cual | Lee el texto visible | Transcripción por visión, con verificación |
| 5.3 | ¿Cuántas acciones de navegador por hora son razonables antes de que la corrida se vuelva lenta o cara? | I | Volumen de LinkedIn ítem por ítem | 20 a 40 acciones por hora | Usar campañas de Dripify |
| 5.4 | ¿El box está **encendido 24 h** y Chrome queda abierto entre corridas? (`06` 2.7, sin dato) | I | Lectura de WhatsApp cada hora | Sí | Lecturas sólo en horario hábil |

## 6. Personas del cliente

| # | Pregunta | Prio | Por qué importa | Supuesto | Si no |
|---|---|---|---|---|---|
| 6.1 | ¿Un usuario del cliente puede **chatear con un solo bot** (el `coordinador`) sin ver los demás bots, el box, los secretos ni el historial de las routines? | I | Que el cliente pregunte «¿cómo vamos?» en lenguaje natural | No confirmado (`06` 1.1) | Las preguntas del cliente se responden en el panel |
| 6.2 | ¿Un **bot de equipo** puede tener miembros externos a la cuenta? ¿Qué ven? | D | Variante de 6.1 | — | Igual que 6.1 |

## 7. Costo y medición

| # | Pregunta | Prio | Por qué importa | Supuesto | Si no |
|---|---|---|---|---|---|
| 7.1 | ¿**Cómo se mide el uso**: por token, por minuto de navegador, por corrida? ¿Se puede ver por bot o por routine? | B | Costo por cliente contra lo que se cobra (`09` §8.3) | Por cuenta, sin detalle | Estimar por cantidad de corridas e ítems |
| 7.2 | ¿Hay **API o exportación** del consumo? | I | Llevarlo al panel de Biguá | No | Carga manual mensual |
| 7.3 | Precio por volumen para N cuentas (`06` A.4 #3, sigue pendiente) | B | Modelo de negocio | — | — |
