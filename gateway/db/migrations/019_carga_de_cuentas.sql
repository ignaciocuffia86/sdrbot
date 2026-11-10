-- Carga de cuentas por archivo, etapa 1 (docs/27 §6.1).
--
-- Dos entradas con el mismo lector (Excel o CSV):
--   campana       las cuentas de una campaña. En la etapa 1, sólo semillas del ICP: quedan en el
--                 registro como excluidas, con su perfil, y no reciben nada. Las cuentas para
--                 prospectar llegan con la campaña de tipo «lista» (etapa 2).
--   no_contactar  la lista de no contactar de la empresa, la de siempre: vale para todas las
--                 campañas y canales.
--
-- La lista de no contactar suma empresas por nombre (tipo 'empresa'), para un referido o un cliente
-- que el archivo trae sin dominio. Se compara por una clave: el nombre en minúsculas, sin tildes,
-- sin puntuación y sin la forma societaria del final (sdr.empresa_clave). La clave se calcula sólo
-- acá, en la base, para que la carga, el registro y los controles del envío digan lo mismo.

create or replace function sdr.empresa_clave(nombre text) returns text
language sql immutable parallel safe
set search_path = pg_catalog
as $$
  select nullif(btrim(regexp_replace(
           -- La forma societaria y sus variantes, al final (una o varias: «S.A. de C.V.», «y Cía. Ltda.»).
           ' ' || btrim(regexp_replace(
             translate(lower(coalesce(nombre, '')), 'áàäâãåéèëêíìïîóòöôõúùüûñçý', 'aaaaaaeeeeiiiiooooouuuuncy'),
             '[^a-z0-9]+', ' ', 'g')),
           '( (s a s|s a c i|s a i c|s a c|s a|s p a|s r l|s l|s de r l|de c v|e i r l|ltda|limitada|ltd|sociedad anonima|sas|saci|saic|sac|sa|spa|srl|sl|eirl|inc|llc|corp|gmbh|plc|y cia|cia))+$',
           '')), '')
$$;

-- ---------------------------------------------------------------- lotes

create table if not exists sdr.lote_carga (
  id           uuid primary key default gen_random_uuid(),
  client_id    text not null references mailgw.client on delete cascade,
  destino      text not null check (destino in ('campana', 'no_contactar')),
  campana_id   uuid,
  archivo      text not null check (length(archivo) between 1 and 200),   -- el nombre, sin la ruta
  hoja         text,
  mapeo        jsonb not null,                -- campo → columna del archivo
  resumen      jsonb not null default '{}',   -- conteos por resultado
  estado       text not null default 'aplicado' check (estado in ('aplicado', 'deshecho')),
  por_email    text not null,
  creado_at    timestamptz not null default now(),
  unique (id, client_id),
  foreign key (campana_id, client_id) references sdr.campana (id, client_id) on delete cascade,
  check ((destino = 'campana') = (campana_id is not null))
);
create index if not exists lote_carga_cliente on sdr.lote_carga (client_id, creado_at desc);

-- ---------------------------------------------------------------- registro

alter table sdr.cuenta add column if not exists lote_id uuid references sdr.lote_carga on delete set null;
alter table sdr.cuenta add column if not exists origen text not null default 'bot' check (origen in ('bot', 'archivo'));
alter table sdr.cuenta add column if not exists uso text check (uso is null or uso in ('prospectar', 'semilla'));
alter table sdr.cuenta add column if not exists datos_origen jsonb not null default '{}'::jsonb;
alter table sdr.cuenta add column if not exists prioridad int;
alter table sdr.cuenta add column if not exists nombre_clave text generated always as (sdr.empresa_clave(nombre)) stored;
create index if not exists cuenta_nombre_clave on sdr.cuenta (client_id, nombre_clave) where nombre_clave is not null;
create index if not exists cuenta_lista on sdr.cuenta (client_id, campana_id, prioridad)
  where origen = 'archivo' and estado = 'en_investigacion';

alter table sdr.prospecto add column if not exists lote_id uuid references sdr.lote_carga on delete set null;

-- ---------------------------------------------------------------- no contactar

alter table sdr.no_contactar drop constraint if exists no_contactar_tipo_check;
alter table sdr.no_contactar add constraint no_contactar_tipo_check check (tipo in ('dominio', 'email', 'empresa'));
-- Una empresa puede tener una clave de dos letras («LG»); dominios y mails, como antes.
alter table sdr.no_contactar drop constraint if exists no_contactar_valor_check;
alter table sdr.no_contactar add constraint no_contactar_valor_check
  check (valor = lower(valor) and length(valor) between 2 and 254 and (tipo = 'empresa' or length(valor) >= 3));
-- Una empresa guarda su clave, que no tiene puntos ni arrobas: no choca con un dominio ni un mail.
alter table sdr.no_contactar drop constraint if exists no_contactar_empresa_check;
alter table sdr.no_contactar add constraint no_contactar_empresa_check
  check (tipo <> 'empresa' or valor = sdr.empresa_clave(valor));
alter table sdr.no_contactar add column if not exists nombre text check (nombre is null or length(nombre) <= 200);
alter table sdr.no_contactar add column if not exists lote_id uuid references sdr.lote_carga on delete set null;

-- ---------------------------------------------------------------- permisos

alter table sdr.lote_carga enable row level security;

-- Una carga a la lista de no contactar la escribe el panel con el rol del portal (o el del dueño),
-- como el alta a mano. Una carga a una campaña escribe cuentas del registro: corre con el rol de la
-- aplicación y el cliente fijado, como las aprobaciones, y crea su lote ahí mismo, en la misma
-- transacción. El portal no gana permisos sobre el registro.
grant select, insert, update on sdr.lote_carga to mailgw_portal;
grant select, insert on sdr.lote_carga to mailgw_app;
grant update (resumen) on sdr.lote_carga to mailgw_app;
grant execute on function sdr.empresa_clave(text) to mailgw_app, mailgw_portal;

drop policy if exists por_cliente on sdr.lote_carga;
create policy por_cliente on sdr.lote_carga for all to mailgw_app
  using (client_id = mailgw.current_client()) with check (client_id = mailgw.current_client());
drop policy if exists portal_por_cliente on sdr.lote_carga;
create policy portal_por_cliente on sdr.lote_carga for all to mailgw_portal
  using (client_id = mailgw.current_client()) with check (client_id = mailgw.current_client());

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on sdr.lote_carga from anon, authenticated;
    revoke all on function sdr.empresa_clave(text) from anon, authenticated;
  end if;
end $$;
