/**
 * Listas de llamadas: segmentos de clientes guardados con un nombre para
 * reutilizarlos (cargar la selección y llamar/activar). Tabla call_list.
 */

const db = require('./supabaseDb');

const TABLE = 'call_list';

async function list() {
  const rows = await db.select(TABLE, '?select=*&order=created_at.desc');
  return (rows || []).map((r) => ({
    id: r.id,
    name: r.name,
    phones: Array.isArray(r.phones) ? r.phones.map(String) : [],
    count: Array.isArray(r.phones) ? r.phones.length : 0,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}

async function create(name, phones, by) {
  const clean = [...new Set((phones || []).map(String).filter(Boolean))];
  const rows = await db.insertReturn(TABLE, {
    name: String(name).slice(0, 120),
    phones: clean,
    created_by: by || null,
  });
  return rows && rows[0];
}

async function update(id, { name, phones }) {
  const patch = {};
  if (typeof name === 'string' && name.trim()) patch.name = name.trim().slice(0, 120);
  if (Array.isArray(phones)) patch.phones = [...new Set(phones.map(String).filter(Boolean))];
  if (!Object.keys(patch).length) return { ok: true };
  await db.update(TABLE, `?id=eq.${encodeURIComponent(id)}`, patch);
  return { ok: true };
}

async function remove(id) {
  await db.del(TABLE, `?id=eq.${encodeURIComponent(id)}`);
  return { ok: true };
}

module.exports = { list, create, update, remove };
