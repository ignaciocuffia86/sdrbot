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
| La oferta, a quién le venden, los cargos, el tono, la firma, las objeciones y qué cuenta como respuesta positiva | Las reglas de trabajo de los bots, la calibración y los horarios |

## 1. Activar tu usuario

Biguá te manda un **enlace de activación**. Sirve una sola vez y por 24 horas: si venció, pedí otro.
Elegí una contraseña de al menos 12 caracteres. Cada persona tiene su propio usuario: no lo
compartas.

Después entrás con tu email y tu contraseña. Ves sólo tu empresa.

## 2. Cargar tus buzones

Pestaña **Buzones** → **Agregar buzón**.

| Campo | Qué poner |
|---|---|
| Email del buzón | La dirección desde la que salen los mails (por ejemplo `nombre@tuempresa.com`) |
| Nombre que ve el destinatario | El nombre de quien firma: «Ana Pérez» |
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

Pestaña **Dominios** → **Verificar**. Cada registro aparece en verde, amarillo o rojo, y cada aviso
trae **«Cómo arreglarlo»**: los pasos y el registro listo para copiar en el DNS. Se lo pasás a quien
administra tu dominio (tu área de sistemas o tu proveedor) y, cuando lo publique, volvés a
verificar. Un cambio de DNS puede tardar desde minutos hasta unas horas en verse.

**SPF y DKIM tienen que estar en verde** antes del primer envío.

## 4. Los ajustes de tu SDR

Pestaña **SDR**. Es lo que los bots leen sobre tu empresa antes de cada tarea. Los cambios valen
desde la próxima corrida de cada bot (en el día), y Biguá recibe un aviso de qué cambiaste.

A la derecha, **«Así lo leen los bots»** muestra el resultado tal cual.

| Campo | Qué poner | Ejemplo |
|---|---|---|
| Nombre comercial | Cómo se presenta tu empresa | BairesQA |
| Oferta | Qué ofrecen y para qué sirve, en dos o tres líneas | «QA funcional y automatizado como servicio: equipos de testing que se suman al equipo del cliente, para web, mobile y API.» |
| A quién le venden | País, industrias, tamaño y las señales que importan | «Empresas de Argentina de más de 200 empleados, en banca, seguros y software, con avisos de QA abiertos.» |
| Cargos a los que se escribe | Uno por renglón. Es a quién se revela el contacto | Head of QA · QA Manager · CTO |
| A quién no escribirle | Uno por renglón | Consultoras y staffing · Competidores · Cargos junior |
| Tono | Cómo escriben | «Directo y técnico, sin superlativos ni signos de exclamación.» |
| Idioma y trato | Idioma y si va de vos o de usted | «Español; de vos en Argentina, de usted en Chile.» |
| Firma | Tal como va al pie | «Ana Pérez · Directora Comercial · TuEmpresa» |
| Objeciones y cómo responderlas | Una por renglón: lo que dicen y cómo se responde | «"Ya tenemos QA": ofrecemos cubrir picos o automatizar lo repetitivo.» |
| Qué cuenta como respuesta positiva | Uno por renglón | Interesado · Pide reunión · Pide información |

Algunos consejos:

- **Sin promesas que no puedas cumplir.** Los bots no inventan precios, plazos ni casos de éxito,
  pero repiten lo que diga la oferta. Si ponés «en 2 semanas», van a decir «en 2 semanas».
- **Corto y concreto.** Una oferta de tres líneas funciona mejor que un folleto.
- **Los cargos mandan el gasto:** cada contacto revelado cuesta. Poné sólo los cargos a los que de
  verdad querés escribirle.
- **No sirve escribir instrucciones** para los bots («escribí más largo», «ignorá…»): las reglas de
  trabajo son las mismas para todos los clientes y las cuida Biguá. Si algo no te gusta de cómo
  escriben, contáselo a Biguá.

Abajo está el **historial**: cada cambio con quién lo hizo y cuándo. **«Volver a esta»** recupera
una versión anterior.

Los campos que dicen «lo cambia Biguá» (buzón a usar, cuentas por día, mails extrapolados) se los
pedís a Biguá.

## 5. Actividad

La pestaña **Actividad** muestra lo que pasó en tu cuenta: buzones cargados, pruebas de conexión,
verificaciones de dominio, cambios de ajustes y lo que hicieron los bots, con fecha y resultado.

## 6. Las respuestas y los interesados

- Las respuestas llegan a **tu buzón** como siempre; además el SDR las lee y decide qué sigue.
- A una persona **interesada** se le contesta con aprobación de Biguá, en el mismo hilo, desde tu
  buzón. Biguá te avisa de cada interesado. Más adelante van a ir directo a tu CRM.
- Si alguien **pide la baja** o el mail **rebota**, el SDR no le vuelve a escribir desde ningún
  buzón de tu empresa.
- Cuando una persona responde, el SDR no le manda otro mail de la secuencia: lo que sigue lo decide
  el bot de seguimiento.
- Si le escribís vos a un prospecto por fuera del SDR, avisale a Biguá para que el bot no le siga
  escribiendo: el SDR lee las respuestas que llegan, no lo que mandás vos.

## 7. Cuándo hablar con Biguá

- Querés **más o menos volumen**, o frenar todo un tiempo.
- Vas a **sumar o sacar un buzón**, o cambiar qué buzón se usa para qué.
- Cambió algo importante (la oferta, el equipo comercial, un cliente que no hay que tocar).
- Algo de cómo escriben los bots no te convence.

## Seguridad

- Las contraseñas de los buzones se cargan sólo en el panel. Nunca las mandes por mail ni por chat,
  tampoco a Biguá.
- Cada persona con su usuario. Si alguien deja la empresa, pedile a Biguá que lo desactive.
