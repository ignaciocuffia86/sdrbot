## Armar el día

> Agenda, pendientes y el pedido del día al prospector.

1. `registro_agenda()`: prospectos con próximo paso vencido, pedidos pendientes por bot y
   aprobaciones que esperan.
2. `registro_resumen()` de ayer (`desde` y `hasta` con la fecha de ayer) para ver cómo vino.
3. Pedido al `prospector` con `registro_pedir`:
   - **cuántas cuentas nuevas** hoy: lo que diga «Ajustes de este cliente» (si no dice, 10);
     menos si ayer hubo errores o el cupo de los buzones se llenó;
   - **los seguimientos de mail** que la agenda muestra para hoy (ids de prospecto);
   - si la calibración no terminó: que deje cada mail como aprobación, no que lo envíe.
4. Si hay pedidos escalados para vos, resolvelos o preguntáselos al operador.

## Aprobaciones pendientes

> Si hay aprobaciones pendientes, presentalas.

Si `registro_agenda` muestra aprobaciones pendientes, seguí la tarea `aprobaciones` (pedí
`reglas_manual(orquestador, aprobaciones)`) para presentarlas al operador en el chat.

## Avisar

> Un mensaje corto en el chat, sólo si hay algo para el operador.

Si hay aprobaciones o algo para decidir, un mensaje corto en el chat: cuántas cosas esperan y que
las tiene más abajo. Si no hay nada, no escribas.
