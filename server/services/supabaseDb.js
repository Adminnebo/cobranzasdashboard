/**
 * Cliente REST mínimo de Supabase (PostgREST) usando la service_role key.
 * Salta RLS, así que SOLO se usa desde el backend, nunca se expone al navegador.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

const dbEnabled = !!(SUPABASE_URL && SERVICE_KEY);

function headers(extra) {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
    ...(extra || {}),
  };
}

async function call(path, opts = {}) {
  if (!dbEnabled) throw new Error('Supabase no configurado (SUPABASE_URL / SUPABASE_SERVICE_KEY)');
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: headers(opts.headers) });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = (body && (body.message || body.hint || body.details)) || `Supabase ${res.status}`;
    const e = new Error(msg);
    e.status = res.status;
    throw e;
  }
  return body;
}

/** SELECT. Ej: select('cliente_config', '?select=phone,enabled') */
const select = (table, query = '?select=*') => call(`${table}${query}`);

/**
 * UPSERT (insert on conflict update). `rows` es un array de objetos.
 * `onConflict` = columnas de la PK/unique separadas por coma.
 */
const upsert = (table, rows, onConflict) =>
  call(`${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
  });

/** INSERT simple (sin upsert). */
const insert = (table, rows) =>
  call(table, {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(Array.isArray(rows) ? rows : [rows]),
  });

module.exports = { select, upsert, insert, dbEnabled, SUPABASE_URL };
