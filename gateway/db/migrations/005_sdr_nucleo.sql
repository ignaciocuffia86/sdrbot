-- Núcleo del SDR v2 (docs/09 y docs/11): reglas de operación de los bots, registro de
-- prospección, pedidos entre bots, aprobaciones y bitácora de corridas.
--
-- Mismo modelo de aislamiento que el gateway: cada pedido corre con el rol mailgw_app y el
-- cliente del token fijado en mailgw.client_id; las políticas dejan ver y escribir sólo las
-- filas de ese cliente. Las reglas (playbooks) son globales: iguales para todos los clientes,
-- de sólo lectura para la aplicación, y se publican desde el repo con la CLI.

create schema if not exists sdr;

-- ---------------------------------------------------------------- reglas (globales)

-- Una versión publicada es inmutable.
create table if not exists sdr.playbook_version (
  version       text primary key check (version ~ '^[0-9A-Za-z._-]{1,40}$'),
  publicada_at  timestamptz not null default now(),
  notas         text
);

-- El contenido: por bot ('*' = todos) y tarea ('*' = todas), partido en secciones.
create table if not exists sdr.playbook_seccion (
  version    text not null references sdr.playbook_version on delete cascade,
  bot        text not null check (bot ~ '^(\*|[a-z][a-z0-9_]{1,30})$'),
  tarea      text not null check (tarea ~ '^(\*|[a-z][a-z0-9_]{1,40})$'),
  orden      int not null,
  seccion    text not null check (seccion ~ '^[a-z0-9][a-z0-9_-]{0,60}$'),
  titulo     text not null,
  resumen    text not null default '',
  contenido  text not null,
  primary key (version, bot, tarea, seccion)
);

-- Las routines de cada bot, con su prompt de presentación (plantilla).
create table if not exists sdr.playbook_rutina (
  version    text not null references sdr.playbook_version on delete cascade,
  bot        text not null,
  nombre     text not null,
  tarea      text not null,
  cron       text not null,
  timing     text not null default 'flexible' check (timing in ('flexible', 'exact')),
  disparo    text not null default 'horario' check (disparo in ('horario', 'webhook', 'horario_y_webhook')),
  descripcion text not null default '',
  etapa      int not null default 1,
  primary key (version, bot, nombre)
);

-- Qué versión sigue cada canal.
create table if not exists sdr.playbook_canal (
  canal      text primary key check (canal in ('canario', 'estable')),
  version    text not null references sdr.playbook_version,
  cambiado_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- configuración del cliente

create table if not exists sdr.cliente_config (
  client_id          text primary key references mailgw.client on delete cascade,
  canal              text not null default 'estable' check (canal in ('canario', 'estable')),
  version_fija       text references sdr.playbook_version,
  -- ICP, oferta, tono, firma, campañas de Dripify por segmento, qué es positivo, etc.
  ajustes            jsonb not null default '{}'::jsonb,
  bots_activos       text[] not null default '{orquestador,prospector}',
  zona_horaria       text not null default 'America/Argentina/Buenos_Aires',
  -- Los primeros N mails nuevos del cliente necesitan aprobación registrada (0 = sin calibración).
  calibracion_mails  int not null default 20 check (calibracion_mails between 0 and 500),
  actualizado_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------- registro de prospección

create table if not exists sdr.cuenta (
  id            uuid primary key default gen_random_uuid(),
  client_id     text not null references mailgw.client on delete cascade,
  asci_id       text,
  nombre        text not null,
  dominio       text check (dominio is null or dominio = lower(dominio)),
  pais          text,
  vertical      text,
  tamano        text,
  senales       jsonb not null default '[]'::jsonb,
  tesis         text,
  estado        text not null default 'en_investigacion'
                check (estado in ('en_investigacion', 'en_contacto', 'en_pausa', 'excluida', 'descartada')),
  estado_motivo text,
  pausa_hasta   date,
  creado_at     timestamptz not null default now(),
  actualizado_at timestamptz not null default now(),
  unique (id, client_id)
);
create unique index if not exists cuenta_dominio on sdr.cuenta (client_id, dominio) where dominio is not null;
create unique index if not exists cuenta_asci on sdr.cuenta (client_id, asci_id) where asci_id is not null;

create table if not exists sdr.prospecto (
  id             uuid primary key default gen_random_uuid(),
  client_id      text not null references mailgw.client on delete cascade,
  cuenta_id      uuid,
  asci_id        text,
  apollo_id      text,
  nombre         text not null,
  cargo          text,
  area           text,
  seniority      text,
  email          text check (email is null or email = lower(email)),
  email_calidad  text check (email_calidad is null or email_calidad in ('verificado', 'extrapolado', 'desconocido')),
  linkedin_url   text,
  whatsapp       text,
  eleccion       jsonb not null default '{}'::jsonb,
  estado         text not null default 'investigado'
                 check (estado in ('investigado', 'descartado', 'en_contacto', 'respondio', 'positivo', 'en_crm',
                                   'en_pausa', 'derivo', 'negativo', 'sin_respuesta', 'baja')),
  canales        text[] not null default '{}',
  dripify        jsonb,
  proximo_paso   text,
  proximo_canal  text check (proximo_canal is null or proximo_canal in ('mail', 'linkedin', 'whatsapp', 'crm', 'otro')),
  proximo_fecha  date,
  ultima_interaccion_at    timestamptz,
  ultima_interaccion_canal text,
  crm_id         text,
  creado_at      timestamptz not null default now(),
  actualizado_at timestamptz not null default now(),
  unique (id, client_id),
  foreign key (cuenta_id, client_id) references sdr.cuenta (id, client_id) on delete cascade
);
create unique index if not exists prospecto_email on sdr.prospecto (client_id, email) where email is not null;
create unique index if not exists prospecto_linkedin on sdr.prospecto (client_id, linkedin_url) where linkedin_url is not null;
create unique index if not exists prospecto_asci on sdr.prospecto (client_id, asci_id) where asci_id is not null;
create index if not exists prospecto_agenda on sdr.prospecto (client_id, proximo_fecha) where proximo_fecha is not null;

-- Línea de tiempo: sólo se agrega. Los tipos son una lista fija (docs/11 §3.3).
create table if not exists sdr.evento (
  id            bigint generated always as identity primary key,
  client_id     text not null references mailgw.client on delete cascade,
  prospecto_id  uuid,
  cuenta_id     uuid,
  tipo          text not null check (tipo in (
                  'cuenta.investigada', 'cuenta.excluida', 'prospecto.revelado',
                  'mail.enviado', 'mail.rebotado',
                  'linkedin.cargado', 'linkedin.invitacion', 'linkedin.conexion', 'linkedin.mensaje',
                  'linkedin.pausado', 'linkedin.bloqueado',
                  'whatsapp.enviado', 'respuesta', 'positivo', 'crm.cargado', 'baja',
                  'aprobacion.pedida', 'aprobacion.decidida', 'pedido', 'decision', 'aviso.cliente', 'nota')),
  canal         text,
  datos         jsonb not null default '{}'::jsonb,
  ref           text,
  interno       boolean not null default false,
  bot           text,
  tarea         text,
  corrida       uuid,
  version_reglas text,
  at            timestamptz not null default now(),
  foreign key (prospecto_id, client_id) references sdr.prospecto (id, client_id) on delete cascade,
  foreign key (cuenta_id, client_id) references sdr.cuenta (id, client_id) on delete cascade
);
create index if not exists evento_prospecto on sdr.evento (client_id, prospecto_id, id);
create index if not exists evento_cliente on sdr.evento (client_id, id);

-- Pedidos entre bots: la fuente de verdad. El mensaje de Grok entre bots sólo despierta.
create table if not exists sdr.pedido (
  id            uuid primary key default gen_random_uuid(),
  client_id     text not null references mailgw.client on delete cascade,
  de_bot        text not null,
  para_bot      text not null,
  prospecto_id  uuid,
  que           text not null,
  por_que       text,
  para_cuando   timestamptz,
  relacionado_con uuid,
  idas          int not null default 1,
  escalado      boolean not null default false,
  estado        text not null default 'pendiente' check (estado in ('pendiente', 'en_curso', 'hecho', 'descartado')),
  resultado     text,
  creado_at     timestamptz not null default now(),
  actualizado_at timestamptz not null default now(),
  unique (id, client_id),
  foreign key (prospecto_id, client_id) references sdr.prospecto (id, client_id) on delete cascade
);
create index if not exists pedido_pendientes on sdr.pedido (client_id, para_bot) where estado in ('pendiente', 'en_curso');

-- Aprobaciones: datos, no tarjetas de Grok (docs/09 §5.4). El gateway las exige.
create table if not exists sdr.aprobacion (
  id             uuid primary key default gen_random_uuid(),
  client_id      text not null references mailgw.client on delete cascade,
  tipo           text not null check (tipo in ('calibracion_mail', 'respuesta_positivo', 'crm_mapeo', 'crm_cambio',
                                               'whatsapp_primero', 'otro')),
  prospecto_id   uuid,
  pedida_por     text not null,
  contenido      jsonb not null,
  estado         text not null default 'pendiente' check (estado in ('pendiente', 'aprobada', 'rechazada', 'usada')),
  decision_contenido jsonb,
  decision_nota  text,
  decidida_por   text,
  decidida_at    timestamptz,
  usada_at       timestamptz,
  usada_clave    text,
  creado_at      timestamptz not null default now(),
  foreign key (prospecto_id, client_id) references sdr.prospecto (id, client_id) on delete cascade
);
create index if not exists aprobacion_estado on sdr.aprobacion (client_id, estado);

-- Bitácora de corridas de las routines.
create table if not exists sdr.corrida (
  id         uuid primary key default gen_random_uuid(),
  client_id  text not null references mailgw.client on delete cascade,
  bot        text not null,
  tarea      text not null,
  version_reglas text,
  inicio     timestamptz not null default now(),
  fin        timestamptz,
  estado     text not null default 'corriendo' check (estado in ('corriendo', 'ok', 'parcial', 'error')),
  items      int,
  resumen    text
);
create index if not exists corrida_bot on sdr.corrida (client_id, bot, inicio desc);

-- ---------------------------------------------------------------- seguridad

alter table sdr.playbook_version enable row level security;
alter table sdr.playbook_seccion enable row level security;
alter table sdr.playbook_rutina  enable row level security;
alter table sdr.playbook_canal   enable row level security;
alter table sdr.cliente_config   enable row level security;
alter table sdr.cuenta           enable row level security;
alter table sdr.prospecto        enable row level security;
alter table sdr.evento           enable row level security;
alter table sdr.pedido           enable row level security;
alter table sdr.aprobacion       enable row level security;
alter table sdr.corrida          enable row level security;

grant usage on schema sdr to mailgw_app;
grant select on sdr.playbook_version, sdr.playbook_seccion, sdr.playbook_rutina, sdr.playbook_canal to mailgw_app;
grant select on sdr.cliente_config to mailgw_app;
grant select, insert, update on sdr.cuenta, sdr.prospecto, sdr.pedido, sdr.aprobacion, sdr.corrida to mailgw_app;
grant select, insert on sdr.evento to mailgw_app;
grant usage on all sequences in schema sdr to mailgw_app;

do $$
declare t text;
begin
  foreach t in array array['playbook_version', 'playbook_seccion', 'playbook_rutina', 'playbook_canal'] loop
    execute format('drop policy if exists lectura on sdr.%I', t);
    execute format('create policy lectura on sdr.%I for select to mailgw_app using (true)', t);
  end loop;
  foreach t in array array['cliente_config', 'cuenta', 'prospecto', 'evento', 'pedido', 'aprobacion', 'corrida'] loop
    execute format('drop policy if exists por_cliente on sdr.%I', t);
    execute format('create policy por_cliente on sdr.%I for all to mailgw_app
                      using (client_id = mailgw.current_client()) with check (client_id = mailgw.current_client())', t);
  end loop;
end $$;

-- Sin acceso para los roles públicos de Supabase.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema sdr from anon, authenticated;
    revoke usage on schema sdr from anon, authenticated;
  end if;
end $$;

-- Permiso nuevo de los tokens: 'sdr' (reglas, registro, pedidos, aprobaciones, bitácora).
alter table mailgw.token drop constraint if exists token_scopes_validos;
alter table mailgw.token add constraint token_scopes_validos
  check (scopes <@ array['read', 'draft', 'send', 'manage', 'sdr']::text[]);
