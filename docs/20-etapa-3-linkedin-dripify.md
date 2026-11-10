# Etapa 3: LinkedIn por Dripify

Estado al 05/11/2026. Complementa a `09-arquitectura-v2.md` §5.3 y §9, a `14-etapa-2-memoria-del-correo.md`
y al alta de un cliente (`15`, paso 11).

## 1. Cómo funciona

**Mail y LinkedIn van juntos.** A cada persona con URL de LinkedIn, el `prospector` le escribe,
además del mail, los tres textos de la campaña de LinkedIn y la carga en Dripify el mismo día que
sale su mail 1. Sin mail, va sólo por LinkedIn.

**Una campaña esqueleto por cliente.** En Dripify, una sola campaña con la secuencia fija:

```
Invitación con nota {{sdr_nota}}  →  espera a que acepte  →  mensaje 1 {{sdr_mensaje1}}
→  espera 3 o 4 días hábiles  →  mensaje 2 {{sdr_mensaje2}}
```

Todo el texto son **campos personalizados por persona** (custom lead fields): lo único que tiene la
campaña es la secuencia y las esperas. El bot escribe la nota (hasta 300 caracteres con LinkedIn
Premium, 200 sin) y los dos mensajes (hasta 1000, el tope de un campo de Dripify) para cada persona,
y el gateway los carga con la persona por la Open API.

| Pieza | Qué hace |
|---|---|
| `dripify_cargar` | Carga una tanda (hasta 100) en la campaña con los tres textos. Rechaza la carga entera si alguien no tiene LinkedIn, ya respondió, está cerrado, ya estaba cargado, tiene una respuesta sin atender, está en la supresión, tiene textos con marcadores (`{{…}}`, `[Nombre]`) o demasiado largos; en calibración, si los textos no son los aprobados. Idempotente por clave. Registra `linkedin.cargado` con los textos |
| Webhook de la campaña | `POST /hook/dripify/<cliente>/<secreto>?e=…`: invitación, conexión, mensaje y respuesta pasan a la línea de tiempo (`linkedin.invitacion`, `linkedin.conexion`, `linkedin.mensaje`, `respuesta`). La respuesta deja al prospecto en `respondio` y queda para `seguimiento` |
| Lectura de conversaciones | Dripify avisa por webhook sólo la primera respuesta. El reloj (cada 5 minutos) lee por la API las conversaciones de quienes ya respondieron, a lo sumo cada 15 minutos cada una y hasta 10 por vuelta, y trae lo nuevo |
| `linkedin_revisar` / `linkedin_atendido` | Lo que espera a `seguimiento` por LinkedIn, como `correo_revisar` |
| `dripify_conversacion` | La conversación entera, leída de Dripify en el momento |
| `dripify_responder` | Contesta en la conversación. A un positivo, sólo con aprobación `respuesta_positivo` con `canal: "linkedin"` y ese texto |
| `dripify_frenar` / `dripify_reanudar` | Lista negra de Dripify (sale de la secuencia) y vuelta atrás |
| `dripify_estado` | Campaña activa, campos, largo de la nota, números de la campaña y cupo usado |
| Freno cruzado | Si alguien responde por mail, pide la baja o entra a la lista de no contactar del cliente (por mail o por dominio, aunque ya estuviera cargado), el gateway lo saca de la campaña (lista negra) en la próxima vuelta del reloj o en el `correo_revisar` siguiente. Si responde por LinkedIn, Dripify corta la secuencia solo y el gateway ya no deja salir mails de la secuencia (`prospecto_respondio`) |
| Despertador de `seguimiento` | También avisa las respuestas de LinkedIn |
| Calibración | La aprobación del primer contacto (`calibracion_mail`) lleva `contenido.linkedin` con los tres textos, en la misma aprobación que el mail. El operador puede corregirlos en el chat del `orquestador` |
| Cupo de la API | 50 pedidos por minuto y 4500 por día por cliente (Dripify permite 60 y 5000). Pasado eso, `dripify_limite` |
| Panel | Pestaña Canales → «LinkedIn · Dripify»: API key (cifrada, no se vuelve a mostrar), id de la campaña, largo de la nota, **Probar** y **Generar URL del webhook** |

## 2. Lo que prepara el cliente (o Biguá) en Dripify

1. Un plan de Dripify que incluya la **Open API** (si no, la API contesta 403 y el gateway lo dice:
   `dripify_sin_api`).
2. **Settings → Lead fields:** crear tres campos de texto con estos nombres exactos: `sdr_nota`,
   `sdr_mensaje1`, `sdr_mensaje2`.
3. **La campaña esqueleto:** invitación con la nota `{{sdr_nota}}`, mensaje `{{sdr_mensaje1}}` al
   aceptar, espera de 3 o 4 días hábiles y mensaje `{{sdr_mensaje2}}`. Sin otros pasos ni textos
   fijos. Arrancar con 5 a 10 invitaciones por día y subir de a 10–20 % por semana. **Activarla**
   (la API no puede prenderla).
4. Anotar el **id de la campaña** (el número de su URL en Dripify).
5. **Settings → Integrations → Open API:** generar la API key. Va al panel, nunca por chat ni mail.
6. Con LinkedIn Premium o Sales Navigator, la nota puede tener 300 caracteres; sin Premium, 200 (y
   LinkedIn limita las notas por mes).

## 3. El alta en el panel

1. Pestaña **Canales** → **LinkedIn · Dripify**: API key, id de la campaña y largo máximo de la nota.
   **Cargar Dripify.**
2. **Probar:** tiene que decir «listo», con la campaña ACTIVE y los tres campos encontrados. Si
   falta algo, lo lista.
3. **Generar URL del webhook.** Se muestra una sola vez. En la campaña de Dripify, Webhooks, una
   por disparador con la misma URL y al final:

   | Disparador de Dripify | Agregar |
   |---|---|
   | Invitación enviada | `?e=invitacion` |
   | Invitación aceptada | `?e=conexion` |
   | Mensaje enviado | `?e=mensaje` |
   | Respuesta de LinkedIn recibida (con la conversación) | `?e=respuesta` |

   Si se genera otra URL, la anterior deja de andar.
4. En el chat del `orquestador`: «Llamá dripify_estado y decime qué ves». Tiene que decir `listo`.

## 4. Probarlo con una persona

Con calibración, sobre un prospecto de prueba con LinkedIn propio:

1. Pedirle al `prospector` la tanda: la aprobación del primer contacto tiene que mostrar el mail y
   los tres textos de LinkedIn.
2. Aprobar. En `ejecutar_aprobados`, sale el mail y la persona se carga en Dripify
   (`linkedin.cargado` en su historia y la lista nueva en la campaña, «SDR linkedin-…»).
3. Aceptar la invitación desde ese LinkedIn: llega `linkedin.conexion` y Dripify manda el mensaje 1.
4. Contestar el mensaje: llega la respuesta, el prospecto pasa a `respondio`, se despierta a
   `seguimiento` y `linkedin_revisar` la muestra. El mail 2 ya no sale.
5. Con otra persona: contestar **el mail**. En la vuelta siguiente del reloj, la persona queda
   frenada en Dripify (`linkedin.pausado` en su historia).

Mientras tanto, mirar lo que llega del webhook: `select tipo, procesado, error, cuerpo from
sdr.dripify_evento order by id desc limit 10;`. Dripify no publica un ejemplo del cuerpo: si algún
evento queda `procesado = false` con «no se sabe qué evento es» o «ningún prospecto con esa URL»,
el cuerpo guardado dice qué ajustar.

## 5. Lo que queda por ver con la cuenta real

- La forma exacta del cuerpo del webhook (dónde viene la URL del perfil y la conversación). El
  gateway busca cualquier URL `linkedin.com/in/…` en el cuerpo y la conversación en cualquier
  campo cuyo nombre la mencione; si viene distinta, se ajusta con los cuerpos guardados.
- Si mandar un mensaje por la API a alguien en la lista negra funciona (hoy `seguimiento` no lo
  necesita: el freno es para quien respondió por mail).
- Cuánto tarda Dripify en procesar una lista recién cargada: hasta que la persona aparece, el
  freno cruzado se reintenta en cada vuelta del reloj durante 24 horas.
