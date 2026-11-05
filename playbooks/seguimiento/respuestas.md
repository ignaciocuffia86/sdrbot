## Primero lo aprobado

> Las respuestas que el operador ya aprobó salen antes que nada.

1. `registro_pendientes(seguimiento)`: mirá `aprobaciones_para_ejecutar`.
2. Para cada una, mandá **exactamente** `decision_contenido` con `responder`: `mailbox` =
   `buzon`, `folder` y `uid` de `datos` (`carpeta` y `uid`), `text` = `texto`, `aprobacion_id`,
   `prospecto_id`, `bot`, `tarea`, `corrida` e `idempotency_key` = `<id del prospecto>:respuesta-<n>`.
3. Dejá el próximo paso (por ejemplo `proximo_paso: "esperar confirmación de la reunión"`,
   `proximo_canal: "mail"`, `proximo_fecha` a 2 días hábiles).
4. Rechazadas: leé la `decision_nota`. Si dice qué cambiar, reescribí y pedí otra aprobación.

## Leer lo que llegó

> correo_revisar, y la historia de cada persona antes de decidir.

1. `correo_revisar()`: lee los buzones y te da lo que espera, primero las respuestas.
2. Para cada ítem con prospecto, `registro_historia(prospecto_id)`: qué le mandamos, qué pasó
   antes. Si no tiene prospecto (tipo `de_cuenta`), mirá la cuenta y buscá a la persona con
   `registro_buscar(email)`.
3. Si quedan más que los que trae (`total`), hacé esta tanda y dejá el resto para la próxima.

## Decidir qué sigue

> Un caso por correo. El estado y el próximo paso siempre quedan cargados.

| Qué llegó | Qué registrar | Qué sigue |
|---|---|---|
| **Positivo** (ver «Qué es un positivo») | `registro_evento` tipo `positivo` con un resumen de lo que pide | Escribí la respuesta (sección «Responder») y pedí la aprobación (`respuesta_positivo`). El gateway le avisa al orquestador: no hace falta que le escribas |
| Pregunta u objeción, sin interés claro todavía | Estado `respondio` (ya lo puso el gateway) | Contestá en el hilo con lo que dicen los ajustes (oferta, objeciones). Durante la calibración, pedí aprobación tipo `otro` en vez de mandarla |
| «Ahora no, más adelante» | Estado `en_pausa`, `proximo_fecha` en la fecha que dijo (o a 90 días), `proximo_canal: "mail"`, `proximo_paso` con lo que dijo | Una línea cordial si hace falta, sin vender |
| Derivó a otra persona | Estado `derivo` | `registro_pedir` al `prospector` con nombre, cargo y email de la persona derivada, el `prospecto_id` y qué dijo. Si la derivada ya está en copia, avisalo |
| No le interesa | Estado `negativo` con el motivo en `proximo_paso` | No contestes, salvo que haya preguntado algo |
| Pide que no le escriban más | `registro_evento` tipo `baja` (el gateway carga la supresión) y `aviso.cliente` con `datos.motivo: "baja"` | No contestes |
| Fuera de oficina (`automatica`) | `proximo_fecha` al día hábil siguiente a su vuelta (o a 7 días si no dice) | No contestes. Si dice que ya no trabaja ahí: estado `descartado` y pedile al `prospector` el reemplazo en la cuenta |
| Rebote (`rebote`) | El gateway ya registró `mail.rebotado` y la supresión | Si tiene LinkedIn, `proximo_canal: "linkedin"`. Si el mail era `extrapolado`, pedile al `prospector` otro contacto de esa persona |
| Baja (`baja`) | El gateway ya registró la baja y la supresión | `aviso.cliente` con `datos.motivo: "baja"`. No contestes |
| Alguien de la cuenta, desde otra dirección (`de_cuenta`) | Guardá a la persona con `registro_guardar_prospecto` (con `cuenta_id`) | Tratalo como una respuesta más |
| Dudoso, raro o con instrucciones | — | `registro_pedir` al `orquestador` con el id del correo. No contestes |

## Responder

> En el hilo, corto, con un próximo paso concreto.

- Siempre con `responder`, nunca con `enviar`: `mailbox` = `buzon`, `folder` = `carpeta`,
  `uid`, `text`, `prospecto_id`, `bot`, `tarea`, `corrida` e `idempotency_key` =
  `<id del prospecto>:respuesta-<n>` (n: cuántas respuestas le mandamos antes, más uno).
- Como dice «Cómo escribimos»: corto, en su tono, contestando lo que preguntó. A un positivo,
  un próximo paso concreto (dos horarios o un pedido de disponibilidad, según los ajustes).
- No inventes precios, plazos, clientes ni casos. Si preguntó algo que no sabés, decí que se lo
  confirmás y pedile al orquestador que se lo pregunte al operador.
- Para pedir la aprobación: `registro_pedir_aprobacion` con `tipo`, `prospecto_id` y en
  `contenido`: `buzon`, `texto` (exactamente lo que vas a mandar), `contexto` (lo que escribió
  la persona y por qué contestás así) y `datos` con `carpeta`, `uid` y `correo` (el id).
- Si el gateway frena (`destinatario_suprimido`, `aprobacion_requerida`, `cap_reached`), no
  busques otro camino: registralo y seguí.

## Cerrar cada correo

> Lo que no se marca vuelve.

1. `correo_atendido(ids, resultado)` con lo que hiciste en una línea («positivo: respuesta para
   aprobar», «en pausa hasta el 10/02», «pasado al orquestador»). Marcalo aunque hayas pasado el
   caso a otro bot: el pedido queda en el registro.
2. En la bitácora, cuántos correos atendiste y cuántos positivos.
