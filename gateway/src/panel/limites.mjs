// Límites de uso del MCP del panel y del OAuth (docs/24 §6): una ventana de un minuto por clave,
// contada en la base (en Vercel, dos pedidos seguidos pueden caer en instancias distintas).
//
//   por usuario en /mcp/panel     60 pedidos por minuto
//   cambios (decidir, editar)     20 por minuto por usuario
//   por IP en /oauth/*            30 pedidos por minuto (ingreso, canje, registro)
//
// Si la base no responde, el límite no bloquea: el pedido sigue y falla después por su cuenta.

import { getPool } from '../store.mjs';
import { GatewayError } from '../errors.mjs';

// Se pueden cambiar por variable de entorno (las pruebas los suben o los bajan).
const tope = (nombre, defecto) => Number(process.env[`MAILGW_LIMITE_${nombre.toUpperCase()}`]) || defecto;
export const TOPES = {
  get usuario() { return tope('usuario', 60); },
  get cambios() { return tope('cambios', 20); },
  get ip() { return tope('ip', 30); },
};

export async function contar(clave, tope) {
  let n;
  try {
    const { rows } = await getPool().query(
      `insert into mailgw.limite (clave, ventana, n) values ($1, date_trunc('minute', now()), 1)
       on conflict (clave, ventana) do update set n = mailgw.limite.n + 1 returning n`, [clave]);
    n = rows[0].n;
    // Limpieza de a poco: una vez cada ~200 pedidos, lo de hace más de una hora.
    if (Math.random() < 0.005) {
      getPool().query(`delete from mailgw.limite where ventana < now() - interval '1 hour'`).catch(() => {});
    }
  } catch (e) {
    console.error('[limites]', e.message);
    return;
  }
  if (n > tope) {
    const espera = 60 - new Date().getUTCSeconds();
    throw new GatewayError('rate_limited', `Demasiados pedidos: el tope es ${tope} por minuto. Probá de nuevo en ${espera} segundos.`, 429,
      { reintentar_en: espera });
  }
}

// La IP de quien llama: la primera de x-forwarded-for (la pone Vercel), o la del socket.
export const ipDe = (req) => String(req.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim()
  || req.headers?.['x-real-ip'] || req.socket?.remoteAddress || 'desconocida';
