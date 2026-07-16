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
const schedule = require('./schedule');
const clienteConfig = require('./clienteConfig');
const { getCachedData } = require('./cache');

const TABLE = 'llamada_cola';
const TZ = process.env.CRON_TZ || 'America/Santo_Domingo';

function horarioTexto(cfg) {
  const bloques = (cfg.blocks || []).map((b) => `${b.start}–${b.end}`).join(', ') || '—';
  return `${bloques}${cfg.weekdaysOnly ? ' · L–V' : ''} (${cfg.tz || TZ})`;
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

// Auto-encola a los clientes activos una vez por día, al entrar al primer bloque.
async function autoEnqueueEnabled() {
  const phones = await clienteConfig.getEnabledPhones();
  if (!phones.length) return 0;
  const { clientes } = await getCachedData(true);
  const byPhone = new Map(clientes.map((c) => [c.phone, c]));
  const objetivo = phones.map((p) => byPhone.get(p)).filter((c) => c && c.phone);
  const r = await enqueue(objetivo, 'cron', null, 'principal');
  console.log(`[cola] auto-encolado diario: ${r.encoladas} activos`);
  return r.encoladas;
}

async function tick() {
  if (corriendo) return;                       // evita solapamiento
  if (!calls.callsEnabled) return;             // sin N8N_CALL_URL no hace nada

  const cfg = await schedule.get();
  if (!schedule.inWindow(cfg)) return;         // fuera de los bloques: pausa

  corriendo = true;
  try {
    // Al entrar en el bloque, encola a los activos (1x/día) si está habilitado.
    if (cfg.autoEnqueue && cfg.lastEnqueueDate !== schedule.ymdInTz()) {
      await autoEnqueueEnabled();
      await schedule.markEnqueued();
    }

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
  const cfg = await schedule.get();
  return {
    pendientes: pendientes.length,
    proximo: pendientes[0] ? { phone: pendientes[0].phone, nombre: pendientes[0].nombre } : null,
    enviadas24h: ultimas.filter((r) => r.estado === 'enviada').length,
    errores24h: ultimas.filter((r) => r.estado === 'error').length,
    scheduleEnabled: cfg.enabled,
    enHorario: schedule.inWindow(cfg),
    horario: horarioTexto(cfg),
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

module.exports = { enqueue, tick, status, cancelarTodo, autoEnqueueEnabled, TZ };
