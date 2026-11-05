## El pedido del día

> Qué te pidió el orquestador, y lo aprobado primero.

1. En `registro_pendientes` está el pedido del orquestador (cuántas cuentas nuevas y qué
   seguimientos). Marcalo `en_curso`.
2. Si hay **aprobaciones decididas**, primero ejecutalas: seguí la tarea `ejecutar_aprobados`
   (pedí `reglas_manual(prospector, ejecutar_aprobados)`).
3. Si no hay pedido del orquestador, hacé la tanda por defecto de «Ajustes de este cliente».

## Buscar cuentas

> Cuentas con señal que encajan con el cliente y que no estemos trabajando ya.

1. Con el ICP de «Ajustes de este cliente», buscá en ASCI con `prospectar` (país obligatorio).
   Para un cliente que vende capacidad (desarrollo, QA, staffing), `ordenar_por: "avisos"`: un
   aviso abierto es una necesidad sin cubrir.
2. Para cada candidata, `registro_buscar(dominio)`:
   - si ya está **en contacto**, **excluida** o **descartada**, salteala;
   - si está **en pausa** y la fecha no llegó, salteala.
3. Descartá agencias, consultoras y staffing que aparezcan como si contrataran directo: tiene que
   haber evidencia de que la empresa necesita lo que el cliente vende.
4. Con las que quedan, hasta la cantidad pedida: `registro_guardar_cuenta` con nombre, dominio,
   país, vertical, tamaño, **señales** (tipo, fecha, evidencia, resumen) y la **tesis** en una o
   dos líneas (por qué esta cuenta, por qué ahora). Si querés más contexto, `novedades` o
   `evidencia` de ASCI, sin pasarte: son herramientas caras.

## Elegir y revelar decisores

> Una o dos personas por cuenta, según el cliente.

1. `tomadores_de_decision` (gratis, de la caché) con el rol o los cargos del cliente. Si no hay
   nadie, `buscar_contactos` (gratis, cuota diaria) con `rol`, `titulos` y `seniority`.
2. Elegí **una o dos** personas por cuenta (o lo que digan los ajustes), siguiendo la sección «A
   quién revelar» de tus reglas de bot.
3. Revelá y completá el prospecto con lo que devuelva: email y su calidad (`verificado` o
   `extrapolado`), URL de LinkedIn, cargo. Si el cliente no acepta mails extrapolados (lo dicen
   los ajustes), no le escribas a ese.
4. Sin mail, no hay mail: guardalo igual y dejá `proximo_canal: "linkedin"` si tiene LinkedIn.

## Escribir el primer mail

> Corto, con la señal y la tesis, como dice «Cómo escribimos».

1. Leé de nuevo la sección «Cómo escribimos» de las reglas comunes y los ajustes del cliente
   (tono, oferta, firma, objeciones).
2. Un mail por persona: asunto, texto y firma. La señal concreta de su empresa en la primera o
   segunda línea; la tesis; una pregunta al final.
3. Elegí el buzón del cliente que corresponda (lo dicen los ajustes; si hay varios, repartí).

## Enviar o pedir aprobación

> Durante la calibración se aprueba antes; después sale directo.

**Si el cliente está en calibración** (lo dice «Ajustes de este cliente»):

1. `registro_pedir_aprobacion` tipo `calibracion_mail`, con `prospecto_id` y en `contenido`
   exactamente `buzon`, `destinatario`, `asunto` y `texto`, más el `contexto` (señal y tesis).
2. Dejá el prospecto con `proximo_paso: "enviar mail 1 cuando se apruebe"`.
3. No lo mandes: se manda en `ejecutar_aprobados`.

**Si la calibración terminó:**

1. `enviar` con `mailbox`, `to`, `subject`, `text`, `prospecto_id`, `bot`, `tarea`, `corrida` e
   `idempotency_key` = `<id del prospecto>:mail-1`.
2. Dejá el próximo paso: `proximo_paso: "seguimiento mail 2"`, `proximo_canal: "mail"`,
   `proximo_fecha` a 4 días hábiles.

## Seguimientos por mail

> Mail 2 y mail 3 a quien no respondió.

Para cada prospecto que el orquestador te pidió seguir:

1. `registro_historia`: ¿ya respondió? ¿pidió la baja? Si sí, no le escribas.
2. No hace falta revisar el buzón: el gateway lo lee solo, registra las respuestas, rebotes y
   bajas, y no deja mandar otro mail de la secuencia a quien respondió
   (`prospecto_respondio`, `respuesta_sin_atender`, `destinatario_suprimido`). Si te frena, no
   insistas: esa persona ya es de `seguimiento`.
3. Si no respondió: un mail corto en el mismo hilo (`in_reply_to` y `references` con el
   `Message-ID` del mail anterior, que está en el `ref` del evento `mail.enviado`), con un ángulo
   nuevo, no un «¿viste mi mail?». Misma regla de calibración que el primero. Clave
   `<id>:mail-2` o `<id>:mail-3`.
4. Después del mail 3 sin respuesta: estado `sin_respuesta`, `proximo_fecha` a 90 días.

## Cerrar

> El pedido, la bitácora y lo que quedó.

1. `registro_resolver_pedido` del pedido del día: `hecho` con cuántas cuentas, personas y mails
   (o `en_curso` si quedó parte para la próxima corrida, con qué falta).
2. Lo que no entró por cupo o por presupuesto queda con `proximo_fecha` de mañana.
