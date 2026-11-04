# Respuestas de Grok Bot a la consulta v2 e impacto en el diseño

Respuesta de Grok Bot a `10-preguntas-grokbot-v2.md`, recibida el 04/11/2026, con un repaso de
Dripify (documentación oficial y experiencia del equipo de headhunting de Biguá). La parte A es
lo que cambia en el diseño; las decisiones ya están aplicadas en `09` y `11`. La parte B es la
respuesta textual.

---

## Parte A · Impacto en el diseño

### A.1 Lo que cambia

| # | Respuesta | Cambio | Dónde |
|---|---|---|---|
| 1 | **La revisión automática (Auto Review) sí revisa las llamadas MCP, también desatendidas**, y lo que nace en una routine, un webhook o un mensaje de otro bot **vence a los ~30 minutos** si nadie lo aprueba. Se controla con reglas **Allow** y **Ask first** (hasta 20 de cada una; gana Ask first) | Las aprobaciones del SDR **no son tarjetas de Grok**: son datos en el registro. Los bots piden aprobación con `registro.pedir_aprobacion`; el operador aprueba en el chat del `orquestador`; el gateway exige la aprobación registrada antes de ejecutar lo que la necesita. Con eso, las herramientas del MCP de Biguá llevan regla **Allow** (ver A.2, desacuerdo 1) | `09` §5.4, §6, §11 |
| 2 | **No hay perfil de bot**: la identidad es memoria. **Las memorias no se pueden apagar** ni dejar en sólo lectura, y la revisión automática no mira lo que el bot memoriza | Nada que tenga que ser igual entre clientes vive en el bot. **Cada routine se presenta sola**: dice qué bot es, de qué cliente, y que pida sus reglas con `reglas.manual`. No depende de que el bot recuerde nada. Revisión semanal de memorias | `09` §3 |
| 3 | **Actualizar una plantilla no se propaga** a las cuentas que ya la importaron (sin dato de lo contrario). Un bot **puede crear routines por herramienta** (probado) | El alta de una cuenta no depende de plantillas: el `orquestador` pide `reglas.alta()` y crea las routines de todos los bots desde esa lista. La plantilla queda como comodidad | `09` §9 |
| 4 | **El modelo cambia de un pedido a otro** y no se puede fijar | Casos de prueba de regresión **semanales**, con entradas fijas y la salida esperada guardada en Supabase | `09` §3 |
| 5 | **Mensaje entre bots:** despierta al otro y es **asincrónico** («mandar y seguir»); latencia sin dato; **qué pasa si el receptor está ocupado, sin dato**; cada mensaje entre bots **cuesta uso** | Los pedidos entre bots se escriben **en el registro** (fuente de verdad); el mensaje sólo despierta. Cada bot revisa sus pedidos pendientes al empezar y al terminar. Menos mensajes entre bots: sólo cuando hace falta que el otro actúe ya | `09` §4.3 |
| 6 | **Dos bots corren a la vez** (cada uno con su pantalla). La computadora es **por asiento**: los bots de un asiento comparten archivos, sesiones y logins | Confirma la concurrencia. Una sesión de WhatsApp Web por asiento: un cliente con dos números de WhatsApp necesita dos asientos | `09` §4.1 |
| 7 | **Dripify tiene Open API** (cargar hasta 1.000 leads por pedido con `linkedinUrl` y campos propios, leer actividad y conversaciones, mandar mensajes, blacklist) y **MCP propio** (sólo listar y cargar). Límite: 60 pedidos por minuto y 5.000 por día **por API key** | **Dripify por API, sin navegador.** Herramientas `dripify.*` en el MCP de Biguá sobre la Open API, con caché y límite de pedidos, normalización de URL y verificación de la carga. **Desaparece el bot `linkedin`**: carga el `prospector` y lee `seguimiento` | `09` §4.1, §5.3; `11` §3.3.1 |
| 8 | **El webhook de respuesta de Dripify se dispara sólo con la primera respuesta** del lead en la campaña; trae la conversación completa | El webhook es **disparador, no fuente de verdad**: al recibirlo, `seguimiento` lee la conversación por API; y una pasada periódica revisa las conversaciones activas | `09` §5.3; `11` §3.3.1 |
| 9 | **Webhook de routine:** URL + `Authorization: Bearer <key>`, el cuerpo llega al prompt, un 200 es «arrancó» (no «terminó»), **300 corridas por hora por cuenta y 200 por routine, sin reintento** | El gateway reintenta con espera, agrupa avisos (despierta una vez con la lista, no una por evento) y no da nada por procesado hasta que `seguimiento` lo escribe en el registro | `09` §7 |
| 10 | **Notificaciones:** con el switch `Notifications`, el bot avisa cuando termina o cuando espera aprobación (escritorio y teléfono) | `Notifications` prendido en el `orquestador` de cada cliente; aviso por mail desde el gateway si un positivo pasa N horas sin aprobar | `09` §5.4 |
| 11 | **Shared Bot no es frontera de seguridad** (usa apps y secretos del dueño) | Para que el cliente hable con el bot más adelante: capa propia (Teams, Slack, mail), no Shared Bots | `09` §9 |
| 12 | **El mail propio del bot desde una routine siempre queda borrador**; Agent Email apagado por defecto en equipos | Nada del flujo usa el mail del bot: todo por el gateway (ya era así) | — |
| 13 | **Costo por pasos y tokens**; hay vista de uso por bot y por sesión en la app; sin API de consumo | Medir el piloto con esa vista; carga manual mensual al panel | `09` §8 |
| 14 | **Datos:** computadoras en EE. UU.; borrado hasta 30 días después de terminar; proveedores de modelo sin retención; Privacy Mode evita el entrenamiento; auditoría formal sólo Enterprise | Privacy Mode prendido en todas las cuentas. Contrato: no prometer residencia de datos ni SLA hasta hablar con el account team | — |

### A.2 Dónde no seguimos la recomendación, y por qué

**Desacuerdo 1 · Allow también para las herramientas que envían.** Grok recomienda Allow para
lectura y **Ask first** para envío. Pero un Ask first en una corrida desatendida genera una
tarjeta que **vence a los 30 minutos**: el `prospector` no podría mandar nada de noche ni en una
tanda sin alguien mirando, y la calibración ya no tendría sentido. En nuestro diseño, lo que una
persona tiene que aprobar se aprueba **antes**, en el chat del `orquestador`, y queda en el
registro; el gateway no deja ejecutar sin esa aprobación (calibración, respuesta a positivos,
primera carga en el CRM) y además pone cupo, idempotencia, supresión y máximo de destinatarios.
Las barandas están del lado del servidor, que es donde no dependen de un LLM ni de una tarjeta.
Queda **Ask first** sólo para lo que no tiene baranda en el servidor.

**Desacuerdo 2 · Un solo bot hablando con Dripify.** Grok sugiere que sólo un bot hable con
Dripify por el límite de pedidos. Lo resolvemos del otro lado: las herramientas `dripify.*` del
MCP de Biguá cachean y limitan los pedidos por API key, así cualquier bot puede usarlas sin
agotar el cupo, y no hace falta un bot sólo para eso.

### A.3 Lo que hay que probar antes de construir encima

Grok corrió 2 de las 6 pruebas. Quedan, y las corre Biguá en la cuenta canario en la etapa 0 de
`09` §9:

| Prueba | Por qué no se puede dar por hecha |
|---|---|
| Latencia de un mensaje entre bots, y qué pasa si el receptor está ocupado | Define si un pedido urgente puede ir por mensaje o tiene que ir por webhook |
| Dos routines de dos bots a la misma hora | Está documentado, no probado |
| Una routine que llama a una herramienta del MCP de Biguá **con y sin regla Allow** | Ver con los propios ojos que con Allow no se frena y sin Allow vence a los 30 minutos |
| Tamaño y tiempo de respuesta MCP | `reglas.manual` puede devolver mucho texto; se prueba con una herramienta de prueba del MCP de Biguá que devuelve N KB con N segundos de demora |
| Reintento ante un error 500 | Que el bot no reintente solo un envío (el gateway ya es idempotente, pero hay que saberlo) |
| Webhook de routine: latencia real y cuerpo en el prompt | Es como el gateway despierta a `seguimiento` |
| Dripify: que el plan tenga Open API (si no, 403) y el JSON real del webhook | Todo el canal LinkedIn depende de eso |

---

## Parte B · Respuesta textual

Tal cual la recibimos. Las citas a `/workspace/docs` y a `/workspace/bigua-fleet` son archivos
del box de la cuenta de Grok Bot de Biguá, no de este repo.


Respuesta punto por punto a `consulta-sdr-v2.md` (Partes C, D y E), al 4 de noviembre de 2026.

### Cómo leerlo

Tres niveles de fuente, y no se mezclan:

| Etiqueta | Qué significa |
|---|---|
| `Probado` | Lo corrimos en el box o con herramientas de esta cuenta el 4/11/2026. Vale más que la doc. |
| `Producto` | Está en la documentación oficial (docs.x.ai/grok-bot), citada con página y sección. |
| `Sin dato` | No lo pudimos verificar y no está documentado. No lo inventamos: falta preguntarlo o probarlo. |

Dos advertencias antes de seguir:

- Lo `Probado` se corrió en el box de esta cuenta. Lo `Producto` es documentación: puede estar atrás del producto, y cuando la doc y la prueba se contradicen gana la prueba.
- Todo lo `Sin dato` es una deuda del diseño: no se puede construir encima como si fuera cierto. La lista está al final, con a quién preguntarle.

Las citas remiten a los `.txt` de `/workspace/docs` (página y sección). Cuando digo "la doc" es esa copia.

---

### Parte C · Supuestos S1–S15

Un ítem por supuesto. El último renglón de cada uno dice si hay que tocar la Parte A del diseño o no.

**S1 — Un mensaje de un bot a otro despierta al receptor en menos de un minuto**

- **Respuesta:** Despierta y atiende el pedido aunque no tenga routine, y puede responder después. La latencia no está documentada: el "menos de un minuto" no lo podemos afirmar.
- **Fuente:** `Producto` · chat-and-collaboration §Let Bots hand work off
- **Qué cambia en la parte A:** nada de fondo; sacar el "menos de un minuto" del diseño y de la promesa al cliente.

**S2 — Dos bots de la misma cuenta corren al mismo tiempo**

- **Respuesta:** Sí. Cada bot tiene su propia pantalla en la computadora compartida: razonan, usan conectores y navegan en paralelo. Por bot, una tarea de computer-use a la vez.
- **Fuente:** `Producto` · computer-and-apps §One computer, shared by all your Bots · faq §Can several Bots work at the same time? · §Do my Bots share one computer?
- **Qué cambia en la parte A:** nada en la concurrencia: los 5 bots en 2 asientos se sostienen. Pero ojo, la computadora es por miembro y no por bot: los bots de un mismo asiento comparten archivos, sesiones de navegador y logins. La sesión de LinkedIn de cada vendedor va en un asiento distinto.

**S3 — Si recibe un mensaje mientras corre, se encola y lo procesa después**

- **Respuesta:** `Sin dato` para el caso entre bots. Lo documentado es otra cosa: un mensaje directo del usuario tiene prioridad y puede redirigir el turno. No hay cola visible.
- **Fuente:** `Sin dato` · chat-and-collaboration §Redirect work in progress (es lo único documentado)
- **Qué cambia en la parte A:** el diseño no puede apoyarse en una cola: los pedidos van al registro y cada bot los levanta en su routine.

**S4 — Los mensajes entre bots quedan registrados en el historial**

- **Respuesta:** Sí, el ida y vuelta se ve en la conversación. No hay exportación documentada. Auditoría real: Audit Logs y Action Recording, las dos Enterprise; Action Recording guarda 90 días y sale sólo por OpenTelemetry Export.
- **Fuente:** `Producto` · chat-and-collaboration §Let Bots hand work off · security §Logging and audit
- **Qué cambia en la parte A:** la auditoría va al registro propio (Supabase), no al historial de Grok Bot.

**S5 — La revisión automática no bloquea las llamadas a un MCP ya agregado en una routine**

- **Respuesta:** Falso, va al revés. Auto Review revisa llamadas a apps y MCP, también las desatendidas, y las aprobaciones nacidas en una routine, un trigger o un mensaje de otro bot vencen a los ~30 minutos. Con Enforce Auto-review (Enterprise) también frenan.
- **Fuente:** `Producto` · approvals-security-and-privacy §Review an action y §If you don't answer · troubleshooting §An approval expired or is blocked
- **Qué cambia en la parte A:** reglas Allow para las tools de lectura y Ask first para las de envío. Sin eso, los bots se frenan solos.

**S6 — B9 también aplica a las tools MCP que envían y alcanza con el prompt de la routine**

- **Respuesta:** No. B9 no lo aplica Grok Bot solo. Auto Review sí frena la herramienta de envío, pero con una regla Allow el envío sale sin humano. Y el mail del bot escrito en una routine siempre queda como borrador.
- **Fuente:** `Producto` · approvals-security-and-privacy §Review an action · computer-and-apps §Sending mail
- **Qué cambia en la parte A:** envíos por `gateway.enviar`, con cupos y reglas duras del lado del servidor. Nunca por el email propio del bot.

**S7 — Un MCP puede devolver decenas de KB y tardar 60 segundos**

- **Respuesta:** `Sin dato`. No hay límite documentado de tamaño de respuesta ni de tiempo por llamada.
- **Fuente:** `Sin dato` · no aparece en ninguna página de la doc
- **Qué cambia en la parte A:** `reglas.manual` partido por sección (índice corto + secciones) y prueba de carga antes de escribir las reglas definitivas.

**S8 — Las memorias de trabajo se pueden apagar o borrar**

- **Respuesta:** No. No hay pantalla de memoria en bots personales, no se apagan ni se dejan en sólo lectura, y el bot guarda solo sin preguntar. Borrar el bot borra su memoria. En Enterprise tampoco hay control.
- **Fuente:** `Producto` · bots §See, correct, or remove a memory · §When a Bot saves something
- **Qué cambia en la parte A:** instrucción explícita de no guardar memoria de comportamiento y revisión semanal (ya previsto).

**S9 — Si el operador contesta horas después, el bot retoma con el contexto**

- **Respuesta:** Sí, si el pedido nació en el chat del usuario: la tarjeta espera y no vence por reloj, y el bot retoma con el contexto.
- **Fuente:** `Producto` · approvals-security-and-privacy §If you don't answer
- **Qué cambia en la parte A:** nada, y confirma que la aprobación tiene que pedirse en el chat y no en una routine.

**S10 — El operador recibe una notificación cuando el bot pide una aprobación**

- **Respuesta:** Sí, con el switch `Notifications` del bot: avisa cuando termina o cuando espera aprobación. En macOS y Windows va a la notificación del escritorio; si no lo abrís, al teléfono a los ~3 minutos. En Linux la notificación de escritorio se suprime mientras la app está enfocada y el teléfono avisa igual.
- **Fuente:** `Producto` · settings-and-notifications §Control notifications
- **Qué cambia en la parte A:** prender `Notifications` en el `orquestador` el día uno; sumar aviso por mail si el operador no tiene la app en el teléfono.

**S11 — El webhook de una routine tiene URL con secreto, el cuerpo llega al prompt y dispara en menos de un minuto**

- **Respuesta:** URL (`POST to`), secreto (`key`) y `Authorization: Bearer <key>`: sí. JSON opcional y el cuerpo llega con la instrucción: sí. Un 200 significa que arrancó, no que terminó. Límites: 300 corridas/hora por cuenta y 200/hora por routine, sin reintento. Latencia: no documentada.
- **Fuente:** `Producto` · skills-routines-and-automations §Webhooks y §Rate limits · `Probado`: la routine se creó y quedó enabled por herramienta, con URL y clave visibles en la app
- **Qué cambia en la parte A:** el gateway reintenta y es idempotente: el 200 no es "hecho".

**S12 — El bot escribe un CSV en el box y el navegador lo sube a una página**

- **Respuesta:** Sí, con una salvedad. El CSV en `/workspace` y la subida por ruta absoluta desde código funcionan. El diálogo nativo del sistema no se dibuja en pantalla, así que no se "tipea" a mano. La descarga no la probamos.
- **Fuente:** `Probado` · 4/11/2026: CSV de 105 bytes escrito y subido en una página de prueba
- **Qué cambia en la parte A:** el import de Dripify por CSV es viable, pero deja de ser necesario: Dripify ya tiene Open API y MCP server propio para cargar leads sin navegador (ver sección de Dripify). Si el sitio exige arrastrar el archivo, ese paso lo da el humano.

**S13 — El navegador puede leer el texto de la página, no sólo verla**

- **Respuesta:** Sí, con `innerText`, sin visión: devolvió párrafos completos.
- **Fuente:** `Probado` · 4/11/2026, sobre un sitio de prueba
- **Qué cambia en la parte A:** nada; volcar la respuesta de WhatsApp como texto crudo al registro.

**S14 — El box está 24 h y Chrome mantiene la sesión entre corridas**

- **Respuesta:** Sí: días de uptime, perfil persistente y sesión que se mantiene; hiberna sola y despierta al próximo mensaje. Contrapartida: un sitio puede pedir re-login, y `Terminate Inactive Computers` (Enterprise, apagado por defecto) termina el box a los 30 días sin mensajes; el disco durable queda, así que al próximo mensaje arranca con bots, archivos y logins, pero se pierden los paquetes instalados a mano.
- **Fuente:** `Probado` · 4/11/2026 · `Producto` · computers §Terminate inactive computers automatically
- **Qué cambia en la parte A:** lecturas de WhatsApp fuera de horario sí, con plan B: si el sitio pide re-login, avisa y entra el humano.

**S15 — No se puede fijar el modelo, pero cambia pocas veces**

- **Respuesta:** Se puede fijar: no. "Cambia pocas veces" es suposición nuestra: puede cambiar de un pedido a otro y usar modelos de terceros. El allowlist del team no aplica.
- **Fuente:** `Producto` · faq §Can I pick the model? · security §Models and data
- **Qué cambia en la parte A:** casos de prueba de regresión frecuentes, con la misma entrada y la salida esperada.

Dos supuestos no son "falsos" pero sí están mal escritos: **S5** dice lo contrario de lo que pasa y **S6** da por hecho que B9 viaja solo al MCP. Los dos están corregidos arriba y en "Lo que cambia el diseño".

---
### Parte D · Preguntas

#### 1. Conversación entre bots y concurrencia

**1.1 — ¿Pueden correr al mismo tiempo dos bots distintos de la misma cuenta?**

- **Respuesta:** Sí. Cada bot tiene su propia pantalla en la computadora compartida, así que pueden razonar, usar conectores y navegar en paralelo. El límite es por bot: uno corre una tarea de computer-use a la vez.
- **Fuente:** `Producto` — computer-and-apps, "One computer, shared by all your Bots": "Each Bot gets its own screen... although one Bot can run only one computer-use task on its screen at a time". También faq, "Can several Bots work at the same time?". No lo corrimos como prueba de concurrencia (ver Parte E, prueba 2).
- **Qué cambia en la parte A:** nada. Los 5 bots en 2 asientos se sostienen. Lo que no se puede es separar sesiones dentro del mismo asiento: la computadora es por miembro y los bots comparten archivos y sesiones de navegador, así que la sesión de LinkedIn de cada vendedor vive en un asiento distinto (su propia cuenta), no en un bot distinto del mismo asiento.

**1.2 — Cuando un bot le manda un mensaje a otro, ¿el receptor se despierta sin routine? ¿Cuánto tarda?**

- **Respuesta:** Sí, despierta sin routine, atiende el pedido y puede responder después. La latencia no está documentada, así que no prometemos "menos de un minuto".
- **Fuente:** `Producto` — chat-and-collaboration, "Let Bots hand work off": "A Bot can send an asynchronous message to another Bot. The receiving Bot wakes, handles the request, and can reply later. You can see the handoff in the conversation."
- **Qué cambia en la parte A:** sacar el "menos de un minuto" del diseño y de cualquier promesa al cliente. Si un pedido necesita latencia, se dispara por webhook, no por mensaje entre bots.

**1.3 — ¿El que manda puede esperar la respuesta en su corrida, o es "mandar y seguir"?**

- **Respuesta:** Asincrónico: el receptor atiende y puede responder después. Que el que manda pueda esperar la respuesta dentro de su corrida no está documentado, así que el diseño tiene que asumir mandar y seguir.
- **Fuente:** `Producto` para el asincrónico — chat-and-collaboration, "Let Bots hand work off" ("asynchronous message... can reply later"). La espera bloqueante: `Sin dato`.
- **Qué cambia en la parte A:** el recorrido de A.4, pasos 5 y 6, no puede ser una llamada con retorno. `seguimiento` deja el pedido y sigue; el `orquestador` recibe la propuesta como mensaje aparte, y el estado se lee en el registro.

**1.4 — ¿Los mensajes entre bots quedan registrados y se pueden ver o exportar?**

- **Respuesta:** Se ven en la conversación. Exportar, no: no hay exportación documentada. Para auditoría formal hay Audit Logs (control plane) y Action Recording (acciones del bot, 90 días, exportable sólo por OpenTelemetry), las dos Enterprise.
- **Fuente:** `Producto` — chat-and-collaboration, "Let Bots hand work off"; security, "Logging and audit"; teams-and-enterprises, "Action Recording".
- **Qué cambia en la parte A:** la auditoría del SDR va al registro propio, no al historial de Grok Bot. Si un cliente pide auditoría formal, es Enterprise más OTel, y hoy no lo tenemos.

**1.5 — Si recibe un mensaje mientras corre, ¿se encola, lo interrumpe o se pierde?**

- **Respuesta:** `Sin dato` para el caso entre bots. Lo único documentado es que un mensaje directo del usuario tiene prioridad y puede redirigir el turno en curso. No hay cola visible ni límite de solape documentado.
- **Fuente:** `Sin dato` — chat-and-collaboration, "Redirect work in progress" (lo documentado cubre sólo el mensaje del usuario).
- **Qué cambia en la parte A:** no se puede garantizar que un pedido que llega en medio de una tanda se atienda. Cada bot tiene que chequear el registro al empezar y al terminar, y el pedido se reintenta desde ahí.

**1.6 — Si una routine dispara mientras la anterior del mismo bot sigue corriendo, ¿se encola, se saltea o corre en paralelo?**

- **Respuesta:** `Sin dato`. No hay nada documentado sobre solape entre routines del mismo bot. Lo único que acota el caso es que un bot corre una tarea de computer-use a la vez en su pantalla; qué hace la segunda corrida (esperar, saltearse o correr sin navegador) no está documentado.
- **Fuente:** `Sin dato` — computer-and-apps, "One computer, shared by all your Bots" (el límite de una tarea de computer-use por bot es lo único cercano, y no responde la pregunta).
- **Qué cambia en la parte A:** una franja por bot para trabajo de navegador y un lock en el registro antes de arrancar. Si dos corridas se solapan, la segunda no puede avanzar.

**1.7 — ¿Hay protección contra bucles de mensajes entre bots? ¿Cómo se cobran?**

- **Respuesta:** Protección, no hay documentada. Lo que sí está: no existe un switch para impedir que los bots se escriban (se instruye), y cada respuesta entre bots consume uso como cualquier otra.
- **Fuente:** `Sin dato` para el bucle. `Producto` para el resto — chat-and-collaboration, "Stop Bots from messaging each other": "There is no switch for this"; y "Every Bot reply counts toward your usage, including replies in a group and messages between Bots".
- **Qué cambia en la parte A:** el tope de idas y vueltas en las reglas (ya previsto) más un contador en el registro. Es lo único que frena un bucle: no hay red de producto.

**1.8 — Webhook de una routine: ¿qué URL y qué autenticación, el cuerpo llega al prompt, latencia y límite?**

- **Respuesta:** URL en `POST to`, secreto en `key`, y el header `Authorization: Bearer <key>`. Acepta JSON opcional y el cuerpo llega con la instrucción. Un 200 significa que la corrida arrancó, no que terminó. Límites: 300 corridas/hora por cuenta y 200/hora por routine; al excederse falla y no reintenta. Latencia: no documentada.
- **Fuente:** `Producto` — skills-routines-and-automations, "Webhooks" y "Rate limits". `Probado` el 4/11: la routine con disparo por webhook se crea y queda enabled por herramienta, y la URL y la clave se ven en la app.
- **Qué cambia en la parte A:** el gateway reintenta y manda clave de idempotencia, porque el 200 no es "hecho" y el rate limit no reintenta. Ningún aviso se da por procesado hasta que `seguimiento` escribe en el registro.

**1.9 — Los subagentes, ¿usan los mismos conectores? ¿Cuentan para concurrencia y costo?**

- **Respuesta:** `Sin dato`. Lo único documentado es que los subagentes son parte del mismo turno (los hooks de inferencia los inspeccionan junto con el resto del turno) y que su lanzamiento pasa por Auto Review. Conectores y cuenta de uso: sin documentar.
- **Fuente:** `Sin dato` — inference-hooks, "behind one turn, subagents included"; security-faq, "What does Auto Review check?" ("delegation such as Cloud Agent and subagent launches").
- **Qué cambia en la parte A:** no usarlos en el camino crítico. Si se usan, para trabajo sin conectores y con el mismo criterio de no mandar nada.

**1.10 — ¿Hay alguna función para coordinar varios bots (tablero compartido, memoria compartida, bot de equipo)?**

- **Respuesta:** Hay dos cosas, ninguna es un tablero. Un group chat de 2 a 6 bots, con los handoffs visibles, y el primary Bot, que coordina y te escribe solo. No hay memoria compartida entre bots ni tablero de tareas: comparten archivos en el box, mensajes y unos pocos datos sobre la persona.
- **Fuente:** `Producto` — chat-and-collaboration, "Start a group chat"; bots, "Your primary Bot" y "Bots have separate roles and conversations, but they share the computer".
- **Qué cambia en la parte A:** el group chat sirve como pizarra visible y los 5 bots entran. Ojo con las aprobaciones: chat-and-collaboration dice que los pedidos de aprobación, los pedidos de secretos y los borradores de mail **no aparecen en un grupo**; approvals aclara que, si hay tarjeta en un grupo, sólo la contesta quien hizo el pedido y no ofrece `Always allow`. En cualquier caso no es un circuito de aprobación: van en el chat del `orquestador`. El registro en Supabase sigue siendo la fuente de verdad.

#### 2. Estandarización del comportamiento

**2.1 — ¿Las memorias de trabajo se crean solas? ¿Se pueden apagar, fijar o borrar por bot?**

- **Respuesta:** Se crean solas: el bot decide qué guardar y no pregunta. No hay pantalla de memoria en bots personales: se piden y se corrigen por chat. No se pueden apagar ni dejar en sólo lectura, y en Enterprise no hay control de memorias. Borrar el bot borra su memoria. Encima, Auto Review no revisa las escrituras de memoria.
- **Fuente:** `Producto` — bots, "See, correct, or remove a memory" ("There is no memory screen for a personal Bot"), "When a Bot saves something", "What resets or deletes memory"; security-faq, "What does Auto Review check?" ("It does not review every side effect, such as memory writes").
- **Qué cambia en la parte A:** instrucción explícita de no guardar memoria de comportamiento ni datos de clientes, y revisión semanal de qué recuerda cada bot. Sumale que el "perfil" tampoco existe como campo (2.2): la identidad también termina en memoria.

**2.2 — ¿Qué largo máximo tiene el perfil? ¿Se edita sin reimportar? ¿Hay historial?**

- **Respuesta:** Los bots personales ya no tienen descripción ni página de settings: se les habla en el chat y lo que persiste es la memoria. Largo máximo documentado, no hay; historial de cambios, tampoco.
- **Fuente:** `Producto` — bots, "Edit a Bot" ("Personal Bots no longer have a description or a Bot settings page; to change what a Bot does, tell it in chat") y "What a Bot remembers". Largo e historial: `Sin dato`.
- **Qué cambia en la parte A:** el "perfil de cada bot" del arranque no es un campo editable: es un mensaje inicial que se guarda como memoria. Todo lo que tiene que ser igual entre clientes va en `reglas.manual`, no en el perfil.

**2.3 — ¿Un skill se aplica si el prompt lo nombra o el bot lo elige por relevancia? ¿Si se edita, la próxima corrida usa la versión nueva?**

- **Respuesta:** Se piden por nombre. En las skills publicadas, la descripción es lo que usan los bots para decidir cuándo aplica. Que un archivo editado en el box lo tome la próxima corrida no está documentado; lo que sí está es `Sync`, que empuja tus ediciones a la copia del equipo.
- **Fuente:** `Producto` — skills-routines-and-automations, "Save a skill" ("ask the Bot for it by name") y "Share a skill with your team" (descripción y `Sync`).
- **Qué cambia en la parte A:** nada urgente. Si se usan skills, que el nombre esté en la routine y que la versión viva en Supabase, no en un archivo suelto.

**2.4 — ¿Se puede actualizar una plantilla ya importada en todas las cuentas? ¿Qué pasa con routines, memorias y conectores al reimportar?**

- **Respuesta:** `Sin dato` en lo que importa. La plantilla se puede actualizar (`Update template` empuja a la copia compartida), pero no está documentado que eso alcance a las copias ya importadas en otras cuentas, ni qué pasa con routines, memorias y conectores al reimportar. Lo único claro: importar crea una copia nueva.
- **Fuente:** `Sin dato` — bots, "Share a Bot" (`Update template`, `Add a Bot from a template`). Detalle: la doc de hoy dice que el template expone "identity, description, skills, and routines" y no menciona memorias, distinto de lo que dice B11.
- **Qué cambia en la parte A:** no diseñar sobre "actualizo la plantilla y se propaga". El arranque de cada cuenta se arma con un script propio (MCP más routines), y la plantilla queda como comodidad.

**2.5 — ¿Qué modelo usan los bots? ¿Avisan cuando cambia? ¿Se puede fijar?**

- **Respuesta:** No se puede fijar. Grok Bot elige por pedido, puede cambiar de un pedido a otro y puede usar modelos de terceros. El allowlist del team no aplica y no avisa cuando cambia.
- **Fuente:** `Producto` — faq, "Can I pick the model?" ("the choice can differ from one request to the next"); security, "Models and data".
- **Qué cambia en la parte A:** regresión frecuente (semanal, no mensual) con las mismas reglas y una salida esperada guardada para comparar.

#### 3. Conectores y MCP

**3.1 — ¿Hay conectores nativos de HubSpot y Dynamics 365?**

- **Respuesta:** Hay plugin de HubSpot en el catálogo (id 49339689) y no está instalado en esta cuenta. No hay conector nativo de Dynamics 365: sólo Business Central y Dataverse. Ninguno de los dos trae los límites que necesita el SDR.
- **Fuente:** `Probado` — catálogo de plugins de la cuenta, 4/11/2026.
- **Qué cambia en la parte A:** nada. El MCP propio sigue siendo el camino, también para HubSpot; el nativo sirve sólo para consultas a mano.

**3.2 — ¿Se puede conectar un MCP remoto que pide OAuth, o sólo con cabecera fija?**

- **Respuesta:** Los conectores del catálogo se autentican con OAuth y los tokens quedan en el backend de Cursor: el bot no los ve. Para un MCP propio montado por URL, lo documentado es header fijo (`Authorization: Bearer`). Que un MCP propio pueda hacer el flujo OAuth completo no está documentado.
- **Fuente:** `Producto` para OAuth y tokens en el backend — computer-and-apps, "Connect an app" ("OAuth tokens are held on Cursor's connector backend, and the Bot invokes tools without receiving them"); security, "Connector tokens stay on Cursor's backend". Header fijo en MCP propio por URL: `Producto` (misma sección de la doc sobre conectar apps).
- **Qué cambia en la parte A:** el gateway usa un token fijo por cliente y el bot no ve nada más. Si un cliente exige OAuth en su MCP, hay que preguntarlo antes de prometerlo.

**3.3 — ¿Límites de herramientas por conector, tamaño de respuesta y tiempo por llamada?**

- **Respuesta:** `Sin dato` en los tres. Los 60 segundos y las decenas de KB no están confirmados por la doc ni por una prueba nuestra.
- **Fuente:** `Sin dato` — no aparece en ninguna página de `/workspace/docs`. Se prueba con `sdrbot` y con ASCI.
- **Qué cambia en la parte A:** `reglas.manual` devuelve un índice corto y después las secciones de a una, y hay una prueba de carga antes de escribir las reglas definitivas.

**3.4 — ¿Las llamadas MCP pasan por la revisión automática en corridas desatendidas? ¿Se puede marcar un conector como confiable?**

- **Respuesta:** Sí pasan, también las desatendidas. Y lo que nace en una routine, un trigger o un mensaje de otro bot vence a los ~30 minutos. Marcar confiable: sólo con una regla Allow (hasta 20 Allow y 20 Ask first, y gana Ask first).
- **Fuente:** `Producto` — approvals-security-and-privacy, "Review an action" y "If you don't answer"; troubleshooting, "An approval expired or is blocked"; teams-and-enterprises, "Enforce Auto-review".
- **Qué cambia en la parte A:** el supuesto S5 está al revés. Hay que escribir reglas Allow para las tools de lectura y dejar con `Ask first` las de envío, o los bots se frenan solos a los 30 minutos.

**3.5 — Ante un 429 o 5xx del servidor MCP, ¿el bot reintenta solo?**

- **Respuesta:** `Sin dato`. No está documentado que reintente.
- **Fuente:** `Sin dato` — ninguna página lo dice. Lo único cercano son las routines que fallan por rate limit, que justamente no se reintentan solas.
- **Qué cambia en la parte A:** cada tool del MCP dice en el texto qué hacer (reintentar en X segundos o no reintentar) y el gateway tiene idempotencia por clave. No se confía en el reintento del bot.

**3.6 — ¿Se puede apagar un conector o una herramienta para un bot en particular?**

- **Respuesta:** Se pueden apagar tools de una app instalada, pero no hay forma documentada de dejarla apagada sólo para un bot: el conector permitido queda disponible para todos los bots del asiento, y el connector policy es por equipo.
- **Fuente:** `Producto` — settings-and-notifications, "Connected apps" ("individual app tools can be enabled or disabled"); teams-and-enterprises, "Connector policy" ("Any permitted connector is available to every Bot a member runs").
- **Qué cambia en la parte A:** la separación `linkedin` y `whatsapp` no se impone por herramientas. Se impone por instrucción, por dueño de sesión y por asiento.

**3.7 — ¿El conector manda alguna identificación del bot que llama?**

- **Respuesta:** `Sin dato`, y lo que se ve es que no: un MCP remoto con Bearer fijo manda el mismo token para cualquier bot. No hay cabecera con la identidad del bot.
- **Fuente:** `Sin dato` — no está documentado.
- **Qué cambia en la parte A:** cada tool recibe `bot`, `tarea` y `run_id` como parámetros, y el gateway valida contra el token. El token dice el cliente; el parámetro dice el bot.

**3.8 — La regla de no enviar sin aprobación, ¿se aplica a las tools MCP que envían? ¿Alcanza con que la routine lo autorice?**

- **Respuesta:** No. B9 no lo aplica Grok Bot solo: hay que ponerlo como regla propia o pedirlo en el prompt. Lo que sí aplica siempre es Auto Review sobre la herramienta de envío. Y el mail del bot escrito en una routine siempre queda como borrador: no hay envío desatendido por esa vía. Las tools de un MCP (por ejemplo `gateway.enviar`) no pasan por esa lógica de borrador, pero sí por Auto Review: con una regla Allow, el envío sale sin humano.
- **Fuente:** `Producto` — approvals-security-and-privacy, "Review an action" ("Email from a routine, an incoming message, or other work you didn't start with that request waits as a draft until you press Send"); computer-and-apps, "Sending mail" ("there's no option for unattended sending"); teams-and-enterprises, "Agent Email".
- **Qué cambia en la parte A:** los envíos van por `gateway.enviar` con cupos y reglas duras del lado del servidor, nunca por el email propio del bot. Y B9 hay que reescribirlo: como está escrito promete algo que el producto no hace.

#### 4. Routines

**4.1 — ¿Cuánto puede durar una corrida y cuántas llamadas aguanta antes de degradar o compactar?**

- **Respuesta:** `Sin dato`. No hay duración máxima ni cantidad de llamadas documentada, ni cuándo compacta el contexto.
- **Fuente:** `Sin dato`.
- **Qué cambia en la parte A:** tandas chicas, con un techo propio que definamos nosotros (por ejemplo, N cuentas por corrida) y continuación en la próxima. No diseñar corridas de una hora.

**4.2 — ¿Hay límite de routines por bot y por cuenta?**

- **Respuesta:** 50 routines por bot. Por cuenta, 300 corridas por hora en total, y 200 por hora por routine. Además, cada routine guarda los últimos 20 registros de corrida.
- **Fuente:** `Producto` — skills-routines-and-automations, "Manage routines" y "Rate limits".
- **Qué cambia en la parte A:** nada. Con 5 bots hay lugar de sobra, pero el techo de 300/hora es de la cuenta entera: muchas routines de 5 minutos se comen el cupo entre todas.

**4.3 — ¿Grok Bot avisa cuando una routine falla o no corre?**

- **Respuesta:** El historial muestra `Succeeded` o `Failed` con el motivo. Alerta proactiva documentada no hay; lo único que avisa es el switch `Notifications` del bot, cuando termina o cuando espera aprobación.
- **Fuente:** `Producto` — skills-routines-and-automations, "Manage routines" (Run history); settings-and-notifications, "Control notifications".
- **Qué cambia en la parte A:** cada routine anota inicio y fin en la bitácora propia y alertamos nosotros, como estaba previsto. Nada de esperar un mail de Grok Bot.

#### 5. Navegador (Dripify y WhatsApp Web)

**5.1 — ¿El bot puede escribir un archivo en el box y el navegador subirlo? ¿Y descargar?**

- **Respuesta:** Sí, con una salvedad. El CSV en `/workspace` y la subida por ruta absoluta desde código funcionan: la página lo acepta. El diálogo nativo del sistema no se dibuja en pantalla, así que no se puede "tipear la ruta a mano"; se resuelve por código. La descarga no la probamos.
- **Fuente:** `Probado` — 4/11/2026: CSV de 105 bytes escrito en `/workspace` y subido en una página de prueba, con subida real confirmada.
- **Qué cambia en la parte A:** el import de Dripify por CSV es viable, aunque ya no hace falta: se carga por Open API o por el MCP propio de Dripify, sin navegador. Si algún sitio exige arrastrar el archivo o un selector raro, ese paso lo da el humano: no lo resolvemos por automatización.

**5.2 — ¿El agente puede leer el texto de la página para devolverlo completo?**

- **Respuesta:** Sí, con `innerText`, sin visión: devolvió párrafos completos.
- **Fuente:** `Probado` — 4/11/2026, sobre un sitio de prueba.
- **Qué cambia en la parte A:** nada. Las respuestas de WhatsApp se pueden volcar al registro como texto y citar textual. Conviene guardar el texto crudo, no sólo el resumen.

**5.3 — ¿Cuántas acciones de navegador por hora son razonables antes de que la corrida se vuelva lenta o cara?**

- **Respuesta:** `Sin dato`. No hay número documentado, ni un umbral donde la corrida se vuelva lenta o cara.
- **Fuente:** `Sin dato`. Lo único documentado sobre costo es que se mide por pasos y tokens (6.1), no por minuto de navegador.
- **Qué cambia en la parte A:** lotes por CSV (una carga por campaña, no una por lead) y medir el consumo real del piloto antes de estimar.

**5.4 — ¿El box está encendido 24 h y Chrome queda abierto entre corridas?**

- **Respuesta:** Sí. El box lleva días de uptime, Chrome corre con perfil persistente y la sesión se mantiene entre corridas; hiberna sola y despierta al próximo mensaje. Dos contrapartidas: un sitio puede pedir re-login en cualquier momento, y `Terminate Inactive Computers` (Enterprise, off por defecto) termina el box a los 30 días sin mensajes de nadie; el disco durable sobrevive y los logins vuelven, pero no los paquetes instalados a mano.
- **Fuente:** `Probado` — 4/11/2026. `Producto` — computers, "Terminate inactive computers automatically"; computer-and-apps, "Sign in once" ("Some websites expire sessions...").
- **Qué cambia en la parte A:** lecturas de WhatsApp fuera de horario sí, con plan B: si el sitio pide re-login, el bot avisa y el humano entra. Y un mensaje humano cada menos de 30 días si el cliente tiene esa opción prendida.

#### 6. Costo

**6.1 — ¿Cómo se mide el uso? ¿Se ve por bot?**

- **Respuesta:** Por pasos del agente y tokens, no por minuto de navegador ni por mensaje. Cada corrida de routine gasta uso y cada respuesta cuenta, incluidas las que van entre bots. La app tiene una vista de Usage por bot y por sesión; no la abrimos en esta sesión.
- **Fuente:** `Producto` — faq, "Is there a free trial?" ("measured by agent steps and tokens rather than the number of messages you send"); skills-routines-and-automations, "Routines and usage"; chat-and-collaboration, "Stop Bots from messaging each other". La vista por bot y por sesión en Usage: `Producto`, no la abrimos en esta sesión.
- **Qué cambia en la parte A:** el costo del SDR se estima por pasos, y el piloto lo mide antes de cotizar. Los mensajes entre bots no son gratis: un ida y vuelta de más se paga.

**6.2 — ¿Hay API o exportación del consumo?**

- **Respuesta:** `Sin dato`. No hay API ni exportación de consumo documentada.
- **Fuente:** `Sin dato`. Pista para preguntar: en Enterprise existe OpenTelemetry Export, que manda métricas de uso a un colector propio, pero no está documentado como export del consumo por bot.
- **Qué cambia en la parte A:** carga manual mensual por ahora, como estaba previsto.

**6.3 — ¿Hay precio por volumen para N cuentas?**

- **Respuesta:** `Sin dato`. No hay precio por volumen documentado para N cuentas.
- **Fuente:** `Sin dato` — la doc sólo lista los planes (Premium USD 30, Super USD 100, Ultra USD 200), el pool semanal por asiento y el prepago con tope mensual.
- **Qué cambia en la parte A:** cotizar con lista hasta que el account team conteste. No prometer descuento por volumen.

#### 7. Personas

**7.1 — ¿Un usuario externo puede chatear sólo con el orquestador, sin ver los otros bots, el box, los secretos ni el historial?**

- **Respuesta:** Parcial. Un Shared Bot le da a un externo un chat privado: no ve los otros bots ni la computadora, y el dueño no puede leer ese chat. Pero usa las apps y los secretos del dueño, Vault no está disponible ahí y siempre corre en la nube. No es una frontera de seguridad.
- **Fuente:** `Producto` — shared-bots, "Can the owner see my chats with a shared Bot?", "Whose apps and secrets does a shared Bot use?", "Which computer does a shared Bot use?"; security ("Vault is not available on shared Bots"); approvals-security-and-privacy ("Sharing a Bot is not a security boundary").
- **Qué cambia en la parte A:** para el cliente final, capa propia (Teams, Slack o mail contra nuestro gateway), no un Shared Bot. Los Shared Bots quedan para el equipo de Biguá, no para clientes.

**7.2 — ¿El orquestador puede avisarle al operador que hay una aprobación pendiente?**

- **Respuesta:** Sí, con el switch `Notifications` de cada bot: avisa cuando termina o cuando espera aprobación. En macOS y Windows va a la notificación del escritorio y, si no lo abrís, al teléfono a los ~3 minutos. En Linux, mientras la app está enfocada, el escritorio no molesta y el teléfono avisa igual.
- **Fuente:** `Producto` — settings-and-notifications, "Control notifications".
- **Qué cambia en la parte A:** prender `Notifications` en el `orquestador` de cada cuenta el día uno. Si el operador no tiene la app en el teléfono, el aviso no llega: sumar aviso por mail desde el gateway.

**7.3 — Si el operador contesta en el chat horas después, ¿el orquestador retoma con el contexto?**

- **Respuesta:** Sí. Si el pedido nació en el chat, la tarjeta espera sin vencerse y el bot retoma con el contexto cuando contestás. Ojo: eso vale para el chat del usuario; lo que nació en una routine muere a los 30 minutos.
- **Fuente:** `Producto` — approvals-security-and-privacy, "If you don't answer".
- **Qué cambia en la parte A:** nada en el flujo de aprobación del `orquestador`, que ya está en el chat. Confirma que no se puede pedir aprobación desde una routine.

#### 8. Pendientes de la consulta anterior

**8 — Roles de miembro, región, DPA, entrenamiento, retención, auditoría, suspensión y SLA.**

- **Respuesta:** `Sin dato` para lo que sigue faltando: roles de miembro y qué ve cada uno, DPA y subencargados firmados, retención y borrado por cuenta, qué pasa con el box ante una suspensión, y SLA de soporte. Lo que sí está documentado y responde una parte: los datos se borran o devuelven hasta 30 días después de terminar el servicio (DPA); los proveedores de modelo no guardan prompts ni salidas (Zero Data Retention); las computadoras corren en Estados Unidos y hay un programa de residencia en EE. UU.; con Privacy Mode prendido el contenido no se usa para entrenar; y Audit Logs y Action Recording son Enterprise.
- **Fuente:** `Sin dato` para lo pendiente. `Producto` — security, "Data retention and deletion", "Data residency", "Models and data", "Logging and audit".
- **Qué cambia en la parte A:** nada de diseño, pero sí de contrato: no firmar SLA ni prometer residencia de datos hasta hablarlo con el account team.

---

### Parte E · Estado de las 6 pruebas

| # | Prueba | Estado | Qué dio |
|---|---|---|---|
| 1 | Mensaje entre bots (S1, S3, S4) | No corrida | La doc responde S1 y S4. S3 sigue sin dato y es la que más duele: falta la prueba con dos bots de prueba y cronómetro, incluso con el segundo ocupado. |
| 2 | Concurrencia (S2) | No corrida como prueba | La arquitectura de pantallas por bot lo explica y se ve en la cuenta, pero falta correr dos routines de 5 minutos a la misma hora y ver si arrancan juntas. |
| 3 | MCP desatendido (S5, S6) | No corrida | La doc dice que Auto Review sí revisa MCP y que las aprobaciones de background vencen a los 30 minutos. Falta verlo con una búsqueda de ASCI y con una tool que escribe. |
| 4 | Archivo y subida (S12) | **Corrida el 4/11** | CSV de 105 bytes escrito en `/workspace` y subido: la página lo aceptó y la subida se disparó. El diálogo nativo del sistema no se dibuja; se selecciona por ruta absoluta desde código. Descarga: no probada. |
| 5 | Memorias (S8) | Respondida por doc, no por prueba | No hay pantalla de memoria en bots personales; las opciones son pedirlas y corregirlas en chat. Falta confirmarlo en la app de esta cuenta. |
| 6 | Webhook (S11) | **Corrida parcial el 4/11** | La routine con disparo por webhook se creó y quedó enabled por herramienta; la URL y la clave se ven en la app. Falta: latencia real y confirmar que el cuerpo JSON llega al prompt (hoy está en la doc). |

Resultado: dos de seis corridas, una de ellas parcial. Las tres que más bloquean son la 1, la 3 y la 6.

---

---

### Dripify · lo que verificamos y cómo lo hace hoy el equipo

Dripify pesa en tres lugares del diseño (el bot `linkedin`, el disparo de `seguimiento` y la carga de leads), así que lo verificamos aparte. Las fuentes son `help.dripify.com` y `api.dripify.com` (documentación de Dripify, no de Grok Bot), más la respuesta del equipo de headhunting de Biguá sobre cómo lo opera hoy.

#### 1. Open API pública (v1)
- Base: `https://api.dripify.com`, auth por header `X-Api-Key` (se genera en Settings → Integrations → API Key).
- Rate limit: **60 requests por minuto y 5.000 por día por API key**. Devuelve `X-RateLimit-Limit/Remaining/Reset`; al excederse, 429 con `Retry-After`.
- Lectura: campañas y su estado, lead lists, leads por campaña/lista/status/tag, detalle de lead, **activity log** del lead (los mismos eventos de la UI, con el campo `error` cuando falló), **conversación** del lead y sus **mensajes** (se leen en vivo de LinkedIn en cada llamada, páginas de 20), estadísticas por campaña (acceptance rate, reply rate, breakdown por estado), equipos y miembros.
- Escritura: **subir leads a una campaña** (`POST /v1/open-api/campaigns/{id}/leads`, hasta 1.000 por request, crea una lead list nueva; acepta `linkedinUrl` o `publicId` + custom fields), **append** a una lead list existente tipo "Paste profile URLs", **enviar mensaje** a una conversación existente (`POST /v1/open-api/leads/{leadId}/messages`), **blacklist/unblacklist**, **resume** de campañas pausadas del lead, **tags** por lote (hasta 1.000 leads y 50 tags), custom fields por lead.
- **Lo que NO hace la API**: prender/apagar una campaña (eso es sólo por la UI), crear o editar secuencias.
- Dato importante: **enviar un mensaje por API pausa la automatización de ese lead** en cualquier campaña donde esté `READY_FOR_PROCESSING`, igual que mandar desde el inbox. El `resume` es por lead, no por campaña.
- Los cuerpos son estrictos: un campo que no está en el schema da 400.

#### 2. MCP Server propio de Dripify
- Existe y está en producción (anunciado sept. 2026). URL: `https://app.dripify.com/api/v1/mcp`, auth con el mismo `X-Api-Key`.
- Requiere plan **Pro o Advanced**.
- Tools actuales: listar campañas, listar lead lists de una campaña, buscar lead por email o URL de LinkedIn, y **subir hasta 1.000 perfiles** a una campaña. No puede mandar mensajes, editar secuencias ni borrar.
- Clientes soportados: Claude Desktop, Cursor, VS Code, Codex CLI, Gemini CLI, Windsurf, o cualquiera que acepte un MCP remoto con header propio.
- Conclusión: se puede agregar como conector MCP en Grok Bot con header fijo; cubre la carga de leads sin navegador, pero para conversaciones y envíos conviene nuestra propia capa sobre la Open API.

#### 3. Webhooks
- Se configuran **por campaña** (Settings de la campaña) y admiten varios triggers a la vez.
- Para respuestas existe el trigger **"After LinkedIn reply is received"**, que manda el payload con la propiedad `LinkedIn conversation` con la conversación completa del inbox (mensajes del lead y nuestros). El trigger viejo "After lead's first LinkedIn reply" está deprecado.
- Los datos que empuja el webhook: nombre, país, ciudad, email, teléfono, URL de LinkedIn, puesto, empresa, web, educación, industria, dotación, seguidores, si es Premium y nombre de campaña (22 campos).
- **Advertencia de comportamiento**: el webhook de respuesta se dispara con la **primera** respuesta del lead en la campaña. Si el lead queda pausado y se sigue la conversación a mano, las respuestas siguientes no vuelven a disparar el webhook; si se reanuda y vuelve a responder, sí. Es decir: **no alcanza el webhook para seguir una conversación**, hay que consultar la API (conversación y mensajes) o usar el inbox.
- No hay ejemplo oficial del JSON del payload en el help center.

#### 4. Límites y salud de la cuenta de LinkedIn
- Topes que aplica Dripify por día: **75 invitaciones**, 100 mensajes (Basic) o 150 (Sales Navigator/Recruiter Lite), 25 InMails, 200–400 vistas de perfil, 50–100 likes/endorsements/follows.
- El límite que realmente manda es el **semanal de LinkedIn: ~100 invitaciones por ventana móvil de 7 días** (algunas cuentas con Sales Navigator llegan a ~200). Un tope diario de 20 ya choca con el semanal para muchas cuentas.
- Recomendación de Dripify: cuentas nuevas o frías 5–10 invitaciones/día la primera semana, 10–15 la segunda, 15–20 la tercera, y hasta 20/día después; cuentas avanzadas 20–30/día. Subir de a 10–20% por semana.
- Mantener invitaciones pendientes por debajo de ~700; retirar las viejas ayuda pero **no devuelve cupo semanal**.
- Acceptance rate por debajo de ~30% = lista mal segmentada, no bajar el límite.
- En plan Advanced existe **Activity Control**, que ajusta los topes solo según la salud de la cuenta.
- Cada asiento de Dripify conecta **una sola cuenta de LinkedIn**.
- Dripify manda desde su nube con IP propia, no desde el navegador: **el bot no necesita el navegador para que la secuencia corra**. El navegador sólo sirve para armar campañas y para el inbox.

#### 5. Carga de leads por CSV
- El CSV **tiene que traer la URL del perfil de LinkedIn**, si no Dripify no puede ubicar a la persona.
- Campos que reconoce: nombre, apellido, email, teléfono, puesto, empresa, web, país, ciudad, URL de LinkedIn y última acción. Las columnas no mapeadas se pueden saltear.
- Desde agosto 2026 admite hasta **50 custom lead fields** importables por CSV, y se pueden usar como variables en la secuencia (permite un mensaje distinto por lead dentro de la misma campaña).

#### 6. Cómo se saca a alguien de una secuencia
- Una respuesta detectada **pausa sola** la secuencia de ese lead.
- Para cortar del todo: sacarlo de la campaña o **blacklistearlo** (reversible). La API expone el blacklist.
- "Resume sequence" existe para casos donde la respuesta no amerita parar (un "gracias por conectar", un emoji).

#### 7. Lectura para el diseño
- El bot `linkedin` puede dejar de lado el navegador para el trabajo rutinario: subir leads por API o MCP, leer estados y conversaciones por API, blacklistear por API. El navegador queda sólo para lo que la API no cubre: crear campañas y editar secuencias (y eso lo hace una persona una vez).
- El webhook sirve como **disparador**, no como fuente de verdad: al recibirlo, el `seguimiento` tiene que leer la conversación por API.
- Hay que presupuestar el rate limit: 60 req/min y 5.000/día **por API key**, es decir por cuenta de Dripify. Con 5 bots leyendo lo mismo, se agota rápido. Conviene que el gateway haga de caché y que sólo un bot hable con Dripify.
- Los cupos de LinkedIn son el techo real del embudo, no el costo del bot: a 20 invitaciones/día por perfil y ~30% de aceptación, son ~6 conversaciones nuevas por día por vendedor.

---

#### 8. Cómo lo hace hoy el equipo de headhunting (respuesta del recruit-lead, 4/11/2026)

Esto es experiencia operativa, no documentación. Lo que sigue es lo que ellos hacen y lo que les falló.

**Carga:** CSV importado a mano desde el navegador, nunca por API ni alta manual. Tres columnas exactas: `linkedinUrl`, `recruiter_bot_mensaje1_Linkedin`, `recruiter_bot_mensaje2_Linkedin`. En el import mapean la URL al campo LinkedIn URL y los dos mensajes a sus custom fields homónimos, y en "existing leads" eligen **"Update all leads"**. Cada tanda va a su propia lista, nombrada `YYYYMMDD-HHMM-<slug>.dripify`.

**Campañas:** una sola en producción, `2079504 Test Bot Recruiter`. La `2077658` está fuera de alcance por decisión de Ignacio. Las arma `outreach-ops`, `recruit-lead` valida el handoff e Ignacio aprueba el import. No hay cadencia fija: una lista por ola, según haya scrape nuevo aprobado.

**LinkedIn:** una sola cuenta de Dripify con un perfil conectado, y el navegador con esa sesión vive en la máquina compartida del bot. No tienen esquema multi-seat, así que no hay experiencia propia que copiar. Cuando aparece el login wall, **SSO de Google** pasa directo; no insistir con el formulario de contraseña.

**Webhooks:** los reciben. Dripify POSTea a un endpoint en el Supabase de locasci que inserta la fila cruda en `ops.dripify_webhook_events` y le agrega un evento inferido. Dos capas: una routine se despierta con el push y un poll cada 30 minutos como red de seguridad. La inferencia que usan: `conversation` nula → `connection_accepted`; si hay reply → `reply`; interés explícito → `interest`. Trampa concreta: **PostgREST no expone el schema `ops` por defecto y devuelve `PGRST106`**; hay que agregarlo a `pgrst.db_schemas` y recargar la config.

**Límites:** no fijan números propios. Trabajan con volumen muy bajo (listas de 1 a 20 leads) y dejan que Dripify maneje el ritmo. Ellos mismos aclaran que para caps duros hay que ir a la doc de Dripify, no a su experiencia, porque no los midieron.

**Sacar a alguien:** semi-manual. Hay un catálogo de respuestas con estados (`no_reply_yet`, `connection_accepted`, `interested`, `in_house_only`, `blacklist`) y un archivo de blocklist de slugs que se aplica al armar el CSV de la ola siguiente. De la campaña activa se lo saca a mano en la UI. **No tienen automatizado el pausar la secuencia al detectar respuesta.**

#### Las trampas que ya pagaron

1. **URLs con host de país** (`ar.`, `mx.`, `in.`) hacen que el import no actualice los custom fields de leads que ya existían. Normalizar siempre a `https://www.linkedin.com/in/<slug>` y hacer spot-check fila por fila después del import.
2. **Un slug truncado** (URL terminada en `-`) hizo que se mergee con el lead equivocado y los mensajes quedaran vacíos. Un lead sin mensaje pasó inadvertido varios días.
3. **El import parece trabado** ("still to be added", "in progress") pero puede estar procesando. No reimportar: se duplica. Una sola importación por aprobación y verificación read-only después.
4. **Aceptar la invitación no es interés.** No disparar nada aguas abajo por una aceptación.
5. **Ruido en el scrape:** para 100 puestos les trajo 1.125 avisos, la mayoría de otros dominios, y el costo se fue de lo previsto. Filtrar por título y dominio en el origen.
6. **Agencias y staffing se colaron** como "empresa que contrata directo". Triage estricto con evidencia positiva.

Documentos de referencia en el box: `/workspace/bigua-fleet/HANDOFF.md`, `TRIAGE.md`, `DRIPIFY_WEBHOOK_PUSH.md` y `desk/SCOPE.md`.

#### 9. Lo que se puede mejorar respecto de cómo lo hacen hoy

- **La carga por navegador se puede reemplazar por API o MCP.** Ellos importan a mano porque el import es el único camino que tienen armado, pero la API acepta hasta 1.000 leads por request con `linkedinUrl` + custom fields, que es exactamente su CSV de tres columnas. Eso elimina de un saque las trampas 1, 2 y 3: la API rechaza el cuerpo con 400 si un campo no existe, colapsa duplicados dentro del request y devuelve `acceptedCount` y `duplicateCount` como confirmación explícita.
- **El "sacar a alguien" se automatiza** con `POST /v1/open-api/leads/{leadId}/messages`, que pausa la automatización del lead como efecto secundario, o directamente con el blacklist. No hace falta tocar la UI.
- **Ojo con el webhook de respuesta:** se dispara con la primera respuesta y no con las siguientes. Su red de seguridad de poll cada 30 minutos no lo cubre del todo; lo correcto es que al recibir el push lean la conversación por API.
- **Los cupos son el techo del embudo.** Con listas de 1 a 20 leads la campaña nunca se acercó al límite de LinkedIn, así que no hay evidencia operativa de qué pasa cuando se sube el volumen. Para el equipo nuevo de BairesQA hay que fijar los caps desde la doc (~100 invitaciones por 7 días por perfil) y probarlos en la semana de volumen bajo.

---

### Lo que cambia el diseño

Catorce puntos, cada uno con lo que hay que hacer. Los nueve primeros son los que ya habíamos marcado; el 10 al 12 salieron de las pruebas y la documentación de Grok Bot, y el 13 y el 14 del repaso de Dripify.

1. **Las aprobaciones de background vencen a los 30 minutos.** El `orquestador` no puede dejar pedidos de aprobación colgados en una routine: los pide en el chat del operador, que es el único lugar donde la tarjeta espera sin vencer. Si una routine necesita un OK, escribe el pedido en el registro y avisa; nunca se queda esperando una tarjeta.
2. **Auto Review revisa MCP, también desatendido.** Escribir reglas Allow para las tools de lectura (`reglas.manual`, `registro.*`, consultas de ASCI) y dejar con `Ask first` las de envío y escritura; si no, los bots se frenan solos a los 30 minutos y el trabajo no sale.
3. **El email propio del bot nunca se envía solo desde una routine: siempre queda borrador.** El envío va por `gateway.enviar`, con cupos, idempotencia y reglas duras del lado del servidor.
4. **El modelo puede variar de un pedido a otro.** Casos de prueba de regresión frecuentes (semanales), con la misma entrada y la salida esperada guardada, para detectar el cambio de comportamiento antes que el cliente.
5. **Agent Email está OFF por defecto en Teams.** No depender del email del bot para nada del flujo: ni avisos, ni respuestas, ni verificación de códigos. Todo por el gateway.
6. **Las memorias no se pueden apagar.** Instrucción explícita en el arranque de cada bot ("no guardes memoria de comportamiento ni datos de clientes") y revisión semanal de qué recuerda cada uno.
7. **SMTP e IMAP no tienen ruta desde el box.** El gateway HTTPS no es una comodidad: es la única salida. Si el gateway se cae, no hay correo, y eso hay que decirlo en el SLA del servicio.
8. **Cada bot tiene su pantalla, así que los 5 bots en 2 asientos se sostienen.** Pero la computadora es por miembro, no por bot: los bots de un asiento comparten archivos, sesiones de navegador y logins. La sesión de LinkedIn de cada vendedor vive en un asiento distinto, no en un bot distinto del mismo asiento.
9. **La subida de CSV funciona, el diálogo nativo no.** Si un sitio exige arrastrar el archivo o un selector raro, ese paso lo da el humano. El bot no "tipea" rutas en diálogos del sistema.
10. **No hay campo de perfil en los bots personales.** La identidad del bot es memoria, y la memoria no se puede fijar ni auditar. Todo lo que tiene que ser idéntico entre clientes va en `reglas.manual`; en el bot queda una línea de arranque y la routine que pide las reglas.
11. **El group chat no sirve como circuito de aprobación.** La doc dice que las aprobaciones, los pedidos de secretos y los borradores de mail no aparecen en un grupo; y si una tarjeta aparece, sólo la contesta quien hizo el pedido y sin `Always allow`. Si se usa un group chat como pizarra de los 5 bots, las aprobaciones siguen en el chat del `orquestador`.
12. **B9, como está escrito, ya no es cierto para el email propio.** Decía que con el prompt de la routine alcanzaba; el producto hoy dice que el mail del bot desde una routine siempre espera como borrador. Reemplazarlo por: el envío del SDR pasa por `gateway.enviar` y el permiso se controla en el servidor.
13. **Dripify se opera por API, no por navegador.** La Open API permite cargar hasta 1.000 leads por request con `linkedinUrl` y custom fields, leer el activity log y la conversación, mandar mensajes (lo que pausa la automatización del lead) y blacklistear. El navegador queda sólo para crear campañas y editar secuencias, que se hace una vez y a mano. Esto reemplaza el import por CSV y elimina las tres trampas que el equipo ya pagó.
14. **El webhook de Dripify es disparador, no fuente de verdad.** Se dispara con la primera respuesta del lead y no repite en las siguientes: al recibir el push hay que leer la conversación por API. Y ojo con el rate limit: 60 pedidos por minuto y 5.000 por día por API key, o sea por cuenta de Dripify; un solo bot debe hablar con Dripify y el gateway tiene que cachear.

---

### Lo que falta

Quince ítems quedaron en `Sin dato` (S3, S7 y trece preguntas de la Parte D), más tres que están respondidos a medias y dejan un hueco: 1.2 (latencia), 1.3 (espera bloqueante) y 2.2 (largo e historial del perfil). Esto es lo que falta y a quién preguntarle:

| Qué falta | A quién |
|---|---|
| Latencia de un mensaje entre bots (S1, 1.2) | Prueba pendiente: dos bots de prueba y cronómetro |
| Qué pasa si un bot recibe un mensaje mientras corre (S3, 1.5) y si dos routines del mismo bot se solapan (1.6) | Prueba pendiente |
| Protección contra bucles (1.7) y si los subagentes usan conectores y cómo se cobran (1.9) | Soporte (support@x.ai) |
| Largo máximo e historial del perfil (2.2) y si el que manda puede esperar la respuesta en su corrida (1.3) | Soporte |
| Tamaño de respuesta y tiempo por llamada MCP (S7, 3.3) | Prueba pendiente contra `sdrbot` y ASCI |
| Reintento ante 429 o 5xx (3.5) | Prueba pendiente: un 500 a propósito |
| Identificación del bot en el MCP (3.7) | Resuelto de nuestro lado con parámetros; si hay cabecera, lo dice soporte |
| Actualización de plantillas ya importadas (2.4) | Soporte |
| Duración de corrida y compactación del contexto (4.1) | Prueba pendiente y soporte |
| Acciones de navegador por hora antes de degradar (5.3) | Prueba pendiente, midiendo consumo |
| API o exportación del consumo (6.2) | Account team; preguntar si OpenTelemetry Export (Enterprise) sirve para esto |
| Precio por volumen para N cuentas (6.3) | Account team |
| Parte 8: roles, DPA y subencargados, retención por cuenta, suspensión, SLA | Account team; certificados en trust.cursor.com |
| Dripify: si el plan contratado incluye Open API y MCP server (devuelve 403 si no), y el JSON exacto del payload del webhook | Probar con la API key de la cuenta; el payload se captura en el primer push real |
| Dripify: cupos reales de LinkedIn a volumen (el equipo nunca pasó de 20 leads por tanda) | Medirlo en la semana de volumen bajo del piloto |

---

### Cierre

Listo para construir ya: el gateway MCP con cupos e idempotencia, `reglas.manual` partido por sección, el registro en Supabase, el `orquestador` con las aprobaciones en su chat, y la carga de leads en Dripify por Open API con el webhook como disparador.

No conviene construir todavía nada que dependa de una cola entre bots, de aprobaciones desatendidas, de memorias apagables, del email propio del bot o de que el modelo no cambie.
