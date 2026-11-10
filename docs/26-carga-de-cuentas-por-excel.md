# Carga de cuentas y contactos por Excel

Estado: **diseño, 10/11/2026.** Sale de la reunión con Alberto Veloso (09/11): trabaja con un Excel
de empresas exportadoras (la base que le dio el SAC), una lista de referidos y sus tres clientes
(Copefruit, Agrosuper, Ortiz). Hoy esa información no tiene cómo entrar al SDR. Complementa a
`21` §4.2 (el tipo «Cuentas objetivo» que quedó para más adelante), a `11` §3 (el registro) y a
`27` (la campaña por ICP, que usa esta carga como semilla).

## 1. El problema

| Hoy | Falta |
|---|---|
| Las cuentas entran al registro solo por el `prospector`, una por una, con `registro_guardar_cuenta` | Cargar de una vez cientos de empresas que el cliente ya tiene identificadas |
| «No contactar» acepta un CSV pegado, pero solo dominios y mails (`no_contactar.mjs`, tope 5.000) | Que una empresa sea «no la toques vos, la llevo yo» **con nombre y motivo**, sin dominio a mano |
| Los referidos y la gente conocida del cliente no existen para el bot | Separar lo que va **manual** (referido, conocido, cliente actual) de lo que se automatiza |
| La campaña de prospección necesita una señal de avisos (`18`) | Una campaña que trabaje **una lista dada**, sin señal |

## 2. Qué resuelve

Un archivo (Excel o CSV) que el cliente o un operador sube en el panel y que hace, por fila, una
de cuatro cosas:

| Uso de la fila | Qué queda en el registro | Qué hace el SDR con ella |
|---|---|---|
| **`prospectar`** | Cuenta `en_investigacion` en la campaña elegida, con los contactos que traiga la fila | El `prospector` la toma como candidata (salteando la búsqueda en ASCI), completa a quien decide si falta y escribe |
| **`semilla`** | Cuenta `excluida` con motivo «semilla del ICP» (no se le escribe) | Sirve de modelo para buscar empresas parecidas (`27` §3) |
| **`manual`** | Cuenta `excluida` con motivo «la lleva el cliente: <motivo>» (referido, conocido, cliente) | Nadie del SDR le escribe, ni a ninguna persona de esa empresa. Si responde alguien de ahí, va a `seguimiento` como siempre |
| **`no_contactar`** | Lo mismo que la lista de hoy, con dominio o mail | El gateway lo hace cumplir como ya lo hace |

`manual` y `no_contactar` se diferencian en el motivo y en lo que ve el cliente: «la lleva Alberto»
no es lo mismo que «no quiere saber nada». Las dos cierran la cuenta para el bot.

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
| Rubro / vertical | No | `cuenta.vertical` | Texto libre del cliente; sirve como pista para `27` |
| Tamaño | No | `cuenta.tamano` | Texto («200-500», «grande») |
| RUT / identificador fiscal | No | `cuenta.datos_origen.rut` | No se usa para buscar; queda para el cliente |
| Uso | No | §2 | `prospectar`, `semilla`, `manual`, `no_contactar`. Si falta, el uso por defecto de la carga |
| Motivo | No | `estado_motivo` | Para `manual` y `no_contactar` («referido de Juan», «cliente») |
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
4. Sin cuenta en ASCI y sin dominio: entra igual con su nombre. El `prospector` la va a tener que
   completar (buscar el dominio en `buscar_contactos` con `empresa`, que también resuelve en Apollo)
   antes de escribirle. Una `manual` o `no_contactar` sin dominio cierra igual la empresa por
   **nombre normalizado** (§4.3).

### 4.3 Choques con lo que ya hay

| Caso | Qué pasa |
|---|---|
| La cuenta ya está en el registro, `en_investigacion` | `prospectar`: se le suman los contactos nuevos y la nota; queda en su campaña. `manual`/`no_contactar`: pasa a `excluida` |
| Ya está `en_contacto` o `en_pausa` | `prospectar`: no se toca (se informa). `manual`: pasa a `excluida`, **se frena** lo pendiente (mails de la secuencia y Dripify, como una baja de la cuenta) y se avisa al orquestador |
| Ya está `excluida` o `descartada` | No se toca; se informa |
| Está en «No contactar» | `prospectar` y `semilla` quedan `excluida`, como hoy en `guardarCuenta` |
| Una persona ya existe (mismo mail o LinkedIn) en otra cuenta o campaña | No se mueve (regla «una persona, una campaña», `21` §4.3); se informa |
| Dos filas de la misma empresa | Una cuenta; cada fila con contacto suma una persona |
| Filas `manual` sin dominio | Se guarda el nombre normalizado en la exclusión; `registro_guardar_cuenta` compara también por nombre normalizado y rechaza la cuenta con `no_contactar` si coincide |

### 4.4 Los contactos del archivo

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
| Señal en el primer mail | El aviso, con fecha | La **nota para el bot** de la fila, o la propuesta de la campaña (`27` §5 para el ángulo sin señal) |
| A quién | Publicante + decisor | Los contactos de la fila; si no hay, el decisor por `tomadores_de_decision` o `buscar_contactos` con los cargos de la campaña |
| Obligatorio para activar | ICP, cargos | Propuesta, cargos, al menos un lote cargado |
| Cuando se acaba la lista | — | El orquestador avisa al operador y deja de pedir cuentas a esa campaña |

### 5.2 Reglas (`playbooks/`)

- `prospector/lista.md`, tarea nueva: tomar del registro las cuentas de la campaña en
  `en_investigacion` (herramienta `registro_cuentas_de_lista`, §6.2), completar dominio y decisor,
  escribir con la nota del cliente como motivo, el resto igual que `diaria`.
- `orquestador`: una campaña `lista` recibe pedidos como las demás, con su `cuentas_por_dia`, sin
  señal que mirar; si `registro_cuentas_de_lista` devuelve cero, no pide y avisa.
- `comun.md`: las cuentas con motivo «la lleva el cliente» son del cliente, no del SDR: no se les
  escribe ni se les revela gente, aunque aparezcan en otra búsqueda.

## 6. Cambios técnicos

### 6.1 Base (migración `017_carga_de_cuentas.sql`)

```sql
create table sdr.lote_carga (
  id           uuid primary key default gen_random_uuid(),
  client_id    text not null references mailgw.client on delete cascade,
  campana_id   uuid,                         -- destino de las filas «prospectar»
  archivo      text not null,                -- nombre original, sin la ruta
  uso_defecto  text not null check (uso_defecto in ('prospectar','semilla','manual','no_contactar')),
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
  add column uso          text check (uso in ('prospectar','semilla','manual','no_contactar')),
  add column nombre_norm  text,              -- para cerrar empresas sin dominio
  add column datos_origen jsonb not null default '{}'::jsonb,
  add column prioridad    int;
create index cuenta_nombre_norm on sdr.cuenta (client_id, nombre_norm) where nombre_norm is not null;
create index cuenta_lista on sdr.cuenta (client_id, campana_id, prioridad) where origen = 'archivo' and estado = 'en_investigacion';

alter table sdr.prospecto add column lote_id uuid references sdr.lote_carga on delete set null;
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
| `store.mjs` · `guardarCuenta` | Comparar también por `nombre_norm` contra las cuentas `manual`/`no_contactar` |
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
2. Choques de §4.3, uno por caso, incluido «`manual` sobre una cuenta en contacto frena la secuencia
   y Dripify».
3. Aislamiento: un usuario de un cliente no ve ni deshace lotes de otro (`aislamiento.test.mjs`).
4. `guardarCuenta` rechaza por nombre normalizado una cuenta `manual` sin dominio.
5. De punta a punta en BairesQA (canario): subir 20 filas mezcladas, campaña `lista` en
   calibración, el `prospector` toma 4, pide aprobación con la nota del cliente como motivo.

## 8. Decisiones abiertas

| # | Pregunta | Propuesta |
|---|---|---|
| 1 | ¿El mail del cliente cuenta como verificado? | No: `desconocido`, y la campaña decide si lo usa (`acepta_mails_del_cliente`, sí por defecto) |
| 2 | ¿Se puede cargar una lista a una campaña de señal, no solo a una `lista`? | No en la primera entrega: una cuenta cargada `prospectar` va a una campaña `lista`. Las de señal la ven solo como exclusión si está `manual` |
| 3 | ¿Teléfonos del archivo para WhatsApp de primer contacto? | No: WhatsApp sigue siendo solo de seguimiento (`22`). El teléfono queda guardado |
| 4 | ¿Quién sube la base del SAC de Alberto? | Biguá en el kickoff, con él en la llamada, para revisar juntos el mapeo y la vista previa |
| 5 | ¿Actualizar una carga (subir el Excel de nuevo con cambios)? | Primera entrega: cada subida es un lote nuevo; las cuentas que ya están se informan y no se pisan, salvo `manual`, que siempre gana |

## 9. Etapas

| Etapa | Qué | Sale cuando |
|---|---|---|
| **1** | Migración, `carga.mjs`, panel con previa y aplicación, usos `manual`, `no_contactar` y `semilla`, cierre por nombre | La lista de referidos y clientes de Alberto queda cargada y el bot no la toca |
| **2** | Tipo de campaña `lista`, `registro_cuentas_de_lista`, `prospector/lista.md` | El `prospector` escribe a 4 cuentas de la base del SAC con aprobación |
| **3** | Deshacer, informe descargable, mapeo guardado, `cargas_listar` en el MCP del panel | El cliente sube su archivo solo |

La etapa 1 es lo que hace falta antes del kickoff con Alberto; la 2, antes de que salga su primer
mail.
