# Asistentes del panel: alta del cliente y armado de campañas

Hay mucho para cargar al dar de alta un cliente, y estaba repartido entre seis pestañas y una guía
(`15`). Si un dato se pide fuera de su contexto, se carga mal o no se carga. Este documento describe
los dos asistentes que ordenan esa carga y dejan pausar lo que todavía no está definido.

## Decisiones

| Tema | Decisión |
|---|---|
| Quién completa el alta | Biguá, junto con el cliente, en la llamada de inicio. El asistente de alta es sólo de Biguá |
| Orden | Primero se configura el cliente (alta); la campaña tiene su propio asistente, que se recorre cada vez que se crea una |
| Pausa | Un paso o un campo puede quedar «esperando una definición», con qué falta y quién lo define. Sin recordatorios por mail: lo pendiente se ve en el panel |
| Dónde se guarda | Cada paso guarda donde ya guardaba el panel (ajustes de Empresa, campaña, buzones, tokens…). El asistente no tiene una copia propia de los datos |

## Alta del cliente

Pestaña **Alta** de la ficha del cliente (sólo Biguá). «Nuevo cliente» la abre sola. Mientras no
esté completa, el Resumen muestra «Alta: N de 16 pasos listos».

| Etapa | Paso | Queda listo cuando | Se puede marcar «no aplica» |
|---|---|---|---|
| Cuenta | Activar el SDR | El SDR está activado | |
| | Usuario del cliente | Tiene al menos un usuario | Sí |
| La empresa | Quién es y cómo habla | Tiene nombre comercial y qué hace la empresa | |
| | Casos y objeciones | Se marca hecho | Sí |
| | Interesados y derivación | Tiene quién toma a los interesados y su mail (`26`) | |
| | A quién no escribirle | Se marca hecho (incluye «No contactar») | Sí |
| Correo | Buzones | Hay un buzón activo que pasó la prueba | |
| | Dominios | Los dominios de los buzones están verificados y sin errores | |
| Canales | LinkedIn · Dripify | La API key está cargada y probada, sin error | Sí |
| | WhatsApp | Está activado | Sí |
| | CRM · HubSpot | La conexión está activa | Sí |
| Bots | Usuario de ASCI | Se marca hecho (se hace fuera del panel) | |
| | Token del gateway | Hay un token vigente con el permiso `sdr` | |
| | Cuenta de Grok Bot | Se marca hecho (se hace fuera del panel) | |
| | Routines | Se marca hecho (se hace fuera del panel) | |
| | Despertadores | Están los de los bots activos que los usan | |

Cada paso muestra qué preguntarle al cliente, qué le falta y, debajo, el mismo formulario o la misma
tarjeta que en el resto del panel. Los pasos que se comprueban con datos no se pueden marcar listos
a mano. Los que pasan fuera del panel (ASCI, Grok, routines) traen su lista de `15`.

El **resumen del alta** junta lo que espera una definición (pasos y campos, con quién lo define) y
lo que falta hacer. Completa el alta, lleva al asistente de la primera campaña en borrador.

## Asistente de campaña

Se abre al crear una campaña y desde el botón **Asistente** de cualquier campaña que no esté
terminada. Lo usan Biguá y el cliente; cada uno edita lo que sus permisos le dejan, como en la
campaña.

| Paso | Secciones de la campaña |
|---|---|
| Objetivo | Tipo, nombre y fechas |
| Para quién | A quién se le escribe, cargos, exclusiones y señal |
| Cuentas | En una «Lista del cliente», la lista de cuentas a prospectar (obligatoria); en las demás, las cuentas modelo del ICP (opcional). Se cargan por Excel o CSV (`27`) |
| Qué ofrecemos | Propuesta y casos que se citan |
| Mensaje y llamado a la acción | Qué se le pide al prospecto, links, tono e idioma |
| Respuestas e interesados | Positivos, objeciones y quién toma a los interesados si no es el de Empresa |
| Canales y ritmo | Buzones, cuentas por día, Dripify y calibración |
| Revisar y activar | Lo que falta para activarla, lo pendiente y cómo la leen los bots |

Un paso queda listo al guardarlo sin que le falte nada de lo que exige la campaña para activarse. El de cuentas no tiene formulario: queda listo con «Listo, seguir», y en una lista sólo si ya hay cuentas cargadas.

## Pausa

- **Un campo:** «Lo definimos después» debajo de cada campo. Lo cargado hasta ese momento se guarda
  y el campo queda pendiente, con qué falta y quién lo define.
- **Un paso:** «Lo definimos después» en la cabecera del paso.
- «Ya está definido» lo saca de pendientes. Un paso con un campo pendiente figura como «espera una
  definición» aunque lo demás esté.

## Modelo y API

Tabla `mailgw.asistente_paso` (migración `019`): por cliente, ámbito (`alta` o
`campana:<id>`) y paso (o `campo:<clave>`), con el estado (`esperando`, `listo`, `no_aplica`), qué
falta, quién lo define, quién lo marcó y cuándo. Un paso sin fila está por hacer, o listo si los datos
lo dicen. El rol del portal sólo ve y escribe las filas de las campañas de su cliente, nunca el alta.

| Ruta | Qué hace |
|---|---|
| `GET /admin/api/clients/:client/asistente/alta` | Los 16 pasos con su estado calculado, qué les falta y lo pendiente (sólo Biguá) |
| `GET /admin/api/clients/:client/asistente/campana:<id>` | Los pasos y campos pausados de una campaña |
| `PUT /admin/api/clients/:client/asistente/:ambito/:paso` | `{ estado: "esperando" \| "listo" \| "no_aplica" \| null, que, quien }` |

## Pestañas

Cada dato vive en un solo lugar, según quién lo carga y para qué:

| Pestaña | Qué tiene | Quién |
|---|---|---|
| Resumen | Lo que necesita atención (con el avance del alta, para Biguá), los números y el estado de cada canal | Los dos |
| Aprobaciones | Los mensajes que esperan un OK | Los dos |
| Campañas | Cada campaña, su asistente y sus cuentas | Los dos |
| Empresa | Lo común a todas las campañas: quién es, cómo habla, casos, interesados, exclusiones y No contactar | Los dos |
| Canales | Lo que el cliente conecta y ve: buzones con su firma, dominios, CRM y el estado de LinkedIn y WhatsApp | Los dos |
| Actividad | El monitor y la auditoría | Los dos |
| Alta | El asistente de alta | Biguá |
| ⚙ Administración | Operación, bots y despertadores, **LinkedIn y WhatsApp** (la API key, la campaña y el webhook de Dripify; las reglas del turno de WhatsApp), usuarios y tokens | Biguá |

## Que no se quede atrás

Cada PR que toque la configuración de un cliente o de una campaña suma lo nuevo al paso que le
corresponde (regla en `CLAUDE.md`). `gateway/test/asistentes.test.mjs` falla si un campo de Empresa,
una sección de la campaña o algo que puede faltar para activarla no está en ningún paso.

## Lo que sigue

- Cerrar la migración del formulario viejo de Empresa (clientes de antes de la `014`).
