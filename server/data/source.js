/**
 * Capa de fuente de datos. Prioridad:
 *   1) demo            (USE_DEMO_DATA=true)
 *   2) n8n webhooks    (N8N_WEBHOOK_CLIENTES + N8N_WEBHOOK_LLAMADAS)
 *   3) Supabase REST   (SUPABASE_URL + SUPABASE_SERVICE_KEY)
 *
 * Las respuestas se normalizan al shape interno, tolerando distintos nombres de
 * columnas (alias) para que enchufar n8n no obligue a renombrar nada en la BD.
 */

const demo = require('./demoData');

// ── Utilidades ──────────────────────────────────────────────────────────────
const num = (v) => {
  if (v == null || v === '') return 0;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const str = (v) => (v == null ? '' : String(v));

// Índice case-insensitive de las llaves del objeto (los webhooks reales usan
// Capitalización distinta: "Balance", "Telefono", etc.).
const lcIndex = (obj) => {
  const m = {};
  for (const k in obj) m[k.toLowerCase()] = obj[k];
  return m;
};

// Devuelve el primer valor presente entre varios alias de campo (case-insensitive).
const pick = (lc, ...keys) => {
  for (const k of keys) {
    const v = lc[k.toLowerCase()];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
};

// Teléfono canónico para el cruce: últimos 10 dígitos (RD sin código de país).
const phoneKey = (v) => String(v || '').replace(/\D/g, '').slice(-10);

// Normaliza intencion_pago a una de las 7 categorías canónicas, tolerando
// acentos, mayúsculas, espacios y sinónimos comunes del agente.
const INTENCION_CANON = new Set([
  'pago_inmediato', 'fecha_especifica', 'negociacion', 'proximo_corte', 'promesa_vaga', 'disputa', 'sin_intencion', 'no_contesta',
]);
const INTENCION_SINONIMOS = {
  pago_hoy: 'pago_inmediato', paga_hoy: 'pago_inmediato', inmediato: 'pago_inmediato',
  fecha: 'fecha_especifica', fecha_pago: 'fecha_especifica', promesa_fecha: 'fecha_especifica',
  negociar: 'negociacion', plan_pago: 'negociacion', plan: 'negociacion', acuerdo: 'negociacion', quita: 'negociacion',
  promesa: 'promesa_vaga', promesa_pago: 'promesa_vaga', promesa_de_pago: 'promesa_vaga', pronto: 'promesa_vaga',
  disputa_deuda: 'disputa', reclamo: 'disputa', objecion: 'disputa', aclaracion: 'disputa',
  sin_intencion_pago: 'sin_intencion', no_paga: 'sin_intencion', rechazo: 'sin_intencion', incobrable: 'sin_intencion', negativa: 'sin_intencion',
  no_contactado: 'no_contesta', buzon: 'no_contesta', no_responde: 'no_contesta', no_contesto: 'no_contesta', sin_respuesta: 'no_contesta', voicemail: 'no_contesta',
};
function normalizeIntencion(v) {
  if (!v) return 'no_contactado';
  const key = String(v).trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quita acentos
    .replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  if (INTENCION_CANON.has(key)) return key;
  if (INTENCION_SINONIMOS[key]) return INTENCION_SINONIMOS[key];
  return key || 'no_contactado'; // desconocido: se muestra tal cual, sin romper
}

// n8n a veces envuelve la salida. Aceptamos: [ ... ] | { data:[...] } |
// { clientes:[...] } | { results:[...] } | { json:{...} } | un solo objeto.
function toArray(payload, ...wrapKeys) {
  if (Array.isArray(payload)) return payload.map(unwrapItem);
  if (payload && typeof payload === 'object') {
    for (const k of ['data', 'results', 'rows', 'items', ...wrapKeys]) {
      if (Array.isArray(payload[k])) return payload[k].map(unwrapItem);
    }
    return [unwrapItem(payload)];
  }
  return [];
}
// n8n Respond-to-Webhook a veces manda { json: {...} } por item.
const unwrapItem = (it) => (it && typeof it === 'object' && it.json && typeof it.json === 'object' ? it.json : it);

// ── Normalización al shape interno ──────────────────────────────────────────
function normalizeCliente(r) {
  const lc = lcIndex(r);
  const codigo = pick(lc, 'codigo', 'code');
  return {
    id: pick(lc, 'id', 'cliente_id') ?? codigo ?? undefined,
    codigo: codigo != null ? str(codigo).trim() : '',
    phone: phoneKey(pick(lc, 'phone', 'telefono', 'celular', 'numero', 'phone_number')),
    name: str(pick(lc, 'name', 'nombre', 'cliente', 'razon_social')),
    empresa: codigo != null ? `Cód. ${str(codigo).trim()}` : str(pick(lc, 'empresa', 'company') || ''),
    deuda_total: num(pick(lc, 'deuda_total', 'saldo_total', 'balance_total', 'balance', 'deuda', 'total')),
    deuda_vencida: num(pick(lc, 'deuda_vencida', 'saldo_vencido', 'balance_vencido', 'vencido', 'overdue')),
    credito_ofrecido: num(pick(lc, 'credito_ofrecido', 'linea_credito', 'credit_limit', 'limite', 'credito')),
    dias_mora: num(pick(lc, 'dias_mora', 'dias_vencido', 'days_overdue', 'mora')),
    ultimo_pago: str(pick(lc, 'ultimo_pago', 'last_payment', 'fecha_ultimo_pago', 'fechahora') || ''),
    email: str(pick(lc, 'email', 'correo') || ''),
    // Fila original completa: conserva TODAS las columnas de la tabla (RNC,
    // FechaSync, etc.) aunque la UI no las muestre. Uso interno del backend
    // (Asistente IA); se elimina antes de mandar al navegador.
    _raw: r,
  };
}

function normalizeLlamada(r) {
  const lc = lcIndex(r);
  return {
    id: pick(lc, 'id', 'call_id') ?? undefined,
    created_at: str(pick(lc, 'created_at', 'fecha', 'timestamp', 'date') || ''),
    phone: phoneKey(pick(lc, 'phone', 'telefono', 'celular', 'numero', 'phone_number')),
    name: str(pick(lc, 'name', 'nombre', 'cliente') || ''),
    fecha_pago: str(pick(lc, 'fecha_pago', 'payment_date', 'promesa_fecha') || ''),
    intencion_pago: normalizeIntencion(pick(lc, 'intencion_pago', 'intencion', 'intent', 'payment_intent')),
    notas: str(pick(lc, 'notas', 'notes', 'resumen', 'summary') || ''),
    transcripcion: str(pick(lc, 'transcripcion', 'transcript', 'transcripcion_texto') || ''),
    grabacion: str(pick(lc, 'grabacion', 'recording', 'recording_url', 'audio_url') || ''),
    // Fila original completa (incluye columnas no mapeadas, p.ej. follow_up).
    _raw: r,
  };
}

// ── n8n ─────────────────────────────────────────────────────────────────────
async function callWebhook(url) {
  const method = (process.env.N8N_METHOD || 'POST').toUpperCase();
  const opts = { method, headers: { Accept: 'application/json' } };
  if (method === 'POST') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = '{}';
  }
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`webhook ${url} respondió ${res.status}`);
  const text = await res.text();
  if (!text.trim()) return [];
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`webhook ${url} no devolvió JSON: ${text.slice(0, 120)}`);
  }
}

async function fetchFromN8n() {
  const hasLlamadas = !!process.env.N8N_WEBHOOK_LLAMADAS;
  const [rawC, rawL] = await Promise.all([
    callWebhook(process.env.N8N_WEBHOOK_CLIENTES),
    hasLlamadas ? callWebhook(process.env.N8N_WEBHOOK_LLAMADAS) : Promise.resolve([]),
  ]);
  // Los clientes SIN teléfono se conservan: su deuda cuenta en los totales,
  // solo que no son llamables (no hay a quién marcar). El filtro anterior los
  // descartaba y su deuda desaparecía de la cartera.
  const clientes = toArray(rawC, 'clientes').map(normalizeCliente);
  const llamadas = toArray(rawL, 'llamadas').map(normalizeLlamada).filter((l) => l.phone);
  return { clientes, llamadas };
}

// ── Supabase ────────────────────────────────────────────────────────────────
async function fetchFromSupabase() {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const tClientes = process.env.SUPABASE_TABLE_CLIENTES || 'clientes';
  const tLlamadas = process.env.SUPABASE_TABLE_LLAMADAS || 'resultados_llamadas';
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  const [rc, rl] = await Promise.all([
    fetch(`${base}/rest/v1/${tClientes}?select=*`, { headers }),
    fetch(`${base}/rest/v1/${tLlamadas}?select=*`, { headers }),
  ]);
  if (!rc.ok || !rl.ok) throw new Error(`Supabase respondió ${rc.status}/${rl.status}`);
  return {
    clientes: (await rc.json()).map(normalizeCliente),
    llamadas: (await rl.json()).map(normalizeLlamada),
  };
}

// ── Selector ────────────────────────────────────────────────────────────────
async function getData() {
  const useDemo = (process.env.USE_DEMO_DATA ?? 'true') !== 'false';
  if (useDemo) {
    return { clientes: demo.clientes, llamadas: demo.llamadas, source: 'demo' };
  }
  if (process.env.N8N_WEBHOOK_CLIENTES) {
    return { ...(await fetchFromN8n()), source: 'n8n' };
  }
  if (process.env.SUPABASE_URL) {
    return { ...(await fetchFromSupabase()), source: 'supabase' };
  }
  // Sin fuente configurada -> demo como salvavidas.
  return { clientes: demo.clientes, llamadas: demo.llamadas, source: 'demo (sin fuente configurada)' };
}

module.exports = { getData, normalizeCliente, normalizeLlamada, toArray };
