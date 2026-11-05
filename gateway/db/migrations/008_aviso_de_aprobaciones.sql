-- El despertador también avisa al orquestador: cuando hay aprobaciones pendientes, el gateway
-- despierta su routine «SDR · aprobaciones» por webhook, igual que despierta a seguimiento cuando
-- llega correo. Así una respuesta a un positivo no espera a la routine de las 12 o las 16, ni
-- depende de que otro bot se acuerde de mandarle un mensaje.

alter table sdr.aprobacion add column if not exists avisada_at timestamptz;
alter table sdr.aprobacion add column if not exists avisos int not null default 0;
create index if not exists aprobacion_pendiente on sdr.aprobacion (client_id, creado_at) where estado = 'pendiente';
