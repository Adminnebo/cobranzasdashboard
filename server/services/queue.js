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
const vapi = require('./vapi');
const { getCachedData } = require('./cache');

const TABLE = 'llamada_cola';
const TZ = process.env.CRON_TZ || 'America/Santo_Domingo';

// Concurrencia: máx. llamadas simultáneas (respetando el límite de VAPI).
const MAX_CONCURRENT = parseInt(process.env.CALL_MAX_CONCURRENT || '8', 10);
// Respaldo si VAPI no está configurado: 1 llamada cada RATE_MS.
const RATE_MS = parseInt(process.env.CALL_RATE_MS || '60000', 10);
let lastLaunchAt = 0;

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

  const pendientes = await db.select(TABLE, '?select=id,phone,agente&estado=eq.pendiente');
  const pendPorTel = new Map((pendientes || []).map((r) => [String(r.phone), r]));

  // Un follow up reemplaza a la llamada normal que el cliente tuviera en cola
  // (antes se descartaba el follow up y la promesa quedaba sin llamada).
  let reemplazadas = 0;
  if (agente === 'seguimiento') {
    for (const c of llamables) {
      const p = pendPorTel.get(String(c.phone));
      if (p && (p.agente || 'principal') !== 'seguimiento') {
        await db.update(TABLE, `?id=eq.${p.id}`, { estado: 'cancelada', detalle: 'reemplazada por follow up', enviada_at: new Date().toISOString() });
        pendPorTel.delete(String(c.phone));
        reemplazadas++;
      }
    }
  }

  const nuevos = llamables.filter((c) => !pendPorTel.has(String(c.phone)));
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
      // Solo los follow ups: su promesa y la fecha prometida (viaja a Sword).
      ...(c.promesa_id ? { promesa_id: String(c.promesa_id), fecha_prometida: c.fecha_prometida || null } : {}),
    }));
    // Insertar por lotes para no mandar un body gigante.
    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(TABLE, rows.slice(i, i + 500));
    }
  }

  const totalPendientes = await countPendientes();
  console.log(`[cola] +${nuevos.length} encoladas${agente === 'seguimiento' ? ' (follow up)' : ''} (${yaEnCola} ya estaban${reemplazadas ? `, ${reemplazadas} reemplazadas` : ''}${omitidosIvr ? `, ${omitidosIvr} omitidos por IVR` : ''}) · pendientes: ${totalPendientes}`);
  return { encoladas: nuevos.length, yaEnCola, reemplazadas, omitidosIvr, totalPendientes };
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
  // Solo a quien tiene vencido: llamar con vencido en cero confunde al cliente.
  const objetivo = phones.map((p) => byPhone.get(p)).filter((c) => c && c.phone && (c.deuda_vencida || 0) > 0);
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

    // ── Control de concurrencia ──
    if (vapi.vapiEnabled) {
      // Modo exacto: pregunta a VAPI cuántas hay activas; lanza solo si hay cupo.
      const activas = await vapi.activeCalls();
      if (activas === null) return;              // no se pudo consultar: no arriesgar
      if (activas >= MAX_CONCURRENT) return;     // 8 activas: sin cupo, espera
    } else {
      // Respaldo sin VAPI: 1 llamada cada RATE_MS.
      if (Date.now() - lastLaunchAt < RATE_MS) return;
    }

    // Primero los follow ups (tienen fecha), después el resto por orden de llegada.
    const rows = await db.select(TABLE, '?select=*&estado=eq.pendiente&order=agente.desc.nullslast,created_at.asc&limit=1');
    const item = rows && rows[0];
    if (!item) return;
    lastLaunchAt = Date.now();

    const agente = item.agente || 'principal';

    // Deuda al momento de marcar (no la de cuando se encoló): si ya no tiene
    // vencido, no se llama; si era un follow up, su promesa queda cumplida.
    const { clientes } = await getCachedData();
    const vivo = (clientes || []).find((c) => String(c.phone) === String(item.phone));
    if (vivo && (vivo.deuda_vencida || 0) <= 0) {
      await db.update(TABLE, `?id=eq.${item.id}`, { estado: 'cancelada', detalle: 'sin vencido al marcar', enviada_at: new Date().toISOString() });
      if (item.promesa_id) {
        await db.update('promesa_pago', `?id=eq.${encodeURIComponent(item.promesa_id)}`, { estado: 'cumplida', cerrada_at: new Date().toISOString(), motivo_cierre: 'sin vencido al marcar' });
        await clienteConfig.salirEstado(String(item.phone));
      }
      console.log(`[cola] ⏭  ${item.phone}: sin vencido, no se llama`);
      return;
    }

    const cliente = {
      phone: item.phone,
      name: (vivo && vivo.name) || item.nombre,
      empresa: (vivo && vivo.empresa) || item.empresa,
      deuda_total: vivo ? vivo.deuda_total : Number(item.deuda_total) || 0,
      deuda_vencida: vivo ? vivo.deuda_vencida : Number(item.deuda_vencida) || 0,
      credito_ofrecido: vivo ? vivo.credito_ofrecido : Number(item.credito_ofrecido) || 0,
      fecha_prometida: item.fecha_prometida || null,
    };

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
  // Consulta las llamadas activas ahora (si VAPI está configurado).
  const activas = vapi.vapiEnabled ? await vapi.activeCalls().catch(() => null) : null;
  return {
    pendientes: pendientes.length,
    proximo: pendientes[0] ? { phone: pendientes[0].phone, nombre: pendientes[0].nombre } : null,
    enviadas24h: ultimas.filter((r) => r.estado === 'enviada').length,
    errores24h: ultimas.filter((r) => r.estado === 'error').length,
    scheduleEnabled: cfg.enabled,
    enHorario: schedule.inWindow(cfg),
    horario: horarioTexto(cfg),
    modo: vapi.vapiEnabled ? 'concurrencia' : 'ritmo',
    maxConcurrent: MAX_CONCURRENT,
    activas,                                  // llamadas en curso ahora (o null)
    minutosEstimados: pendientes.length,      // aprox.
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
