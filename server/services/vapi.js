/**
 * Consulta a VAPI cuántas llamadas hay activas en este momento, para respetar
 * el límite de concurrencia (máx. simultáneas) al vaciar la cola.
 *
 * Requiere VAPI_API_KEY (la privada). Sin ella, activeCalls() devuelve null y
 * la cola cae a modo "ritmo" (1 cada CALL_RATE_MS) como respaldo seguro.
 */

const VAPI_KEY = process.env.VAPI_API_KEY || '';
const BASE = process.env.VAPI_BASE_URL || 'https://api.vapi.ai';

const vapiEnabled = !!VAPI_KEY;

// Estados que cuentan como "llamada activa" (ocupando un cupo de concurrencia).
const ACTIVOS = new Set(['queued', 'ringing', 'in-progress', 'forwarding']);

/**
 * Nº de llamadas activas ahora mismo. Devuelve null si VAPI no está configurado
 * o si la consulta falla (para que el llamador decida el respaldo).
 */
async function activeCalls() {
  if (!vapiEnabled) return null;
  try {
    // Trae las llamadas más recientes; las activas son siempre las últimas.
    const res = await fetch(`${BASE}/call?limit=100`, {
      headers: { Authorization: `Bearer ${VAPI_KEY}` },
    });
    if (!res.ok) {
      console.error(`[vapi] activeCalls ${res.status}`);
      return null;
    }
    const list = await res.json();
    const arr = Array.isArray(list) ? list : (list.results || []);
    return arr.filter((c) => ACTIVOS.has(c.status)).length;
  } catch (err) {
    console.error('[vapi] activeCalls falló:', err.message);
    return null;
  }
}

module.exports = { activeCalls, vapiEnabled };
