-- Etapa C1, lo suelto (docs/21 §7.2): desde que la pestaña Campañas está abierta a los clientes,
-- un cliente nuevo arranca con el formulario de Empresa sola; lo de cada campaña se edita en su
-- campaña. La 014 dejaba a los nuevos en 'transicion'.
--
-- También pasa a 'empresa' a los clientes que ya existen y no tienen claves de campaña en Empresa
-- (la 014 no los tocaba porque no había nada que mover). Si después la CLI les carga claves de
-- campaña, setConfig las mueve a la «principal» con sdr.migrar_empresa_014.

alter table sdr.cliente_config alter column formulario set default 'empresa';

update sdr.cliente_config set formulario = 'empresa'
 where formulario = 'transicion'
   and not (ajustes ?| array['oferta', 'icp', 'roles_objetivo', 'senal_avisos', 'dias_aviso', 'llamado_accion', 'links_permitidos',
                            'positivos', 'cuentas_por_dia', 'buzones']);
