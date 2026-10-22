# Onboarding, prerrequisitos y plan de construcción

Qué necesita el cliente para arrancar, qué necesita Biguá para operar, cómo es el alta paso a paso y en qué orden se construye. Complementa `02-arquitectura.md`.

## 1. Lo que entrega el cliente (kit de alta)

Todo se recoge en el **manifiesto de tenant** (`tenant-manifest.example.yaml`) salvo los secretos, que el cliente carga directo en su box o en la cuenta de Grok Bot y nunca manda por mail. Biguá acompaña el llenado en una reunión de kickoff; el cliente no completa el YAML a mano.

| # | Ítem | Formato | Quién del cliente | Bloqueante | Tiempo típico |
|---|---|---|---|---|---|
| 1 | **Personas y roles:** aprobador de leads y tandas, vendedor (AE), dueño de la línea de WhatsApp, referente técnico | Nombres, mails, canal de aviso preferido | Dirección comercial | Sí | 1 día |
| 2 | **Oferta:** 3 a 4 puntos de valor, 2 casos ancla con resultado, frases prohibidas, tono, firma | Texto | Comercial | Sí | 2 a 3 días |
| 3 | **ICP:** mercados (país, idioma, tratamiento), verticales, tamaño, cargos objetivo, señales que importan, competidores | Lista; Biguá lo traduce a roles y categorías de ASCI | Comercial + Biguá | Sí | 1 reunión |
| 4 | **No contactar:** clientes actuales, pipeline abierto, bajas previas, dominios excluidos | CSV (dominio o mail, motivo) | Comercial / CRM | Sí | 1 día |
| 5 | **Textos base aprobados:** primer toque, recordatorio, breakup, respuesta a "no por ahora", respuesta de cortesía, por idioma | Biguá redacta; el cliente aprueba | Aprobador | Sí, antes del primer envío | 3 a 5 días |
| 6 | **Dominio alternativo y casillas:** dominio distinto del principal, SPF/DKIM/DMARC publicados, 3 a 5 casillas, credenciales SMTP/IMAP | DNS publicados; credenciales cargadas por el cliente en los `.env` del box; o delegación a Biguá | TI del cliente | Sí para mail | 2 días + 2 semanas de warm-up |
| 7 | **LinkedIn del vendedor:** perfil, Sales Navigator, Dripify; login y 2FA hechos por él en el box | Sesión en el navegador del box | Vendedor | Sí para LinkedIn | 1 sesión de 30 min |
| 8 | **Línea de WhatsApp:** número dedicado, teléfono a mano para el QR, quién aprueba, base legal para primeros contactos (si los hay) | Sesión en el box + manifiesto | Dueño de la línea | Sí para WhatsApp | 1 sesión de 15 min |
| 9 | **CRM:** acceso a HubSpot con token de scopes mínimos, o "ninguno" | Token cargado como secreto de la cuenta de Grok Bot | TI / comercial | No | 1 día |
| 10 | **SLA de aprobación:** cuánto tarda en aprobar calientes, tibios y tandas; qué pasa si no llega (recordar, cortesía, nada) | Manifiesto | Aprobador | Sí | En el kickoff |
| 11 | **Acuerdo de tratamiento de datos (DPA)** y base legal por mercado | Firma | Legal / dirección | Sí | 1 semana |
| 12 | **Agenda:** quién toma reuniones, arma propuestas, gestiona altas de proveedor | Manifiesto | Comercial | Sí | En el kickoff |

Opcional y recomendado: una lista de 20 a 50 cuentas "soñadas" para validar la cobertura de ASCI y de Apify en los mercados del cliente antes del primer envío.

### 1.1 Servicio gestionado de mail (opción)

Para bajar fricción, Biguá puede ofrecer como paquete: registro del dominio alternativo, DNS, casillas (Google Workspace o equivalente) y warm-up, con el dominio a nombre del cliente. En el manifiesto, `channels.email.dns_owner: bigua`. Las credenciales igual se guardan en el box del tenant y no en Biguá.

## 2. Lo que necesita Biguá

### 2.1 Construcción (backlog por frente)

| Frente | Entregables | Bloqueante para el primer tenant |
|---|---|---|
| **Base de control** | Migraciones del esquema `sdr` (sección 7 del documento + deltas de la revisión), RLS en todas las tablas, vistas, RPCs, pg_cron, tests de aislamiento en CI, entornos dev/staging/prod | Sí |
| **ASCI** | Usuario y clave por tenant; rol `sdr_bot` (`04-rol-sdr-bot-asci.md`: una migración de filas); override de presupuesto por usuario y tope mensual; `mi_clave` y `mi_uso` opcionales; jobs de Apify parametrizados por mercado y vertical | Rol: no (se usa `operador` mientras tanto). Usuario por tenant: sí |
| **Scripts (port de PasQAlito)** | `mailbox`, `send_batch`, `imap_fetch`, `forward_replies`, `send_replies`, `decisor`, `wa_batch`, `wa_send`, `linkedin`, `sessions_check`, `heartbeat`, `maintenance`; módulo común `db` (SDK + RPC) e `ia` (validación de JSON contra esquemas) | Sí |
| **Skills** | Calificación, redacción, respuestas, interpretación de aprobaciones, WhatsApp, InMails/Dripify, resumen; como archivos del repo | Sí |
| **Plantilla Grok Bot** | Seis bots, routines con horarios del manifiesto, secretos, `export-bot-template` | Sí |
| **Manifiesto y alta** | Esquema JSON del manifiesto, validador, script `provision` (manifiesto → filas en Supabase + usuario ASCI + usuario Supabase + checklist de secretos), script `offboard` | Sí |
| **Notificador** | Edge Function mail (y WhatsApp en fase 2), tabla `notifications`, plantillas | Sí (mail) |
| **Aprobaciones** | Tabla `approvals`, verificación de remitente, tokens, RPC `request_approval` / `decide_approval` | Sí |
| **Resúmenes** | `daily_summary` por tenant y consolidado de Biguá | Sí |
| **Migración de BairesQA** | Script JSON + CRM de Claude → tablas; corrida en seco con diff; plan de corte | Sí para BairesQA |
| **Kit de box** | Spec, instalador (Python, repo, Chrome, heartbeat), runbook de sesiones | Sí |
| **Playbooks** | Alta, operación diaria, incidentes (sesión vencida, dominio quemado, número bloqueado, box caído, créditos agotados), release de plantilla, baja | Alta e incidentes: sí |
| **Tablero web y página de aprobación** | App mínima sobre Supabase con magic link | No (fase 2) |
| **Capa MCP `sdr.*`** | Namespace en `mcp.bigua.lat` sobre las RPC | No (fase 2) |
| **Adaptador de CRM** | HubSpot: contactos, empresas, deals, actividades | No (fase 2) |

### 2.2 Decisiones y pedidos externos

| Pedido | A quién | Por qué importa |
|---|---|---|
| Rol `sdr_bot` (migración de filas) y override de presupuesto por usuario con tope mensual | Desarrollo de ASCI (Ignacio) | Aislamiento de permisos y de gasto por tenant. Spec en `04-rol-sdr-bot-asci.md` |
| `mi_clave` y `mi_uso` para no-admin (opcionales) | Desarrollo de ASCI | Que el bot vea el vencimiento de su clave y su consumo |
| Scope de conectores por bot; API para exportar/importar plantilla; modelo de membresía de cuentas; permiso mínimo para el soporte de Biguá en una cuenta del cliente (modelo fábrica) | Producto de Grok Bot | Propagación de versiones y acceso de Biguá a las cuentas |
| Capacidades del box: persistencia de sesiones de Chrome y de archivos entre reinicios, scripts de Python con salida a SMTP/IMAP, acceso al escritorio para QR y 2FA, zona horaria, routine corta periódica | Producto de Grok Bot | Son los supuestos de `02-arquitectura.md` §4.1; cada uno que no se cumpla tiene un plan B |
| Proyecto de Supabase `sdrbot` (nuevo, misma organización y región que `locasci`) | Biguá | Base de control separada del corpus de ASCI |
| DPA estándar y texto de baja por idioma | Biguá con asesoría legal | Base legal por mercado |

### 2.3 Operación (personas)

- **Nicolás:** operación diaria, vínculo con el cliente, revisión de respuestas de baja confianza, aprobación de créditos, playbooks de incidentes.
- **Ignacio:** diseño, ICP y playbook de señales por tenant, ASCI y plano de control, releases de plantilla.
- **A partir del tercer tenant:** un operador adicional o un tablero que reduzca la carga de lectura de resúmenes.

## 3. Proceso de alta (runbook)

Duración objetivo: 3 semanas desde el kickoff hasta el primer envío, condicionada por el warm-up de casillas.

| Semana | Paso | Quién | Salida |
|---|---|---|---|
| 0 | Firma de propuesta y DPA | Cliente + Biguá | Contrato |
| 1 | Kickoff: se completa el manifiesto (personas, oferta, ICP, SLA, canales) | Biguá + cliente | `tenants/<slug>.yaml` en el repo privado de tenants |
| 1 | Cliente entrega DNC y, si corresponde, dominio y casillas | Cliente | CSV + DNS publicados |
| 1 | `provision <slug>`: filas en Supabase, usuario y clave en ASCI (`cliente = slug`), usuario Auth con `client_id`, checklist de secretos | Biguá | Tenant en estado `onboarding` |
| 1 | Validación de cobertura: 20 a 50 cuentas del cliente contra ASCI (`resolver_cuentas`, `presencia`) y Apify por mercado | Biguá | Informe de cobertura; ajuste del playbook de señales |
| 2 | Cuenta de Grok Bot desde la plantilla; secretos cargados; cliente agregado como miembro aprobador | Biguá | Cuenta lista |
| 2 | Box de Grok Bot del tenant: instalador del repo en el tag, `.env` de casillas (cliente), logins de LinkedIn/Dripify (vendedor), QR de WhatsApp (dueño de la línea), heartbeat | Biguá + cliente | `boxes` con heartbeat y sesiones ok |
| 2 | Textos base redactados por Biguá y aprobados por el cliente (`sequences` en `approved`) | Biguá + aprobador | Secuencias activas |
| 2 a 3 | Warm-up de casillas (escalones del manifiesto) | Automático | `mailboxes.status = warming` |
| 3 | Corrida en seco: todas las routines con `dry_run = true`; se revisan `run_log`, candidatos, borradores y el resumen | Biguá + cliente | Checklist de salida firmado |
| 3 | Activación: `clients.status = active`, routines encendidas, primer resumen 18:50 | Biguá | Tenant activo |
| 4+ | Revisión semanal de respuestas, cupos, rebotes y consumo; ajuste de ICP y textos | Biguá + cliente | Minuta |

Criterios de salida de la corrida en seco: cero violaciones de DNC en el log, caps respetados, aprobaciones llegando al aprobador correcto, heartbeat estable 48 horas, resumen legible.

## 4. Baja

1. `clients.status = offboarding`; routines pausadas; aprobaciones pendientes canceladas.
2. Exportación de datos del tenant a Storage y entrega al cliente (contactos, envíos, respuestas, DNC).
3. Revocación de la clave de ASCI (`actualizar_usuario activo=false`) y del usuario de Supabase.
4. `offboard_client`: borrado en cascada salvo `do_not_contact` del tenant, que se conserva el tiempo que exija la retención.
5. Cierre o entrega de la cuenta de Grok Bot; cierre de sesiones y borrado del perfil de Chrome del box.

## 5. Plan por fases

| Fase | Alcance | Criterio de salida |
|---|---|---|
| **0 · Cierre de diseño** (1 a 2 semanas) | Fijar el esquema del manifiesto; pedir rol `sdr_bot` y scope de conectores; verificar las capacidades del box con Grok Bot; crear el proyecto de Supabase `sdrbot` | v1.2 del documento aprobada; manifiesto de BairesQA completo |
| **1 · Plano de control mínimo + BairesQA** (4 a 6 semanas) | Migraciones, RLS, RPC, vistas, pg_cron, tests; port de scripts; skills; plantilla; notificador por mail; aprobaciones con token; resúmenes; `provision`; kit de box; migración de BairesQA; corrida en seco; corte desde PasQAlito | BairesQA opera en Grok Bot una semana sin envíos duplicados ni violaciones de DNC |
| **2 · Segundo tenant y estandarización** (3 a 4 semanas) | Alta de Tacco **sólo** con el manifiesto y el runbook; lo que haya que tocar a mano se convierte en código; resumen consolidado de Biguá; playbooks probados | Tacco activo sin cambios ad hoc en el repo; checklist de alta en menos de 3 semanas |
| **3 · Escala** (según demanda) | Rol `sdr_bot` y presupuesto en ASCI; capa MCP `sdr.*`; tablero web y página de aprobación; notificador por WhatsApp; adaptador HubSpot; release automatizado | Tercer tenant en alta con un operador sin intervención de Ignacio |

## 6. Decisiones tomadas (22/10/2026)

| # | Tema | Decisión | Dónde queda |
|---|---|---|---|
| 1 | Rol del bot en ASCI | Rol `sdr_bot` especificado y pedido; `operador` con tope en software hasta que exista | `04-rol-sdr-bot-asci.md` |
| 2 | Dueño de la cuenta de Grok Bot | Biguá durante el contrato por default. El modelo fábrica (cuenta a nombre del cliente, Biguá como miembro administrador durante el soporte) está soportado y documentado | `02-arquitectura.md` §5.1; `grokbot.ownership_model` en el manifiesto |
| 3 | Box | Es la computadora virtual de Grok Bot de la cuenta del tenant. No hay VPS de Biguá ni equipo del cliente. Quedan supuestos a verificar con Grok Bot | `02-arquitectura.md` §4.1 |
| 4 | Revisión de respuestas de baja confianza | Operador de Biguá, no el cliente | `02-arquitectura.md` §7.3; `reply_handling` del manifiesto |
| 5 | SLA vencido | Forma parte del manifiesto por tipo de aprobación: horas, acción al vencer y a quién escala | `approvals.*` del manifiesto |
| 6 | Capa MCP `sdr.*` | Fase 2 | `02-arquitectura.md` §11 |
| 7 | Base de control | Un proyecto de Supabase `sdrbot` con RLS, separado del proyecto `locasci` de ASCI, misma organización y región | `02-arquitectura.md` §3.1 |
| 8 | Secretos | Grok Bot secrets por tenant como runtime; Supabase Vault del proyecto `sdrbot` para lo que Biguá conserva. Sin gestor externo | `02-arquitectura.md` §5.2 |

Quedan abiertas, y no bloquean la fase 0:

- Opt-outs por tenant y supresión global sólo técnica/legal (recomendado: sí).
- Primer contacto por WhatsApp en frío: prohibido salvo base legal declarada (recomendado: prohibido por default).
- Respuesta de cortesía ante SLA vencido en leads calientes: habilitada por tenant con texto aprobado de antemano (recomendado: sí). El mecanismo ya está en el manifiesto; falta confirmar el default.
