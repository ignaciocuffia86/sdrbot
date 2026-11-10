-- Cierre del formulario de transición de Empresa (docs/29 §Lo que sigue). Desde la 014, lo de cada
-- campaña (a quién, la propuesta, qué es positivo, el volumen) vive en su campaña, y Empresa sólo lo
-- común. El panel siguió ofreciendo, para los clientes de antes de la 014, el formulario viejo que
-- editaba lo de la «principal» desde Empresa. Ya no queda ningún cliente así: el panel muestra un
-- solo formulario de Empresa y lo de la campaña que llegue a Empresa por otro camino (la CLI, volver a
-- una versión de antes de la 014) pasa a la «principal» con sdr.migrar_empresa_014.
--
-- Por las dudas, migra a cualquier cliente que todavía tenga en Empresa claves de la campaña.
-- Idempotente: un cliente ya migrado no cambia.

select sdr.migrar_empresa_014(client_id) from sdr.cliente_config
 where ajustes ?| array['oferta', 'icp', 'roles_objetivo', 'senal_avisos', 'dias_aviso', 'llamado_accion', 'links_permitidos',
                        'positivos', 'cuentas_por_dia', 'buzones'];

update sdr.cliente_config set formulario = 'empresa' where formulario <> 'empresa';

-- La columna queda sin uso (el panel ya no la lee) y se borra en una migración posterior, cuando
-- ninguna versión desplegada del gateway la consulte.
comment on column sdr.cliente_config.formulario is
  'Sin uso desde la migración 022: hay un solo formulario de Empresa. Se borra en una migración posterior.';
