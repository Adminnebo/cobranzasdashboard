/**
 * Cola PERSISTENTE de llamadas (tabla llamada_cola en Supabase).
 *
 * Encolas todas las que quieras (sin tope). Un worker saca UNA por minuto,
 * solo dentro del horario laboral (9:00–18:00, L–V por defecto). Si la cola es
 * más larga que el día, continúa al día siguiente.
 *
 * Sobrevive reinicios/redeploys: el estado vive en Supabase, no en memoria.
 *
 * Config por env:
 *   CALL_HOURS_START     hora de inicio (default 9)
 *   CALL_HOURS_END       hora de fin, exclusiva (default 18)
 *   CALL_WEEKDAYS_ONLY   'true' = solo lunes a viernes (default true)
 *   CRON_TZ              zona horaria de la ventana
 */

const db = require('./supabaseDb');
const calls = require('./calls');
const ivr = require('./ivr');

const TABLE = 'llamada_cola';
const TZ = process.env.CRON_TZ || 'America/Santo_Domingo';
const HOUR_START = parseInt(process.env.CALL_HOURS_START || '9', 10);
const HOUR_END = parseInt(process.env.CALL_HOURS_END || '18', 10);
const WEEKDAYS_ONLY = (process.env.CALL_WEEKDAYS_ONLY || 'true') !== 'false';

// ── Ventana horaria ──────────────────────────────────────────────────────────
function partsInTz(d = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(d);
  const hour = parseInt(fmt.find((p) => p.type === 'hour').value, 10) % 24;
  const weekday = fmt.find((p) => p.type === 'weekday').value; // Mon, Tue...
  return { hour, weekday };
}

function dentroDeHorario(d = new Date()) {
  const { hour, weekday } = partsInTz(d);
  if (WEEKDAYS_ONLY && (weekday === 'Sat' || weekday === 'Sun')) return false;
  return hour >= HOUR_START && hour < HOUR_END;
}

// ── Encolar ──────────────────────────────────────────────────────────────────
/**
 * Agrega clientes a la cola. Evita duplicar teléfonos que ya estén pendientes.
 * @returns { encoladas, yaEnCola, totalPendientes }
 */
async function enqueue(clientes, origen = 'bulk', por = null, agente = 'principal') {
  const conTel = clientes.filter((c) => c.phone);

  // Los que cayeron en IVR NUNCA se encolan (da igual el origen: cron, manual o masivo).
  const ivrPhones = await ivr.getIvrPhones();
  const llamables = conTel.filter((c) => !ivrPhones.has(c.phone));
  const omitidosIvr = conTel.length - llamables.length;

  if (!llamables.length) {
    return { encoladas: 0, yaEnCola: 0, omitidosIvr, totalPendientes: await countPendientes() };
  }

  const pendientes = await db.select(TABLE, '?select=phone&estado=eq.pendiente');
  const yaEstan = new Set((pendientes || []).map((r) => String(r.phone)));

  const nuevos = llamables.filter((c) => !yaEstan.has(c.phone));
  const yaEnCola = llamables.length - nuevos.length;

  if (nuevos.length) {
    const rows = nuevos.map((c) => ({
      phone: c.phone,
      nombre: c.name,
      empresa: c.empresa,
      deuda_total: c.deuda_total,
      deuda_vencida: c.deuda_vencida,
      credito_ofrecido: c.credito_ofrecido,
      origen,
      agente,
      estado: 'pendiente',
      encolada_por: por,
    }));
    // Insertar por lotes para no mandar un body gigante.
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(TABLE, rows.slice(i, i + 500));
    }
  }

  const totalPendientes = await countPendientes();
  console.log(`[cola] +${nuevos.length} encoladas (${yaEnCola} ya estaban${omitidosIvr ? `, ${omitidosIvr} omitidos por IVR` : ''}) · pendientes: ${totalPendientes}`);
  return { encoladas: nuevos.length, yaEnCola, omitidosIvr, totalPendientes };
}

async function countPendientes() {
  const rows = await db.select(TABLE, '?select=id&estado=eq.pendiente');
  return (rows || []).length;
}

// ── Worker: saca UNA de la cola y la dispara ─────────────────────────────────
let corriendo = false;

async function tick() {
  if (corriendo) return;                       // evita solapamiento
  if (!calls.callsEnabled) return;             // sin N8N_CALL_URL no hace nada
  if (!dentroDeHorario()) return;              // fuera de la ventana: pausa

  corriendo = true;
  try {
    const rows = await db.select(TABLE, '?select=*&estado=eq.pendiente&order=created_at.asc&limit=1');
    const item = rows && rows[0];
    if (!item) return;

    const cliente = {
      phone: item.phone,
      name: item.nombre,
      empresa: item.empresa,
      deuda_total: Number(item.deuda_total) || 0,
      deuda_vencida: Number(item.deuda_vencida) || 0,
      credito_ofrecido: Number(item.credito_ofrecido) || 0,
    };

    const agente = item.agente || 'principal';
    try {
      await calls.triggerOne(cliente, agente);
      await marcar(item.id, 'enviada', null);
      await calls.logDisparo({ phone: item.phone, nombre: item.nombre, origen: item.origen, estado: 'ok', disparado_por: item.encolada_por });
      console.log(`[cola] ✅ ${item.phone} (${item.nombre || 's/n'}) · agente: ${agente}`);
    } catch (err) {
      await marcar(item.id, 'error', err.message);
      await calls.logDisparo({ phone: item.phone, nombre: item.nombre, origen: item.origen, estado: 'error', detalle: err.message, disparado_por: item.encolada_por });
      console.error(`[cola] ❌ ${item.phone}: ${err.message}`);
    }
  } catch (err) {
    console.error('[cola] tick falló:', err.message);
  } finally {
    corriendo = false;
  }
}

async function marcar(id, estado, detalle) {
  await db.update(TABLE, `?id=eq.${id}`, {
    estado,
    detalle: detalle || null,
    enviada_at: new Date().toISOString(),
  });
}

// ── Estado / control ─────────────────────────────────────────────────────────
async function status() {
  const [pend, hoy] = await Promise.all([
    db.select(TABLE, '?select=id,phone,nombre,created_at&estado=eq.pendiente&order=created_at.asc'),
    db.select(TABLE, `?select=id,estado&estado=in.(enviada,error)&enviada_at=gte.${new Date(Date.now() - 86400000).toISOString()}`),
  ]);
  const pendientes = pend || [];
  const ultimas = hoy || [];
  return {
    pendientes: pendientes.length,
    proximo: pendientes[0] ? { phone: pendientes[0].phone, nombre: pendientes[0].nombre } : null,
    enviadas24h: ultimas.filter((r) => r.estado === 'enviada').length,
    errores24h: ultimas.filter((r) => r.estado === 'error').length,
    enHorario: dentroDeHorario(),
    horario: `${HOUR_START}:00–${HOUR_END}:00${WEEKDAYS_ONLY ? ' (L–V)' : ''} ${TZ}`,
    minutosEstimados: pendientes.length, // 1 por minuto
    activo: calls.callsEnabled,
  };
}

/** Cancela todas las pendientes. */
async function cancelarTodo() {
  const n = await countPendientes();
  await db.update(TABLE, '?estado=eq.pendiente', { estado: 'cancelada', enviada_at: new Date().toISOString() });
  console.log(`[cola] ${n} pendientes canceladas`);
  return { canceladas: n };
}

module.exports = { enqueue, tick, status, cancelarTodo, dentroDeHorario, TZ };
