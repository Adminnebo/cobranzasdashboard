// Base en memoria con el subconjunto de PostgREST que usa el panel:
// filtros eq / in / lt / lte / gt / gte / is.null / is.true / not.is.null, order, limit y offset.
const tablas = {};
let seq = 1;
const tabla = (t) => (tablas[t] = tablas[t] || []);

function parse(query) {
  const q = new URLSearchParams(String(query || '').replace(/^\?/, ''));
  const filtros = [];
  let order = null, limit = null, offset = 0;
  for (const [k, v] of q) {
    if (k === 'select' || k === 'on_conflict') continue;
    if (k === 'order') { order = v; continue; }
    if (k === 'limit') { limit = parseInt(v, 10); continue; }
    if (k === 'offset') { offset = parseInt(v, 10) || 0; continue; }
    filtros.push([k, decodeURIComponent(v)]);
  }
  return { filtros, order, limit, offset };
}
const val = (x) => (x == null ? x : String(x));
function cumple(row, [col, expr]) {
  const v = row[col];
  if (expr === 'is.null') return v == null;
  if (expr === 'not.is.null') return v != null;
  if (expr === 'is.true') return v === true;
  const m = expr.match(/^(eq|lt|lte|gt|gte|in)\.(.*)$/);
  if (!m) throw new Error('filtro no soportado: ' + expr);
  const [, op, arg] = m;
  if (op === 'eq') return val(v) === arg;
  if (op === 'lte') return v != null && String(v) <= arg;
  if (op === 'gte') return v != null && String(v) >= arg;
  if (op === 'lt') return v != null && String(v) < arg;
  if (op === 'gt') return v != null && String(v) > arg;
  const lista = arg.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, ''));
  return lista.includes(val(v));
}
function filtrar(t, query) {
  const { filtros, order, limit, offset } = parse(query);
  let rows = tabla(t).filter((r) => filtros.every((f) => cumple(r, f)));
  if (order) {
    const claves = order.split(',').map((o) => o.split('.'));
    rows = rows.slice().sort((a, b) => {
      for (const [col, dir] of claves) {
        const x = a[col] ?? '', y = b[col] ?? '';
        if (x === y) continue;
        return (x < y ? -1 : 1) * (dir === 'desc' ? -1 : 1);
      }
      return 0;
    });
  }
  if (offset) rows = rows.slice(offset);
  return limit ? rows.slice(0, limit) : rows;
}
const ins = (t, rows) => (Array.isArray(rows) ? rows : [rows]).map((r) => {
  const row = { id: seq++, created_at: new Date(Date.now() + seq).toISOString(), ...r };
  tabla(t).push(row); return row;
});
module.exports = {
  dbEnabled: true,
  tablas, reset() { for (const k of Object.keys(tablas)) delete tablas[k]; },
  select: async (t, q) => filtrar(t, q).map((r) => ({ ...r })),
  insert: async (t, rows) => { ins(t, rows); return null; },
  insertReturn: async (t, rows) => ins(t, rows),
  update: async (t, q, patch) => { for (const r of filtrar(t, q)) Object.assign(r, patch); return null; },
  upsert: async (t, rows, key) => {
    for (const r of Array.isArray(rows) ? rows : [rows]) {
      const ex = tabla(t).find((x) => key.split(',').every((k) => val(x[k]) === val(r[k])));
      if (ex) Object.assign(ex, r); else ins(t, r);
    }
    return null;
  },
  del: async (t, q) => { const out = filtrar(t, q); tablas[t] = tabla(t).filter((r) => !out.includes(r)); return null; },
};
