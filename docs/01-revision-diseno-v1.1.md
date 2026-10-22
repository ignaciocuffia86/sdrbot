# Revisión del documento "SDR BOT · Gestión centralizada multicliente" (v1.1)

Fecha de revisión: 22 de octubre de 2026.
Insumos: el documento v1.1, el estado real del MCP de ASCI al día de hoy (roles, usuarios, claves y medidor de uso, consultados con la clave admin de Biguá) y los skills `brief-cuenta-asci` y `propuestas-bigua`.

El objetivo de esta revisión no es reescribir el documento sino decir qué está sólido, qué no cierra contra lo que existe hoy, y qué hay que cambiar para que el esquema escale a N clientes sin rehacerlo. Las propuestas de solución están desarrolladas en `02-arquitectura.md`; acá se enumeran los hallazgos.

## 1. Veredicto general

El documento está bien planteado y la mayoría de las decisiones de fondo son las correctas:

- **Separación programático / IA / WhatsApp / humano.** Es la división que hace que el sistema sea auditable. Lo que es regla (cupos, no contactar, deduplicación, un follow-up sin respuesta, aprobaciones) vive en la base y no en la memoria de un bot.
- **Plano de control único + un plano de ejecución por cliente.** Es la topología correcta para el estado actual de Grok Bot (box compartido por cuenta, conectores sin scope por bot). Aísla sesiones de navegador, credenciales y archivos por construcción, no por disciplina.
- **Supabase como base de control con RLS por `client_id`** en todas las tablas, vistas `security_invoker`, RPCs como único camino de escritura y `service_role` sólo en Biguá. Es el diseño multitenant estándar y está bien aplicado.
- **Idempotencia** por `run_key`, `external_ref` y `(enrollment_id, channel, step_no)`. Es lo que permite reintentar routines sin duplicar envíos.
- **Nada sale sin aprobación** en los canales de riesgo (WhatsApp, leads calientes y tibios). Reduce el riesgo reputacional del cliente y legal de Biguá.

Lo que falta es, sobre todo, (a) alinear el modelo de "token por cliente" con cómo funciona ASCI de verdad, (b) convertir lo que hoy es un caso (BairesQA) en un contrato estándar de alta, y (c) cerrar algunos huecos operativos que a un cliente no se notan y a cinco sí.

## 2. Hallazgos verificados contra ASCI (estado al 22/10/2026)

Esto es lo que ASCI expone hoy y que el documento asume de otra manera.

| Tema | Lo que dice el documento | Lo que hay hoy en ASCI | Impacto |
|---|---|---|---|
| "Token de ASCI por cliente" | Un token por cliente, para medir uso y aplicar rate limit | No hay tokens sueltos: hay **usuarios** con **rol** y **claves** (varias por usuario, con nombre, vencimiento y último uso). El consumo se atribuye por usuario y por `cliente` del usuario | El "token" del documento es una clave de un usuario de ASCI creado para el bot del tenant. Hay que definir qué rol tiene ese usuario |
| Rol para el bot del cliente | Implícito: el cliente consulta con su token | El rol `cliente` **sólo ve su cartera** (cuentas asignadas). Para un SDR que descubre cuentas nuevas por señal (`prospectar`, `novedades` de todo el universo) no sirve. El rol `operador` sí consulta sin restricción, pero además **cura** cuentas, carga archivos y revierte cambios: demasiado para un bot de un cliente | Hace falta un rol nuevo en ASCI para el bot SDR (ver §4.1). Hasta que exista, `operador` con clave nombrada por tenant, aceptando el riesgo |
| Routine "Consumo de ASCI" (18:40) en la cuenta del cliente | El bot del cliente trae su consumo con su token | La tool `uso` es **sólo para admin**. Un bot con rol cliente u operador no puede leer su propio consumo | La sincronización de consumo tiene que correr desde el plano de control (clave admin), no desde el tenant. O ASCI expone un `mi_uso` para no-admin |
| Revelar contactos de forma autónoma | El bot `qualify` revela decisores por reglas + IA | Las tools de reveal están diseñadas con humano en el loop ("nunca reveles por tu cuenta"). Cuesta 1 crédito por persona, se cobra aunque no haya mail; el móvil cuesta 5, tiene tope propio y llega por webhook (asíncrono) | Hay que definir una **política de reveal programática** por tenant (quién "decide" cuando no hay humano: las reglas del `client_config`) y un **presupuesto de créditos por tenant** que ASCI haga cumplir |
| Atribución de créditos por cliente | `asci_usage` espejo del medidor por token | `uso` ya devuelve `por_cliente` y `por_usuario`, con créditos de Apollo, avisos ("presupuesto agotado", 429) y errores con texto | Sirve tal cual. El bot de cada tenant debe crearse con `cliente = <slug del tenant>` para que la atribución salga sola |
| Caché compartida de Apollo | No se menciona | El reveal es gratis si la persona ya fue revelada (por cualquier usuario) dentro de `frescura_dias`. `tomadores_de_decision` sale de caché y no gasta | Baja el costo marginal del segundo cliente que trabaja la misma cuenta. Conviene consultar caché antes que Apollo siempre (ya está así en las tools) |
| Estado por cliente dentro de ASCI | "ASCI no guarda nada del cliente" | `guardar_contactos` guarda una lista **por usuario** (estado nuevo/contactado/descartado). Es estado de cliente dentro de ASCI | Decidir: no usarla (el estado vive en Supabase) o usarla sólo como espejo. Recomendación: no usarla |
| Teléfonos para WhatsApp | Primeros contactos a celulares de decisores que salen de SalesQL y Apollo | Los teléfonos del corpus son en gran parte conmutadores (`llega_a_la_persona: false`). El móvil real cuesta 5 créditos y es asíncrono | La tanda de WhatsApp sólo puede armarse con teléfonos marcados como personales. Y entra en tensión con la regla de F2 ("nunca teléfonos sin pedido") |
| Cobertura geográfica | Corridas EE.UU. y LATAM/España | El corpus de señales es LATAM (Argentina, Chile, Perú, México, Colombia, Ecuador; algo de EE.UU.). `buscar_contactos` por dominio sale a Apollo y funciona para cualquier empresa | Para EE.UU. y España las señales vienen de Apify (avisos), no de ASCI. Hay que explicitar la fuente por mercado en el config del tenant |
| Vencimiento de claves | No se menciona | Las claves vencen (365 días por defecto; varias de prueba a 15 días). Hay claves de prueba y usuarios de clientes ya cargados como `operador` (por ejemplo Tacco) | El chequeo de sesiones de las 07:30 tiene que incluir la fecha de vencimiento de la clave de ASCI; y el alta de un tenant no debe reutilizar la clave personal de un usuario del cliente |
| Ingesta de Apify | Apify en el plano de control → API de ingesta → ASCI | Ya existe el rol `ingesta` y el usuario `bot.scraping@bigua.lat` con uso diario | Está resuelto; sólo hay que parametrizar qué se scrapea por tenant (países, cargos, verticales) |

## 3. Problemas y vacíos del diseño

Orden por impacto. Cada uno tiene su propuesta en `02-arquitectura.md`.

### 3.1 Críticos (bloquean la estandarización o el aislamiento)

1. **El modelo de identidad en ASCI no está definido.** "Token por cliente" no es una entidad de ASCI. Sin un rol adecuado, el bot del tenant o ve de menos (`cliente`) o puede de más (`operador`). Y sin presupuesto por usuario, un bot con un bug puede gastar los créditos de todos.
2. **No hay contrato de alta.** Lo que un cliente tiene que entregar está disperso entre la sección 9.1, la 6.1 y el `config.json` de PasQAlito. Para escalar hace falta **un manifiesto de tenant** con esquema fijo, que sea la única entrada del proceso de alta y del que se deriven `clients`, `client_config`, `mailboxes`, `channel_seats`, `members` y `do_not_contact`. Ver `tenant-manifest.example.yaml`.
3. **La lista global de no contactar mezcla cosas distintas.** Un opt-out de un mensaje de BairesQA no es un opt-out de Tacco: son responsables del tratamiento distintos. La supresión global (`client_id NULL`) debe limitarse a rebotes duros, pedidos legales y trampas de spam; los opt-outs son por tenant. Si no, Biguá propaga entre clientes una decisión que el contacto tomó frente a uno solo.
4. **Aprobaciones por mail sin verificación de origen.** El canal de control de WhatsApp y de leads calientes es un mail con "OK 1,3". Cualquiera que mande un mail con el asunto correcto a la casilla monitoreada aprueba una tanda. Hace falta verificar remitente (dirección exacta del aprobador, alineación DKIM/SPF) y un identificador de tanda en el asunto, con decisiones idempotentes.

### 3.2 Importantes (duelen a partir del tercer cliente)

5. **El box por cliente es la pieza más frágil y menos especificada.** Una máquina por tenant con Chrome adelante, QR de WhatsApp, LinkedIn del vendedor y `.env` de casillas. No está dicho quién la provee, dónde corre, cómo se monitorea que esté viva, qué pasa cuando se apaga, ni cómo se actualizan los scripts. Hace falta un **kit de box estándar** (spec, instalador, heartbeat, runbook).
6. **La propagación de la plantilla entre cuentas de Grok Bot es un punto abierto que condiciona todo.** Si no hay mecanismo, cada actualización son N operaciones manuales en N cuentas. La mitigación es mover todo lo posible **fuera** de la cuenta de Grok Bot y **dentro** del repo (scripts, prompts de skills como archivos, definición de routines como datos), para que actualizar un tenant sea mover un tag.
7. **Señales limitadas a avisos.** El pedido es prospección por señales de avisos **y** novedades segmentadas por ASCI. ASCI ofrece además `novedades` (señales nuevas, ingresos con señal, avisos), `rotacion` (decisor recién llegado, que es el disparador más fuerte) y `prospectar` ordenado por avisos. El documento modela `signal_type` pero no define **qué consulta se corre, con qué parámetros, cada cuánto y a qué secuencia dispara**. Eso es lo que hay que estandarizar como "playbook de señales" en el config del tenant.
8. **Las dos reglas de follow-up no están unificadas** (punto abierto 2). Son compatibles si se modelan en dos niveles: por contacto, como máximo un follow-up sin respuesta; por cuenta, como máximo dos personas y la segunda sólo a los N días sin respuesta de la primera. Lo segundo es un nuevo `enrollment`, no un follow-up.
9. **Revisión de baja confianza asignada al cliente.** Una clasificación con confianza < 0,7 crea una tarea `review_reply` para Augusto. Es trabajo de operador de Biguá, no del cliente. El cliente debería ver sólo lo que ya está clasificado como caliente o tibio.
10. **Alertas sin canal de salida.** `alerts` es una tabla. No está definido quién la lee ni cómo llega a Biguá (mail, WhatsApp, Slack) fuera del resumen de las 19:00. Un `connector_down` a las 09:00 tiene que avisar a las 09:00.
11. **No hay DPA ni base legal por tenant.** Biguá trata datos personales por cuenta de cada cliente. Hace falta un acuerdo de tratamiento estándar en el alta y que el manifiesto declare base legal, mercados y texto de baja por idioma.

### 3.3 Menores (conviene corregir antes de la v1.2)

12. **Credencial de Supabase del tenant = email + contraseña** en secretos de Grok Bot. Funciona, pero conviene desactivar el alta pública de usuarios en Supabase Auth, fijar `app_metadata.client_id` por API admin (no editable por el usuario) y prever rotación. A mediano plazo, la capa MCP de Biguá (8.4) elimina la credencial de Supabase del tenant.
13. **`members.id = auth.users.id`** sugiere que aprobadores y vendedores inician sesión en Supabase. Hoy no lo necesitan (aprueban por mail). Desacoplar: `members.auth_user_id` nullable.
14. **`send_ledger.sent_by_member_id` "email: siempre humano"** contradice el envío por script SMTP. Debe admitir `sent_by = bot` con el `run_id` que lo envió.
15. **`asci_usage.decisor_searches / reveals`** debería espejar los campos reales de `uso` (llamadas por tool, créditos de Apollo, contactos entregados, avisos) en un `jsonb` más dos columnas agregadas, para no rehacer la tabla cuando ASCI agregue medidas.
16. **`pg_cron` y zona horaria.** Los jobs están en hora de Buenos Aires pero pg_cron corre en UTC y los tenants pueden estar en otra zona (`clients.timezone`). Los jobs de "día operativo" deben calcular el día por tenant, no por hora de servidor.
17. **`contacts.email UNIQUE (client_id, email)`** más `UNIQUE (client_id, linkedin_url_norm)` puede chocar cuando una misma persona llega con mail de Apollo y LinkedIn de Sales Nav en momentos distintos. `upsert_contact` debe hacer merge por cualquiera de las tres claves, no sólo `ON CONFLICT` por una.
18. **El resumen consolidado de Biguá (19:00)** está marcado como supuesto. Para la gestión centralizada es la pieza principal, no un extra: es lo que hace que Nicolás no tenga que abrir N cuentas.

## 4. Propuesta de resolución de los puntos abiertos (11.2)

| # | Punto | Propuesta |
|---|---|---|
| 1 | Limitar una cuenta de conector a un bot o equipo | Mantener una cuenta de Grok Bot por cliente aunque producto lo resuelva: el aislamiento del box lo exige igual. Si producto lo habilita, usarlo sólo para la cuenta de Biguá (varios tenants de solo lectura para el tablero) |
| 2 | Regla de seguimiento | Dos niveles en `client_config.followups`: `max_unanswered_per_contact: 1` y `second_contact_after_days: 7` (nuevo enrollment, no follow-up). Ver §3.2.8 |
| 3 | Acceso de Biguá a las cuentas de los clientes | Biguá **crea y es dueña** de la cuenta de Grok Bot del tenant durante el contrato (es parte del servicio). El cliente es miembro con permisos de aprobación. A la baja se entrega o se cierra. Evita depender de que el cliente administre bien una cuenta que opera Biguá |
| 4 | Propagación de versiones | Todo como código en el repo, tag por tenant, `template_version` en cada corrida, checklist de release por tenant. Automatizar cuando Grok Bot exponga API |
| 5 | Un proyecto de Supabase compartido o uno por cliente | Compartido con RLS hasta que un cliente exija aislamiento físico (contrato enterprise o regulación). El esquema no cambia si después se separa: `client_id` ya está en todas las tablas |
| 6 | Migración del histórico de BairesQA | Script de migración único (JSON + CRM de Claude → `send_ledger`, `send_counters`, `do_not_contact`, `contacts`), corrida en seco con diff de duplicados, y congelar PasQAlito un día antes del corte |
| 7 | Horarios SUPUESTO | Mover todos los horarios a `client_config.schedule` por tenant con los valores de BairesQA como default. Dejan de ser supuestos del documento y pasan a ser config |
| 8 | SLA del cliente para calientes y tibios | `reply_sla` por clasificación. Vencido: recordatorio al aprobador, alerta `sla_breach` a Biguá, y a las 24 h la respuesta "de cortesía" aprobada de antemano (texto fijo del tenant que confirma recepción y promete respuesta), si el tenant lo habilita |
| 9 | Capa MCP/API de Biguá | Fase 1: SDK + RPC desde los scripts del box. Fase 2 (al tercer tenant o cuando Grok Bot necesite llamar tools sin script): exponer las mismas RPC como tools `sdr.*` en `mcp.bigua.lat` con la **misma** autenticación que ASCI (usuario + clave del bot del tenant). Un solo secreto por tenant |

## 5. Cambios propuestos al modelo de datos (deltas sobre la sección 7)

Son ajustes, no un rediseño.

| Tabla | Cambio | Motivo |
|---|---|---|
| `clients` | `asci_user_email`, `asci_key_id`, `asci_key_expires_at`, `box_id`, `template_tag` | Identidad real en ASCI; vencimiento de clave en el chequeo de 07:30; versión de plantilla como tag de git |
| `client_config` | `signal_playbook jsonb`, `schedule jsonb`, `followups jsonb`, `markets jsonb` (país → fuente de señal, idioma, tratamiento, horario), `legal jsonb` (base legal, texto de baja por idioma), `credits jsonb` (presupuesto diario y mensual de ASCI, umbral de aviso) | Lo que hoy es supuesto o está fijo pasa a config por tenant |
| `members` | `auth_user_id uuid NULL` en lugar de `id = auth.users.id`; `notify_via` (email, whatsapp) | Aprobadores sin cuenta en Supabase; canal de aviso por persona |
| `do_not_contact` | `reason` global restringido por CHECK a `bounce_hard`, `legal_request`, `spam_trap`; los `opt_out` siempre con `client_id` | Separar supresión técnica/legal (global) de opt-out comercial (por tenant) |
| `contacts` | `phone_reaches_person bool`, `phone_source`, `whatsapp_basis` (opt_in, prior_relationship, none) | Sólo teléfonos personales en tandas de WhatsApp; base para contactar por ese canal |
| `send_ledger` | `sent_by` enum (bot, human) + `run_id` FK | Envío por script SMTP |
| `asci_usage` | `raw jsonb` con el bloque de `uso` del día; `credits int`, `calls int`, `contacts_delivered int` | Espejo fiel del medidor |
| `approvals` (nueva) | `id, client_id, kind (whatsapp_batch, reply, sequence, credits), ref_id, token, channel (email, ui), requested_at, decided_at, decided_by, raw_decision text, parsed jsonb` | Una sola tabla de aprobaciones con token verificable y decisión cruda guardada. Hoy la decisión está repartida en `whatsapp_batches`, `inbound_replies.client_decision` y `tasks` |
| `boxes` (nueva) | `id, client_id, hostname, last_heartbeat_at, chrome_front bool, sessions jsonb (whatsapp, linkedin, dripify: ok/expired/unknown), scripts_tag` | El box pasa a ser una entidad monitoreable; alimenta `connector_down` y `run_stale` |
| `notifications` (nueva) | `id, client_id NULL, member_id, channel, template, payload, sent_at, external_ref` | Registro de lo que se mandó a personas (resúmenes, pedidos de aprobación, alertas). Hoy no queda rastro |

## 6. Lo que el documento hace bien y no hay que tocar

Para que la v1.2 no "arregle" lo que funciona:

- Las RPCs `reserve_send / register_send / release_send` con contador atómico y `cap_snapshot`.
- `next_followups` con `FOR UPDATE SKIP LOCKED` y la prohibición de dos corridas de envío en paralelo.
- El trigger de `inbound_replies` que frena todos los canales ante cualquier respuesta.
- La regla de que la IA devuelve JSON con esquema fijo y un script valida y llama la RPC. No hay SQL libre desde el modelo.
- El MCP admin de Supabase sólo en la cuenta de Biguá.
- La lista de tareas que siguen siendo humanas (sección 10). Es el límite de responsabilidad y conviene que figure en la propuesta comercial de cada cliente.
