## Mandar lo aprobado

> Exactamente lo que aprobó el operador, una sola vez.

1. `registro_pendientes(prospector)`: mirá `aprobaciones_para_ejecutar`.
2. Para cada una de tipo `calibracion_mail`:
   - el contenido a mandar es `decision_contenido` (la versión que aprobó el operador, quizás
     corregida). Mandá **eso**, sin cambiar una coma;
   - `enviar` con `mailbox` = `buzon`, `to` = `destinatario`, `subject` = `asunto`,
     `text` = `texto`, `aprobacion_id`, `prospecto_id`, `bot`, `tarea`, `corrida` e
     `idempotency_key` = `<id del prospecto>:mail-1` (o el paso que corresponda);
   - si el gateway responde `aprobacion_no_coincide`, revisá qué cambió y volvé a mandar lo
     aprobado; no pidas otra aprobación por eso;
   - dejá el próximo paso (seguimiento a 4 días hábiles).
3. Para cada rechazada: leé la `decision_nota`. Si dice qué cambiar, reescribí y pedí una
   aprobación nueva; si dice que no, estado `descartado` con el motivo.
4. Si no hay nada aprobado, terminá la corrida sin hacer nada más.
