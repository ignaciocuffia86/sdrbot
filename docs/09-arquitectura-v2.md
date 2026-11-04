# Arquitectura v2 · Grok Bot como orquestador

Estado: **modelo definido por Biguá el 04/11/2026**, con la revisión de cada punto donde choca
con lo decidido antes. Reemplaza a partes de `02-arquitectura.md` (§1 dice cuáles). Los datos
de la prospección y lo que va al CRM están en `11-datos-crm-y-seguimiento.md`; las preguntas a
Grok Bot, en `10-preguntas-grokbot-v2.md`.

## 0. El modelo

Lo que definió Biguá:

1. **Grok Bot orquesta.** Los bots conversan entre sí sobre sus tareas y deciden el próximo
   paso con criterio. El proceso no es lineal ni lo dicta un motor de reglas externo.
2. **El gateway controla y documenta el correo:** límites de envío, respuestas y seguimiento de
   los hilos.
3. **Un bot prospecta de punta a punta por mail:** busca cuentas nuevas en ASCI, usa Apollo a
   través del MCP de ASCI, encuentra a los tomadores de decisión, arma el correo y lo envía por
   el gateway.
4. **LinkedIn por Dripify:** con campañas ya armadas, un bot carga leads por URL de LinkedIn
   (importación por CSV a una campaña) y Dripify corre la prospección. El plan tiene webhooks.
5. **WhatsApp para seguimiento** cuando se tiene el número de WhatsApp de la persona. El
   consentimiento ya está resuelto en el origen del dato.
6. **El CRM documenta lo que importa:** sólo las respuestas positivas, o lo que se le pida al
   bot. HubSpot primero; un cliente con Dynamics 365 en carpeta.
7. **Supabase** tiene el gateway y además **las reglas de operación de cada bot**, para que el
   contexto de los bots (el harness) sea el mismo para todos los clientes.
8. **Las aprobaciones se hacen en el chat de Grok** con el líder de los bots (`orquestador`).

## 1. Revisión: dónde choca con lo decidido antes

Fuentes: **v1.1** (documento original, revisado en `01`), **02** (`02-arquitectura.md`), **09a**
(la primera propuesta de este documento, «la plataforma decide», descartada; queda en el
historial de git).

| # | Antes | Ahora | A favor | En contra | ¿Viable? | Cómo queda |
|---|---|---|---|---|---|---|
| 1 | La base hace cumplir las reglas: cupos, no contactar, deduplicación, follow-ups, aprobaciones «viven en la base, no en la memoria de un bot» (v1.1, 02 §1) | Las decisiones las toman los bots | Proceso con criterio: un bot puede cambiar de canal, esperar o pedir ayuda; mucho menos código propio | Un LLM puede olvidarse una regla, repetir un envío o equivocarse de persona; más difícil de auditar | **Sí, con barandas** | §6: cada regla es **dura** (la impone el gateway, ASCI o Dripify) o **guía** (la sigue el bot por sus reglas) |
| 2 | Estado del SDR en Supabase con un esquema completo (v1.1, 02 §3) | Los bots deciden; al CRM va sólo lo positivo | — | Si el CRM sólo tiene positivos, los bots no tienen dónde recordar a los demás | **Sí, con un registro chico** | **Registro de prospección** en Supabase, memoria de trabajo de los bots (`11` §2 y §3). Mucho más chico que el esquema de `02`: cuentas, prospectos y una línea de tiempo |
| 3 | El trabajo entre bots pasa por la base (02 §7) o por una cola (09a) | Los bots conversan entre sí | Es lo que da el proceso no lineal; Grok lo soporta (`06` 4.5) | No sabemos si un mensaje entre bots despierta al otro, si queda registrado, ni si dos bots corren a la vez (`06` 3.3); riesgo de bucles y de trabajo duplicado | **A validar con Grok** (`10` §1, bloqueante) | Protocolo de conversación (§4.3): referencia del registro, estado en el registro, evento por pedido, tope de idas y vueltas |
| 4 | Reveal con filtro programático y presupuesto validado antes de gastar (02 §6.2) | El `prospector` revela por el MCP de ASCI | Un solo bot decide a quién y lo hace | Puede gastar de más o revelar a quien no corresponde | **Sí** | El presupuesto diario de ASCI por usuario es la baranda dura; falta el mensual (`04` §4.2). Antes de revelar, el bot consulta exclusiones en el CRM (`11` §6) |
| 5 | Aprobación humana de textos base y de respuestas a interesados (v1.1); aprobación por mail con token (02 §7.2) | Aprobación en el chat de Grok con el `orquestador` | Sin canal extra; el que aprueba conversa con el bot y puede pedir cambios | El que aprueba necesita acceso a la cuenta de Grok del cliente | **Sí** | Aprueba un **operador de Biguá**, que ya administra la cuenta (§5.4). Cada aprobación queda como evento en el registro. Más adelante, una capa para aprobar desde Teams, Slack o mail |
| 6 | Envíos de mail desde scripts del box (02 §4.2) | El bot envía por el MCP del gateway | Ya funciona en el piloto | El tope y la idempotencia dependen de que el bot mande bien la clave | **Sí** | El gateway exige clave de idempotencia, cupo y máximo de destinatarios; las reglas fijan cómo armar la clave (§5.2) |
| 7 | Gateway sin memoria de los hilos | El gateway documenta respuestas y seguimiento | Una sola fuente del correo | Hay que construirlo | **Sí** | §7 |
| 8 | LinkedIn con un bot que opera Sales Navigator y Dripify (02) | Dripify con campañas armadas; el bot carga leads por CSV | Dripify corre la cadencia y sus límites; el navegador hace poco | Si el prospecto contesta por mail, Dripify le sigue escribiendo hasta que alguien lo saque | **Sí** | Bot `linkedin`, dueño de la sesión; los webhooks de Dripify llegan al gateway (§5.3); sacar de la campaña es regla guía con verificación diaria (§6) |
| 9 | WhatsApp: tandas aprobadas, sólo seguimientos, teléfono que llega a la persona, base legal declarada (v1.1, 02 §7.4) | Seguimiento cuando hay número de WhatsApp; el consentimiento ya está | Más simple | — | **Sí** | El número está en el registro; si está, se puede usar para seguimiento |
| 10 | Documentación completa en el CRM (`09` en su versión anterior) | Al CRM sólo positivos o a pedido | El CRM del cliente queda limpio | Cada CRM guarda los datos distinto | **Sí** | Paquete de derivación igual para todos los CRM (`11` §5) |
| 11 | Un paquete fijo con mapeo cerrado (versión anterior de `11`) | El bot llega al CRM por MCP, mira los datos que el cliente ya tiene y decide qué campos cargar y cómo (línea de tiempo, lo conversado, completar datos) | Cargas útiles para cada cliente, sin formularios por cliente | Un bot con escritura libre puede pisar o ensuciar el CRM del cliente | **Sí, con límites** | `crm.*` en el MCP de Biguá: el bot explora el esquema y decide; el MCP pone límites duros (no borra, no pisa datos cargados, sólo entidades permitidas). El mapeo se aprueba una vez por cliente en el chat (`11` §5 y §6) |
| 12 | Siete bots (02) | Los que pida el flujo | — | — | — | Cinco (§4.1) |
| 13 | Alta con usuario de Supabase, ocho secretos e instalador en el box (02, 03) | Grok con conectores | Menos piezas | — | **Sí** | En Grok: conector de ASCI y conector de `sdrbot.bigua.lat` (gateway, reglas, registro y CRM). Ningún programa propio en el box |

## 2. Vista general

```mermaid
flowchart LR
  subgraph G["Cuenta de Grok Bot del cliente: orquesta"]
    ORQ[orquestador<br/>aprobaciones en el chat]
    PRO[prospector]
    SEG[seguimiento]
    LI[linkedin<br/>sesión Dripify]
    WA[whatsapp<br/>sesión WhatsApp Web]
    ORQ <--> PRO & SEG & LI & WA
    SEG <--> LI & WA & PRO
  end
  H[Líder humano] <-- chat --> ORQ

  subgraph B["Biguá"]
    ASCI[(ASCI · MCP<br/>cuentas · señales · Apollo · reveal)]
    subgraph PL["sdrbot.bigua.lat · Supabase sdrbot · un MCP"]
      GW[gateway.*<br/>cupos · hilos · respuestas · supresión]
      REG[reglas.*<br/>manual por bot y tarea]
      RP[registro.*<br/>prospectos y línea de tiempo]
      CRM[crm.*<br/>HubSpot · Dynamics 365]
    end
  end

  PRO -- MCP --> ASCI
  ORQ & PRO & SEG & LI & WA -- MCP --> PL
  GW <--> BUZ[(Buzones del cliente)]
  DRIP[Dripify] -- webhooks --> GW
  LI -- navegador: CSV --> DRIP
  CRM -- sólo positivos o a pedido --> CRMC[(CRM del cliente)]
```

## 3. Reglas de operación centralizadas (el harness)

| Capa | Qué tiene | Dónde | Cuánto cambia |
|---|---|---|---|
| **Arranque** | Perfil de cada bot: quién es, con quién habla, que sus reglas están en `reglas.manual`, que lo que sabe de un prospecto está en el registro y no en su memoria, que nunca envía a quien no está en el registro. Routines cortas: «Tarea `prospector.diaria`: seguí `reglas.manual`» | Plantillas de Grok (equipo de Biguá) | Casi nunca: cambiarlo es reimportar en cada cuenta |
| **Manual** | Por bot y por tarea: objetivo, pasos, criterios de decisión, a quién pedirle qué, qué registrar, cómo cargar en el CRM, qué hacer ante cada error, ejemplos | Repo (`playbooks/`) → publicado en Supabase con versión | Seguido; llega a todos los clientes sin tocar Grok |
| **Ajustes del cliente** | ICP, oferta, tono, idioma, firma, campaña de Dripify por segmento, límites propios, qué cuenta como positivo, quién aprueba | Supabase, editables en el panel | Por cliente |

- `reglas.manual(bot, tarea)` devuelve las tres capas combinadas para ese cliente, con su
  versión. Herramienta de sólo lectura del mismo MCP que el gateway.
- Cada evento del registro guarda la versión de las reglas con que se hizo: se puede saber qué
  versión escribió qué y volver atrás cambiando un número en el panel.
- Versiones con canal `canario` y `estable`.
- Las **memorias de trabajo** de Grok pueden hacer que dos clientes con las mismas reglas se
  comporten distinto. Hay que saber si se pueden apagar o borrar (`10` 2.1). Hasta entonces, el
  arranque dice que no guarde memorias de comportamiento y el `orquestador` las revisa cada
  semana.

## 4. Los bots y cómo conversan

### 4.1 Quiénes son

| Bot | Hace | Le pide a | Navegador |
|---|---|---|---|
| `orquestador` | Líder: arma el plan del día con `registro.agenda`, reparte y destraba, **pide y recibe aprobaciones en su chat**, carga en el CRM lo que se le pida, responde preguntas, resume | A todos | No |
| `prospector` | Cuentas nuevas en ASCI, exclusiones en el CRM, decisores, reveal, contenido y envío por el gateway del primer mail y sus seguimientos | `linkedin` (sumar a Dripify), `orquestador` (aprobaciones y dudas) | No |
| `seguimiento` | Respuestas de los tres canales: clasifica, decide qué sigue (contestar, frenar, pasar a WhatsApp, prospectar a la persona derivada), propone la respuesta y carga los positivos en el CRM | `orquestador` (aprobación), `prospector`, `linkedin` (sacar de Dripify), `whatsapp` | No |
| `linkedin` | Dueño de la sesión de Dripify: arma el CSV con las URL de LinkedIn y lo importa en la campaña que corresponde, saca de la campaña a quien respondió por otro canal | `seguimiento` | **Sí** |
| `whatsapp` | Dueño de WhatsApp Web: manda los seguimientos que le pide `seguimiento`, lee respuestas y avisa | `seguimiento` | **Sí** |

`seguimiento` va separado de `prospector` para que un interesado no espere a que termine una
tanda de investigación. Si Grok no deja correr dos bots a la vez (`10` 1.1), se juntan en tres.

Dos bots en la misma sesión de navegador se pisan (`06` A2): por eso el que entra a Dripify es
siempre `linkedin`, aunque lo decida otro.

### 4.2 Las respuestas de LinkedIn y WhatsApp

- **LinkedIn:** Dripify avisa por webhook al gateway (aceptó la invitación, respondió). El
  gateway lo registra en el registro y despierta a `seguimiento` (`10` 1.8).
- **WhatsApp:** `whatsapp` lee las conversaciones de los prospectos en cada pasada y le pasa lo
  nuevo a `seguimiento`.
- **Mail:** el gateway relaciona cada respuesta con su envío (§7) y despierta a `seguimiento`.

### 4.3 Protocolo de conversación

Los bots conversan, pero con una forma fija, que vive en las reglas:

- **Todo pedido nombra al prospecto por su id del registro** y dice qué se pide, por qué y para
  cuándo. Nada de «el de ayer».
- **El estado no viaja en la conversación, está en el registro.** El que recibe un pedido lee el
  prospecto antes de actuar: si otro bot ya lo hizo, no lo repite.
- **Cada pedido deja un evento** en el registro (quién pidió qué a quién). Es la auditoría de
  un proceso que no es lineal.
- **Tope de idas y vueltas:** si un tema pasa más de tres veces entre bots sin resolverse, va al
  `orquestador`; si él no lo resuelve, lo pregunta en su chat.
- **El que ejecuta vuelve a chequear las reglas duras**, aunque se lo pida el `orquestador`.

Todo esto supone que un mensaje entre bots despierta al otro (`10` §1). Si no fuera así, los
pedidos quedan como eventos pendientes en el registro y cada bot los lee en su routine.

## 5. El recorrido

### 5.1 Un ejemplo

```mermaid
sequenceDiagram
  autonumber
  participant O as orquestador
  participant P as prospector
  participant A as ASCI
  participant R as registro / crm / gateway
  participant L as linkedin
  participant S as seguimiento
  participant H as Líder (chat de Grok)

  O->>R: registro.agenda: qué toca hoy
  O->>P: 15 cuentas nuevas de la vertical X + 8 seguimientos por mail
  P->>A: prospectar, decisores
  P->>R: crm.exclusiones(dominio)
  P->>A: reveal (dentro del presupuesto)
  P->>R: registro.guardar: cuenta, prospecto, señal, tesis
  P->>R: gateway: enviar mail 1
  P->>L: sumá a la campaña «X - decisores» a estos 6 (ids del registro)
  L->>R: CSV importado en Dripify · eventos
  R-->>S: respuesta por mail atada al mail 1
  S->>R: registro.historia
  S->>L: sacalo de Dripify: respondió por mail
  S->>O: positivo: esta es la respuesta propuesta
  O->>H: ¿apruebo esta respuesta?
  H-->>O: sí (o con cambios)
  O->>S: aprobado
  S->>R: gateway: responder en el hilo
  S->>R: crm.describir / buscar / crear Lead + nota + tarea
  S->>R: registro.evento: en CRM
```

Lo no lineal está en las decisiones: el `orquestador` cambia el plan si un segmento no responde;
`seguimiento` pasa a WhatsApp si la persona no contesta el mail pero tiene número; el
`prospector` busca a otra persona en la cuenta si le dicen «hablá con fulano».

### 5.2 Envío de mail

- Siempre por el MCP del gateway. Clave de idempotencia fija en las reglas:
  `<id del prospecto>:<paso>` (por ejemplo `p-1234:mail-1`). Si el bot reintenta, el gateway
  devuelve el envío anterior y no manda dos veces.
- El gateway rechaza si el buzón llegó al cupo del día, si el destinatario está en la lista de
  supresión del cliente (§7) o si son más de 10 destinatarios. El bot lo registra y sigue.

### 5.3 Dripify

- Las campañas las arma una persona en Dripify (por segmento o por idioma). Los ajustes del
  cliente dicen qué campaña corresponde a cada segmento.
- `linkedin` arma un CSV con las URL de LinkedIn de los prospectos que le pidieron (en el box,
  con la herramienta de archivos del bot) y lo importa en la campaña. Necesita que el navegador
  de Grok pueda subir archivos (`10` 5.1); si no, los carga de a uno.
- La URL sale de ASCI o Apollo; sin URL, la persona no va a Dripify.
- Los webhooks de Dripify llegan a una dirección del gateway por cliente, con un secreto propio;
  el gateway los registra y despierta a `seguimiento`.

### 5.4 Aprobaciones en el chat de Grok

- El `orquestador` pide la aprobación en su chat: qué se va a hacer, a quién, el texto, el
  contexto (la respuesta del prospecto, la tesis). El líder contesta «sí», «no» o el texto
  corregido.
- El `orquestador` registra la aprobación (quién, cuándo, texto aprobado) y avisa al bot que
  espera. El bot que ejecuta comprueba en el registro que la aprobación existe antes de enviar.
- Qué necesita aprobación, por cliente:

| Qué | Por defecto |
|---|---|
| Respuesta a un positivo | Siempre |
| **Calibración de un cliente nuevo:** los primeros N mails del `prospector` (N = 20 por defecto) | Sí. Después salen solos |
| Primer WhatsApp a cada persona | A definir por cliente |
| Carga en el CRM | No: es consecuencia de la respuesta aprobada |
| Lo que los bots no resolvieron (tope de idas y vueltas) | Siempre |

- El líder es **un operador de Biguá**. Mientras no contesta, lo pendiente queda en el registro y
  el `orquestador` lo recuerda; un positivo sin aprobar después de N horas levanta una alerta.
- Más adelante: una **capa de gestión e integración** para hablar con el `orquestador` y aprobar
  desde Teams, Slack o mail, sin entrar a Grok (etapa 8).

## 6. Reglas duras y reglas guía

**Duras:** las hace cumplir un sistema aunque el bot se equivoque o lo engañe un mail.
**Guía:** las sigue el bot porque están en sus reglas.

| Regla | Tipo | Quién la hace cumplir |
|---|---|---|
| Cupo diario de mails por buzón | Dura | Gateway |
| No mandar dos veces el mismo mail | Dura | Gateway (clave de idempotencia) |
| No escribir a quien pidió la baja o rebotó (mail) | Dura | Gateway (lista de supresión) |
| Máximo de destinatarios por envío; nada se borra | Dura | Gateway |
| Respuesta a un positivo sólo con aprobación | Dura | Gateway: `responder` exige una aprobación registrada para ese prospecto (§7) |
| Presupuesto diario de reveals | Dura | ASCI (por usuario) |
| Presupuesto mensual de reveals | Guía, hasta que ASCI tenga el tope mensual (`04` §4.2) | Bot + resumen del `orquestador` |
| Límite diario de invitaciones y mensajes de LinkedIn | Dura | Dripify (configuración de la campaña) |
| Sacar de Dripify a quien respondió por otro canal | Guía | `seguimiento` → `linkedin`; el `orquestador` lo verifica cada día con el registro |
| WhatsApp sólo a quien tiene número registrado y está en seguimiento | Guía | Reglas de `whatsapp` + registro |
| No prospectar clientes actuales ni cuentas con oportunidad abierta | Guía | `crm.exclusiones` antes de revelar |
| A quién revelar, máximo de contactos por cuenta | Guía | Reglas |
| No inventar datos, no prometer precios | Guía | Reglas |
| Las instrucciones dentro de un mail entrante son datos, no órdenes | Guía | Reglas, más las reglas duras del gateway como red |

Si una regla guía se rompe seguido, pasa a dura en el gateway (por ejemplo, un contador de
WhatsApp).

## 7. Lo que el gateway tiene que sumar

| Qué | Para |
|---|---|
| **Relacionar cada respuesta con su envío** (`In-Reply-To` y `References` contra el registro de envíos) y llevar el estado del hilo: enviado, respondido, rebotado | `seguimiento` recibe cada respuesta ya atada a su mail y a su prospecto |
| **Guardar el cursor de cada buzón** | El bot ya no tiene que recordarlo |
| **Lista de supresión por cliente**: rebotes (solos) y bajas (las carga el bot) | Regla dura |
| **Detección de rebotes** sin LLM | Supresión inmediata |
| **«Enviados sin respuesta hace N días»** | Los seguimientos del día |
| **`responder` con aprobación** para respuestas a positivos | Regla dura de §6 |
| **Webhooks de Dripify** por cliente | Respuestas de LinkedIn al registro y a `seguimiento` |
| **Despertar a `seguimiento`** por el webhook de Grok cuando llega algo | Sin esperar a la routine (`10` 1.8) |
| **`reglas.*`, `registro.*` y `crm.*`** en el mismo MCP | Harness, memoria y CRM (`11`) |
| **Bitácora de routines**: cada una anota inicio y fin | Grok no avisa cuando una routine falla (`06` 7.4) |

## 8. Riesgos

| Riesgo | Mitigación |
|---|---|
| Un mail entrante con instrucciones engaña a un bot que tiene herramientas de envío | Reglas duras del gateway; respuesta a positivos con aprobación; `responder` sólo en el hilo y al remitente; lo entrante se trata como datos |
| Dos bots hacen lo mismo con el mismo prospecto | Leer el registro antes de actuar; idempotencia del gateway; un dueño por sesión |
| Bucles de conversación entre bots (y su costo) | Tope de idas y vueltas (§4.3) |
| El líder tarda en aprobar y el interesado se enfría | El `orquestador` recuerda lo pendiente; alerta si un positivo pasa N horas sin aprobar |
| Una routine no corre y nadie se entera | Bitácora y alerta (§7) |
| El comportamiento se desvía entre clientes | Reglas versionadas en Supabase; memorias controladas (§3) |
| Costo de Grok por conversaciones entre bots | Medir en el piloto (`10` §6) |

## 9. Etapas

| Etapa | Qué | Sale cuando |
|---|---|---|
| **0** · hecho | Gateway, panel, dominios; BairesQA con un bot leyendo y escribiendo borradores | — |
| **1** · reglas y registro | `reglas.*` y `registro.*`; bots `orquestador` y `prospector`; calibración con aprobación en el chat | El `prospector` envía 20 mails aprobados en el chat, todo en el registro |
| **2** · memoria del correo | Hilos, respuestas atadas, cursor, supresión, rebotes, «sin respuesta», bitácora; bot `seguimiento` | `seguimiento` trabaja sólo con lo que le dan el gateway y el registro |
| **3** · CRM | `crm.*` con HubSpot (explorar el esquema, crear con límites); mapeo aprobado en el chat; respuesta a positivos con aprobación | Un positivo aprobado aparece en HubSpot con los campos del cliente completados, la conversación y una tarea |
| **4** · Dripify | `linkedin` importando CSV; webhooks; sacar de la campaña al que respondió por mail | Un prospecto en mail y Dripify se frena en los dos al responder en uno |
| **5** · WhatsApp | Bot `whatsapp` | Un seguimiento por WhatsApp registrado |
| **6** · Dynamics 365 | Adaptador de `crm.*`; usuario de aplicación con rol de seguridad acotado | El cliente de D365 recibe sus positivos como Lead con su mapeo aprobado |
| **7** · Dashboard del cliente | Vista del registro en el panel: números, embudo, canales, positivos, línea de tiempo, avisos (`11` §8) | El cliente ve qué hicimos en la semana sin preguntar |
| **8** · Capa de integración | Hablar con el `orquestador` y aprobar desde Teams, Slack o mail | Una aprobación hecha desde fuera de Grok |

## 10. Decidido el 04/11

| Tema | Decisión |
|---|---|
| Memoria de los bots | Registro de prospección en Supabase, que además alimenta el dashboard del cliente (`11` §2, §8) |
| Calibración | Los primeros 20 mails de cada cliente nuevo con aprobación en el chat; se corrige si hace falta |
| Quién aprueba | Un operador de Biguá; la capa de integración, más adelante |
| Qué es positivo | Interesado, pide reunión, pide información, acepta una llamada |
| Carga en el CRM | El bot decide qué campos y cómo, por MCP, con límites duros y mapeo aprobado por cliente; en Dynamics 365, Lead |
| Bajas | Se marcan en el CRM si la persona ya existía y se avisa al cliente |
