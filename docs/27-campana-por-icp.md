# Campaña por ICP: empresas parecidas, sin señal de avisos

Estado: **diseño, 10/11/2026.** Sale de la reunión con Alberto Veloso (09/11). Su ICP son
exportadores de agro, alimentos, vino y salmón de Chile (y después Argentina y Perú) afectados por
la nueva norma de certificación de envases (la «204»). Esas empresas casi no publican avisos de lo
que él vende, así que la campaña de hoy (`18`, señal = aviso reciente) no le sirve. Complementa a
`21` §4.2 (tipos de campaña), `18` (lógica del prospector), `19` (pedido a ASCI) y `26` (carga por
Excel, que da las semillas y las exclusiones).

## 1. Qué cambia respecto de la campaña por señal

| | Prospección por señal (`diaria`, hoy) | Prospección por ICP (nueva) |
|---|---|---|
| Por qué esta empresa | Publicó un aviso de lo que vende el cliente en los últimos 14 días | **Se parece a su ICP**: rubro, país, tamaño, lo que dice de sí misma, y se parece a sus clientes actuales |
| De dónde salen | `avisos_recientes` de ASCI | ASCI (empresas por perfil) y, si no alcanza, Apollo a través de ASCI |
| Orden | El aviso más nuevo primero | El **ajuste al perfil** (§3.3), y lo que el operador cure |
| A quién | Publicante + decisor | **Los decisores definidos** en la campaña (uno o dos por cuenta, con ángulos distintos) |
| Motivo del primer mail | El aviso, con fecha | La **tesis de la cuenta**: un hecho concreto de esa empresa que conecta con la propuesta (exporta a X, produce Y, tiene planta en Z) y, si la hay, la razón del momento (la norma) |
| Volumen | Lo que haya en la ventana | Lo que pida la campaña, con un universo que se agota: hay que llevar la cuenta |
| Riesgo | Pocas cuentas | Mails genéricos. Se compensa con la tesis obligatoria y la curación (§4) |

## 2. Lo medido en ASCI (10/11)

Consultas sobre el corpus de ASCI (`consultar`), empresas con país Chile:

| Qué | Empresas en Chile |
|---|---|
| Vertical `alimentos_bebidas` | 494 (297 con sitio web) |
| Vertical `agro` | 135 (107 con sitio web) |
| Vertical `manufactura` (incluye envases) | 1.173 |
| Descripción que nombra salmón, acuícola o pesquera | 68 |
| Descripción que nombra fruta, cereza, arándano, viña o vino | 191 |
| Descripción que menciona exportación | 122 |
| Total de empresas de Chile en el maestro | 7.703 |

Lo que dice esto:

- **Hay universo para empezar** (unas 600–700 empresas de Chile del rubro), pero no hay una
  vertical acuícola ni pesquera: las salmoneras se encuentran por la descripción o el nombre. Es
  lo que se vio en la demo («salmoneras casi no aparecen»).
- **El tamaño falta en un tercio** y el sitio web en un 40 %. Sin dominio no hay
  `registro_guardar_cuenta` con deduplicación ni `buscar_contactos` exacto: hay que completarlo.
- **«Exporta» no es un campo:** sale del texto de la descripción, de los avisos que la nombran o
  de la base del cliente (SAC). La base del SAC (`26`) es la mejor fuente para ese dato.
- **ASCI no tiene hoy una herramienta para esto.** `prospectar` exige una tecnología (fabricante,
  categoría, producto o ciclo de vida) y ordena por evidencia técnica; `tomadores_de_decision` y
  `buscar_contactos` parten de una empresa ya elegida. Se puede hacer con `consultar`, pero es SQL
  libre, solo para administradores y no apto para un bot. Hace falta un pedido a ASCI (§6).

## 3. Cómo elige el prospector

### 3.1 El perfil de la campaña

Ajustes nuevos de la campaña, bloque «Audiencia»:

| Ajuste | Ejemplo para Alberto | Para qué |
|---|---|---|
| `paises` | Chile (después Argentina, Perú) | País de la empresa, no de la casa matriz |
| `verticales` | `agro`, `alimentos_bebidas` | Las de ASCI (`core.vertical`) |
| `terminos_empresa` | `exporta`, `salmón`, `acuícola`, `cereza`, `arándano`, `viña`, `pesquera`, `frutícola` | Se buscan en la descripción, el nombre y el sector de los avisos de la empresa |
| `excluir_terminos` | `distribuidora`, `importadora`, `restaurante`, `retail` | Lo que parece del rubro y no es |
| `tamano_min` / `tamano_max` | 200 / — | Corporaciones (la licencia es de 6.000 USD por año) |
| `sin_tamano` | Incluir | Un tercio de las empresas no lo tiene: no dejarlas afuera de entrada |
| `semillas` | Copefruit, Agrosuper, Ortiz, más las filas `semilla` de la base del SAC | Las cuentas «como estas» (§3.2) |
| `roles_objetivo` (ya existe) | Gerente de Comercio Exterior, Jefe de Exportaciones, Gerente de Calidad, Jefe de Aseguramiento de Calidad, Gerente de Operaciones, Gerente General (en las medianas) | Los decisores definidos |
| `decisores_por_cuenta` | 2 | Uno de comercio exterior y uno de calidad, con ángulos distintos |
| `curar_lista` | Sí durante el piloto | La lista de la semana se aprueba antes de revelar (§4) |
| `fuentes` | ASCI primero, Apollo si faltan | §3.4 |

El ICP en texto (`icp`) y la propuesta siguen siendo los de siempre; estos campos son los que el
bot pasa a las herramientas.

### 3.2 Semillas: «empresas como estas»

Las semillas son cuentas que el cliente ya ganó o que le gustan (uso `semilla` de `26`, o la lista
de la campaña). De cada una ASCI saca su perfil: verticales con peso, industria de LinkedIn,
tamaño, términos frecuentes de la descripción y de sus avisos, país. La búsqueda por parecido toma
la unión de esos perfiles y ordena a las demás empresas por cuánto se parecen.

Las semillas **nunca reciben mails**: quedan `excluida` con motivo «semilla» (`26` §2).

### 3.3 Orden: el ajuste al perfil

Sin aviso no hay fecha que ordene. Cada candidata trae un **puntaje de ajuste** (de 0 a 100) con su
desglose, para que el bot y el operador vean por qué entró:

| Componente | Peso | De dónde |
|---|---|---|
| Vertical pedida | 30 | `core.empresa_vertical` (más peso si viene del maestro y de los avisos) |
| Términos en la descripción o en los avisos | 30 | `core.company.descripcion`, `job_posting` (con el índice de texto) |
| Tamaño dentro del rango | 15 | `tamano_desde`/`tamano_hasta`; sin dato, la mitad |
| Parecido a las semillas | 15 | Vertical, industria y términos en común |
| Contactabilidad | 10 | Tiene sitio web, tiene decisores en caché (`tomadores_de_decision`) |

A igual puntaje, primero las que ya tienen decisores en caché (no gastan créditos) y después las
que tienen avisos en los últimos 12 meses (señal de actividad, aunque no sea del rubro).

### 3.4 Fuentes, en orden

1. **ASCI, empresas por perfil** (herramienta nueva, §6.1). Gratis.
2. **ASCI, personas por concepto** (`personas_por_texto`, ya existe): para rubros que el maestro
   cubre mal, gente que **hoy** trabaja en comercio exterior o calidad y nombra el rubro
   («exportación de fruta», «salmón», «certificación de envases») da su empresa. Sirve para las
   salmoneras. Gratis, con el cupo de contactos del rol.
3. **Apollo a través de ASCI** (herramienta nueva, §6.2): búsqueda de empresas por industria,
   palabras clave, país y tamaño, para lo que ASCI no tiene. Gasta cuota de Apollo, no créditos de
   reveal. Las empresas que vuelven quedan cacheadas en ASCI para todos.
4. **La base del cliente** (`26`): si la campaña es mixta, las filas `prospectar` de la base del
   SAC entran primero.

El bot no completa con cuentas que no alcanzan el puntaje mínimo de la campaña (`ajuste_min`, 50
por defecto): hace menos y lo dice, como hoy con la ventana de avisos.

### 3.5 Decisores y reveal

1. `tomadores_de_decision` (caché, gratis) con `titulos` = los cargos de la campaña y `pais`.
2. Si no hay nadie: `buscar_contactos` con `dominio`, `titulos` y `seniority` (`director`, `head`,
   `manager`, más `c_suite` si la empresa es mediana). Gratis, con la cuota diaria.
3. Elige hasta `decisores_por_cuenta` personas de **áreas distintas** (comercio exterior y calidad),
   no dos de la misma.
4. `revelar_lote` (1 crédito por persona no cacheada) solo después de la curación si `curar_lista`
   está prendido, y con el tope de reveals del pedido (§5.3).
5. Si una cuenta no tiene a nadie con los cargos pedidos, queda `descartada` con motivo «sin
   decisor» y una fecha para revisarla en 90 días (puede que Apollo la complete después).

## 4. La lista de la semana (curación)

Es lo que se le contó a Alberto: el lunes los bots arman la lista y alguien la revisa antes de
contactar.

1. **Lunes, routine del `prospector` (tarea `icp_lista`):** arma la lista de la semana de cada
   campaña por ICP (cuentas por día × días hábiles, más un 30 % de margen), con cuenta, puntaje,
   desglose, tesis propuesta y los cargos que encontró (sin revelar).
2. La guarda como aprobación tipo **`lista_cuentas`** (nueva) con todas las filas.
3. El `orquestador` la presenta en su chat; el operador (o el cliente, si el MCP del panel le da la
   aprobación, `24`) contesta «sí», «sí sin 3, 7 y 12», o «sacá las chicas y las que no exportan».
4. Las que se aprueban pasan a `en_investigacion` con su tesis; las rechazadas quedan
   `descartada` con el motivo que dio el operador (el bot aprende de los motivos: van a la memoria
   de la campaña como reglas guía).
5. De martes a viernes, la tarea diaria toma de esa lista las cuentas del día y recién ahí revela y
   escribe.

Con `curar_lista` apagado (después del piloto), la lista se arma igual, queda registrada para que
se pueda ver y sale sin aprobar.

## 5. El primer mail sin señal

### 5.1 La tesis

Obligatoria por cuenta, en una o dos líneas, con **un hecho verificable** de esa empresa:

- de la descripción («exportan cerezas y arándanos a China y EE. UU.»);
- de un aviso, aunque no sea del rubro («están buscando un jefe de calidad para la planta de
  Rancagua»);
- de la base del cliente (la nota de `26`);
- del contexto del rubro, solo si aplica a esa empresa («la 204 exige … a quien exporta envases de
  vidrio»).

Sin hecho propio, la cuenta no sale: se descarta con motivo «sin tesis». Esto es lo que evita el
mail genérico.

### 5.2 Ángulo por persona

| A quién | Ángulo |
|---|---|
| Comercio exterior | El riesgo en destino (rechazos, retención en aduana) y los plazos de la norma |
| Calidad / aseguramiento | La certificación como proceso: trazabilidad, auditorías, carga de trabajo |
| Gerente general (medianas) | Costo de no cumplir y el caso de un par del rubro (`prueba_social`) |

Si van dos personas de la misma cuenta, la segunda sale un día hábil después, como hoy.

### 5.3 Volumen y costos

- `cuentas_por_dia` como cualquier campaña, dentro del tope del cliente.
- **Reveals por día:** nuevo `reveals_por_dia` en la campaña (por defecto `cuentas_por_dia ×
  decisores_por_cuenta`). Con 4 cuentas y 2 decisores son unos 8 créditos por día, unos 170 por
  mes: hay que confirmarlo contra el presupuesto del usuario de ASCI del cliente.
- Las búsquedas de Apollo por empresa (§3.4.3) tienen su propio tope por día.

## 6. Pedido a ASCI

Mismo formato que `19`.

### 6.1 `cuentas_por_perfil` (nueva)

Empresas por perfil de negocio, sin tecnología.

| Parámetro | Tipo | Notas |
|---|---|---|
| `pais` | texto, obligatorio | País de la empresa (`core.empresa_pais`) |
| `verticales` | lista | `core.vertical`; pasa si tiene cualquiera |
| `industrias` | lista | Texto de LinkedIn, en inglés |
| `terminos` | lista de frases | Sobre descripción, nombre y sector de sus avisos; sin acentos y por raíz, como `personas_por_texto` |
| `excluir_terminos` | lista | |
| `tamano_min`, `tamano_max`, `incluir_sin_tamano` | | |
| `parecidas_a` | lista de nombres o dominios | Semillas (§3.2); se resuelven como en `resolver_cuentas` |
| `excluir` | lista de dominios o nombres | Lo que el registro ya trabaja o el cliente excluyó (hasta 2.000) |
| `limite`, `pagina` | | 60 por defecto |

Devuelve, por empresa: nombre, dominio, `account_id` si está resuelta, país, verticales, industria,
tamaño, el fragmento de la descripción donde aparecieron los términos, avisos de los últimos 12
meses (cuántos y el último), si tiene decisores en caché y el **puntaje con su desglose** (§3.3).
Y `filtros` con lo que quedó afuera (sin tamaño, proveedores, excluidas), como `prospectar`.

Sin costo de créditos. Proveedores y consultoras afuera por defecto.

### 6.2 `empresas_apollo` (nueva)

Búsqueda de organizaciones en Apollo (`mixed_companies/search`) por palabras clave, industria,
país y rango de empleados, con caché compartida y su tope diario, para lo que el maestro de ASCI no
tiene. Lo que vuelve se guarda en `core.company` (fuente `apollo`) para que la próxima vez salga de
`cuentas_por_perfil`. Devuelve el dominio siempre que Apollo lo tenga.

### 6.3 Mejoras chicas

- **Vertical `pesca_acuicultura`** en `core.vertical`, con reglas por nombre y por industria
  («Fishery», «Aquaculture», «salmon»). Hoy esas empresas caen en `alimentos_bebidas` o en nada.
- Completar el **sitio web** desde Apollo cuando se revela a alguien de una empresa sin dominio.

### 6.4 Cómo saber que está

Con Alberto como caso: `cuentas_por_perfil(pais: "Chile", verticales: ["agro",
"alimentos_bebidas"], terminos: ["export", "salmon", "acuicola", "cereza", "vina"], tamano_min:
200, incluir_sin_tamano: true, parecidas_a: ["Copefruit", "Agrosuper"])` devuelve al menos 150
empresas, con salmoneras, cada una con dominio en más del 80 % de los casos y un desglose del
puntaje legible.

## 7. Cambios en el SDR

| Pieza | Qué |
|---|---|
| `ajustes.mjs` | Tipo `icp` en `TIPOS` («Prospección por perfil»), con sus campos (§3.1) en el bloque Audiencia; para activarla: propuesta, cargos, país y al menos una vertical, un término o una semilla. `senal_avisos` y `dias_aviso` no aplican |
| `store.mjs` | `seccionesCliente` muestra los campos del perfil en la sección de la campaña, citados como datos del cliente |
| Aprobaciones | Tipo nuevo `lista_cuentas` (§4), con decisión por fila; `registro_pedir_aprobacion` lo acepta solo de `prospector` |
| Registro | `cuenta.senales` admite tipo `perfil` (puntaje, desglose, fuente) además de `aviso`; `cuenta.estado_motivo` para «sin decisor» y «sin tesis» |
| Topes | `reveals_por_dia` por campaña, contado por el gateway con los eventos `prospecto.revelado` del día |
| Panel | Campaña de tipo ICP: los campos del perfil, la lista de semillas (de los lotes `semilla` de `26` o escritas a mano), la vista de la lista de la semana con su estado |
| `playbooks/prospector/` | `icp_lista.md` (lunes, §4) y `icp_diaria.md` (martes a viernes: revelar, escribir con tesis, cargar en Dripify). Reusan «Escribir los textos de LinkedIn», «Enviar o pedir aprobación» y «Seguimientos» de `diaria` |
| `playbooks/orquestador/` | Repartir por campaña como hoy; una campaña `icp` con `curar_lista` sin lista aprobada no recibe pedido diario, y el orquestador avisa que hay una lista esperando |
| `playbooks/rutinas.json` | Routine `icp_lista` los lunes a primera hora de la zona del cliente |

## 8. Riesgos

| Riesgo | Mitigación |
|---|---|
| Mails genéricos, sin motivo real | Tesis obligatoria con un hecho de la empresa (§5.1); curación en el piloto; calibración de la campaña nueva (5 mails, `21` §4.4) |
| Se agota el universo (Chile del rubro son cientos, no miles) | El resumen de la campaña muestra cuántas quedan; el orquestador avisa al 20 %; se abre país o se suman términos |
| Gasto de créditos sin respuesta | `reveals_por_dia`, reveal después de la curación, decisores cacheados primero |
| Empresas sin dominio | Se completan por Apollo; sin dominio no salen (no hay forma de deduplicar ni de verificar el mail) |
| El ICP es de corporaciones y Apollo trae pymes | `tamano_min` y el puntaje; el operador cura |
| Pisar a los referidos y clientes de Alberto | Carga `manual` de `26` antes de activar la campaña; `excluir` en `cuentas_por_perfil` con todo el registro |
| Depender de ASCI para construir §6 | Mientras tanto, la lista se puede armar desde el chat con `consultar` (administrador de Biguá) y cargarse por `26` como campaña `lista`: el piloto no espera a la herramienta |

## 9. Etapas

| Etapa | Qué | Sale cuando |
|---|---|---|
| **0 · Puente** | Sin código nuevo en el SDR: un operador de Biguá arma la primera lista de Alberto en ASCI (`consultar` + `personas_por_texto` + `tomadores_de_decision`) y la carga con `26` como campaña `lista` | Salen los primeros mails de Alberto en calibración |
| **1 · ASCI** | `cuentas_por_perfil` y la vertical `pesca_acuicultura` (§6) | Se cumple §6.4 |
| **2 · SDR** | Tipo `icp`, campos del perfil, `icp_lista` y `icp_diaria`, aprobación `lista_cuentas`, `reveals_por_dia` | La lista del lunes se aprueba en el chat y el prospector escribe de martes a viernes solo con lo aprobado |
| **3 · Apollo** | `empresas_apollo` y la mezcla de fuentes | La campaña sigue con cuentas cuando ASCI se agota |
| **4 · Sin curación** | `curar_lista` apagado por campaña, con el aprendizaje de los motivos de rechazo | Cuatro semanas con menos del 10 % de rechazos en la lista |

Para el piloto de Alberto alcanza con la etapa 0 y la etapa 1 de `26`; las demás llegan durante los
tres meses.
