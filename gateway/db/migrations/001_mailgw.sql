-- Gateway IMAP/SMTP del SDR BOT · esquema mailgw
--
-- Vive en el proyecto de Supabase de la base de control (sdrbot), en su propio esquema.
-- Sólo lo toca el gateway con su conexión de servicio: RLS activada en todas las tablas y
-- ninguna política, así que anon y authenticated no leen ni escriben nada aunque tengan
-- la URL del proyecto.
--
-- La contraseña de cada buzón se guarda cifrada con AES-256-GCM por el gateway
-- (src/crypto.mjs). La clave vive en la variable de entorno MAILGW_ENC_KEYS de Vercel y
-- nunca en la base: un volcado de la base sola no expone ninguna contraseña.

create schema if not exists mailgw;

-- Un tenant del SDR BOT. El id es el slug del manifiesto (tenant.slug).
create table if not exists mailgw.client (
  id          text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name        text not null,
  created_at  timestamptz not null default now()
);

-- Tokens de acceso al gateway, uno o más por tenant. Se guarda sólo el hash.
-- scopes: read (leer y sincronizar), draft (crear borradores), send (enviar y responder),
-- manage (marcar, mover y crear carpetas).
create table if not exists mailgw.token (
  id            uuid primary key default gen_random_uuid(),
  client_id     text not null references mailgw.client on delete cascade,
  name          text not null,
  token_hash    text not null unique,
  scopes        text[] not null default '{read}',
  created_at    timestamptz not null default now(),
  expires_at    timestamptz,
  revoked_at    timestamptz,
  last_used_at  timestamptz,
  constraint token_scopes_validos check (scopes <@ array['read','draft','send','manage']::text[])
);

-- Un buzón IMAP/SMTP de un tenant.
create table if not exists mailgw.account (
  id                 uuid primary key default gen_random_uuid(),
  client_id          text not null references mailgw.client on delete cascade,
  email              text not null check (email = lower(email) and email like '%_@_%'),
  display_name       text,
  username           text not null,
  secret_enc         text not null,
  imap_host          text not null,
  imap_port          int  not null check (imap_port between 1 and 65535),
  imap_security      text not null check (imap_security in ('tls','starttls')),
  smtp_host          text not null,
  smtp_port          int  not null check (smtp_port between 1 and 65535),
  smtp_security      text not null check (smtp_security in ('tls','starttls')),
  timezone           text not null default 'America/Argentina/Buenos_Aires',
  daily_send_cap     int  not null default 40 check (daily_send_cap between 0 and 1000),
  append_sent        boolean not null default true,
  sent_folder        text,
  drafts_folder      text,
  status             text not null default 'active' check (status in ('active','paused','auth_error')),
  auth_failures      int  not null default 0,
  last_ok_at         timestamptz,
  last_error         text,
  last_error_at      timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (client_id, email)
);

-- Libro de envíos. Una fila por clave de idempotencia: un reintento con la misma clave
-- devuelve el resultado anterior en vez de mandar otro mail.
-- status reserved = el envío está en curso (o se cortó a mitad: ver docs/07 §6).
create table if not exists mailgw.send_log (
  id               bigint generated always as identity primary key,
  account_id       uuid not null references mailgw.account on delete cascade,
  idempotency_key  text not null check (length(idempotency_key) between 8 and 200),
  day              date not null,
  kind             text not null check (kind in ('send','reply')),
  status           text not null check (status in ('reserved','sent')),
  message_id       text,
  recipients       text[],
  subject          text,
  smtp_response    text,
  sent_folder      text,
  sent_uid         bigint,
  created_at       timestamptz not null default now(),
  sent_at          timestamptz,
  unique (account_id, idempotency_key)
);
create index if not exists send_log_por_dia on mailgw.send_log (account_id, day);

-- Contador atómico por buzón y día (en la zona del buzón): es donde se hace cumplir el cupo.
create table if not exists mailgw.send_counter (
  account_id  uuid not null references mailgw.account on delete cascade,
  day         date not null,
  count       int  not null check (count >= 0),
  primary key (account_id, day)
);

-- Qué hizo cada token: operación, buzón, si salió bien y un detalle sin contenido de
-- mensajes ni contraseñas.
create table if not exists mailgw.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  client_id   text,
  token_id    uuid,
  account_id  uuid,
  op          text not null,
  ok          boolean not null,
  error_code  text,
  detail      jsonb
);
create index if not exists audit_por_cliente on mailgw.audit_log (client_id, at desc);

alter table mailgw.client       enable row level security;
alter table mailgw.token        enable row level security;
alter table mailgw.account      enable row level security;
alter table mailgw.send_log     enable row level security;
alter table mailgw.send_counter enable row level security;
alter table mailgw.audit_log    enable row level security;

-- En Supabase existen los roles de la API; en un Postgres local no.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on schema mailgw from anon, authenticated;
    revoke all on all tables in schema mailgw from anon, authenticated;
  end if;
end $$;
