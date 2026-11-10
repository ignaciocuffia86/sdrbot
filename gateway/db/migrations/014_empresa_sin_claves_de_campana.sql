-- Etapa C1 (docs/21 §6.2, «Migración de la principal», paso 3; §7.2, paso 4): Empresa se queda con
-- lo común y la «principal» con lo suyo.
--
-- La 012 COPIÓ a la «principal» las claves de la campaña. Desde entonces el formulario de Empresa
-- las siguió editando en Empresa, y el gateway leía la principal con lo de Empresa encima
-- (en_campana.efectivos). Por eso acá, por cliente:
--   1. la principal toma los valores de Empresa de hoy (Empresa gana: es lo que el cliente vio y
--      editó): icp, roles_objetivo, senal_avisos, dias_aviso, llamado_accion, links_permitidos,
--      positivos, y `oferta` como `propuesta`; las cuentas por día de Empresa van a su columna;
--   2. la principal deja de tener su copia de `acepta_mails_extrapolados`: queda en Empresa como
--      valor por defecto y la campaña lo hereda (decisión 9);
--   3. Empresa estrena `descripcion` con una copia de `oferta` (el panel avisa «Revisar la
--      descripción de la empresa» mientras sea igual a la propuesta de la principal);
--   4. Empresa pierde esas claves, `cuentas_por_dia` y `buzones` (el texto libre de qué buzón usar,
--      que reemplazan los buzones de cada campaña). Lo de antes queda en el historial.
--
-- Después de esto el panel muestra el formulario nuevo de Empresa (ajustes.formularioEmpresa) y
-- reglas_manual arma la sección de las reglas viejas con lo de la principal: un cliente que sigue
-- en las reglas de antes recibe lo mismo que hoy.
--
-- Es idempotente: un cliente ya migrado no tiene esas claves en Empresa y no cambia.

-- Qué formulario de Empresa ve el panel: 'transicion' (Empresa con lo de la «principal», el de hasta
-- ahora) o 'empresa' (sólo lo común; lo de cada campaña, en su campaña). Esta migración pasa a
-- 'empresa' a cada cliente que migra. Los clientes nuevos arrancan en 'transicion' hasta que la
-- pestaña Campañas se abra a los clientes (docs/21 §7.2, paso 5).
alter table sdr.cliente_config add column if not exists formulario text not null default 'transicion'
  check (formulario in ('transicion', 'empresa'));

create or replace function sdr.migrar_empresa_014(p_client text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_e        jsonb;
  v_k        sdr.campana%rowtype;
  v_legado   jsonb;
  v_empresa  jsonb;
  v_campana  jsonb;
  v_claves   text[] := array['icp', 'roles_objetivo', 'senal_avisos', 'dias_aviso', 'llamado_accion', 'links_permitidos', 'positivos'];
  v_quitar   text[] := array['oferta', 'icp', 'roles_objetivo', 'senal_avisos', 'dias_aviso', 'llamado_accion', 'links_permitidos',
                             'positivos', 'cuentas_por_dia', 'buzones'];
begin
  select ajustes into v_e from sdr.cliente_config where client_id = p_client for update;
  if v_e is null or not (v_e ?| v_quitar) then return false; end if;

  -- Una foto de cómo estaba Empresa, para verla (y volver) desde el historial.
  insert into sdr.ajustes_historial (client_id, ajustes, cambios, por_rol, nota)
  values (p_client, v_e, '{}', 'cli', 'Antes de la migración 014.');

  perform sdr.campana_principal(p_client);
  select * into v_k from sdr.campana where client_id = p_client and clave = 'principal' for update;

  -- 1 y 2: la principal, con lo de Empresa encima y sin su copia de los extrapolados.
  select coalesce(jsonb_object_agg(k, v_e->k), '{}'::jsonb) into v_legado
    from unnest(v_claves) k where v_e ? k and jsonb_typeof(v_e->k) <> 'null';
  if v_e ? 'oferta' and jsonb_typeof(v_e->'oferta') <> 'null' then
    v_legado := v_legado || jsonb_build_object('propuesta', v_e->'oferta');
  end if;
  v_campana := (coalesce(v_k.ajustes, '{}'::jsonb) || v_legado) - 'acepta_mails_extrapolados';
  if v_campana is distinct from v_k.ajustes then
    insert into sdr.ajustes_historial (client_id, campana_id, ajustes, cambios, por_rol, nota)
    values (p_client, v_k.id, v_campana,
            array(select key from jsonb_each(v_campana) where v_k.ajustes->key is distinct from value
                  union select key from jsonb_each(v_k.ajustes) where not v_campana ? key),
            'cli', 'Migración 014: la campaña toma lo que tenía Empresa.');
  end if;
  update sdr.campana
     set ajustes = v_campana,
         cuentas_por_dia = case when v_e->>'cuentas_por_dia' ~ '^[0-9]{1,3}$'
                                then least((v_e->>'cuentas_por_dia')::int, 100) else cuentas_por_dia end,
         actualizado_at = now()
   where id = v_k.id;

  -- 3 y 4: Empresa.
  v_empresa := v_e - v_quitar;
  if not v_empresa ? 'descripcion' and v_e ? 'oferta' and jsonb_typeof(v_e->'oferta') = 'string' then
    v_empresa := v_empresa || jsonb_build_object('descripcion', v_e->'oferta');
  end if;
  update sdr.cliente_config set ajustes = v_empresa, formulario = 'empresa', actualizado_at = now() where client_id = p_client;
  insert into sdr.ajustes_historial (client_id, ajustes, cambios, por_rol, nota)
  values (p_client, v_empresa,
          array(select key from jsonb_each(v_e) where not v_empresa ? key
                union select key from jsonb_each(v_empresa) where v_e->key is distinct from value),
          'cli', 'Migración 014: lo de cada campaña pasó a la campaña (la «principal»). Lo de antes, en la versión anterior.');
  return true;
end $$;

revoke all on function sdr.migrar_empresa_014(text) from public;

select sdr.migrar_empresa_014(client_id) from sdr.cliente_config;
