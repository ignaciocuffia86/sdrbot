-- Etapa C1 (docs/21 §7.2): desde que el gateway exige que un mail nuevo salga por un buzón de la
-- campaña de la persona, un buzón dado de alta después de la 012 no estaba en ninguna campaña y no
-- podía mandar nada. Ahora todo buzón nuevo entra en la «principal» de su cliente (si el cliente ya
-- tiene una); de las demás campañas lo saca o lo suma el panel.
--
-- También suma a la «principal» los buzones que se dieron de alta entre la 012 y esta migración.

create or replace function sdr.buzon_a_principal()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into sdr.campana_buzon (client_id, campana_id, account_id)
  select new.client_id, k.id, new.id
    from sdr.campana k
   where k.client_id = new.client_id and k.clave = 'principal'
  on conflict do nothing;
  return new;
end $$;

revoke all on function sdr.buzon_a_principal() from public;

drop trigger if exists a_principal on mailgw.account;
create trigger a_principal after insert on mailgw.account
  for each row execute function sdr.buzon_a_principal();

insert into sdr.campana_buzon (client_id, campana_id, account_id)
select a.client_id, k.id, a.id
  from mailgw.account a
  join sdr.campana k on k.client_id = a.client_id and k.clave = 'principal'
on conflict do nothing;
