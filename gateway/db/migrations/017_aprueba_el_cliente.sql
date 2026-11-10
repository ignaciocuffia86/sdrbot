-- Etapa M2 del MCP del panel (docs/24 §5): el cliente puede aprobar sus mensajes.
--
-- Quién decide se fija por cliente en sdr.cliente_config.aprueba:
--   bigua            sólo Biguá, como hasta hoy;
--   cliente_y_bigua  el que llegue primero;
--   cliente          sólo el cliente: Biguá puede rechazar (frenar), pero no aprobar.
-- Vale para los mensajes (calibracion_mail, respuesta_positivo, whatsapp_primero). crm_mapeo,
-- crm_cambio y otro siguen siendo de Biguá.
--
-- Los clientes que ya existen quedan en 'bigua' (nada cambia para ellos); los nuevos arrancan en
-- 'cliente_y_bigua'.
--
-- Quién decidió cada aprobación sale de la sesión de quien decide, no de un parámetro:
-- decidida_por_usuario (el usuario del panel, si decidió desde el panel o desde Claude),
-- decidida_por_rol (bigua o cliente) y decidida_via (chat del orquestador, panel o mcp_panel).
-- decidida_por sigue con el texto de siempre (el operador del chat, o el mail de la persona).
--
-- La decisión corre con el rol de la aplicación y el cliente fijado, después de que el panel
-- comprobó que la persona puede ver ese cliente: el portal no gana permisos sobre el registro.

alter table sdr.cliente_config add column if not exists aprueba text not null default 'bigua'
  check (aprueba in ('bigua', 'cliente_y_bigua', 'cliente'));
alter table sdr.cliente_config alter column aprueba set default 'cliente_y_bigua';

alter table sdr.aprobacion add column if not exists decidida_por_usuario uuid references mailgw.admin_user on delete set null;
alter table sdr.aprobacion add column if not exists decidida_por_rol text check (decidida_por_rol in ('bigua', 'cliente'));
alter table sdr.aprobacion add column if not exists decidida_via text check (decidida_via in ('chat', 'panel', 'mcp_panel'));

-- Las decididas antes de esta migración fueron todas de Biguá, por el chat.
update sdr.aprobacion set decidida_por_rol = 'bigua', decidida_via = 'chat'
 where decidida_at is not null and decidida_por_rol is null;

-- Límites de uso del MCP del panel y del OAuth (docs/24 §6): cuántos pedidos hizo cada clave en
-- cada minuto. Una clave es «usuario:<id>», «cambios:<id>» o «ip:<dirección>». En la base y no en
-- memoria: en Vercel cada pedido puede caer en una instancia distinta. Las filas viejas se borran
-- solas de a poco (src/panel/limites.mjs). Sólo la toca el dueño.
create table if not exists mailgw.limite (
  clave    text not null,
  ventana  timestamptz not null,
  n        int not null default 0,
  primary key (clave, ventana)
);
alter table mailgw.limite enable row level security;
