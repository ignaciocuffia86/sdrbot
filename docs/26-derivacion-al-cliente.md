# Derivación de un interesado al cliente

Las casillas y dominios secundarios son para prospectar. Cuando alguien contesta interesado, la
conversación pasa al cliente, a la casilla del **dominio principal** de quien toma a los
interesados. Se hace en el mismo hilo, con esa persona en copia: el interesado ve la presentación,
el hilo sigue entero y el dominio principal sólo le escribe a quien ya contestó.

## Cómo funciona

1. `seguimiento` clasifica la respuesta como positivo y escribe la contestación presentando al
   responsable («te sumo en copia a Augusto, que lleva esto de nuestro lado»).
2. Pide la aprobación `respuesta_positivo` con `contenido.cc` = el mail del responsable. El
   gateway controla la copia al pedirla y otra vez al mandarla (abajo).
3. Aprobada, `responder` la manda con `cc` exactamente igual. Al salir, el gateway registra el
   evento `derivado` y guarda en el prospecto `derivado_a` y `derivado_at` (migración 018).
4. Augusto contesta *a todos* desde el dominio principal y la conversación sigue con él.

## Qué controla el gateway

| Regla | Dónde |
|---|---|
| La copia sólo va a quien toma a los interesados (`responsable_email` de la campaña o de Empresa; si no está, el mail escrito en `responsable_positivos`) o a alguien de su mismo dominio. Con un dominio público (gmail.com…), sólo esa dirección. El prospecto no va en copia | `controlarCopia` (`copia_no_permitida`, `sin_responsable`) |
| La copia va sólo en una respuesta a un positivo por mail, y sólo con una aprobación que la lleve igual: ni una dirección de más ni de menos | `pedirAprobacion`, `controlarEnvio` (`aprobacion_no_coincide`) |
| El cliente y el operador ven la copia antes de aprobar y no la cambian: si no es la persona, se rechaza con una nota | panel (`contenidoAprobacion`), MCP del panel, reglas del orquestador |
| A un derivado no le sale ningún mail nuevo del SDR, y lo que se le conteste pide aprobación aunque ya no figure como positivo (mail, LinkedIn y WhatsApp) | `controlarDestinatarios` (`prospecto_derivado`), `pideAprobacionComoPositivo` |
| Se frena su campaña de LinkedIn y sale de la agenda del orquestador | `aplicarEvento` (`derivado`), `agenda` |
| Lo que escribe el responsable (o alguien de su dominio) en el hilo se guarda como `del_responsable`, atendido, con una nota en la línea de tiempo: no es una respuesta del prospecto ni despierta a `seguimiento` | `correo.procesar` |
| Lo que escribe el prospecto después llega como respuesta, con `datos.derivado_a`: `seguimiento` sólo le recuerda, con aprobación, que lo sigue el responsable | `correo.procesar`, reglas de `seguimiento` |

Un bot no puede marcar a nadie como derivado con `registro_evento`: `derivado_a` decide qué mails
dejan de contar como respuestas del prospecto, así que sólo lo escribe el gateway al mandar una
copia aprobada.

## Recomendaciones para el cliente

- Cada casilla secundaria lleva el nombre de una **persona real** del equipo del cliente
  (idealmente la misma que toma a los interesados), no un nombre inventado.
- Que la web del dominio secundario redirija a la del principal.
- Nada de `Reply-To` del dominio principal en los mails fríos: es señal de spam y el gateway
  dejaría de ver las respuestas.
- Con más de un responsable (por país, por producto), cada campaña tiene el suyo
  («Mail de quien toma a los interesados» en la campaña).
