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

/** Activa/desactiva uno o varios teléfonos. */
async function setEnabled(phones, enabled, updatedBy) {
  const list = (Array.isArray(phones) ? phones : [phones]).map(String).filter(Boolean);
  if (!list.length) return { updated: 0 };
  const rows = list.map((phone) => ({
    phone,
    enabled: !!enabled,
    updated_at: new Date().toISOString(),
    updated_by: updatedBy || null,
  }));
  await db.upsert(TABLE, rows, 'phone');
  return { updated: rows.length, enabled: !!enabled };
}

module.exports = { getEnabledMap, getEnabledPhones, setEnabled };
