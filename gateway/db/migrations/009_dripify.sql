-- Etapa 3 de docs/09: LinkedIn por Dripify, desde el gateway.
--
-- Cada cliente tiene su cuenta de Dripify con una campaña esqueleto (invitación con nota,
-- mensaje 1 al aceptar, mensaje 2 unos días después) cuyo contenido entero son variables por
-- persona: sdr_nota, sdr_mensaje1 y sdr_mensaje2. El bot escribe esos textos, el gateway los
-- carga en la campaña por la API y documenta todo en el registro. Las respuestas llegan por el
-- webhook de la campaña y, para las conversaciones ya abiertas, el reloj las lee por la API.

-- La cuenta de Dripify del cliente. La API key va cifrada con MAILGW_ENC_KEYS, como las
-- contraseñas de los buzones. Del webhook sólo se guarda el hash del secreto de la URL.
create table if not exists sdr.dripify_cuenta (
  client_id      text primary key references mailgw.client on delete cascade,
  api_key_enc    text,
  campana_id     bigint,
  -- Nombre de cada variable de la campaña → id del campo en Dripify (se resuelve por la API).
  campos         jsonb not null default '{}'::jsonb,
  -- Largo máximo de la nota de invitación: 300 con LinkedIn Premium, 200 sin.
  nota_max       int not null default 300 check (nota_max between 100 and 300),
  webhook_hash   text,
  activo         boolean not null default true,
  ultimo_ok_at   timestamptz,
  ultimo_error   text,
  actualizado_at timestamptz not null default now()
);

-- Cada carga de prospectos a la campaña: idempotente por clave, como los envíos de mail.
create table if not exists sdr.dripify_carga (
  id            bigint generated always as identity primary key,
  client_id     text not null references mailgw.client on delete cascade,
  clave         text not null,
  campana_id    bigint not null,
  prospectos    uuid[] not null,
  estado        text not null default 'enviando' check (estado in ('enviando', 'ok', 'error')),
  lead_list_id  bigint,
  aceptados     int,
  duplicados    int,
  error         text,
  creado_at     timestamptz not null default now(),
  unique (client_id, clave)
);

-- Mensajes que el gateway manda por la API en una conversación abierta (las respuestas de
-- seguimiento). Idempotentes por clave.
create table if not exists sdr.dripify_envio (
  id            bigint generated always as identity primary key,
  client_id     text not null references mailgw.client on delete cascade,
  clave         text not null,
  prospecto_id  uuid not null,
  lead_id       bigint,
  texto         text not null,
  aprobacion_id uuid,
  estado        text not null default 'enviando' check (estado in ('enviando', 'ok', 'error')),
  event_id      text,
  error         text,
  creado_at     timestamptz not null default now(),
  unique (client_id, clave),
  foreign key (prospecto_id, client_id) references sdr.prospecto (id, client_id) on delete cascade
);

-- Lo que manda el webhook de Dripify, tal cual llega: Dripify no publica un ejemplo del cuerpo,
-- así que se guarda entero y se interpreta lo que se puede.
create table if not exists sdr.dripify_evento (
  id            bigint generated always as identity primary key,
  client_id     text not null references mailgw.client on delete cascade,
  tipo          text not null,
  linkedin_url  text,
  prospecto_id  uuid,
  cuerpo        jsonb not null,
  procesado     boolean not null default false,
  error         text,
  recibido_at   timestamptz not null default now()
);
create index if not exists dripify_evento_cliente on sdr.dripify_evento (client_id, id);

-- Mensajes de prospectos por LinkedIn que esperan a seguimiento: el equivalente de sdr.correo.
create table if not exists sdr.linkedin_respuesta (
  id              bigint generated always as identity primary key,
  client_id       text not null references mailgw.client on delete cascade,
  prospecto_id    uuid not null,
  lead_id         bigint,
  conversation_id text,
  -- Id del mensaje en Dripify (eventId) cuando se conoce: no se guarda dos veces.
  mensaje_id      text,
  texto           text,
  enviado_at      timestamptz,
  origen          text not null check (origen in ('webhook', 'api')),
  dripify_evento  bigint,
  estado          text not null default 'nuevo' check (estado in ('nuevo', 'atendido')),
  avisado_at      timestamptz,
  avisos          int not null default 0,
  atendido_at     timestamptz,
  atendido_por    text,
  resultado       text,
  creado_at       timestamptz not null default now(),
  foreign key (prospecto_id, client_id) references sdr.prospecto (id, client_id) on delete cascade
);
create unique index if not exists linkedin_respuesta_mensaje on sdr.linkedin_respuesta (client_id, mensaje_id) where mensaje_id is not null;
create index if not exists linkedin_respuesta_nueva on sdr.linkedin_respuesta (client_id, id) where estado = 'nuevo';

-- Cupo de la API: Dripify permite 60 pedidos por minuto y 5000 por día por key. El gateway se
-- queda un poco abajo para que un pico no corte a los bots a mitad de una tarea.
create table if not exists sdr.dripify_uso (
  client_id   text primary key references mailgw.client on delete cascade,
  minuto      timestamptz not null default date_trunc('minute', now()),
  n_minuto    int not null default 0,
  dia         date not null default current_date,
  n_dia       int not null default 0
);

-- ---------------------------------------------------------------- seguridad

alter table sdr.dripify_cuenta     enable row level security;
alter table sdr.dripify_carga      enable row level security;
alter table sdr.dripify_envio      enable row level security;
alter table sdr.dripify_evento     enable row level security;
alter table sdr.linkedin_respuesta enable row level security;
alter table sdr.dripify_uso        enable row level security;

-- La aplicación lee la cuenta (para descifrar la key con su cliente fijado) y anota cómo le
-- fue; la key, la campaña y el webhook los carga Biguá desde el panel (dueño).
grant select on sdr.dripify_cuenta to mailgw_app;
grant update (campos, ultimo_ok_at, ultimo_error) on sdr.dripify_cuenta to mailgw_app;
grant select, insert, update on sdr.dripify_carga, sdr.dripify_envio, sdr.dripify_evento,
  sdr.linkedin_respuesta, sdr.dripify_uso to mailgw_app;
grant usage on all sequences in schema sdr to mailgw_app;

do $$
declare t text;
begin
  foreach t in array array['dripify_cuenta', 'dripify_carga', 'dripify_envio', 'dripify_evento',
                           'linkedin_respuesta', 'dripify_uso'] loop
    execute format('drop policy if exists por_cliente on sdr.%I', t);
    execute format('create policy por_cliente on sdr.%I for all to mailgw_app
                      using (client_id = mailgw.current_client()) with check (client_id = mailgw.current_client())', t);
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema sdr from anon, authenticated;
  end if;
end $$;
