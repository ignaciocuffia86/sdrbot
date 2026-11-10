-- Carga de cuentas por archivo, etapa 3 (docs/27 §4.1 y §9): deshacer un lote, el informe por
-- renglón y el mapeo guardado.
--
-- informe        lo que pasó con cada renglón del archivo, para descargar como CSV. Se borra a los
--                30 días (el gateway lo vacía al listar las cargas); el archivo nunca se guarda.
-- mapeo_nombres  qué encabezado del archivo fue a cada campo, para proponer el mismo mapeo la
--                próxima vez que el cliente suba un archivo con esas columnas.

alter table sdr.lote_carga add column if not exists informe jsonb;
alter table sdr.lote_carga add column if not exists mapeo_nombres jsonb not null default '{}'::jsonb;
alter table sdr.lote_carga add column if not exists deshecho_at timestamptz;
alter table sdr.lote_carga add column if not exists deshecho_por text;
alter table sdr.lote_carga drop constraint if exists lote_carga_deshecho_check;
alter table sdr.lote_carga add constraint lote_carga_deshecho_check check ((estado = 'deshecho') = (deshecho_at is not null));

-- La aplicación escribe el informe y el mapeo al crear el lote (ya puede insertar); el portal
-- vacía los informes vencidos (ya puede actualizar).

-- Deshacer un lote: borra lo que creó y nada más, mientras nada de eso se haya trabajado.
--   campaña       las cuentas que creó el lote (con sus personas, eventos y lo que cuelga de ellas)
--                 y las personas que sumó a cuentas que ya estaban. No se deshace si alguna persona
--                 de esas cuentas, o alguna persona del lote, ya tuvo un toque, un próximo paso,
--                 Dripify o una aprobación, o si alguna de sus cuentas está en contacto o en pausa.
--   no_contactar  las filas de la lista que agregó el lote. Lo que esas filas ya hicieron (cuentas
--                 excluidas, Dripify frenado) no vuelve atrás.
-- Corre como dueño, siempre dentro del cliente fijado por el gateway (mailgw.current_client()):
-- la aplicación no tiene permiso de borrar cuentas ni personas, y no lo gana.
create or replace function sdr.deshacer_lote(p_lote uuid, p_por text) returns jsonb
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_cliente text := mailgw.current_client();
  v_lote record;
  v_en_uso int;
  v_cuentas int := 0;
  v_personas int := 0;
  v_filas int := 0;
begin
  if v_cliente is null or v_cliente = '' then
    raise exception 'deshacer_lote sin cliente fijado' using errcode = '42501';
  end if;
  select id, destino, estado into v_lote from sdr.lote_carga where id = p_lote and client_id = v_cliente for update;
  if not found then return jsonb_build_object('error', 'no_existe'); end if;
  if v_lote.estado = 'deshecho' then return jsonb_build_object('error', 'ya_deshecho'); end if;

  if v_lote.destino = 'campana' then
    select count(*) into v_en_uso
      from sdr.prospecto p
     where p.client_id = v_cliente
       and (p.lote_id = p_lote or p.cuenta_id in (select k.id from sdr.cuenta k where k.client_id = v_cliente and k.lote_id = p_lote))
       and (p.estado <> 'investigado' or p.proximo_paso is not null or p.dripify is not null
            or exists (select 1 from sdr.aprobacion a where a.client_id = p.client_id and a.prospecto_id = p.id)
            or exists (select 1 from sdr.evento e where e.client_id = p.client_id and e.prospecto_id = p.id
                         and e.tipo in ('mail.enviado', 'linkedin.cargado', 'whatsapp.enviado', 'respuesta')));
    v_en_uso := v_en_uso + (select count(*) from sdr.cuenta k
                             where k.client_id = v_cliente and k.lote_id = p_lote and k.estado in ('en_contacto', 'en_pausa'));
    if v_en_uso > 0 then return jsonb_build_object('error', 'en_uso', 'en_uso', v_en_uso); end if;
    delete from sdr.prospecto p
     where p.client_id = v_cliente and p.lote_id = p_lote
       and p.cuenta_id not in (select k.id from sdr.cuenta k where k.client_id = v_cliente and k.lote_id = p_lote);
    get diagnostics v_personas = row_count;
    v_personas := v_personas + (select count(*) from sdr.prospecto p
                                 where p.client_id = v_cliente
                                   and p.cuenta_id in (select k.id from sdr.cuenta k where k.client_id = v_cliente and k.lote_id = p_lote));
    delete from sdr.cuenta k where k.client_id = v_cliente and k.lote_id = p_lote;
    get diagnostics v_cuentas = row_count;
  else
    delete from sdr.no_contactar n where n.client_id = v_cliente and n.lote_id = p_lote;
    get diagnostics v_filas = row_count;
  end if;

  update sdr.lote_carga set estado = 'deshecho', deshecho_at = now(), deshecho_por = left(p_por, 254)
   where id = p_lote and client_id = v_cliente;
  return jsonb_build_object('cuentas', v_cuentas, 'personas', v_personas, 'filas', v_filas);
end $$;

revoke all on function sdr.deshacer_lote(uuid, text) from public;
grant execute on function sdr.deshacer_lote(uuid, text) to mailgw_app;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function sdr.deshacer_lote(uuid, text) from anon, authenticated;
  end if;
end $$;
