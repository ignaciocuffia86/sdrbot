-- Administración web (/admin): usuarios con roles, sesiones y un rol de base para los
-- usuarios de un cliente.
--
-- Roles:
--   bigua_admin   operador de Biguá: todos los clientes, sus usuarios y los tokens de Grok Bot.
--   client_admin  usuario de un cliente: sólo los buzones de su cliente y su actividad.
--
-- Lo que hace un client_admin corre en la base con el rol mailgw_portal y su cliente fijado,
-- con las mismas políticas por cliente que el gateway: un error en el código del panel no
-- puede tocar buzones de otro cliente.

create table if not exists mailgw.admin_user (
  id                uuid primary key default gen_random_uuid(),
  email             text not null unique check (email = lower(email) and email like '%_@_%'),
  name              text not null,
  role              text not null check (role in ('bigua_admin', 'client_admin')),
  client_id         text references mailgw.client on delete cascade,
  password_hash     text,
  setup_token_hash  text unique,
  setup_expires_at  timestamptz,
  active            boolean not null default true,
  failed_logins     int not null default 0,
  locked_until      timestamptz,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  last_login_at     timestamptz,
  constraint rol_y_cliente check (
    (role = 'bigua_admin' and client_id is null) or (role = 'client_admin' and client_id is not null))
);

create table if not exists mailgw.admin_session (
  token_hash    text primary key,
  user_id       uuid not null references mailgw.admin_user on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  last_seen_at  timestamptz not null default now(),
  ip            text,
  user_agent    text
);
create index if not exists admin_session_por_usuario on mailgw.admin_session (user_id);

alter table mailgw.admin_user    enable row level security;
alter table mailgw.admin_session enable row level security;

-- Quién hizo cada acción del panel.
alter table mailgw.audit_log add column if not exists actor_user_id uuid;

-- ---------------------------------------------------------------- rol de los usuarios de un cliente

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'mailgw_portal') then
    create role mailgw_portal nologin nobypassrls;
  end if;
end $$;

grant mailgw_portal to current_user;

grant usage on schema mailgw to mailgw_portal;
grant select on mailgw.client to mailgw_portal;
grant select, insert, update, delete on mailgw.account to mailgw_portal;
grant select on mailgw.send_counter to mailgw_portal;
grant select, insert on mailgw.audit_log to mailgw_portal;
grant usage on all sequences in schema mailgw to mailgw_portal;
grant execute on function mailgw.current_client() to mailgw_portal;
-- Sin permisos sobre token, admin_user, admin_session, send_log ni migration.

drop policy if exists portal_por_cliente on mailgw.client;
create policy portal_por_cliente on mailgw.client for select to mailgw_portal
  using (id = mailgw.current_client());

drop policy if exists portal_por_cliente on mailgw.account;
create policy portal_por_cliente on mailgw.account for all to mailgw_portal
  using (client_id = mailgw.current_client())
  with check (client_id = mailgw.current_client());

drop policy if exists portal_por_cliente on mailgw.send_counter;
create policy portal_por_cliente on mailgw.send_counter for select to mailgw_portal
  using (client_id = mailgw.current_client());

drop policy if exists portal_lee on mailgw.audit_log;
create policy portal_lee on mailgw.audit_log for select to mailgw_portal
  using (client_id = mailgw.current_client());

drop policy if exists portal_escribe on mailgw.audit_log;
create policy portal_escribe on mailgw.audit_log for insert to mailgw_portal
  with check (client_id = mailgw.current_client());
