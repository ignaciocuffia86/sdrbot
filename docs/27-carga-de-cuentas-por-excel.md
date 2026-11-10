# Carga de cuentas y contactos por Excel

Estado: **etapas 1, 2 y 3 construidas, 10/11/2026** (ver §0: lo que cambió respecto del diseño
original). Migraciones `019`, `020` y `021` aplicadas en producción el 10/11/2026, después de la `018`
de la derivación. Sale de la reunión con Alberto Veloso (09/11): trabaja con un Excel
de empresas exportadoras (la base que le dio el SAC), una lista de referidos y sus tres clientes
(Copefruit, Agrosuper, Ortiz). Hoy esa información no tiene cómo entrar al SDR. Complementa a
`21` §4.2 (el tipo «Cuentas objetivo» que quedó para más adelante), a `11` §3 (el registro) y a
`28` (la campaña por ICP, que usa esta carga como semilla).

## 0. Lo construido en la etapa 1, y lo que cambió del diseño

Al construir la etapa 1 se tomaron estas decisiones, que mandan sobre lo que dicen las secciones de
abajo:

| Tema | Diseño original | Cómo quedó |
|---|---|---|
| Dónde se sube | Una pestaña «Cuentas cargadas» con una columna «Uso» que mezclaba los tres usos | **Dos entradas con el mismo lector:** las cuentas son **de una campaña** (vista de la campaña → «Semillas del ICP» → Subir Excel o CSV) y las exclusiones son **de la empresa** (Empresa → No contactar → Subir Excel o CSV). No hay columna «Uso»: el destino lo da dónde se sube |
| Usos de la etapa 1 | `prospectar`, `semilla`, `no_contactar` | `semilla` (en la campaña) y `no_contactar` (en la empresa). `prospectar` llega con la campaña de tipo `lista` (etapa 2); la migración ya deja las columnas listas |
| Resolución sin dominio (§4.2) | El gateway llama a `resolver_cuentas` de ASCI | **Sin ASCI en la etapa 1**: el gateway no tiene cliente de ASCI. Una fila sin sitio web entra por su nombre; para prospectar, el `prospector` la completará con `resolver_cuentas` (etapa 2) |
| Comparar por nombre | «Nombre normalizado» | Una clave que calcula la base, `sdr.empresa_clave(nombre)`: minúsculas, sin tildes ni puntuación y sin la forma societaria del final («Agrícola Ortiz y Cía. Ltda.» → `agricola ortiz`). `sdr.cuenta.nombre_clave` es una columna generada con esa clave, así el registro, la carga y los controles dicen lo mismo |
| Subida del archivo | Multipart de hasta 5 MB, previa guardada 30 minutos | El gateway sólo recibe JSON: el archivo va **en base64**, hasta **3 MB** (las rutas de carga aceptan cuerpos de 4,4 MB; Vercel corta en 4,5). **No se guarda nada entre la vista previa y la confirmación:** el panel vuelve a mandar el archivo con la **huella** de la vista previa (archivo, hoja, destino y mapeo); si algo cambió, responde `carga_cambio` (409) y hay que volver a verla |
| Lector de `.xlsx` | Una dependencia (`read-excel-file`) | **Lector propio** (`sdr/carga.mjs`): abre el zip con `zlib` de Node y recorre los XML con búsquedas hacia adelante, en tiempo lineal (sin expresiones regulares sobre el documento: Vercel 01M7360X214QQ68W26K5AYZAE5). Una etiqueta sin cerrar o enorme se rechaza; hay topes de bytes descomprimidos reales (20 MB), de filas, columnas, textos compartidos y un plazo de 4 s. Sólo valores: de una fórmula queda su último valor como texto; no se evalúa nada, ni macros ni vínculos |
| Freno de §4.4 | Propuesta | **Construido** para cualquier alta en la lista (a mano, CSV pegado o archivo): las cuentas en investigación de esa empresa quedan `excluidas` con su motivo y las personas cargadas en Dripify se marcan para frenar en la próxima vuelta del reloj (`frenarPendientes`, como una baja). Si el alta la hizo el cliente y tocó algo en marcha, se le avisa al orquestador |
| Una semilla | Excluida | Excluida; el gateway no deja que el bot la reabra ni la mueva de campaña (`cuenta_semilla`), y los mismos controles de no contactar la frenan en todas las salidas: una persona nueva en ella o con un mail de su dominio, pasar a alguien a esa cuenta, un mail o una respuesta, Dripify y WhatsApp (error `no_contactar`, «semilla del ICP»; Vercel `01M73616907NW21T3B4WY6VAD3`) |
| Migración | `017_carga_de_cuentas.sql` | `019_carga_de_cuentas.sql` (la 017 y la 018 son de otras entregas: aprobaciones del cliente y derivación) |

**Piezas:** `db/migrations/019_carga_de_cuentas.sql`; `gateway/src/sdr/carga.mjs` (lectura, mapeo,
plan); `no_contactar.mjs` (empresas por nombre, coincidencias por cuenta y por nombre);
`store.mjs` (`aplicarNoContactar`, la protección de las semillas); `admin/servicio.mjs` y
`admin/api.mjs` (`POST …/no-contactar/cargas/previa`, `POST …/no-contactar/cargas`,
`POST …/sdr/campanas/:id/cargas/previa`, `POST …/sdr/campanas/:id/cargas`, `GET …/cargas`, auditoría
`admin.sdr.carga` con conteos); el panel (`static/app.js`); y `test/carga.test.mjs`.

### Etapa 2: la campaña «Lista del cliente»

| Tema | Cómo quedó |
|---|---|
| Tipo de campaña | `lista` en `TIPOS` (migración `020_campana_lista.sql`). No pide ICP ni señal; pide propuesta, cargos y **al menos una cuenta cargada** (`cuentas_de_lista`, que sale de los lotes aplicados). El tipo lo elige Biguá, como siempre |
| Qué se sube en una campaña | Una lista prospecta por defecto; la columna opcional **Uso** («semilla») marca una empresa modelo. Una campaña que no es lista sólo toma semillas: una fila `prospectar` ahí es un error de la fila (decisión 2) |
| Contactos del archivo | Una persona por fila (nombre, cargo, mail, teléfono, LinkedIn), con **mail o LinkedIn**; si no, la fila entra sin persona y el `prospector` busca a quien decide. El mail queda con calidad **`del_cliente`** (decisión 1: ni verificado ni deducido). Dos filas de la misma empresa son una cuenta con dos personas. No se carga una persona que ya está en el registro, en la supresión o en no contactar |
| Choques (§4.3) | Cuenta en investigación: suma los contactos y la nota, y queda en su campaña. En otro estado: no se toca. En no contactar: entra `excluida`, sin personas |
| `acepta_mails_del_cliente` | Ajuste de la campaña («Acepta los mails del archivo»), sí si no dice nada. Lo aplica el `prospector` (como los extrapolados), no el gateway |
| `registro_cuentas_de_lista(campana, limite)` | Las próximas cuentas **sin trabajar**, en el orden del archivo, con sus personas y lo del cliente en `datos_del_cliente`. Sin trabajar: en investigación y ninguna de sus personas avanzó (otro estado, próximo paso, Dripify o una aprobación), así una cuenta que espera su aprobación no se repite. `quedan` dice cuántas faltan; con 0, un aviso. Una campaña de otro tipo: `campana_no_es_lista` |
| Reglas | `prospector/lista.md` (tomar, completar dominio y decisor, escribir con la nota del cliente, descartar si no hay a quién); `prospector/diaria.md` deriva ahí; `orquestador/diaria.md` pide como a las demás y avisa cuando la lista se termina; `comun.md` suma `campana_no_es_lista`. La sección de cada campaña lista se lo dice al bot |
| Panel | En una campaña lista, la tarjeta «Cuentas de la lista» con cuántas quedan sin trabajar, en curso y cerradas (`GET …/sdr/campanas/:id/lista`), y la vista previa con el uso y el contacto de cada fila |

### Etapa 3: deshacer, informe, mapeo guardado y MCP

| Tema | Cómo quedó |
|---|---|
| Deshacer un lote | `sdr.deshacer_lote` en la base (migración `021_carga_etapa3.sql`), con el cliente fijado por el gateway: la aplicación no gana permiso de borrar. **Campaña:** borra las cuentas que creó el lote (con lo que cuelga de ellas) y las personas que sumó a cuentas que ya estaban; no se deshace (`carga_en_uso`, 409) si alguna de esas personas tuvo un toque, un próximo paso, Dripify o una aprobación, o una cuenta está en contacto o en pausa. **No contactar:** saca de la lista las filas del lote; lo que ya hicieron (cuentas excluidas, Dripify frenado) no vuelve atrás. El lote queda `deshecho`, con quién y cuándo, y deja de contar para activar una lista |
| Informe | Una fila por renglón del archivo con lo que pasó (y sus avisos), guardado con el lote y **borrado a los 30 días** (se vacía al listar las cargas). Se baja como CSV para Excel (punto y coma, UTF-8 con BOM); una celda que Excel tomaría como fórmula va con un apóstrofo adelante |
| Mapeo guardado | El lote guarda qué encabezado fue a cada campo (`mapeo_nombres`); la próxima carga del mismo destino propone ese mapeo si el archivo trae esos encabezados, y completa el resto por los nombres de siempre |
| Panel | La tabla de cargas (en la campaña y, plegada, en No contactar) con «Informe» y «Deshacer» |
| MCP del panel | `cargas_listar`, de lectura (docs/24): subir, deshacer y bajar el informe quedan en el panel |

## 1. El problema

| Hoy | Falta |
|---|---|
| Las cuentas entran al registro solo por el `prospector`, una por una, con `registro_guardar_cuenta` | Cargar de una vez cientos de empresas que el cliente ya tiene identificadas |
| «No contactar» (`21` §3.3, `no_contactar.mjs`) acepta un CSV pegado con dominio o mail y motivo, y el gateway la hace cumplir en el registro, el envío y Dripify | Cargar ahí **empresas sin dominio** (un referido escrito solo con su nombre) y hacerlo desde el mismo Excel |
| La campaña de prospección necesita una señal de avisos (`18`) | Una campaña que trabaje **una lista dada**, sin señal |

## 2. Qué resuelve

Un archivo (Excel o CSV) que el cliente o un operador sube en el panel y que hace, por fila, una
de tres cosas:

| Uso de la fila | Adónde va | Qué hace el SDR con ella |
|---|---|---|
| **`prospectar`** | Registro: cuenta `en_investigacion` en la campaña elegida, con los contactos que traiga la fila | El `prospector` la toma como candidata (salteando la búsqueda en ASCI), completa a quien decide si falta y escribe |
| **`semilla`** | Registro: cuenta `excluida` con motivo «semilla del ICP» | No se le escribe; sirve de modelo para buscar empresas parecidas (`28` §3) |
| **`no_contactar`** | **La lista de no contactar que ya existe** (`sdr.no_contactar`), con el motivo de la fila: «referido de Juan», «cliente», «no quiere saber nada» | Lo de hoy: el gateway rechaza cuentas, personas, mails y cargas en Dripify de esa empresa |

**Las exclusiones no son una pieza nueva.** Un referido, un conocido o un cliente actual es una fila
`no_contactar` con su motivo: para el bot es lo mismo que cualquier otra exclusión, y el cliente
lo distingue por el motivo en la pestaña «No contactar». El Excel es solo otra forma de cargar esa
lista, además del CSV pegado de hoy. Lo único que hay que sumarle a la lista es aceptar una empresa
**por nombre** cuando no tiene dominio (§4.2 y §6.1).

Una semilla queda en el registro y no en la lista porque tiene que llevar su perfil (rubro, tamaño,
`asci_id`) para que `28` la use; igual no recibe nada.

## 3. El archivo

### 3.1 Formato

- **`.xlsx` o `.csv`** (coma, punto y coma o tabulación, UTF-8 o Latin-1). Una hoja; si el Excel
  trae varias, se elige cuál.
- Hasta **2.000 filas** por carga (el doble alcanza para la base del SAC; si no, en dos cargas).
- Primera fila, encabezados. El panel propone el mapeo de columnas por nombre (`empresa`, `razón
  social`, `web`, `rut`, `contacto`, `cargo`, `mail`, `teléfono`, `linkedin`…) y el usuario lo
  corrige antes de seguir. El mapeo queda guardado para la próxima carga de ese cliente.

### 3.2 Columnas

| Columna | Obligatoria | Va a | Notas |
|---|---|---|---|
| Empresa | **Sí** | `cuenta.nombre` | Tal como la escribe el cliente |
| Sitio web o dominio | Recomendada | `cuenta.dominio` | Se normaliza como en «No contactar» (`https://www.x.cl/…` → `x.cl`). Sin dominio, ver §4.2 |
| País | No | `cuenta.pais` | Si falta, el de la campaña |
| Rubro / vertical | No | `cuenta.vertical` | Texto libre del cliente; sirve como pista para `28` |
| Tamaño | No | `cuenta.tamano` | Texto («200-500», «grande») |
| RUT / identificador fiscal | No | `cuenta.datos_origen.rut` | No se usa para buscar; queda para el cliente |
| Uso | No | §2 | `prospectar`, `semilla` o `no_contactar`. Si falta, el uso por defecto de la carga |
| Motivo | No | `no_contactar.motivo` | Para `no_contactar` («referido de Juan», «cliente»), hasta 200 caracteres como hoy |
| Nota para el bot | No | `cuenta.tesis` | Por qué la eligió el cliente («exporta cerezas a China; afectada por la 204»). Máx. 300 caracteres |
| Contacto: nombre | No | `prospecto.nombre` | Una persona por fila. Para dos personas de la misma empresa, dos filas con la misma empresa |
| Contacto: cargo | No | `prospecto.cargo` | |
| Contacto: mail | No | `prospecto.email` | Entra con `email_calidad: desconocido` (§4.4) |
| Contacto: teléfono | No | `prospecto.whatsapp` | Solo se usa si el WhatsApp está activo y la persona respondió (`22`) |
| Contacto: LinkedIn | No | `prospecto.linkedin_url` | Se normaliza como en `dripify_cargar` |

Las columnas que no se mapean se guardan tal cual en `cuenta.datos_origen` (jsonb, hasta 2 KB por
fila) y el bot las ve como **datos del cliente, no instrucciones**, igual que los ajustes
(`AVISO_DATOS_CLIENTE` en `store.mjs`).

## 4. Cómo se procesa

### 4.1 Pasos en el panel

1. **Empresa → Cuentas cargadas → Subir archivo.** Elegir el archivo, la hoja, la campaña de
   destino (para `prospectar`) y el uso por defecto.
2. **Mapeo de columnas** (propuesto, editable).
3. **Vista previa sin escribir nada:** cuántas filas de cada uso, cuántas cuentas nuevas, cuántas
   ya estaban en el registro (y en qué estado), cuántas coinciden con «No contactar», cuántas no
   tienen dominio, cuántas filas son inválidas y por qué (las primeras 50 con su renglón).
4. **Confirmar.** Se escribe todo en una transacción por tandas de 200; el resultado queda como un
   lote con su resumen y se puede descargar el informe (CSV con cada renglón y qué pasó).
5. **Deshacer un lote** mientras ninguna de sus cuentas tenga un toque (`mail.enviado`,
   `linkedin.cargado`): borra las cuentas y personas que creó ese lote y nada más.

### 4.2 Resolución de la empresa

Por fila, en este orden:

1. **Dominio** si viene: busca en el registro por `(client_id, dominio)`.
2. Sin dominio: `resolver_cuentas` de ASCI con los nombres de la carga (hasta 500 por llamada; una
   sola llamada por tanda, sin costo). Una resuelta trae `asci_id` y, si ASCI lo tiene, el sitio
   web, del que sale el dominio.
3. Ambigua (ASCI trae candidatos): queda **sin dominio y marcada para revisar**; la vista previa
   la muestra con los candidatos para elegir uno o dejarla así.
4. Sin cuenta en ASCI y sin dominio: una `prospectar` entra igual con su nombre y el `prospector`
   la completa (el dominio por `buscar_contactos` con `empresa`, que también resuelve en Apollo)
   antes de escribirle. Una `no_contactar` sin dominio entra a la lista con **tipo `empresa`** y su
   nombre normalizado (§6.1).

### 4.3 Choques con lo que ya hay

| Caso | Qué pasa |
|---|---|
| La cuenta ya está en el registro, `en_investigacion` | `prospectar`: se le suman los contactos nuevos y la nota; queda en su campaña. `no_contactar`: entra a la lista y la cuenta pasa a `excluida`, como cuando se carga a mano hoy |
| Ya está `en_contacto` o `en_pausa` | `prospectar`: no se toca (se informa). `no_contactar`: entra a la lista; ver el pendiente de §4.4 |
| Ya está `excluida` o `descartada` | No se toca; se informa |
| Ya está en «No contactar» | `prospectar` y `semilla` quedan `excluida`, como hoy en `guardarCuenta`; una `no_contactar` repetida no se toca (`on conflict do nothing`, como hoy) |
| Una persona ya existe (mismo mail o LinkedIn) en otra cuenta o campaña | No se mueve (regla «una persona, una campaña», `21` §4.3); se informa |
| Dos filas de la misma empresa | Una cuenta; cada fila con contacto suma una persona |

### 4.4 Pendiente de la lista de hoy, que la carga hace más visible

Cargar una empresa en «No contactar» hoy frena lo **nuevo** (el gateway rechaza el próximo mail, la
próxima persona y la próxima carga en Dripify), pero no lo que ya está en marcha: un prospecto que
ya está cargado en una campaña de Dripify sigue recibiendo la invitación y los dos mensajes. Con una
carga de cientos de exclusiones de una vez, el caso es más probable. Propuesta: al agregar a la
lista (a mano, por CSV o por el Excel), el gateway busca en el registro las cuentas y personas
activas que coinciden, pausa sus leads en Dripify (como hace con una baja) y le avisa al
orquestador. Es un arreglo de la lista, no de la carga: sirve igual para las altas de hoy.

### 4.5 Los contactos del archivo

- El mail del cliente entra como `desconocido`: el gateway **no lo trata como verificado**. El
  `prospector` puede usarlo para el primer mail solo si la campaña acepta mails no verificados
  (ajuste nuevo de la campaña, `acepta_mails_del_cliente`, sí por defecto: es la base del propio
  cliente). Un rebote lo baja como hoy.
- Una persona del archivo sin mail ni LinkedIn queda guardada pero no recibe nada hasta que el
  `prospector` la complete por ASCI.
- **No se revela a nadie al cargar.** El costo de Apollo lo decide el `prospector` en su corrida,
  con el tope del pedido.

## 5. Cómo lo usa el SDR

### 5.1 Campaña de tipo «Lista del cliente»

Un tipo nuevo de campaña (`lista`, en `TIPOS` de `ajustes.mjs`) que **no busca cuentas en ASCI**:
toma las cuentas `prospectar` de sus lotes, en el orden del archivo (o por prioridad, si el
archivo la trae).

| | Prospección por señal (hoy) | Lista del cliente (nueva) |
|---|---|---|
| De dónde salen las cuentas | `avisos_recientes` | Las cargadas por archivo en esa campaña |
| Señal en el primer mail | El aviso, con fecha | La **nota para el bot** de la fila, o la propuesta de la campaña (`28` §5 para el ángulo sin señal) |
| A quién | Publicante + decisor | Los contactos de la fila; si no hay, el decisor por `tomadores_de_decision` o `buscar_contactos` con los cargos de la campaña |
| Obligatorio para activar | ICP, cargos | Propuesta, cargos, al menos un lote cargado |
| Cuando se acaba la lista | — | El orquestador avisa al operador y deja de pedir cuentas a esa campaña |

### 5.2 Reglas (`playbooks/`)

- `prospector/lista.md`, tarea nueva: tomar del registro las cuentas de la campaña en
  `en_investigacion` (herramienta `registro_cuentas_de_lista`, §6.2), completar dominio y decisor,
  escribir con la nota del cliente como motivo, el resto igual que `diaria`.
- `orquestador`: una campaña `lista` recibe pedidos como las demás, con su `cuentas_por_dia`, sin
  señal que mirar; si `registro_cuentas_de_lista` devuelve cero, no pide y avisa.
- `comun.md` no cambia: las exclusiones del Excel son la lista de no contactar de siempre, y la
  sección «No contactar» de las reglas ya le dice al bot que no escriba ni revele a nadie de ahí.

## 6. Cambios técnicos

### 6.1 Base (migración `019_carga_de_cuentas.sql`; lo construido en §0)

```sql
create table sdr.lote_carga (
  id           uuid primary key default gen_random_uuid(),
  client_id    text not null references mailgw.client on delete cascade,
  campana_id   uuid,                         -- destino de las filas «prospectar»
  archivo      text not null,                -- nombre original, sin la ruta
  uso_defecto  text not null check (uso_defecto in ('prospectar','semilla','no_contactar')),
  mapeo        jsonb not null,               -- columna del archivo → campo
  resumen      jsonb not null default '{}',  -- conteos por uso y por resultado
  estado       text not null default 'aplicado' check (estado in ('aplicado','deshecho')),
  por_email    text not null,
  creado_at    timestamptz not null default now(),
  foreign key (campana_id, client_id) references sdr.campana (id, client_id)
);

alter table sdr.cuenta
  add column lote_id      uuid references sdr.lote_carga on delete set null,
  add column origen       text not null default 'bot' check (origen in ('bot','archivo')),
  add column uso          text check (uso in ('prospectar','semilla')),
  add column datos_origen jsonb not null default '{}'::jsonb,
  add column prioridad    int;
create index cuenta_lista on sdr.cuenta (client_id, campana_id, prioridad) where origen = 'archivo' and estado = 'en_investigacion';

alter table sdr.prospecto add column lote_id uuid references sdr.lote_carga on delete set null;

-- La lista de no contactar de siempre suma empresas por nombre (sin dominio) y recuerda de qué lote
-- vino cada fila, para poder deshacer una carga.
alter table sdr.no_contactar drop constraint if exists no_contactar_tipo_check;
alter table sdr.no_contactar add constraint no_contactar_tipo_check check (tipo in ('dominio', 'email', 'empresa'));
-- el check de «tipo email ⇔ tiene @» sigue valiendo; una 'empresa' guarda el nombre normalizado
alter table sdr.no_contactar add column lote_id uuid references sdr.lote_carga on delete set null;
-- email_calidad suma 'del_cliente' (o se reusa 'desconocido'; decidir en §8)
```

La política de filas de `mailgw_portal` se extiende a `sdr.lote_carga` igual que a las demás
tablas del cliente. El archivo **no se guarda**: solo el resumen y el informe por renglón (este, 30
días).

### 6.2 Gateway

| Pieza | Qué |
|---|---|
| `gateway/src/sdr/carga.mjs` (nuevo) | Leer el archivo (CSV con el lector de `no_contactar.mjs` extendido; `.xlsx` con una dependencia chica y sin macros, p. ej. `read-excel-file`, que no evalúa fórmulas), normalizar, resolver (§4.2), armar la vista previa y aplicar por tandas |
| `admin/servicio.mjs` y `api.mjs` | `POST /admin/api/clients/:c/cargas/previa` (multipart, hasta 5 MB), `POST …/cargas` (aplica la previa por su id, válida 30 min), `GET …/cargas`, `POST …/cargas/:id/deshacer`. Auditoría `admin.sdr.carga` con conteos, sin contenido |
| `admin/static/` | Pestaña «Cuentas cargadas» en Empresa: subir, mapear, vista previa, historial de lotes, deshacer |
| `no_contactar.mjs` | `coincidencias` compara además el nombre normalizado de la cuenta contra las filas de tipo `empresa`; `leerCsv` acepta un nombre de empresa en la primera columna cuando no es dominio ni mail. Lo usan `guardarCuenta`, el envío y Dripify, sin otros cambios. Más el arreglo de §4.4 al agregar |
| Pestaña «No contactar» | Muestra las filas de tipo `empresa` y de qué carga vinieron; el CSV pegado de hoy sigue igual |
| MCP del bot | `registro_cuentas_de_lista(campana, limite)`: las próximas cuentas de la lista sin trabajar, con sus contactos y su nota; `registro_buscar` devuelve `origen` y `uso` |
| MCP del panel (`24`) | `cargas_listar` de lectura; la subida queda en el panel (un archivo no pasa por el chat) |
| `ajustes.mjs` | Tipo `lista` en `TIPOS`, `acepta_mails_del_cliente` en la campaña, faltantes para activarla |

### 6.3 Seguridad

- El archivo es contenido del cliente: celdas que empiezan con `=`, `+`, `-` o `@` se guardan como
  texto (no se reexportan como fórmula en el informe), y todo lo que el bot lee de `datos_origen`
  y `tesis` va citado como dato del cliente, igual que los nombres de campaña (`citaNombre`).
- Tope de tamaño y de filas; el análisis corre en memoria y se descarta.
- Solo `client_admin` del cliente y los operadores de Biguá suben archivos.

## 7. Pruebas

1. `carga.test.mjs`: mapeo propuesto, normalización de dominios y LinkedIn, filas inválidas, celdas
   con fórmula, dos filas de la misma empresa, Latin-1.
2. Choques de §4.3, uno por caso. Y el arreglo de §4.4: agregar a la lista una empresa con un lead
   ya cargado en Dripify lo pausa.
3. Aislamiento: un usuario de un cliente no ve ni deshace lotes de otro (`aislamiento.test.mjs`).
4. Una fila `no_contactar` sin dominio entra como tipo `empresa`, y `guardarCuenta` excluye la cuenta
   de ese nombre aunque llegue después con dominio.
5. De punta a punta en BairesQA (canario): subir 20 filas mezcladas, campaña `lista` en
   calibración, el `prospector` toma 4, pide aprobación con la nota del cliente como motivo.

## 8. Decisiones abiertas

| # | Pregunta | Propuesta |
|---|---|---|
| 1 | ¿El mail del cliente cuenta como verificado? | No: `desconocido`, y la campaña decide si lo usa (`acepta_mails_del_cliente`, sí por defecto) |
| 2 | ¿Se puede cargar una lista a una campaña de señal, no solo a una `lista`? | No en la primera entrega: una cuenta cargada `prospectar` va a una campaña `lista`. Las demás la ven solo si está en no contactar |
| 3 | ¿Teléfonos del archivo para WhatsApp de primer contacto? | No: WhatsApp sigue siendo solo de seguimiento (`22`). El teléfono queda guardado |
| 4 | ¿Quién sube la base del SAC de Alberto? | Biguá en el kickoff, con él en la llamada, para revisar juntos el mapeo y la vista previa |
| 5 | ¿Actualizar una carga (subir el Excel de nuevo con cambios)? | Primera entrega: cada subida es un lote nuevo; las cuentas que ya están se informan y no se pisan, salvo una `no_contactar`, que siempre gana |

## 9. Etapas

| Etapa | Qué | Sale cuando |
|---|---|---|
| **1** (construida) | Migración, `carga.mjs`, panel con previa y aplicación, usos `no_contactar` (a la lista de siempre, con empresas por nombre) y `semilla`, y el arreglo de §4.4 | La lista de referidos y clientes de Alberto queda cargada y el bot no la toca |
| **2** (construida) | Tipo de campaña `lista`, `registro_cuentas_de_lista`, `prospector/lista.md` | El `prospector` escribe a 4 cuentas de la base del SAC con aprobación |
| **3** (construida) | Deshacer, informe descargable, mapeo guardado, `cargas_listar` en el MCP del panel | El cliente sube su archivo solo |

La etapa 1 es lo que hace falta antes del kickoff con Alberto; la 2, antes de que salga su primer
mail.
