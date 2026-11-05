# Panel por cliente: canales, campañas y ajustes del SDR

Estado: **diseño para revisar, nada construido.** Escrito el 05/11/2026. Propone cómo reorganizar
la ficha de cada cliente en `https://sdrbot.bigua.lat/admin`: qué se configura, dónde, quién lo
toca y en qué orden se construye. Complementa a `15` (alta), `16` (guía del cliente) y `20`
(Dripify).

## 1. Lo que hay hoy

La ficha de un cliente tiene seis pestañas al mismo nivel:

| Pestaña | Qué tiene | Quién la ve |
|---|---|---|
| **SDR** | El formulario de ajustes (15 campos en una sola columna), «Así lo leen los bots», la configuración técnica (canal de reglas, zona horaria, calibración, bots activos), los dos despertadores, LinkedIn · Dripify y el historial | Todos; lo técnico, sólo Biguá |
| **Buzones** | Alta, prueba, contraseña, pausa y cupo de cada buzón | Todos |
| **Dominios** | SPF, DKIM y DMARC | Todos |
| **Usuarios** | Usuarios del panel del cliente | Biguá |
| **Tokens de Grok Bot** | Tokens del gateway | Biguá |
| **Actividad** | Auditoría | Todos |

Lo que no funciona:

1. **La pestaña SDR mezcla cuatro cosas de naturaleza distinta:** quién es la empresa (nombre,
   tono, firma), a quién se le escribe y con qué argumento (ICP, cargos, oferta, señal), cuánto y
   cómo opera (cuentas por día, extrapolados, calibración) y la plomería (webhooks de los
   despertadores, API key de Dripify). Todo en la misma columna y con el mismo peso visual.
2. **Los canales están desparramados:** el correo en dos pestañas (Buzones y Dominios), LinkedIn
   adentro de SDR, y «qué buzón usar para qué» es un párrafo libre en los ajustes.
3. **Lo administrativo tiene la misma jerarquía que el negocio:** Usuarios y Tokens se ven igual
   que SDR, aunque se tocan una vez en el alta y casi nunca más.
4. **Hay una sola configuración por cliente.** No hay forma de tener dos propuestas de valor, dos
   audiencias o una invitación a un webinar en paralelo a la prospección. El diseño v2 ya lo
   preveía («campaña de Dripify por segmento», `09` §3) pero no está modelado.
5. **Varias decisiones de negocio están fijas en las reglas** y el cliente no las ve: la cadencia
   (mail 2 a los 4 días hábiles, mail 3, pausa de 90 días), dos personas por cuenta con un día de
   diferencia, el largo del mail, «sin links». Están bien como default, pero una campaña de
   webinar, por ejemplo, necesita un link y una fecha límite.
6. **No hay una vista de estado:** para saber si un cliente está sano hay que recorrer pestañas
   (¿buzón bloqueado?, ¿Dripify con error?, ¿cuántas aprobaciones esperan?, ¿cómo va la
   calibración?).

## 2. Inventario de configuraciones

Todo lo que hoy se puede configurar, más lo que conviene sumar, con el nivel donde debería vivir.
Los niveles se explican en §3.

### 2.1 Lo que ya existe

| Ajuste | Hoy | Lo edita | Lo lee | Nivel propuesto |
|---|---|---|---|---|
| Nombre comercial | `ajustes.nombre_comercial` | Cliente | Todos los bots | **Empresa** |
| Oferta | `ajustes.oferta` | Cliente | prospector, seguimiento | **Empresa** (descripción general) + **Campaña** (propuesta de valor de esa campaña) |
| A quién le venden (ICP) | `ajustes.icp` | Cliente | prospector | **Campaña** |
| Cargos a los que se escribe | `ajustes.roles_objetivo` | Cliente | prospector | **Campaña** |
| A quién no escribirle | `ajustes.excluir` | Cliente | prospector | **Empresa** (exclusiones de siempre) + **Campaña** (las propias) |
| Tono | `ajustes.tono` | Cliente | Todos | **Empresa**, con override por campaña |
| Idioma y trato | `ajustes.idioma` | Cliente | Todos | **Empresa**, con override por campaña |
| Firma | `ajustes.firma` | Cliente | prospector, seguimiento | **Canal → buzón** (la firma es de quien manda), con default en Empresa |
| Objeciones | `ajustes.objeciones` | Cliente | seguimiento | **Empresa** (generales) + **Campaña** (las de esa oferta) |
| Qué cuenta como positivo | `ajustes.positivos` | Cliente | seguimiento | **Campaña** (en un webinar, positivo es «se inscribió») |
| Qué buzón usar para qué | `ajustes.buzones` (texto libre) | Biguá | prospector | **Campaña** → buzones asignados (selección, no texto) |
| Cuentas nuevas por día | `ajustes.cuentas_por_dia` | Biguá | orquestador | **Campaña** (con un tope total del cliente en Operación) |
| Antigüedad máxima del aviso | `ajustes.dias_aviso` | Biguá | prospector | **Campaña → señal** |
| Señal en los avisos | `ajustes.senal_avisos` | Biguá | prospector | **Campaña → señal** |
| Acepta mails extrapolados | `ajustes.acepta_mails_extrapolados` | Biguá | prospector | **Campaña** (default de Empresa) |
| Canal de reglas / versión fija | `cliente_config.canal`, `version_fija` | Biguá | gateway | **Administración** |
| Zona horaria | `cliente_config.zona_horaria` | Biguá | gateway, routines | **Empresa** (dato del cliente; lo ve, lo cambia Biguá) |
| Calibración | `cliente_config.calibracion_mails` | Biguá | gateway | **Operación** (y por campaña, §4.4) |
| Bots activos | `cliente_config.bots_activos` | Biguá | gateway, orquestador | **Administración** |
| Despertadores (URL, clave, horario, espera) | `sdr` despertadores | Biguá | gateway | **Administración → Bots** |
| Buzones (IMAP/SMTP, cupo, nombre visible) | `mailgw.mailbox` | Cliente | gateway | **Canales → Correo** |
| Dominios | `mailgw` dominios | Cliente | — | **Canales → Correo** (salud del remitente) |
| Dripify: API key, campaña, largo de la nota, webhook | `sdr.dripify_cuenta` | Biguá | gateway, prospector | **Canales → LinkedIn** (la cuenta); la campaña de Dripify pasa a **Campaña** |
| Usuarios, tokens | `mailgw` | Biguá | — | **Administración** |

### 2.2 Lo que está fijo en las reglas y conviene exponer

| Ajuste | Hoy (fijo en `playbooks/`) | Por qué exponerlo | Nivel |
|---|---|---|---|
| **Objetivo y llamado a la acción** | Implícito: «una pregunta que se conteste en una línea» | Prospección pide una charla; un webinar pide inscribirse; una reactivación pide «¿sigue vigente?» | Campaña |
| **Cadencia del mail** | Mail 1 → 4 días hábiles → mail 2 → mail 3 → `sin_respuesta` y 90 días | Un webinar termina en la fecha del evento; una reactivación puede ser de un solo mail | Campaña (pasos y esperas, con tope) |
| **Personas por cuenta** | Dos: el publicante y quien decide, un día hábil después | Hay ofertas donde sólo importa el decisor, o donde van tres | Campaña |
| **Links permitidos** | «Sin links» | El link de inscripción al webinar, o el de agenda | Campaña (lista de URLs exactas permitidas) |
| **Fechas** | No hay | Una campaña de webinar tiene inicio, cierre de inscripción y fecha del evento | Campaña |
| **Largo del primer mail** | 60 a 120 palabras | Rara vez cambia: dejarlo fijo, con «corto / normal» como mucho | Campaña (avanzado) |
| **Prueba social aprobada** | No hay: los bots no inventan casos | Con casos reales cargados («redujimos 40 % el tiempo de regresión en X»), el mail es más fuerte sin inventar nada | Empresa (la biblioteca) y Campaña (cuáles usar) |
| **Link de agenda** | No hay | Para que el positivo pueda agendar directo (Calendly, HubSpot Meetings) | Empresa, con override por campaña |
| **A quién avisar un positivo** | Biguá avisa a mano | El vendedor del cliente que toma la reunión | Empresa (y por campaña si cada una tiene dueño) |
| **Lista de no contactar** | `excluir` en texto libre + supresión de bajas y rebotes | Clientes actuales, partners, competidores por dominio: mejor una lista de dominios y mails, cargable por CSV, que el gateway haga cumplir | Empresa |
| **Presupuesto de ASCI** | Tope «3 publicantes por tanda», sin tope diario de créditos | Cada reveal cuesta; con varias campañas hay que repartir | Operación (tope del cliente) y Campaña (peso) |
| **Días y horas de envío** | Los que marcan las routines | Con campañas en varios países, los envíos deberían salir en horario del destinatario | Operación (después) |
| **Feriados** | No hay | No mandar en feriados del país del destinatario | Operación (después; lista por país) |

No conviene exponer: el contenido de las reglas, los nombres de las variables de Dripify, los
crons de las routines, ni nada que el cliente pueda usar para darles instrucciones a los bots
(«escribí más largo»). Eso sigue en `playbooks/`, cuidado por Biguá (`16` §4).

## 3. La jerarquía propuesta

Cinco niveles, de lo que más se usa a lo que menos:

```
Cliente
├── Resumen        ← estado y pendientes (lo primero que se ve)
├── Campañas       ← el núcleo: cada una con su configuración de SDR
├── Empresa        ← lo común a todas las campañas: identidad, tono, exclusiones, prueba social
├── Canales        ← por dónde se habla: correo, LinkedIn, WhatsApp; y adónde va lo bueno: CRM, agenda
├── Actividad
└── ⚙ Administración  ← usuarios, tokens, bots y despertadores, reglas, operación
```

**Regla de herencia:** Empresa define los defaults; una campaña sólo dice lo que cambia (tono,
idioma, firma, extrapolados, link de agenda). En el formulario de la campaña, un campo heredado se
ve atenuado con «De Empresa: …» y un botón «Cambiar para esta campaña».

**Regla de permisos:** el candado reemplaza al «· lo cambia Biguá» al final del título. El cliente
ve todo lo de su negocio (incluido lo que no puede cambiar, en sólo lectura) y no ve Administración.

| Sección | Cliente | Biguá |
|---|---|---|
| Resumen | Ve | Ve |
| Campañas | Crea borradores y edita mensaje y audiencia; ve volumen y canales | Todo; activa, pausa y termina |
| Empresa | Edita | Edita |
| Canales → Correo | Carga y prueba sus buzones y dominios | Todo |
| Canales → LinkedIn / WhatsApp / CRM | Ve el estado; puede pegar la API key | Todo |
| Actividad | Ve | Ve |
| Administración | — | Todo |

### 3.1 Resumen

Una pantalla de estado. Nada se edita acá; cada bloque lleva a donde se arregla.

```
BairesQA                                                        ⚙
────────────────────────────────────────────────────────────────────
 Resumen   Campañas   Empresa   Canales   Actividad

 ┌ Necesita atención ───────────────────────────────────────────┐
 │ ● 3 aprobaciones esperan en el chat del orquestador          │
 │ ● Buzón ventas@ bloqueado por contraseña      → Canales      │
 │ ● Calibración: 14 de 20 mails aprobados                      │
 └──────────────────────────────────────────────────────────────┘

 Campañas activas                                    Esta semana
 ┌─────────────────────────────┬────────┬────────┬────────┬──────┐
 │ QA por avisos · Argentina   │ 42 env │ 6 resp │ 2 pos. │ ●    │
 │ Webinar automatización 28/11│ 18 env │ 4 insc │        │ ●    │
 └─────────────────────────────┴────────┴────────┴────────┴──────┘

 Canales   Correo ● 2 buzones · SPF/DKIM ok   LinkedIn ● Dripify listo
           WhatsApp ○ no configurado          CRM ○ no configurado
```

Los números salen de `registro_resumen` (ya existe, por cliente; habría que abrirlo por campaña).

### 3.2 Campañas

La lista, con estado (borrador, activa, pausada, terminada), tipo, canales, volumen y números de
la semana. **Nueva campaña** arranca desde un tipo (§4.2), que precarga lo razonable.

El editor de una campaña, en secciones plegables, en el orden en que se piensa una campaña:

```
← Campañas
Webinar: automatización de pruebas (28/11)            [Borrador ▾]  Guardar
──────────────────────────────────────────────────────────────────────────
 1 Objetivo          Tipo: Invitación a evento · Inicio 10/11 · Cierre 27/11
 2 Propuesta         Qué se ofrece en esta campaña, por qué ahora, prueba social
 3 Audiencia         ICP · cargos · exclusiones propias · señal (avisos, ninguna, lista)
 4 Mensajes          Llamado a la acción · links permitidos · tono e idioma (heredados)
 5 Secuencia         Mail 1 → 3 días → mail 2 → hasta el 27/11 · LinkedIn: nota + 2 mensajes
 6 Canales y ritmo   Buzones: ana@, info@ · Dripify: campaña 123456 · 8 cuentas/día · 1 persona/cuenta
 7 Respuestas        Qué es positivo · objeciones propias · a quién avisar
 ── Avanzado (Biguá) ───────────────────────────────────────────────────
    Calibración de la campaña · extrapolados · reveals de publicantes por tanda · peso en el cupo
 ── Así lo leen los bots ─── (vista previa, a la derecha en pantallas anchas)
 ── Historial de cambios de esta campaña
```

Cada sección cerrada muestra un resumen de una línea (como arriba), así la campaña se lee entera
sin abrir nada. Las secciones con algo obligatorio vacío llevan un punto; una campaña no se puede
activar con puntos pendientes.

### 3.3 Empresa

Lo que no cambia de una campaña a otra. Es casi todo lo que hoy edita el cliente:

| Bloque | Campos |
|---|---|
| Identidad | Nombre comercial, qué hace la empresa (descripción general, no la oferta de una campaña), zona horaria (sólo lectura para el cliente) |
| Voz | Tono, idioma y trato, firma por defecto |
| Exclusiones de siempre | Tipos de empresa y cargos a no tocar (texto), **lista de no contactar** (dominios y mails, carga por CSV) |
| Prueba social | Casos y datos que los bots pueden citar, cada uno con su fuente («caso publicado», «aprobado por el cliente») |
| Objeciones generales | «Lo que dicen»: cómo se responde |
| Después del positivo | A quién avisar, link de agenda |

Con su vista previa y su historial, como hoy.

### 3.4 Canales

Por dónde se habla y adónde va lo que sale bien. Una tarjeta por canal con su estado; cada una
abre su detalle.

```
 Canales
 ┌ Correo ─────────────── ● ok ┐ ┌ LinkedIn · Dripify ─── ● listo ┐ ┌ WhatsApp ──── ○ ┐
 │ 2 buzones · 31/80 hoy        │ │ Cuenta conectada · 2 campañas  │ │ Próximamente    │
 │ bairesqa.net SPF ● DKIM ●    │ │ Cupo API 140/4500              │ │ (sólo seguim.)  │
 └──────────────────────────────┘ └────────────────────────────────┘ └─────────────────┘
 ┌ CRM ───────────────────── ○ ┐ ┌ Agenda ──────────────────── ○ ┐
 │ HubSpot · próximamente       │ │ Link de reuniones             │
 └──────────────────────────────┘ └───────────────────────────────┘
```

- **Correo:** buzones y dominios juntos (el dominio es la salud del remitente). Por buzón: lo de
  hoy, más **firma** y **en qué campañas se usa** (de sólo lectura; se asigna en la campaña). Los
  dominios aparecen como una franja de estado arriba de los buzones de ese dominio. Microsoft 365
  y Google Workspace entran acá como otros tipos de buzón (`08`).
- **LinkedIn · Dripify:** la **cuenta** (API key, largo de la nota según Premium, Probar, cupo de
  la API, URL del webhook). Las **campañas de Dripify** se listan con la campaña del SDR que usa
  cada una; el id se elige en la campaña. Una cuenta de Dripify es una persona de LinkedIn: si el
  cliente prospecta desde dos perfiles, son dos cuentas (§6).
- **WhatsApp:** tarjeta visible como «próximamente» para fijar expectativas. Ver §5.
- **CRM:** HubSpot primero (`11` §5); mapeo aprobado, propietario por defecto, qué se carga.
- **Agenda:** el link de reuniones del vendedor; lo usa `seguimiento` con un positivo.

### 3.5 Administración (⚙)

Fuera de la barra principal: un engranaje arriba a la derecha, sólo para Biguá. Adentro, una
columna de navegación:

| Sección | Qué tiene |
|---|---|
| Usuarios | Los del panel del cliente (lo de hoy) |
| Tokens de Grok Bot | Lo de hoy |
| Bots | Bots activos, y para cada bot sus routines (de `playbook_rutina`, sólo lectura) y su **despertador** si tiene. Así el despertador queda junto al bot que despierta |
| Reglas | Canal (estable o canario), versión fija, versión que está leyendo hoy |
| Operación | Calibración del cliente, tope total de cuentas por día, presupuesto de ASCI, pausa general del SDR («frenar todo») |
| Ajustes fuera del formulario | Las claves que cargó la CLI y el formulario no conoce (hoy es una línea gris en SDR) |

## 4. Campañas

### 4.1 Qué es una campaña

Una campaña es **una propuesta para una audiencia, con su objetivo, sus mensajes y sus canales**.
Cada prospecto entra al registro por una campaña y queda atado a ella: todo lo que se le escribe
sale con la configuración de esa campaña, y sus números se cuentan ahí.

El cliente hoy tiene, implícita, una sola campaña: la migración la crea como «Principal» con los
ajustes actuales (§7).

### 4.2 Tipos

Un tipo es una plantilla: precarga campos, decide qué secciones son obligatorias y qué tarea de
las reglas lee el bot. Arrancar con tres:

| Tipo | Señal | Objetivo y positivo | Secuencia por defecto | Lo propio |
|---|---|---|---|---|
| **Prospección por señal** (la de hoy) | Aviso reciente (ventana en días, cómo pedirlo a ASCI) | Una charla | Mail 1 → 4 d → 2 → 4 d → 3; LinkedIn nota + 2 | Publicante + decisor |
| **Invitación a evento** | Opcional: aviso, ICP sin señal, o lista | Inscribirse | Mail 1 → 3 d → mail 2, y nada después del cierre | Fecha del evento y del cierre, link de inscripción permitido, después del evento: seguimiento a los inscriptos (etapa siguiente) |
| **Reactivación** | Prospectos propios en `sin_respuesta` o `en_pausa` vencida, de cualquier campaña | Retomar la charla | Un mail, mismo hilo si se puede | Sin reveal: no gasta créditos |

Más adelante: **Cuentas objetivo** (una lista de empresas cargada por CSV, sin señal de avisos) y
**Derivados** (la persona que alguien nos derivó, hoy un caso de `seguimiento`).

### 4.3 Reglas entre campañas

- **Una persona, una campaña activa.** Si ya está en contacto por otra, no se la toma; se ve en la
  campaña como «ya en contacto por X».
- **Una cuenta en contacto por una campaña de prospección no entra en otra de prospección** hasta
  que esa termine con ella (respuesta, `sin_respuesta` o pausa). Una de **evento** sí puede escribir
  a otra persona de esa cuenta, o a la misma si su campaña terminó sin respuesta (configurable en
  la campaña de evento: «incluir cuentas en contacto»).
- **La supresión es del cliente, no de la campaña.** Una baja o un rebote vale para todas.
- **El cupo de los buzones es compartido.** El orquestador reparte las cuentas del día por el
  **peso** de cada campaña activa y nunca pasa el tope total del cliente.
- **Una respuesta pertenece a la campaña del mensaje que contesta**; `seguimiento` lee la
  configuración de esa campaña (positivos, objeciones, link de agenda).

### 4.4 Calibración

Hoy es por cliente: los primeros 20 mails. Con campañas:

- La **primera** campaña del cliente calibra como hoy (20).
- Cada campaña **nueva** calibra sus primeros **5** (configurable en Avanzado): cambia la
  propuesta y el tono del pedido, y conviene ver los primeros mails aunque el cliente ya esté
  calibrado.
- El gateway cuenta las aprobaciones `calibracion_mail` usadas **por campaña**.

### 4.5 Cómo lo leen los bots

| Pieza | Hoy | Con campañas |
|---|---|---|
| `reglas_manual` | Una sección «Ajustes de este cliente» | Dos secciones: «Empresa» y «Campaña: <nombre>» (la del pedido); el orquestador recibe además «Campañas activas» con peso y cupo |
| Pedido del orquestador al prospector | «N cuentas nuevas» | «N cuentas para la campaña X, M para la Y» (`campana` en el pedido) |
| `registro_guardar_cuenta` / `_prospecto` | — | Llevan `campana`; el gateway rechaza una persona que ya está activa en otra |
| `enviar` | Cualquier buzón del cliente | Sólo un buzón asignado a la campaña del prospecto; links sólo los permitidos de la campaña |
| `dripify_cargar` | La campaña de Dripify del cliente | La de la campaña del prospecto; una carga por campaña |
| Webhook de Dripify | Una URL por cliente | La misma URL; el gateway ubica la campaña por el id de campaña de Dripify del cuerpo o por el prospecto |
| Aprobaciones | Por cliente | Llevan la campaña; el orquestador la nombra al presentarlas |
| `registro_resumen` | Por cliente | Por cliente y por campaña |

Las reglas (`playbooks/`) tienen que cambiar en tres lugares: el orquestador reparte por campaña,
el prospector toma la campaña del pedido (y la tarea de su tipo: `diaria` para prospección,
`evento` y `reactivacion` nuevas), y `seguimiento` lee la campaña del prospecto.

### 4.6 Datos

```sql
create table sdr.campana (
  id             uuid primary key default gen_random_uuid(),
  client_id      text not null references mailgw.client on delete cascade,
  clave          text not null,                    -- 'principal', 'webinar-2026-11'
  nombre         text not null,
  tipo           text not null check (tipo in ('prospeccion', 'evento', 'reactivacion')),
  estado         text not null default 'borrador'
                 check (estado in ('borrador', 'activa', 'pausada', 'terminada')),
  ajustes        jsonb not null default '{}',      -- lo de §2, validado por tipo como hoy ajustes.mjs
  buzones        uuid[] not null default '{}',     -- mailgw.mailbox
  dripify_campana_id bigint,
  peso           int not null default 1 check (peso between 0 and 10),
  calibracion_mails int not null default 5,
  inicio date, fin date,
  creado_at timestamptz not null default now(), actualizado_at timestamptz not null default now(),
  unique (client_id, clave), unique (id, client_id)
);
-- + campana_id en sdr.cuenta (la que la tomó), sdr.prospecto, sdr.evento, sdr.pedido,
--   sdr.aprobacion y sdr.dripify_carga; historial: sdr.ajustes_historial gana campana_id.
```

`sdr.cliente_config.ajustes` queda como los ajustes de **Empresa**. Las claves que pasan a la
campaña (§2.1) se mueven a la campaña «principal» en la migración. Mismas políticas por cliente
que el resto de `sdr`.

## 5. WhatsApp

Se puede, con un límite que conviene dejar dicho en la tarjeta del canal desde el principio:
**WhatsApp es para seguimiento, no para el primer contacto.**

- Por **WhatsApp Web en el asiento de Grok** (el bot `whatsapp` de `09` §4): técnicamente puede
  mandar a cualquiera, pero un número que escribe en frío a desconocidos se bloquea rápido y
  arrastra al número del cliente. Ya está decidido que va con aprobación (`whatsapp_primero`).
- Por la **API de WhatsApp Business** (Meta, directo o por un proveedor como Twilio): estable y
  con webhooks como Dripify, pero exige consentimiento del destinatario y plantillas aprobadas por
  Meta para iniciar la conversación (verificar al implementar). No sirve para prospectar en frío.

Propuesta: canal WhatsApp con un número por cliente, usado sólo cuando la persona dio su número o
pidió seguir por ahí, y por la API de Business cuando haya un cliente que lo necesite. En la
campaña aparece como un paso opcional de **Respuestas** («si pide WhatsApp»), no de la secuencia.

## 6. Decisiones que necesito

| # | Pregunta | Propuesta |
|---|---|---|
| 1 | ¿El cliente puede crear campañas? | Sí, como borrador; las activa Biguá (revisión y calibración) |
| 2 | ¿Una campaña de Dripify por campaña del SDR? | Sí: el cliente duplica la esqueleto en Dripify por cada campaña con LinkedIn. Alternativa: una sola campaña de Dripify y que la campaña del SDR sólo cambie los textos (más simple, pero los números de Dripify no se separan) |
| 3 | ¿Una persona puede estar en dos campañas a la vez? | No (§4.3), con la excepción configurable de la de evento |
| 4 | ¿Calibración por campaña? | Sí: 20 la primera, 5 las siguientes (§4.4) |
| 5 | ¿La firma pasa al buzón? | Sí, con la de Empresa como default |
| 6 | ¿Lista de no contactar que el gateway haga cumplir? | Sí, por dominio y por mail, en Empresa, con carga por CSV |
| 7 | ¿Cadencia configurable? | Sí, pero acotada: de 1 a 4 mails, esperas de 2 a 10 días hábiles; LinkedIn sigue con la secuencia de Dripify (nota + 2) |
| 8 | ¿Cuántos perfiles de LinkedIn por cliente? | Uno al principio; el modelo admite varios (cuenta de Dripify por perfil) |

## 7. Por etapas

Cada etapa se puede usar sola; la A no toca la base ni las reglas.

| Etapa | Qué | Toca |
|---|---|---|
| **A · Reordenar** | Barra nueva (Resumen, Empresa, Canales, Actividad, ⚙; Campañas aparece en C y, mientras tanto, «A quién y con qué» vive como un bloque de Empresa). Canales junta Buzones, Dominios y Dripify. Administración junta Usuarios, Tokens, lo técnico y los despertadores. El formulario de ajustes de hoy partido en bloques (Empresa / A quién y con qué / Operación) con candados en vez de sufijos. Resumen con lo que ya hay (aprobaciones, calibración, estado de buzones y Dripify) | Sólo `gateway/src/admin/static/` y un endpoint de resumen |
| **B · Ajustes nuevos** | Lista de no contactar (con el gateway haciéndola cumplir), firma por buzón, link de agenda, a quién avisar un positivo, prueba social, llamado a la acción. Las reglas los leen | `ajustes.mjs`, una tabla de supresión del cliente, `playbooks/` |
| **C · Campañas** | Tabla `sdr.campana`, la «principal» migrada, tipo Prospección, buzones y Dripify por campaña, `campana` en las herramientas MCP, reparto en el orquestador, calibración por campaña, resumen por campaña | Base, gateway, MCP, `playbooks/`, panel |
| **D · Más tipos** | Invitación a evento y Reactivación, cadencia configurable | `playbooks/` (tareas nuevas), panel |
| **E · Canales nuevos** | CRM (HubSpot), WhatsApp de seguimiento | Según `11` y §5 |

Sugerencia: A y B juntas en una entrega, C después de revisar con
BairesQA cómo quieren usar la segunda campaña.
