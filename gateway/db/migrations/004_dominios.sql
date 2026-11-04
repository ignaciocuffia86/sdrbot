-- Chequeo de SPF, DKIM, DMARC y MX por dominio de cada cliente.
--
-- Una fila por (cliente, dominio): los selectores DKIM que cargó el cliente y el resultado
-- del último chequeo, para que el panel lo muestre sin volver a consultar DNS. Los dominios
-- salen de los buzones del cliente; dos clientes con el mismo dominio tienen filas separadas.

create table if not exists mailgw.domain_check (
  client_id       text not null references mailgw.client on delete cascade,
  domain          text not null check (domain = lower(domain) and domain like '%_._%'),
  dkim_selectors  text[] not null default '{}',
  status          text check (status in ('ok', 'warn', 'error')),
  result          jsonb,
  checked_at      timestamptz,
  primary key (client_id, domain)
);

alter table mailgw.domain_check enable row level security;

grant select, insert, update on mailgw.domain_check to mailgw_portal;

drop policy if exists portal_por_cliente on mailgw.domain_check;
create policy portal_por_cliente on mailgw.domain_check for all to mailgw_portal
  using (client_id = mailgw.current_client())
  with check (client_id = mailgw.current_client());
