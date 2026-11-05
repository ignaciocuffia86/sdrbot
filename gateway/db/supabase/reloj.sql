-- El reloj de la memoria del correo (etapa 2): cada 5 minutos, pg_cron llama a
-- POST https://sdrbot.bigua.lat/cron/correo con un secreto. El gateway lee los buzones de los
-- clientes con `seguimiento` activo y despierta al bot.
--
-- Sólo para Supabase (pg_cron y pg_net no están en el Postgres de las pruebas): se aplica una vez
-- con el MCP de Supabase o el editor SQL, después de la migración 006.
--
-- El secreto se genera acá adentro y queda en el Vault: no pasa por el repo, el chat ni Vercel.
-- La tabla sdr.reloj guarda sólo su sha256, que es lo que compara el gateway.
-- Volver a correr este archivo rota el secreto (el job lee siempre el del Vault).

create extension if not exists pg_cron;
create extension if not exists pg_net;

do $$
declare
  s text := 'mgw_' || encode(extensions.gen_random_bytes(32), 'hex');
  existente uuid;
begin
  select id into existente from vault.secrets where name = 'sdr_reloj';
  if existente is null then
    perform vault.create_secret(s, 'sdr_reloj', 'Secreto de POST /cron/correo del gateway SDRBOT');
  else
    perform vault.update_secret(existente, s);
  end if;
  insert into sdr.reloj (id, secreto_hash) values (true, encode(extensions.digest(s, 'sha256'), 'hex'))
  on conflict (id) do update set secreto_hash = excluded.secreto_hash;
end $$;

select cron.unschedule(jobid) from cron.job where jobname = 'sdr-correo';
select cron.schedule('sdr-correo', '*/5 * * * *', $job$
  select net.http_post(
    url := 'https://sdrbot.bigua.lat/cron/correo',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'sdr_reloj'),
      'Content-Type', 'application/json'),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000)
$job$);

-- Para ver cómo le va:
--   select ultimo_tick_at, ultimo_resultado from sdr.reloj;
--   select status_code, content, created from net._http_response order by created desc limit 5;
--   select * from cron.job_run_details where jobid = (select jobid from cron.job where jobname = 'sdr-correo')
--     order by start_time desc limit 5;
