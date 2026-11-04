-- Aislamiento entre clientes en la base, no sólo en el código del gateway.
--
-- Hasta la 001 la separación dependía de que cada consulta filtrara por el cliente del
-- token, y el gateway se conectaba con el dueño de las tablas, que saltea RLS. Una consulta
-- con un error alcanzaba para cruzar datos. Desde acá:
--
--   1. Todas las tablas con datos de un cliente llevan client_id, y los envíos quedan
--      atados a un buzón del mismo cliente por clave foránea compuesta.
--   2. El gateway trabaja con el rol mailgw_app: sin BYPASSRLS, no es dueño de nada, y sólo
--      tiene los permisos que usa. Lo toma en cada transacción con
--      set_config('role', 'mailgw_app', true) junto con set_config('mailgw.client_id', ...).
--   3. Políticas por cliente en cada tabla: sin mailgw.client_id fijado no ve ninguna fila,
--      y no puede escribir filas de otro cliente.
--   4. Los tokens no se leen directo: mailgw.autenticar(hash) los busca por hash y
--      devuelve el cliente. Es lo único que corre antes de saber de qué cliente es el pedido.
--
-- La CLI de administración sigue usando el dueño: es la herramienta del operador para dar
-- de alta clientes, buzones y tokens.

-- ---------------------------------------------------------------- client_id en todas las tablas

alter table mailgw.account
  add constraint account_id_cliente unique (id, client_id);

alter table mailgw.send_log add column if not exists client_id text;
update mailgw.send_log l set client_id = a.client_id
  from mailgw.account a where a.id = l.account_id and l.client_id is null;
alter table mailgw.send_log alter column client_id set not null;
alter table mailgw.send_log
  add constraint send_log_buzon_del_cliente foreign key (account_id, client_id)
  references mailgw.account (id, client_id) on delete cascade;
create index if not exists send_log_por_cliente on mailgw.send_log (client_id);

alter table mailgw.send_counter add column if not exists client_id text;
update mailgw.send_counter s set client_id = a.client_id
  from mailgw.account a where a.id = s.account_id and s.client_id is null;
alter table mailgw.send_counter alter column client_id set not null;
alter table mailgw.send_counter
  add constraint send_counter_buzon_del_cliente foreign key (account_id, client_id)
  references mailgw.account (id, client_id) on delete cascade;

-- ---------------------------------------------------------------- rol de la aplicación

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mailgw_app') then
    create role mailgw_app nologin nobypassrls;
  end if;
end $$;

-- Quien corre las migraciones (postgres en Supabase) tiene que poder tomar el rol.
grant mailgw_app to current_user;

grant usage on schema mailgw to mailgw_app;
grant select on mailgw.client to mailgw_app;
grant select, update on mailgw.account to mailgw_app;
grant select, insert, update, delete on mailgw.send_log to mailgw_app;
grant select, insert, update on mailgw.send_counter to mailgw_app;
grant insert on mailgw.audit_log to mailgw_app;
grant usage on all sequences in schema mailgw to mailgw_app;
-- Sin permisos sobre mailgw.token ni mailgw.migration.

-- ---------------------------------------------------------------- políticas por cliente

create or replace function mailgw.current_client()
returns text language sql stable set search_path = '' as $$
  select nullif(current_setting('mailgw.client_id', true), '')
$$;

drop policy if exists por_cliente on mailgw.client;
create policy por_cliente on mailgw.client for select to mailgw_app
  using (id = mailgw.current_client());

drop policy if exists por_cliente on mailgw.account;
create policy por_cliente on mailgw.account for all to mailgw_app
  using (client_id = mailgw.current_client())
  with check (client_id = mailgw.current_client());

drop policy if exists por_cliente on mailgw.send_log;
create policy por_cliente on mailgw.send_log for all to mailgw_app
  using (client_id = mailgw.current_client())
  with check (client_id = mailgw.current_client());

drop policy if exists por_cliente on mailgw.send_counter;
create policy por_cliente on mailgw.send_counter for all to mailgw_app
  using (client_id = mailgw.current_client())
  with check (client_id = mailgw.current_client());

drop policy if exists por_cliente on mailgw.audit_log;
create policy por_cliente on mailgw.audit_log for insert to mailgw_app
  with check (client_id = mailgw.current_client());

-- ---------------------------------------------------------------- autenticación por token

create or replace function mailgw.autenticar(p_hash text)
returns table (id uuid, client_id text, name text, scopes text[])
language sql security definer set search_path = '' as $$
  update mailgw.token t
     set last_used_at = now()
   where t.token_hash = p_hash
     and t.revoked_at is null
     and (t.expires_at is null or t.expires_at > now())
  returning t.id, t.client_id, t.name, t.scopes
$$;

revoke all on function mailgw.autenticar(text) from public;
revoke all on function mailgw.current_client() from public;
grant execute on function mailgw.autenticar(text) to mailgw_app;
grant execute on function mailgw.current_client() to mailgw_app;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function mailgw.autenticar(text) from anon, authenticated;
    revoke all on function mailgw.current_client() from anon, authenticated;
  end if;
end $$;
