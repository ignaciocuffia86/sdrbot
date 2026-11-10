# Guía del cliente: cómo configurar tu SDR

Esta guía es para la persona del cliente que configura el SDR de Biguá: sus buzones, su dominio y
cómo los bots presentan su empresa. Todo se hace en el panel, sin instalar nada:

**`https://sdrbot.bigua.lat/admin`**

## Cómo trabaja el SDR, en corto

Tres bots trabajan para tu empresa todos los días hábiles:

- **Orquestador:** arma el día y le presenta a Biguá lo que hay que aprobar.
- **Prospector:** busca empresas que hoy tienen una razón para comprarte (por ejemplo, un aviso de
  empleo abierto), elige a quién escribirle y escribe el mail.
- **Seguimiento:** lee las respuestas y decide qué sigue con cada persona.

Los mails salen **desde tus buzones**, con tu firma. Al principio, cada mail nuevo lo aprueba una
persona de Biguá antes de que salga (los primeros 20). Una respuesta interesada se contesta siempre
con aprobación.

| Lo manejás vos | Lo maneja Biguá |
|---|---|
| Tus buzones y sus contraseñas | Cuántas empresas nuevas por día |
| Tu dominio (SPF, DKIM, DMARC) | Las aprobaciones de mails |
| La oferta, a quién le venden, los cargos, el tono, las firmas, los casos que se pueden citar, las objeciones, qué cuenta como respuesta positiva y a quién no escribirle nunca | Las reglas de trabajo de los bots, la calibración y los horarios |

## 1. Activar tu usuario

Biguá te manda un **enlace de activación**. Sirve una sola vez y por 24 horas: si venció, pedí otro.
Elegí una contraseña de al menos 12 caracteres. Cada persona tiene su propio usuario: no lo
compartas.

Después entrás con tu email y tu contraseña. Ves sólo tu empresa.

## 2. Cargar tus buzones

El panel tiene cuatro pestañas: **Resumen** (lo que necesita atención y cómo viene la semana),
**Empresa** (lo que los bots saben de tu empresa), **Canales** (tus buzones, tu dominio y LinkedIn)
y **Actividad**.

Pestaña **Canales** → **Agregar buzón**.

| Campo | Qué poner |
|---|---|
| Email del buzón | La dirección desde la que salen los mails (por ejemplo `nombre@tuempresa.com`) |
| Nombre que ve el destinatario | El nombre de quien firma: «Ana Pérez» |
| Firma | La firma de esa persona, tal como va al pie de cada mail. Vacía, va la firma por defecto de Empresa |
| Usuario de login | Casi siempre es el mismo email |
| Contraseña del buzón | La de esa casilla. Se guarda cifrada y nadie la vuelve a ver, ni Biguá |
| Entrada (IMAP) y Salida (SMTP) | Servidor y puerto: están en el panel de tu hosting o en la configuración de tu programa de correo. Lo más común es TLS con 993 (IMAP) y 465 (SMTP) |
| Tope de envíos por día | Por debajo del límite que te da tu hosting. Para empezar, entre 20 y 40 |
| Guardar copia en enviados | Dejalo marcado: así ves en tu correo lo que mandó el bot |

Después tocá **Probar**: tienen que decir «conecta» IMAP y SMTP.

- **Si cambiás la contraseña de la casilla**, actualizala en el panel («Contraseña»). Tres intentos
  fallidos seguidos bloquean el buzón en el panel; se desbloquea cargando la correcta.
- **Para frenar los envíos** de un buzón, **Pausar**. Nada sale de ahí hasta que lo reactives.

El gateway lee la bandeja de entrada para encontrar las respuestas a los mails del SDR. Sólo guarda
lo que es respuesta, rebote o baja de un mail que mandó el SDR. El resto de tu correo no se guarda
ni se toca, y nunca se borra nada.

## 3. Tu dominio: SPF, DKIM y DMARC

Son registros del DNS de tu dominio que les dicen a Gmail, Outlook y los demás que tus mails son
legítimos. Sin ellos, los mails del SDR van a spam.

Pestaña **Canales**, debajo de los buzones → **Verificar**. Cada registro aparece en verde, amarillo o rojo, y cada aviso
trae **«Cómo arreglarlo»**: los pasos y el registro listo para copiar en el DNS. Se lo pasás a quien
administra tu dominio (tu área de sistemas o tu proveedor) y, cuando lo publique, volvés a
verificar. Un cambio de DNS puede tardar desde minutos hasta unas horas en verse.

**SPF y DKIM tienen que estar en verde** antes del primer envío.

## 4. Los ajustes de tu SDR

Pestaña **Empresa**. Es lo que los bots leen sobre tu empresa antes de cada tarea. Los cambios valen
desde la próxima corrida de cada bot (en el día), y Biguá recibe un aviso de qué cambiaste.

A la derecha, **«Así lo leen los bots»** muestra el resultado tal cual.

**Identidad y voz**

| Campo | Qué poner | Ejemplo |
|---|---|---|
| Nombre comercial | Cómo se presenta tu empresa | BairesQA |
| Oferta | Qué ofrecen y para qué sirve, en dos o tres líneas | «QA funcional y automatizado como servicio: equipos de testing que se suman al equipo del cliente, para web, mobile y API.» |
| Tono | Cómo escriben | «Directo y técnico, sin superlativos ni signos de exclamación.» |
| Idioma y trato | Idioma y si va de vos o de usted | «Español; de vos en Argentina, de usted en Chile.» |
| Firma por defecto | Para los buzones sin firma propia (cada buzón tiene la suya en Canales) | «Equipo comercial · TuEmpresa» |
| Casos y datos que se pueden citar | Uno por renglón, con su fuente. Es lo único que los bots citan como resultado | «Banca: regresión de 5 días a 6 horas (caso publicado)» |

**A quién y con qué señal**

| Campo | Qué poner | Ejemplo |
|---|---|---|
| A quién le venden | País, industrias, tamaño y las señales que importan | «Empresas de Argentina de más de 200 empleados, en banca, seguros y software, con avisos de QA abiertos.» |
| Cargos a los que se escribe | Uno por renglón. Es a quién se revela el contacto | Head of QA · QA Manager · CTO |
| Tipos de empresa y cargos a evitar | Uno por renglón. Las empresas puntuales van en «No contactar» (§5) | Consultoras y staffing · Cargos junior |

**Conversación**

| Campo | Qué poner | Ejemplo |
|---|---|---|
| Qué le pedimos al prospecto | El pedido del final del primer mail | «Una charla de 20 minutos esta semana» |
| Objeciones y cómo responderlas | Una por renglón: lo que dicen y cómo se responde | «"Ya tenemos QA": ofrecemos cubrir picos o automatizar lo repetitivo.» |
| Qué cuenta como respuesta positiva | Uno por renglón | Interesado · Pide reunión · Pide información |
| Quién toma a los interesados | El nombre de quien sigue la conversación | «Ana Pérez» |
| Mail de quien toma a los interesados | Su casilla del **dominio principal**. Va en copia en la respuesta a un interesado (§7) | `ana@tuempresa.com` |
| Link de agenda | Para que un interesado elija horario. Va sólo en la respuesta a un positivo | `https://calendly.com/tuempresa/20min` |

**Operación:** cuántas empresas nuevas por día, qué buzón usar para qué y si se escribe a mails
deducidos. Los decide Biguá, salvo que tu cuenta sea autogestionada: entonces los cambiás vos (las
empresas por día, hasta el tope que acordaste con Biguá).

Algunos consejos:

- **Sin promesas que no puedas cumplir.** Los bots no inventan precios, plazos ni casos de éxito,
  pero repiten lo que diga la oferta y lo que cargues en los casos. Si ponés «en 2 semanas», van a
  decir «en 2 semanas».
- **Corto y concreto.** Una oferta de tres líneas funciona mejor que un folleto.
- **Los cargos mandan el gasto:** cada contacto revelado cuesta. Poné sólo los cargos a los que de
  verdad querés escribirle.
- **No sirve escribir instrucciones** para los bots («escribí más largo», «ignorá…»): las reglas de
  trabajo son las mismas para todos los clientes y las cuida Biguá. Si algo no te gusta de cómo
  escriben, contáselo a Biguá.

Abajo está el **historial**: cada cambio con quién lo hizo y cuándo. **«Volver a esta»** recupera
una versión anterior.

Los campos con un candado (🔒) se los pedís a Biguá.

## 5. No contactar

En la misma pestaña **Empresa**, más abajo. Son las empresas y las personas a las que el SDR no les
escribe nunca, por ningún canal: tus clientes actuales, partners, competidores, alguien que pidió que
no lo contacten.

- Un **dominio** (`empresa.com`) cubre a toda la empresa, también sus subdominios
  (`ventas.empresa.com`). Un **mail** cubre sólo a esa persona.
- Se cargan de a uno, **pegando una lista** o con **Cargar CSV**: primera columna el dominio o el
  mail y segunda, opcional, el motivo. Podés exportar la lista de clientes de tu CRM y subirla.
- No depende de que los bots se acuerden: el sistema rechaza cualquier mail o invitación de LinkedIn
  a alguien de la lista, y una empresa de la lista queda excluida apenas aparece.
- «Quitar» la saca de la lista; queda en la actividad quién lo hizo.

## 6. Actividad

La pestaña **Actividad** muestra lo que pasó en tu cuenta: buzones cargados, pruebas de conexión,
verificaciones de dominio, cambios de ajustes y lo que hicieron los bots, con fecha y resultado.

## 7. Las respuestas y los interesados

- Las respuestas llegan a **tu buzón** como siempre; además el SDR las lee y decide qué sigue.
- A una persona **interesada** se le contesta con aprobación de Biguá, en el mismo hilo, desde tu
  buzón. Biguá te avisa de cada interesado y, si conectás tu HubSpot (§7.1), entra solo ahí.
- **La derivación.** Esa respuesta va con copia a quien toma a los interesados, en su casilla del
  dominio principal («te sumo a Ana, que lleva esto de nuestro lado»). Ana contesta *a todos*
  desde su casilla y la conversación sigue con ella. Desde ahí el SDR no le escribe más a esa
  persona (ni mail ni LinkedIn), y lo que Ana escriba en el hilo no lo toma como una respuesta del
  prospecto. Si el prospecto le vuelve a escribir a la casilla secundaria, el SDR sólo le recuerda
  que lo sigue Ana. La copia va sólo a esa casilla o a alguien de su mismo dominio.
- **Personas reales.** Cada casilla secundaria lleva el nombre de una persona de tu equipo que
  existe (la misma que toma a los interesados, o alguien de tu equipo comercial), no un nombre
  inventado: el interesado la va a conocer en la reunión.
- Si alguien **pide la baja** o el mail **rebota**, el SDR no le vuelve a escribir desde ningún
  buzón de tu empresa.
- Cuando una persona responde, el SDR no le manda otro mail de la secuencia: lo que sigue lo decide
  el bot de seguimiento.
- Si le escribís vos a un prospecto por fuera del SDR, avisale a Biguá para que el bot no le siga
  escribiendo: el SDR lee las respuestas que llegan, no lo que mandás vos.

### 7.1 Tu HubSpot

Si usás HubSpot, cada interesado que Biguá aprueba entra solo a tu CRM: el contacto (si ya lo
tenías, sólo se completa lo que está vacío y no se cambia el vendedor asignado), la empresa, una
nota con lo que respondió y una tarea para el vendedor, que vence el día hábil siguiente. Nunca se
borra nada.

1. En HubSpot: **Settings → Integrations → Private Apps → Create a private app**. Nombre: «SDR
   Biguá». En **Scopes**, marcá: `crm.objects.contacts` (read y write), `crm.objects.companies`
   (read y write), `crm.objects.owners.read` y `crm.schemas.contacts.read`. Creala y copiá el token.
2. En el panel: **Canales → CRM**, pegá el token y apretá **Conectar HubSpot**. No lo mandes por
   mail ni por chat.
3. **Probar conexión** tiene que decir «listo». Elegí la propiedad que dice de dónde vino el
   contacto (si tenés una, por ejemplo «Origen del lead») con su valor, y quién recibe las tareas
   de los contactos nuevos. **Guardar**.
4. **Vista previa** te muestra cómo va a quedar un interesado, sin escribir nada en HubSpot.

Abajo ves cada carga: cargada (con el enlace al contacto), en cola o con un problema. Si cambiás o
revocás el token, las cargas esperan en cola hasta que cargues uno nuevo. **Pausar** las frena sin
perderlas.

## 8. Cuándo hablar con Biguá

- Querés **más o menos volumen**, o frenar todo un tiempo.
- Vas a **sumar o sacar un buzón**, o cambiar qué buzón se usa para qué.
- Cambió algo importante (la oferta, el equipo comercial, un cliente que no hay que tocar).
- Algo de cómo escriben los bots no te convence.

## Seguridad

- Las contraseñas de los buzones se cargan sólo en el panel. Nunca las mandes por mail ni por chat,
  tampoco a Biguá.
- Cada persona con su usuario. Si alguien deja la empresa, pedile a Biguá que lo desactive.
