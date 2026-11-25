-- Cómo habla, qué casos cita, qué objeciones contesta, a quién evita y quién toma a los interesados
-- pasan a ser sólo de cada campaña (docs/21 §6.2, docs/29). Hasta acá Empresa los tenía como base:
-- la campaña heredaba el tono, el idioma y el responsable, sumaba sus exclusiones y objeciones a las
-- de Empresa y elegía sus casos de la «biblioteca» de Empresa. Con una campaña en inglés y otra en
-- español, o un AM por vertical o por territorio, esa base no servía.
--
-- Empresa queda con quién es (nombre comercial, qué hace), la firma por defecto y si se aceptan mails
-- deducidos. «No contactar» sigue siendo del cliente: vale para todas las campañas.
--
-- Cada campaña (también las pausadas y las terminadas, que siguen contestando) se queda con lo que
-- hasta hoy le llegaba de Empresa, así los bots ven lo mismo que antes:
--   - tono, idioma, quién toma a los interesados, su mail y el link de agenda: el de la campaña, o
--     si no tenía, el de Empresa;
--   - exclusiones y objeciones: las de Empresa y después las de la campaña, sin repetir;
--   - casos: los que la campaña había elegido de Empresa, en el orden de Empresa; si no había
--     elegido ninguno, todos los de Empresa.
-- Después se sacan de Empresa. Todo queda en el historial, con una foto de Empresa de antes.
--
-- sdr.migrar_empresa_024 también la usa el gateway si lo de la campaña vuelve a Empresa por otro
-- camino (la CLI, o restaurar una versión vieja de Empresa): entonces los casos se suman como las
-- demás listas (p_seleccion = false), porque los de la campaña ya son suyos.
-- Idempotente: un cliente sin esas claves en Empresa no cambia.

create or replace function sdr.migrar_empresa_024(p_client text, p_seleccion boolean default false)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_e        jsonb;
  v_k        sdr.campana%rowtype;
  v_a        jsonb;
  v_lista    jsonb;
  v_empresa  jsonb;
  v_clave    text;
  v_escalar  text[] := array['tono', 'idioma', 'responsable_positivos', 'responsable_email', 'link_agenda'];
  v_listas   text[] := array['excluir', 'objeciones'];
  v_quitar   text[] := array['tono', 'idioma', 'excluir', 'prueba_social', 'objeciones',
                             'responsable_positivos', 'responsable_email', 'link_agenda'];
begin
  if mailgw.current_client() is not null and mailgw.current_client() <> p_client then
    raise exception 'migrar_empresa_024: cliente % fuera de la sesión', p_client using errcode = '42501';
  end if;
  select ajustes into v_e from sdr.cliente_config where client_id = p_client for update;
  if v_e is null or not (v_e ?| v_quitar) then return false; end if;

  insert into sdr.ajustes_historial (client_id, ajustes, cambios, por_rol, nota)
  values (p_client, v_e, '{}', 'cli', 'Antes de la migración 024.');

  -- Un cliente sin campañas: lo de Empresa va a la «principal», que se crea acá.
  perform sdr.campana_principal(p_client);

  for v_k in select * from sdr.campana where client_id = p_client order by creado_at, id for update loop
    v_a := coalesce(v_k.ajustes, '{}'::jsonb);

    foreach v_clave in array v_escalar loop
      if not (v_a ? v_clave and jsonb_typeof(v_a->v_clave) <> 'null')
         and v_e ? v_clave and jsonb_typeof(v_e->v_clave) <> 'null' then
        v_a := v_a || jsonb_build_object(v_clave, v_e->v_clave);
      end if;
    end loop;

    foreach v_clave in array v_listas || case when p_seleccion then array[]::text[] else array['prueba_social'] end loop
      select coalesce(jsonb_agg(x order by o), '[]'::jsonb) into v_lista from (
        select x, min(o) as o from (
          select x, n as o from jsonb_array_elements(case when jsonb_typeof(v_e->v_clave) = 'array' then v_e->v_clave else '[]' end)
                                with ordinality as t(x, n)
          union all
          select x, 100000 + n from jsonb_array_elements(case when jsonb_typeof(v_a->v_clave) = 'array' then v_a->v_clave else '[]' end)
                                with ordinality as t(x, n)
        ) u group by x
      ) d;
      if jsonb_array_length(v_lista) > 0 then v_a := v_a || jsonb_build_object(v_clave, v_lista); end if;
    end loop;

    -- Los casos de la migración: hasta hoy la campaña guardaba cuáles de Empresa citaba.
    if p_seleccion and jsonb_typeof(v_e->'prueba_social') = 'array' then
      if jsonb_typeof(v_a->'prueba_social') = 'array' and jsonb_array_length(v_a->'prueba_social') > 0 then
        select coalesce(jsonb_agg(x order by n), '[]'::jsonb) into v_lista
          from jsonb_array_elements(v_e->'prueba_social') with ordinality as t(x, n)
         where v_a->'prueba_social' @> jsonb_build_array(x);
      else
        v_lista := v_e->'prueba_social';
      end if;
      v_a := case when jsonb_array_length(v_lista) > 0 then v_a || jsonb_build_object('prueba_social', v_lista)
                  else v_a - 'prueba_social' end;
    elsif p_seleccion and v_a ? 'prueba_social' then
      -- Había elegido casos de una biblioteca vacía: no citaba ninguno, y sigue sin citar.
      v_a := v_a - 'prueba_social';
    end if;

    if v_a is distinct from v_k.ajustes then
      insert into sdr.ajustes_historial (client_id, campana_id, ajustes, cambios, por_rol, nota)
      values (p_client, v_k.id, v_a,
              array(select key from jsonb_each(v_a) where coalesce(v_k.ajustes, '{}'::jsonb)->key is distinct from value
                    union select key from jsonb_each(coalesce(v_k.ajustes, '{}'::jsonb)) where not v_a ? key),
              'cli', 'Migración 024: la campaña toma de Empresa el tono, el idioma, los casos, las objeciones, las exclusiones y quién toma a los interesados.');
      update sdr.campana set ajustes = v_a, actualizado_at = now() where id = v_k.id;
    end if;
  end loop;

  v_empresa := v_e - v_quitar;
  update sdr.cliente_config set ajustes = v_empresa, actualizado_at = now() where client_id = p_client;
  insert into sdr.ajustes_historial (client_id, ajustes, cambios, por_rol, nota)
  values (p_client, v_empresa, array(select key from jsonb_each(v_e) where not v_empresa ? key),
          'cli', 'Migración 024: el tono, el idioma, los casos, las objeciones, las exclusiones y quién toma a los interesados pasaron a cada campaña. Lo de antes, en la versión anterior.');
  return true;
end $$;

revoke all on function sdr.migrar_empresa_024(text, boolean) from public;
-- La llama el panel (con el rol del portal) al guardar Empresa: sólo mueve lo del cliente fijado en
-- la sesión, dentro de ese mismo cliente.
grant execute on function sdr.migrar_empresa_024(text, boolean) to mailgw_app, mailgw_portal;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function sdr.migrar_empresa_024(text, boolean) from anon, authenticated;
  end if;
end $$;

select sdr.migrar_empresa_024(client_id, true) from sdr.cliente_config;

-- Los pasos del alta que pasaron al asistente de cada campaña («Casos y objeciones», «Interesados
-- y derivación»): sus marcas ya no se muestran en ningún lado.
delete from mailgw.asistente_paso where ambito = 'alta' and paso in ('casos', 'interesados');
delete from mailgw.asistente_paso where ambito = 'alta'
   and paso in ('campo:tono', 'campo:idioma', 'campo:excluir', 'campo:prueba_social', 'campo:objeciones',
                'campo:responsable_positivos', 'campo:responsable_email', 'campo:link_agenda');
