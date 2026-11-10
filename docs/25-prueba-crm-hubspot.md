# Prueba del CRM con un HubSpot real (etapa 4a)

Checklist para probar la carga en el CRM (`23`) contra un HubSpot de verdad antes de dársela a un
cliente y de decidir la etapa 4b. Los tests del gateway usan un HubSpot simulado; esto confirma lo
que el simulado no puede: los permisos de la app privada, cómo se ve lo cargado y cómo responde
HubSpot de verdad.

**Dónde:** el cliente de prueba **BairesQA** y la cuenta «Empower IT (prueba)» con el prospecto
`ignacio@empower-it.net`, como en las pruebas de la etapa 2 (`14` §3). **Un portal de HubSpot de
prueba de Biguá, nunca el de un cliente**: el gateway no borra nada, así que todo lo que se cree en
la prueba queda en ese portal hasta que alguien lo borre a mano.

**Tiempo:** una hora y media, más lo que tarde en responder el mail de prueba.

## 1. Qué tiene que quedar respondido

| # | Pregunta | Dónde se responde |
|---|---|---|
| P1 | ¿Alcanzan los scopes de la guía (`23` §13.2) para crear **notas y tareas**? | Prueba 3 |
| P2 | ¿`/account-info` pide un permiso extra? (Si lo pide, falta el enlace «Ver en HubSpot», nada más) | Prueba 2 |
| P3 | ¿Cómo se ven en HubSpot la nota y la tarea (el HTML, los saltos, el texto escapado)? | Prueba 3 |
| P4 | ¿El buscador de HubSpot tarda en ver un contacto nuevo? ¿El 409 trae el id? | Prueba 5 |
| P5 | ¿Qué tan útil le resulta al vendedor lo mínimo? ¿Hace falta la capa 2 (4b)? | §5 |

## 2. Preparación

| # | Paso | Cómo | Listo |
|---|---|---|---|
| 0.1 | Portal de prueba | Una cuenta de HubSpot de Biguá (la gratuita alcanza para contactos, empresas, notas y tareas). Anotar el número de portal | ☐ |
| 0.2 | Dos usuarios en el portal | El dueño de la cuenta y un segundo usuario («vendedor B»), para probar el dueño por defecto y el dueño de un contacto existente | ☐ |
| 0.3 | Propiedad de origen | En Settings → Properties → Contact, una propiedad de lista «Origen del lead» con un valor «SDR Biguá» (interno `sdr_bigua`) | ☐ |
| 0.4 | Contacto existente | Crear a mano un contacto con email `existente@empower-it.net`, cargo «Director» y dueño «vendedor B» (para la prueba 4) | ☐ |
| 0.5 | App privada | Settings → Integrations → Private Apps → Create, nombre «SDR Biguá (prueba)», con los scopes de `23` §13.2: `crm.objects.contacts.read` y `.write`, `crm.objects.companies.read` y `.write`, `crm.objects.owners.read`, `crm.schemas.contacts.read`. Copiar el token | ☐ |
| 0.6 | BairesQA en canario | Las reglas del CRM están en `2026.11.10-4`, sólo en canario. Panel → BairesQA → ⚙ Administración → Operación → canal `canario` (o `sdr-config`). **Volverlo a `estable` al terminar** | ☐ |
| 0.7 | Reloj andando | Panel → Resumen sin despertadores ni corridas en rojo; la carga corre en la vuelta del reloj, cada minuto | ☐ |

## 3. Pruebas

Cada prueba dice qué hacer, qué tiene que pasar y dónde mirarlo. Para mirar la base, las consultas
de §4.

### Prueba 1 · Conectar

| Hacer | Tiene que pasar | Listo |
|---|---|---|
| Panel → BairesQA → Canales → CRM: pegar el token y **Conectar HubSpot** | La tarjeta dice «conectado». El token no aparece en ningún lado (ni en el panel ni en la auditoría) | ☐ |
| **Probar conexión** | «listo», con el número de portal (P2: si no aparece el portal pero dice «listo», la app no lee los datos de la cuenta; anotarlo) | ☐ |
| Elegir «Origen del lead» → «SDR Biguá» y el dueño por defecto (el dueño de la cuenta). **Guardar** | Se guarda sin error | ☐ |
| Elegir como origen una propiedad del mínimo (por ejemplo `email`, si aparece en la lista) | Rechazado: «lo completa la carga con los datos del prospecto» | ☐ |
| **Vista previa** | Muestra un positivo de ejemplo (o el último real) con contacto, empresa, nota y tarea. No escribe nada en HubSpot (el portal sigue igual) | ☐ |

### Prueba 2 · Permisos de lectura

| Hacer | Tiene que pasar | Listo |
|---|---|---|
| En la app privada, sacar `crm.objects.owners.read` y **Probar conexión** | «falta algo», con el permiso que falta. La tarjeta pasa a «token rechazado» | ☐ |
| Volver a poner el scope y **Probar** | «listo» y la tarjeta vuelve a «conectado» | ☐ |

(Si al sacar el scope HubSpot pide rotar el token, cargar el nuevo en el panel.)

### Prueba 3 · Positivo nuevo, de punta a punta

| Hacer | Tiene que pasar | Listo |
|---|---|---|
| Que el `prospector` le escriba a `ignacio@empower-it.net` (o usar un mail ya enviado) y contestar desde ahí: «Me interesa, ¿hablamos el jueves? <prueba>» | `seguimiento` registra el positivo y pide la aprobación de la respuesta (prueba 11 de `14`) | ☐ |
| En el chat del `orquestador`, aprobar la respuesta | La confirmación del orquestador dice que el positivo entra solo al CRM | ☐ |
| Esperar uno o dos minutos | En Canales → CRM, la carga pasa a «cargado» con «Ver en HubSpot» | ☐ |
| Abrir el contacto en HubSpot | Nombre, apellido, email, cargo y empresa del registro; «Origen del lead» = «SDR Biguá»; dueño = el dueño por defecto | ☐ |
| La empresa | Una empresa con el dominio de la cuenta, asociada al contacto (o la que ya existía con ese dominio) | ☐ |
| La nota (P3) | Se lee bien: qué pide, lo que respondió (con `<prueba>` como texto, no como etiqueta), la respuesta aprobada y la referencia al registro | ☐ |
| La tarea (P1, P3) | Existe, asignada al dueño, vence el día hábil siguiente, prioridad alta, y el cuerpo se lee bien. Si la nota o la tarea no se crearon por permisos, la conexión queda en «token rechazado» con el scope que falta: sumarlo y anotarlo en `23` §13.2 | ☐ |
| El registro | El prospecto quedó `en_crm` con su `crm_id`, hay un evento `crm.cargado` y la carga tiene los cuatro pasos en `cambios` (§4) | ☐ |
| Volver a pedir la carga: «cargá a Ignacio en el CRM» en el chat del orquestador | Dice que ya está cargado; en HubSpot no aparece nada nuevo | ☐ |

### Prueba 4 · Contacto que ya existía

| Hacer | Tiene que pasar | Listo |
|---|---|---|
| Registrar un prospecto con `existente@empower-it.net` (`registro_guardar_prospecto` desde el chat del orquestador) y pedir «cargalo en el CRM» | La carga termina «cargado» | ☐ |
| Abrir el contacto en HubSpot | Sigue uno solo. El cargo sigue «Director» (no se pisó), el dueño sigue «vendedor B», y se completaron los campos que estaban vacíos | ☐ |
| La tarea | Asignada a «vendedor B», no al dueño por defecto | ☐ |

### Prueba 5 · Buscador atrasado (P4)

| Hacer | Tiene que pasar | Listo |
|---|---|---|
| Crear a mano en HubSpot un contacto `nuevo@empower-it.net` e **inmediatamente** registrarlo y pedir la carga | Termina «cargado» sobre ese mismo contacto, sin duplicado. Si HubSpot no lo veía todavía, el alta dio 409 y se usó el id que trae; anotar si pasó | ☐ |

### Prueba 6 · Fallas

| Hacer | Tiene que pasar | Listo |
|---|---|---|
| Sin email: registrar un prospecto sin email y pedir la carga | Queda «bloqueada» con el motivo, sin tocar HubSpot; el orquestador recibe un pedido para contarlo | ☐ |
| Token revocado: en HubSpot, rotar el token de la app y pedir una carga | La tarjeta pasa a «token rechazado» y el Resumen lo avisa; la carga queda **en cola** sin gastar intentos | ☐ |
| Cargar el token nuevo en el panel | La cola sigue sola en el próximo minuto y la carga termina «cargada» | ☐ |
| Dato rechazado: en HubSpot, borrar el valor «SDR Biguá» de la propiedad de origen y pedir una carga | Queda «bloqueada» con el mensaje de HubSpot; el orquestador recibe el pedido | ☐ |
| Volver a crear el valor y **Reintentar** desde la lista de cargas | Termina «cargada» | ☐ |
| **Pausar** desde la tarjeta y pedir una carga | Queda en cola. **Reanudar**: se carga | ☐ |

### Prueba 7 · Lo que ve el cliente

| Hacer | Tiene que pasar | Listo |
|---|---|---|
| Entrar al panel con el usuario de BairesQA (no Biguá) | Ve Canales → CRM, prueba, vista previa, cargas y puede pausar. No ve ni puede cambiar los campos fijos ni el tope | ☐ |
| Resumen | El canal «CRM · HubSpot» con los cargados de la semana; los avisos de las fallas de la prueba 6 mientras duraron | ☐ |

## 4. Consultas para mirar la base

En el MCP de Supabase (proyecto `sdrbot`), con el id del cliente de BairesQA:

```sql
-- Las cargas, con su estado, intentos, error y lo que creó cada paso.
select id, prospecto_id, motivo, estado, intentos, error, crm_ids, cambios, hecha_at
  from sdr.crm_carga where client_id = '<cliente>' order by id desc limit 20;

-- La conexión, sin el token.
select estado, portal_id, origen_campo, origen_valor, dueno_defecto, campos_fijos, tope_dia, ultimo_ok_at, ultimo_error
  from sdr.crm_conexion where client_id = '<cliente>';

-- Los eventos de carga y los pedidos que dejó el gateway al orquestador.
select at, tipo, ref, datos from sdr.evento where client_id = '<cliente>' and tipo = 'crm.cargado' order by id desc limit 10;
select creado_at, para_bot, que, estado from sdr.pedido where client_id = '<cliente>' and de_bot = 'gateway' order by id desc limit 10;

-- Lo que hizo el reloj en su última vuelta (la parte crm).
select ultimo_tick_at, ultimo_resultado->'crm' from sdr.reloj;
```

## 5. Al terminar

| # | Paso | Listo |
|---|---|---|
| 5.1 | BairesQA vuelve a `estable` | ☐ |
| 5.2 | Anotar en `23` §13 lo que salió de P1 a P4. Si hizo falta otro scope, corregir `23` §13.2, la guía del cliente (`16` §7.1) y el texto de ayuda del panel | ☐ |
| 5.3 | P5 con quien vaya a usar el CRM: ¿la nota y la tarea alcanzan para responder bien? ¿Qué campos del cliente se extrañan? Con eso se decide si la 4b (capa 2) vale el costo, o si alcanza con lo mínimo más algunos campos fijos | ☐ |
| 5.4 | Desconectar el CRM de BairesQA si no va a seguir usándolo (pausar la conexión en el panel) | ☐ |
| 5.5 | Borrar en el portal de prueba lo creado, si molesta (a mano: el gateway no borra) | ☐ |
| 5.6 | Si todo pasó: pasar `estable` a `2026.11.10-4` (`playbooks-canal estable 2026.11.10-4`) | ☐ |
