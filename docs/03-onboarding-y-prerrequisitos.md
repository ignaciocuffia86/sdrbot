# Onboarding, prerrequisitos y plan de construcción

Qué necesita el cliente para arrancar, qué necesita Biguá para operar, cómo es el alta paso a paso y en qué orden se construye. Complementa `02-arquitectura.md`.

## 1. Lo que entrega el cliente (kit de alta)

Todo se recoge en el **manifiesto de tenant** (`tenant-manifest.example.yaml`) salvo los secretos, que van por la bóveda. Biguá acompaña el llenado en una reunión de kickoff; el cliente no completa el YAML a mano.

| # | Ítem | Formato | Quién del cliente | Bloqueante | Tiempo típico |
|---|---|---|---|---|---|
| 1 | **Personas y roles:** aprobador de leads y tandas, vendedor (AE), dueño de la línea de WhatsApp, referente técnico | Nombres, mails, canal de aviso preferido | Dirección comercial | Sí | 1 día |
| 2 | **Oferta:** 3 a 4 puntos de valor, 2 casos ancla con resultado, frases prohibidas, tono, firma | Texto | Comercial | Sí | 2 a 3 días |
| 3 | **ICP:** mercados (país, idioma, tratamiento), verticales, tamaño, cargos objetivo, señales que importan, competidores | Lista; Biguá lo traduce a roles y categorías de ASCI | Comercial + Biguá | Sí | 1 reunión |
| 4 | **No contactar:** clientes actuales, pipeline abierto, bajas previas, dominios excluidos | CSV (dominio o mail, motivo) | Comercial / CRM | Sí | 1 día |
| 5 | **Textos base aprobados:** primer toque, recordatorio, breakup, respuesta a "no por ahora", respuesta de cortesía, por idioma | Biguá redacta; el cliente aprueba | Aprobador | Sí, antes del primer envío | 3 a 5 días |
| 6 | **Dominio alternativo y casillas:** dominio distinto del principal, SPF/DKIM/DMARC publicados, 3 a 5 casillas, credenciales SMTP/IMAP | DNS + credenciales por bóveda; o delegación a Biguá | TI del cliente | Sí para mail | 2 días + 2 semanas de warm-up |
| 7 | **LinkedIn del vendedor:** perfil, Sales Navigator, Dripify; login y 2FA hechos por él en el box | Sesión en el navegador del box | Vendedor | Sí para LinkedIn | 1 sesión de 30 min |
| 8 | **Línea de WhatsApp:** número dedicado, teléfono a mano para el QR, quién aprueba, base legal para primeros contactos (si los hay) | Sesión en el box + manifiesto | Dueño de la línea | Sí para WhatsApp | 1 sesión de 15 min |
| 9 | **CRM:** acceso a HubSpot con token de scopes mínimos, o "ninguno" | Token por bóveda | TI / comercial | No | 1 día |
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
| **ASCI** | Usuario y clave por tenant; rol `sdr_bot` y presupuesto por usuario (pedido a desarrollo de ASCI); `mi_uso` opcional; jobs de Apify parametrizados por mercado y vertical | Rol: no (se usa `operador`). Usuario por tenant: sí |
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
| Rol `sdr_bot` con presupuesto por usuario | Desarrollo de ASCI (Ignacio) | Aislamiento de permisos y de gasto por tenant |
| `mi_uso` para no-admin (opcional) | Desarrollo de ASCI | Mover la sincronización de uso al tenant |
| Scope de conectores por bot; API para exportar/importar plantilla; modelo de membresía de cuentas | Producto de Grok Bot | Propagación de versiones y acceso de Biguá a las cuentas |
| Proveedor de bóveda de secretos | Biguá | Entrega y rotación de credenciales por tenant |
| Proveedor de VPS para boxes | Biguá | Boxes gestionados en vez de máquinas del cliente |
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
| 2 | Box: instalación, clon del repo en el tag, `.env` de casillas (cliente), logins de LinkedIn/Dripify (vendedor), QR de WhatsApp (dueño de la línea), heartbeat | Biguá + cliente | `boxes` con heartbeat y sesiones ok |
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
5. Cierre o entrega de la cuenta de Grok Bot; cierre de sesiones y borrado del perfil de Chrome del box; baja del VPS.

## 5. Plan por fases

| Fase | Alcance | Criterio de salida |
|---|---|---|
| **0 · Cierre de diseño** (1 a 2 semanas) | Decidir los puntos de `01-revision §4`; fijar el esquema del manifiesto; pedir rol `sdr_bot` y scope de conectores; elegir bóveda y VPS | v1.2 del documento aprobada; manifiesto de BairesQA completo |
| **1 · Plano de control mínimo + BairesQA** (4 a 6 semanas) | Migraciones, RLS, RPC, vistas, pg_cron, tests; port de scripts; skills; plantilla; notificador por mail; aprobaciones con token; resúmenes; `provision`; kit de box; migración de BairesQA; corrida en seco; corte desde PasQAlito | BairesQA opera en Grok Bot una semana sin envíos duplicados ni violaciones de DNC |
| **2 · Segundo tenant y estandarización** (3 a 4 semanas) | Alta de Tacco **sólo** con el manifiesto y el runbook; lo que haya que tocar a mano se convierte en código; resumen consolidado de Biguá; playbooks probados | Tacco activo sin cambios ad hoc en el repo; checklist de alta en menos de 3 semanas |
| **3 · Escala** (según demanda) | Rol `sdr_bot` y presupuesto en ASCI; capa MCP `sdr.*`; tablero web y página de aprobación; notificador por WhatsApp; adaptador HubSpot; release automatizado | Tercer tenant en alta con un operador sin intervención de Ignacio |

## 6. Decisiones pendientes para Ignacio y Nicolás

Cada una cambia lo que se construye en fase 1. Recomendación entre paréntesis.

1. Rol del bot en ASCI hasta que exista `sdr_bot`: `operador` con presupuesto en software, o esperar el rol (**`operador`, no esperar**).
2. Dueño de la cuenta de Grok Bot de cada tenant (**Biguá durante el contrato**).
3. Box: VPS de Biguá o máquina del cliente (**VPS de Biguá como default; máquina del cliente como excepción documentada**).
4. Opt-outs por tenant y supresión global sólo técnica/legal (**sí**).
5. Primer contacto por WhatsApp en frío: prohibido salvo base legal declarada (**prohibido por default**).
6. Revisión de baja confianza: operador de Biguá, no el cliente (**sí**).
7. Respuesta de cortesía ante SLA vencido en leads calientes (**habilitada por tenant, texto aprobado de antemano**).
8. Capa MCP `sdr.*` en fase 2, no en fase 1 (**sí**).
9. Un proyecto de Supabase compartido (**sí**).
10. Proveedor de bóveda y de VPS (**a elegir**).
