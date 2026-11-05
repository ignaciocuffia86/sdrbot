# Pedido a ASCI: avisos recientes y quién los publicó

> **Hecho el 05/11/2026** en `locasci` (migraciones 0307, 0308 y 0309): `avisos_recientes` y
> `revelar_publicante`, para `operador`. Cómo las usa el SDR: `18` §5 y las reglas del `prospector`
> desde `2026.11.05-6`. Queda pendiente en ASCI el rol `sdr_bot` con las dos herramientas.

Para el equipo (o el agente) que trabaja en el repo de ASCI, `locasci`. Lo pide el SDR de Biguá
(repo `sdrbot`), que usa ASCI por MCP para elegir a quién escribirle. Fecha: 05/11/2026.

Leer antes el `CLAUDE.md` de `locasci`: todo lo de abajo tiene que medirse sobre `limit 1000`,
extrapolarse y entrar holgado en el corte de 60 s del canal.

## 1. Para qué

El bot `prospector` del SDR busca empresas que **acaban de publicar un aviso** de lo que vende el
cliente (por ejemplo, un aviso de QA para un cliente que vende QA tercerizado) y les escribe a dos
personas:

1. **quien publicó el aviso**, que es quien hoy tiene el problema;
2. **quien decide sobre ese puesto** (para un aviso de QA, el gerente de TI, el Head of QA o el CTO),
   buscado y revelado por Apollo a través de ASCI.

La señal tiene que ser **lo más nueva posible**: un aviso de los últimos 14 días, nombrado en el mail.

## 2. Por qué hoy no alcanza

Medido el 05/11 en producción:

| # | Qué pasa | Dato |
|---|---|---|
| 1 | `prospectar` con `ordenar_por: "avisos"` ordena por **cantidad** de avisos de los últimos 12 meses (`avisos_12m` en `ops.t_prospectar_base`, migración 0270) y no devuelve la fecha del último | Una cuenta con avisos de hace diez meses queda arriba de una que publicó ayer |
| 2 | **El 90 % de los avisos de los últimos 14 días no tiene `account_id`** | 35.202 de 38.934 |
| 3 | `prospectar` y `presencia` trabajan sobre cuentas resueltas | Casi todo lo nuevo les es invisible |
| 4 | `novedades` filtra por fecha (`desde`), pero sólo de a 10 empresas, sólo cuentas ya resueltas, sólo avisos con tags (`cardinality(t.tags) > 0`) y **no devuelve quién publicó** | Sirve para confirmar frescura de pocas candidatas, no para descubrir |
| 5 | `core.job_posting.pais` viene **vacío** en los avisos recientes | Los 38.934 de los últimos 14 días; el país sólo sale de `ubicacion` |
| 6 | El 24 % de los avisos trae quién lo publicó (`poster_nombre`, `poster_slug`, `poster_person_id`) | 9.467 de 38.934 |
| 7 | El 18 % son reposteos (`reposteos > 0`) | 6.915 de 38.934. Un rol que no se llena: señal más fuerte |
| 8 | La ingesta es diaria | Avisos publicados hasta el día anterior |

Los avisos de QA en Argentina de los últimos 14 días (búsqueda por texto) son 627, de los que sólo
22 cuentas están resueltas. Entre los no resueltos abundan consultoras, staffing y plataformas de
trabajo remoto, y aparece ruido de la búsqueda por texto.

Mientras tanto el SDR usa `prospectar` para candidatas y `novedades` con `desde` para quedarse con
las que tienen un aviso reciente. Pierde todo lo nuevo sin cuenta y no puede contactar a quien
publicó.

## 3. Lo que se pide

### 3.1 Herramienta `avisos_recientes`

Avisos activos publicados en los últimos N días, **con o sin cuenta resuelta**, agrupados por empresa
y ordenados por el aviso más nuevo.

**Entrada:**

| Parámetro | Tipo | Notas |
|---|---|---|
| `pais` | texto, obligatorio | Como en `prospectar`. Como `job_posting.pais` viene vacío, sale de `ubicacion` (o de la cuenta cuando está resuelta); decidir y documentar cómo |
| `dias` | entero, 1 a 60, por defecto 14 | Ventana sobre `publicado_en` |
| `texto` | texto, opcional | Búsqueda por título y descripción con `job_fts` (por ejemplo `qa \| tester \| testing`). Es el eje de quien vende capacidad por rol |
| `categorias`, `productos` | como en `prospectar`, opcionales | Por tags del aviso (`core.tag_aviso`) |
| `industrias`, `tamano_min`, `tamano_max` | como en `prospectar`, opcionales | Sólo filtran a las empresas resueltas; las no resueltas pasan y se marcan |
| `incluir_proveedores` | booleano, por defecto false | Consultoras, staffing y plataformas que publican por terceros, también entre las no resueltas (por nombre o por una lista curada) |
| `limite` | entero, por defecto 60, máximo 200 | Empresas, no avisos |

Hace falta al menos uno de `texto`, `categorias` o `productos`.

**Salida, una fila por empresa:**

- `empresa`: nombre de la cuenta resuelta, o `empresa_raw`;
- `cuenta_resuelta` (sí/no), `account_id` si hay, `li_company_id`, `dominio` si se conoce;
- `aviso_mas_nuevo`: `job_id`, título, `publicado_en`, `url`, `ubicacion`, `reposteos`, `postulantes`;
- `avisos_en_ventana` (cantidad) y hasta 5 más (título, fecha, url);
- `publicante` del aviso más nuevo, si lo hay: nombre, `poster_slug` (perfil de LinkedIn),
  `poster_person_id`, y si ya hay contacto cacheado;
- `es_proveedor` (para cuando se pide `incluir_proveedores: true`);
- `industria`, `verticales` y `tamano` cuando la cuenta está resuelta.

Orden: `publicado_en` del aviso más nuevo, descendente; a igual fecha, más avisos en la ventana y
reposteados primero. La respuesta dice cuántos avisos y empresas había en la ventana antes de
filtrar, como hace `prospectar` con «filtros», para que el bot no crea que vio todo.

**Costo:** entrar por `job_recientes` (`publicado_en desc where activo`). Una ventana de 14 días son
unas 39 mil filas de 249 mil. La búsqueda por texto sobre esa ventana con `ubicacion ilike` midió
6 s; medir la versión final con `limit 1000` primero.

### 3.2 Revelar al publicante

Un camino para pasar del publicante a su contacto por Apollo, con el mismo cobro y la misma caché
que `revelar_lote`:

- **Opción A:** `revelar_contacto` (o `revelar_lote`) acepta `linkedin_url` además de `apollo_id`, y
  usa el match de personas de Apollo por LinkedIn.
- **Opción B:** herramienta `revelar_publicante(job_id)`, que resuelve el `poster_slug` del aviso
  con Apollo y lo revela.

Debe cobrar 1 crédito sólo si Apollo devuelve a la persona, quedar cacheado para todos y atribuirse
al cliente del usuario que llama, como el resto de los reveals.

### 3.3 Más chico, si 3.1 tarda

En `prospectar`:

- parámetro `avisos_desde` (fecha) que restrinja `ordenar_por: "avisos"` a esa ventana;
- campo `ultimo_aviso` (fecha, título y url) por cuenta.

Arregla el punto 1, no el 2: lo nuevo sin cuenta sigue invisible.

## 4. Permisos

- `avisos_recientes` y el reveal del publicante, para el rol **`operador`** (el bot del SDR entra
  hoy con ese rol) y para **`sdr_bot`** cuando exista (`docs/04` del repo `sdrbot`).
- Sumarlas a los casos de `mcp/probar-listado.mjs` y `mcp/probar-aislamiento.mjs`, y al catálogo
  de `usuarios`.

## 5. Cómo sabemos que está

1. Con `pais: "Argentina"`, `dias: 14` y `texto: "qa | tester | testing"`, devuelve empresas
   ordenadas por el aviso más nuevo, con avisos de los últimos días, **incluidas empresas sin cuenta
   resuelta**, y sin las consultoras ni el staffing por defecto.
2. Cada fila trae el link del aviso y, cuando existe, quién lo publicó.
3. Para un publicante con perfil de LinkedIn, el reveal devuelve su mail y cobra 1 crédito; la
   segunda vez sale de la caché.
4. La consulta entra holgada en el corte (medida con `limit 1000` y extrapolada), y la sexta
   llamada seguida en la misma sesión no se pone lenta (plan genérico; `CLAUDE.md` de `locasci`).

## 6. Qué cambia en el SDR cuando esté

En `sdrbot`, las reglas del `prospector` pasan de `prospectar` + `novedades` a `avisos_recientes`
para descubrir, y suman al publicante como primera persona a contactar. La lógica completa está en
`docs/18-logica-de-prospeccion.md` del repo `sdrbot`.
