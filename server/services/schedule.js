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
  promesaMaxAtraso: 7,   // (en desuso desde la ventana de follow up; se conserva la columna)
  reintentoHoras: 2,     // el primer día de follow up: horas entre reintentos si no contesta
  // Ventana de follow up: desde la primera llamada de follow up, cuántos días
  // (de calendario) insiste antes de devolver al cliente al agente principal.
  fuVentanaDias: 7,
  fuReintentosDia1: 1,       // reintentos el primer día si no contesta (además de la 1.ª llamada)
  fuSinFechaMismoDia: false, // si contesta sin fecha el primer día: ¿reintenta ese día? (no: al día siguiente)
  fuCadaDias: 1,             // después del primer día: una llamada cada N días
  // Fase B: hora que pide el cliente ("llámenme mañana a las 3") y llamadas que
  // no alcanzan a salir en una ventana corta (horario propio o esa hora).
  citaVentanaMin: 30,        // minutos desde la hora pedida en los que puede salir la llamada
  maxMovidas: 2,             // días que se pasa al siguiente antes de ir a 🙋 Por atender
  // Horario propio de un cliente: puede salirse del horario general, pero
  // nunca de este rango (que nadie lo llame a las 6 de la mañana).
  horarioClienteDesde: '08:00',
  horarioClienteHasta: '19:00',
  // Días hábiles después de la fecha prometida para el follow up (deja que el
  // pago se refleje). Con 1: "pago mañana" (jue) -> follow up el vie.
  followUpMargenDias: 1,
  // Retiros: horas de "en la mañana" y "en la tarde" cuando piden que pasen a buscar el pago.
  retiroManana: { desde: '08:00', hasta: '12:00' },
  retiroTarde: { desde: '14:00', hasta: '18:00' },
  // Ajustar solo el horario propio con lo que dice el cliente ("solo puedo los martes").
  // Arranca apagado: primero se revisa en Promesas que la IA lea bien.
  horarioAuto: false,
};
const franja = (desde, hasta, def) => {
  const d = hhmm(desde, def.desde), h = hhmm(hasta, def.hasta);
  return toMins(h) > toMins(d) ? { desde: d, hasta: h } : { ...def };
};

// Días de la semana: 1 = lunes … 7 = domingo.
const DIA_NUM = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const normDias = (dias) => {
  if (!Array.isArray(dias)) return null;
  const out = [...new Set(dias.map((n) => parseInt(n, 10)).filter((n) => n >= 1 && n <= 7))].sort((a, b) => a - b);
  return out.length ? out : null;
};

/** Suma N días hábiles (lunes a viernes) a una fecha YYYY-MM-DD. */
function sumarHabiles(ymd, n) {
  let d = new Date(String(ymd).slice(0, 10) + 'T12:00:00Z');
  let faltan = Math.max(0, parseInt(n, 10) || 0);
  while (faltan > 0) {
    d = new Date(d.getTime() + 86400000);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) faltan--;
  }
  return d.toISOString().slice(0, 10);
}

/** Suma N días de calendario a una fecha YYYY-MM-DD. */
function sumarDias(ymd, n) {
  const d = new Date(String(ymd).slice(0, 10) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + (parseInt(n, 10) || 0));
  return d.toISOString().slice(0, 10);
}

/** Último día de la ventana de follow up que empieza en `desde` (incluido). */
const finVentana = (desde, cfg) => sumarDias(desde, Math.max(1, (cfg && cfg.fuVentanaDias) || DEFAULT.fuVentanaDias) - 1);

/** Fecha en que sale el follow up de una promesa: la prometida + el margen en días hábiles. */
const fechaFollowUp = (fechaPrometida, cfg) =>
  sumarHabiles(String(fechaPrometida).slice(0, 10), cfg && cfg.followUpMargenDias != null ? cfg.followUpMargenDias : 0);

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
        followUpMargenDias: entero(row.follow_up_margen_dias, DEFAULT.followUpMargenDias, 1, 5),
        retiroManana: franja(row.retiro_manana_desde, row.retiro_manana_hasta, DEFAULT.retiroManana),
        retiroTarde: franja(row.retiro_tarde_desde, row.retiro_tarde_hasta, DEFAULT.retiroTarde),
        horarioAuto: row.horario_auto == null ? DEFAULT.horarioAuto : !!row.horario_auto,
        fuVentanaDias: entero(row.fu_ventana_dias, DEFAULT.fuVentanaDias, 1, 30),
        fuReintentosDia1: entero(row.fu_reintentos_dia1, DEFAULT.fuReintentosDia1, 0, 6),
        fuSinFechaMismoDia: row.fu_sin_fecha_mismo_dia == null ? DEFAULT.fuSinFechaMismoDia : !!row.fu_sin_fecha_mismo_dia,
        fuCadaDias: entero(row.fu_cada_dias, DEFAULT.fuCadaDias, 1, 7),
        citaVentanaMin: entero(row.cita_ventana_min, DEFAULT.citaVentanaMin, 10, 180),
        maxMovidas: entero(row.max_movidas, DEFAULT.maxMovidas, 0, 10),
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
    .map((b) => ({ start: String(b.start || '').slice(0, 5), end: String(b.end || '').slice(0, 5), dias: normDias(b.dias) }))
    .filter((b) => /^\d{2}:\d{2}$/.test(b.start) && /^\d{2}:\d{2}$/.test(b.end))
    .map((b) => ({ s: Math.max(desde, toMins(b.start)), e: Math.min(hasta, toMins(b.end)), dias: b.dias }))
    .filter((b) => b.e > b.s)
    .map((b) => ({ start: minsAHhmm(b.s), end: minsAHhmm(b.e), ...(b.dias ? { dias: b.dias } : {}) }));
  return out.length ? out : null;
}

/**
 * ¿Se puede llamar a este cliente ahora? Con horario propio manda el suyo (aunque
 * esté fuera del general); sin horario propio, el general. Un bloque con días
 * propios (ej. solo martes) usa esos días, aunque el general sea L–V; sin días,
 * usa los del general. El interruptor de llamadas automáticas es el general.
 */
function abiertoPara(cfg, horario, d = new Date()) {
  const propio = bloquesCliente(cfg, horario);
  if (!propio) return inWindow(cfg, d);
  if (!cfg || !cfg.enabled) return false;
  const p = partsInTz(d);
  const dia = DIA_NUM[p.weekday];
  const finde = dia >= 6;
  return propio.some((b) => {
    if (b.dias ? !b.dias.includes(dia) : (cfg.weekdaysOnly && finde)) return false;
    return p.mins >= toMins(b.start) && p.mins < toMins(b.end);
  });
}

/** Bloques que aplican HOY (por día de la semana) de una lista, en minutos. */
function bloquesDeHoy(cfg, bloques, d, { usaDiasGenerales = true } = {}) {
  const p = partsInTz(d);
  const dia = DIA_NUM[p.weekday];
  const finde = dia >= 6;
  return (bloques || [])
    .filter((b) => (b.dias ? b.dias.includes(dia) : !(usaDiasGenerales && cfg.weekdaysOnly && finde)))
    .map((b) => ({ s: toMins(b.start), e: toMins(b.end) }))
    .filter((b) => b.e > b.s);
}

/**
 * Ventana de una llamada de la cola en este momento. Manda, en este orden:
 *  1. la hora que pidió el cliente (cita): solo ese día, de esa hora a +N min,
 *     aunque esté fuera de su horario propio y del general;
 *  2. su horario propio;
 *  3. el horario general.
 * El interruptor de llamadas automáticas apaga todo.
 * @param ctx { horario, cita: ISO|null }
 * @returns { tipo: 'cita'|'propio'|'general', abierto, disponible: minutos que le
 *   quedan hoy para salir (menos = más urgente), espera?: 'cita' si su hora es más tarde o otro día,
 *   desde?, hasta? (HH:MM de la ventana de la cita) }
 */
function ventanaLlamada(cfg, { horario = null, cita = null } = {}, d = new Date()) {
  const ahora = partsInTz(d).mins;
  const hoy = ymdInTz(d);
  if (cita) {
    const c = new Date(cita);
    const dia = ymdInTz(c);
    if (dia >= hoy) {
      const ini = partsInTz(c).mins;
      const fin = Math.min(ini + ((cfg && cfg.citaVentanaMin) || DEFAULT.citaVentanaMin), 24 * 60);
      const rango = { desde: minsAHhmm(ini), hasta: minsAHhmm(Math.min(fin, 24 * 60 - 1)), dia };
      if (dia > hoy || ahora < ini) return { tipo: 'cita', abierto: false, disponible: null, espera: 'cita', ...rango };
      const abierto = !!(cfg && cfg.enabled) && ahora < fin;
      return { tipo: 'cita', abierto, disponible: abierto ? fin - ahora : 0, ...rango };
    }
    // Una cita de un día que ya pasó no cuenta (la revisión de perdidas la mueve o la borra).
  }
  const propio = bloquesCliente(cfg, horario);
  const bloques = propio ? bloquesDeHoy(cfg, propio, d) : bloquesDeHoy(cfg, (cfg && cfg.blocks) || [], d, { usaDiasGenerales: true });
  const abierto = propio ? abiertoPara(cfg, horario, d) : inWindow(cfg, d);
  const disponible = bloques.reduce((s, b) => s + Math.max(0, b.e - Math.max(b.s, ahora)), 0);
  return { tipo: propio ? 'propio' : 'general', abierto, disponible: cfg && cfg.enabled ? disponible : 0 };
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
    if (b.dias != null && !Array.isArray(b.dias)) throw Object.assign(new Error('Los días de un bloque deben ser una lista'), { status: 400 });
    const dias = normDias(b.dias);
    out.push({ start, end, ...(dias ? { dias } : {}) });
  }
  return out.sort((a, b) => toMins(a.start) - toMins(b.start) || ((a.dias || [0])[0] - (b.dias || [0])[0]));
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
  // Y el margen del follow up (sql/007).
  if ('followUpMargenDias' in patch) rango.follow_up_margen_dias = entero(next.followUpMargenDias, DEFAULT.followUpMargenDias, 1, 5);
  // Retiros y horario automático (sql/008).
  if ('retiroManana' in patch) {
    const f = franja(next.retiroManana && next.retiroManana.desde, next.retiroManana && next.retiroManana.hasta, DEFAULT.retiroManana);
    Object.assign(rango, { retiro_manana_desde: f.desde, retiro_manana_hasta: f.hasta });
  }
  if ('retiroTarde' in patch) {
    const f = franja(next.retiroTarde && next.retiroTarde.desde, next.retiroTarde && next.retiroTarde.hasta, DEFAULT.retiroTarde);
    Object.assign(rango, { retiro_tarde_desde: f.desde, retiro_tarde_hasta: f.hasta });
  }
  if ('horarioAuto' in patch) rango.horario_auto = !!next.horarioAuto;
  // Ventana de follow up (sql/011): solo si vienen.
  if ('fuVentanaDias' in patch) rango.fu_ventana_dias = entero(next.fuVentanaDias, DEFAULT.fuVentanaDias, 1, 30);
  if ('fuReintentosDia1' in patch) rango.fu_reintentos_dia1 = entero(next.fuReintentosDia1, DEFAULT.fuReintentosDia1, 0, 6);
  if ('fuSinFechaMismoDia' in patch) rango.fu_sin_fecha_mismo_dia = !!next.fuSinFechaMismoDia;
  if ('fuCadaDias' in patch) rango.fu_cada_dias = entero(next.fuCadaDias, DEFAULT.fuCadaDias, 1, 7);
  // Fase B (sql/013): solo si vienen.
  if ('citaVentanaMin' in patch) rango.cita_ventana_min = entero(next.citaVentanaMin, DEFAULT.citaVentanaMin, 10, 180);
  if ('maxMovidas' in patch) rango.max_movidas = entero(next.maxMovidas, DEFAULT.maxMovidas, 0, 10);
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

module.exports = { get, set, inWindow, abiertoPara, bloquesCliente, validarHorarioCliente, markEnqueued, ymdInTz, partsInTz, sumarHabiles, sumarDias, finVentana, fechaFollowUp, ventanaLlamada, bloquesDeHoy, toMins, minsAHhmm, TZ, DEFAULT };
