-- Memoria del correo (etapa 2 de docs/09): el gateway lee los buzones, ata cada respuesta y
-- cada rebote a su envío y a su prospecto, lleva la supresión por cliente y despierta al bot
-- `seguimiento` por el webhook de su routine cuando llega algo.
--
-- Mismo aislamiento que la 005: lo que es de un cliente se lee y escribe con mailgw_app y el
-- cliente fijado. El despertador (URL y clave del webhook de Grok) y el reloj (el secreto con
-- el que pg_cron llama al gateway) son del dueño: la aplicación no los ve.

-- ---------------------------------------------------------------- cursor por buzón

-- Hasta dónde se leyó el INBOX de cada buzón. ocupado_hasta es un permiso de unos segundos
-- para que dos lecturas a la vez (el reloj y un bot) no procesen lo mismo; igual, cada mensaje
-- entra una sola vez por la clave única de sdr.correo.
create table if not exists sdr.buzon_cursor (
  account_id      uuid primary key references mailgw.account on delete cascade,
  client_id       text not null references mailgw.client on delete cascade,
  carpeta         text not null default 'INBOX',
  uidvalidity     text,
  last_uid        bigint not null default 0,
  revisado_at     timestamptz,
  ocupado_hasta   timestamptz,
  ultimo_error    text,
  ultimo_error_at timestamptz
);

-- ---------------------------------------------------------------- correo entrante

-- Sólo lo que importa al SDR: respuestas, respuestas automáticas, rebotes y bajas atadas a un
-- envío, a un prospecto o a una cuenta del registro. Un mail que no tiene que ver con la
-- prospección no se guarda.
create table if not exists sdr.correo (
  id              bigint generated always as identity primary key,
  client_id       text not null references mailgw.client on delete cascade,
  account_id      uuid not null references mailgw.account on delete cascade,
  carpeta         text not null,
  uidvalidity     text not null,
  uid             bigint not null,
  message_id      text,
  de              text,
  de_nombre       text,
  asunto          text,
  fecha           timestamptz,
  tipo            text not null check (tipo in ('respuesta', 'automatica', 'rebote', 'rebote_temporal', 'baja', 'de_cuenta')),
  prospecto_id    uuid,
  cuenta_id       uuid,
  -- El mail nuestro al que contesta o que rebotó, y cómo se lo relacionó.
  enviado_message_id text,
  como            text check (como is null or como in ('hilo', 'remitente', 'dominio', 'destinatario')),
  -- Lo que escribió la persona, sin la cita, recortado.
  texto           text,
  datos           jsonb not null default '{}'::jsonb,
  estado          text not null default 'nuevo' check (estado in ('nuevo', 'atendido')),
  avisado_at      timestamptz,
  avisos          int not null default 0,
  atendido_at     timestamptz,
  atendido_por    text,
  resultado       text,
  creado_at       timestamptz not null default now(),
  unique (account_id, uidvalidity, uid),
  foreign key (prospecto_id, client_id) references sdr.prospecto (id, client_id) on delete cascade,
  foreign key (cuenta_id, client_id) references sdr.cuenta (id, client_id) on delete cascade
);
create index if not exists correo_nuevo on sdr.correo (client_id, id) where estado = 'nuevo';
create index if not exists correo_prospecto on sdr.correo (client_id, prospecto_id) where prospecto_id is not null;

-- Para atar una respuesta a su envío por In-Reply-To / References.
create index if not exists send_log_message_id on mailgw.send_log (client_id, message_id) where message_id is not null;
create index if not exists evento_ref on sdr.evento (client_id, ref) where ref is not null;

-- ---------------------------------------------------------------- supresión

-- A quién no se le escribe más desde ningún buzón del cliente: rebotes definitivos, bajas y
-- altas manuales. El gateway la hace cumplir al enviar.
create table if not exists sdr.supresion (
  client_id  text not null references mailgw.client on delete cascade,
  email      text not null check (email = lower(email)),
  motivo     text not null check (motivo in ('rebote', 'baja', 'manual')),
  origen     text,
  at         timestamptz not null default now(),
  primary key (client_id, email)
);

-- ---------------------------------------------------------------- despertador y reloj (del dueño)

-- El webhook de la routine de un bot en Grok (docs/12: Bearer, el cuerpo va al prompt). La
-- clave va cifrada con MAILGW_ENC_KEYS, como las contraseñas de los buzones.
create table if not exists sdr.despertador (
  client_id       text not null references mailgw.client on delete cascade,
  bot             text not null check (bot ~ '^[a-z][a-z0-9_]{1,30}$'),
  url             text not null check (url ~ '^https://'),
  clave_enc       text not null,
  activo          boolean not null default true,
  -- Horario del cliente (zona horaria de sdr.cliente_config) en el que se despierta al bot.
  -- Fuera de horario el correo se lee igual y el aviso sale al abrir el horario.
  hora_desde      int not null default 8 check (hora_desde between 0 and 23),
  hora_hasta      int not null default 20 check (hora_hasta between 1 and 24),
  dias            int[] not null default '{1,2,3,4,5}',
  -- Entre dos avisos pasan al menos estos minutos: los avisos se agrupan en una corrida.
  espera_min      int not null default 10 check (espera_min between 1 and 240),
  ultimo_aviso_at timestamptz,
  ultimo_estado   int,
  ultimo_error    text,
  fallas          int not null default 0,
  actualizado_at  timestamptz not null default now(),
  primary key (client_id, bot)
);

-- Una sola fila: el hash del secreto con el que el reloj (pg_cron + pg_net en Supabase) llama
-- a POST /cron/correo, y cómo le fue la última vez.
create table if not exists sdr.reloj (
  id               boolean primary key default true check (id),
  secreto_hash     text not null,
  ultimo_tick_at   timestamptz,
  ultimo_resultado jsonb
);

-- ---------------------------------------------------------------- seguridad

alter table sdr.buzon_cursor enable row level security;
alter table sdr.correo       enable row level security;
alter table sdr.supresion    enable row level security;
alter table sdr.despertador  enable row level security;
alter table sdr.reloj        enable row level security;

grant select, insert, update on sdr.buzon_cursor, sdr.correo to mailgw_app;
grant select, insert on sdr.supresion to mailgw_app;
grant usage on all sequences in schema sdr to mailgw_app;

do $$
declare t text;
begin
  foreach t in array array['buzon_cursor', 'correo', 'supresion'] loop
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
