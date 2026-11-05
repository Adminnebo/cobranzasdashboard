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
 * (decidir, siguienteIntento, fechaDeLlamada) para poder probarla sin base.
 */

const db = require('./supabaseDb');
const queue = require('./queue');
const schedule = require('./schedule');
const clienteConfig = require('./clienteConfig');
const pruebas = require('./pruebas');
const iaCosto = require('./iaCosto');
const fichas = require('./fichas');
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
// Quien paga toda su deuda desaparece de la cartera. Antes de darlo por pagado
// tiene que faltar este tiempo seguido, y la cartera tiene que haber llegado
// completa (no menos de la mitad de la más grande vista): así una lectura a
// medias de la fuente no cierra promesas de gente que sigue debiendo.
const AUSENTE_MINUTOS = parseInt(process.env.AUSENTE_MINUTOS || '60', 10);
const ausentes = new Map(); // phone -> desde cuándo falta (ms), en memoria
let mayorCartera = 0;
function carteraCompleta(n) {
  mayorCartera = Math.max(mayorCartera, n);
  return n > 0 && n >= mayorCartera * 0.5;
}
function ausenteConfirmado(phone, ahoraMs, carteraOk) {
  if (!carteraOk) return false;
  if (!ausentes.has(phone)) ausentes.set(phone, ahoraMs);
  return ahoraMs - ausentes.get(phone) >= AUSENTE_MINUTOS * 60000;
}
const SIN_CARTERA = 'ya no está en la cartera (deuda total en 0)';

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
 * @param ctx       { abierta: promesa abierta del cliente o null, fecha: YYYY-MM-DD|null, tope,
 *                    hoy: YYYY-MM-DD, ahora: Date, cfg: ajustes del follow up }
 * @returns {{ accion: 'nueva_promesa'|'reprogramar'|'dice_pago'|'seguir'|'incumplida'|'escalar'|'nada',
 *             fecha?: string, intento?: number, proximo?: string, reintento?: boolean }}
 */
function decidir(ll, { abierta, fecha, tope, hoy = ymdInTz(new Date()), ahora = new Date(), cfg = {} }) {
  const intencion = ll.intencion_pago;
  if (intencion === 'ya_pago') return { accion: 'dice_pago' };

  const esFollowUp = ll.agente === 'seguimiento' && abierta && abierta.estado === 'en_seguimiento';
  if (esFollowUp) {
    const intento = abierta.intento || 1;
    // El follow up se hizo porque la promesa NO se cumplió: cuenta como incumplida.
    // Una fecha nueva es lo único que corta la ventana (y empieza una nueva).
    if (fecha) return intento >= tope ? { accion: 'escalar' } : { accion: 'reprogramar', fecha, intento: intento + 1 };
    // Sin fecha (no contestó, o contestó sin dar una): sigue intentando dentro de la ventana.
    return siguienteIntento(abierta, { contesto: intencion !== 'no_contesta', hoy, ahora, cfg, tope });
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

/** ¿A esa hora todavía queda horario general ese día? (sin bloques: sí) */
function quedaHorario(cuando, c) {
  const blocks = Array.isArray(c.blocks) ? c.blocks : [];
  if (!blocks.length) return true;
  const m = schedule.partsInTz(cuando).mins;
  const aMin = (hhmm) => { const [h, mm] = String(hhmm).split(':').map(Number); return h * 60 + mm; };
  return blocks.some((b) => aMin(b.end) > m);
}

/**
 * Ventana de follow up: tras un intento sin fecha nueva, cuándo es el siguiente.
 *  - el primer día, si no contestó (o si contestó sin fecha y así está configurado),
 *    reintenta a las X horas, hasta N veces, si todavía queda horario ese día;
 *  - si no, una llamada cada K días (de calendario), al empezar el día;
 *  - si ese día ya cae fuera de la ventana, se acabó: incumplida (o a una persona si era la última promesa).
 */
function siguienteIntento(p, { contesto, hoy, ahora, cfg, tope }) {
  const c = { ...schedule.DEFAULT, ...(cfg || {}) };
  const desde = p.ventana_desde ? String(p.ventana_desde).slice(0, 10) : hoy;
  const hasta = p.ventana_hasta ? String(p.ventana_hasta).slice(0, 10) : schedule.finVentana(desde, c);
  const intento = p.intento || 1;
  const fin = () => (intento >= tope ? { accion: 'escalar' } : { accion: 'incumplida' });
  if (hoy === desde && (!contesto || c.fuSinFechaMismoDia) && (p.reintentos || 0) < c.fuReintentosDia1) {
    const cuando = new Date(ahora.getTime() + c.reintentoHoras * 3600000);
    if (ymdInTz(cuando) === hoy && quedaHorario(cuando, c)) return { accion: 'seguir', proximo: cuando.toISOString(), reintento: true };
  }
  const dia = sumarDias(hoy, c.fuCadaDias);
  if (dia > hasta) return fin();
  return { accion: 'seguir', proximo: inicioDelDia(dia).toISOString(), reintento: false };
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
    const d = decidir(ll, { abierta, fecha, tope: cfg.promesaTope, cfg });
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
    case 'seguir': {
      const patch = { proximo_intento_at: d.proximo };
      if (d.reintento) patch.reintentos = (abierta.reintentos || 0) + 1;
      await db.update(TABLE, `?id=eq.${abierta.id}`, patch);
      abiertas.set(phone, { ...abierta, ...patch });
      return;
    }
    case 'incumplida': {
      await cerrar(abierta, 'incumplida', 'se acabó la ventana de follow up sin fecha nueva');
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
// Último follow up en cola del cliente (por teléfono: si ya tenía uno pendiente,
// la cola no crea otro y ese no lleva el id de esta promesa).
async function ultimaEnCola(phone) {
  const rows = await db.select('llamada_cola', `?select=estado,enviada_at,created_at&phone=eq.${encodeURIComponent(phone)}&agente=eq.seguimiento&order=created_at.desc&limit=1`);
  return (rows && rows[0]) || null;
}

/**
 * Encola el follow up. Si la cola no lo acepta (número marcado como IVR o
 * buzón), la promesa se cierra sin llamada en vez de contarse como "no
 * contestó", y el cliente queda fuera del follow up y apagado.
 * @returns {boolean} si quedó en cola
 */
async function encolarFollowUp(p, cliente, extra = {}) {
  const r = await queue.enqueue(
    [{ ...cliente, promesa_id: String(p.id), fecha_prometida: p.fecha_prometida }],
    'seguimiento', null, 'seguimiento',
  );
  if (!r.encoladas && !r.yaEnCola) {
    await cerrar(p, 'sin_llamada', r.omitidosIvr ? 'no se llama: número marcado como IVR o buzón' : 'la cola no aceptó la llamada');
    await clienteConfig.salirEstado(String(p.phone), { apagado: true });
    return false;
  }
  await db.update(TABLE, `?id=eq.${p.id}`, { estado: 'en_seguimiento', seguimiento_at: new Date().toISOString(), proximo_intento_at: null, ...extra });
  return true;
}

/** Se acabó la ventana: los follow ups que quedaron en cola de ese cliente ya no salen. */
async function cancelarFollowUpsEnCola(phone, motivo) {
  await db.update('llamada_cola', `?phone=eq.${encodeURIComponent(phone)}&agente=eq.seguimiento&estado=eq.pendiente`,
    { estado: 'cancelada', detalle: motivo });
}

async function revisarAbiertas(clientesPorTel, cfg, { ahora: ahoraFecha = new Date(), carteraOk = true } = {}) {
  const hoy = ymdInTz(ahoraFecha);
  const ahora = Date.now();
  const abiertas = await abiertasPorTelefono();
  const cuenta = {};
  const sumar = (k) => { cuenta[k] = (cuenta[k] || 0) + 1; };

  for (const [phone, p] of abiertas) {
    const c = clientesPorTel.get(phone);
    try {
      if (!c) {
        // Pagó toda la deuda: desapareció de la cartera. Se cierra como cumplida.
        if (ausenteConfirmado(phone, ahoraFecha.getTime(), carteraOk)) {
          await cerrar(p, 'cumplida', SIN_CARTERA);
          await clienteConfig.salirEstado(phone);
          ausentes.delete(phone);
          sumar('cumplidas_sin_cartera');
        }
        continue;
      }
      ausentes.delete(phone);
      const fecha = String(p.fecha_prometida).slice(0, 10);
      if ((c.deuda_vencida || 0) <= 0 && !c._forzar) {
        if (fecha <= hoy || p.estado === 'en_seguimiento') {
          await cerrar(p, 'cumplida', 'sin vencido');
          await clienteConfig.salirEstado(phone);
          sumar('cumplidas');
        }
        continue;
      }
      if (p.estado === 'pendiente') {
        if (fecha > hoy) continue;
        // El follow up sale N días hábiles después de la fecha prometida (margen
        // de Ajustes, mínimo 1): "pago hoy" → el siguiente día hábil. Ese día
        // empieza la ventana de follow up (días de calendario).
        const desde = schedule.fechaFollowUp(fecha, cfg);
        if (desde > hoy) continue;
        const hasta = schedule.finVentana(desde, cfg);
        if (hoy > hasta) {
          // Nunca se pudo llamar en su ventana (sistema caído, llamadas apagadas).
          await cerrar(p, 'vieja', `se acabó su ventana de follow up sin poder llamarlo (${desde} a ${hasta})`);
          await clienteConfig.salirEstado(phone);
          sumar('viejas');
          continue;
        }
        sumar((await encolarFollowUp(p, c, { ventana_desde: desde, ventana_hasta: hasta, reintentos: 0 })) ? 'follow_ups_encolados' : 'sin_llamada');
        continue;
      }
      // en_seguimiento. Las que ya estaban en follow up antes de la ventana la empiezan hoy.
      if (!p.ventana_hasta) {
        const desde = hoy;
        const hasta = schedule.finVentana(desde, cfg);
        await db.update(TABLE, `?id=eq.${p.id}`, { ventana_desde: desde, ventana_hasta: hasta });
        p.ventana_desde = desde; p.ventana_hasta = hasta;
      }
      if (hoy > String(p.ventana_hasta).slice(0, 10)) {
        // Se acabó la ventana sin fecha nueva: vuelve al agente principal (o a una persona si era la última).
        await cancelarFollowUpsEnCola(phone, 'se acabó la ventana de follow up');
        const d = (p.intento || 1) >= cfg.promesaTope ? { accion: 'escalar' } : { accion: 'incumplida' };
        await aplicar(d, { ll: { phone }, abierta: p, cliente: c, cfg, abiertas: new Map() });
        sumar(`fin_ventana_${d.accion}`);
        continue;
      }
      if (p.proximo_intento_at) {
        if (Date.parse(p.proximo_intento_at) <= ahora) sumar((await encolarFollowUp(p, c)) ? 'reintentos_encolados' : 'sin_llamada');
        continue;
      }
      // Enviado y sin resultado: tras unas horas cuenta como no contestado.
      const enCola = await ultimaEnCola(phone);
      if (enCola && enCola.estado === 'pendiente') continue;
      const desde = Date.parse((enCola && (enCola.enviada_at || enCola.created_at)) || p.seguimiento_at || 0);
      const sinResultado = !enCola || enCola.estado === 'error' || ahora - desde > SIN_RESULTADO_HORAS * 3600000;
      if (!sinResultado) continue;
      const d = decidir({ agente: 'seguimiento', intencion_pago: 'no_contesta' }, { abierta: p, fecha: null, tope: cfg.promesaTope, hoy, ahora: ahoraFecha, cfg });
      await aplicar(d, { ll: { phone }, abierta: p, cliente: c, cfg, abiertas: new Map() });
      sumar(`sin_resultado_${d.accion}`);
    } catch (err) {
      console.error(`[promesas] revisar ${phone} falló:`, err.message);
    }
  }
  return cuenta;
}

/**
 * Estados que quedan colgados sin promesa abierta:
 *  - el cliente desapareció de la cartera (pagó todo): vuelve a la normalidad;
 *  - "dice que pagó" y su vencido ya está en 0: era cierto, vuelve a la
 *    normalidad (si más adelante vuelve a tener vencido, lo llama el agente principal).
 * "Pasar a una persona" no se toca: lo decide una persona.
 */
async function limpiarEstados(clientesPorTel, { ahora: ahoraFecha = new Date(), carteraOk = true } = {}) {
  const cuenta = {};
  const estados = await clienteConfig.getEstadoMap();
  if (!estados.size) return cuenta;
  const abiertas = await abiertasPorTelefono();
  for (const [phone, e] of estados) {
    if (abiertas.has(phone)) continue; // la maneja revisarAbiertas
    const c = clientesPorTel.get(phone);
    try {
      if (!c) {
        if (ausenteConfirmado(phone, ahoraFecha.getTime(), carteraOk)) {
          await clienteConfig.salirEstado(phone);
          ausentes.delete(phone);
          cuenta.estados_sin_cartera = (cuenta.estados_sin_cartera || 0) + 1;
        }
        continue;
      }
      ausentes.delete(phone);
      if (e.estado === 'dice_pago' && (c.deuda_vencida || 0) <= 0 && !c._forzar) {
        await clienteConfig.salirEstado(phone);
        cuenta.dice_pago_confirmado = (cuenta.dice_pago_confirmado || 0) + 1;
      }
    } catch (err) {
      console.error(`[promesas] limpiar estado de ${phone} falló:`, err.message);
    }
  }
  return cuenta;
}

// ── Vuelta completa ──────────────────────────────────────────────────────────
let corriendo = false;

/**
 * @param {object} [opts]
 * @param {boolean} [opts.fresco]  fuerza a leer las llamadas de n8n ahora (botón
 *   "Actualizar ahora"). Sin él usa el caché del panel (≤45 s), así correr cada
 *   minuto no suma consultas a n8n.
 */
async function correr({ fresco = false } = {}) {
  if (corriendo) return { omitida: 'ya está corriendo' };
  if (!db.dbEnabled) return { omitida: 'Supabase no configurado' };
  corriendo = true;
  try {
    const [data, cfg] = await Promise.all([getCachedData(fresco), schedule.get(true)]);
    // Los números de prueba no están en la cartera: el motor los trata como
    // clientes ficticios con vencido, para poder probar el ciclo completo.
    const clientesPorTel = new Map((data.clientes || []).filter((c) => c.phone).map((c) => [String(c.phone), c]));
    for (const c of await pruebas.clientesFicticios(data.clientes || [])) clientesPorTel.set(c.phone, c);
    // "Forzar follow up": clientes reales a los que se les hace el follow up
    // aunque no tengan vencido (pruebas). Siguen contando como reales.
    for (const phone of await clienteConfig.getForzadosSet()) {
      const c = clientesPorTel.get(phone);
      if (c) clientesPorTel.set(phone, { ...c, _forzar: true });
    }
    const llamadas = [...(data.llamadas || []), ...(data.llamadasPrueba || [])];
    const r1 = await procesarLlamadas(llamadas, clientesPorTel, cfg);
    const carteraOk = carteraCompleta((data.clientes || []).filter((c) => c.phone).length);
    const r2 = await revisarAbiertas(clientesPorTel, cfg, { carteraOk });
    Object.assign(r2, await limpiarEstados(clientesPorTel, { carteraOk }));
    // Ficha de cada llamada (retiro, hora pedida, horario que se repite). Aparte:
    // si la IA falla, las promesas siguen igual y la ficha se reintenta luego.
    try { await fichas.procesar(llamadas, cfg); }
    catch (err) { console.error('[fichas] falló:', err.message); }
    // Cobro en Sword del gasto de la IA de los días ya cerrados (si está prendido).
    try { await iaCosto.cobrar(); }
    catch (err) { console.error('[ia-costo] falló:', err.message); }
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

/**
 * Reabre una promesa cerrada (super admins, para pruebas): vuelve a "Esperando
 * la fecha" con sus reintentos en cero y el cliente vuelve al estado "promesa".
 * En la próxima revisión, si la fecha ya llegó, el motor encola su follow up.
 */
async function reabrir(id, por = null) {
  const [p] = (await db.select(TABLE, `?select=*&id=eq.${encodeURIComponent(id)}`)) || [];
  if (!p) throw Object.assign(new Error('Esa promesa no existe'), { status: 404 });
  if (ABIERTAS.includes(p.estado)) throw Object.assign(new Error('La promesa ya está abierta'), { status: 409 });
  const otra = (await abiertasPorTelefono()).get(String(p.phone));
  if (otra) throw Object.assign(new Error('Ese cliente ya tiene otra promesa abierta'), { status: 409 });
  await db.update(TABLE, `?id=eq.${p.id}`, {
    estado: 'pendiente', cerrada_at: null, motivo_cierre: null,
    reintentos: 0, proximo_intento_at: null, seguimiento_at: null,
  });
  await clienteConfig.entrarEstado(String(p.phone), 'promesa', String(p.fecha_prometida).slice(0, 10));
  console.log(`[promesas] reabierta ${p.id} (${p.phone})${por ? ` por ${por}` : ''}`);
  return { ...p, estado: 'pendiente' };
}

/** Lista para la pestaña Promesas (más recientes primero). */
async function lista(limit = 300) {
  const rows = await db.select(TABLE, `?select=*&order=created_at.desc&limit=${Math.min(1000, Math.max(1, limit))}`);
  return rows || [];
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
  limpiarEstados,
  correr, resumen, lista, reabrir, cancelarPorCambioManual,
  // internas (pruebas con base en memoria)
  procesarLlamadas, revisarAbiertas,
  // puras (pruebas)
  decidir, siguienteIntento, fechaDeLlamada, inicioDelDia, llamadaKey,
};
