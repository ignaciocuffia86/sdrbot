# SDR BOT · Diseño multitenant

Documentación de diseño del SDR BOT de Biguá sobre Grok Bot: prospección por señales (avisos y novedades de ASCI), mail multi-casilla, LinkedIn y WhatsApp con aprobación, y derivación de interesados al cliente final. Operado de forma centralizada por Biguá para N clientes.

BairesQA aparece como cliente modelo. Es un placeholder: el objetivo es que cualquier cliente entre por el mismo manifiesto y el mismo runbook.

| Documento | Qué contiene |
|---|---|
| [01-revision-diseno-v1.1.md](01-revision-diseno-v1.1.md) | Revisión del documento "SDR BOT · Gestión centralizada multicliente" v1.1: qué está sólido, hallazgos verificados contra el estado real de ASCI, problemas y vacíos, propuesta para cada punto abierto y deltas al modelo de datos |
| [02-arquitectura.md](02-arquitectura.md) | Arquitectura objetivo: plano de control y plano de ejecución, identidad y secretos por tenant, integración con ASCI (rol, reveal, uso, playbook de señales), contratos de routines, aprobaciones, observabilidad, cumplimiento, decisión RPC vs MCP, qué cambia con la escala |
| [03-onboarding-y-prerrequisitos.md](03-onboarding-y-prerrequisitos.md) | Qué entrega el cliente, qué construye y decide Biguá, runbook de alta y baja, plan por fases y decisiones pendientes |
| [tenant-manifest.example.yaml](tenant-manifest.example.yaml) | Manifiesto estándar de tenant: la única entrada del proceso de alta, con BairesQA como ejemplo |

Orden de lectura sugerido: revisión → arquitectura → onboarding → manifiesto.

Estado: diseño. No hay implementación en este repositorio todavía.
