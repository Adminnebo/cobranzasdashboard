/**
 * Números de prueba (tabla numeros_prueba en Supabase).
 *
 * Las llamadas a estos números son pruebas del equipo: no cuentan en métricas,
 * historial, asistente ni promesas, y en el panel solo las ven los super admins
 * (marcadas como "Prueba"). La lista se edita desde el panel (solo super admins).
 *
 * Si la tabla no existe o Supabase no está configurado, la lista queda vacía y
 * todo funciona como antes.
 */

const db = require('./supabaseDb');

const TABLE = 'numeros_prueba';
const TTL = 60000;

// Mismo criterio de cruce que el resto del panel: últimos 10 dígitos.
const phoneKey = (v) => String(v || '').replace(/\D/g, '').slice(-10);

let cache = { at: 0, rows: null };

async function list(force = false) {
  if (!db.dbEnabled) return [];
  if (!force && cache.rows && Date.now() - cache.at < TTL) return cache.rows;
  try {
    const rows = await db.select(TABLE, '?select=phone,nota,agregado_por,created_at&order=created_at.asc');
    cache = { at: Date.now(), rows: rows || [] };
  } catch (e) {
    // Tabla aún no creada: sin números de prueba.
    if (!cache.rows) console.warn('[pruebas] tabla no disponible:', e.message);
    cache = { at: Date.now(), rows: cache.rows || [] };
  }
  return cache.rows;
}

async function phones() {
  return new Set((await list()).map((r) => phoneKey(r.phone)));
}

async function add(phone, nota, por) {
  const key = phoneKey(phone);
  if (key.length !== 10) {
    const err = new Error('Teléfono inválido');
    err.status = 400;
    throw err;
  }
  await db.upsert(TABLE, { phone: key, nota: nota ? String(nota).slice(0, 200) : null, agregado_por: por || null }, 'phone');
  return list(true);
}

async function remove(phone) {
  await db.del(TABLE, `?phone=eq.${phoneKey(phone)}`);
  return list(true);
}

/**
 * Separa las llamadas de prueba del resto.
 * @returns {{ reales: Array, pruebas: Array }} las de prueba llevan prueba: true
 */
function separar(llamadas, setPruebas) {
  if (!setPruebas || !setPruebas.size) return { reales: llamadas, pruebas: [] };
  const reales = [];
  const pruebas = [];
  for (const l of llamadas) {
    if (setPruebas.has(phoneKey(l.phone))) pruebas.push({ ...l, prueba: true });
    else reales.push(l);
  }
  return { reales, pruebas };
}

module.exports = { list, phones, add, remove, separar, phoneKey };
