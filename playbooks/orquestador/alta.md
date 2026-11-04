## Crear las routines

> Dar de alta (o actualizar) las routines de todos los bots de la cuenta.

1. `reglas_alta()`: devuelve las routines de los bots activos del cliente, cada una con bot,
   nombre, cron, timing, disparo y el prompt exacto.
2. Para cada una, en el bot indicado:
   - si ya existe una routine con ese nombre, actualizala (cron, timing y prompt);
   - si no existe, creala;
   - usá la zona horaria que devuelve `reglas_alta`;
   - copiá el prompt **tal cual**, sin resumirlo ni agregarle nada.
3. Si un bot de la lista no existe en la cuenta, no lo crees vos: decíselo al operador.
4. Las routines con disparo `webhook` o `horario_y_webhook`: anotá la URL y la clave que da Grok
   y pasáselas al operador en el chat (son para el gateway).
5. Al final, una lista para el operador: qué creaste, qué actualizaste y qué no pudiste.

## Comprobar

> Que todo quedó andando.

- Pedile al operador que confirme en la app que cada routine quedó habilitada.
- Recordale los dos ajustes de la cuenta que no podés hacer vos: **Privacy Mode** prendido y
  **Notifications** prendido en tu bot (así le llegan los avisos de aprobaciones).
- Recordale las reglas de la revisión automática de Grok: **Allow** para las herramientas del MCP
  de SDRBOT y de ASCI, salvo `registro_aprobar`, que va en **Ask first**.
