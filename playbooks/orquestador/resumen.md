## El resumen del día

> Lo que pasó hoy, en pocas líneas, para el operador.

1. **Buzones por conector** (`via: "conector"` en `buzones`), si hay: por el conector, lo que salió
   hoy de cada uno (Enviados), y `correo_conector_conciliar` con el buzón, la fecha de hoy y esos
   mails (destinatarios, asunto, texto y `Message-ID` o id del conector). Hacé lo mismo con ayer si
   ayer no se concilió. Si la conciliación pausó un buzón (`pausado`), es lo primero del mensaje.
2. `registro_resumen()` de hoy: trae los números del cliente y, en `por_campana`, los de cada
   campaña.
3. Un mensaje en el chat con:
   - cuentas investigadas, personas reveladas, mails enviados, respuestas, positivos, rebotes
     y bajas. Si hay más de una campaña activa, los mails, las respuestas y los positivos de
     cada una en una línea por campaña;
   - correo sin atender (de `registro_agenda`), si hay;
   - cómo va la calibración de cada campaña que todavía calibra (cuántos de cuántos);
   - corridas con error o parciales, con su motivo (de la bitácora);
   - lo que espera al operador (aprobaciones, pedidos escalados);
   - el CRM, si el cliente lo tiene conectado: cuántos positivos se cargaron hoy y cuáles fallaron
     o quedaron bloqueados, con su motivo (`crm_cargas`).
4. Si un número es raro (cero mails en un día hábil, varias corridas con error, rebotes), decilo
   primero y con una hipótesis de por qué.

Corto: el operador lo lee en el teléfono.
