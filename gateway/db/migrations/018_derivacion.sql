-- Derivación de un interesado al cliente (docs/16 §7, docs/09 §5.4): la respuesta a un positivo
-- sale desde la casilla secundaria, en el mismo hilo, con quien toma a los interesados en copia
-- (su casilla del dominio principal). Desde ahí la conversación es del cliente.
--
-- El prospecto guarda a quién se derivó y cuándo. No es un estado nuevo: la persona sigue siendo
-- positivo o en_crm (el CRM la carga igual); la derivación es lo que frena al SDR.

alter table sdr.prospecto add column if not exists derivado_a text
  check (derivado_a is null or (derivado_a = lower(derivado_a) and derivado_a like '%_@_%'));
alter table sdr.prospecto add column if not exists derivado_at timestamptz;

-- Un evento nuevo en la línea de tiempo: «derivado» (lo ve el cliente).
alter table sdr.evento drop constraint if exists evento_tipo_check;
alter table sdr.evento add constraint evento_tipo_check check (tipo in (
  'cuenta.investigada', 'cuenta.excluida', 'prospecto.revelado',
  'mail.enviado', 'mail.rebotado',
  'linkedin.cargado', 'linkedin.invitacion', 'linkedin.conexion', 'linkedin.mensaje',
  'linkedin.pausado', 'linkedin.bloqueado',
  'whatsapp.enviado', 'respuesta', 'positivo', 'crm.cargado', 'baja',
  'aprobacion.pedida', 'aprobacion.decidida', 'pedido', 'decision', 'aviso.cliente', 'nota', 'derivado'));

-- Un correo nuevo: lo que escribe en el hilo quien tomó al interesado (por ejemplo, su «responder a
-- todos» que también le llega a la casilla secundaria). No es una respuesta del prospecto: queda
-- atendido y no despierta a seguimiento.
alter table sdr.correo drop constraint if exists correo_tipo_check;
alter table sdr.correo add constraint correo_tipo_check
  check (tipo in ('respuesta', 'automatica', 'rebote', 'rebote_temporal', 'baja', 'de_cuenta', 'del_responsable'));
