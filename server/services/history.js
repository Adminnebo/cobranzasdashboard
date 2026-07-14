/**
 * Histórico de deuda persistido en Supabase (tabla deuda_historico).
 * Cada toma (4:00 y 16:00) guarda un snapshot de los totales de la cartera.
 * La gráfica consume la agregación diaria (último snapshot de cada día).
 */

const { getCachedData } = require('./cache');
const { computeMetrics } = require('./metrics');
const db = require('./supabaseDb');

const TZ = process.env.CRON_TZ || 'America/Santo_Domingo';
const TABLE = 'deuda_historico';

// ── Helpers de fecha en la zona horaria de captura ──────────────────────────
function ymdInTz(d = new Date(), tz = TZ) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function hourInTz(d = new Date(), tz = TZ) {
  return parseInt(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', hour12: false }).format(d), 10) % 24;
}

const round2 = (n) => Math.round((n || 0) * 100) / 100;

// ── Snapshot ─────────────────────────────────────────────────────────────────
async function takeSnapshot(slot = 'manual') {
  const { clientes, llamadas, source } = await getCachedData(true); // datos frescos
  const m = computeMetrics(clientes, llamadas);
  const fecha = ymdInTz();

  const row = {
    fecha,
    slot,
    tomado_en: new Date().toISOString(),
    deuda_total: round2(m.deudaTotal),
    deuda_vencida: round2(m.deudaVencida),
    credito_ofrecido: round2(m.creditoOfrecido),
    total_clientes: m.totalClientes,
    source,
  };

  await db.upsert(TABLE, row, 'fecha,slot');
  console.log(`[history] snapshot ${slot} ${fecha}: deudaTotal=${row.deuda_total}`);
  return row;
}

// ── Seed inicial: ~30 días para que la gráfica tenga forma desde el primer
// arranque. Se marca slot='seed'; las tomas reales (AM/PM) del mismo día lo
// sustituyen en la agregación. Solo corre si la tabla está vacía. ────────────
async function ensureSeed(days = 30) {
  const existing = await db.select(TABLE, '?select=fecha&limit=1');
  if (existing && existing.length) return;

  const { clientes, llamadas } = await getCachedData();
  const m = computeMetrics(clientes, llamadas);
  const now = new Date();
  const rows = [];
  for (let i = days; i >= 1; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const trend = 1 - i * 0.004;                 // ~12% más bajo hace 30 días
    const wobble = 1 + Math.sin(i / 3) * 0.012;  // ±1.2%
    const f = trend * wobble;
    rows.push({
      fecha: ymdInTz(d),
      slot: 'seed',
      tomado_en: d.toISOString(),
      deuda_total: Math.round(m.deudaTotal * f),
      deuda_vencida: Math.round(m.deudaVencida * (f - 0.01)),
      credito_ofrecido: round2(m.creditoOfrecido),
      total_clientes: m.totalClientes,
      source: 'seed',
    });
  }
  await db.upsert(TABLE, rows, 'fecha,slot');
  console.log(`[history] seed de ${days} días creado (estimado; se reemplaza con tomas reales).`);
}

// Al arrancar: si ya pasó una toma del día y no está registrada, captúrala.
async function catchUp() {
  const h = hourInTz();
  const fecha = ymdInTz();
  const rows = await db.select(TABLE, `?select=slot&fecha=eq.${fecha}`);
  const has = (slot) => (rows || []).some((r) => r.slot === slot);
  if (h >= 4 && !has('AM')) await takeSnapshot('AM');
  if (h >= 16 && !has('PM')) await takeSnapshot('PM');
}

// ── Agregación diaria para la gráfica (último snapshot de cada día) ───────────
async function getDailyHistory() {
  const rows = await db.select(TABLE, '?select=*&order=fecha.asc,tomado_en.asc');
  const byDate = new Map();
  for (const r of rows || []) {
    const cur = byDate.get(r.fecha);
    if (!cur || r.tomado_en > cur.tomado_en) byDate.set(r.fecha, r);
  }
  return [...byDate.values()]
    .sort((a, b) => (a.fecha < b.fecha ? -1 : 1))
    .map((r) => ({
      date: r.fecha,
      slot: r.slot,
      deudaTotal: Number(r.deuda_total),
      deudaVencida: Number(r.deuda_vencida),
      creditoOfrecido: Number(r.credito_ofrecido),
      totalClientes: r.total_clientes,
      seeded: r.slot === 'seed',
    }));
}

module.exports = { takeSnapshot, ensureSeed, catchUp, getDailyHistory, TZ };
