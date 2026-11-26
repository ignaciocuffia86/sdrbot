# Proveedor de los buzones de prospección

Estado: **decidido el 26/11/2026; falta construir la credencial de Microsoft 365 en el gateway
(§5).** Los precios y las condiciones de los proveedores salen de sus sitios de ayuda y de
reseñas de terceros, que no siempre coinciden: están marcados **(verificar)** y hay que
confirmarlos antes de contratar.

## 1. Decisión

| Tema | Decisión |
|---|---|
| Proveedor principal | **Microsoft 365 contratado directo** (licencia Exchange Online Plan 1, sin Office) |
| Segundo proveedor | **Google Workspace directo**, cuando la campaña le escribe sobre todo a empresas en Google |
| Organización | **Una por cliente**: una suspensión o un problema de reputación no arrastra a los demás clientes |
| Dueño de los dominios | **Biguá** (registra y conserva; en la baja se dan de baja o se reutilizan, `17`) |
| Clientes que traen sus buzones | Se aceptan, por el camino de `08` |
| Calentamiento | Escalones del manifiesto **y** una red de calentamiento externa (zona gris aceptada) |
| Revendedores de buzones (Zapmail, Maildoso, Infraforge) | **No como proveedor principal**. Infraforge queda como opción para un piloto sin código nuevo (§4) |
| SMTP propio o de envío (SES, SendGrid, Mailgun, Postmark) | **Descartado** (§3) |

## 2. Lo que se definió con Biguá

- Dueño de los buzones: Biguá como servicio gestionado y también los que traiga el cliente.
- Volumen en 6 a 12 meses: 5 a 20 clientes con unos 5 buzones cada uno (25 a 100 buzones).
- Los buzones los usa sólo el bot por el gateway: nadie entra a la bandeja. Lo caliente se deriva
  al cliente (`26`).
- Lo que más pesa: la **entregabilidad**, por encima del costo.
- Destinatarios: **corporativos**, mayormente con Microsoft 365.

## 3. Por qué

- **Microsoft 365 por sobre Workspace.** Entre organizaciones de Microsoft el correo suele
  entrar mejor a la bandeja, y los destinatarios están ahí. Como el bot es el único que usa el
  buzón, alcanza con la licencia de Exchange Online Plan 1, de unos USD 4 por buzón por mes,
  contra unos USD 7 a 8,4 de Workspace Business Starter **(verificar)**.
- **Autorización sin trámite.** Biguá administra cada organización, así que registra su propia
  aplicación con permisos de aplicación y no necesita la verificación del editor ni el «un clic»
  de `08` §3 (§5).
- **El gateway tiene que leer, no sólo enviar.** Concilia respuestas, rebotes y bajas por IMAP
  (`07`). Los servicios que sólo envían no tienen bandeja y prohíben el correo en frío en sus
  condiciones de uso. Un SMTP propio en un VPS arranca con una IP sin reputación, el gateway no
  tiene IP fija en Vercel y no hay buzón real detrás.

## 4. Revendedores de buzones

| | Zapmail | Maildoso | Infraforge |
|---|---|---|---|
| Qué vende | Buzones de Google Workspace o Microsoft 365 en organizaciones del proveedor | Buzones en servidores propios, IP rotativas compartidas | Buzones en servidores propios, con IP dedicadas |
| Precio | USD 39 por 10, 99 por 30, 299 por 100 por mes; suben al renovar a los 12 meses (59, 169, 499); calentamiento aparte **(verificar)** | USD 75 por 30, 225 por 300, 499 por 1.000 por mes; dominios aparte, USD 15 por año; 14 días de calentamiento obligatorio **(verificar)** | USD 4 por buzón por mes (pago trimestral, mínimo 10) y USD 99 por mes por IP dedicada, hasta unos 40 buzones por IP; dominios unos USD 14 por año **(verificar)** |
| Acceso para el gateway | **Google: sí**, exporta IMAP, SMTP y contraseñas de aplicación. **Microsoft: no**, sólo da usuario de administrador; no genera credenciales IMAP ni SMTP | IMAP y SMTP propios; no se confirmó cómo se entregan las credenciales | IMAP y SMTP con contraseña |
| API | En el plan de 100 buzones | API REST y servidor MCP: dominios, buzones, DNS | Incluida: IP, dominios, buzones, exportación |
| Dominios | No se encontró a nombre de quién quedan ni cómo se transfieren | Sin dato | Se transfieren pidiéndolo a soporte |

**Qué simplificarían:** compran dominios, publican el DNS y crean los buzones por lotes en
minutos; una sola factura; sin las organizaciones nuevas de Microsoft ni sus límites; reemplazar
un dominio quemado es inmediato. Con Infraforge, Maildoso o los buzones de Google de Zapmail, el
gateway funciona **hoy, sin código**: se cargan como un buzón IMAP genérico (`07`).

**Por qué no como principal:**

- **Separación por cliente.** Zapmail comparte la organización y Maildoso las IP con otros
  remitentes de correo en frío: una suspensión o una lista negra afecta a clientes de Biguá por
  terceros. Infraforge con IP dedicadas lo evita, pero una IP por cliente cuesta USD 99 por mes
  más los buzones, unas cinco veces lo que cuesta Microsoft directo con 5 buzones.
- **Entregabilidad a corporativos.** Maildoso e Infraforge mandan desde servidores propios, sin
  la ventaja de ir de Microsoft a Microsoft, y los filtros corporativos (Proofpoint, Mimecast)
  castigan las IP chicas y nuevas.
- **Microsoft por Zapmail no sirve para el gateway** sin credenciales IMAP y SMTP. Con el
  usuario de administrador que da, habría que registrar la aplicación de §5 dentro de su
  organización, si lo permite **(verificar con Zapmail)**.
- **Otro proveedor con acceso a los datos:** el contenido de los mails y las respuestas de los
  prospectos pasan por él (`07` §2 eligió el stack propio también por esto).
- **Condiciones de uso:** Zapmail revende Google y Microsoft en zona gris; esas organizaciones se
  pueden suspender sin aviso.

**Cuándo sí:**

- **Piloto mientras se construye §5:** un cliente con Infraforge (IP dedicada, IMAP y SMTP con
  contraseña). Prueba la campaña de punta a punta y da una línea de base de entrega a la bandeja
  para comparar con Microsoft.
- **Si administrar organizaciones pasa a ser el cuello de botella** (más de 20 clientes): se
  compara un revendedor contra automatizar el alta de las organizaciones de Microsoft.

## 5. Microsoft 365 en el gateway

Sigue por IMAP (`outlook.office365.com:993`) y SMTP (`smtp.office365.com:587`); cambia sólo la
autenticación, de contraseña a token de aplicación (OAuth, flujo de credenciales del cliente).
El cupo, los seguimientos, las respuestas, los rebotes y las bajas no cambian: viven en el
gateway.

### 5.1 Preparar cada organización (Biguá, una vez)

| # | Qué | Dónde |
|---|---|---|
| 1 | Registrar la aplicación (una por organización, o una de Biguá habilitada en cada una) | Entra ID |
| 2 | Permisos `IMAP.AccessAsApp` y `SMTP.SendAsApp`, con consentimiento del administrador | Entra ID |
| 3 | Credencial: certificado (preferido) o clave secreta (vence a los 24 meses como máximo) | Entra ID |
| 4 | `New-ServicePrincipal -AppId … -ObjectId …` | Exchange Online PowerShell |
| 5 | Por buzón: `Add-MailboxPermission -Identity <buzón> -User <id> -AccessRights FullAccess`; la aplicación sólo entra a los buzones habilitados | Exchange Online PowerShell |
| 6 | Por buzón: `Set-CASMailbox <buzón> -SmtpClientAuthenticationDisabled $false` | Exchange Online PowerShell |
| 7 | Política antispam de salida: tope de destinatarios externos por hora y por día un poco por encima del cupo del panel, como segunda barrera | Microsoft Defender |
| 8 | SPF con `include:spf.protection.outlook.com`, DKIM, DMARC (`p=quarantine`) | DNS; la pestaña «Dominios» lo verifica |

Todo **(verificar al implementar)**. Va como un script de PowerShell en el repo, que también
sirve cuando el cliente trae su propio Microsoft 365 y lo corre su administrador.

### 5.2 Código

- Credencial nueva en `mailgw.account` (por ejemplo `m365_app`): organización, id de la
  aplicación y certificado o clave, cifrados con `MAILGW_ENC_KEYS`. Los buzones de una misma
  organización la comparten.
- Pedir el token en `login.microsoftonline.com/{organización}/oauth2/v2.0/token` con el permiso
  `https://outlook.office365.com/.default`; dura alrededor de una hora, se guarda en memoria por
  organización y se pide otro al vencer.
- `imapflow` y `nodemailer` aceptan el token en lugar de `pass` (`src/mail/imap.mjs`,
  `src/mail/smtp.mjs`).
- Token rechazado: el buzón pasa a `auth_error`, como con una contraseña mala. El panel avisa
  antes de que venza la credencial.
- **Copia en Enviados:** Exchange Online guarda lo que se manda por SMTP **(verificar)**, y el
  gateway hoy la agrega él (`src/mail/compose.mjs`); para estos buzones no se agrega, como en
  Gmail (`08` §5.2).
- Panel, asistente de alta, `29` y MCP del panel en el mismo PR (`CLAUDE.md`). La credencial es
  un secreto: se carga sólo en el panel y se anota en `ALTA_DESDE_CLAUDE`.

### 5.3 Riesgo: organizaciones nuevas

Microsoft limita lo que una organización nueva manda a destinatarios externos según sus
licencias y su antigüedad, y restringe más a las de prueba **(verificar)**. Con 4 a 6 buzones de
25 a 35 envíos por día debería alcanzar; se confirma antes de comprometer plazos. Las licencias
se pagan desde el primer día, sin prueba gratis.

## 6. Por cliente

- 2 dominios secundarios de Biguá, parecidos a la marca del cliente, con 2 o 3 buzones cada uno.
- Tope de 25 a 35 envíos por día por buzón después del calentamiento.
- Costo aproximado: USD 20 a 25 por mes de licencias, unos USD 25 por año de dominios, más la red
  de calentamiento **(verificar)**.

## Fuentes

- Zapmail, exportar credenciales: <https://help.zapmail.ai/en/articles/10460716-how-to-export-mailbox-credentials-in-zapmail>
- Zapmail, preguntas frecuentes de buzones: <https://help.zapmail.ai/en/articles/9541207-faqs-mailbox-management-in-zapmail>
- Zapmail, precios (terceros): <https://getle.ad/blog/zapmail-pricing>, <https://www.inboxkit.com/learn/zapmail-pricing>
- Maildoso, precios (terceros): <https://getle.ad/blog/maildoso-pricing>, <https://www.inboxkit.com/learn/maildoso-pricing>
- Infraforge, precios (terceros): <https://getle.ad/blog/infraforge-pricing>, <https://www.inboxkit.com/learn/infraforge-pricing>, <https://outreach2day.com/vs/mailforge-vs-infraforge>
