/**
 * Promesas de pago y seguimiento de incumplidos.
 *
 * Flujo:
 *  1. De las llamadas con intención "fecha_especifica" / "pago_inmediato" y un
 *     `fecha_pago` en texto libre ("el próximo 15", "mañana", "la quincena"),
 *     se extrae la FECHA REAL con IA (gpt-4o-mini) usando la fecha de la llamada
 *     como referencia. Se guarda en la tabla promesa_pago.
 *  2. Cada día se revisan las promesas vencidas (+ GRACIA días). Si el cliente
 *     SIGUE con deuda vencida > 0, la promesa se marca 'incumplida' y se encola
 *     una llamada al SUB-AGENTE de seguimiento.
 *  3. Si ya no tiene deuda vencida, la promesa se marca 'cumplida'.
 */

const db = require('./supabaseDb');
const queue = require('./queue');

const TABLE = 'promesa_pago';
const TZ = process.env.CRON_TZ || 'America/Santo_Domingo';
const GRACIA_DIAS = parseInt(process.env.PROMESA_GRACIA_DIAS || '1', 10);
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// Intenciones que constituyen una promesa con fecha.
const CON_PROMESA = new Set(['fecha_especifica', 'pago_inmediato']);

const ymdInTz = (d = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

// ── Extracción de fecha con IA ───────────────────────────────────────────────
/**
 * Convierte los textos libres de fecha_pago en fechas ISO (YYYY-MM-DD).
 * Manda todas juntas en una sola llamada al modelo (barato).
 * @param {Array<{id, texto, fechaLlamada}>} items
 * @returns {Map<id, 'YYYY-MM-DD'|null>}
 */
async function parsearFechas(items) {
  const out = new Map();
  if (!items.length) return out;
  if (!process.env.OPENAI_API_KEY) {
    console.warn('[promesas] sin OPENAI_API_KEY: no se pueden parsear las fechas de pago');
    return out;
  }

  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60000 });

  const system =
    'Convierte promesas de pago en texto libre (español) a una fecha exacta ISO (YYYY-MM-DD). ' +
    'Usa la fecha de la llamada como referencia para resolver "mañana", "el 15", "la quincena", ' +
    '"fin de mes", "el próximo lunes", etc. Si el texto no permite deducir una fecha concreta ' +
    '(ej. "pronto", "cuando pueda", vacío), devuelve null para ese id. ' +
    'Responde SOLO un JSON: {"fechas":[{"id":"<id>","fecha":"YYYY-MM-DD"|null}]}';

  const user = JSON.stringify(items.map((i) => ({
    id: String(i.id),
    fecha_llamada: i.fechaLlamada,
    texto: i.texto,
  })), null, 1);

  try {
    const resp = await client.chat.completions.create({
      model: MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    const parsed = JSON.parse(resp.choices[0].message.content);
    for (const f of parsed.fechas || []) {
      const ok = f.fecha && /^\d{4}-\d{2}-\d{2}$/.test(f.fecha);
      out.set(String(f.id), ok ? f.fecha : null);
    }
  } catch (err) {
    console.error('[promesas] parseo con IA falló:', err.message);
  }
  return out;
}

// ── 1. Sincronizar promesas desde las llamadas ───────────────────────────────
/**
 * Detecta promesas nuevas en las llamadas y las guarda.
 * @param {Array} llamadas  resultados de llamadas (ya normalizados)
 * @param {Array} clientes  para adjuntar el monto adeudado al momento de prometer
 */
async function sincronizar(llamadas, clientes) {
  const conPromesa = llamadas.filter(
    (l) => CON_PROMESA.has(l.intencion_pago) && l.phone && (l.fecha_pago || '').trim()
  );
  if (!conPromesa.length) return { detectadas: 0, nuevas: 0 };

  // Las que ya tenemos registradas (por teléfono + texto) no se re-procesan.
  const existentes = await db.select(TABLE, '?select=phone,texto_original');
  const yaEstan = new Set((existentes || []).map((r) => `${r.phone}|${r.texto_original}`));

  const pendientes = conPromesa.filter((l) => !yaEstan.has(`${l.phone}|${l.fecha_pago}`));
  if (!pendientes.length) return { detectadas: conPromesa.length, nuevas: 0 };

  const fechas = await parsearFechas(pendientes.map((l) => ({
    id: `${l.phone}|${l.created_at}`,
    texto: l.fecha_pago,
    fechaLlamada: l.created_at,
  })));

  const byPhone = new Map(clientes.map((c) => [c.phone, c]));
  const rows = [];
  for (const l of pendientes) {
    const fecha = fechas.get(`${l.phone}|${l.created_at}`);
    if (!fecha) continue; // no se pudo deducir fecha -> no es una promesa vigilable
    const c = byPhone.get(l.phone);
    rows.push({
      phone: l.phone,
      nombre: l.name || (c && c.name) || null,
      llamada_id: l.id != null ? String(l.id) : null,
      fecha_llamada: l.created_at || null,
      texto_original: l.fecha_pago,
      fecha_prometida: fecha,
      monto_al_prometer: c ? c.deuda_vencida : null,
      estado: 'pendiente',
    });
  }

  if (rows.length) await db.upsert(TABLE, rows, 'phone,fecha_prometida');
  console.log(`[promesas] ${rows.length} promesa(s) nueva(s) registradas`);
  return { detectadas: conPromesa.length, nuevas: rows.length };
}

// ── 2. Revisar promesas vencidas y encolar al sub-agente ─────────────────────
/**
 * Marca cumplidas/incumplidas y encola el seguimiento de las incumplidas.
 * Regla: pasó (fecha_prometida + GRACIA_DIAS) y el cliente SIGUE con vencido > 0.
 */
async function revisarIncumplidas(clientes) {
  const hoy = ymdInTz();
  const limite = new Date(new Date(hoy + 'T12:00:00Z').getTime() - GRACIA_DIAS * 86400000);
  const limiteYmd = limite.toISOString().slice(0, 10);

  // Promesas pendientes cuya fecha ya pasó (con la gracia aplicada).
  const rows = await db.select(TABLE, `?select=*&estado=eq.pendiente&fecha_prometida=lte.${limiteYmd}`);
  if (!rows || !rows.length) return { revisadas: 0, cumplidas: 0, incumplidas: 0, encoladas: 0 };

  const byPhone = new Map(clientes.map((c) => [c.phone, c]));
  const cumplidas = [];
  const incumplidas = [];

  for (const p of rows) {
    const c = byPhone.get(String(p.phone));
    if (!c) continue;                       // ya no está en la cartera -> se ignora
    if ((c.deuda_vencida || 0) > 0) incumplidas.push({ promesa: p, cliente: c });
    else cumplidas.push(p);                 // ya no debe vencido -> pagó
  }

  // Marcar cumplidas
  for (const p of cumplidas) {
    await db.update(TABLE, `?id=eq.${p.id}`, { estado: 'cumplida' });
  }

  // Marcar incumplidas + encolar al sub-agente de seguimiento
  let encoladas = 0;
  if (incumplidas.length) {
    const r = await queue.enqueue(
      incumplidas.map((x) => x.cliente),
      'seguimiento',
      null,
      'seguimiento'   // <- usa el webhook del SUB-AGENTE
    );
    encoladas = r.encoladas;

    for (const x of incumplidas) {
      await db.update(TABLE, `?id=eq.${x.promesa.id}`, {
        estado: 'incumplida',
        seguimiento_at: new Date().toISOString(),
      });
    }
  }

  console.log(`[promesas] revisadas ${rows.length} · cumplidas ${cumplidas.length} · incumplidas ${incumplidas.length} · encoladas ${encoladas}`);
  return { revisadas: rows.length, cumplidas: cumplidas.length, incumplidas: incumplidas.length, encoladas };
}

/** Resumen para el dashboard. */
async function resumen() {
  const rows = await db.select(TABLE, '?select=estado,fecha_prometida,phone,nombre,monto_al_prometer&order=fecha_prometida.desc&limit=500');
  const all = rows || [];
  return {
    pendientes: all.filter((r) => r.estado === 'pendiente').length,
    cumplidas: all.filter((r) => r.estado === 'cumplida').length,
    incumplidas: all.filter((r) => r.estado === 'incumplida').length,
    proximas: all.filter((r) => r.estado === 'pendiente').slice(0, 10),
    graciaDias: GRACIA_DIAS,
  };
}

module.exports = { sincronizar, revisarIncumplidas, resumen, GRACIA_DIAS };
