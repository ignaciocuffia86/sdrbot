# Panel por cliente: canales, campañas y ajustes del SDR

Estado: **etapas A y B construidas** (06/11/2026, migración `010` del gateway); de C1, la base
(migración `012`, aplicada en producción el 09/11/2026), los ajustes partidos, la API y la pestaña Campañas del panel (09/11/2026; la
pestaña la ve sólo Biguá hasta que las reglas lean la campaña); el resto de C en adelante, diseño, con todas las
definiciones cerradas (§6, decisiones 9 a 14, del 09/11/2026).
Escrito el 05/11/2026. Propone cómo reorganizar
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
| Firma | `ajustes.firma` | Cliente | prospector, seguimiento | **Canal → buzón** (la firma es de quien manda), con default en Empresa; la campaña no tiene firma (decisión 11) |
| Objeciones | `ajustes.objeciones` | Cliente | seguimiento | **Empresa** (generales) + **Campaña** (las de esa oferta) |
| Qué cuenta como positivo | `ajustes.positivos` | Cliente | seguimiento | **Campaña** (en un webinar, positivo es «se inscribió») |
| Qué buzón usar para qué | `ajustes.buzones` (texto libre) | Biguá | prospector | **Campaña** → buzones asignados (selección, no texto) |
| Cuentas nuevas por día | `ajustes.cuentas_por_dia` | Biguá | orquestador | **Campaña** (con un tope total del cliente en Operación; sin peso, decisión 12) |
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
| **Presupuesto de ASCI** | Tope «3 publicantes por tanda», sin tope diario de créditos | Cada reveal cuesta; con varias campañas hay que repartir | Operación (tope del cliente), repartido en proporción a las cuentas por día de cada campaña (decisión 12) |
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
idioma, extrapolados, link de agenda y quién toma a los interesados; la firma no, es del buzón:
decisión 11). En el formulario de la campaña, un campo heredado se
ve atenuado con «De Empresa: …» y un botón «Cambiar para esta campaña».

**Regla de permisos:** el candado reemplaza al «· lo cambia Biguá» al final del título. El cliente
ve todo lo de su negocio (incluido lo que no puede cambiar, en sólo lectura) y no ve Administración.

| Sección | Cliente | Biguá |
|---|---|---|
| Resumen | Ve | Ve |
| Campañas | Crea y edita; en modo autogestionado también activa, pausa y fija el volumen (decisión 1) | Todo |
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

Los números salen de `registro_resumen`, con el detalle de cada campaña en `por_campana` (§7.2, paso 3).

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
    Calibración de la campaña · extrapolados · reveals de publicantes por tanda · campaña de Dripify
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
  que esa termine con ella (respuesta, `sin_respuesta` o pausa). Una de **evento** puede escribirle
  a otra persona de esa cuenta, nunca a una que esté activa en otra campaña (decisión 3).
- **La supresión es del cliente, no de la campaña.** Una baja o un rebote vale para todas.
- **El cupo de los buzones es compartido.** Cada campaña activa pide sus cuentas por día; la suma
  de las activas no puede pasar el tope total del cliente (el panel no deja guardar ni activar).
  Si un día los buzones no dan para todo, el orquestador recorta en proporción (decisión 12).
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
| `reglas_manual` | Una sección «Ajustes de este cliente» | Dos secciones: «Empresa» y «Campaña: <nombre>» (la del pedido); el orquestador recibe además «Campañas activas» con sus cuentas por día y el cupo |
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

Construido en la migración `012_campanas` del gateway. Lo principal:

```sql
create table sdr.campana (
  id, client_id, clave,               -- 'principal', 'webinar-2026-11'; único por cliente
  nombre, tipo,                       -- prospeccion | evento | reactivacion
  estado,                             -- borrador | activa | pausada | terminada
  ajustes jsonb,                      -- lo de §6.2 «Campaña», validado por tipo como hoy ajustes.mjs
  dripify_campana_id bigint,          -- C1: un perfil; en C2 pasa a una tabla por perfil
  cuentas_por_dia int,                -- decisión 12, sin peso
  calibracion_mails int default 5,    -- decisión 4
  inicio date, fin date,
  duplicada_de uuid, terminada_at,    -- decisión 13: una terminada no se reactiva, se duplica
  creado_at, actualizado_at
);
create table sdr.campana_buzon (client_id, campana_id, account_id);  -- los buzones de cada campaña
-- + campana_id (not null, clave foránea compuesta con client_id) en sdr.cuenta, sdr.prospecto,
--   sdr.evento, sdr.pedido, sdr.aprobacion y sdr.dripify_carga; sdr.ajustes_historial gana
--   campana_id (vacío = Empresa).
```

Diferencias con el boceto anterior:

- Los buzones van en una tabla y no en un `uuid[]`, para que la clave foránea compuesta impida
  asignar un buzón de otro cliente y borrar un buzón lo saque de sus campañas.
- En `sdr.dripify_carga`, `campana_id` ya era el id de la campaña de Dripify: pasa a llamarse
  `dripify_campana_id`.
- `sdr.campana_principal(cliente)` devuelve la «principal» y la crea si falta. La usan:
  - un disparador en las seis tablas del registro, que completa `campana_id` cuando el código de
    hoy no lo manda;
  - el alta de `sdr.cliente_config`.

  Es `security definer`, porque la aplicación sólo lee campañas, y rechaza un cliente distinto
  del de la sesión.

`sdr.cliente_config.ajustes` queda como los ajustes de **Empresa**. Las claves que pasan a la
campaña (§6.2) se copian a la «principal» en la `012` y se borran de Empresa en la `014`. Mismas políticas por cliente
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

## 6. Decisiones

Tomadas el 05/11/2026. Maqueta navegable con todas aplicadas: https://claude.ai/artifact/9qrd8bD42oAhNfMnJ7eEpL

| # | Pregunta | Decisión |
|---|---|---|
| 1 | ¿El cliente puede crear campañas? | **Sí.** El servicio hoy lo opera Biguá, pero puede pasar a ser autogestionado: cada cliente tiene un **modo de operación** (Administración → Operación). *Operado por Biguá:* el cliente arma borradores y Biguá los activa. *Autogestionado:* el cliente crea, activa y pausa sus campañas y elige cuántas cuentas por día, dentro del tope que fija Biguá |
| 2 | ¿Una campaña de Dripify por campaña del SDR? | **Sí**, una por cada perfil de LinkedIn que use la campaña (ver 8) |
| 3 | ¿Una persona puede estar en dos campañas a la vez? | **No**, sin excepciones (tampoco en las de evento): se corrige §4.3 |
| 4 | ¿Calibración por campaña? | **Sí:** 20 la primera del cliente, 5 cada campaña nueva |
| 5 | ¿La firma pasa al buzón? | **Sí**, con la de Empresa como default |
| 6 | ¿Lista de no contactar que el gateway haga cumplir? | **Sí**, por dominio y por mail, en Empresa, con carga por CSV |
| 7 | ¿Cadencia configurable? | **Sí:** de 1 a 4 mails, esperas de 2 a 10 días hábiles; LinkedIn sigue con la secuencia de Dripify |
| 8 | ¿Cuántos perfiles de LinkedIn por cliente? | **Configurable:** varias cuentas de Dripify (cada una con su API key) para sumar volumen. Ver §6.1 |

Las decisiones 9 a 14 se tomaron el 09/11/2026 sin pasar por BairesQA: las define Biguá y después
se ajustan a cada cliente (decisión 14). El detalle de cada una está en §6.2.

| # | Pregunta | Decisión |
|---|---|---|
| 9 | ¿Dónde quedan los ajustes de la etapa B? | `llamado_accion` pasa a la **campaña**, con un valor por defecto según el tipo. `prueba_social` queda en **Empresa** como biblioteca y cada campaña elige qué casos cita (si no elige, todos). `responsable_positivos` y `link_agenda` quedan en **Empresa** y la campaña puede cambiarlos |
| 10 | ¿Cómo se parten `oferta` y `excluir` al migrar? | La `oferta` de hoy se copia entera a la **propuesta** de la campaña «principal» y también a la nueva **descripción** de Empresa, con un aviso en Resumen para recortarla. `excluir` queda entero en **Empresa** (exclusiones de siempre); las exclusiones propias de la «principal» arrancan vacías |
| 11 | ¿Qué firma gana? | **Buzón > Empresa.** La campaña no tiene firma: si necesita otra, usa otro buzón |
| 12 | ¿Peso o cuentas por día? | **Sólo cuentas por día**, por campaña. Se elimina el peso. La suma de las activas no puede pasar el tope del cliente; si un día los buzones no dan, el orquestador recorta en proporción. El presupuesto de ASCI se reparte con la misma proporción |
| 13 | ¿Qué edita el cliente en una campaña? | Lo ve todo. **En los dos modos** edita el contenido; **en autogestionado**, además, el estado, las fechas, el volumen, los buzones y el ritmo. **Siempre Biguá:** la señal, la calibración, la campaña y los perfiles de Dripify. Detalle en §6.2 |
| 14 | ¿Se espera a BairesQA para arrancar C? | **No.** C arranca con estas definiciones y se parte en dos entregas: **C1**, campañas con un solo perfil de LinkedIn; **C2**, varios perfiles (§6.1). BairesQA se adecúa después, sobre la «principal» migrada |

### 6.1 Lo que suma tener varios perfiles de LinkedIn

Una cuenta de Dripify es un perfil de LinkedIn, y LinkedIn limita invitaciones por perfil: dos
perfiles duplican el techo. No cambia el modelo, pero toca más piezas que una sola cuenta:

| Qué | Cambio |
|---|---|
| Datos | `sdr.dripify_cuenta` deja de tener una fila por cliente: gana `id` y el perfil (nombre, URL). `dripify_carga`, `dripify_envio`, `dripify_evento`, `linkedin_respuesta` y `dripify_uso` llevan la cuenta |
| Campaña | Elige qué perfiles usa y, para cada uno, su campaña de Dripify (con la decisión 2: una campaña del SDR con dos perfiles son dos campañas de Dripify) |
| Reparto | El prospector reparte a las personas del día entre los perfiles de la campaña |
| Persona atada a su perfil | La persona queda con el perfil que la invitó: respuestas, `dripify_responder` y los frenos (`dripify_frenar`, freno cruzado) van por esa cuenta. Nunca se invita a la misma persona desde dos perfiles (el gateway lo rechaza) |
| Webhook | Una URL por cuenta (cada una con su secreto), para saber de qué perfil viene el evento |
| Cupo de la API | Por cuenta (50 por minuto y 4500 por día cada una) |
| Lectura de conversaciones | El reloj recorre cada cuenta |
| Textos | La nota y los mensajes hablan en nombre de la persona del perfil: el bot recibe el nombre del perfil con cada persona |
| Riesgo | Cada perfil tiene que ser de una persona real del cliente que acepte que se use; un perfil restringido por LinkedIn no frena a los demás |

Es trabajo de la etapa C (entrega C2, decisión 14), no un proyecto aparte.

### 6.2 Detalle de las decisiones 9 a 14

**Qué vive dónde.** Esta tabla reemplaza la columna «Nivel propuesto» de §2.1 donde no coinciden:

| Nivel | Campos |
|---|---|
| **Empresa** | `nombre_comercial`, `descripcion` (nueva: qué hace la empresa), zona horaria, `tono`, `idioma`, `firma` (por defecto), `excluir` (de siempre), no contactar, `prueba_social` (biblioteca), `objeciones` (generales), `responsable_positivos`, `link_agenda`, `acepta_mails_extrapolados` (el valor por defecto) |
| **Campaña** | Tipo, estado, `inicio`/`fin`, `propuesta`, `icp`, `roles_objetivo`, `excluir` (propias), `senal_avisos`, `dias_aviso`, `llamado_accion`, `links_permitidos`, cadencia, personas por cuenta, `positivos`, `objeciones` (propias), `prueba_social` (cuáles de la biblioteca), buzones, Dripify, `cuentas_por_dia`, `calibracion_mails`, `acepta_mails_extrapolados` |
| **La campaña puede cambiar lo de Empresa** | `tono`, `idioma`, `acepta_mails_extrapolados`, `responsable_positivos`, `link_agenda`. Nada más: lo demás se suma (exclusiones, objeciones) o es sólo de un nivel |
| **Buzón** | `firma` (gana a la de Empresa) |
| **Se va** | `ajustes.buzones` (texto libre): lo reemplaza la selección de buzones de la campaña |

Las listas que existen en los dos niveles (`excluir`, `objeciones`) **se suman**: el bot ve las de
Empresa y las de la campaña juntas.

**En el código.** `gateway/src/sdr/ajustes.mjs` tiene los dos esquemas:

- `CAMPOS_EMPRESA` y `CAMPOS_CAMPANA`, con sus bloques.
- `COLUMNAS_CAMPANA`: nombre, tipo, estado, fechas, buzones, volumen, Dripify y calibración.
- Los permisos de la decisión 13 y los estados.
- El control del tope (`aplicarColumnasCampana`).
- Lo que falta para activar (`faltantesParaActivar`).
- Lo que leen los bots (`ajustesEfectivos`).

Mientras dure la transición conserva también el formulario de hoy (`CAMPOS`).

**Valores por defecto de `llamado_accion` según el tipo.** Prospección: «una charla corta para ver
si tiene sentido»; Evento: «inscribirse con el link»; Reactivación: «¿sigue vigente el tema?».
Para la «principal» se copia el `llamado_accion` que el cliente tenga hoy.

**Volumen (12).**

- Se guarda en la campaña o se activa sólo si la suma de las `cuentas_por_dia` de las activas no
  pasa el `tope_cuentas_dia` del cliente. Para activar una segunda campaña el tope tiene que
  estar cargado (Administración → Operación).
- El orquestador pide a cada campaña lo suyo. Si el cupo de los buzones asignados no alcanza ese
  día, recorta cada campaña en proporción a lo que pidió y lo anota en la bitácora.
- Los reveals de ASCI del día se reparten con la misma proporción.

**Permisos (13).** El cliente ve todos los campos de la campaña; los que no puede tocar se ven en
sólo lectura, con candado.

| Quién | Qué edita en la campaña |
|---|---|
| **Cliente, en los dos modos** | Nombre, propuesta, ICP, cargos, exclusiones propias, qué le pedimos al prospecto, links permitidos (sólo `https`, hasta 3), positivos, objeciones propias, qué casos cita, lo que puede cambiar de Empresa (tono, idioma, responsable, link de agenda). En modo operado por Biguá, la campaña nueva queda en borrador |
| **Cliente, en autogestionado** | Además: activar, pausar y terminar; inicio y fin; `cuentas_por_dia` (dentro del tope); buzones; `dias_aviso`; extrapolados; cadencia (desde la etapa D) |
| **Sólo Biguá** | Tipo (una vez activa, no cambia), `senal_avisos`, `calibracion_mails`, campaña y perfiles de Dripify, «Avanzado» |

Una campaña **terminada** no se reactiva. Para repetirla se usa **Duplicar**, que crea un borrador
con la misma configuración. Así los números de cada campaña no se mezclan.

**Migración de la «principal» (10).** Va en dos migraciones, para que la base pueda cambiar
antes que el código sin romper nada:

- **`012` (hecha):** pasos 1, 2, 4 y 5. Las claves se **copian** y Empresa no cambia.
- **`014`** (era la `013`; ese número lo tomó la del buzón nuevo, §7.2): paso 3 y el borrado de Empresa de las claves que pasaron a la campaña, salvo
  `acepta_mails_extrapolados`, que queda en Empresa como valor por defecto. Se aplica cuando el
  gateway, el panel y las reglas ya lean la campaña.

Por cliente:

1. Se crea `sdr.campana` con `clave = 'principal'`, `nombre = 'Principal'`, tipo prospección y
   estado `activa` si el cliente tiene bots activos (si no, `pausada`).
2. Pasan a la campaña: `icp`, `roles_objetivo`, `senal_avisos`, `dias_aviso`, `llamado_accion`,
   `positivos`, `cuentas_por_dia`, `acepta_mails_extrapolados`, y `oferta` como `propuesta`. Los
   buzones se cargan con todos los del cliente (el estado de cada uno sigue mandando); el id de Dripify, con el que tiene hoy.
3. En Empresa: `descripcion` arranca con una copia de `oferta` (y aparece «Revisar la descripción
   de la empresa» en Resumen hasta que alguien la guarde); `excluir`, `objeciones` y
   `prueba_social` quedan como están; `ajustes.buzones` se borra, y su texto queda en el historial.
4. La calibración de la «principal» arranca con la que el cliente ya lleva: si ya terminó, queda
   terminada.
5. Todas las filas que ya existen de `cuenta`, `prospecto`, `evento`, `pedido`, `aprobacion` y
   `dripify_carga` quedan con el `campana_id` de la «principal».

## 7. Por etapas

Cada etapa se puede usar sola; la A no toca la base ni las reglas.

| Etapa | Qué | Toca |
|---|---|---|
| **A · Reordenar** (hecha) | Barra nueva (Resumen, Empresa, Canales, Actividad, ⚙; Campañas aparece en C y, mientras tanto, «A quién y con qué» vive como un bloque de Empresa). Canales junta Buzones, Dominios y Dripify. Administración junta Usuarios, Tokens, lo técnico y los despertadores. El formulario de ajustes de hoy partido en bloques (Empresa / A quién y con qué / Operación) con candados en vez de sufijos. Resumen con lo que ya hay (aprobaciones, calibración, estado de buzones y Dripify) | Sólo `gateway/src/admin/static/` y un endpoint de resumen |
| **B · Ajustes nuevos** (hecha) | Lista de no contactar (con el gateway haciéndola cumplir), firma por buzón, link de agenda, a quién avisar un positivo, prueba social, llamado a la acción. Las reglas los leen | `ajustes.mjs`, una tabla de supresión del cliente, `playbooks/` |
| **C · Campañas** (C1 y C2) | Tabla `sdr.campana`, la «principal» migrada (§6.2), tipo Prospección, buzones y Dripify por campaña, `campana` en las herramientas MCP, reparto en el orquestador, calibración por campaña, resumen por campaña | Base, gateway, MCP, `playbooks/`, panel |
| **D · Más tipos** | Invitación a evento y Reactivación, cadencia configurable | `playbooks/` (tareas nuevas), panel |
| **E · Canales nuevos** | CRM (HubSpot), WhatsApp de seguimiento | Según `11` y §5 |

A y B se entregaron juntas. C arranca ya, sin la revisión con BairesQA (decisión 14), en dos
entregas: **C1**, todo lo de la fila C con un perfil de LinkedIn por cliente, y **C2**, varios
perfiles (§6.1). D, cuando haya una campaña de evento o de reactivación que lo pida.

### 7.1 Lo que quedó construido en A y B

- **Panel:** Resumen, Empresa (ajustes en cuatro bloques, vista previa, no contactar e historial),
  Canales (correo con firma por buzón y dominios, LinkedIn · Dripify, WhatsApp y CRM como
  próximamente), Actividad y ⚙ Administración (operación, bots y despertadores, usuarios, tokens).
  Las direcciones de las pestañas viejas llevan a su lugar nuevo.
- **No contactar** (`sdr.no_contactar`): dominios con sus subdominios y mails, de a uno, pegados o
  por CSV. El gateway la hace cumplir al guardar una cuenta (queda `excluida`) o una persona, al
  enviar o responder un mail y al cargar en Dripify (error `no_contactar`).
- **Firma por buzón** (`mailgw.account.firma`): los bots la ven en `buzones` y en «Buzones y firmas».
- **Ajustes nuevos:** qué le pedimos al prospecto, casos y datos que se pueden citar, quién toma a
  los interesados y link de agenda. Las reglas (`comun`, `prospector/diaria`,
  `seguimiento/respuestas`) los usan.
- **Modo de operación** (`sdr.cliente_config.modo` y `tope_cuentas_dia`): en autogestionado el
  cliente cambia volumen, buzones, extrapolados y antigüedad del aviso, con las cuentas por día
  hasta el tope. La activación de campañas por el cliente llega con la etapa C.

### 7.2 C1: lo hecho y lo que falta (en pausa desde el 09/11/2026)

C1 quedó en pausa el 09/11/2026 para resolver los hallazgos abiertos de Vercel Security Review;
las correcciones entraron con el PR #6 y las reglas, en canario (`2026.11.09-2`). Este es el
punto donde se retoma.

**Hecho** (PR `ignaciocuffia86/sdrbot#6`):

- **Decisiones** 9 a 14 (§6 y §6.2).
- **Migración `012_campanas`.** Tablas `sdr.campana` y `sdr.campana_buzon`; la «principal» de
  cada cliente; `campana_id` en el registro, con un disparador que lo completa mientras el código
  no lo mande. **Aplicada en producción el 09/11/2026**, antes del merge del PR #6.
- **`ajustes.mjs` partido** en Empresa y campaña. El formulario de hoy sigue igual.
- **API de campañas del panel** (`src/sdr/campanas.mjs`).
- **Pestaña Campañas.** Sólo la ve Biguá, con aviso de transición
  (`CAMPANAS_PARA_CLIENTES = false` en `static/app.js`).

**Falta, en este orden:**

1. ~~**Las herramientas MCP con `campana`.**~~ Hecho (`src/sdr/en_campana.mjs`, migración
   `013`).
   - **Parámetro:** `registro_guardar_cuenta`, `registro_guardar_prospecto`, `registro_pedir` y
     `registro_pedir_aprobacion` reciben `campana`, la clave. Es opcional: sin ella vale la campaña
     del prospecto, la de su cuenta o la «principal», así que los bots de hoy siguen igual.
   - **Personas y cuentas:**
     - Una persona está en una sola campaña. Se la pasa a otra sólo si la suya no está activa o si
       todavía no está en contacto (investigada, descartada, sin respuesta).
     - Una cuenta en contacto por una campaña de prospección activa no entra en otra de
       prospección (error `en_otra_campana`).
     - Una campaña que no está activa no toma cuentas ni personas nuevas.
   - **Mails nuevos (`enviar` con `prospecto_id`):**
     - La campaña tiene que estar activa (error `campana_inactiva`).
     - El buzón tiene que ser de la campaña (error `buzon_fuera_de_campana`).
     - Los links, en el mail y en la respuesta, tienen que ser de los permitidos: los
       `links_permitidos` de la campaña, el link de agenda y los dominios de las firmas (error
       `link_no_permitido`).
     - Las respuestas salen del buzón que recibió, aunque la campaña esté en pausa.
   - **LinkedIn:** `dripify_cargar` carga en la campaña de Dripify de la campaña (o en la de la
     cuenta) y no mezcla campañas en una carga.
   - **Aprobaciones y calibración:** las aprobaciones quedan en la campaña de la persona, y la
     calibración se cuenta por campaña. La «principal» sigue con el número de Administración.
   - **Clientes sin el SDR** (sólo el gateway de correo): no tienen campañas ni estos controles.
2. ~~**Las reglas leen la campaña** (`playbooks/` y `reglas_manual`).~~ Hecho (PR #9) y
   publicado en canario como `2026.11.10-1`. Estable sigue en `2026.11.05-6` hasta pasar a
   BairesQA a las reglas nuevas.
   - `reglas_manual` arma, al final del índice, «Ajustes de este cliente: Empresa»
     (`ajustes-cliente`), «Campañas de este cliente» (`campanas`: clave, id, estado, cuentas por
     día, calibración y buzones de cada una) y una «Campaña: <nombre>» (`campana-<clave>`) por
     campaña activa, pausada o terminada. Los borradores no aparecen.
   - **Transición de la «principal»:** mientras Empresa tenga sus claves (hasta la `014`), la
     principal las toma de ahí, que es lo que edita el formulario de Empresa (`oferta` es su
     `propuesta`, y `cuentas_por_dia` de Empresa, sus cuentas por día). Lo calcula
     `en_campana.efectivos`, el mismo para las reglas, para los links que permite el gateway y
     para la pestaña Campañas. Cuando la `014` saque esas claves, vale lo de la campaña sin
     tocar el código.
   - El orquestador hace un pedido por campaña activa, con sus cuentas por día (decisión 12).
   - El prospector trabaja cada pedido con la campaña del pedido, guarda con `campana` y carga
     LinkedIn de a una campaña por vez.
   - `seguimiento` lee la sección de la campaña del prospecto.
   - Las cuentas por día de la principal son una sola: su columna. El formulario de Empresa, al
     guardar `cuentas_por_dia`, la actualiza y controla la suma de las activas contra el tope.
3. ~~**`registro_resumen` por campaña**, y las campañas activas en la pestaña Resumen (§3.1).~~
   Hecho.
   - `registro_resumen` trae los números del cliente y `por_campana` (eventos, prospectos por
     estado y calibración de cada campaña que no es borrador); con `campana`, sólo los de esa
     campaña. La calibración del cliente es la de su principal. Las corridas son del cliente.
   - El panel muestra en Resumen la tabla «Campañas · últimos 7 días» (activas y en pausa), por
     ahora sólo a Biguá, como la pestaña Campañas.
   - El orquestador cuenta los números por campaña en el resumen del día.
4. ~~**Migración `014`** (§6.2, paso 3).~~ Escrita (`014_empresa_sin_claves_de_campana.sql`); se
   aplica en el paso 6. Por cliente (`sdr.migrar_empresa_014`, idempotente):
   - la «principal» toma los valores de Empresa de hoy (Empresa gana: es lo que se siguió
     editando después de la `012`), `oferta` como `propuesta` y las cuentas por día en su
     columna; deja su copia de `acepta_mails_extrapolados`, que hereda de Empresa;
   - Empresa estrena `descripcion` (copia de `oferta`) y pierde esas claves, `cuentas_por_dia` y
     `buzones`. Antes, una foto «Antes de la migración 014» en el historial;
   - `sdr.cliente_config.formulario` pasa a `empresa`: el panel muestra `CAMPOS_EMPRESA`. Los
     clientes nuevos siguen en `transicion` hasta el paso 5.
   - El Resumen pide «Revisar la descripción de la empresa» mientras sea igual a la propuesta de
     la principal.
   - Las reglas de antes de las campañas (las estables de hoy) siguen recibiendo todo en
     «Ajustes de este cliente», con lo de la principal y sus nombres de antes.
   - Vuelta atrás: Biguá restaura la versión «Antes de la migración 014»; Empresa recupera las
     claves y el panel vuelve al formulario de la transición.
   - El historial de Empresa ya no muestra ni restaura versiones de una campaña.
5. **Abrir la pestaña a los clientes** (`CAMPANAS_PARA_CLIENTES = true`) y sacar el aviso de
   transición.
6. **Aplicar la `014` en producción**, después de publicar las reglas que leen la campaña y de
   abrir la pestaña (paso 5): con la `014`, el formulario de Empresa ya no edita lo de la
   campaña, y hasta el paso 5 un cliente no tiene dónde editarlo.

**Pendientes chicos, vistos al construir:**

- ~~Un buzón dado de alta después de la `012` no entraba en ninguna campaña.~~ La migración `013`
  lo suma solo a la «principal»; de las demás campañas lo saca o lo suma el panel.
- Volver una campaña a una versión anterior del historial, como en Empresa.

**Después de C1:** C2, con varios perfiles de LinkedIn (§6.1), y D, con los tipos Evento y
Reactivación y la cadencia configurable.
