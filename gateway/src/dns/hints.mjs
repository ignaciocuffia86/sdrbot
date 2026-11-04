// Qué hacer con cada aviso o error del chequeo de dominio.
//
// Un hint es { steps: [texto], record?: { type, host, fqdn, value }, links?: [{ label, url }] }.
// Cuando el arreglo se puede calcular, record trae el registro listo para copiar (por ejemplo
// el SPF con el "~all" agregado, o los dos SPF unificados en uno). Cuando depende del
// proveedor de correo, los pasos son los de ese proveedor, detectado por MX y SMTP.

const PROVIDERS = {
  google: {
    name: 'Google Workspace',
    mx: /(^|\.)(google|googlemail)\.com$/,
    smtp: /(^|\.)(gmail|google|googlemail)\.com$/,
    spfInclude: '_spf.google.com',
    links: {
      spf: 'https://support.google.com/a/answer/33786',
      dkim: 'https://support.google.com/a/answer/174124',
      dmarc: 'https://support.google.com/a/answer/2466580',
    },
    dkimSteps: [
      'Entrar a la consola de administración de Google (admin.google.com) → Apps → Google Workspace → Gmail → Autenticar correo electrónico.',
      'Elegir el dominio y tocar «Generar registro nuevo»: longitud de clave 2048 bits, prefijo «google».',
      'Publicar en el DNS el registro TXT que muestra la consola (nombre google._domainkey).',
      'Esperar a que propague (de minutos a unas horas), volver a la consola y tocar «Iniciar autenticación».',
    ],
    dkimRotate: 'En la consola de Google (Gmail → Autenticar correo electrónico) generar un registro nuevo de 2048 bits, publicarlo y tocar «Iniciar autenticación».',
    mxRecords: '1 smtp.google.com',
  },
  microsoft: {
    name: 'Microsoft 365',
    mx: /\.mail\.protection\.outlook\.com$/,
    smtp: /(^|\.)(office365|outlook)\.com$/,
    spfInclude: 'spf.protection.outlook.com',
    links: {
      spf: 'https://learn.microsoft.com/defender-office-365/email-authentication-spf-configure',
      dkim: 'https://learn.microsoft.com/defender-office-365/email-authentication-dkim-configure',
      dmarc: 'https://learn.microsoft.com/defender-office-365/email-authentication-dmarc-configure',
    },
    dkimSteps: [
      'Entrar al portal de Microsoft Defender (security.microsoft.com) → Correo electrónico y colaboración → Directivas y reglas → Directivas de amenazas → Configuración de autenticación de correo → DKIM.',
      'Elegir el dominio: el portal muestra dos registros CNAME, selector1._domainkey y selector2._domainkey, que apuntan a direcciones de onmicrosoft.com.',
      'Publicar los dos CNAME en el DNS del dominio, tal cual los muestra el portal.',
      'Volver al portal y activar «Firmar mensajes para este dominio con firmas DKIM».',
    ],
    dkimRotate: 'En el portal de Defender → DKIM, elegir el dominio y usar «Rotar claves DKIM» con 2048 bits: Microsoft publica la clave nueva por los mismos CNAME.',
    dkimType: 'CNAME',
    mxRecords: '0 <dominio-con-guiones>.mail.protection.outlook.com (el valor exacto está en el centro de administración de Microsoft 365 → Configuración → Dominios)',
  },
  zoho: {
    name: 'Zoho Mail',
    mx: /(^|\.)zoho(mail)?\.(com|eu|in|com\.au|jp)$/,
    smtp: /(^|\.)zoho(mail)?\./,
    spfInclude: 'zohomail.com',
    links: { dkim: 'https://www.zoho.com/mail/help/adminconsole/dkim-configuration.html' },
    dkimSteps: [
      'Entrar a la consola de administración de Zoho Mail → Dominios → el dominio → Configuración de correo → DKIM.',
      'Agregar un selector (por ejemplo «zmail») y copiar el registro TXT que genera.',
      'Publicarlo en el DNS, volver a Zoho y tocar «Verificar».',
      'Cargar el mismo selector acá, en «Selectores DKIM propios».',
    ],
    dkimRotate: 'En Zoho (Dominios → DKIM) agregar un selector nuevo con clave de 2048 bits, publicarlo, verificarlo, marcarlo como predeterminado y después borrar el viejo.',
    mxRecords: '10 mx.zoho.com · 20 mx2.zoho.com · 50 mx3.zoho.com',
  },
  hosting: {
    name: 'el hosting',
    links: { dkim: 'https://docs.cpanel.net/cpanel/email/email-deliverability/' },
    dkimSteps: [
      'cPanel: Correo electrónico → Entregabilidad del correo (Email Deliverability) → el dominio → «Reparar» o «Instalar el registro sugerido» en DKIM. Si el DNS lo maneja cPanel, lo publica solo; si el DNS está en otro lado (Cloudflare, el registrador), copiar el TXT default._domainkey que muestra y publicarlo ahí.',
      'Plesk: Sitios web y dominios → Correo → Configuración del correo → activar «Usar el sistema de protección contra spam DKIM».',
      'Otro hosting: pedirle a soporte que active la firma DKIM para el dominio y que pase el nombre del selector.',
      'Si el selector no es «default», cargarlo acá en «Selectores DKIM propios».',
    ],
    dkimRotate: 'Pedirle al hosting (o en cPanel, Email Deliverability) una clave nueva de 2048 bits; si el panel no deja elegir, pedirlo a soporte.',
    mxRecords: '10 mail.<dominio> (o el que indique el hosting)',
  },
};

export function detectProvider(mxHosts = [], smtpHosts = []) {
  const mx = mxHosts.map((h) => h.toLowerCase().replace(/\.$/, ''));
  const smtp = smtpHosts.map((h) => h.toLowerCase());
  for (const [id, p] of Object.entries(PROVIDERS)) {
    if (!p.mx) continue;
    if (mx.some((h) => p.mx.test(h)) || smtp.some((h) => p.smtp.test(h))) return { id, ...p };
  }
  return { id: 'hosting', ...PROVIDERS.hosting };
}

export function providerOfHost(host) {
  for (const [id, p] of Object.entries(PROVIDERS)) if (p.smtp?.test(host.toLowerCase())) return { id, ...p };
  return null;
}

const PUBLISH = (fqdn) => `Entrar al panel DNS del dominio (en el registrador, Cloudflare o el hosting: donde estén los registros MX) y crear o editar el registro de ${fqdn}.`;
const WAIT = 'Esperar a que propague (de minutos a unas horas) y volver a tocar «Verificar».';

const rec = (type, host, fqdn, value) => ({ type, host, fqdn, value });
const spfRec = (domain, value) => rec('TXT', '@', domain, value);
const dmarcRec = (domain, value) => rec('TXT', '_dmarc', `_dmarc.${domain}`, value);
const link = (p, kind) => (p.links?.[kind] ? [{ label: `Guía de ${p.id === 'hosting' ? 'cPanel' : p.name}`, url: p.links[kind] }] : []);

// ---------------------------------------------------------------- SPF

function spfTerms(record) { return record.trim().split(/\s+/).slice(1); }
const isAll = (t) => /^[+\-~?]?all$/i.test(t);
const withTerms = (terms) => `v=spf1 ${terms.join(' ')}`.trim();

// Inserta términos antes del "all" (o del redirect, o al final).
function insertBeforeAll(record, add) {
  const terms = spfTerms(record).filter((t) => !add.includes(t));
  const i = terms.findIndex((t) => isAll(t) || /^redirect=/i.test(t));
  if (i < 0) return withTerms([...terms, ...add]);
  return withTerms([...terms.slice(0, i), ...add, ...terms.slice(i)]);
}

export const spfHints = {
  missing(domain, provider, smtpIps) {
    const value = provider.spfInclude
      ? `v=spf1 include:${provider.spfInclude} ~all`
      : `v=spf1 a mx${smtpIps.map((ip) => ` ${ip.includes(':') ? 'ip6' : 'ip4'}:${ip}`).join('')} ~all`;
    return {
      steps: [
        PUBLISH(domain),
        `Crear un registro TXT con nombre «@» y este valor (armado para ${provider.name}).`,
        'Si además mandan mails desde otros servicios (Mailchimp, HubSpot, el CRM, la web), sumar su include antes del «~all»: cada servicio lo indica en su ayuda.',
        WAIT,
      ],
      record: spfRec(domain, value),
      links: link(provider, 'spf'),
    };
  },
  multiple(domain, records) {
    // "-all" sólo si todos lo tenían: unificar no tiene que endurecer lo que ya se aceptaba.
    const terms = [];
    let strict = true;
    let redirect = null;
    for (const r of records) {
      if (!spfTerms(r).some((t) => /^-all$/i.test(t))) strict = false;
      for (const t of spfTerms(r)) {
        if (isAll(t)) continue;
        if (/^redirect=/i.test(t)) { redirect ??= t; continue; }
        if (!terms.includes(t)) terms.push(t);
      }
    }
    const value = withTerms([...terms, redirect && !terms.length ? redirect : (strict ? '-all' : '~all')].filter(Boolean));
    return {
      steps: [
        PUBLISH(domain),
        `Borrar los ${records.length} registros TXT que empiezan con «v=spf1».`,
        'Crear uno solo con todo unificado (este valor junta lo que tenían; termina en «-all» sólo si todos lo tenían).',
        'Revisar que siga por debajo de 10 consultas DNS: al unificar puede pasarse.',
        WAIT,
      ],
      record: spfRec(domain, value),
    };
  },
  noAll(domain, record) {
    return { steps: [PUBLISH(domain), 'Agregar «~all» al final del registro SPF.', WAIT], record: spfRec(domain, `${record.trim()} ~all`) };
  },
  weakAll(domain, record) {
    const value = withTerms(spfTerms(record).map((t) => (isAll(t) ? '~all' : t)));
    return {
      steps: [PUBLISH(domain), 'Cambiar el final del registro SPF por «~all» (marca como sospechoso lo que no esté listado). Cuando todo lo legítimo esté incluido, se puede pasar a «-all».', WAIT],
      record: spfRec(domain, value),
    };
  },
  invalid(domain, record, invalid) {
    const value = withTerms(spfTerms(record).filter((t) => !invalid.includes(t)));
    return {
      steps: [
        PUBLISH(domain),
        `Corregir o sacar: ${invalid.map((t) => `«${t}»`).join(', ')}. Errores típicos: un espacio de más («ip4: 1.2.3.4»), «include» sin dominio, comas en vez de espacios.`,
        'Este valor es el mismo registro sin esos términos; si alguno era necesario, corregirlo en vez de sacarlo.',
        WAIT,
      ],
      record: spfRec(domain, value),
    };
  },
  broken(domain, record, broken) {
    const value = withTerms(spfTerms(record).filter((t) => !broken.some((b) => t.toLowerCase() === `include:${b}` || t.toLowerCase() === `+include:${b}`)));
    return {
      steps: [
        PUBLISH(domain),
        `Revisar ${broken.join(', ')}: si está mal escrito, corregirlo con el que indica el servicio; si es de un servicio que ya no usan, sacarlo.`,
        'Un include roto invalida el SPF entero para los receptores estrictos.',
        WAIT,
      ],
      record: spfRec(domain, value),
    };
  },
  loop(domain) {
    return { steps: [PUBLISH(domain), 'Algún include termina apuntando de nuevo al propio dominio: sacar el include que lo cierra.', WAIT] };
  },
  tooManyLookups(domain, lookups, breakdown) {
    const top = [...breakdown].sort((a, b) => b.lookups - a.lookups).map((b) => `«${b.term}»: ${b.lookups}`).join(' · ');
    return {
      steps: [
        `Consultas por término: ${top}.`,
        'Sacar los include de servicios que ya no se usan para mandar mail (es lo más común: proveedores viejos que quedaron).',
        'Reemplazar «a» y «mx» por las IPs fijas con «ip4:…»: no consumen consultas.',
        `Bajar a 10 o menos (hoy son ${lookups}). Si todos son necesarios, mandar lo masivo desde un subdominio con su propio SPF, o usar un servicio de «SPF flattening».`,
        WAIT,
      ],
    };
  },
  ptr(domain, record) {
    const value = withTerms(spfTerms(record).filter((t) => !/^[+\-~?]?ptr(:|$)/i.test(t)));
    return { steps: [PUBLISH(domain), 'Sacar «ptr» y, si autorizaba un servidor propio, poner su IP con «ip4:…».', WAIT], record: spfRec(domain, value) };
  },
  smtpProviderMissing(domain, record, host, provider) {
    return {
      steps: [
        `El buzón manda por ${provider.name} (${host}), pero el SPF no incluye a ${provider.name}.`,
        PUBLISH(domain),
        `Agregar «include:${provider.spfInclude}» antes del «all».`,
        WAIT,
      ],
      record: spfRec(domain, insertBeforeAll(record, [`include:${provider.spfInclude}`])),
      links: link(provider, 'spf'),
    };
  },
  smtpIpMissing(domain, record, host, ips) {
    const terms = ips.map((ip) => `${ip.includes(':') ? 'ip6' : 'ip4'}:${ip}`);
    return {
      steps: [
        `El buzón manda por ${host} y su IP no está autorizada: los receptores lo ven como no autorizado.`,
        `Primero preguntarle al hosting qué incluir: muchos dan un «include:» propio (por ejemplo «include:spf.<hosting>»), que es mejor que la IP porque sigue funcionando si la cambian.`,
        'Si no tienen, agregar la IP antes del «all» (este valor ya la tiene).',
        WAIT,
      ],
      record: spfRec(domain, insertBeforeAll(record, terms)),
    };
  },
  temp() {
    return { steps: ['Volver a tocar «Verificar» en unos minutos.', 'Si sigue fallando, revisar el estado del proveedor de DNS del dominio: puede estar caído o mal delegado.'] };
  },
};

// ---------------------------------------------------------------- DMARC

function serializeDmarc(tags) {
  const order = ['v', 'p', 'sp', 'pct', 'rua', 'ruf', 'fo', 'adkim', 'aspf', 'ri', 'rf'];
  const keys = [...order.filter((k) => tags[k] !== undefined), ...Object.keys(tags).filter((k) => !order.includes(k))];
  return keys.map((k) => `${k}=${tags[k]}`).join('; ');
}

const DMARC_RAMP = 'El camino habitual: p=none 2 a 4 semanas mirando los reportes → p=quarantine → p=reject.';

export const dmarcHints = {
  missing(domain, provider) {
    return {
      steps: [
        'Crear un buzón (o alias) dmarc@ en el dominio para recibir los reportes, o usar la dirección de un servicio gratuito que los resume (Postmark DMARC, dmarcian, Valimail Monitor).',
        PUBLISH(`_dmarc.${domain}`),
        'Crear un registro TXT con nombre «_dmarc» y este valor. Empieza en «p=none»: sólo mide, no frena nada, así que no hay riesgo de que se pierdan mails propios.',
        DMARC_RAMP,
        WAIT,
      ],
      record: dmarcRec(domain, `v=DMARC1; p=none; rua=mailto:dmarc@${domain}; fo=1`),
      links: link(provider, 'dmarc'),
    };
  },
  duplicate(domain, records) {
    return {
      steps: [
        PUBLISH(`_dmarc.${domain}`),
        `Hay ${records.length} registros TXT en _dmarc. Borrar todos menos uno: con dos, los receptores no aplican ninguno.`,
        'Este es el primero que aparece; si el bueno es otro, dejar ese.',
        WAIT,
      ],
      record: dmarcRec(domain, records[0]),
    };
  },
  noPolicy(at, tags) {
    return {
      steps: [PUBLISH(`_dmarc.${at}`), 'Agregar la política «p=none» justo después de «v=DMARC1» (o quarantine/reject si ya miraron los reportes).', WAIT],
      record: dmarcRec(at, serializeDmarc({ ...tags, v: 'DMARC1', p: 'none' })),
    };
  },
  // El valor sugerido conserva las etiquetas del registro y suma rua si falta: así este
  // consejo y el de los reportes no se pisan, se aplique el que se aplique último.
  monitorOnly(at, tags, { spfOk, dkimOk }) {
    const ready = spfOk && dkimOk;
    const steps = [];
    if (!tags.rua) {
      steps.push('Primero sumar los reportes (el aviso de «rua», acá abajo) y mirarlos de dos a cuatro semanas: sin reportes no hay forma de saber si subir la política deja afuera mails propios.');
    } else {
      steps.push('Mirar los reportes (rua) de al menos dos semanas: todo lo que mande el dominio legítimamente tiene que pasar SPF o DKIM.');
    }
    steps.push(ready
      ? 'SPF y DKIM están bien, así que el dominio está listo para subirla cuando los reportes estén limpios.'
      : `Antes de subirla, arreglar ${[!spfOk && 'SPF', !dkimOk && 'DKIM'].filter(Boolean).join(' y ')}: con «quarantine», los mails propios que fallen van a spam.`);
    steps.push(PUBLISH(`_dmarc.${at}`),
      `Cambiar «p=none» por «p=quarantine» (este valor${tags.rua ? '' : ', que ya incluye los reportes'}). Unas semanas después, si los reportes siguen limpios, «p=reject».`,
      WAIT);
    return { steps, record: dmarcRec(at, serializeDmarc({ ...tags, p: 'quarantine', rua: tags.rua ?? `mailto:dmarc@${at}` })) };
  },
  pct(at, tags) {
    const { pct: _p, ...rest } = tags;
    return {
      steps: [PUBLISH(`_dmarc.${at}`), 'Sacar «pct» (vale 100 por defecto) cuando los reportes estén limpios: hoy la política se aplica sólo a una parte de los mails.', WAIT],
      record: dmarcRec(at, serializeDmarc(rest)),
    };
  },
  noRua(at, tags) {
    return {
      steps: [
        'Crear un buzón o alias dmarc@ en el dominio, o usar la dirección de un servicio que resume los reportes (Postmark DMARC, dmarcian, Valimail Monitor).',
        PUBLISH(`_dmarc.${at}`),
        `Agregar «rua=mailto:…» con esa dirección (este valor usa dmarc@${at}: la casilla tiene que existir, si no los reportes rebotan). La política queda como está.`,
        WAIT,
      ],
      record: dmarcRec(at, serializeDmarc({ ...tags, rua: `mailto:dmarc@${at}` })),
    };
  },
  temp: () => spfHints.temp(),
};

// ---------------------------------------------------------------- DKIM

export const dkimHints = {
  missing(domain, provider) {
    return {
      steps: [
        `Activar la firma DKIM en ${provider.name}:`,
        ...provider.dkimSteps,
        'Después, volver a tocar «Verificar».',
      ],
      links: link(provider, 'dkim'),
    };
  },
  notPublished(domain, selector, provider) {
    return {
      steps: [
        `Los mails salen firmados con el selector «${selector}», pero la clave pública no está en el DNS: el receptor no puede validar la firma y DKIM falla.`,
        `Copiar el registro de la clave desde ${provider.name} (donde se activó DKIM) y publicarlo con nombre «${selector}._domainkey».`,
        ...(provider.id === 'hosting' ? ['En cPanel: Correo electrónico → Entregabilidad del correo → el dominio → muestra el registro DKIM a publicar.'] : []),
        WAIT,
      ],
      record: rec(provider.dkimType ?? 'TXT', `${selector}._domainkey`, `${selector}._domainkey.${domain}`, null),
      links: link(provider, 'dkim'),
    };
  },
  configuredMissing(domain, selector) {
    return {
      steps: [
        `No existe ${selector}._domainkey.${domain}. Revisar que el selector esté bien escrito: va sólo el nombre, sin «._domainkey» ni el dominio.`,
        'Si no es el que usa el proveedor, sacarlo de «Selectores DKIM propios».',
      ],
    };
  },
  revoked(domain, selector, provider, otherValid) {
    return {
      steps: otherValid
        ? [`Es normal si «${selector}» es un selector viejo que se dio de baja a propósito: hay otra clave válida. Si nadie firma con él, se puede borrar el registro ${selector}._domainkey o ignorar este aviso.`]
        : [`La clave de «${selector}» está dada de baja y no hay otra válida. Hay que generar una nueva:`, ...provider.dkimSteps],
      links: link(provider, 'dkim'),
    };
  },
  unreadable(domain, selector) {
    return {
      steps: [
        `Volver a copiar el valor completo del registro ${selector}._domainkey desde el proveedor.`,
        'Las claves de 2048 bits pasan de 255 caracteres: el TXT va partido en varias cadenas entre comillas dentro del mismo registro. Muchos paneles lo hacen solos; si no, pegar el valor en dos partes.',
        'Sin saltos de línea, espacios ni comillas sueltas dentro de «p=».',
        WAIT,
      ],
    };
  },
  // Una clave corta sólo importa si los mails firman con ella. Si hay otra fuerte publicada y
  // no se sabe cuál usa el servidor, lo primero es averiguarlo: puede ser una clave vieja.
  weakKey(domain, selector, provider, { strongOthers = [], detected = [] } = {}) {
    const rotate = [
      provider.dkimRotate,
      'Lo seguro es publicar la clave nueva con un selector nuevo, pasar la firma a ese selector y recién unos días después borrar el viejo: así ningún mail en tránsito queda sin validar.',
      WAIT,
    ];
    if (detected.includes(selector)) {
      return { steps: [`Los mails del dominio salen firmados con «${selector}», así que conviene cambiarla:`, ...rotate], links: link(provider, 'dkim') };
    }
    if (detected.length) {
      return {
        steps: [
          `Los mails salen firmados con ${detected.map((x) => `«${x}»`).join(', ')}, no con «${selector}»: esta clave no se usa.`,
          `Se puede borrar el registro ${selector}._domainkey.${domain} del DNS (o dejarlo: no afecta la entrega).`,
        ],
      };
    }
    if (strongOthers.length) {
      return {
        steps: [
          `También está publicada ${strongOthers.map((x) => `«${x}»`).join(', ')} con 2048 bits. Lo primero es saber con cuál firma el servidor: si no es con «${selector}», no hay nada que arreglar.`,
          'Para saberlo: mandar un mail desde el buzón a una cuenta de Gmail, abrirlo, menú ⋮ → «Mostrar original». Arriba dice «DKIM: PASS con el dominio …», y en la cabecera DKIM-Signature el selector es lo que sigue a «s=».',
          `Si firma con ${strongOthers.map((x) => `«${x}»`).join(' o ')}: «${selector}» es una clave vieja; se puede borrar ${selector}._domainkey o ignorar este aviso.`,
          `Si firma con «${selector}»: ${provider.dkimRotate}`,
        ],
        links: link(provider, 'dkim'),
      };
    }
    return { steps: rotate, links: link(provider, 'dkim') };
  },
  foreign(domain, foreign, provider) {
    return {
      steps: [
        `Hoy los mails los firma ${foreign.join(', ')} en vez de ${domain}. Para DMARC sólo cuenta la firma del propio dominio.`,
        `Activar DKIM con el dominio propio en ${provider.name}:`,
        ...provider.dkimSteps,
      ],
      links: link(provider, 'dkim'),
    };
  },
  temp: () => spfHints.temp(),
};

// ---------------------------------------------------------------- MX y dominio

export const mxHints = {
  missing(domain, provider) {
    return {
      steps: [
        PUBLISH(domain),
        `Crear los registros MX de ${provider.name}: ${provider.mxRecords.replace('<dominio>', domain).replace('<dominio-con-guiones>', domain.replace(/\./g, '-'))}.`,
        'Sin MX, las respuestas de los prospectos rebotan.',
        WAIT,
      ],
    };
  },
  temp: () => spfHints.temp(),
};

export function unresolvableHint(domain) {
  return {
    steps: [
      `Revisar que el dominio esté bien escrito en el email de los buzones (${domain}).`,
      'Volver a tocar «Verificar» en unos minutos: puede ser una falla momentánea del DNS.',
      'Si sigue igual, revisar con el registrador que el dominio esté activo (no vencido) y con los servidores DNS bien delegados.',
    ],
  };
}
