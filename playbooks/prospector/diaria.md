## El pedido del día

> Qué te pidió el orquestador, y lo aprobado primero.

1. En `registro_pendientes` está el pedido del orquestador (cuántas cuentas nuevas y qué
   seguimientos). Marcalo `en_curso`.
2. Si hay **aprobaciones decididas**, primero ejecutalas: seguí la tarea `ejecutar_aprobados`
   (pedí `reglas_manual(prospector, ejecutar_aprobados)`).
3. Si no hay pedido del orquestador, hacé la tanda por defecto de «Ajustes de este cliente».

## Buscar cuentas

> Cuentas con un aviso de los últimos días, que encajan con el cliente y que no estemos trabajando.

La ventana es la «Antigüedad máxima del aviso» de los ajustes del cliente; si no dice, **14 días**.

1. **Candidatas:** con el ICP de «Ajustes de este cliente», `prospectar` (país obligatorio) con
   `ordenar_por: "avisos"` y `limite` 60. Ojo: ese orden cuenta los avisos de los últimos 12 meses
   y **no dice cuán nuevo es el último**; por eso el paso 3.
2. **Fuera lo que ya trabajamos:** para cada candidata, `registro_buscar(dominio)`. Salteá las que
   están en contacto, excluidas o descartadas, y las en pausa cuya fecha no llegó.
3. **Frescura:** con las que quedan, de a 10 empresas, `novedades(empresas, desde: hoy menos la
   ventana)`. Quedate **sólo** con las que tienen al menos un aviso publicado dentro de la ventana
   y que sea de lo que vende el cliente (por título y señales). Anotá de cada una el aviso más
   nuevo: título, fecha y link. `novedades` es la herramienta más cara de ASCI: no la llames para
   cuentas que ya descartaste.
4. **Orden:** primero el aviso más nuevo. A igual fecha, la cuenta con más avisos en la ventana.
5. Descartá agencias, consultoras y staffing que publican para terceros: tiene que haber evidencia
   de que la empresa necesita lo que el cliente vende.
6. Hasta la cantidad pedida: `registro_guardar_cuenta` con nombre, dominio, país, vertical, tamaño,
   **señales** con el aviso (tipo `aviso`, fecha de publicación, evidencia = link del aviso,
   resumen = título) y la **tesis** en una o dos líneas: por qué ese aviso importa hoy.
7. Si no llegás a la cantidad pedida con avisos dentro de la ventana, **no completes con cuentas
   sin aviso reciente**: hacé menos y decilo en el cierre del pedido.

## Elegir y revelar a quién escribirle

> Quien publicó el aviso y quien decide sobre ese puesto (sección «A quién escribirle»).

1. **Quien publicó el aviso:** cuando ASCI lo devuelva, buscalo y revelalo. Hoy no lo devuelve:
   salteá este paso.
2. **Quien decide:** `tomadores_de_decision` (gratis, de la caché) con los cargos del área del aviso
   que estén entre los del cliente. Si no hay nadie, `buscar_contactos` (gratis, cuota diaria) con
   `rol`, `titulos` y `seniority`. Una persona por cuenta, la más cercana al equipo que contrata.
3. Guardalas y revelalas como dice «A quién escribirle»: email y su calidad (`verificado` o
   `extrapolado`), URL de LinkedIn, cargo. Si el cliente no acepta mails extrapolados (lo dicen los
   ajustes), no le escribas a ese.
4. Sin mail, no hay mail: guardalo igual y dejá `proximo_canal: "linkedin"` si tiene LinkedIn.

## Escribir el primer mail

> Corto, con el aviso como señal y la tesis, como dice «Cómo escribimos».

1. Leé de nuevo la sección «Cómo escribimos» de las reglas comunes y los ajustes del cliente
   (tono, oferta, firma, objeciones).
2. **El aviso va nombrado** en la primera o segunda línea, con su fecha («vi que el 3/11 publicaron
   una búsqueda de QA Automation»). Nada de «vi que están creciendo».
3. **Un ángulo por persona:**
   - a **quien publicó el aviso**: cubrir ese puesto más rápido o sumar capacidad mientras lo
     cubren;
   - a **quien decide**: lo que gana el equipo (la tesis), sin repetir el mail del otro.
4. Si en la cuenta van dos personas, el de quien decide sale **un día hábil después** que el de
   quien publicó (`proximo_fecha`), para no llegar los dos el mismo día.
5. Elegí el buzón del cliente que corresponda (lo dicen los ajustes; si hay varios, repartí).

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

1. `registro_historia`: ¿ya respondió? ¿pidió la baja? ¿Respondió **otra persona de la misma
   cuenta**? En cualquiera de esos casos, no le escribas: esa cuenta ya es de `seguimiento`.
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
