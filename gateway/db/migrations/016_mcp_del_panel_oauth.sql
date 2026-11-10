-- Etapa M1 del MCP del panel (docs/24 §3): OAuth para que una persona conecte Claude con su
-- usuario del panel.
--
-- Los clientes OAuth (Claude por CIMD, o cualquiera por DCR) no se guardan: su client_id es una
-- URL o un sobre firmado con OAUTH_FIRMA. A la base va sólo lo que tiene que ser de uso único o
-- revocable: el código de autorización y los tokens. Todo se guarda como hash.
--
-- Una «conexión» es una familia de tokens: la autorización crea la familia y cada renovación rota
-- el par dentro de ella. Desconectar es revocar la familia. Si se usa un token de renovación que
-- ya se había rotado, alguien lo copió, y se revoca toda la familia (docs/24 §3.4).
--
-- Sólo las toca el dueño (el gateway, como admin_user y admin_session): ni mailgw_app ni
-- mailgw_portal tienen permisos, así que ningún pedido de un bot o de un cliente las puede leer.

create table if not exists mailgw.oauth_code (
  code_hash       text primary key,
  client_id       text not null,
  cliente_nombre  text not null,
  user_id         uuid not null references mailgw.admin_user on delete cascade,
  redirect_uri    text not null,
  code_challenge  text not null,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  used_at         timestamptz
);

create table if not exists mailgw.oauth_token (
  id              uuid primary key default gen_random_uuid(),
  token_hash      text not null unique,
  tipo            text not null check (tipo in ('acceso', 'renovacion')),
  familia         uuid not null,
  client_id       text not null,
  cliente_nombre  text not null,
  user_id         uuid not null references mailgw.admin_user on delete cascade,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null,
  -- Una renovación usada queda con used_at: volver a presentarla revoca la familia.
  used_at         timestamptz,
  revoked_at      timestamptz,
  last_used_at    timestamptz
);
create index if not exists oauth_token_por_usuario on mailgw.oauth_token (user_id, familia);
create index if not exists oauth_token_por_familia on mailgw.oauth_token (familia);

alter table mailgw.oauth_code  enable row level security;
alter table mailgw.oauth_token enable row level security;
