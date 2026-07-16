/**
 * Horario de llamadas configurable desde la UI (tabla call_schedule).
 * Reemplaza las variables de entorno CALL_CRON / CALL_HOURS_*.
 *
 * Config:
 *   enabled       bool   -> llamadas automáticas on/off
 *   weekdaysOnly  bool   -> solo lunes a viernes
 *   autoEnqueue   bool   -> encolar a los clientes activos automáticamente (1x/día)
 *   blocks        [{start:"HH:MM", end:"HH:MM"}]  -> bloques horarios para llamar
 *
 * El worker de la cola llama solo dentro de algún bloque.
 */

const db = require('./supabaseDb');

const TABLE = 'call_schedule';
const TZ = process.env.CRON_TZ || 'America/Santo_Domingo';
const TTL = 15000;

let cache = null;
let cacheAt = 0;

const DEFAULT = {
  enabled: false,
  weekdaysOnly: true,
  autoEnqueue: true,
  blocks: [{ start: '09:00', end: '18:00' }],
};

function partsInTz(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(d);
  const hour = parseInt(fmt.find((p) => p.type === 'hour').value, 10) % 24;
  const minute = parseInt(fmt.find((p) => p.type === 'minute').value, 10);
  const weekday = fmt.find((p) => p.type === 'weekday').value;
  return { hour, minute, weekday, mins: hour * 60 + minute };
}

function ymdInTz(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const toMins = (hhmm) => {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
};

function normBlocks(blocks) {
  if (!Array.isArray(blocks)) return DEFAULT.blocks;
  const ok = blocks
    .map((b) => ({ start: String(b.start || '').slice(0, 5), end: String(b.end || '').slice(0, 5) }))
    .filter((b) => /^\d{2}:\d{2}$/.test(b.start) && /^\d{2}:\d{2}$/.test(b.end) && toMins(b.end) > toMins(b.start));
  return ok.length ? ok : DEFAULT.blocks;
}

async function get(force = false) {
  if (!force && cache && Date.now() - cacheAt < TTL) return cache;
  let row = null;
  try {
    const rows = await db.select(TABLE, '?id=eq.1&select=*');
    row = rows && rows[0];
  } catch (e) {
    // Tabla aún no creada -> defaults (llamadas apagadas).
  }
  const cfg = row
    ? {
        enabled: !!row.enabled,
        weekdaysOnly: !!row.weekdays_only,
        autoEnqueue: !!row.auto_enqueue,
        blocks: normBlocks(row.blocks),
        lastEnqueueDate: row.last_enqueue_date || null,
        tz: TZ,
      }
    : { ...DEFAULT, lastEnqueueDate: null, tz: TZ };
  cache = cfg;
  cacheAt = Date.now();
  return cfg;
}

function inWindow(cfg, d = new Date()) {
  if (!cfg || !cfg.enabled) return false;
  const p = partsInTz(d);
  if (cfg.weekdaysOnly && (p.weekday === 'Sat' || p.weekday === 'Sun')) return false;
  return (cfg.blocks || []).some((b) => p.mins >= toMins(b.start) && p.mins < toMins(b.end));
}

async function set(patch, by) {
  const cur = await get(true);
  const next = { ...cur, ...patch };
  await db.upsert(TABLE, {
    id: 1,
    enabled: !!next.enabled,
    weekdays_only: !!next.weekdaysOnly,
    auto_enqueue: !!next.autoEnqueue,
    blocks: normBlocks(next.blocks),
    updated_at: new Date().toISOString(),
    updated_by: by || null,
  }, 'id');
  cache = null;
  return get(true);
}

async function markEnqueued() {
  await db.upsert(TABLE, { id: 1, last_enqueue_date: ymdInTz(), updated_at: new Date().toISOString() }, 'id');
  cache = null;
}

module.exports = { get, set, inWindow, markEnqueued, ymdInTz, partsInTz, TZ, DEFAULT };
