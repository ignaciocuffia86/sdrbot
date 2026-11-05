-- Ajustes del SDR en el panel /admin: los usuarios de cada cliente editan su oferta, tono,
-- firma, ICP y objeciones; los operadores de Biguá, además, lo técnico. Cada cambio queda en
-- el historial con quién lo hizo, y se puede volver a una versión anterior.
--
-- El rol del portal (003) ve y cambia sólo los ajustes de su cliente: ni la calibración, ni los
-- bots activos, ni el canal, ni nada del registro.

create table if not exists sdr.ajustes_historial (
  id         bigint generated always as identity primary key,
  client_id  text not null references mailgw.client on delete cascade,
  ajustes    jsonb not null,
  cambios    text[] not null default '{}',
  por_email  text,
  por_rol    text check (por_rol is null or por_rol in ('bigua_admin', 'client_admin', 'cli')),
  nota       text,
  at         timestamptz not null default now()
);
create index if not exists ajustes_historial_cliente on sdr.ajustes_historial (client_id, id desc);
alter table sdr.ajustes_historial enable row level security;

grant usage on schema sdr to mailgw_portal;
grant select on sdr.cliente_config to mailgw_portal;
grant update (ajustes, actualizado_at) on sdr.cliente_config to mailgw_portal;
grant select, insert on sdr.ajustes_historial to mailgw_portal;

do $$
declare s text := pg_get_serial_sequence('sdr.ajustes_historial', 'id');
begin
  execute format('grant usage on sequence %s to mailgw_portal', s);
end $$;

drop policy if exists portal_por_cliente on sdr.cliente_config;
create policy portal_por_cliente on sdr.cliente_config for all to mailgw_portal
  using (client_id = mailgw.current_client()) with check (client_id = mailgw.current_client());

drop policy if exists portal_por_cliente on sdr.ajustes_historial;
create policy portal_por_cliente on sdr.ajustes_historial for all to mailgw_portal
  using (client_id = mailgw.current_client()) with check (client_id = mailgw.current_client());

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema sdr from anon, authenticated;
  end if;
end $$;
