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
  // Agente de voz elegido en Ajustes. Se manda como `agentId` en el webhook
  // de salientes; no cambia la asignación del número.
  agentId: null,
  agentName: null,
  // Follow up (motor de promesas).
  promesaTope: 3,        // promesas incumplidas seguidas antes de pasar a una persona
  promesaMaxAtraso: 7,   // días máx. desde la fecha prometida para todavía llamar
  reintentoHoras: 2,     // horas hasta reintentar un follow up no contestado, el mismo día
  // Horario propio de un cliente: puede salirse del horario general, pero
  // nunca de este rango (que nadie lo llame a las 6 de la mañana).
  horarioClienteDesde: '08:00',
  horarioClienteHasta: '19:00',
  // "Pago hoy": hora a la que sale el follow up de una promesa hecha hoy para hoy.
  pagoHoyHora: '17:00',
};

const hhmm = (v, def) => (/^\d{2}:\d{2}$/.test(String(v || '').slice(0, 5)) ? String(v).slice(0, 5) : def);

const entero = (v, def, min, max) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
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
        agentId: row.agent_id || null,
        agentName: row.agent_name || null,
        lastEnqueueDate: row.last_enqueue_date || null,
        promesaTope: entero(row.promesa_tope, DEFAULT.promesaTope, 1, 10),
        promesaMaxAtraso: entero(row.promesa_max_atraso, DEFAULT.promesaMaxAtraso, 0, 60),
        reintentoHoras: entero(row.reintento_horas, DEFAULT.reintentoHoras, 1, 8),
        horarioClienteDesde: hhmm(row.horario_cliente_desde, DEFAULT.horarioClienteDesde),
        horarioClienteHasta: hhmm(row.horario_cliente_hasta, DEFAULT.horarioClienteHasta),
        pagoHoyHora: hhmm(row.pago_hoy_hora, DEFAULT.pagoHoyHora),
        tz: TZ,
      }
    : { ...DEFAULT, lastEnqueueDate: null, tz: TZ };
  cache = cfg;
  cacheAt = Date.now();
  return cfg;
}

function enBloques(cfg, blocks, d) {
  if (!cfg || !cfg.enabled) return false;
  const p = partsInTz(d);
  if (cfg.weekdaysOnly && (p.weekday === 'Sat' || p.weekday === 'Sun')) return false;
  return (blocks || []).some((b) => p.mins >= toMins(b.start) && p.mins < toMins(b.end));
}

/** Horario general: ¿se puede llamar ahora? */
function inWindow(cfg, d = new Date()) {
  return enBloques(cfg, cfg && cfg.blocks, d);
}

const minsAHhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/**
 * Bloques del horario propio de un cliente, recortados al rango permitido
 * (horarioClienteDesde–Hasta). Devuelve null si no tiene horario propio o si
 * no le queda ningún bloque válido (entonces sigue el horario general).
 */
function bloquesCliente(cfg, horario) {
  if (!Array.isArray(horario) || !horario.length) return null;
  const desde = toMins((cfg && cfg.horarioClienteDesde) || DEFAULT.horarioClienteDesde);
  const hasta = toMins((cfg && cfg.horarioClienteHasta) || DEFAULT.horarioClienteHasta);
  const out = horario
    .map((b) => ({ start: String(b.start || '').slice(0, 5), end: String(b.end || '').slice(0, 5) }))
    .filter((b) => /^\d{2}:\d{2}$/.test(b.start) && /^\d{2}:\d{2}$/.test(b.end))
    .map((b) => ({ s: Math.max(desde, toMins(b.start)), e: Math.min(hasta, toMins(b.end)) }))
    .filter((b) => b.e > b.s)
    .map((b) => ({ start: minsAHhmm(b.s), end: minsAHhmm(b.e) }));
  return out.length ? out : null;
}

/**
 * ¿Se puede llamar a este cliente ahora? Con horario propio manda el suyo (aunque
 * esté fuera del general); sin horario propio, el general. Los días (L–V) y el
 * interruptor de llamadas automáticas son los generales.
 */
function abiertoPara(cfg, horario, d = new Date()) {
  const propio = bloquesCliente(cfg, horario);
  return propio ? enBloques(cfg, propio, d) : inWindow(cfg, d);
}

/**
 * Valida un horario propio que viene de la UI. Devuelve los bloques limpios
 * o null (sin horario propio). Lanza un error con status 400 si algo no cuadra.
 */
function validarHorarioCliente(cfg, horario) {
  if (horario == null || (Array.isArray(horario) && !horario.length)) return null;
  if (!Array.isArray(horario)) throw Object.assign(new Error('horario debe ser una lista de bloques'), { status: 400 });
  const desde = cfg.horarioClienteDesde || DEFAULT.horarioClienteDesde;
  const hasta = cfg.horarioClienteHasta || DEFAULT.horarioClienteHasta;
  const out = [];
  for (const b of horario) {
    const start = String((b && b.start) || '').slice(0, 5);
    const end = String((b && b.end) || '').slice(0, 5);
    if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || toMins(end) <= toMins(start)) {
      throw Object.assign(new Error(`Bloque inválido: ${start || '?'}–${end || '?'}`), { status: 400 });
    }
    if (toMins(start) < toMins(desde) || toMins(end) > toMins(hasta)) {
      throw Object.assign(new Error(`El horario de un cliente tiene que estar entre ${desde} y ${hasta}`), { status: 400 });
    }
    out.push({ start, end });
  }
  return out.sort((a, b) => toMins(a.start) - toMins(b.start));
}

async function set(patch, by) {
  const cur = await get(true);
  const next = { ...cur, ...patch };
  // Rango del horario por cliente: solo se escribe si viene (así guardar el
  // horario no falla si sql/004 aún no se corrió).
  const rango = ('horarioClienteDesde' in patch || 'horarioClienteHasta' in patch)
    ? (() => {
        const desde = hhmm(next.horarioClienteDesde, DEFAULT.horarioClienteDesde);
        const hasta = hhmm(next.horarioClienteHasta, DEFAULT.horarioClienteHasta);
        if (toMins(hasta) <= toMins(desde)) throw Object.assign(new Error('El rango del horario por cliente está al revés'), { status: 400 });
        return { horario_cliente_desde: desde, horario_cliente_hasta: hasta };
      })()
    : {};
  // Igual con la hora de "pago hoy" (sql/005).
  if ('pagoHoyHora' in patch) rango.pago_hoy_hora = hhmm(next.pagoHoyHora, DEFAULT.pagoHoyHora);
  await db.upsert(TABLE, {
    id: 1,
    ...rango,
    enabled: !!next.enabled,
    weekdays_only: !!next.weekdaysOnly,
    auto_enqueue: !!next.autoEnqueue,
    blocks: normBlocks(next.blocks),
    agent_id: next.agentId || null,
    agent_name: next.agentName || null,
    promesa_tope: entero(next.promesaTope, DEFAULT.promesaTope, 1, 10),
    promesa_max_atraso: entero(next.promesaMaxAtraso, DEFAULT.promesaMaxAtraso, 0, 60),
    reintento_horas: entero(next.reintentoHoras, DEFAULT.reintentoHoras, 1, 8),
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

module.exports = { get, set, inWindow, abiertoPara, bloquesCliente, validarHorarioCliente, markEnqueued, ymdInTz, partsInTz, TZ, DEFAULT };
