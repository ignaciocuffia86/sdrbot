## Mandar lo aprobado

> Exactamente lo que aprobó el operador, una sola vez.

1. `registro_pendientes(prospector)`: mirá `aprobaciones_para_ejecutar`.
2. Para cada una de tipo `calibracion_mail`:
   - **la señal sigue viva:** si pasaron más de 7 días desde la fecha del aviso de la cuenta,
     confirmá con `novedades` que el aviso siga publicado. Si ya no está, no lo mandes: dejá el
     prospecto con `proximo_paso: "aviso cerrado: buscar otra señal"` y contalo en el cierre;
   - el contenido a mandar es `decision_contenido` (la versión que aprobó el operador, quizás
     corregida). Mandá **eso**, sin cambiar una coma;
   - `enviar` con `mailbox` = `buzon`, `to` = `destinatario`, `subject` = `asunto`,
     `text` = `texto`, `aprobacion_id`, `prospecto_id`, `bot`, `tarea`, `corrida` e
     `idempotency_key` = `<id del prospecto>:mail-1` (o el paso que corresponda);
   - si el gateway responde `aprobacion_no_coincide`, revisá qué cambió y volvé a mandar lo
     aprobado; no pidas otra aprobación por eso;
   - dejá el próximo paso (seguimiento a 4 días hábiles);
   - si `decision_contenido` trae `linkedin`, esa persona va a la carga de LinkedIn de esta
     corrida con **esos** textos y `aprobacion_id` (aunque el mail ya haya salido: la aprobación
     sirve para las dos cosas). Si trae sólo `linkedin`, no hay mail: sólo la carga.
3. **Una carga por corrida:** todas las aprobadas con `linkedin` en un solo `dripify_cargar`, con
   `idempotency_key` = `linkedin-<AAAA-MM-DD>-aprobados-<n>`. Si `dripify_carga_rechazada` dice
   que alguien no coincide con lo aprobado, mandá exactamente `decision_contenido.linkedin`.
4. Para cada rechazada: leé la `decision_nota`. Si dice qué cambiar, reescribí y pedí una
   aprobación nueva; si dice que no, estado `descartado` con el motivo.
5. Si no hay nada aprobado, terminá la corrida sin hacer nada más.
