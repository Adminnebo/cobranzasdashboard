/**
 * Config por cliente (tabla cliente_config en Supabase): a quién se llama.
 * Se cruza por `phone` (10 dígitos normalizados) con la lista viva de clientes.
 * Por defecto TODOS están disabled: si no hay fila, enabled = false.
 */

const db = require('./supabaseDb');

const TABLE = 'cliente_config';

/** Map<phone, enabled> con todo lo que hay en la tabla. */
async function getEnabledMap() {
  const rows = await db.select(TABLE, '?select=phone,enabled');
  const map = new Map();
  for (const r of rows || []) map.set(String(r.phone), !!r.enabled);
  return map;
}

/** Teléfonos actualmente habilitados. */
async function getEnabledPhones() {
  const rows = await db.select(TABLE, '?select=phone&enabled=is.true');
  return (rows || []).map((r) => String(r.phone));
}

/**
 * Activa/desactiva uno o varios teléfonos. Es la decisión de una persona: borra
 * el estado de cobro (promesa, dice que pagó, pasar a una persona). Así, si el
 * equipo vuelve a prender a quien dijo que ya pagó, vuelve a la lista normal.
 */
async function setEnabled(phones, enabled, updatedBy) {
  const list = (Array.isArray(phones) ? phones : [phones]).map(String).filter(Boolean);
  if (!list.length) return { updated: 0 };
  const rows = list.map((phone) => ({
    phone,
    enabled: !!enabled,
    estado_cobro: null,
    estado_detalle: null,
    estado_at: null,
    enabled_antes: null,
    updated_at: new Date().toISOString(),
    updated_by: updatedBy || null,
  }));
  await db.upsert(TABLE, rows, 'phone');
  return { updated: rows.length, enabled: !!enabled };
}

// ── Estado de cobro (lo maneja el motor de promesas) ────────────────────────
// promesa    -> prometió una fecha: solo lo llama el follow up ese día
// dice_pago  -> dijo que ya pagó: no se llama hasta que el equipo lo prenda
// escalar    -> varias promesas incumplidas seguidas: pasa a una persona
const ESTADOS = new Set(['promesa', 'dice_pago', 'escalar']);

/** Map<phone, {estado, detalle, at}> de los clientes con estado de cobro. */
async function getEstadoMap() {
  const rows = await db.select(TABLE, '?select=phone,estado_cobro,estado_detalle,estado_at&estado_cobro=not.is.null');
  const map = new Map();
  for (const r of rows || []) map.set(String(r.phone), { estado: r.estado_cobro, detalle: r.estado_detalle, at: r.estado_at });
  return map;
}

async function filaDe(phone) {
  const rows = await db.select(TABLE, `?select=phone,enabled,estado_cobro,enabled_antes&phone=eq.${encodeURIComponent(phone)}`);
  return (rows && rows[0]) || null;
}

/**
 * Pone al cliente en un estado de cobro y lo apaga para el agente normal.
 * Recuerda si estaba prendido (solo al entrar desde "normal") para devolverlo igual.
 */
async function entrarEstado(phone, estado, detalle) {
  if (!ESTADOS.has(estado)) throw new Error(`estado de cobro inválido: ${estado}`);
  const r = await filaDe(phone);
  const yaEnEstado = r && r.estado_cobro;
  await db.upsert(TABLE, {
    phone: String(phone),
    enabled: false,
    estado_cobro: estado,
    estado_detalle: detalle || null,
    estado_at: new Date().toISOString(),
    enabled_antes: yaEnEstado ? r.enabled_antes : !!(r && r.enabled),
    updated_at: new Date().toISOString(),
    updated_by: 'sistema (follow up)',
  }, 'phone');
}

/**
 * Saca al cliente del estado de cobro: vuelve a la lista normal como estaba.
 * Con { apagado: true } queda apagado (p.ej. su número cayó en IVR).
 */
async function salirEstado(phone, { apagado = false } = {}) {
  const r = await filaDe(phone);
  if (!r || !r.estado_cobro) return;
  await db.upsert(TABLE, {
    phone: String(phone),
    enabled: apagado ? false : !!r.enabled_antes,
    estado_cobro: null,
    estado_detalle: null,
    estado_at: new Date().toISOString(),
    enabled_antes: null,
    updated_at: new Date().toISOString(),
    updated_by: 'sistema (follow up)',
  }, 'phone');
}

module.exports = { getEnabledMap, getEnabledPhones, setEnabled, getEstadoMap, entrarEstado, salirEstado };
