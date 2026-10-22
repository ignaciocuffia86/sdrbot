# Rol `sdr_bot` en ASCI: especificación

Pedido a desarrollo de ASCI (repo `locasci`). Define el rol con el que el bot SDR de cada tenant consulta ASCI, qué tools ve, qué presupuesto tiene, cómo se da de alta y qué tools nuevas o cambios chicos conviene agregar. Está escrito contra el estado del repo al 22/10/2026 (migración 0291).

## 1. Por qué un rol nuevo

En ASCI los roles son datos: una fila en `ops.rol`, una fila por tool en `ops.permiso`, una fila en `ops.presupuesto_apollo`. Ninguno de los cinco roles actuales calza con un bot SDR:

| Rol | Por qué no sirve |
|---|---|
| `cliente` | `ve_todas_las_cuentas = false`: `presencia`, `evidencia` y `novedades` filtran por cartera (`ops.cuentas_visibles()`). Un SDR descubre cuentas nuevas con `prospectar` y después necesita mirarlas; con cartera vacía no ve nada |
| `operador` | Ve todo, pero además cura (`confirmar_cuenta`, `revertir_cuenta`), carga archivos y no tiene tope de créditos. Un bot con un bug gastaría sin límite y podría alterar la base compartida |
| `admin` | Todo lo anterior más usuarios, claves y SQL libre |
| `recruiter` | Sólo personas por skill; no ve cuentas |
| `ingesta` | Sólo carga |

El bot necesita: ver el universo entero, no curar, no cargar, no administrar, gastar con tope, y que su consumo quede atribuido a un cliente.

## 2. Definición del rol

| Campo | Valor | Motivo |
|---|---|---|
| `rol` | `sdr_bot` | |
| `descripcion` | "Bot SDR de un cliente: prospecta y revela decisores con tope diario, sin curar ni cargar." | |
| `requiere_cliente` | `true` | Fuerza `cliente_id` en el usuario: `uso` atribuye por cliente sin configuración extra, y `ops.prospecto` queda ligado al tenant |
| `ve_todas_las_cuentas` | `true` | `prospectar` y `novedades` sobre el universo; `presencia` y `evidencia` sobre cualquier cuenta descubierta |

Nota: hoy ningún rol combina `requiere_cliente = true` con `ve_todas_las_cuentas = true`. Las políticas (`ops.sin_restriccion() or cliente_id = ops.ctx_cliente()`) y `cuentas_visibles()` lo soportan sin cambios; hay que agregar un caso en `mcp/probar-listado.mjs` y en `mcp/probar-aislamiento.mjs` que lo cubra.

## 3. Tools permitidas (`ops.permiso`)

| Tool | Incluida | Uso en el SDR |
|---|---|---|
| `resolver_cuentas` | Sí | Normalizar nombres de cuentas del cliente y de señales |
| `prospectar` | Sí | Playbook de señales: avisos, stack, categorías, ciclo de vida, por país y vertical |
| `novedades` | Sí | Qué cambió en cuentas en secuencia o engaged |
| `rotacion` | Sí | Decisor recién llegado en cuentas trabajadas |
| `presencia` | Sí | Firmeza por país antes de redactar la tesis |
| `evidencia` | Sí | Fragmentos para el mensaje y para defender la afirmación |
| `productos` | Sí | Nombres exactos del diccionario para el playbook |
| `roles_objetivo` | Sí | `rol_id` del catálogo para buscar decisores |
| `tomadores_de_decision` | Sí | Decisores desde caché, gratis, primer paso siempre |
| `buscar_contactos` | Sí | Padrón por rol, títulos y seniority del ICP (Apollo, gratis, cuota diaria) |
| `revelar_lote` | Sí | Reveal de los calificados, hasta 25, caché primero |
| `revelar_contacto` | Sí | Reveal de uno; teléfono sólo si el tenant lo habilita |
| `hallazgos` | Sí | Lo que ya se radiografió de la cuenta, sin salir a buscar |
| `personas_por_mail` | Sí, con cupo | Identificar a quien responde desde una dirección que no está en contactos (derivaciones, reenvíos). Consume el cupo mensual de contactos |
| `guardar_contactos` | No | El estado de contacto vive en la base de control del SDR, no en ASCI |
| `radiografia`, `guardar_hallazgos` | No en v1 | Escriben en la base compartida. Evaluar cuando el SDR haga búsqueda web por cuenta |
| `personas`, `personas_por_texto` | No | Entrada por persona y skill; es otro producto |
| `confirmar_cuenta`, `revertir_cuenta`, `cargar_archivo`, `estado_carga` | No | Curación e ingesta |
| `usuarios`, `uso`, `crear_usuario`, `crear_clave`, `actualizar_usuario`, `revocar_clave` | No | Administración |
| `esquema`, `consultar`, `exportar_consulta` | No | SQL libre, sin cupo ni cartera |

Total: 14 tools. `ops.tool_tipo` ya clasifica cada una; no hace falta tocarla.

## 4. Presupuesto

### 4.1 Lo que ya existe y alcanza para arrancar

`ops.presupuesto_apollo` define el tope **por rol** y `ops.apollo_presupuesto()` lo aplica **por usuario y por día** (cuenta `ops.apollo_llamada` con `usuario_id = ops.ctx_usuario()` desde `date_trunc('day', now())`). Como cada tenant tiene su propio usuario, el tope del rol ya es un tope por tenant por día.

| Columna | Valor propuesto para `sdr_bot` | Motivo |
|---|---|---|
| `busquedas_dia` | 100 | Dos corridas diarias de hasta 25 cuentas, una página por cuenta, más margen |
| `creditos_dia` | 40 | Máximo 2 personas por cuenta y 15 a 20 cuentas nuevas por día; el resto sale de caché |
| `telefonos_dia` | 0 | Sin móviles por defecto. Un tenant que los habilite pasa por el override de 4.2 |

Cada tool de Apollo devuelve `presupuesto` (`busquedas_hoy`, `creditos_hoy`, `puede_gastar`...) en su respuesta, así que el script del bot sabe dónde está parado sin una tool extra. Cuando `puede_gastar` es `false`, el script registra el motivo y sigue; no reintenta.

`ops.presupuesto_personas`: una fila para `sdr_bot` con 200 contactos por mes, por el uso de `personas_por_mail`.

### 4.2 Cambio chico propuesto: override por usuario

Hoy el tope es uno por rol. Dos tenants con volúmenes distintos necesitan topes distintos, y un tope mensual que el diario no da.

| Tabla nueva | Columnas |
|---|---|
| `ops.presupuesto_usuario` | `usuario_id` (PK, FK `ops.usuario`), `busquedas_dia`, `creditos_dia`, `telefonos_dia`, `creditos_mes` (todas `int null`) |

`ops.apollo_presupuesto()` pasa a leer `coalesce(usuario.columna, rol.columna)` para los tres diarios, y agrega `creditos_mes` / `creditos_mes_hoy` / `puede_gastar_mes` contando desde `date_trunc('month', now())` en la zona de Buenos Aires, igual que el cupo de personas. `puede_gastar` queda como `puede_gastar_dia and puede_gastar_mes`. Las tools que ya consultan `puede_gastar` no cambian. `actualizar_usuario` acepta los cuatro valores como parámetros opcionales.

Es una migración y un cambio en una función. Mientras no exista, el tope mensual se hace cumplir en la base de control del SDR (`credits` del manifiesto), que es una barrera de software y no de ASCI.

## 5. Alta, rotación y baja de un tenant

| Paso | Llamada | Resultado |
|---|---|---|
| Alta | `crear_usuario(email = "sdr.<slug>@bigua.lat", nombre = "SDR BOT · <slug>", rol = "sdr_bot", cliente = "<slug>", dias_de_validez = 365)` | Crea el cliente en `ops.cliente` si no existe y devuelve la clave una sola vez. La clave va al secreto `ASCI_KEY` de la cuenta de Grok Bot del tenant, junto con la URL `https://mcp.bigua.lat/mcp` |
| Rotación | `crear_clave(email, nombre = "SDR BOT · <slug> · 2027")` → actualizar el secreto → `revocar_clave(clave_id vieja)` | Sin corte |
| Vencimiento | El chequeo de sesiones del tenant lee `expira_en` de su clave (hoy sólo lo ve `usuarios`, admin) | Ver 6.1 |
| Baja | `actualizar_usuario(email, activo = false)` | Revoca las claves; el cliente queda en `ops.cliente` para el histórico de `uso` |

El mail `sdr.<slug>@bigua.lat` hace que `ops.usuario.interno` sea `true` por dominio, y las cuentas de retención del panel admin lo excluyen. Si se quiere que el bot figure como actividad del cliente, usar un subdominio propio (`sdr.<slug>@bots.bigua.lat`) y revisar la columna generada.

Los scripts del bot llaman al MCP por HTTP (`tools/call` con `Authorization: Bearer`), no a través de un modelo. Las instrucciones de las descripciones de tools ("mostrale los cargos al usuario y que elija") aplican al modelo, no al script: el script decide con las reglas del `client_config` y deja la justificación en `contact_qualifications` antes de revelar. El `User-Agent` del script es `sdrbot/<tag> tenant=<slug>`, que `ops.acceso` guarda como `cliente_mcp`.

## 6. Tools nuevas o cambios chicos

En orden de valor para el SDR. Ninguno bloquea el arranque.

### 6.1 `mi_clave` (lectura, sin créditos)

Devuelve, para el usuario autenticado: `email`, `rol`, `cliente`, la clave con la que entró (`clave_id`, `nombre`, `expira_en`, `ultimo_uso`) y el presupuesto vigente (`ops.apollo_presupuesto()` más el override de 4.2). Hoy `expira_en` sólo lo ve `usuarios` (admin), así que un bot no puede avisar que su clave vence. Es una función `ops.t_mi_clave` sobre `ops.ctx_usuario()` y la clave en contexto (desde la 0276 se guarda `clave_id` por llamada). Permiso para todos los roles.

### 6.2 `mi_uso` (lectura, sin créditos)

La parte de `uso` que es del propio usuario: llamadas por tool, créditos de Apollo, contactos entregados y avisos desde una fecha. Es `ops.t_uso` filtrado por `ops.ctx_usuario()`, sin `actividad` ni `salud_tools`. Permite mover la sincronización de consumo al tenant. Prioridad baja: la sincronización desde el plano de control con la clave admin funciona hoy.

### 6.3 `prospectar` con `avisos_desde`

Un parámetro opcional `avisos_desde` (YYYY-MM-DD) que, con `ordenar_por: "avisos"`, cuente y ordene sólo los avisos publicados desde esa fecha. Un bot que prospecta cada lunes necesita "qué apareció esta semana", no el ranking de los últimos 12 meses. Hoy se resuelve en la base de control deduplicando señales, pero paga el costo de traer la lista entera cada vez.

### 6.4 `novedades` y `rotacion` sobre más de 10 cuentas

`novedades` acepta 10 empresas por llamada. Un tenant con 60 cuentas en secuencia son 6 llamadas diarias; aceptable hasta unos 200 por tenant. Si crece, un parámetro `cliente_cartera: true` que itere `ops.abm_account` del cliente del usuario evitaría pasar la lista. Requiere que el SDR registre en `ops.abm_account` las cuentas que trabaja (ver 7).

### 6.5 Presupuesto por usuario (4.2)

Ya descrito. Es el único cambio que conviene hacer antes del tercer tenant.

## 7. Cartera del tenant en ASCI: sí o no

`ops.abm_account` es la cartera de un cliente. Para `sdr_bot` no hace falta para el alcance (ve todo), pero registrar ahí las cuentas que el SDR pone en secuencia tiene dos ventajas: Radar y el MCP de la persona del cliente (rol `cliente`) verían las mismas cuentas que trabaja el bot, y 6.4 se vuelve posible. La contra: el SDR escribiría en una tabla de ASCI, y la decisión de v1.1 es que ASCI no guarda estado del cliente.

Recomendación: no en v1. Reabrir cuando un cliente tenga a la vez SDR y Radar o usuarios humanos de ASCI.

## 8. Borrador de migración

Para que el pedido sea concreto. Numeración y nombre según la convención del repo.

```sql
-- 0292_rol_sdr_bot
insert into ops.rol (rol, descripcion, requiere_cliente, ve_todas_las_cuentas) values
  ('sdr_bot', 'Bot SDR de un cliente: prospecta y revela decisores con tope diario, sin curar ni cargar.', true, true)
on conflict (rol) do update set descripcion = excluded.descripcion,
  requiere_cliente = excluded.requiere_cliente, ve_todas_las_cuentas = excluded.ve_todas_las_cuentas;

insert into ops.permiso (rol, tool)
select 'sdr_bot', t from unnest(array[
  'resolver_cuentas','prospectar','novedades','rotacion','presencia','evidencia','productos',
  'roles_objetivo','tomadores_de_decision','buscar_contactos','revelar_lote','revelar_contacto',
  'hallazgos','personas_por_mail']) as t
on conflict do nothing;

insert into ops.presupuesto_apollo (rol, busquedas_dia, creditos_dia, telefonos_dia)
values ('sdr_bot', 100, 40, 0)
on conflict (rol) do update set busquedas_dia = excluded.busquedas_dia,
  creditos_dia = excluded.creditos_dia, telefonos_dia = excluded.telefonos_dia;

insert into ops.presupuesto_personas (rol, contactos_mes) values ('sdr_bot', 200)
on conflict (rol) do update set contactos_mes = excluded.contactos_mes;
```

Verificar antes de aplicar: el nombre exacto de las columnas de `ops.presupuesto_personas` (0229) y de `ops.permiso`; que `ops.validar_usuario()` acepte el alta con `cliente` creado en la misma transacción (hoy `crear_usuario` lo hace para `cliente`); y agregar los casos a `probar-listado` (14 tools) y `probar-admin` (alta con rol `sdr_bot` sin cliente debe fallar).

## 9. Pruebas que tienen que existir

- Un usuario `sdr_bot` lista exactamente las 14 tools.
- `prospectar`, `presencia` y `novedades` devuelven cuentas fuera de cualquier cartera.
- `confirmar_cuenta` y `uso` devuelven error de permiso.
- Al llegar a `creditos_dia`, `revelar_lote` devuelve `puede_gastar = false` y no sale a Apollo.
- `uso` (admin) atribuye las llamadas del bot al `cliente` del usuario.
- Dos usuarios `sdr_bot` de clientes distintos no comparten contador diario.
