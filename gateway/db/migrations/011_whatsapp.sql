-- WhatsApp de seguimiento (docs/22): el bot `whatsapp` manda por WhatsApp Web desde el navegador de
-- su asiento de Grok, pero cada mensaje pasa antes por el gateway, que le da un turno sólo si
-- respeta las reglas: horario, ritmo humano entre envíos, topes por contacto y por día, sólo
-- contactos tibios, nada repetido en 24 horas y, si WhatsApp avisó un bloqueo, nada hasta que Biguá
-- lo reanude. Así esas reglas no dependen de que el bot se acuerde.

create table if not exists sdr.whatsapp_config (
  client_id          text primary key references mailgw.client on delete cascade,
  activo             boolean not null default false,
  -- El número desde el que manda (el de la sesión de WhatsApp Web), sólo para mostrar.
  numero             text check (numero is null or numero ~ '^\+?[0-9 ]{6,20}$'),
  -- Horario del cliente (zona de sdr.cliente_config) en el que se manda; fuera de él, nada.
  hora_desde         int not null default 8 check (hora_desde between 0 and 23),
  hora_hasta         int not null default 24 check (hora_hasta between 1 and 24),
  dias               int[] not null default '{1,2,3,4,5,6,7}',
  -- Pausa al azar entre dos envíos del cliente (no por chat): que no salgan en ráfaga.
  pausa_min_seg      int not null default 20 check (pausa_min_seg between 5 and 600),
  pausa_max_seg      int not null default 60 check (pausa_max_seg between 5 and 1800),
  tope_contacto_dia  int not null default 8 check (tope_contacto_dia between 1 and 50),
  tope_dia           int not null default 60 check (tope_dia between 1 and 500),
  -- El primer mensaje a cada persona se aprueba en el chat del orquestador (whatsapp_primero).
  aprobar_primero    boolean not null default true,
  -- WhatsApp avisó un bloqueo o un tope: no sale nada hasta que Biguá lo reanude en el panel.
  pausado            boolean not null default false,
  pausa_motivo       text,
  pausado_at         timestamptz,
  -- El próximo turno libre: el ritmo entre envíos es del cliente, no de cada conversación.
  proximo_turno_at   timestamptz,
  actualizado_at     timestamptz not null default now(),
  check (pausa_min_seg <= pausa_max_seg),
  check (hora_desde < hora_hasta)
);

-- Cada mensaje: el turno que da el gateway y cómo terminó. Idempotente por clave.
create table if not exists sdr.whatsapp_envio (
  id             bigint generated always as identity primary key,
  client_id      text not null references mailgw.client on delete cascade,
  clave          text not null,
  prospecto_id   uuid not null,
  texto          text not null,
  texto_hash     text not null,
  estado         text not null default 'turno' check (estado in ('turno', 'enviado', 'fallido', 'vencido', 'bloqueado')),
  enviar_desde   timestamptz not null,
  vence_at       timestamptz not null,
  aprobacion_id  uuid,
  resultado      text,
  creado_at      timestamptz not null default now(),
  enviado_at     timestamptz,
  unique (client_id, clave),
  foreign key (prospecto_id, client_id) references sdr.prospecto (id, client_id) on delete cascade
);
create index if not exists whatsapp_envio_dia on sdr.whatsapp_envio (client_id, creado_at);
create index if not exists whatsapp_envio_prospecto on sdr.whatsapp_envio (client_id, prospecto_id, creado_at);

alter table sdr.whatsapp_config enable row level security;
alter table sdr.whatsapp_envio  enable row level security;

-- La aplicación lee la configuración y anota el próximo turno y la pausa; el resto lo carga Biguá
-- desde el panel (dueño).
grant select on sdr.whatsapp_config to mailgw_app;
grant update (proximo_turno_at, pausado, pausa_motivo, pausado_at) on sdr.whatsapp_config to mailgw_app;
grant select, insert, update on sdr.whatsapp_envio to mailgw_app;
grant usage on all sequences in schema sdr to mailgw_app;

do $$
declare t text;
begin
  foreach t in array array['whatsapp_config', 'whatsapp_envio'] loop
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
