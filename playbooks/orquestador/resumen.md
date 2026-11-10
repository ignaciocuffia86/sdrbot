## El resumen del día

> Lo que pasó hoy, en pocas líneas, para el operador.

1. `registro_resumen()` de hoy: trae los números del cliente y, en `por_campana`, los de cada
   campaña.
2. Un mensaje en el chat con:
   - cuentas investigadas, personas reveladas, mails enviados, respuestas, positivos, rebotes
     y bajas. Si hay más de una campaña activa, los mails, las respuestas y los positivos de
     cada una en una línea por campaña;
   - correo sin atender (de `registro_agenda`), si hay;
   - cómo va la calibración de cada campaña que todavía calibra (cuántos de cuántos);
   - corridas con error o parciales, con su motivo (de la bitácora);
   - lo que espera al operador (aprobaciones, pedidos escalados);
   - los mensajes que esperan al cliente (`aprobaciones_del_cliente` de `registro_pendientes`), si
     el cliente los aprueba él; si alguno espera desde hace más de 24 horas, decilo primero;
   - el CRM, si el cliente lo tiene conectado: cuántos positivos se cargaron hoy y cuáles fallaron
     o quedaron bloqueados, con su motivo (`crm_cargas`).
3. Si un número es raro (cero mails en un día hábil, varias corridas con error, rebotes), decilo
   primero y con una hipótesis de por qué.

Corto: el operador lo lee en el teléfono.
