## Crear las routines

> Dar de alta (o actualizar) las routines de todos los bots de la cuenta.

1. `reglas_alta()`: devuelve las routines de los bots activos del cliente, cada una con bot,
   nombre, cron, timing, disparo y el prompt exacto.
2. **Las tuyas** (bot `orquestador`): si ya existe una routine con ese nombre, actualizala (cron,
   timing y prompt); si no, creala. Usá la zona horaria que devuelve `reglas_alta` y copiá el
   prompt **tal cual**, sin resumirlo ni agregarle nada.
3. **Las de los otros bots:** en Grok cada bot crea sólo sus propias routines. Mandale a cada uno
   este mensaje: «Creá tus routines del SDR: llamá reglas_alta y creá o actualizá sólo las tuyas,
   con el cron, el timing y el prompt tal cual. Avisame cuando estén.» Esperá su respuesta antes
   de dar el alta por terminada.
4. Si un bot de la lista no existe en la cuenta, no lo crees vos: decíselo al operador.
5. Las routines con disparo `webhook` o `horario_y_webhook` (la de `seguimiento`): pasale al
   operador la URL del webhook y pedile que copie la clave desde la routine en la app de Grok y
   la cargue en el panel (pestaña SDR → Despertador de seguimiento). **No escribas la clave vos
   en el chat.** Hasta que la cargue, el bot corre sólo en su horario.
6. Al final, una lista para el operador: qué creaste, qué actualizaste y qué no pudiste.

## Comprobar

> Que todo quedó andando.

- Pedile al operador que confirme en la app que cada routine quedó habilitada.
- Recordale los dos ajustes de la cuenta que no podés hacer vos: **Privacy Mode** prendido y
  **Notifications** prendido en tu bot (así le llegan los avisos de aprobaciones).
- Recordale las reglas de la revisión automática de Grok: **Allow** para las herramientas del MCP
  de SDRBOT y de ASCI, salvo `registro_aprobar`, que va en **Ask first**.
