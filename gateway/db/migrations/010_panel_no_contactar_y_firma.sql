-- Etapas A y B del panel por cliente (docs/21): lista de no contactar, firma por buzón y modo de
-- operación del cliente.

-- ---------------------------------------------------------------- no contactar

-- Dominios y mails a los que el SDR no les escribe nunca, de ninguna campaña ni canal: clientes
-- actuales, partners, competidores, quien pidió que no lo contacten. La cargan el cliente o Biguá
-- en el panel (Empresa → No contactar); el gateway la hace cumplir al guardar una cuenta o una
-- persona, al enviar o responder un mail y al cargar en Dripify. Es distinta de sdr.supresion
-- (bajas y rebotes, que escribe el gateway solo).
create table if not exists sdr.no_contactar (
  client_id  text not null references mailgw.client on delete cascade,
  valor      text not null check (valor = lower(valor) and length(valor) between 3 and 254),
  tipo       text not null check (tipo in ('dominio', 'email')),
  motivo     text check (motivo is null or length(motivo) <= 200),
  por_email  text,
  at         timestamptz not null default now(),
  primary key (client_id, valor),
  check ((tipo = 'email') = (position('@' in valor) > 0))
);

alter table sdr.no_contactar enable row level security;

-- La aplicación (los bots) sólo la lee; el portal del cliente la administra.
grant select on sdr.no_contactar to mailgw_app;
grant select, insert, update, delete on sdr.no_contactar to mailgw_portal;

drop policy if exists por_cliente on sdr.no_contactar;
create policy por_cliente on sdr.no_contactar for select to mailgw_app
  using (client_id = mailgw.current_client());
drop policy if exists portal_por_cliente on sdr.no_contactar;
create policy portal_por_cliente on sdr.no_contactar for all to mailgw_portal
  using (client_id = mailgw.current_client()) with check (client_id = mailgw.current_client());

-- ---------------------------------------------------------------- firma por buzón

-- La firma va con quien manda el mail. Sin firma propia, los bots usan la de los ajustes.
alter table mailgw.account add column if not exists firma text;
alter table mailgw.account drop constraint if exists account_firma_largo;
alter table mailgw.account add constraint account_firma_largo check (firma is null or length(firma) <= 600);

-- ---------------------------------------------------------------- modo de operación

-- operado: lo de operación (volumen, buzones, extrapolados) lo decide Biguá.
-- autogestionado: lo decide el cliente, con las cuentas por día hasta el tope que fija Biguá.
alter table sdr.cliente_config add column if not exists modo text not null default 'operado';
alter table sdr.cliente_config drop constraint if exists cliente_config_modo;
alter table sdr.cliente_config add constraint cliente_config_modo check (modo in ('operado', 'autogestionado'));
alter table sdr.cliente_config add column if not exists tope_cuentas_dia int;
alter table sdr.cliente_config drop constraint if exists cliente_config_tope;
alter table sdr.cliente_config add constraint cliente_config_tope check (tope_cuentas_dia is null or tope_cuentas_dia between 0 and 100);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on all tables in schema sdr from anon, authenticated;
  end if;
end $$;
