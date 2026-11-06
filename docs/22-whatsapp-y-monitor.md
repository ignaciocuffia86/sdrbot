# WhatsApp de seguimiento y monitor de actividad

Estado al 06/11/2026: **construido** (migración `011` del gateway, reglas `whatsapp/_bot` y
`whatsapp/pasada`). Complementa a `09` §4.1 (el bot `whatsapp`) y a `21` (el panel).

## 1. WhatsApp: el gateway da el turno, el bot manda

**Decisión del 06/11:** el WhatsApp sale por **WhatsApp Web, en el navegador del asiento de Grok**
(sin infraestructura nueva), y **cada mensaje pasa antes por el gateway**, que hace cumplir las
reglas en código. Si más adelante se pasa a un servidor WAHA, las reglas y las herramientas son las
mismas: cambia sólo quién aprieta «enviar».

La regla de fondo: **poco volumen, horario del cliente, ritmo humano y sólo gente que ya tiene
relación con nosotros.**

| Regla | Por defecto | Quién la hace cumplir |
|---|---|---|
| Horario (hora del cliente) | De 8 a 24 h, todos los días | Gateway: `whatsapp_fuera_de_horario` |
| Pausa al azar entre dos envíos del cliente, para todos los chats juntos | 20 a 60 s | Gateway: el turno trae `espera_segundos` |
| Topes | 8 por persona por día, 60 por día en total | Gateway: `whatsapp_tope` |
| Sólo contactos tibios: ya respondió por algún canal o ya tiene chat | — | Gateway: `whatsapp_contacto_frio` |
| Nada repetido: mismo texto a la misma persona | 24 h | Gateway: `whatsapp_repetido` |
| Primer mensaje a cada persona con el OK del operador | Sí | Gateway: aprobación `whatsapp_primero` (y `respuesta_positivo` a un positivo), con el texto exacto |
| No contactar, supresión, respuesta sin leer, persona cerrada | — | Gateway, como en el mail |
| Un bloqueo frena todo el canal | — | Gateway: `whatsapp_resultado` «bloqueado» pausa el WhatsApp del cliente y el orquestador le avisa al operador. Sólo Biguá lo reanuda |
| Ritual antes de cada mensaje: abrir el chat (visto), escribir de a poco `escribiendo_seg` (1 a 8 s, según el largo) y mandar | — | El bot (`whatsapp/pasada`) |
| Destinatario: sólo el número del turno, en su chat individual; sin grupos, listas ni difusiones | — | El bot |
| Sin adjuntos, imágenes, audios ni links (salvo el link de agenda a un positivo) | — | El bot |

### Herramientas

| Herramienta | Qué hace |
|---|---|
| `whatsapp_estado` | Activo o en pausa (y por qué), horario, si ahora se puede, pausa entre envíos, envíos de hoy y topes |
| `whatsapp_turno` | Pide el turno de un mensaje antes de escribirlo. Devuelve `envio_id`, `espera_segundos`, el número y el ritual. Idempotente por clave (`<prospecto>:whatsapp-<n>`). Un turno vence a los 10 minutos |
| `whatsapp_resultado` | «enviado» (queda `whatsapp.enviado` en la línea de tiempo y se gasta la aprobación), «fallido» o «bloqueado» (pausa todo) |
| `registro_buscar` | Ahora también por número de WhatsApp (últimos 10 dígitos), para saber de quién es un chat |

`registro_evento` ya no acepta `whatsapp.enviado`: lo registra el gateway con el turno. Las
respuestas por WhatsApp las registra el bot con `registro_evento` tipo `respuesta`, canal
`whatsapp`, con el texto textual, y le avisa a `seguimiento`.

### Cómo se reparte el trabajo

- `seguimiento` decide cuándo va un WhatsApp y escribe el texto; pide la aprobación si es el primero
  (o a un positivo) y le pasa el pedido al bot `whatsapp`.
- `whatsapp` (routine «SDR · whatsapp», lunes a viernes 9:20 a 19:20 cada dos horas) toma los
  pedidos, pide turno, espera, hace el ritual, manda y cuenta el resultado; y lee lo que contestaron.

### Alta

1. En la cuenta de Grok: un cuarto bot `whatsapp`, con el conector de SDRBOT y las herramientas
   `whatsapp_*` en «Allow». La sesión de WhatsApp Web se abre con el QR del número del cliente en el
   navegador del asiento (videollamada con el cliente, `09` §9).
2. Panel → **⚙ Administración → Operación**: sumar `whatsapp` a los bots activos.
3. Panel → **Canales → WhatsApp**: activarlo, el número (sólo para mostrar) y, si hace falta, el
   horario, la pausa y los topes.
4. Que el bot cree su routine (`reglas_alta`, como los demás).

Si queda en pausa por un bloqueo, el Resumen lo muestra en rojo. Antes de **Reanudar**, revisar la
sesión de WhatsApp Web en el asiento.

## 2. Monitor de actividad

La pestaña **Actividad** del panel es un monitor en dos columnas (`GET /clients/:id/monitor`, se
actualiza solo cada 30 segundos):

- **Izquierda, los canales y procesos con su modo:** Prospección, Correo, LinkedIn, WhatsApp y
  Respuesta a interesados. **Supervisado** quiere decir que sale con el OK del operador (calibración
  en curso, primer WhatsApp, siempre la respuesta a un interesado); **autónomo**, que sale solo.
  Sólo muestra: el modo se cambia donde siempre (calibración en Administración, primer WhatsApp en
  Canales).
- **Derecha, lo que pasó hoy** en la zona horaria del cliente, en orden: hora, estado (✓ ejecutado,
  ◐ esperando OK, ✕ error), canal y qué pasó. Sale de la línea de tiempo del registro (sin lo
  interno de los bots) y de lo que se hizo en el panel.

Debajo, «Registro completo del panel» abre la auditoría de siempre.
