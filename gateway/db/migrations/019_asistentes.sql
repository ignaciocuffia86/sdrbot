-- Asistentes del panel (docs/29): el alta de un cliente y el armado de cada campaña, paso a paso y
-- con pausa. Lo que se carga en cada paso va a donde ya iba (ajustes, campaña, buzones…): acá sólo
-- queda en qué quedó cada paso cuando no sale de los datos.
--
--   ambito   'alta' (el cliente) o 'campana:<id>' (una campaña)
--   paso     la clave del paso, o 'campo:<clave>' para un campo que se define después
--   estado   esperando  falta una definición: qué falta (que) y quién la toma (quien)
--            listo      un paso que no se puede comprobar con los datos (la cuenta de Grok, ASCI)
--            no_aplica  el cliente no lo usa (WhatsApp, CRM…)
--
-- Un paso sin fila está por hacer, o listo si los datos lo dicen. El alta la hace Biguá; los pasos
-- de una campaña los puede pausar también el cliente, sólo los de sus campañas.

create table if not exists mailgw.asistente_paso (
  client_id       text not null references mailgw.client on delete cascade,
  ambito          text not null check (ambito = 'alta' or ambito ~ '^campana:[0-9a-f-]{36}$'),
  paso            text not null check (paso ~ '^(campo:)?[a-z][a-z0-9_]{1,60}$'),
  estado          text not null check (estado in ('esperando', 'listo', 'no_aplica')),
  que             text check (length(que) <= 500),
  quien           text check (length(quien) <= 120),
  actualizado_por text,
  actualizado_at  timestamptz not null default now(),
  primary key (client_id, ambito, paso)
);

alter table mailgw.asistente_paso enable row level security;

grant select, insert, update, delete on mailgw.asistente_paso to mailgw_portal;

drop policy if exists portal_campanas on mailgw.asistente_paso;
create policy portal_campanas on mailgw.asistente_paso for all to mailgw_portal
  using (client_id = mailgw.current_client() and ambito like 'campana:%')
  with check (client_id = mailgw.current_client() and ambito like 'campana:%');
