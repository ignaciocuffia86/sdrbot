// Adaptador de HubSpot para la carga en el CRM (docs/23). Sólo HTTP: qué escribir y cuándo lo
// decide src/sdr/crm.mjs. Usa el token de una app privada del portal del cliente
// (Authorization: Bearer) contra la API v3/v4 de HubSpot.
//
// Cada error vuelve como CrmError con un tipo que dice qué hacer con la carga:
//   credencial  401: el token no sirve. Se pausa la conexión hasta que la reconecten.
//   permisos    403: a la app privada le falta un scope. Ídem.
//   limite      429: reintentar más tarde.
//   caido       5xx o sin respuesta: reintentar más tarde.
//   rechazo     400/422: el dato no entra (propiedad o valor que no existen). La carga se bloquea.
//   conflicto   409: el contacto ya existe (HubSpot dice cuál, en existe_id).
//   no_existe   404.
//   tiempo      se terminó el tiempo de esta vuelta del reloj antes de pedir (con `hasta`).

const base = () => (process.env.MAILGW_HUBSPOT_URL || 'https://api.hubapi.com').replace(/\/+$/, '');

// Tipos de asociación definidos por HubSpot (HUBSPOT_DEFINED).
export const ASOC = { notaContacto: 202, notaEmpresa: 190, tareaContacto: 204, tareaEmpresa: 192 };

export class CrmError extends Error {
  constructor(tipo, message, extra = {}) {
    super(message);
    this.tipo = tipo;
    Object.assign(this, extra);
  }
}

function errorDe(status, json, texto) {
  const msg = (json?.message ?? texto ?? '').toString().replace(/\s+/g, ' ').slice(0, 400) || `HTTP ${status}`;
  if (status === 401) return new CrmError('credencial', 'HubSpot rechazó el token: hay que cargar uno válido en el panel (Canales → CRM).');
  if (status === 403) {
    return new CrmError('permisos', `A la app privada de HubSpot le falta un permiso: ${msg}. Sumarlo en HubSpot (Settings → ` +
      'Integrations → Private Apps → Scopes) y probar la conexión otra vez.');
  }
  if (status === 429) return new CrmError('limite', 'HubSpot pidió bajar el ritmo (límite de pedidos).');
  if (status === 409) {
    const existe = /Existing ID:\s*(\d+)/i.exec(msg)?.[1] ?? null;
    return new CrmError('conflicto', `HubSpot dice que ya existe: ${msg}`, { existe_id: existe });
  }
  if (status === 404) return new CrmError('no_existe', `HubSpot no lo encontró: ${msg}`);
  if (status >= 500) return new CrmError('caido', `HubSpot no respondió bien (HTTP ${status}): ${msg}`);
  return new CrmError('rechazo', `HubSpot rechazó el dato (HTTP ${status}): ${msg}`);
}

// Con `hasta` (un instante en ms), ningún pedido pasa de ese límite: el reloj tiene un tiempo
// fijo por vuelta y una carga lenta no puede comerse el de la lectura de los buzones.
export function cliente(token, { fetchImpl = fetch, hasta = Infinity } = {}) {
  async function api(method, path, body) {
    const queda = hasta - Date.now();
    if (queda < 1_000) throw new CrmError('tiempo', 'Se terminó el tiempo de esta vuelta: la carga sigue en la próxima.');
    const plazo = Math.min(20_000, queda);
    let res;
    try {
      res = await fetchImpl(`${base()}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(plazo),
      });
    } catch (e) {
      if (e.name === 'TimeoutError' && plazo < 20_000) {
        throw new CrmError('tiempo', 'Se terminó el tiempo de esta vuelta esperando a HubSpot: la carga sigue en la próxima.');
      }
      throw new CrmError('caido', e.name === 'TimeoutError' ? 'HubSpot no contestó en 20 segundos.' : `No se pudo llegar a HubSpot: ${e.message}`);
    }
    const texto = await res.text();
    let json = null;
    try { json = texto ? JSON.parse(texto) : null; } catch { json = null; }
    if (!res.ok) throw errorDe(res.status, json, texto);
    return json;
  }

  const buscar = async (objeto, propiedad, valor, properties) => {
    const r = await api('POST', `/crm/v3/objects/${objeto}/search`, {
      filterGroups: [{ filters: [{ propertyName: propiedad, operator: 'EQ', value: valor }] }],
      properties, sorts: [{ propertyName: 'createdate', direction: 'DESCENDING' }], limit: 10,
    });
    return r?.results ?? [];
  };
  const asociar = (para, tipo) => ({ to: { id: String(para) }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: tipo }] });

  return {
    cuenta: () => api('GET', '/account-info/v3/details'),
    duenos: async () => {
      const out = [];
      let after;
      for (let i = 0; i < 5; i++) {
        const r = await api('GET', `/crm/v3/owners?limit=100&archived=false${after ? `&after=${encodeURIComponent(after)}` : ''}`);
        out.push(...(r?.results ?? []));
        after = r?.paging?.next?.after;
        if (!after) break;
      }
      return out;
    },
    propiedadesContacto: async () => (await api('GET', '/crm/v3/properties/contacts'))?.results ?? [],
    buscarContactos: (email, properties) => buscar('contacts', 'email', email, properties),
    leerContacto: (id, properties) => api('GET', `/crm/v3/objects/contacts/${encodeURIComponent(id)}?properties=${properties.map(encodeURIComponent).join(',')}`),
    crearContacto: (properties) => api('POST', '/crm/v3/objects/contacts', { properties }),
    actualizarContacto: (id, properties) => api('PATCH', `/crm/v3/objects/contacts/${encodeURIComponent(id)}`, { properties }),
    buscarEmpresas: (dominio) => buscar('companies', 'domain', dominio, ['name', 'domain']),
    crearEmpresa: (properties) => api('POST', '/crm/v3/objects/companies', { properties }),
    asociarContactoEmpresa: (contacto, empresa) =>
      api('PUT', `/crm/v4/objects/contact/${encodeURIComponent(contacto)}/associations/default/company/${encodeURIComponent(empresa)}`),
    crearNota: (properties, contacto, empresa) => api('POST', '/crm/v3/objects/notes', {
      properties, associations: [asociar(contacto, ASOC.notaContacto), ...(empresa ? [asociar(empresa, ASOC.notaEmpresa)] : [])],
    }),
    crearTarea: (properties, contacto, empresa) => api('POST', '/crm/v3/objects/tasks', {
      properties, associations: [asociar(contacto, ASOC.tareaContacto), ...(empresa ? [asociar(empresa, ASOC.tareaEmpresa)] : [])],
    }),
  };
}

export const urlContacto = (portalId, contactoId) =>
  (portalId && contactoId ? `https://app.hubspot.com/contacts/${portalId}/record/0-1/${contactoId}` : null);
