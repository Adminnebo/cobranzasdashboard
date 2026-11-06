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
const pruebas = require('./pruebas');

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
  // Los follow ups con "forzar follow up" (🧪, pruebas) entran aunque el número tenga IVR.
  const forzados = agente === 'seguimiento' ? await clienteConfig.getForzadosSet() : new Set();
  const llamables = conTel.filter((c) => !ivrPhones.has(c.phone) || forzados.has(String(c.phone)));
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

/**
 * Elige la próxima llamada de la cola según el horario de cada cliente:
 *   1. quien tiene horario propio y está dentro de él (se aprovecha su ventana);
 *   2. follow ups (tienen fecha);
 *   3. el resto por orden de llegada.
 * Quien tiene horario propio cerrado espera; quien no tiene, sigue el general.
 * ordenCola devuelve TODA la cola en ese orden (las que pueden salir ahora
 * primero, luego las que esperan); elegirSiguiente toma la primera que puede.
 * @param rows     pendientes de llamada_cola
 * @param horarios Map<phone, bloques> (cliente_config.horario)
 */
function ordenCola(rows, horarios, cfg, d = new Date(), citas = new Map()) {
  const items = (rows || []).map((r) => {
    const phone = String(r.phone);
    const h = horarios.get(phone);
    const cita = citas.get(phone) || null;
    const v = schedule.ventanaLlamada(cfg, { horario: h, cita: cita && cita.at }, d);
    const propio = (h && schedule.bloquesCliente(cfg, h)) || null;
    return { r, propio, cita, ...v };
  });
  // Las que pueden salir ahora primero; entre ellas, la que menos tiempo le queda
  // hoy (una ventana de 10 min antes que alguien con todo el día); luego follow
  // ups; luego orden de llegada.
  const disp = (x) => (x.disponible == null ? Infinity : x.disponible);
  items.sort((a, b) =>
    (b.abierto - a.abierto)
    || (disp(a) - disp(b))
    || ((b.r.agente === 'seguimiento') - (a.r.agente === 'seguimiento'))
    || String(a.r.created_at).localeCompare(String(b.r.created_at)));
  return items;
}

function elegirSiguiente(rows, horarios, cfg, d = new Date(), citas = new Map()) {
  const [primero] = ordenCola(rows, horarios, cfg, d, citas);
  return primero && primero.abierto ? primero.r : null;
}

/** ¿Hay alguna ventana abierta ahora (la general, la de algún cliente o una hora pedida)? */
function algunaAbierta(cfg, horarios, d = new Date(), citas = new Map()) {
  if (schedule.inWindow(cfg, d)) return true;
  for (const h of horarios.values()) if (schedule.bloquesCliente(cfg, h) && schedule.abiertoPara(cfg, h, d)) return true;
  for (const c of citas.values()) if (schedule.ventanaLlamada(cfg, { cita: c.at }, d).abierto) return true;
  return false;
}

/**
 * Llamadas que no alcanzaron a salir en su ventana corta de hoy (su horario
 * propio o la hora que pidió). Se pasan al siguiente día con el motivo a la
 * vista; después de maxMovidas veces se quitan de la cola y el cliente va a
 * 🙋 Por atender. El horario general no cuenta: esas siguen solas mañana.
 * Corre cada minuto desde el motor; una fila se cuenta una sola vez por día.
 */
let faltaMovida = false; // sql/013 sin correr: no insistir cada minuto
async function revisarPerdidas(ahora = new Date()) {
  if (faltaMovida) return {};
  const cfg = await schedule.get();
  if (!cfg.enabled) return {};
  const rows = (await db.select(TABLE, '?select=*&estado=eq.pendiente')) || [];
  const citas = await clienteConfig.getCitaMap();
  const horarios = await clienteConfig.getHorarioMap();
  const hoy = schedule.ymdInTz(ahora);
  const min = schedule.partsInTz(ahora).mins;
  const diaTxt = new Date(`${hoy}T12:00:00Z`).toLocaleDateString('es-DO', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const cuenta = {};
  const conFila = new Set();
  for (const r of rows) {
    const phone = String(r.phone);
    conFila.add(phone);
    if (r.movida_dia && String(r.movida_dia).slice(0, 10) === hoy) continue;
    const cita = citas.get(phone);
    let fin = null; let desc = null; let esCita = false;
    if (cita && schedule.ymdInTz(new Date(cita.at)) === hoy) {
      const v = schedule.ventanaLlamada(cfg, { cita: cita.at }, ahora);
      fin = schedule.toMins(v.desde) + cfg.citaVentanaMin; desc = `la hora que pidió (${v.desde}–${v.hasta})`; esCita = true;
    } else if (!cita || schedule.ymdInTz(new Date(cita.at)) < hoy) {
      const propio = schedule.bloquesCliente(cfg, horarios.get(phone));
      const deHoy = propio ? schedule.bloquesDeHoy(cfg, propio, ahora) : [];
      if (deHoy.length) {
        fin = Math.max(...deHoy.map((b) => b.e));
        desc = `su horario (${deHoy.map((b) => `${schedule.minsAHhmm(b.s)}–${schedule.minsAHhmm(b.e)}`).join(', ')})`;
      }
    }
    if (fin == null || min < fin) continue;
    // Entró a la cola después de que cerró su ventana: no la perdió, la espera.
    const creada = new Date(r.created_at);
    if (schedule.ymdInTz(creada) === hoy && schedule.partsInTz(creada).mins >= fin) continue;
    const movida = (r.movida || 0) + 1;
    try {
      if (movida > cfg.maxMovidas) {
        const motivo = `No se pudo llamar en ${desc}: ${movida} días seguidos sin alcanzar a salir`;
        await db.update(TABLE, `?id=eq.${r.id}`, { estado: 'cancelada', detalle: motivo, movida, movida_dia: hoy, enviada_at: new Date().toISOString() });
        await clienteConfig.setAtencion(phone, motivo, 'sistema (cola)');
        if (esCita) await clienteConfig.setCita(phone, null, { updatedBy: 'sistema (cola)' });
        cuenta.a_persona = (cuenta.a_persona || 0) + 1;
        console.log(`[cola] 🙋 ${phone}: ${motivo}`);
      } else {
        const tope = cfg.maxMovidas ? ` (${movida} de ${cfg.maxMovidas})` : '';
        await db.update(TABLE, `?id=eq.${r.id}`, { movida, movida_dia: hoy, detalle: `No alcanzó a salir en ${desc} el ${diaTxt}: pasa al siguiente día${tope}` });
        if (esCita) {
          // La hora pedida se mueve al siguiente día hábil, a la misma hora.
          const sig = schedule.sumarHabiles(hoy, 1);
          const nueva = new Date(new Date(cita.at).getTime() + (Date.parse(`${sig}T12:00:00Z`) - Date.parse(`${hoy}T12:00:00Z`)));
          await clienteConfig.setCita(phone, nueva.toISOString(), { texto: cita.texto, origen: cita.origen, movida, updatedBy: 'sistema (cola)' });
        }
        cuenta.movidas = (cuenta.movidas || 0) + 1;
        console.log(`[cola] ↪ ${phone}: no alcanzó ${desc}, pasa al siguiente día${tope}`);
      }
    } catch (err) {
      if (/movida|column|42703|PGRST204/i.test(err.message)) {
        faltaMovida = true;
        console.warn('[cola] faltan las columnas de sql/013: no se revisan las ventanas cortas perdidas');
        return cuenta;
      }
      console.error(`[cola] revisar ventana de ${phone} falló:`, err.message);
    }
  }
  // Horas pedidas de días que ya pasaron sin ninguna llamada en cola: se borran.
  for (const [phone, c] of citas) {
    if (!conFila.has(phone) && schedule.ymdInTz(new Date(c.at)) < hoy) {
      await clienteConfig.setCita(phone, null, { updatedBy: 'sistema (cola)' }).catch(() => {});
      cuenta.citas_vencidas = (cuenta.citas_vencidas || 0) + 1;
    }
  }
  return cuenta;
}

/**
 * ¿Se llama a este cliente ahora? Con la cartera de este momento, no la de
 * cuando se encoló. Quien pagó toda su deuda desaparece de la cartera (no se
 * ve ni se puede tocar): a ese no se le llama nunca.
 * @returns {{ accion: 'llamar'|'esperar'|'cancelar', motivo?: string, vivo?: object }}
 */
function decidirAlMarcar(item, { clientes, pruebasSet, forzado }) {
  // Sin cartera (la fuente falló o llegó vacía) no se sabe quién debe: no se marca.
  if (!clientes || !clientes.length) return { accion: 'esperar', motivo: 'sin cartera cargada' };
  const vivo = clientes.find((c) => String(c.phone) === String(item.phone));
  if (!vivo) {
    const esPrueba = pruebasSet && pruebasSet.has(pruebas.phoneKey(item.phone));
    if (esPrueba) return { accion: 'llamar' };
    return { accion: 'cancelar', motivo: 'ya no está en la cartera (deuda total en 0)' };
  }
  if ((vivo.deuda_vencida || 0) <= 0 && !forzado) return { accion: 'cancelar', motivo: 'sin vencido al marcar', vivo };
  return { accion: 'llamar', vivo };
}

async function tick() {
  if (corriendo) return;                       // evita solapamiento
  if (!calls.callsEnabled) return;             // sin N8N_CALL_URL no hace nada

  const cfg = await schedule.get();
  if (!cfg.enabled) return;
  const horarios = await clienteConfig.getHorarioMap();
  const citas = await clienteConfig.getCitaMap();
  // Fuera del horario general, de todos los horarios propios y de toda hora pedida: pausa.
  if (!algunaAbierta(cfg, horarios, new Date(), citas)) return;

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

    // Abiertas ahora, la de menos tiempo disponible primero (ver ordenCola).
    const rows = await db.select(TABLE, '?select=*&estado=eq.pendiente&order=created_at.asc');
    const item = elegirSiguiente(rows, horarios, cfg, new Date(), citas);
    if (!item) return;
    lastLaunchAt = Date.now();

    const agente = item.agente || 'principal';

    // Deuda al momento de marcar (no la de cuando se encoló): si ya no tiene
    // vencido, no se llama; si era un follow up, su promesa queda cumplida.
    const { clientes } = await getCachedData();
    const forzado = agente === 'seguimiento' && (await clienteConfig.getForzadosSet()).has(String(item.phone));
    const d = decidirAlMarcar(item, { clientes, pruebasSet: await pruebas.phones().catch(() => new Set()), forzado });
    if (d.accion === 'esperar') {
      console.warn(`[cola] ⏸  ${d.motivo}: no se marca hasta que vuelva la cartera`);
      return;
    }
    if (d.accion === 'cancelar') {
      await db.update(TABLE, `?id=eq.${item.id}`, { estado: 'cancelada', detalle: d.motivo, enviada_at: new Date().toISOString() });
      if (item.promesa_id) {
        await db.update('promesa_pago', `?id=eq.${encodeURIComponent(item.promesa_id)}`, { estado: 'cumplida', cerrada_at: new Date().toISOString(), motivo_cierre: d.motivo });
        await clienteConfig.salirEstado(String(item.phone));
      }
      console.log(`[cola] ⏭  ${item.phone}: ${d.motivo}, no se llama`);
      return;
    }
    const vivo = d.vivo;

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
      // Si salió por la hora que pidió, esa hora ya se usó.
      const cita = citas.get(String(item.phone));
      if (cita && schedule.ymdInTz(new Date(cita.at)) <= schedule.ymdInTz()) await clienteConfig.setCita(item.phone, null, { updatedBy: 'sistema (cola)' }).catch(() => {});
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
    db.select(TABLE, '?select=id,phone,nombre,agente,created_at&estado=eq.pendiente&order=created_at.asc'),
    db.select(TABLE, `?select=id,estado&estado=in.(enviada,error)&enviada_at=gte.${new Date(Date.now() - 86400000).toISOString()}`),
  ]);
  const pendientes = pend || [];
  const ultimas = hoy || [];
  const cfg = await schedule.get();
  const horarios = await clienteConfig.getHorarioMap();
  const citas = await clienteConfig.getCitaMap();
  // Consulta las llamadas activas ahora (si VAPI está configurado).
  const activas = vapi.vapiEnabled ? await vapi.activeCalls().catch(() => null) : null;
  const sig = elegirSiguiente(pendientes, horarios, cfg, new Date(), citas);
  // En cola con horario propio cerrado ahora: esperan su ventana.
  const esperandoHorario = pendientes.filter((r) => {
    const h = horarios.get(String(r.phone));
    return h && schedule.bloquesCliente(cfg, h) && !schedule.abiertoPara(cfg, h);
  }).length;
  return {
    pendientes: pendientes.length,
    proximo: sig ? { phone: sig.phone, nombre: sig.nombre, agente: sig.agente || 'principal', horarioPropio: horarios.has(String(sig.phone)) } : null,
    esperandoHorario,
    clientesConHorario: horarios.size,
    followUpsEnCola: pendientes.filter((r) => r.agente === 'seguimiento').length,
    enviadas24h: ultimas.filter((r) => r.estado === 'enviada').length,
    errores24h: ultimas.filter((r) => r.estado === 'error').length,
    scheduleEnabled: cfg.enabled,
    enHorario: schedule.inWindow(cfg),
    algunaAbierta: algunaAbierta(cfg, horarios),
    horario: horarioTexto(cfg),
    modo: vapi.vapiEnabled ? 'concurrencia' : 'ritmo',
    maxConcurrent: MAX_CONCURRENT,
    activas,                                  // llamadas en curso ahora (o null)
    minutosEstimados: pendientes.length,      // aprox.
    activo: calls.callsEnabled,
  };
}

/**
 * La cola completa, en el orden en que el bot la va a llamar.
 * estado: 'lista' (puede salir ya) | 'esperando_horario' (su horario propio está
 * cerrado) | 'fuera_de_horario' (el horario general está cerrado o apagado).
 */
async function lista(limit = 500) {
  const rows = await db.select(TABLE, '?select=*&estado=eq.pendiente&order=created_at.asc');
  const cfg = await schedule.get();
  const horarios = await clienteConfig.getHorarioMap();
  const citas = await clienteConfig.getCitaMap();
  const orden = ordenCola(rows, horarios, cfg, new Date(), citas);
  const items = orden.slice(0, Math.max(1, limit)).map(({ r, propio, abierto, tipo, disponible, espera, desde, hasta, dia }, i) => ({
    id: r.id,
    pos: i + 1,
    phone: r.phone,
    nombre: r.nombre,
    empresa: r.empresa,
    deuda_vencida: Number(r.deuda_vencida) || 0,
    agente: r.agente || 'principal',
    origen: r.origen,
    encolada_por: r.encolada_por,
    created_at: r.created_at,
    fecha_prometida: r.fecha_prometida || null,
    horario: propio,
    cita: tipo === 'cita' ? { dia, desde, hasta } : null,
    disponible: abierto ? disponible : null,
    movida: r.movida || 0,
    detalle: r.movida ? r.detalle : null,
    estado: !cfg.enabled ? 'fuera_de_horario' : abierto ? 'lista' : espera === 'cita' ? 'esperando_cita' : propio ? 'esperando_horario' : 'fuera_de_horario',
  }));
  return { total: orden.length, items, horario: horarioTexto(cfg), enabled: cfg.enabled };
}

/** Quita UNA llamada pendiente de la cola. Devuelve la fila (o null si ya no estaba). */
async function quitar(id, por = null) {
  const [row] = (await db.select(TABLE, `?select=*&id=eq.${encodeURIComponent(id)}&estado=eq.pendiente`)) || [];
  if (!row) return null;
  await db.update(TABLE, `?id=eq.${encodeURIComponent(id)}`, {
    estado: 'cancelada', detalle: `quitada a mano${por ? ` (${por})` : ''}`, enviada_at: new Date().toISOString(),
  });
  console.log(`[cola] quitada a mano: ${row.phone} (${row.nombre || 's/n'})${por ? ` por ${por}` : ''}`);
  return row;
}

/** Cancela todas las pendientes. */
async function cancelarTodo() {
  const n = await countPendientes();
  await db.update(TABLE, '?estado=eq.pendiente', { estado: 'cancelada', enviada_at: new Date().toISOString() });
  console.log(`[cola] ${n} pendientes canceladas`);
  return { canceladas: n };
}

module.exports = { enqueue, tick, decidirAlMarcar, revisarPerdidas, status, lista, quitar, cancelarTodo, autoEnqueueEnabled, ordenCola, elegirSiguiente, algunaAbierta, TZ };
