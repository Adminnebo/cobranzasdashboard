/**
 * Agentes de voz disponibles para cobranzas.
 *
 * Fuente PRIMARIA: VAPI (los assistants). Ahí viven los agentes reales de
 * cobranzas ("JH Cobranzas", "JH Cobranzas (Follow Up)"). El phone-switch de
 * Sword AI solo lista los agentes importados de cotizaciones, por eso no
 * mostraba los de cobranzas.
 *
 * Filtro por nombre: AGENT_ALLOW (coma-separado, coincidencia por texto o ID).
 * Por defecto "cobranza" -> solo se muestran los agentes de cobranzas.
 *
 * El agente elegido NO cambia la asignación del número: se guarda en la config
 * de llamadas (schedule) y se manda como `agentId` en el webhook de salientes.
 */

const VAPI_KEY = process.env.VAPI_API_KEY || '';
const VAPI_BASE = process.env.VAPI_BASE_URL || 'https://api.vapi.ai';

// Fallback opcional: phone-switch de Sword AI (config anterior).
const SW_BASE = String(process.env.AGENT_API_BASE || 'https://app.swordaisolutions.com').replace(/\/+$/, '');
const SW_CLIENT_ID = String(process.env.AGENT_CLIENT_ID || '').trim();
const SW_API_KEY = String(process.env.AGENT_API_KEY || '').trim();

const ALLOW = String(process.env.AGENT_ALLOW || 'cobranza')
  .split(',').map((s) => s.trim()).filter(Boolean);
const ALLOW_LC = ALLOW.map((s) => s.toLowerCase());

function permitido(a) {
  if (!ALLOW.length) return true;
  const id = String(a.id || '');
  const name = String(a.name || '').toLowerCase();
  return ALLOW.includes(id) || ALLOW_LC.some((x) => name.includes(x));
}

// Limpia el sufijo "(Imported)" del nombre.
const limpiaNombre = (n) => String(n || '').replace(/\s*\(imported\)\s*$/i, '').trim();

async function listFromVapi() {
  const res = await fetch(`${VAPI_BASE}/assistant?limit=100`, {
    headers: { Authorization: `Bearer ${VAPI_KEY}` },
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j) {
    return { available: false, agents: [], phoneNumbers: [], error: (j && j.message) || `VAPI respondió ${res.status}` };
  }
  const arr = Array.isArray(j) ? j : (j.results || []);
  const agents = arr
    .map((a) => ({ id: a.id, name: limpiaNombre(a.name || a.id), agentType: null, connected: true }))
    .filter(permitido)
    .sort((a, b) => (a.name > b.name ? 1 : -1));
  return { available: true, agents, phoneNumbers: [], source: 'vapi' };
}

async function listFromSwordAI() {
  const url = `${SW_BASE}/api/phone-switch/agents?clientId=${encodeURIComponent(SW_CLIENT_ID)}&apiKey=${encodeURIComponent(SW_API_KEY)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j || j.success === false) {
    return { available: false, agents: [], phoneNumbers: [], error: (j && (j.error || j.message)) || `El servicio de agentes respondió ${res.status}` };
  }
  return {
    available: true,
    source: 'sword-ai',
    agents: (j.agents || []).map((a) => ({ id: a.id, name: limpiaNombre(a.name || a.id), agentType: a.agentType || null, connected: !!a.connected })).filter(permitido),
    phoneNumbers: (j.phoneNumbers || []).map((p) => ({ id: p.id, phoneNumber: p.phoneNumber || null, friendlyName: p.friendlyName || null, currentAgentId: p.currentAgentId || null, currentAgentName: p.currentAgentName || null })),
  };
}

const enabled = !!(VAPI_KEY || (SW_CLIENT_ID && SW_API_KEY));

async function list() {
  try {
    if (VAPI_KEY) return await listFromVapi();
    if (SW_CLIENT_ID && SW_API_KEY) return await listFromSwordAI();
    return { available: false, agents: [], phoneNumbers: [], error: 'Falta VAPI_API_KEY (o AGENT_CLIENT_ID / AGENT_API_KEY)' };
  } catch (err) {
    return { available: false, agents: [], phoneNumbers: [], error: err.message };
  }
}

module.exports = { list, enabled };
