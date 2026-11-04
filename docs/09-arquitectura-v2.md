# Arquitectura v2 · Grok Bot como orquestador

Estado: **modelo definido por Biguá el 04/11/2026**, con la revisión de cada punto donde choca
con lo decidido antes. Reemplaza a la propuesta anterior de este mismo documento (la de «la
plataforma decide y Grok ejecuta», que queda en el historial de git) y a partes de
`02-arquitectura.md` (§1 dice cuáles). Las preguntas a Grok Bot para validarlo están en
`10-preguntas-grokbot-v2.md`.

## 0. El modelo

Lo que definió Biguá:

1. **Grok Bot orquesta.** Los bots conversan entre sí sobre sus tareas y deciden el próximo
   paso con criterio. El proceso no es lineal ni lo dicta un motor de reglas externo.
2. **El gateway sólo controla y documenta el correo:** límites de envío, respuestas y
   seguimiento de los hilos.
3. **Un bot prospecta de punta a punta por mail:** busca cuentas nuevas en ASCI, usa Apollo a
   través del MCP de ASCI, encuentra a los tomadores de decisión, arma el contenido del correo y
   lo envía por el gateway.
4. **LinkedIn por Dripify:** con campañas ya armadas en Dripify, un bot carga leads por la URL
   de LinkedIn y la prospección por ese canal la corre Dripify.
5. **WhatsApp para seguimiento,** sólo cuando hay un dato de contacto y consentimiento de la
   persona.
6. **El CRM documenta.** En este caso, HubSpot: ahí queda cada empresa, contacto, toque,
   respuesta y oportunidad.
7. **Supabase** tiene el gateway y además **las reglas de operación de cada bot,** para que el
   contexto de los bots (el harness) sea el mismo para todos los clientes.

## 1. Revisión: dónde choca con lo decidido antes

Cada fila es una decisión anterior que este modelo cambia. Fuente: **v1.1** (documento
original, revisado en `01`), **02** (`02-arquitectura.md`), **09a** (la propuesta anterior de
este documento).

| # | Antes | Ahora | A favor | En contra | ¿Viable? | Cómo queda |
|---|---|---|---|---|---|---|
| 1 | La base hace cumplir las reglas: cupos, no contactar, deduplicación, follow-ups, aprobaciones «viven en la base, no en la memoria de un bot» (v1.1, 02 §1) | Las decisiones las toman los bots | Proceso con criterio: un bot puede cambiar de canal, esperar, pedir ayuda a otro; mucho menos código propio | Un LLM puede olvidarse una regla, repetir un envío o equivocarse de persona; más difícil de auditar | **Sí, con barandas.** Las reglas que si se rompen cuestan plata, reputación o un problema legal tienen que estar fuera del LLM | §6: cada regla queda clasificada como **dura** (la impone el gateway, ASCI, Dripify o HubSpot) o **guía** (la sigue el bot por el manual) |
| 2 | Estado del SDR en Supabase: contactos, secuencias, envíos, respuestas, aprobaciones (v1.1, 02 §3) | El estado vive en HubSpot | El cliente ve todo en su CRM; HubSpot ya deduplica, tiene propiedades, tareas y línea de tiempo; no hay que construir una base de prospectos | Límites de pedidos por segundo y por día **(verificar)**; propiedades a crear en cada portal; si el cliente toca o borra datos, el bot pierde el hilo; un cliente sin HubSpot necesita otra cosa | **Sí** para clientes con HubSpot | §7: propiedades estándar de SDR en HubSpot, creadas en el alta; HubSpot es la memoria de los bots |
| 3 | Los bots no se pasan trabajo hablando; pasa por la base (02 §7) o por una cola (09a §6) | Los bots conversan entre sí | Es lo que da el proceso no lineal; Grok lo soporta (`06` 4.5) | No sabemos si un mensaje entre bots despierta al otro, si queda registrado, ni si dos bots corren a la vez (`06` 3.3, sin dato); riesgo de bucles y de trabajo duplicado | **A validar con Grok** (`10` §1, bloqueante) | §4.3: protocolo de conversación (qué se pide, a quién, con qué referencia de HubSpot, máximo de idas y vueltas), y cada pedido deja nota en HubSpot |
| 4 | Revelar contactos con filtro programático y presupuesto validado antes de gastar (02 §6.2) | El bot prospector revela por el MCP de ASCI | Simple: un solo bot decide a quién y lo hace | El bot puede gastar de más o revelar a quien no corresponde | **Sí**: ASCI ya corta por **presupuesto diario por usuario** | El tope diario de ASCI es la baranda dura; falta el **tope mensual** y el rol `sdr_bot` (`04` §4.2). Las reglas de a quién revelar van en el manual |
| 5 | Aprobación humana de textos base y de leads calientes y tibios (v1.1) | El bot arma y envía | Velocidad | Un mail malo sale con el nombre del cliente | **Sí, por etapas:** el token del gateway ya separa `draft` de `send` | Semanas 1 y 2 con token sin `send`: el bot deja borradores y una persona los manda o aprueba. Después se habilita `send`. La respuesta a un interesado sigue con aprobación (§5.4) |
| 6 | Envíos de mail desde scripts del box por API (02 §4.2) o desde la plataforma (09a) | El bot envía por el MCP del gateway | Ya funciona en el piloto | El tope y la idempotencia dependen de que el bot mande bien la clave | **Sí** | El gateway ya exige `idempotency_key`, cupo diario y máximo de destinatarios. El manual fija cómo armar la clave (§5.2) |
| 7 | El gateway sin memoria de los hilos: el bot guarda el cursor y cruza las respuestas | El gateway documenta respuestas y seguimiento | Una sola fuente de verdad del correo, por cliente | Hay que construirlo | **Sí** | §8: el gateway relaciona cada respuesta con su envío, guarda el cursor de cada buzón, lleva la lista de supresión y responde «enviados sin respuesta hace N días» |
| 8 | LinkedIn con un bot que opera Sales Navigator y Dripify (02) | Dripify con campañas armadas; el bot sólo carga leads por URL | Dripify corre la cadencia y sus límites; el bot hace poco en el navegador, que es lo lento | Si el prospecto contesta por mail, Dripify sigue escribiéndole por LinkedIn hasta que alguien lo saque; cargar leads depende de qué deja hacer Dripify **(verificar)** | **Sí** | Bot `linkedin`, dueño de la sesión. Regla dura de cruce de canales en §6 |
| 9 | WhatsApp: tandas aprobadas, sólo seguimientos, teléfono que llega a la persona (v1.1, 02 §7.4) | Seguimiento por WhatsApp con consentimiento | Igual en lo esencial | El consentimiento hay que poder probarlo | **Sí** | Consentimiento como propiedad de HubSpot con su evidencia (§7). Sin ella, el bot `whatsapp` no escribe |
| 10 | Siete bots (02) o cinco (09a) | Los que pida el flujo de §2 | — | — | — | Cinco bots (§4.1) |
| 11 | Manual de los bots en la plataforma, servido por MCP (09a §4) | Reglas de operación en Supabase | Es lo mismo que pide el modelo | — | **Sí** | §3: se mantiene |
| 12 | Plan de alta con usuario de Supabase, ocho secretos e instalador en el box (02, 03) | Grok con conectores | Menos piezas | — | **Sí** | En Grok: conectores de ASCI, gateway (con las reglas) y HubSpot. Ningún programa propio en el box salvo que HubSpot no tenga conector (§9) |
| 13 | Varios CRM (HubSpot, Dynamics 365, NetHunt, Excel) por adaptadores (09a §7.4) | HubSpot para este cliente | Foco | Otro cliente con otro CRM cambia la memoria de los bots | **Sí**, uno por vez | HubSpot primero. Para otro CRM hace falta su conector en Grok y las mismas propiedades (§9.2). Excel no sirve como memoria de los bots |

## 2. Vista general

```mermaid
flowchart LR
  subgraph G["Cuenta de Grok Bot del cliente: orquesta"]
    ORQ[orquestador]
    PRO[prospector]
    SEG[seguimiento]
    LI[linkedin<br/>sesión LinkedIn + Dripify]
    WA[whatsapp<br/>sesión WhatsApp Web]
    ORQ <--> PRO & SEG & LI & WA
    SEG <--> LI & WA & PRO
  end

  subgraph B["Biguá"]
    ASCI[(ASCI · MCP<br/>cuentas · señales · Apollo · reveal)]
    subgraph PL["sdrbot.bigua.lat · Supabase sdrbot"]
      GW[Gateway de correo<br/>cupos · hilos · respuestas · supresión]
      REG[Reglas de operación<br/>manual por bot y tarea · ajustes por cliente]
      BIT[Bitácora mínima de corridas]
    end
  end

  HS[(HubSpot del cliente<br/>empresas · contactos · actividad · tareas)]
  DRIP[Dripify<br/>campañas armadas]
  BUZ[(Buzones del cliente)]

  PRO -- MCP --> ASCI
  PRO & SEG -- MCP --> GW
  ORQ & PRO & SEG & LI & WA -- MCP --> REG
  ORQ & PRO & SEG & LI & WA -- conector --> HS
  LI -- navegador --> DRIP
  GW <--> BUZ
```

## 3. Reglas de operación centralizadas (el harness)

Es lo que pide el punto 7 y no cambia respecto de la propuesta anterior: el comportamiento de
los bots es dato versionado en Supabase, igual para todos los clientes, con ajustes por cliente.

| Capa | Qué tiene | Dónde | Cuánto cambia |
|---|---|---|---|
| **Arranque** | Perfil de cada bot: quién es, con quién habla, que sus reglas están en `reglas.manual`, que lo que sabe de un prospecto está en HubSpot y no en su memoria, que nunca envía a quien no está en HubSpot. Routines cortas: «Tarea `prospector.diaria`: seguí `reglas.manual`» | Plantillas de Grok (equipo de Biguá) | Casi nunca: cambiarlo es reimportar en cada cuenta |
| **Manual** | Por bot y por tarea: objetivo, pasos, criterios de decisión, a quién pedirle qué, qué propiedades de HubSpot leer y escribir, formato de las notas, qué hacer ante cada error, ejemplos | Repo (`playbooks/`) → publicado en Supabase con versión | Seguido; llega a todos los clientes sin tocar Grok |
| **Ajustes del cliente** | ICP, oferta, tono, idioma, firma, campañas de Dripify por segmento, límites propios, aprobadores | Supabase, editables en el panel | Por cliente |

- `reglas.manual(bot, tarea)` devuelve las tres capas combinadas para ese cliente, con su
  versión. Es una herramienta más del MCP de `sdrbot.bigua.lat`, de sólo lectura, con el mismo
  token del cliente que usa el gateway: un conector en Grok sirve para las dos cosas.
- Cada nota que un bot deja en HubSpot incluye la versión del manual con la que trabajó. Así se
  puede saber qué versión escribió qué y volver atrás cambiando un número en el panel.
- Versiones con canal `canario` (Biguá o un cliente que acepte probar) y `estable`.
- Las **memorias de trabajo** de Grok pueden hacer que dos clientes con el mismo manual se
  comporten distinto. Hay que saber si se pueden apagar o borrar (`10` 2.1); hasta entonces, el
  arranque dice que no guarde memorias de comportamiento y el `orquestador` las revisa una vez
  por semana.

## 4. Los bots y cómo conversan

### 4.1 Quiénes son

| Bot | Hace | Le pide a | Navegador |
|---|---|---|---|
| `orquestador` | Dueño del plan del día por cliente: decide prioridades entre canales, reparte y destraba, arma el resumen, responde preguntas de Biguá o del cliente, revisa calidad | A todos | No |
| `prospector` | Cuentas nuevas en ASCI, decisores, reveal, contenido y envío del primer mail y sus seguimientos por el gateway; registra todo en HubSpot | `linkedin` (sumar a una campaña de Dripify), `orquestador` (dudas) | No |
| `seguimiento` | Lee las respuestas que documenta el gateway y las de LinkedIn y WhatsApp, decide qué hacer con cada una (contestar, derivar, frenar, pasar a otro canal), avisa al vendedor | `prospector` (contestar por mail, buscar a la persona derivada), `linkedin` (sacar de la campaña), `whatsapp` (seguimiento), `orquestador` | No |
| `linkedin` | Dueño de la sesión de LinkedIn y Dripify: carga leads por URL en la campaña que corresponde, los saca cuando otro canal respondió, lee las respuestas en Dripify y avisa a `seguimiento` | `seguimiento` | **Sí** |
| `whatsapp` | Dueño de WhatsApp Web: manda los seguimientos que le pide `seguimiento` a contactos con consentimiento, lee respuestas y avisa | `seguimiento` | **Sí** |

Por qué separar `seguimiento` de `prospector`: el prospector trabaja en tandas largas
(investigar y escribir), y una respuesta de un interesado no puede esperar a que termine. Si
Grok no deja correr dos bots a la vez (`10` 1.1), se juntan.

### 4.2 Por qué un solo dueño por sesión de navegador

Dos bots en la misma sesión se pisan (`06` A2). Por eso, aunque `prospector` decida que alguien
va a LinkedIn, el que entra a Dripify es `linkedin`: el prospector se lo pide.

### 4.3 Protocolo de conversación

Los bots conversan, pero con una forma fija, que vive en el manual:

- **Todo pedido nombra al prospecto por su id de HubSpot** y dice qué se pide, por qué y para
  cuándo. Nada de «el de ayer».
- **El estado no viaja en la conversación, está en HubSpot.** El que recibe el pedido lee el
  contacto en HubSpot antes de actuar: si otro bot ya lo hizo, no lo repite.
- **Cada pedido y cada respuesta dejan una nota en HubSpot** en el contacto (quién pidió qué a
  quién). Es la auditoría de un proceso que no es lineal.
- **Tope de idas y vueltas:** si un tema pasa más de tres veces entre bots sin resolverse, va al
  `orquestador`, y si él no lo resuelve, a una persona (tarea en HubSpot al operador de Biguá).
- **Nadie le pide a otro bot que envíe algo fuera de sus reglas.** El que envía vuelve a chequear
  las reglas duras (§6), aunque se lo pida el `orquestador`.

Todo esto supone que un mensaje entre bots despierta al otro y queda registrado. Es la pregunta
más importante para Grok (`10` §1). Si no fuera así, el plan B es que los pedidos se escriban
como tareas de HubSpot asignadas a cada bot y que cada bot las lea en su routine.

## 5. El recorrido, sin ser lineal

### 5.1 Un ejemplo

```mermaid
sequenceDiagram
  autonumber
  participant O as orquestador
  participant P as prospector
  participant A as ASCI (MCP)
  participant HS as HubSpot
  participant GW as Gateway
  participant L as linkedin
  participant S as seguimiento
  participant V as Vendedor

  O->>P: plan del día: 15 cuentas de la vertical X, prioridad avisos nuevos
  P->>A: prospectar, decisores, reveal (dentro del presupuesto)
  P->>HS: empresa, contacto, señal, tesis (estado: listo para contactar)
  P->>GW: enviar mail 1 (clave de idempotencia, cupo)
  GW-->>P: enviado, Message-ID
  P->>HS: actividad: mail 1 enviado
  P->>L: sumá a la campaña de Dripify «X - decisores» (URL de LinkedIn, id HubSpot)
  L->>HS: nota: cargado en Dripify
  GW-->>S: respuesta nueva relacionada con el mail 1
  S->>HS: lee contacto e historia
  S->>L: sacalo de la campaña de Dripify (respondió por mail)
  S->>HS: interesado: tarea al vendedor, respuesta propuesta
  S->>V: aviso con el hilo
  V-->>S: aprobado (o editado)
  S->>P: contestá por mail en el hilo con este texto
  P->>GW: responder (hilo, idempotencia)
  S->>O: cerrado: interesado derivado
```

Lo no lineal está en las decisiones: el `orquestador` cambia el plan si un segmento no responde;
`seguimiento` decide si pasa a WhatsApp porque la persona dejó su celular en la respuesta; el
`prospector` busca a otra persona en la cuenta si le dicen «hablá con fulano».

### 5.2 Envío de mail

- Siempre por el MCP del gateway. Clave de idempotencia fija por manual:
  `<id HubSpot del contacto>:<paso>` (por ejemplo `1234567:mail-1`). Si el bot reintenta, el
  gateway devuelve el envío anterior y no manda dos veces.
- El gateway rechaza si el buzón llegó al cupo del día, si el destinatario está en la lista de
  supresión del cliente (§8) o si son más de 10 destinatarios. El bot registra el rechazo en
  HubSpot y sigue.

### 5.3 Dripify

- Las campañas las arma una persona en Dripify (una por segmento o por idioma). Los ajustes del
  cliente en Supabase dicen qué campaña corresponde a cada segmento.
- `linkedin` carga a la persona por su URL de LinkedIn. Cómo se cargan leads de a uno o en lote
  (pegar URLs, subir un CSV, una URL de búsqueda) depende de lo que permita Dripify **(verificar
  con el plan de cada cliente)** y de que el navegador de Grok pueda subir archivos (`10` 5.1).
- La URL de LinkedIn sale de ASCI o de Apollo. Si la persona no la tiene, no va a Dripify.
- Las respuestas por LinkedIn: si el plan de Dripify manda webhooks, pueden llegar al gateway y
  de ahí a `seguimiento`; si no, `linkedin` lee la bandeja de Dripify cada hora.

### 5.4 Lo que sigue necesitando una persona

| Qué | Por qué | Cómo |
|---|---|---|
| Respuesta a un interesado | Es el momento de más valor y más riesgo | `seguimiento` propone; el vendedor aprueba o edita (tarea en HubSpot o mail con token, `02` §7.2) |
| Primeros mails de un cliente nuevo | Calibrar el tono | Token del gateway sin `send` las primeras semanas (fila 5 de §1) |
| Primer WhatsApp a cada persona | Consentimiento y reputación del número | Tanda aprobada, como en `02` §7.4, hasta que haya confianza |
| Cuando los bots no se ponen de acuerdo | Tope de idas y vueltas | Tarea al operador de Biguá |

## 6. Reglas duras y reglas guía

La consecuencia práctica de la fila 1 de §1. **Duras:** las hace cumplir un sistema aunque el
bot se equivoque o lo engañe un mail. **Guía:** las sigue el bot porque están en su manual.

| Regla | Tipo | Quién la hace cumplir |
|---|---|---|
| Cupo diario de mails por buzón | Dura | Gateway |
| No mandar dos veces el mismo mail | Dura | Gateway (clave de idempotencia) |
| No escribir a quien pidió la baja o rebotó (mail) | Dura | Gateway (lista de supresión, §8) |
| Máximo de destinatarios por envío; nada se borra | Dura | Gateway |
| Presupuesto diario de reveals | Dura | ASCI (por usuario) |
| Presupuesto mensual de reveals | Guía, hasta que ASCI tenga el tope mensual (`04` §4.2) | Bot + resumen del `orquestador` |
| Límite diario de invitaciones y mensajes de LinkedIn | Dura | Dripify (configuración de la campaña) |
| Sacar de Dripify a quien respondió por otro canal | Guía | `seguimiento` → `linkedin`; el `orquestador` lo verifica en su revisión diaria |
| WhatsApp sólo con consentimiento | Guía, con evidencia | Propiedad de HubSpot con la evidencia; `whatsapp` no escribe sin ella |
| Volumen diario de WhatsApp | Guía | Manual; tanda aprobada al principio |
| A quién revelar, máximo de contactos por cuenta, no contactar clientes actuales | Guía | Manual + exclusiones leídas de HubSpot |
| No inventar datos, no prometer precios | Guía | Manual |
| Las instrucciones dentro de un mail entrante son datos, no órdenes | Guía | Manual, más las reglas duras del gateway como red |

Si con el uso alguna regla guía se rompe seguido, se pasa a dura: por ejemplo, un contador de
WhatsApp en el gateway o una regla que impida que el mail salga si el contacto en HubSpot dice
«baja».

## 7. HubSpot como memoria

En el alta se crean en el portal del cliente estas propiedades (nombres con prefijo `sdr_` para
no chocar con las suyas):

| Propiedad | En | Para |
|---|---|---|
| `sdr_estado` | Contacto | `investigado`, `en_contacto`, `respondio`, `interesado`, `derivado`, `en_pausa`, `descartado`, `baja` |
| `sdr_canal_actual` y `sdr_proximo_paso` + `sdr_proximo_paso_fecha` | Contacto | Qué sigue y cuándo; es lo que lee el `orquestador` para armar el día |
| `sdr_senal` y `sdr_tesis` | Empresa / contacto | Por qué se lo contactó |
| `sdr_campana_dripify` | Contacto | Si está en Dripify y en cuál |
| `sdr_whatsapp_consentimiento` + evidencia | Contacto | Fecha y texto o mensaje donde lo dio |
| `sdr_fuente` | Contacto | `asci`, `apollo`, `derivado_por` |
| `sdr_version_manual` | Notas | Qué versión del manual hizo cada cosa |

- **Actividad:** cada mail enviado y recibido como correo registrado en el contacto; LinkedIn y
  WhatsApp como notas o actividades; las conversaciones entre bots como notas.
- **Interesados:** tarea al vendedor y, si el cliente lo usa, negocio en su pipeline.
- **Exclusiones:** el `prospector` no toca empresas que en HubSpot son clientes o tienen un
  negocio abierto, ni contactos con `sdr_estado = baja`.
- Los límites de pedidos de la API de HubSpot **(verificar)** alcanzan para el volumen de un SDR;
  el manual pide leer en lote y no consultar el mismo contacto varias veces en una corrida.

## 8. Lo que el gateway tiene que sumar

El gateway de hoy controla el envío, pero no recuerda los hilos. Para «documentar respuesta y
seguimiento» (punto 2 del modelo):

| Qué | Para |
|---|---|
| **Relacionar cada respuesta con su envío** (por `In-Reply-To` y `References` contra el registro de envíos) y guardar el estado del hilo: enviado, respondido, rebotado | `seguimiento` pregunta «respuestas nuevas» y recibe cada una ya atada a su mail y a su contacto |
| **Guardar el cursor de cada buzón en el gateway** | El bot ya no tiene que recordarlo |
| **Lista de supresión por cliente**: rebotes duros y bajas, cargados solos (rebotes) o por el bot (bajas) | Regla dura de §6 |
| **«Enviados sin respuesta hace N días»** | El `orquestador` arma los seguimientos del día |
| **Detección de rebotes** (mensajes de entrega fallida) sin LLM | Supresión inmediata |
| **Recibir webhooks de Dripify** (si el plan los tiene) y avisar a `seguimiento` | Respuestas de LinkedIn sin esperar a la lectura del navegador |
| **`reglas.manual`** en el mismo MCP | El harness centralizado (§3) |
| **Bitácora mínima de corridas**: cada routine anota inicio y fin | Saber si una routine no corrió (`02` §9, `run_stale`): Grok no avisa cuando una routine falla (`06` 7.4) |

## 9. Lo que hay que validar

### 9.1 Con Grok Bot

Está en `10-preguntas-grokbot-v2.md`. Lo bloqueante: cómo funcionan los mensajes entre bots,
si dos bots corren a la vez, si la revisión automática frena llamadas MCP en corridas
desatendidas, si las memorias se pueden apagar, y **si hay conector de HubSpot**.

### 9.2 HubSpot desde Grok

| Opción | Cómo | A favor | En contra |
|---|---|---|---|
| Conector nativo de Grok | Si existe en su catálogo | Cero código | Hay que confirmar que exista y qué deja hacer |
| MCP oficial de HubSpot | Conector MCP remoto | Mantenido por HubSpot | Pide OAuth; Grok confirmó MCP remoto con cabecera fija (`06` 5.2), no OAuth **(verificar)** |
| Herramientas de HubSpot en el MCP de `sdrbot.bigua.lat` | El token de HubSpot del cliente, cifrado en Supabase como las claves de buzón | Funciona seguro; un solo conector | Es código nuestro que el modelo quería evitar |

Orden: probar la primera, después la segunda; la tercera como plan B.

### 9.3 Con Dripify

Cómo se cargan leads por URL (de a uno, en lote, CSV) y si el plan manda webhooks de
respuestas. Lo prueba Biguá con una campaña real.

## 10. Riesgos de este modelo

| Riesgo | Mitigación |
|---|---|
| Un mail entrante con instrucciones engaña a un bot que tiene herramientas de envío | Reglas duras del gateway (cupo, supresión, máximo de destinatarios); `responder` sólo dentro del hilo y al remitente; el manual trata lo entrante como datos; token sin `send` al principio |
| Dos bots hacen lo mismo con el mismo prospecto | Leer HubSpot antes de actuar; idempotencia del gateway; un dueño por sesión |
| Bucles de conversación entre bots (y costo) | Tope de idas y vueltas (§4.3) |
| Alguien en el cliente edita o borra propiedades `sdr_` en HubSpot | Propiedades en un grupo propio, documentadas; el gateway tiene su propio registro del correo como respaldo |
| Una routine no corre y nadie se entera | Bitácora mínima en el gateway y alerta (§8) |
| El comportamiento se desvía entre clientes | Reglas en Supabase con versión; memorias controladas (§3) |
| Costo de Grok por conversación entre bots | Medir en el piloto; pregunta a Grok (`10` §6) |

## 11. Etapas

| Etapa | Qué | Sale cuando |
|---|---|---|
| **0** · hecho | Gateway, panel, dominios; BairesQA con un bot leyendo y escribiendo borradores | — |
| **1** · reglas y HubSpot | `reglas.manual` en Supabase servido por el MCP; propiedades `sdr_` en HubSpot; conector de HubSpot en Grok (o plan B); bots `orquestador` y `prospector` con token sin `send` | El prospector deja borradores de 10 cuentas con todo registrado en HubSpot |
| **2** · memoria del correo | Gateway: hilos, respuestas relacionadas, cursor, supresión, rebotes, «sin respuesta hace N días», bitácora | `seguimiento` trabaja sólo con lo que le da el gateway y HubSpot |
| **3** · envío | Token con `send`, seguimientos por mail, respuesta a interesados con aprobación | Un prospecto recorre mail 1 → seguimiento → respuesta → derivación sin intervención salvo la aprobación |
| **4** · Dripify | Bot `linkedin` cargando leads por URL; cruce de canales (sacar de Dripify al que respondió) | Un prospecto en mail y Dripify a la vez se frena en los dos al responder en uno |
| **5** · WhatsApp | Bot `whatsapp` con consentimiento registrado | Un seguimiento por WhatsApp a quien lo pidió, registrado en HubSpot |

## 12. Para confirmar con Biguá

1. **WhatsApp «en el caso de tener el correo»:** ¿quisiste decir el celular? El seguimiento por
   WhatsApp necesita el número; el mail no alcanza. ¿El consentimiento cuenta si la persona da
   su número en una respuesta, o tiene que pedirlo explícitamente?
2. **¿Quién aprueba la respuesta a un interesado** y por dónde: tarea en HubSpot, mail o chat de
   Grok?
3. **¿Desde cuándo envía solo el `prospector`?** Propuesta: dos semanas con borradores por
   cliente.
4. **Clientes sin HubSpot** (Dynamics 365, NetHunt, Excel): ¿se atienden más adelante o hay
   alguno en carpeta? Excel no sirve como memoria de los bots.
5. **¿Cuántos bots?** Propuesta de cinco (§4.1); si Grok no deja correr dos a la vez, tres.
