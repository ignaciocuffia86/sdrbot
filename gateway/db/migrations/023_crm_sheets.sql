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

grant update (planilla_hoja) on sdr.crm_conexion to mailgw_app;
