## El pedido del día

> Qué te pidió el orquestador, y lo aprobado primero.

1. En `registro_pendientes` están los pedidos del orquestador, **uno por campaña** (su
   `campana_id`): cuántas cuentas nuevas y qué seguimientos. Hacelos de a uno; marcá cada uno
   `en_curso` al empezarlo. Para cada pedido, leé la sección de su campaña
   (`reglas_manual(…, seccion: "campana-<clave>")`): de ahí salen el ICP, los cargos, la señal,
   la ventana, la propuesta y el llamado a la acción.
2. Si hay **aprobaciones decididas**, primero ejecutalas: seguí la tarea `ejecutar_aprobados`
   (pedí `reglas_manual(prospector, ejecutar_aprobados)`).
3. Si no hay pedido del orquestador, no prospectes: avisale al orquestador.

## Buscar cuentas

> Empresas que publicaron en los últimos días un aviso de lo que vende el cliente, que no estemos trabajando.

Todo lo de esta sección sale de la campaña del pedido. La ventana es su «Antigüedad máxima del
aviso»; si no dice, **14 días**.

1. **Candidatas:** `avisos_recientes` con `pais` (del ICP), `dias` (la ventana), `limite` 60 y la
   señal como dice «Señal en los avisos» de la campaña. Si no dice, armala con la
   propuesta: quien vende capacidad por un rol (QA, datos, soporte) va con `texto` («qa | tester |
   testing») y `solo_titulo: true`; para una marca, `fabricante`; tecnología, `categorias`;
   modernización, `ciclos_vida: ["legado", "eol"]`. Trae empresas **con o sin cuenta resuelta**,
   ordenadas por el aviso más nuevo, sin consultoras ni staffing.
2. **Fuera lo que ya trabajamos:** para cada candidata, `registro_buscar` por `dominio` (o por
   `nombre` si no hay dominio). Salteá las que están en contacto, excluidas o descartadas, y las en
   pausa cuya fecha no llegó.
3. **Fuera lo que no encaja:** lo que excluye la campaña (sus exclusiones ya suman las de Empresa), y el ruido de la búsqueda por texto
   (un aviso que no es del rol aunque lo nombre). `industrias` y `tamano` sólo filtran a las
   empresas con cuenta resuelta (`cuenta_resuelta: true`): a las demás mirá el nombre, el aviso y,
   si hace falta, su LinkedIn.
4. **Orden:** como viene (lo más nuevo primero). A igual fecha, las reposteadas (`reposteado`: un
   puesto que no se llena) y las que tienen más `avisos_en_ventana`.
5. Hasta la cantidad pedida: `registro_guardar_cuenta` con `campana` (la clave de la campaña del
   pedido), nombre, dominio si lo hay, país,
   vertical, tamaño, `asci_id` = `account_id` si está resuelta, **señales** con el aviso más nuevo
   (tipo `aviso`, fecha = `publicado_en`, evidencia = su `url`, resumen = su `titulo`, y si es
   reposteo) y la **tesis** en una o dos líneas: por qué ese aviso importa hoy.
6. Si no llegás a la cantidad pedida con avisos dentro de la ventana, **no completes con cuentas
   sin aviso reciente**: hacé menos y decilo en el cierre del pedido. `ventana` y `filtros` dicen
   cuántas había y cuántas quedaron afuera: contalo así, no como «no hay más».
7. Si `avisos_recientes` falla, usá lo de antes: `prospectar` con `ordenar_por: "avisos"` y, de a
   10 empresas, `novedades(empresas, desde: hoy menos la ventana)`, quedándote sólo con las que
   tienen un aviso dentro de la ventana.

## Elegir y revelar a quién escribirle

> Quien publicó el aviso y quien decide sobre ese puesto (sección «A quién escribirle»).

1. **Quien publicó el aviso** (`publicante` en la fila de `avisos_recientes`), si lo trae:
   - su **URL de LinkedIn ya viene** en `publicante.linkedin`, gratis: guardalo con esa URL, su
     nombre, el `cargo` si viene y `eleccion.rol_compra: "publicante"`. **No lo reveles para
     tener la URL.**
   - **mail:** si `contacto_cacheado` dice que ya tiene mail, `revelar_publicante(job_id)` (sale
     gratis de la caché). Si no, revelá a lo sumo **3 publicantes por tanda** (1 crédito cada uno
     que Apollo encuentre), los de cargo más cercano al área del aviso, y contá en el cierre
     cuántos trajeron mail. Muchos publicantes son de RRHH y Apollo no tiene su mail: sin mail, va
     sólo por LinkedIn.
2. **Quien decide:** `tomadores_de_decision` (gratis, de la caché) con los cargos del área del aviso
   que estén entre los del cliente. Si no hay nadie, `buscar_contactos` (gratis, cuota diaria) con
   `rol`, `titulos` y `seniority`. Una persona por cuenta, la más cercana al equipo que contrata.
   Revelala (`revelar_lote`) **aunque después no traiga mail**: la URL de LinkedIn vuelve casi
   siempre, y con eso va a la campaña de LinkedIn.
3. Guardalas como dice «A quién escribirle»: email y su calidad (`verificado` o `extrapolado`),
   URL de LinkedIn, cargo. Si el cliente no acepta mails extrapolados (lo dice la campaña), a ese
   no le va mail (sí LinkedIn).
4. Sin mail, no hay mail: guardalo igual. Si tiene LinkedIn, va sólo por LinkedIn (sección
   «Escribir los textos de LinkedIn»).

## Escribir el primer mail

> Corto, con el aviso como señal y la tesis, como dice «Cómo escribimos».

1. Leé de nuevo la sección «Cómo escribimos» de las reglas comunes y los ajustes de la campaña
   (tono, propuesta, objeciones, qué le pedimos al prospecto, casos que se pueden citar) y la firma del
   buzón que vas a usar («Buzones y firmas»).
2. **El aviso va nombrado** en la primera o segunda línea, con su fecha («vi que el 3/11 publicaron
   una búsqueda de QA Automation»). Nada de «vi que están creciendo».
3. **Un ángulo por persona:**
   - a **quien publicó el aviso**: cubrir ese puesto más rápido o sumar capacidad mientras lo
     cubren;
   - a **quien decide**: lo que gana el equipo (la tesis), sin repetir el mail del otro.
4. Si en la cuenta van dos personas, el de quien decide sale **un día hábil después** que el de
   quien publicó (`proximo_fecha`), para no llegar los dos el mismo día.
5. Elegí un buzón de la campaña (los de «Campañas de este cliente»; si hay varios, repartí).

## Escribir los textos de LinkedIn

> La nota de la invitación, el mensaje 1 y el mensaje 2 de cada persona con LinkedIn.

La campaña de LinkedIn del cliente es un esqueleto fijo: invitación con nota, **mensaje 1** cuando
acepta y **mensaje 2** unos días después si no contestó. Todo el texto lo escribís vos, por
persona. Va cualquiera con URL de LinkedIn en el registro, tenga o no mail.

1. **Nota de la invitación** (`nota`): una o dos líneas, con el aviso como motivo («Vi la búsqueda
   de QA Automation que publicaron el 3/11»). Sin venta, sin links. Tope: el «largo máximo de la
   nota» que da `dripify_estado` (300 caracteres con LinkedIn Premium, 200 sin).
2. **Mensaje 1** (`mensaje1`, al aceptar): gracias por aceptar, la tesis en dos o tres líneas y una
   pregunta simple. Hasta 1000 caracteres; mejor menos de 500. Si también le escribiste por mail,
   no copies el mail: el de LinkedIn es más corto y conversacional.
3. **Mensaje 2** (`mensaje2`, unos días después, si no contestó): un ángulo nuevo en dos o tres
   líneas, no un «¿viste mi mensaje?».
4. **Textos completos:** con el nombre y la empresa escritos. Nada de `{{…}}` ni `[Nombre]`: el
   gateway rechaza la carga.
5. Mismo ángulo que su mail (publicante o decisor), las reglas de «Cómo escribimos» y el idioma del
   cliente.

## Enviar o pedir aprobación

> Durante la calibración se aprueba antes; después sale directo.

Cada mail sale por un buzón **de la campaña** de la persona (los de «Campañas de este cliente»;
el gateway rechaza otro con `buzon_fuera_de_campana`), y sólo con los links que permite la campaña
(`link_no_permitido`).

**Si la campaña está en calibración** (lo dice «Campañas de este cliente»):

1. `registro_pedir_aprobacion` tipo `calibracion_mail`, con `prospecto_id` y en `contenido`
   exactamente `buzon`, `destinatario`, `asunto` y `texto`, más el `contexto` (señal y tesis). Si
   tiene LinkedIn, en la **misma** aprobación sumá `linkedin` con `nota`, `mensaje1` y `mensaje2`.
   Sin mail, la aprobación lleva sólo `linkedin` (y el `contexto`).
2. Dejá el prospecto con `proximo_paso: "enviar mail 1 cuando se apruebe"`.
3. No lo mandes ni lo cargues: se hace en `ejecutar_aprobados`.

**Si la calibración terminó:**

1. `enviar` con `mailbox`, `to`, `subject`, `text`, `prospecto_id`, `bot`, `tarea`, `corrida` e
   `idempotency_key` = `<id del prospecto>:mail-1`.
2. Dejá el próximo paso: `proximo_paso: "seguimiento mail 2"`, `proximo_canal: "mail"`,
   `proximo_fecha` a 4 días hábiles.
3. **LinkedIn, una carga por tanda y por campaña:** al final, todas las personas del día con
   LinkedIn **de una misma campaña** en un solo `dripify_cargar` (hasta 100; el gateway no mezcla
   campañas en una carga), cada una con `prospecto_id`, `nota`, `mensaje1` y `mensaje2`, e
   `idempotency_key` = `linkedin-<AAAA-MM-DD>-<clave de la campaña>-<n>` (n: la tanda del día,
   desde 1). Si el gateway
   rechaza la carga (`dripify_carga_rechazada`), trae en `errores` quién y por qué: sacá o corregí
   a esos y volvé a cargar con la **misma** clave (la carga rechazada no llegó a Dripify).
4. Los decisores que van un día hábil después que el publicante, se cargan ese día, en la tanda de
   ese día.

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
5. LinkedIn no tiene seguimientos tuyos: los dos mensajes los manda Dripify. Si la persona responde
   por cualquier canal, el gateway frena el otro solo.

## Cerrar

> El pedido, la bitácora y lo que quedó.

1. `registro_resolver_pedido` del pedido del día: `hecho` con cuántas cuentas, personas, mails y
   cargas a LinkedIn (o `en_curso` si quedó parte para la próxima corrida, con qué falta).
2. Lo que no entró por cupo o por presupuesto queda con `proximo_fecha` de mañana.
