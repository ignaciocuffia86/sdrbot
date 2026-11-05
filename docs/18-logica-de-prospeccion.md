# Cómo elige el prospector a quién escribirle: revisión y propuesta

Revisión del 05/11/2026 de la lógica con la que el `prospector` consulta ASCI para elegir cuentas y
personas, con foco en que **la señal sea un aviso lo más nuevo posible**. Los números son medidos
en ASCI ese día. Pendiente de decisión (§5).

## 1. La lógica de hoy

Reglas `prospector/diaria` (`playbooks/prospector/diaria.md`):

1. **Cuentas:** `prospectar(pais, …, ordenar_por: "avisos")`. Para un cliente que vende capacidad
   (QA, desarrollo, staffing), un aviso abierto es una necesidad sin cubrir.
2. Se descartan las que ya están en el registro (en contacto, excluidas, descartadas, en pausa) y
   las consultoras o staffing.
3. **Personas:** `tomadores_de_decision` (caché, gratis) con los cargos de «Ajustes de este
   cliente»; si no hay, `buscar_contactos` (gratis, cuota diaria). Una o dos por cuenta, guardadas
   con el motivo de la elección **antes** de revelar.
4. `revelar_lote` (1 crédito por persona nueva) y el mail con la señal y la tesis.

## 2. Lo que encontramos

| # | Hallazgo | Medido | Efecto |
|---|---|---|---|
| 1 | `ordenar_por: "avisos"` ordena por **cuántos** avisos tuvo la cuenta en los **últimos 12 meses** (`avisos_12m` en `ops.t_prospectar_base`) y no devuelve la fecha del último | Código de ASCI, migración 0270 | Una cuenta con muchos avisos de hace diez meses queda arriba de una que publicó ayer. El bot no puede saber cuán nueva es la señal |
| 2 | La ingesta de avisos es **diaria** | Avisos publicados hasta el 04/11; 17.107 en los últimos 7 días, 38.934 en 14 | El dato está fresco; el problema es cómo se consulta |
| 3 | **El 90 % de los avisos de los últimos 14 días no está atado a una cuenta** (`account_id` vacío) | 35.202 de 38.934 | `prospectar` trabaja sobre cuentas curadas: casi todo lo nuevo le es invisible hasta que se resuelve la empresa |
| 4 | Entre los avisos nuevos de QA en Argentina abundan **consultoras, staffing y plataformas de trabajo remoto**, y aparece ruido de la búsqueda por texto | 627 avisos en 14 días; 22 cuentas atadas | Hace falta filtrar proveedores también en lo no resuelto |
| 5 | El 24 % de los avisos trae **quién lo publicó** (`poster_nombre`) | 9.467 de 38.934 | Quien publica el aviso suele ser quien contrata: el mejor contacto posible, y hoy no se usa |
| 6 | El 18 % son **reposteos** | 6.915 de 38.934 | Un aviso que se vuelve a publicar es un rol que no se llena: señal más fuerte |
| 7 | `novedades` sí filtra por fecha (`desde`) y devuelve los avisos con su contexto, pero **de a 10 empresas** y es la herramienta más cara de ASCI | Descripción de la herramienta | Sirve para confirmar frescura de pocas candidatas, no para descubrir |

## 3. La lógica propuesta

**Regla:** la señal de un mail es **un aviso concreto, publicado hace pocos días**, y se nombra en
el mail. Sin aviso reciente, la cuenta no entra en la tanda de hoy.

| Paso | Qué | Con qué |
|---|---|---|
| 1. Descubrir | Avisos activos publicados en los **últimos 14 días** (ventana del cliente, §5), del país y del rubro del cliente, **con o sin cuenta resuelta**, sin proveedores, ordenados por fecha: lo más nuevo primero | Herramienta nueva de ASCI (§4) |
| 2. Agrupar por empresa | Una fila por empresa con su aviso más nuevo, cuántos tiene en la ventana, si hay reposteos y quién publicó | Misma herramienta |
| 3. Resolver la cuenta | Las que no están atadas, a su cuenta (o se crea) | `resolver_cuentas` |
| 4. Filtrar | Fuera lo que ya está en el registro, las excluidas, las del rubro equivocado y las que no pasan el ICP (tamaño, vertical) | Registro + ajustes |
| 5. Priorizar | Más nuevo primero; a igual fecha, reposteado y varios avisos en la ventana | — |
| 6. Elegir personas | **Primero quien publicó el aviso**, si cumple los cargos del cliente; después `tomadores_de_decision` con los cargos del área del aviso (un aviso de QA → Head of QA, QA Manager, Engineering Manager) | `tomadores_de_decision`, `buscar_contactos` |
| 7. Guardar la señal | En la cuenta: tipo `aviso`, **fecha de publicación**, título, link, reposteo. La tesis dice por qué ese aviso importa hoy | `registro_guardar_cuenta` |
| 8. Escribir | El mail nombra el aviso («vi que publicaron una búsqueda de QA Automation el 3/11») | Reglas «Cómo escribimos» |

**Vencimiento de la señal:** si el mail 1 no salió dentro de los 7 días del aviso (por ejemplo,
esperando aprobación), se vuelve a mirar si el aviso sigue activo antes de mandarlo.

## 4. Lo que hace falta en ASCI

La lógica de §3 necesita una herramienta que hoy no existe. Propuesta (para el equipo de ASCI,
repo `locasci`):

**`avisos_recientes(pais, dias, categorias | productos | texto, excluir_proveedores, limite)`**

- Lee `core.job_posting` por el índice `job_recientes` (avisos activos por fecha): una ventana de 14
  días son unas 39 mil filas, no las 249 mil. Hay que medirla con la regla de ASCI (`limit 1000`
  primero) antes de darla por buena.
- Incluye los avisos **sin cuenta resuelta**, con el nombre de empresa crudo y el id de LinkedIn
  (`li_company_id`) para resolverla después.
- Devuelve por empresa: aviso más nuevo (título, fecha, link), avisos en la ventana, reposteos,
  `poster_nombre` y si la empresa es proveedor.
- Respeta el tope y la atribución por cliente del rol `sdr_bot` cuando exista (`04`).

Alternativa más chica: sumarle a `prospectar` el parámetro `avisos_desde` y devolver
`ultimo_aviso` por cuenta. Arregla el hallazgo 1, pero no el 3: lo nuevo sin cuenta sigue
invisible.

## 5. Mientras tanto, y qué hay que decidir

**Mientras no exista la herramienta**, sin tocar ASCI:

1. `prospectar(…, ordenar_por: "avisos")` como hoy, para candidatas.
2. Para las candidatas que pasan el registro, de a 10: `novedades(empresas, desde: hoy − 14 días)`.
   Se quedan sólo las que tienen un aviso en esa ventana, y se ordenan por la fecha del más nuevo.
3. La señal y el mail, como en §3 pasos 6 a 8.

Pierde lo nuevo sin cuenta (hallazgo 3) y suma llamadas a la herramienta más cara, pero asegura
que ningún mail salga con un aviso viejo.

**Decisiones:**

| # | Pregunta | Propuesta |
|---|---|---|
| 1 | Ventana de frescura del aviso | 14 días; configurable por cliente en los ajustes |
| 2 | ¿Aplicamos ya la versión intermedia en las reglas del `prospector`? | Sí |
| 3 | ¿Se le pide al equipo de ASCI `avisos_recientes` (o se hace en esta línea de trabajo)? | Sí: es lo que más mueve la calidad de la tanda |
| 4 | ¿Se le escribe primero a quien publicó el aviso? | Sí, si su cargo cumple los del cliente |
