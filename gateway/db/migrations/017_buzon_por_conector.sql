-- Etapa F1 (docs/08 §7): el puente para buzones de Google y Microsoft mientras las aplicaciones
-- de Biguá no están verificadas. El buzón está conectado en la cuenta de Grok del cliente (el
-- conector de Gmail u Outlook) y el bot envía por ahí; el gateway no está en el camino del envío,
-- pero sigue decidiendo: el bot reserva cada envío (cupo, idempotencia, campaña, calibración,
-- supresiones…), lo confirma después, y una conciliación diaria pausa el buzón si algo salió
-- sin reserva.

-- ---------------------------------------------------------------- el buzón

-- auth: 'password' (IMAP/SMTP con contraseña, lo de siempre) o 'conector' (sin credencial ni
-- servidores: lo maneja el conector de Grok). provider: de quién es el buzón.
alter table mailgw.account add column if not exists auth text not null default 'password'
  check (auth in ('password', 'conector'));
alter table mailgw.account add column if not exists provider text not null default 'imap'
  check (provider in ('imap', 'google', 'microsoft'));

-- calibracion: los primeros mails nuevos de un buzón por conector necesitan aprobación, aunque su
-- campaña ya haya calibrado (docs/08 §7.3). No aplica a los buzones con contraseña.
alter table mailgw.account add column if not exists calibracion integer not null default 5
  check (calibracion between 0 and 50);

-- conector_modo: 'envio' (el bot manda por el conector y confirma) o 'borradores' (el bot sólo
-- deja el borrador y una persona del cliente lo manda; lo confirma la conciliación, §7.4). Arranca
-- en borradores, que no tiene riesgo de envío.
alter table mailgw.account add column if not exists conector_modo text not null default 'borradores'
  check (conector_modo in ('envio', 'borradores'));

-- Un buzón por conector no tiene contraseña ni servidores.
alter table mailgw.account alter column username drop not null;
alter table mailgw.account alter column secret_enc drop not null;
alter table mailgw.account alter column imap_host drop not null;
alter table mailgw.account alter column imap_port drop not null;
alter table mailgw.account alter column imap_security drop not null;
alter table mailgw.account alter column smtp_host drop not null;
alter table mailgw.account alter column smtp_port drop not null;
alter table mailgw.account alter column smtp_security drop not null;
alter table mailgw.account drop constraint if exists account_credencial;
alter table mailgw.account add constraint account_credencial check (
  auth <> 'password' or (username is not null and secret_enc is not null and imap_host is not null and imap_port is not null
                         and imap_security is not null and smtp_host is not null and smtp_port is not null and smtp_security is not null));

-- ---------------------------------------------------------------- el libro de envíos

-- via: 'gateway' (lo mandó el gateway por SMTP) o 'conector' (lo mandó el bot por el conector,
-- con una reserva). conector: lo que se reservó (destinatarios, asunto, huella del texto,
-- aprobación, prospecto, la corrida), para confirmar y conciliar.
alter table mailgw.send_log add column if not exists via text not null default 'gateway' check (via in ('gateway', 'conector'));
alter table mailgw.send_log add column if not exists conector jsonb;
