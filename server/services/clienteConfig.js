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

// ── Horario propio ───────────────────────────────────────────────────────────
/**
 * Map<phone, [{start,end}]> de los clientes con horario propio. Si la columna
 * aún no existe (sql/004 sin correr), devuelve un Map vacío: todos siguen el
 * horario general.
 */
async function getHorarioMap() {
  let rows;
  try { rows = await db.select(TABLE, '?select=phone,horario&horario=not.is.null'); }
  catch (e) { return new Map(); }
  const map = new Map();
  for (const r of rows || []) if (Array.isArray(r.horario) && r.horario.length) map.set(String(r.phone), r.horario);
  return map;
}

/**
 * Horario propio con su origen: Map<phone, { horario, origen: 'manual'|'ia'|null, detalle }>.
 * Sin sql/008 (columnas de origen) devuelve el horario con origen null (= a mano).
 */
async function getHorarioInfoMap() {
  let rows;
  try { rows = await db.select(TABLE, '?select=phone,horario,horario_origen,horario_detalle&horario=not.is.null'); }
  catch (e) {
    const solo = await getHorarioMap();
    return new Map([...solo].map(([p, h]) => [p, { horario: h, origen: null, detalle: null }]));
  }
  const map = new Map();
  for (const r of rows || []) {
    if (Array.isArray(r.horario) && r.horario.length) map.set(String(r.phone), { horario: r.horario, origen: r.horario_origen || null, detalle: r.horario_detalle || null });
  }
  return map;
}

/**
 * Guarda (o borra, con null) el horario propio de uno o varios clientes.
 * opts.origen: 'manual' (lo puso una persona) | 'ia' (lo dijo el cliente en una llamada).
 */
async function setHorario(phones, horario, updatedBy, opts = {}) {
  const list = (Array.isArray(phones) ? phones : [phones]).map(String).filter(Boolean);
  if (!list.length) return { updated: 0 };
  const valor = horario && horario.length ? horario : null;
  const at = new Date().toISOString();
  // A los que ya tienen fila solo se les toca el horario (no enabled ni el
  // estado de cobro); los que no tienen fila se crean apagados, como siempre.
  const existentes = new Set(((await db.select(TABLE, `?select=phone&phone=in.(${list.map(encodeURIComponent).join(',')})`)) || []).map((r) => String(r.phone)));
  const origen = valor ? { horario_origen: opts.origen || 'manual', horario_detalle: opts.detalle || null } : { horario_origen: null, horario_detalle: null };
  const escribir = async (extra) => {
    const conFila = list.filter((p) => existentes.has(p)).map((phone) => ({ phone, horario: valor, ...extra, updated_at: at, updated_by: updatedBy || null }));
    const sinFila = list.filter((p) => !existentes.has(p)).map((phone) => ({ phone, enabled: false, horario: valor, ...extra, updated_at: at, updated_by: updatedBy || null }));
    if (conFila.length) await db.upsert(TABLE, conFila, 'phone');
    if (sinFila.length) await db.upsert(TABLE, sinFila, 'phone');
  };
  // Sin sql/008 las columnas de origen no existen: se guarda solo el horario.
  try { await escribir(origen); }
  catch (e) {
    if (!/horario_origen|horario_detalle|column|PGRST204/i.test(e.message)) throw e;
    await escribir({});
  }
  return { updated: list.length, horario: valor };
}

// ── Follow up forzado (pruebas con clientes reales) ─────────────────────────
/**
 * Teléfonos con "forzar follow up": el follow up los llama aunque no tengan
 * vencido (para probar con un cliente real al día). Vacío si sql/006 no corrió.
 */
async function getForzadosSet() {
  try {
    const rows = await db.select(TABLE, '?select=phone&forzar_follow_up=is.true');
    return new Set((rows || []).map((r) => String(r.phone)));
  } catch (e) { return new Set(); }
}

async function setForzado(phone, forzar, updatedBy) {
  const p = String(phone);
  const ex = await db.select(TABLE, `?select=phone&phone=eq.${encodeURIComponent(p)}`);
  const row = { phone: p, forzar_follow_up: !!forzar, updated_at: new Date().toISOString(), updated_by: updatedBy || null };
  await db.upsert(TABLE, ex && ex.length ? row : { ...row, enabled: false }, 'phone');
  return { phone: p, forzar: !!forzar };
}

module.exports = {
  getHorarioInfoMap, getForzadosSet, setForzado, getHorarioMap, setHorario, getEnabledMap, getEnabledPhones, setEnabled, getEstadoMap, entrarEstado, salirEstado };
