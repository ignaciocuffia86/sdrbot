-- Carga de cuentas por archivo, etapa 1 (docs/26 §9): el cliente o Biguá suben un Excel o un CSV y
-- cada fila va a la lista de no contactar de siempre (referidos, clientes, «no quiere») o, sólo
-- Biguá, al registro como semilla del ICP (docs/27 §3.2). Las filas «prospectar» llegan en la
-- etapa 2.
--
-- Lo nuevo de la lista: una empresa también se puede excluir por su NOMBRE, para los referidos que
-- vienen sin sitio web. Se guarda normalizado con sdr.norm_empresa y el gateway lo compara contra
-- el nombre de la cuenta (guardar cuentas y personas, mails, Dripify, WhatsApp).

-- ---------------------------------------------------------------- nombre normalizado

-- «Agrosuper S.A.», «AGROSUPER SA» y «Agrosuper» dan lo mismo: minúsculas, sin acentos ni signos y
-- sin la forma societaria. Inmutable: sirve para índices y para comparar en SQL y en el código igual.
create or replace function sdr.norm_empresa(t text) returns text
language sql immutable parallel safe as $$
  select nullif(btrim(regexp_replace(
           regexp_replace(
             regexp_replace(
               translate(lower(coalesce(t, '')), 'áàäâãéèëêíìïîóòöôõúùüûñç', 'aaaaaeeeeiiiiooooouuuunc'),
               '[^a-z0-9]+', ' ', 'g'),
             '(^| )(sa|s a|sas|s a s|spa|s p a|ltda|limitada|srl|s r l|sac|s a c|saa|eirl|e i r l|sl|s l|inc|llc|corp|corporation|cia|y cia|sociedad anonima)(?= |$)',
             ' ', 'g'),
           ' +', ' ', 'g')), '')
$$;
grant execute on function sdr.norm_empresa(text) to mailgw_app, mailgw_portal;

-- ---------------------------------------------------------------- lotes

create table if not exists sdr.lote_carga (
  id           uuid primary key default gen_random_uuid(),
  client_id    text not null references mailgw.client on delete cascade,
  archivo      text not null check (length(archivo) between 1 and 200),
  uso_defecto  text not null check (uso_defecto in ('prospectar', 'semilla', 'no_contactar')),
  mapeo        jsonb not null default '{}'::jsonb,   -- campo → encabezado del archivo
  resumen      jsonb not null default '{}'::jsonb,   -- conteos por uso y por resultado, sin contenido
  por_email    text,
  creado_at    timestamptz not null default now()
);
create index if not exists lote_carga_cliente on sdr.lote_carga (client_id, creado_at desc);

alter table sdr.lote_carga enable row level security;
grant select, insert on sdr.lote_carga to mailgw_portal;
grant select on sdr.lote_carga to mailgw_app;
drop policy if exists portal_por_cliente on sdr.lote_carga;
create policy portal_por_cliente on sdr.lote_carga for all to mailgw_portal
  using (client_id = mailgw.current_client()) with check (client_id = mailgw.current_client());
drop policy if exists por_cliente on sdr.lote_carga;
create policy por_cliente on sdr.lote_carga for select to mailgw_app
  using (client_id = mailgw.current_client());

-- ---------------------------------------------------------------- no contactar por nombre

alter table sdr.no_contactar drop constraint if exists no_contactar_tipo_check;
alter table sdr.no_contactar add constraint no_contactar_tipo_check check (tipo in ('dominio', 'email', 'empresa'));
-- Una «empresa» guarda el nombre ya normalizado (el check de tipo email ⇔ tiene @ sigue valiendo).
alter table sdr.no_contactar drop constraint if exists no_contactar_empresa_normalizada;
alter table sdr.no_contactar add constraint no_contactar_empresa_normalizada
  check (tipo <> 'empresa' or valor = sdr.norm_empresa(valor));
alter table sdr.no_contactar add column if not exists lote_id uuid references sdr.lote_carga on delete set null;
create index if not exists no_contactar_empresa on sdr.no_contactar (client_id, valor) where tipo = 'empresa';

-- ---------------------------------------------------------------- semillas en el registro

alter table sdr.cuenta add column if not exists origen text not null default 'bot';
alter table sdr.cuenta drop constraint if exists cuenta_origen_check;
alter table sdr.cuenta add constraint cuenta_origen_check check (origen in ('bot', 'archivo'));
alter table sdr.cuenta add column if not exists uso text;
alter table sdr.cuenta drop constraint if exists cuenta_uso_check;
alter table sdr.cuenta add constraint cuenta_uso_check check (uso is null or uso in ('semilla', 'prospectar'));
alter table sdr.cuenta add column if not exists lote_id uuid references sdr.lote_carga on delete set null;
alter table sdr.cuenta add column if not exists datos_origen jsonb not null default '{}'::jsonb;
create index if not exists cuenta_nombre_norm on sdr.cuenta (client_id, sdr.norm_empresa(nombre));

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema sdr from anon, authenticated;
    revoke all on function sdr.norm_empresa(text) from anon, authenticated;
  end if;
end $$;
