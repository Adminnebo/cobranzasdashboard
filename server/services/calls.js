/**
 * Disparo de llamadas del agente de cobranzas vía n8n.
 *
 * 3 orígenes: 'cron' (diario 10:00 a los enabled), 'manual' (un cliente),
 * 'bulk' (varios seleccionados).
 *
 * Ritmo: SECUENCIAL con pausa (CALL_DELAY_MS) para no saturar al agente/telefonía.
 * Cada intento se registra en la tabla llamada_disparo de Supabase.
 *
 * Config por env:
 *   N8N_CALL_URL      -> endpoint que dispara la llamada (webhook o API de n8n)
 *   N8N_CALL_METHOD   -> POST (default)
 *   N8N_API_KEY       -> se manda como X-N8N-API-KEY (si está definido)
 *   CALL_DELAY_MS     -> pausa entre llamadas (default 5000 ms)
 *   CALL_MAX_BATCH    -> tope de llamadas por disparo (default 200, guarda-rail)
 */

const db = require('./supabaseDb');

const CALL_URL = process.env.N8N_CALL_URL || '';
const CALL_METHOD = (process.env.N8N_CALL_METHOD || 'POST').toUpperCase();
const N8N_API_KEY = process.env.N8N_API_KEY || '';
const DELAY_MS = parseInt(process.env.CALL_DELAY_MS || '5000', 10);
const MAX_BATCH = parseInt(process.env.CALL_MAX_BATCH || '200', 10);

const callsEnabled = !!CALL_URL;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Teléfono en E.164 con código de país (+1 para RD/NANP).
 * Internamente guardamos 10 dígitos; el agente lo necesita con el +1.
 */
function toE164(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (!d) return '';
  return d.length === 10 ? `+1${d}` : `+${d}`;
}

/**
 * Payload que se manda al agente por cada cliente.
 * Ajustar aquí si el webhook espera otros nombres de campo.
 */
function buildPayload(c) {
  return {
    phone: toE164(c.phone),
    deuda_total: c.deuda_total,
    deuda_vencida: c.deuda_vencida,
    // Extras por si el agente los usa (no estorban si los ignora):
    nombre: c.name,
    empresa: c.empresa,
    credito_ofrecido: c.credito_ofrecido,
  };
}

function callHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (N8N_API_KEY) h['X-N8N-API-KEY'] = N8N_API_KEY;
  return h;
}

/** Dispara UNA llamada. Devuelve { ok, detalle }. */
async function triggerOne(cliente) {
  if (!callsEnabled) throw new Error('Llamadas no configuradas (falta N8N_CALL_URL)');
  const res = await fetch(CALL_URL, {
    method: CALL_METHOD,
    headers: callHeaders(),
    body: CALL_METHOD === 'GET' ? undefined : JSON.stringify(buildPayload(cliente)),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`n8n ${res.status}: ${text.slice(0, 200)}`);
  return { ok: true, detalle: text.slice(0, 500) };
}

/** Registra el intento en Supabase (nunca rompe el flujo si falla el log). */
async function log(row) {
  try { await db.insert('llamada_disparo', row); }
  catch (e) { console.error('[calls] log falló:', e.message); }
}

/**
 * Dispara llamadas SECUENCIALMENTE con pausa entre cada una.
 * @param {Array} clientes  clientes completos (con phone, name, deudas...)
 * @param {string} origen   'cron' | 'manual' | 'bulk'
 * @param {string} por      email del usuario que disparó (null si es el cron)
 */
async function triggerBatch(clientes, origen = 'manual', por = null) {
  const lista = clientes.slice(0, MAX_BATCH);
  const truncado = clientes.length > MAX_BATCH;
  let lanzadas = 0, fallidas = 0;
  const detalles = [];

  for (let i = 0; i < lista.length; i++) {
    const c = lista[i];
    try {
      await triggerOne(c);
      lanzadas++;
      detalles.push({ phone: c.phone, ok: true });
      await log({ phone: c.phone, nombre: c.name, origen, estado: 'ok', disparado_por: por });
    } catch (err) {
      fallidas++;
      detalles.push({ phone: c.phone, ok: false, error: err.message });
      await log({ phone: c.phone, nombre: c.name, origen, estado: 'error', detalle: err.message, disparado_por: por });
      console.error(`[calls] ${c.phone} falló:`, err.message);
    }
    // Pausa entre llamadas (no tras la última).
    if (i < lista.length - 1 && DELAY_MS > 0) await sleep(DELAY_MS);
  }

  console.log(`[calls] ${origen}: ${lanzadas} lanzadas, ${fallidas} fallidas${truncado ? ` (truncado a ${MAX_BATCH})` : ''}`);
  return { lanzadas, fallidas, truncado, total: clientes.length, detalles };
}

module.exports = { triggerBatch, triggerOne, callsEnabled, MAX_BATCH, DELAY_MS };
