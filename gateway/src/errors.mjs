// Errores con código estable: el script del box y el bot deciden qué hacer por el código,
// no por el texto. El texto es para la persona que lee el log.

export class GatewayError extends Error {
  constructor(code, message, status = 400, extra = undefined) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

export const errors = {
  unauthorized: () => new GatewayError('unauthorized', 'Token ausente, inválido, vencido o revocado.', 401),
  scope: (scope) => new GatewayError('forbidden_scope', `El token no tiene el permiso "${scope}".`, 403),
  invalid: (message, extra) => new GatewayError('invalid_request', message, 400, extra),
  mailboxNotFound: (email) => new GatewayError('mailbox_not_found', `No hay un buzón ${email} para este cliente.`, 404),
  mailboxPaused: (email) => new GatewayError('mailbox_paused', `El buzón ${email} está pausado.`, 423),
  mailboxBlocked: (email) => new GatewayError('mailbox_blocked',
    `El buzón ${email} quedó bloqueado después de tres fallas de autenticación seguidas. ` +
    'Hay que cargar la contraseña correcta en el panel /admin (Contraseña) o con bin/admin.mjs set-password. ' +
    'Se bloquea para no disparar el bloqueo por intentos fallidos del servidor de correo.', 423),
  authFailed: (proto) => new GatewayError('mail_auth_failed',
    `El servidor ${proto} rechazó el usuario o la contraseña del buzón.`, 502),
  unreachable: (proto, detail) => new GatewayError('mail_server_unreachable',
    `No se pudo conectar al servidor ${proto}: ${detail}`, 504),
  mailServer: (proto, detail) => new GatewayError('mail_server_error',
    `El servidor ${proto} respondió con un error: ${detail}`, 502),
  folderNotFound: (folder) => new GatewayError('folder_not_found', `No existe la carpeta "${folder}".`, 404),
  messageNotFound: (folder, uid) => new GatewayError('message_not_found',
    `No hay un mensaje con uid ${uid} en "${folder}".`, 404),
  notAllowed: (message) => new GatewayError('not_allowed', message, 422),
  capReached: (cap, day) => new GatewayError('cap_reached',
    `El buzón llegó a su cupo de ${cap} envíos del día ${day}.`, 429, { cap, day }),
  inProgress: () => new GatewayError('send_in_progress',
    'Ya hay un envío con esa clave de idempotencia en curso o cortado a mitad. ' +
    'No se reintenta para no duplicar: revisar la carpeta de enviados antes de usar otra clave.', 409),
  recipientsRejected: (rejected) => new GatewayError('recipients_rejected',
    'El servidor SMTP rechazó todos los destinatarios.', 422, { rejected }),
  tooLarge: () => new GatewayError('payload_too_large', 'El cuerpo del pedido supera 1 MB.', 413),
  notFound: () => new GatewayError('not_found', 'Ruta inexistente.', 404),
  config: (message) => new GatewayError('misconfigured', message, 500),
};
