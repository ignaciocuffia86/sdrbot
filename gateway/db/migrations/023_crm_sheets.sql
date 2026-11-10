-- docs/23 §14: clientes sin CRM. La misma cola de cargas puede escribir en una planilla de Google
-- Sheets del cliente: una fila por positivo, sin borrar ni pisar nada. El gateway entra con una
-- cuenta de servicio de Biguá (MAILGW_GOOGLE_SA, en Vercel) con la que el cliente comparte la
-- planilla como editor; acá sólo se guarda qué planilla y qué pestaña.

alter table sdr.crm_conexion drop constraint if exists crm_conexion_proveedor_check;
alter table sdr.crm_conexion add constraint crm_conexion_proveedor_check check (proveedor in ('hubspot', 'sheets'));

alter table sdr.crm_conexion add column if not exists planilla_url  text;
alter table sdr.crm_conexion add column if not exists planilla_id   text;
-- La pestaña: el gid de la URL (#gid=…); sin gid, la primera. El nombre se anota al probar o cargar.
alter table sdr.crm_conexion add column if not exists planilla_gid  bigint;
alter table sdr.crm_conexion add column if not exists planilla_hoja text;
-- Que la planilla es del cliente: la cuenta de servicio es la misma para todos, así que tener la URL
-- no alcanza. Al conectar se genera un código; el cliente agrega a la planilla una pestaña con ese
-- nombre (sólo puede quien la edita) y «Probar conexión» la busca. Hasta entonces el gateway no
-- escribe ni muestra nada de la planilla. Si cambia la planilla, código nuevo.
alter table sdr.crm_conexion add column if not exists planilla_codigo        text;
alter table sdr.crm_conexion add column if not exists planilla_verificada_at timestamptz;

grant update (planilla_hoja, planilla_verificada_at) on sdr.crm_conexion to mailgw_app;

-- Y una planilla verificada por un cliente no se puede verificar para otro. Cuenta sólo la
-- verificada: si contara la sólo pegada, cualquiera podría bloquearle a un cliente su propia planilla.
create unique index if not exists crm_conexion_planilla_unica on sdr.crm_conexion (planilla_id)
  where proveedor = 'sheets' and planilla_verificada_at is not null;
