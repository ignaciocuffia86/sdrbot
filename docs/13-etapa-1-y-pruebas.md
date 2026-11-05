# Etapa 1: qué está construido, cómo se da de alta un cliente y las pruebas en Grok

Estado al 04/11/2026. Complementa a `09-arquitectura-v2.md` §9 (etapas 0 y 1).

## 1. Qué está en producción

En `sdrbot.bigua.lat`, el mismo gateway de correo, con el permiso nuevo `sdr`:

- **Reglas de operación** de los bots (`reglas_manual`, `reglas_alta`), versión
  `2026.11.04-1` en los canales `estable` y `canario`. Cubren al `orquestador` (alta, plan del día,
  aprobaciones, resumen, memorias) y al `prospector` (tanda del día, ejecutar lo aprobado). Los
  de `seguimiento` y `whatsapp` llegan en las etapas 2 y 5.
- **Registro de prospección**, **pedidos entre bots**, **aprobaciones** y **bitácora**.
- **Calibración y respuesta a positivos exigidas por el gateway** al enviar.
- **`prueba_carga`** para medir el MCP desde Grok.

Detalle de herramientas y de lo que el gateway hace cumplir: `gateway/README.md`, sección «Núcleo
SDR». Las reglas en sí: carpeta `playbooks/`.

## 2. Alta de un cliente

> Reemplazado por [`15-alta-de-un-cliente.md`](15-alta-de-un-cliente.md) (Biguá),
> [`16-guia-del-cliente.md`](16-guia-del-cliente.md) (cliente) y
> [`17-puesta-en-marcha-operacion-y-baja.md`](17-puesta-en-marcha-operacion-y-baja.md). Lo de abajo queda como historia de la etapa 1.

### 2.1 En el gateway

1. Panel `/admin`: cliente, buzones (y «Verificar» el dominio).
2. Configuración del SDR, con la CLI (más adelante, en el panel):

   ```bash
   node bin/admin.mjs sdr-config <cliente> < config.json
   ```

   ```json
   {
     "calibracion_mails": 20,
     "bots_activos": ["orquestador", "prospector"],
     "zona_horaria": "America/Argentina/Buenos_Aires",
     "ajustes": {
       "nombre_comercial": "…",
       "idioma": "español",
       "icp": "A quién le vende el cliente: país, verticales, tamaño, señales que importan.",
       "roles_objetivo": ["Cargos y roles a los que se escribe (es la elección de a quién revelar)"],
       "oferta": "Qué ofrece, en dos o tres líneas.",
       "tono": "Cómo escribe.",
       "firma": "Nombre, cargo, empresa.",
       "buzones": "Qué buzón usar para qué.",
       "cuentas_por_dia": 10,
       "acepta_mails_extrapolados": false,
       "positivos": ["interesado", "pide reunión", "pide información", "acepta una llamada"],
       "objeciones": ["…"]
     }
   }
   ```

   Los ajustes son libres: lo que se cargue aparece en la sección «Ajustes de este cliente» de las
   reglas de todos los bots.
3. Token para Grok desde la pestaña «Tokens de Grok Bot», con permisos `read`, `draft`, `send` y
   **`sdr`**.

### 2.2 En la cuenta de Grok Bot del cliente

1. Bots `orquestador` y `prospector` (por ahora sólo esos).
2. Conectores: **SDRBOT** (`https://sdrbot.bigua.lat/mcp`, cabecera `Authorization: Bearer
   <token>`) y **ASCI** (`https://mcp.bigua.lat`, con la clave del usuario del cliente).
3. Reglas de la revisión automática (`docs/09` §11):
   - **Allow:** las herramientas del conector SDRBOT y las de ASCI.
   - **Ask first:** `registro_aprobar`. Así, si un mail con instrucciones engañara a un bot para
     que se apruebe algo solo, Grok le pide confirmación a una persona.
4. **Privacy Mode** prendido. **Notifications** prendido en el `orquestador`.
5. Un mensaje al `orquestador`: «Sos el orquestador del SDR de Biguá para <cliente>. Hacé el alta:
   pedí tus reglas con reglas_manual (bot orquestador, tarea alta) y seguilas.» Crea las seis
   routines con `reglas_alta`.

## 3. Etapa 0: pruebas en la cuenta de Grok de Biguá

Antes del piloto. Las que Grok no corrió (`12` A.3). Para las que usan el MCP de SDRBOT, crear un
cliente de prueba en el panel (por ejemplo `prueba-grok`), su configuración con `sdr-config` y un
token con `sdr`, y conectarlo en la cuenta de Biguá.

| # | Prueba | Cómo | Qué anotar |
|---|---|---|---|
| 1 | Mensaje entre bots | Dos bots de prueba, A y B. A B no le pongas routine. Pedile a A: «Mandale a B el mensaje "decime la hora" y anotá la hora en que lo mandaste». Repetir mientras B está corriendo una tarea larga (por ejemplo, pedile a B que cuente hasta 500 de a uno) | Si B se despertó, cuánto tardó, y qué pasó cuando estaba ocupado (lo encoló, lo perdió, lo interrumpió) |
| 2 | Dos bots a la vez | Routines de A y B a la misma hora, cada una: «Llamá prueba_carga con segundos 30 cinco veces y anotá la hora de cada llamada» | Si los horarios de A y B se superponen |
| 3 | MCP desatendido | Una routine con `bitacora_inicio` y `bitacora_fin` (bot `prueba`, tarea `prueba`) **sin** regla Allow, y la misma **con** regla Allow | Si sin Allow quedó esperando aprobación y si venció a los 30 minutos; si con Allow corrió sola |
| 4 | Tamaño y tiempo | En el chat: «Llamá prueba_carga con kb 8, después 32, 128, 512 y 1024; para cada una decime si ves el texto FIN-DE-LA-PRUEBA». Después «prueba_carga con kb 1 y segundos 30», y con 55 | Hasta qué tamaño llega entera la respuesta y si 55 segundos pasan |
| 5 | Error del servidor | En el chat: «Llamá registro_historia con prospecto_id 00000000-0000-0000-0000-000000000000» (da 404) | Si el bot reintenta solo o informa el error |
| 6 | Webhook de routine | Una routine con disparo webhook. Probar con `curl -X POST <url> -H "Authorization: Bearer <key>" -H "Content-Type: application/json" -d '{"prueba": "hola"}'` | Cuánto tarda en arrancar y si el cuerpo aparece en el prompt |
| 7 | Dripify | Con la API key de la cuenta: un `GET` a `https://api.dripify.com/v1/open-api/campaigns` con la cabecera `X-Api-Key` | Si responde (plan con API) o da 403. Y capturar el cuerpo de un webhook real de una campaña |
| 8 | Recorrido completo | Cliente de prueba con un buzón propio, `calibracion_mails: 2`: alta del `orquestador`, una tanda del `prospector` contra cuentas reales de ASCI con `cuentas_por_dia: 2`, aprobar en el chat, ver salir los mails | Si todo queda en el registro (`registro_resumen`) y cuánto uso de Grok gastó (vista de uso por bot) |

Los resultados se anotan en `docs/12` (parte A.3) y lo que cambien en `09`.
