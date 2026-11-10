-- Etapa 4a (docs/23): carga en el CRM, capa 1. El gateway escribe por código el mínimo de cada
-- positivo aprobado (persona, empresa, origen, respuesta, tarea al dueño); el bot sólo enriquece
-- después (etapa 4b). Por ahora, HubSpot.

-- La conexión del cliente con su CRM. El token va cifrado con MAILGW_ENC_KEYS, como las
-- contraseñas de los buzones y la API key de Dripify.
create table if not exists sdr.crm_conexion (
  client_id      text primary key references mailgw.client on delete cascade,
  proveedor      text not null default 'hubspot' check (proveedor in ('hubspot')),
  token_enc      text,
  portal_id      text,
  -- Propiedad del contacto que dice que vino del SDR, y su valor. Vacía: el origen va sólo en la nota.
  origen_campo   text,
  origen_valor   text,
  dueno_defecto  text,
  -- Propiedades obligatorias propias del cliente, con un valor fijo: { "propiedad": "valor" }.
  campos_fijos   jsonb not null default '{}'::jsonb,
  estado         text not null default 'activa' check (estado in ('activa', 'pausada', 'credencial_vencida')),
  tope_dia       int not null default 50 check (tope_dia between 1 and 1000),
  ultimo_ok_at   timestamptz,
  ultimo_error   text,
  actualizado_at timestamptz not null default now()
);

-- La cola de cargas y su auditoría. Una fila por prospecto: un mismo positivo no se carga dos
-- veces aunque se apruebe y además se pida a mano. Cada paso guarda lo que creó en crm_ids, así
-- un reintento sigue desde donde quedó sin duplicar.
create table if not exists sdr.crm_carga (
  id              bigint generated always as identity primary key,
  client_id       text not null references mailgw.client on delete cascade,
  prospecto_id    uuid not null,
  motivo          text not null check (motivo in ('positivo', 'pedido')),
  aprobacion_id   uuid,
  estado          text not null default 'pendiente'
                  check (estado in ('pendiente', 'en_curso', 'hecha', 'error', 'bloqueada')),
  intentos        int not null default 0,
  proximo_intento timestamptz not null default now(),
  tomada_at       timestamptz,
  crm_ids         jsonb not null default '{}'::jsonb,
  cambios         jsonb not null default '[]'::jsonb,
  error           text,
  pedida_por      text,
  creado_at       timestamptz not null default now(),
  hecha_at        timestamptz,
  unique (client_id, prospecto_id),
  foreign key (prospecto_id, client_id) references sdr.prospecto (id, client_id) on delete cascade
);
create index if not exists crm_carga_cola on sdr.crm_carga (proximo_intento) where estado in ('pendiente', 'en_curso');
create index if not exists crm_carga_cliente on sdr.crm_carga (client_id, id);

-- ---------------------------------------------------------------- seguridad

alter table sdr.crm_conexion enable row level security;
alter table sdr.crm_carga    enable row level security;

-- La aplicación lee la conexión (para descifrar el token con su cliente fijado) y anota cómo le
-- fue; el token, el origen, el dueño y los topes se cargan desde el panel (dueño).
grant select on sdr.crm_conexion to mailgw_app;
grant update (estado, portal_id, ultimo_ok_at, ultimo_error) on sdr.crm_conexion to mailgw_app;
grant select, insert, update on sdr.crm_carga to mailgw_app;
grant usage on all sequences in schema sdr to mailgw_app;

do $$
declare t text;
begin
  foreach t in array array['crm_conexion', 'crm_carga'] loop
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
