/**
 * Persistencia del chat del Asistente IA por usuario (tabla asistente_chat).
 * Se guarda el hilo completo (últimos MAX mensajes) para que se conserve entre
 * sesiones y dispositivos.
 */

const db = require('./supabaseDb');

const TABLE = 'asistente_chat';
const MAX = 60; // últimos N intercambios

async function getThread(email) {
  if (!email) return [];
  try {
    const rows = await db.select(TABLE, `?email=eq.${encodeURIComponent(email)}&select=thread`);
    return (rows && rows[0] && rows[0].thread) || [];
  } catch {
    return [];
  }
}

async function append(email, q, a, meta) {
  if (!email) return;
  try {
    const thread = await getThread(email);
    thread.push({ q, a, meta: meta || null, at: new Date().toISOString() });
    await db.upsert(TABLE, { email, thread: thread.slice(-MAX), updated_at: new Date().toISOString() }, 'email');
  } catch (e) {
    console.error('[chat] guardar falló:', e.message);
  }
}

async function clear(email) {
  if (!email) return;
  try {
    await db.upsert(TABLE, { email, thread: [], updated_at: new Date().toISOString() }, 'email');
  } catch (e) {
    console.error('[chat] limpiar falló:', e.message);
  }
}

module.exports = { getThread, append, clear };
