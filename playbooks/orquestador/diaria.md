## Armar el día

> Agenda, pendientes y el pedido del día al prospector.

1. `registro_agenda()`: prospectos con próximo paso vencido, pedidos pendientes por bot y
   aprobaciones que esperan.
2. `registro_resumen()` de ayer (`desde` y `hasta` con la fecha de ayer) para ver cómo vino, en
   total y en cada campaña (`por_campana`).
3. Pedidos al `prospector` con `registro_pedir`, **uno por cada campaña activa** de «Campañas de
   este cliente», con `campana` = su clave:
   - **cuántas cuentas nuevas** hoy: las «Cuentas nuevas por día» de esa campaña (si dice 0, ese
     día no hay cuentas nuevas en esa campaña); menos si ayer hubo errores o el cupo de los
     buzones de la campaña se llenó. Nunca más que lo que dice la campaña;
   - **los seguimientos de mail** de esa campaña que la agenda muestra para hoy (ids de
     prospecto, según su `campana_id`), más los que devuelve `correo_sin_respuesta` y no tienen
     próximo paso;
   - si la calibración de esa campaña no terminó: que deje cada mail como aprobación, no que lo
     envíe;
   - **cuántos publicantes puede revelar** (ver abajo).

   **Si los buzones no dan para todo:** con `buzones()`, el cupo libre de hoy es
   `daily_send_cap − sends_today` de los buzones activos de cada campaña. Contá unos dos mails
   nuevos por cuenta más los seguimientos pedidos. Si a una campaña no le alcanza, bajale las
   cuentas nuevas hasta que entren. Si varias campañas comparten buzones y entre todas no entran,
   **recortá a todas en proporción** a lo que pedía cada una (por ejemplo, 6 y 4 cuentas con lugar
   para 5: 3 y 2, redondeando para que la suma no pase) y anotalo en el resumen de la bitácora
   (`bitacora_fin`): qué pedía cada campaña y qué le pediste.

   **Publicantes de ASCI:** el tope del día son **3 publicantes revelados entre todas las
   campañas** (cada uno cuesta un crédito). Repartilos en proporción a las cuentas nuevas de cada
   pedido (con 3 y 1 cuentas: 2 y 1; con una sola campaña, los 3) y ponelo en el pedido («podés
   revelar hasta N publicantes»).

   Una campaña pausada o terminada no lleva pedido de cuentas nuevas ni de mails nuevos. Si una
   campaña activa no tiene buzones, decíselo al operador y no la pidas.
4. Si hay pedidos escalados para vos, resolvelos o preguntáselos al operador.
5. Si `registro_agenda` muestra `correo_sin_atender` o `linkedin_sin_atender` y `seguimiento` está
   activo, mandale un mensaje corto: «Tenés respuestas para atender».
6. **LinkedIn:** `dripify_estado()`. Si no está listo (`problemas`), decíselo al operador en el chat
   con los problemas, una vez por día, y pedile al `prospector` que hoy no cargue a LinkedIn. Si
   el cliente no tiene Dripify (`dripify_sin_configurar`), no digas nada.

## Aprobaciones pendientes

> Si hay aprobaciones pendientes, presentalas.

Si `registro_agenda` muestra aprobaciones pendientes, seguí la tarea `aprobaciones` (pedí
`reglas_manual(orquestador, aprobaciones)`) para presentarlas al operador en el chat.

## Avisar

> Un mensaje corto en el chat, sólo si hay algo para el operador.

Si hay aprobaciones o algo para decidir, un mensaje corto en el chat: cuántas cosas esperan y que
las tiene más abajo. Si no hay nada, no escribas.
