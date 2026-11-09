-- Etapa C1 del panel por cliente (docs/21 §4 y §6.2): campañas.
--
-- Una campaña es una propuesta para una audiencia, con su objetivo, sus mensajes y sus canales.
-- Cada cuenta, persona, evento, pedido, aprobación y carga de Dripify queda atada a una campaña.
-- Cada cliente tiene, como mínimo, la campaña «principal»: esta migración la crea con los
-- ajustes de hoy y le asigna todo lo que ya está en el registro.
--
-- Esta migración no rompe nada de lo que corre hoy:
--   - Las claves de campaña se COPIAN de sdr.cliente_config.ajustes a la «principal»; no se
--     borran de Empresa. Las mueve la migración 013, cuando el gateway, el panel y las reglas ya
--     lean la campaña (docs/21 §6.2, «Migración de la principal»).
--   - El código de hoy no conoce campana_id: un disparador lo completa con la «principal» del
--     cliente en cada fila nueva que llega sin campaña.

-- ---------------------------------------------------------------- campañas

create table if not exists sdr.campana (
  id                 uuid primary key default gen_random_uuid(),
  client_id          text not null references mailgw.client on delete cascade,
  clave              text not null check (clave ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  nombre             text not null check (length(nombre) between 1 and 120),
  tipo               text not null default 'prospeccion' check (tipo in ('prospeccion', 'evento', 'reactivacion')),
  estado             text not null default 'borrador' check (estado in ('borrador', 'activa', 'pausada', 'terminada')),
  -- Lo de §6.2 «Campaña»: propuesta, icp, roles_objetivo, excluir (propias), senal_avisos,
  -- dias_aviso, llamado_accion, links_permitidos, positivos, objeciones (propias), prueba_social
  -- (cuáles), acepta_mails_extrapolados y lo que cambia de Empresa (tono, idioma,
  -- responsable_positivos, link_agenda). Lo valida el gateway según el tipo, como ajustes.mjs.
  ajustes            jsonb not null default '{}'::jsonb check (jsonb_typeof(ajustes) = 'object'),
  -- La campaña de Dripify del único perfil de LinkedIn del cliente (C1). En C2, con varios
  -- perfiles, pasa a una tabla por perfil.
  dripify_campana_id bigint check (dripify_campana_id is null or dripify_campana_id > 0),
  -- Decisión 12: sin peso. La suma de las activas no pasa sdr.cliente_config.tope_cuentas_dia
  -- (lo controla el gateway al guardar y al activar).
  cuentas_por_dia    int not null default 0 check (cuentas_por_dia between 0 and 100),
  -- Decisión 4: 20 la primera campaña del cliente, 5 cada campaña nueva.
  calibracion_mails  int not null default 5 check (calibracion_mails between 0 and 500),
  inicio             date,
  fin                date,
  -- Una campaña terminada no se reactiva: se duplica (decisión 13).
  duplicada_de       uuid references sdr.campana on delete set null,
  terminada_at       timestamptz,
  creado_at          timestamptz not null default now(),
  actualizado_at     timestamptz not null default now(),
  unique (client_id, clave),
  unique (id, client_id),
  check (fin is null or inicio is null or inicio <= fin),
  check ((estado = 'terminada') = (terminada_at is not null))
);
create index if not exists campana_activas on sdr.campana (client_id) where estado = 'activa';

-- Los buzones de cada campaña. Una tabla y no un arreglo: así la clave foránea compuesta
-- impide asignar un buzón de otro cliente, y borrar un buzón lo saca de sus campañas.
create table if not exists sdr.campana_buzon (
  client_id   text not null references mailgw.client on delete cascade,
  campana_id  uuid not null,
  account_id  uuid not null,
  primary key (campana_id, account_id),
  foreign key (campana_id, client_id) references sdr.campana (id, client_id) on delete cascade,
  foreign key (account_id, client_id) references mailgw.account (id, client_id) on delete cascade
);
create index if not exists campana_buzon_buzon on sdr.campana_buzon (client_id, account_id);

-- ---------------------------------------------------------------- la «principal»

-- Devuelve la campaña «principal» del cliente y, si no existe, la crea con los ajustes de hoy.
-- La usan el disparador de abajo (filas nuevas sin campaña), el alta de sdr.cliente_config y el
-- relleno de esta misma migración.
--
-- Es security definer porque la aplicación (mailgw_app) sólo lee sdr.campana. Para que no sirva
-- para tocar otro cliente, rechaza un cliente distinto del fijado en la sesión.
create or replace function sdr.campana_principal(p_client text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id     uuid;
  v_cfg    sdr.cliente_config%rowtype;
  v_a      jsonb;
  v_cpd    int;
begin
  if mailgw.current_client() is not null and mailgw.current_client() <> p_client then
    raise exception 'campana_principal: cliente % fuera de la sesión', p_client using errcode = '42501';
  end if;

  select id into v_id from sdr.campana where client_id = p_client and clave = 'principal';
  if v_id is not null then return v_id; end if;

  select * into v_cfg from sdr.cliente_config where client_id = p_client;
  v_a := coalesce(v_cfg.ajustes, '{}'::jsonb);
  v_cpd := case when v_a->>'cuentas_por_dia' ~ '^[0-9]{1,3}$'
                then least((v_a->>'cuentas_por_dia')::int, 100) else 0 end;

  insert into sdr.campana (client_id, clave, nombre, tipo, estado, ajustes, dripify_campana_id,
                           cuentas_por_dia, calibracion_mails)
  values (
    p_client, 'principal', 'Principal', 'prospeccion',
    -- Sin configuración todavía, la crea una fila del registro: el cliente ya está operando.
    case when v_cfg.client_id is null or cardinality(v_cfg.bots_activos) > 0 then 'activa' else 'pausada' end,
    -- §6.2, paso 2. `oferta` pasa como `propuesta`. Las claves vacías no se copian.
    jsonb_strip_nulls(jsonb_build_object(
      'propuesta',                 v_a->'oferta',
      'icp',                       v_a->'icp',
      'roles_objetivo',            v_a->'roles_objetivo',
      'senal_avisos',              v_a->'senal_avisos',
      'dias_aviso',                v_a->'dias_aviso',
      'llamado_accion',            v_a->'llamado_accion',
      'positivos',                 v_a->'positivos',
      'acepta_mails_extrapolados', v_a->'acepta_mails_extrapolados')),
    (select dc.campana_id from sdr.dripify_cuenta dc where dc.client_id = p_client),
    v_cpd,
    -- La «principal» sigue con la calibración del cliente: las aprobaciones que ya usó quedan
    -- en ella (el relleno de abajo), así que si ya terminó, sigue terminada.
    coalesce(v_cfg.calibracion_mails, 20)
  )
  on conflict (client_id, clave) do nothing
  returning id into v_id;

  if v_id is null then  -- la creó otra transacción al mismo tiempo
    select id into v_id from sdr.campana where client_id = p_client and clave = 'principal';
    return v_id;
  end if;

  -- §6.2, paso 2: todos los buzones del cliente. El estado de cada uno sigue mandando.
  insert into sdr.campana_buzon (client_id, campana_id, account_id)
  select p_client, v_id, a.id from mailgw.account a where a.client_id = p_client
  on conflict do nothing;

  return v_id;
end $$;

revoke all on function sdr.campana_principal(text) from public;
grant execute on function sdr.campana_principal(text) to mailgw_app, mailgw_portal;

-- Cada cliente con configuración nueva nace con su «principal».
create or replace function sdr.cliente_config_principal()
returns trigger language plpgsql set search_path = '' as $$
begin
  perform sdr.campana_principal(new.client_id);
  return new;
end $$;

drop trigger if exists principal on sdr.cliente_config;
create trigger principal after insert on sdr.cliente_config
  for each row execute function sdr.cliente_config_principal();

-- ---------------------------------------------------------------- campana_id en el registro

-- En sdr.dripify_carga, campana_id ya era el id de la campaña de Dripify: pasa a llamarse
-- dripify_campana_id y campana_id queda, como en todas las tablas, para la campaña del SDR.
do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'sdr' and table_name = 'dripify_carga' and column_name = 'campana_id'
               and data_type = 'bigint') then
    alter table sdr.dripify_carga rename column campana_id to dripify_campana_id;
  end if;
end $$;

-- Completa campana_id con la «principal» cuando el código de hoy no la manda. Una fila de otro
-- cliente se deja como viene: la rechaza la política de la tabla (RLS va antes que not null).
create or replace function sdr.campana_por_defecto()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.campana_id is null
     and (mailgw.current_client() is null or mailgw.current_client() = new.client_id) then
    new.campana_id := sdr.campana_principal(new.client_id);
  end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['cuenta', 'prospecto', 'evento', 'pedido', 'aprobacion', 'dripify_carga'] loop
    execute format('alter table sdr.%I add column if not exists campana_id uuid', t);
    execute format('drop trigger if exists campana_por_defecto on sdr.%I', t);
    execute format('create trigger campana_por_defecto before insert on sdr.%I
                      for each row execute function sdr.campana_por_defecto()', t);
  end loop;
end $$;

-- Relleno (§6.2, pasos 1 y 5): una «principal» por cliente con configuración o con registro, y
-- todas las filas de hoy en ella.
select sdr.campana_principal(c.client_id)
from (select client_id from sdr.cliente_config
      union select client_id from sdr.cuenta
      union select client_id from sdr.prospecto
      union select client_id from sdr.evento
      union select client_id from sdr.pedido
      union select client_id from sdr.aprobacion
      union select client_id from sdr.dripify_carga) c;

do $$
declare t text;
begin
  foreach t in array array['cuenta', 'prospecto', 'evento', 'pedido', 'aprobacion', 'dripify_carga'] loop
    execute format('update sdr.%I x set campana_id = c.id from sdr.campana c
                      where x.campana_id is null and c.client_id = x.client_id and c.clave = ''principal''', t);
    execute format('alter table sdr.%I alter column campana_id set not null', t);
    execute format('alter table sdr.%I drop constraint if exists %I', t, t || '_campana');
    -- Compuesta con client_id: una fila no puede quedar en una campaña de otro cliente.
    execute format('alter table sdr.%I add constraint %I foreign key (campana_id, client_id)
                      references sdr.campana (id, client_id)', t, t || '_campana');
  end loop;
end $$;

create index if not exists cuenta_campana     on sdr.cuenta (client_id, campana_id);
create index if not exists prospecto_campana  on sdr.prospecto (client_id, campana_id);
create index if not exists evento_campana     on sdr.evento (client_id, campana_id, id);
-- La calibración se cuenta por campaña (decisión 4).
create index if not exists aprobacion_campana on sdr.aprobacion (client_id, campana_id, tipo, estado);

-- El historial de ajustes distingue Empresa (sin campaña) de cada campaña.
alter table sdr.ajustes_historial add column if not exists campana_id uuid;
alter table sdr.ajustes_historial drop constraint if exists ajustes_historial_campana;
alter table sdr.ajustes_historial add constraint ajustes_historial_campana foreign key (campana_id, client_id)
  references sdr.campana (id, client_id) on delete cascade;
create index if not exists ajustes_historial_campana on sdr.ajustes_historial (client_id, campana_id, id desc);

-- ---------------------------------------------------------------- seguridad

alter table sdr.campana       enable row level security;
alter table sdr.campana_buzon enable row level security;

-- Los bots leen las campañas; las crean y editan el panel (qué campo puede tocar el cliente lo
-- controla el gateway según el modo, decisión 13) y la CLI.
grant select on sdr.campana, sdr.campana_buzon to mailgw_app;
grant select, insert, update on sdr.campana to mailgw_portal;
grant select, insert, delete on sdr.campana_buzon to mailgw_portal;

do $$
declare t text;
begin
  foreach t in array array['campana', 'campana_buzon'] loop
    execute format('drop policy if exists por_cliente on sdr.%I', t);
    execute format('create policy por_cliente on sdr.%I for select to mailgw_app
                      using (client_id = mailgw.current_client())', t);
    execute format('drop policy if exists portal_por_cliente on sdr.%I', t);
    execute format('create policy portal_por_cliente on sdr.%I for all to mailgw_portal
                      using (client_id = mailgw.current_client()) with check (client_id = mailgw.current_client())', t);
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema sdr from anon, authenticated;
    revoke all on function sdr.campana_principal(text) from anon, authenticated;
  end if;
end $$;
