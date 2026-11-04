/**
 * Motor de promesas de pago y follow up.
 *
 * Corre cada pocos minutos (PROMESA_CRON). En cada vuelta:
 *
 *  1. Lee las llamadas nuevas (de los últimos días, una sola vez cada una) y
 *     decide qué pasó:
 *       - el cliente dio una fecha  -> promesa (se apaga el agente normal; ese
 *                                      día lo llama solo el follow up)
 *       - dijo que ya pagó          -> estado "dice que pagó" (apagado; el equipo
 *                                      lo vuelve a prender si no pagó)
 *       - follow up sin contestar   -> reintento: 1 ese día y 1 al siguiente
 *       - follow up sin fecha       -> vuelve a la lista normal, como estaba
 *       - tope de promesas seguidas -> "pasar a una persona" (apagado)
 *     Si el análisis de Sword llegó vacío, saca intención y fecha de la
 *     transcripción con IA.
 *
 *  2. Revisa las promesas abiertas: el día prometido, si el cliente sigue con
 *     vencido, encola el follow up (entra en los lotes del horario como las
 *     demás llamadas); si ya no tiene vencido, la promesa queda cumplida.
 *
 * La decisión (qué hacer con cada llamada) está en funciones puras
 * (decidir, fechaDeLlamada, proximoReintento) para poder probarla sin base.
 */

const db = require('./supabaseDb');
const queue = require('./queue');
const schedule = require('./schedule');
const clienteConfig = require('./clienteConfig');
const pruebas = require('./pruebas');
const { getCachedData } = require('./cache');

const TABLE = 'promesa_pago';
const T_PROCESADA = 'llamada_procesada';
const TZ = process.env.CRON_TZ || 'America/Santo_Domingo';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
// Llamadas que el motor mira: las de los últimos N días (las más viejas ya se
// procesaron o son de antes del motor).
const VENTANA_DIAS = parseInt(process.env.PROMESA_VENTANA_DIAS || '3', 10);
// Si un follow up se envió y a las N horas no llegó su resultado, se cuenta
// como no contestado.
const SIN_RESULTADO_HORAS = parseInt(process.env.PROMESA_SIN_RESULTADO_HORAS || '3', 10);
const MAX_REINTENTOS = 2; // 1 el mismo día + 1 al día siguiente

const ABIERTAS = ['pendiente', 'en_seguimiento'];
// Intenciones que nunca son promesa aunque traigan una fecha.
const NO_PROMESA = new Set(['ya_pago', 'no_contesta', 'sin_intencion', 'disputa', 'ivr']);

// ── Fechas ───────────────────────────────────────────────────────────────────
const ymdInTz = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
const sumarDias = (ymd, n) => new Date(new Date(ymd + 'T12:00:00Z').getTime() + n * 86400000).toISOString().slice(0, 10);

/** Medianoche (inicio) de un día YYYY-MM-DD en la zona del panel, como Date. */
function inicioDelDia(ymd) {
  const off = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'shortOffset' })
    .formatToParts(new Date(ymd + 'T12:00:00Z')).find((p) => p.type === 'timeZoneName').value; // "GMT-4"
  const m = off.match(/GMT([+-]\d+)(?::(\d+))?/);
  const h = m ? parseInt(m[1], 10) : 0;
  const mm = m && m[2] ? parseInt(m[2], 10) : 0;
  const sign = h < 0 ? '-' : '+';
  const pad = (x) => String(Math.abs(x)).padStart(2, '0');
  return new Date(`${ymd}T00:00:00${sign}${pad(h)}:${pad(mm)}`);
}

// ── Decisiones (puras) ───────────────────────────────────────────────────────
const llamadaKey = (l) => (l.id != null && l.id !== '' ? `log:${l.id}` : `${l.phone}|${l.created_at}`);

/**
 * Fecha de pago que dejó una llamada (YYYY-MM-DD) o null.
 * @param intencion       intención normalizada
 * @param fechaParseada   la fecha que sacó la IA del texto ("el viernes" -> ISO)
 * @param fechaLlamada    created_at de la llamada (para "paga hoy" sin fecha)
 */
function fechaDeLlamada(intencion, fechaParseada, fechaLlamada) {
  if (NO_PROMESA.has(intencion)) return null;
  if (fechaParseada) return fechaParseada;
  if (intencion === 'pago_inmediato' && fechaLlamada) return ymdInTz(new Date(fechaLlamada));
  return null;
}

/**
 * Qué hacer con una llamada.
 * @param ll        { agente, intencion_pago }
 * @param ctx       { abierta: promesa abierta del cliente o null, fecha: YYYY-MM-DD|null, tope }
 * @returns {{ accion: 'nueva_promesa'|'reprogramar'|'dice_pago'|'reintento'|'incumplida'|'escalar'|'nada', fecha?: string, intento?: number }}
 */
function decidir(ll, { abierta, fecha, tope }) {
  const intencion = ll.intencion_pago;
  if (intencion === 'ya_pago') return { accion: 'dice_pago' };

  const esFollowUp = ll.agente === 'seguimiento' && abierta && abierta.estado === 'en_seguimiento';
  if (esFollowUp) {
    const intento = abierta.intento || 1;
    // El follow up se hizo porque la promesa NO se cumplió: cuenta como incumplida.
    if (fecha) return intento >= tope ? { accion: 'escalar' } : { accion: 'reprogramar', fecha, intento: intento + 1 };
    if (intencion === 'no_contesta') {
      if ((abierta.reintentos || 0) < MAX_REINTENTOS) return { accion: 'reintento' };
      return intento >= tope ? { accion: 'escalar' } : { accion: 'incumplida' };
    }
    return intento >= tope ? { accion: 'escalar' } : { accion: 'incumplida' };
  }

  // Llamada del agente normal (o una manual): una fecha nueva es una promesa.
  // Si ya tenía una abierta, la reemplaza sin contarla como incumplida.
  if (fecha) {
    return abierta
      ? { accion: 'reprogramar', fecha, intento: abierta.intento || 1 }
      : { accion: 'nueva_promesa', fecha, intento: 1 };
  }
  return { accion: 'nada' };
}

/** Cuándo reintentar un follow up no contestado: el mismo día y luego al siguiente. */
function proximoReintento(reintentosHechos, ahora, horas) {
  if (reintentosHechos === 0) return new Date(ahora.getTime() + horas * 3600000);
  return inicioDelDia(sumarDias(ymdInTz(ahora), 1));
}

// ── IA ───────────────────────────────────────────────────────────────────────
function openai() {
  if (!process.env.OPENAI_API_KEY) return null;
  const OpenAI = require('openai');
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60000 });
}

async function jsonIA(system, user) {
  const client = openai();
  if (!client) return null;
  const resp = await client.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
  return JSON.parse(resp.choices[0].message.content);
}

/**
 * Convierte "el viernes", "mañana", "el 15"... en YYYY-MM-DD usando la fecha de
 * la llamada como referencia. Una sola consulta para todas.
 * @param {Array<{id, texto, fechaLlamada}>} items
 * @returns {Map<id, 'YYYY-MM-DD'|null>}
 */
async function parsearFechas(items) {
  const out = new Map();
  if (!items.length) return out;
  try {
    const parsed = await jsonIA(
      'Convierte promesas de pago en texto libre (español) a una fecha exacta ISO (YYYY-MM-DD). ' +
      'Usa la fecha de la llamada como referencia para resolver "mañana", "el 15", "la quincena", ' +
      '"fin de mes", "el próximo lunes", etc. Si el texto no permite deducir una fecha concreta ' +
      '(ej. "pronto", "cuando pueda", vacío), devuelve null para ese id. ' +
      'Responde SOLO un JSON: {"fechas":[{"id":"<id>","fecha":"YYYY-MM-DD"|null}]}',
      JSON.stringify(items.map((i) => ({ id: String(i.id), fecha_llamada: i.fechaLlamada, texto: i.texto })), null, 1),
    );
    if (!parsed) console.warn('[promesas] sin OPENAI_API_KEY: no se pueden convertir las fechas');
    for (const f of (parsed && parsed.fechas) || []) {
      out.set(String(f.id), f.fecha && /^\d{4}-\d{2}-\d{2}$/.test(f.fecha) ? f.fecha : null);
    }
  } catch (err) {
    console.error('[promesas] conversión de fechas con IA falló:', err.message);
  }
  return out;
}

/**
 * Respaldo cuando el análisis de Sword llegó vacío: saca tipo de compromiso y
 * fecha de la transcripción.
 * @returns {Map<id, {tipo_compromiso, fecha_texto}>}
 */
async function extraerDeTranscripciones(items) {
  const out = new Map();
  if (!items.length) return out;
  try {
    const parsed = await jsonIA(
      'Lees transcripciones de llamadas de cobranza (español). Camila es la agente. Para cada una devuelve ' +
      'tipo_compromiso (EXACTAMENTE uno de: pago_inmediato, fecha_especifica, promesa_vaga, negociacion, ya_pago, ' +
      'disputa, sin_intencion, evasivo, ninguno, no_contesta) y fecha_texto (la fecha de pago tal como la dijo el ' +
      'cliente, sin convertir; "" si no dio). Si el cliente dio una fecha nueva en un seguimiento, usa esa. ' +
      'Responde SOLO un JSON: {"llamadas":[{"id":"<id>","tipo_compromiso":"...","fecha_texto":"..."}]}',
      JSON.stringify(items.map((i) => ({ id: String(i.id), transcripcion: String(i.transcripcion).slice(0, 4000) })), null, 1),
    );
    for (const r of (parsed && parsed.llamadas) || []) {
      out.set(String(r.id), { tipo_compromiso: String(r.tipo_compromiso || '').trim(), fecha_texto: String(r.fecha_texto || '').trim() });
    }
  } catch (err) {
    console.error('[promesas] extracción de transcripciones con IA falló:', err.message);
  }
  return out;
}

// ── Base ─────────────────────────────────────────────────────────────────────
async function abiertasPorTelefono() {
  const rows = await db.select(TABLE, `?select=*&estado=in.(${ABIERTAS.join(',')})&order=created_at.asc`);
  const map = new Map();
  for (const r of rows || []) map.set(String(r.phone), r); // si hubiera dos, queda la más nueva
  return map;
}

async function cerrar(p, estado, motivo) {
  await db.update(TABLE, `?id=eq.${p.id}`, { estado, cerrada_at: new Date().toISOString(), motivo_cierre: motivo || null });
}

async function crearPromesa({ ll, cliente, fecha, intento, anterior, origen }) {
  const rows = await db.insertReturn(TABLE, {
    phone: String(ll.phone),
    nombre: ll.name || (cliente && cliente.name) || null,
    llamada_id: ll.id != null ? String(ll.id) : null,
    llamada_key: llamadaKey(ll),
    fecha_llamada: ll.created_at || null,
    texto_original: ll.fecha_pago || null,
    fecha_prometida: fecha,
    monto_al_prometer: cliente ? cliente.deuda_vencida : null,
    estado: 'pendiente',
    intento: intento || 1,
    promesa_anterior_id: anterior ? String(anterior.id) : null,
    agente: ll.agente || null,
    origen: origen || 'structured',
  });
  return rows && rows[0];
}

async function yaProcesadas(keys) {
  const hechas = new Set();
  for (let i = 0; i < keys.length; i += 80) {
    const lote = keys.slice(i, i + 80).map((k) => `"${k.replace(/"/g, '')}"`).join(',');
    const rows = await db.select(T_PROCESADA, `?select=llamada_key&llamada_key=in.(${encodeURIComponent(lote)})`);
    for (const r of rows || []) hechas.add(r.llamada_key);
  }
  return hechas;
}

const marcarProcesada = (ll, accion, detalle) =>
  db.upsert(T_PROCESADA, { llamada_key: llamadaKey(ll), phone: String(ll.phone), accion, detalle: detalle || null }, 'llamada_key');

// ── 1. Llamadas nuevas ───────────────────────────────────────────────────────
async function procesarLlamadas(llamadas, clientesPorTel, cfg) {
  const desde = Date.now() - VENTANA_DIAS * 86400000;
  const candidatas = llamadas
    .filter((l) => l.phone && l.created_at && Date.parse(l.created_at) >= desde)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  if (!candidatas.length) return { nuevas: 0 };

  const hechas = await yaProcesadas(candidatas.map(llamadaKey));
  const nuevas = candidatas.filter((l) => !hechas.has(llamadaKey(l)));
  if (!nuevas.length) return { nuevas: 0 };

  // Respaldo IA: contestadas sin intención capturada pero con conversación.
  const sinDato = nuevas.filter((l) => l.intencion_pago === 'sin_dato' && l.resultado !== 'no_answer' && (l.transcripcion || '').length > 40);
  const extraidas = await extraerDeTranscripciones(sinDato.map((l) => ({ id: llamadaKey(l), transcripcion: l.transcripcion })));
  const conDatos = nuevas.map((l) => {
    const x = extraidas.get(llamadaKey(l));
    return x ? { ...l, intencion_pago: x.tipo_compromiso || l.intencion_pago, fecha_pago: x.fecha_texto || l.fecha_pago, _origen: 'ia' } : l;
  });

  // Fechas en texto -> ISO (una consulta para todas).
  const conTexto = conDatos.filter((l) => !NO_PROMESA.has(l.intencion_pago) && (l.fecha_pago || '').trim());
  const fechas = await parsearFechas(conTexto.map((l) => ({ id: llamadaKey(l), texto: l.fecha_pago, fechaLlamada: l.created_at })));

  const abiertas = await abiertasPorTelefono();
  const cuenta = {};
  for (const ll of conDatos) {
    const phone = String(ll.phone);
    const abierta = abiertas.get(phone) || null;
    const fecha = fechaDeLlamada(ll.intencion_pago, fechas.get(llamadaKey(ll)) || null, ll.created_at);
    const d = decidir(ll, { abierta, fecha, tope: cfg.promesaTope });
    const cliente = clientesPorTel.get(phone) || null;
    try {
      await aplicar(d, { ll, abierta, cliente, cfg, abiertas });
      await marcarProcesada(ll, d.accion, d.fecha || null);
      cuenta[d.accion] = (cuenta[d.accion] || 0) + 1;
    } catch (err) {
      // Sin marcar como procesada: se reintenta en la próxima vuelta.
      console.error(`[promesas] ${phone} (${d.accion}) falló:`, err.message);
    }
  }
  return { nuevas: conDatos.length, ...cuenta };
}

async function aplicar(d, { ll, abierta, cliente, cfg, abiertas }) {
  const phone = String(ll.phone);
  switch (d.accion) {
    case 'nueva_promesa': {
      const p = await crearPromesa({ ll, cliente, fecha: d.fecha, intento: 1, origen: ll._origen });
      await clienteConfig.entrarEstado(phone, 'promesa', d.fecha);
      if (p) abiertas.set(phone, p);
      return;
    }
    case 'reprogramar': {
      await cerrar(abierta, 'reprogramada', `nueva fecha ${d.fecha}`);
      const p = await crearPromesa({ ll, cliente, fecha: d.fecha, intento: d.intento, anterior: abierta, origen: ll._origen });
      await clienteConfig.entrarEstado(phone, 'promesa', d.fecha);
      if (p) abiertas.set(phone, p); else abiertas.delete(phone);
      return;
    }
    case 'dice_pago': {
      if (abierta) { await cerrar(abierta, 'dice_pago', 'el cliente dice que ya pagó'); abiertas.delete(phone); }
      await clienteConfig.entrarEstado(phone, 'dice_pago', ll.created_at ? ymdInTz(new Date(ll.created_at)) : null);
      return;
    }
    case 'reintento': {
      const hechos = abierta.reintentos || 0;
      const cuando = proximoReintento(hechos, new Date(), cfg.reintentoHoras);
      await db.update(TABLE, `?id=eq.${abierta.id}`, { reintentos: hechos + 1, proximo_intento_at: cuando.toISOString() });
      abiertas.set(phone, { ...abierta, reintentos: hechos + 1, proximo_intento_at: cuando.toISOString() });
      return;
    }
    case 'incumplida': {
      await cerrar(abierta, 'incumplida', 'follow up sin nueva fecha');
      await clienteConfig.salirEstado(phone);
      abiertas.delete(phone);
      return;
    }
    case 'escalar': {
      await cerrar(abierta, 'escalada', `tope de ${cfg.promesaTope} promesas incumplidas`);
      await clienteConfig.entrarEstado(phone, 'escalar', `${cfg.promesaTope} promesas incumplidas`);
      abiertas.delete(phone);
      return;
    }
    default:
  }
}

// ── 2. Promesas abiertas ─────────────────────────────────────────────────────
async function ultimaEnCola(promesaId) {
  const rows = await db.select('llamada_cola', `?select=estado,enviada_at,created_at&promesa_id=eq.${encodeURIComponent(promesaId)}&order=created_at.desc&limit=1`);
  return (rows && rows[0]) || null;
}

async function encolarFollowUp(p, cliente) {
  await queue.enqueue(
    [{ ...cliente, promesa_id: String(p.id), fecha_prometida: p.fecha_prometida }],
    'seguimiento', null, 'seguimiento',
  );
  await db.update(TABLE, `?id=eq.${p.id}`, { estado: 'en_seguimiento', seguimiento_at: new Date().toISOString(), proximo_intento_at: null });
}

async function revisarAbiertas(clientesPorTel, cfg) {
  const hoy = ymdInTz();
  const corteViejas = sumarDias(hoy, -cfg.promesaMaxAtraso);
  const ahora = Date.now();
  const abiertas = await abiertasPorTelefono();
  const cuenta = {};
  const sumar = (k) => { cuenta[k] = (cuenta[k] || 0) + 1; };

  for (const [phone, p] of abiertas) {
    const c = clientesPorTel.get(phone);
    if (!c) continue; // ya no está en la cartera
    try {
      const fecha = String(p.fecha_prometida).slice(0, 10);
      if ((c.deuda_vencida || 0) <= 0) {
        if (fecha <= hoy || p.estado === 'en_seguimiento') {
          await cerrar(p, 'cumplida', 'sin vencido');
          await clienteConfig.salirEstado(phone);
          sumar('cumplidas');
        }
        continue;
      }
      if (p.estado === 'pendiente') {
        if (fecha > hoy) continue;
        // Prometió hoy para hoy ("pago hoy"): el follow up va al día siguiente,
        // no minutos después de colgar. Los números de prueba no esperan, para
        // poder probar el ciclo completo en el día.
        const diaPromesa = p.fecha_llamada ? ymdInTz(new Date(p.fecha_llamada)) : null;
        if (diaPromesa === hoy && !c._prueba) continue;
        if (fecha < corteViejas) {
          await cerrar(p, 'vieja', `más de ${cfg.promesaMaxAtraso} días de atraso`);
          await clienteConfig.salirEstado(phone);
          sumar('viejas');
          continue;
        }
        await encolarFollowUp(p, c);
        sumar('follow_ups_encolados');
        continue;
      }
      // en_seguimiento
      if (p.proximo_intento_at) {
        if (Date.parse(p.proximo_intento_at) <= ahora) { await encolarFollowUp(p, c); sumar('reintentos_encolados'); }
        continue;
      }
      // Enviado y sin resultado: tras unas horas cuenta como no contestado.
      const enCola = await ultimaEnCola(p.id);
      if (enCola && enCola.estado === 'pendiente') continue;
      const desde = Date.parse((enCola && (enCola.enviada_at || enCola.created_at)) || p.seguimiento_at || 0);
      const sinResultado = !enCola || enCola.estado === 'error' || ahora - desde > SIN_RESULTADO_HORAS * 3600000;
      if (!sinResultado) continue;
      const d = decidir({ agente: 'seguimiento', intencion_pago: 'no_contesta' }, { abierta: p, fecha: null, tope: cfg.promesaTope });
      await aplicar(d, { ll: { phone }, abierta: p, cliente: c, cfg, abiertas: new Map() });
      sumar(`sin_resultado_${d.accion}`);
    } catch (err) {
      console.error(`[promesas] revisar ${phone} falló:`, err.message);
    }
  }
  return cuenta;
}

// ── Vuelta completa ──────────────────────────────────────────────────────────
let corriendo = false;

async function correr() {
  if (corriendo) return { omitida: 'ya está corriendo' };
  if (!db.dbEnabled) return { omitida: 'Supabase no configurado' };
  corriendo = true;
  try {
    const [data, cfg, numerosPrueba] = await Promise.all([getCachedData(true), schedule.get(true), pruebas.list()]);
    // Los números de prueba no están en la cartera: el motor los trata como
    // clientes ficticios con vencido, para poder probar el ciclo completo.
    const clientesPorTel = new Map((data.clientes || []).filter((c) => c.phone).map((c) => [String(c.phone), c]));
    for (const n of numerosPrueba) {
      const phone = pruebas.phoneKey(n.phone);
      if (!clientesPorTel.has(phone)) {
        clientesPorTel.set(phone, { phone, name: 'Prueba', empresa: 'Prueba Nebo', deuda_total: 15000, deuda_vencida: 12500, credito_ofrecido: 0, _prueba: true });
      }
    }
    const llamadas = [...(data.llamadas || []), ...(data.llamadasPrueba || [])];
    const r1 = await procesarLlamadas(llamadas, clientesPorTel, cfg);
    const r2 = await revisarAbiertas(clientesPorTel, cfg);
    const out = { llamadas: r1, promesas: r2 };
    if (r1.nuevas || Object.keys(r2).length) console.log('[promesas]', JSON.stringify(out));
    return out;
  } finally {
    corriendo = false;
  }
}

/**
 * Una persona prendió o apagó al cliente a mano: manda su decisión, así que se
 * cierran sus promesas abiertas (y sus follow ups en cola) sin tocar nada más.
 */
async function cancelarPorCambioManual(phones, por) {
  const lista = [...new Set((phones || []).map(String).filter(Boolean))];
  for (let i = 0; i < lista.length; i += 80) {
    const lote = lista.slice(i, i + 80).join(',');
    await db.update(TABLE, `?phone=in.(${lote})&estado=in.(${ABIERTAS.join(',')})`,
      { estado: 'cancelada', cerrada_at: new Date().toISOString(), motivo_cierre: `cambio manual${por ? ` (${por})` : ''}` });
    await db.update('llamada_cola', `?phone=in.(${lote})&estado=eq.pendiente&agente=eq.seguimiento`,
      { estado: 'cancelada', detalle: 'cambio manual', enviada_at: new Date().toISOString() });
  }
}

/** Resumen para el panel. */
async function resumen() {
  const rows = await db.select(TABLE, '?select=id,estado,fecha_prometida,phone,nombre,monto_al_prometer,intento,reintentos,proximo_intento_at&order=fecha_prometida.desc&limit=500');
  const all = rows || [];
  const n = (e) => all.filter((r) => r.estado === e).length;
  return {
    pendientes: n('pendiente'),
    enSeguimiento: n('en_seguimiento'),
    cumplidas: n('cumplida'),
    incumplidas: n('incumplida'),
    reprogramadas: n('reprogramada'),
    dicePago: n('dice_pago'),
    escaladas: n('escalada'),
    proximas: all.filter((r) => ABIERTAS.includes(r.estado)).slice(0, 20),
  };
}

module.exports = {
  correr, resumen, cancelarPorCambioManual,
  // internas (pruebas con base en memoria)
  procesarLlamadas, revisarAbiertas,
  // puras (pruebas)
  decidir, fechaDeLlamada, proximoReintento, inicioDelDia, llamadaKey, MAX_REINTENTOS,
};
