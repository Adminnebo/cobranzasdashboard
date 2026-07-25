/**
 * Agentes de voz disponibles (servicio de Sword AI).
 * Se consulta desde el servidor para que la API key NUNCA salga al navegador
 * y para evitar problemas de CORS.
 *
 * Config por env:
 *   AGENT_API_BASE   -> default https://app.swordaisolutions.com
 *   AGENT_CLIENT_ID  -> id de cliente de cobranzas
 *   AGENT_API_KEY    -> api key de ese cliente
 *
 * El agente elegido NO cambia la asignación del número: se guarda en la config
 * de llamadas (schedule) y se manda como `agentId` en el webhook de salientes.
 */

const BASE = String(process.env.AGENT_API_BASE || 'https://app.swordaisolutions.com').replace(/\/+$/, '');
const CLIENT_ID = String(process.env.AGENT_CLIENT_ID || '').trim();
const API_KEY = String(process.env.AGENT_API_KEY || '').trim();

// Lista blanca: como cotizaciones y cobranzas comparten la MISMA cuenta, aquí
// se limita qué agentes se ven en cobranzas. Acepta IDs exactos o nombres
// (coincidencia por texto, sin distinguir mayúsculas). Vacío = se muestran todos.
const ALLOW = String(process.env.AGENT_ALLOW || '').split(',').map(s => s.trim()).filter(Boolean);
const ALLOW_LC = ALLOW.map(s => s.toLowerCase());
function permitido(a) {
  if (!ALLOW.length) return true;
  const id = String(a.id || '');
  const name = String(a.name || '').toLowerCase();
  return ALLOW.includes(id) || ALLOW_LC.some(x => name.includes(x));
}

const enabled = !!(CLIENT_ID && API_KEY);

/** Lista de agentes + números. Devuelve { available, agents, phoneNumbers, error? }. */
async function list() {
  if (!enabled) {
    return { available: false, agents: [], phoneNumbers: [], error: 'Falta configurar AGENT_CLIENT_ID / AGENT_API_KEY' };
  }
  const url = `${BASE}/api/phone-switch/agents?clientId=${encodeURIComponent(CLIENT_ID)}&apiKey=${encodeURIComponent(API_KEY)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || j.success === false) {
    return {
      available: false, agents: [], phoneNumbers: [],
      error: (j && (j.error || j.message)) || `El servicio de agentes respondió ${res.status}`,
    };
  }
  return {
    available: true,
    agents: (j.agents || []).filter(permitido).map((a) => ({
      id: a.id,
      name: a.name || a.id,
      agentType: a.agentType || null,
      connected: !!a.connected,
    })),
    phoneNumbers: (j.phoneNumbers || []).map((p) => ({
      id: p.id,
      phoneNumber: p.phoneNumber || null,
      friendlyName: p.friendlyName || null,
      currentAgentId: p.currentAgentId || null,
      currentAgentName: p.currentAgentName || null,
    })),
  };
}

module.exports = { list, enabled };
