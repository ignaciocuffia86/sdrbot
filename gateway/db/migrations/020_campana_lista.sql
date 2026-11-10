-- Carga de cuentas por archivo, etapa 2 (docs/27 §5): la campaña de tipo «Lista del cliente».
--
-- Una campaña `lista` no busca cuentas por avisos: trabaja las que el cliente cargó en ella desde
-- un archivo (sdr.cuenta con origen 'archivo' y uso 'prospectar'), en el orden del archivo.
--
-- Las personas que trae el archivo guardan su mail con calidad 'del_cliente': no es un mail
-- verificado ni deducido, es el que dio el cliente. La campaña decide si se usa para el primer
-- mail («Acepta los mails del cliente», sí si no dice nada).

alter table sdr.campana drop constraint if exists campana_tipo_check;
alter table sdr.campana add constraint campana_tipo_check
  check (tipo in ('prospeccion', 'evento', 'reactivacion', 'lista'));

alter table sdr.prospecto drop constraint if exists prospecto_email_calidad_check;
alter table sdr.prospecto add constraint prospecto_email_calidad_check
  check (email_calidad is null or email_calidad in ('verificado', 'extrapolado', 'desconocido', 'del_cliente'));

-- La próxima cuenta de una lista sale por campaña y orden del archivo (ya está el índice
-- cuenta_lista de la 019); las personas de una cuenta, por su cuenta.
create index if not exists prospecto_cuenta on sdr.prospecto (client_id, cuenta_id) where cuenta_id is not null;
