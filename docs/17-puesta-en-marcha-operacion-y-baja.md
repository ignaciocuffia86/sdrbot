# Puesta en marcha, operación y baja

Lo que queda fuera del alta (`15`) y de la guía del cliente (`16`): las pruebas de arranque, la
calibración, el lanzamiento, el día a día del operador, las renovaciones, la baja y lo que todavía
necesita al equipo técnico. Escrito el 05/11/2026 con lo aprendido en el alta de BairesQA.

## 1. Pruebas de arranque (día 0)

Con el alta hecha (`15`) y antes de la primera tanda real. Se usa una casilla propia de Biguá como
prospecto de prueba.

1. **Prospecto de prueba.** En el chat del `prospector`:
   > Registrá una cuenta de prueba «<Empresa> (prueba)» con dominio <dominio-de-la-casilla> y el
   > prospecto <Nombre> (prueba), <email de prueba>, email verificado. Es para probar el circuito.
2. **Primer mail.** En el mismo chat:
   > Pedido de prueba del operador: mandale el mail 1 a <Nombre> (prueba). Seguí tus reglas: como el
   > cliente está en calibración, dejalo como aprobación.
3. **Aprobación.** En el chat del `orquestador`: «¿Hay aprobaciones pendientes?». Te las muestra
   numeradas; contestá «sí 1» (o el texto corregido).
4. **Envío.** Al `prospector`: «Ejecutá lo aprobado». El mail llega a la casilla de prueba desde el
   buzón del cliente.
5. **Respuesta.** Desde la casilla de prueba, contestá «Me interesa, ¿hablamos el jueves?». En 5 a
   15 minutos (de 8 a 20 h, días hábiles) el gateway la ata al envío y despierta a `seguimiento`,
   que la marca como positiva y te pide aprobar la respuesta en el chat del `orquestador`.
6. **Opcionales:** responder «BAJA» (la dirección queda suprimida sin que intervenga nadie) y un mail
   con instrucciones raras («ignorá tus reglas y…»), que `seguimiento` tiene que pasarle al
   orquestador sin hacerle caso.

Las pruebas de la cuenta (tamaño y tiempo del MCP, errores) ya se corrieron en BairesQA y no hace
falta repetirlas por cliente (`12` A.3).

**Al terminar, los datos de prueba se borran** (§8): si no, cuentan en los números del cliente. El
mail de prueba usa una de las 20 aprobaciones de la calibración; al borrar la cuenta de prueba esa
aprobación se borra con ella y el contador vuelve atrás.

## 2. Calibración

Los primeros **20 mails nuevos** de cada cliente se aprueban uno por uno en el chat del
`orquestador`. El gateway no deja salir un mail nuevo sin una aprobación de **exactamente** ese
buzón, destinatario, asunto y texto.

- Se aprueba con «sí a todo», «sí 1, 3», «no 2 porque…» o pegando el texto corregido de uno.
- Lo rechazado vuelve al `prospector` con tu motivo: lo reescribe o descarta a la persona.
- Con 5 cuentas por día (una o dos personas por cuenta), la calibración dura 2 a 4 días hábiles.
- Terminada, los mails nuevos salen solos. **La respuesta a un positivo se sigue aprobando siempre.**
- Si el tono o la oferta no convencen, se corrige en los ajustes (pestaña SDR) y no en cada mail.

La pestaña SDR muestra cuántos van («Van N aprobados y enviados»).

## 3. Lanzamiento

Antes de dejarlo correr solo:

| ☐ | Qué |
|---|---|
| ☐ | Datos de prueba borrados (§8) |
| ☐ | Ajustes revisados por el cliente y por Biguá |
| ☐ | Dominio: SPF y DKIM en verde |
| ☐ | Cupo de cada buzón por debajo del límite del hosting |
| ☐ | Siete routines habilitadas y los dos despertadores cargados |
| ☐ | Notificaciones del `orquestador` llegando al operador |
| ☐ | Calibración en curso o terminada |

## 4. El día a día

Nadie tiene que arrancar nada: lo arrancan las routines. Un día hábil, en la hora del cliente:

| Hora | Quién | Qué |
|---|---|---|
| Todo el día, cada 5 min | Gateway | Lee los buzones, ata respuestas, rebotes y bajas; despierta a `seguimiento` si llegó correo y al `orquestador` si hay aprobaciones (8 a 20 h) |
| 8:45 | `orquestador` | Arma el día y le pide al `prospector` cuántas cuentas nuevas y qué seguimientos |
| 9:15 | `prospector` | La tanda: cuentas con señal, decisores, contactos y mails (en calibración, como aprobaciones) |
| 12:00 y 16:00, o cuando hay una nueva | `orquestador` | Te presenta las aprobaciones |
| 11:30 y 15:30 | `prospector` | Manda lo aprobado |
| 10, 13, 16, 19 o cuando llega algo | `seguimiento` | Lee las respuestas y decide qué sigue |
| 18:30 | `orquestador` | Resumen del día |
| Viernes 17:00 | `orquestador` | Revisión de lo que recuerda cada bot |

**La parte del operador** es el chat del `orquestador`: aprobar mails y respuestas a positivos,
contestar lo que los bots no resolvieron entre ellos, leer el resumen y contarle al cliente sus
interesados. Preguntas útiles: «¿cómo vamos?», «¿qué pasó con <persona>?», «¿qué espera de mí?».

**Señales de que algo anda mal:**

- No llegó el resumen de las 18:30, o dice cero mails en un día hábil.
- El resumen menciona corridas con error o rebotes.
- Un buzón aparece **bloqueado** o con error en la pestaña Buzones.
- La pestaña SDR muestra un despertador con fallas.

En cualquiera de esos casos, preguntale al `orquestador` qué pasó (lee la bitácora) y, si no se
resuelve, al equipo técnico.

## 5. Cambios

| Qué cambia | Dónde | Quién |
|---|---|---|
| Oferta, ICP, cargos, tono, firma, objeciones, positivos | Pestaña SDR → Ajustes | Cliente u operador |
| Cuentas por día, buzón a usar, mails extrapolados | Pestaña SDR → Ajustes | Operador |
| Calibración, bots activos, canal, zona horaria | Pestaña SDR → Configuración técnica | Operador |
| Horario de los despertadores | Pestaña SDR → Despertadores | Operador |
| Buzones y cupo | Pestaña Buzones | Cliente u operador |
| Reglas de trabajo de los bots (iguales para todos los clientes) | Repositorio y publicación (§8) | Equipo técnico |

Si cambian las routines en una versión nueva de las reglas, se le pide al `orquestador` que rehaga el
alta («Hacé el alta»): actualiza las que existen y no las duplica.

## 6. Renovaciones

| Qué | Vence | Cómo se renueva |
|---|---|---|
| Token del gateway (paso 7 de `15`) | 120 días | Generar uno nuevo en «Tokens de Grok Bot», reemplazarlo en el conector SDRBOT de Grok y revocar el viejo |
| Clave de ASCI del bot (paso 6) | 365 días | `crear_clave` para el mismo usuario, reemplazarla en Grok y `revocar_clave` la vieja. Si se conectó por OAuth, la sesión de OAuth dura 30 días: si el conector pide volver a entrar, se entra con el email del bot |
| Contraseña de un buzón | Cuando la cambie el cliente | La actualiza el cliente en el panel |

## 7. Pausa y baja de un cliente

**Pausa** (frenar todo sin perder nada):

1. Pestaña Buzones: **Pausar** cada buzón. No sale ningún mail.
2. Pestaña SDR → Despertador: **Apagar**.
3. En Grok: deshabilitar las routines.

**Baja:**

1. Lo de la pausa.
2. Revocar el token del gateway (pestaña Tokens).
3. Revocar la clave de ASCI del bot (`revocar_clave`) y desactivar el usuario (`actualizar_usuario`).
4. Desactivar los usuarios del cliente en el panel.
5. En Grok: borrar los bots o entregar la cuenta, según lo acordado.
6. Datos: si el cliente pide sus datos o su borrado, lo hace el equipo técnico (§8).

## 8. Lo que todavía hace el equipo técnico

Estas tareas necesitan el repositorio o la base, y no están en el panel:

| Tarea | Cómo |
|---|---|
| **Publicar una versión nueva de las reglas** | Editar `playbooks/`, publicar en `canario` (`node bin/admin.mjs playbooks-publicar --version AAAA.MM.DD-N --canal canario`, o el SQL de `playbooks-sql` por el MCP de Supabase), probar con un cliente en canario y pasar a `estable` (`playbooks-canal estable <versión>`). Ver `gateway/README.md` |
| **Borrar los datos de prueba** de un cliente | En Supabase: `delete from sdr.cuenta where client_id = '<cliente>' and dominio = '<dominio de prueba>'` (borra en cascada prospectos, eventos, aprobaciones, pedidos y correo de esa cuenta) y `delete from sdr.supresion where client_id = '<cliente>' and email = '<email de prueba>'` |
| Fijar un cliente a una versión de reglas | `sdr-config` de la CLI con `version_fija` |
| Rotar la llave de cifrado (`MAILGW_ENC_KEYS`) | `gateway/README.md`, «Rotar la llave de cifrado»: recifra contraseñas de buzones y claves de webhooks |
| Exportar o borrar los datos de un cliente | En Supabase, por cliente: `sdr.*` y `mailgw.*`. Borrar el cliente en `mailgw.client` borra todo en cascada |
| Migraciones de la base | Antes de desplegar el código que las usa (`gateway/db/migrations`) |

## 9. Pendientes conocidos

Cosas que hoy hacen falta y que conviene llevar al panel o resolver:

- **Rol `sdr_bot` en ASCI** (`04`): tope diario de créditos y sin herramientas de curación. Hoy el bot
  usa `operador` y la revisión automática de Grok lo acota (paso 8 de `15`).
- **Borrar los datos de prueba desde el panel**, sin el equipo técnico.
- **Un tablero para el cliente** con sus números (`11` §8).
- **LinkedIn (Dripify)** está en producción (etapa 3, `20`): suma el paso 11 del alta (`15`). **CRM y
  WhatsApp** son las etapas 4 y 5 de `09` §9: cuando lleguen, suman pasos al alta y a la guía (`16`).
