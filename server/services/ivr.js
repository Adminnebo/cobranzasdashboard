/**
 * Detección de IVR (contestadora / menú automático).
 *
 * Cuando una llamada cae en un IVR no hay a quién cobrarle: el cliente se marca
 * como `ivr` en cliente_config, se DESACTIVA (enabled=false) y queda excluido
 * del cron diario y de cualquier cola. Se puede reactivar a mano si consiguen
 * un mejor número.
 *
 * El dato llega en el RESUMEN de la llamada (campo `notas`). También se acepta
 * que el agente mande directamente intencion_pago = 'ivr'.
 */

const db = require('./supabaseDb');

const TABLE = 'cliente_config';

// Patrones que delatan un IVR / contestadora en el resumen o la transcripción.
const IVR_RE = new RegExp(
  [
    '\\bivr\\b',
    'contestador',
    'buz[oó]n',
    'men[uú]\\s*(de\\s*opciones|autom)',
    'grabaci[oó]n\\s*autom',
    'operadora?\\s*autom',
    'respuesta\\s*autom',
    'sistema\\s*autom',
    'marque\\s+(la\\s+)?(extensi[oó]n|opci[oó]n|n[uú]mero)',
    'presione\\s+\\d',
    'oprima\\s+\\d',
    'central\\s*telef[oó]nica',
    'no\\s*(contest[oó]|atendi[oó])\\s*una?\\s*persona',
    'm[aá]quina\\s*contestadora',
  ].join('|'),
  'i'
);

/** ¿Esta llamada cayó en un IVR? */
function esIVR(ll) {
  if (!ll) return false;
  if (String(ll.intencion_pago || '').toLowerCase() === 'ivr') return true;
  const texto = `${ll.notas || ''}\n${ll.transcripcion || ''}`;
  return IVR_RE.test(texto);
}

/** Extrae un fragmento del resumen como evidencia (para mostrar en el panel). */
function evidencia(ll) {
  const notas = String(ll.notas || '');
  const m = notas.match(IVR_RE);
  if (m) {
    const i = Math.max(0, notas.toLowerCase().indexOf(m[0].toLowerCase()) - 40);
    return notas.slice(i, i + 160).trim();
  }
  return (notas || '').slice(0, 160) || 'Detectado en la transcripción';
}

/** Teléfonos ya marcados como IVR. */
async function getIvrPhones() {
  const rows = await db.select(TABLE, '?select=phone&ivr=is.true');
  return new Set((rows || []).map((r) => String(r.phone)));
}

/** Map<phone, {ivr, ivr_at, ivr_detalle}> para el frontend. */
async function getIvrMap() {
  const rows = await db.select(TABLE, '?select=phone,ivr,ivr_at,ivr_detalle&ivr=is.true');
  const m = new Map();
  for (const r of rows || []) m.set(String(r.phone), { at: r.ivr_at, detalle: r.ivr_detalle });
  return m;
}

/**
 * Revisa las llamadas y marca como IVR (y desactiva) a los clientes que cayeron
 * en contestadora. Idempotente: no re-marca los que ya están.
 */
async function sincronizar(llamadas) {
  const detectados = llamadas.filter((ll) => ll.phone && esIVR(ll));
  if (!detectados.length) return { detectados: 0, nuevos: 0 };

  const yaMarcados = await getIvrPhones();

  // Última llamada IVR por teléfono (por si hay varias).
  const porTel = new Map();
  for (const ll of detectados) {
    if (yaMarcados.has(ll.phone)) continue;
    const prev = porTel.get(ll.phone);
    if (!prev || new Date(ll.created_at) > new Date(prev.created_at)) porTel.set(ll.phone, ll);
  }
  if (!porTel.size) return { detectados: detectados.length, nuevos: 0 };

  const rows = [...porTel.entries()].map(([phone, ll]) => ({
    phone,
    enabled: false,                       // <- se apaga: no se le llama más
    ivr: true,
    ivr_at: ll.created_at || new Date().toISOString(),
    ivr_detalle: evidencia(ll),
    updated_at: new Date().toISOString(),
    updated_by: 'sistema (IVR)',
  }));

  await db.upsert(TABLE, rows, 'phone');
  console.log(`[ivr] ${rows.length} cliente(s) marcados como IVR y desactivados`);
  return { detectados: detectados.length, nuevos: rows.length, phones: rows.map((r) => r.phone) };
}

/** Quita la marca de IVR (para reactivar a mano si consiguen otro número). */
async function desmarcar(phone) {
  await db.upsert(TABLE, {
    phone: String(phone),
    ivr: false,
    ivr_at: null,
    ivr_detalle: null,
    updated_at: new Date().toISOString(),
  }, 'phone');
  return { ok: true };
}

module.exports = { esIVR, sincronizar, getIvrPhones, getIvrMap, desmarcar };
