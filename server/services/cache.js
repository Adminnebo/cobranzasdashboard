/**
 * Caché en memoria de los datos de n8n. El servidor consulta los webhooks a lo
 * sumo una vez por TTL, sin importar cuántos clientes (navegadores) pidan /api/data.
 * Deduplica peticiones concurrentes: si llega una ráfaga mientras se refresca,
 * todas comparten el mismo fetch en vuelo.
 */

const { getData } = require('../data/source');
const pruebas = require('./pruebas');

const TTL = parseInt(process.env.DATA_CACHE_TTL_MS || '45000', 10); // 45s por defecto

let cache = { at: 0, data: null };
let inflight = null;

async function refresh() {
  const raw = await getData();
  // Las llamadas a números de prueba salen de `llamadas` (no cuentan en nada) y
  // quedan aparte en `llamadasPrueba`, que solo /api/data muestra a super admins.
  const { reales, pruebas: dePrueba } = pruebas.separar(raw.llamadas || [], await pruebas.phones());
  const data = { ...raw, llamadas: reales, llamadasPrueba: dePrueba };
  cache = { at: Date.now(), data };
  return data;
}

/** Fuerza el próximo acceso a recargar (p.ej. al cambiar la lista de pruebas). */
function invalidate() { cache = { at: 0, data: cache.data }; }

/**
 * Devuelve los datos cacheados. Si el TTL venció (o force=true), refresca.
 * @param {boolean} force  fuerza consulta a n8n (p.ej. al tomar un snapshot)
 */
async function getCachedData(force = false) {
  const age = Date.now() - cache.at;
  const fresh = cache.data && age < TTL;

  if (!force && fresh) {
    return { ...cache.data, cachedAt: new Date(cache.at).toISOString(), cacheAgeMs: age };
  }
  if (inflight) return inflight.then(withMeta); // ya hay un refresh en curso

  inflight = refresh().finally(() => { inflight = null; });
  return inflight.then(withMeta);
}

function withMeta(data) {
  return { ...data, cachedAt: new Date(cache.at).toISOString(), cacheAgeMs: Date.now() - cache.at };
}

function cacheInfo() {
  return { ageMs: cache.data ? Date.now() - cache.at : null, ttlMs: TTL, warmed: !!cache.data };
}

module.exports = { getCachedData, cacheInfo, invalidate, TTL };
