/**
 * Agentes de voz de cobranzas. Lista fija (los assistants de VAPI de cobranzas).
 *
 * El agente elegido en el panel de horario se guarda en la config de llamadas
 * y se manda como `agentId` (= assistantId de VAPI) en el webhook de salientes.
 * No cambia la asignación del número.
 *
 * Si en el futuro cambian los agentes, edita AGENTS aquí o define AGENT_LIST en
 * el .env con formato: "id1:Nombre 1,id2:Nombre 2".
 */

// IDs de Sword AI (los que espera el flujo de n8n `disparar-llamada`).
const AGENTS = [
  { id: 'cmrkqs0j90009f69lxz1scrwr', name: 'JH Cobranzas' },
  { id: 'cmrksxyke000bf69lt9nw4322', name: 'JH Cobranzas (Follow Up)' },
];

// Override opcional por env: "id:nombre,id:nombre"
function fromEnv() {
  const raw = String(process.env.AGENT_LIST || '').trim();
  if (!raw) return null;
  const out = raw.split(',').map((p) => {
    const i = p.indexOf(':');
    const id = (i === -1 ? p : p.slice(0, i)).trim();
    const name = (i === -1 ? p : p.slice(i + 1)).trim() || id;
    return { id, name };
  }).filter((a) => a.id);
  return out.length ? out : null;
}

async function list() {
  const agents = (fromEnv() || AGENTS).map((a) => ({ ...a, connected: true, agentType: 'outbound' }));
  return { available: true, agents, phoneNumbers: [], source: 'fijo' };
}

module.exports = { list, enabled: true, AGENTS };
