/**
 * Agentes de voz de cobranzas. Lista fija (los agentes de Sword de cobranzas).
 *
 * El agente elegido en el panel de horario se guarda en la config de llamadas
 * y se manda como `agentId` en el webhook de salientes. No cambia la
 * asignación del número.
 *
 * Cada agente tiene un `tipo`:
 *   'cobranzas'    -> el agente principal (primera llamada de cobro)
 *   'seguimiento'  -> el follow up (llama a quien prometió pagar y no pagó)
 * Con el tipo se clasifica cada llamada registrada (ver tipoDeAgente).
 *
 * Si en el futuro cambian los agentes, edita AGENTS aquí o define AGENT_LIST en
 * el .env con formato: "id1:Nombre 1,id2:Nombre 2:seguimiento". El tercer
 * segmento (tipo) es opcional; si falta, se deduce del nombre.
 */

const TIPOS = new Set(['cobranzas', 'seguimiento']);

// IDs de Sword AI (los que espera el flujo de n8n `disparar-llamada`).
const AGENTS = [
  { id: 'cmrkqs0j90009f69lxz1scrwr', name: 'JH Cobranzas', tipo: 'cobranzas' },
  { id: 'cmrksxyke000bf69lt9nw4322', name: 'JH Cobranzas (Follow Up)', tipo: 'seguimiento' },
];

// Nombre con "follow up" / "seguimiento" => agente de seguimiento.
const PATRON_SEGUIMIENTO = /follow[\s_-]*up|seguimiento/i;
const tipoPorNombre = (name) => (PATRON_SEGUIMIENTO.test(String(name || '')) ? 'seguimiento' : 'cobranzas');

// Override opcional por env: "id:nombre[:tipo],id:nombre[:tipo]"
function fromEnv() {
  const raw = String(process.env.AGENT_LIST || '').trim();
  if (!raw) return null;
  const out = raw.split(',').map((p) => {
    const partes = p.split(':').map((s) => s.trim());
    const id = partes[0];
    let tipo = null;
    if (partes.length > 2 && TIPOS.has(partes[partes.length - 1].toLowerCase())) {
      tipo = partes.pop().toLowerCase();
    }
    const name = partes.slice(1).join(':') || id;
    return { id, name, tipo: tipo || tipoPorNombre(name) };
  }).filter((a) => a.id);
  return out.length ? out : null;
}

const catalogo = () => fromEnv() || AGENTS;

/**
 * Tipo del agente que hizo una llamada.
 * @returns {{ tipo: 'cobranzas'|'seguimiento', inferido: boolean }}
 *   inferido = true cuando la llamada no trae agente (registros anteriores a
 *   que se guardara): esas se cuentan como del agente principal.
 */
function tipoDeAgente(agentId, agentName) {
  const id = String(agentId || '').trim();
  if (!id) return { tipo: 'cobranzas', inferido: true };
  const conocido = catalogo().find((a) => a.id === id) || AGENTS.find((a) => a.id === id);
  if (conocido) return { tipo: conocido.tipo, inferido: false };
  return { tipo: tipoPorNombre(agentName), inferido: false };
}

async function list() {
  const agents = catalogo().map((a) => ({ ...a, connected: true, agentType: 'outbound' }));
  return { available: true, agents, phoneNumbers: [], source: 'fijo' };
}

module.exports = { list, tipoDeAgente, enabled: true, AGENTS };
