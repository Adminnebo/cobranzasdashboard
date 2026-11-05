/**
 * Costo de la IA que lee las llamadas (fichas) y su cobro en Sword.
 *
 *   ia_consumo  una fila por día y origen: llamadas, tokens y costo en USD
 *               (con los precios por millón de tokens de ia_config).
 *   ia_cobro    un cobro por día cerrado: lo acumulado de los días anteriores
 *               (costo + ganancia %) se descuenta del saldo del cliente en Sword:
 *
 *     POST {SWORD_AJUSTE_URL}   (por defecto https://app.swordaisolutions.com/api/credits/adjust)
 *     { callerId, apiKey, clientId, amount, operation: 'subtract', concept, note }
 *
 * El endpoint no tiene clave de idempotencia: repetir un pedido que SÍ se aplicó
 * cobraría dos veces. Por eso solo se reintenta solo cuando es seguro que no llegó
 * (no se pudo conectar, 429, 503). Si se cortó a mitad queda en 'revisar' y un
 * super admin decide en el panel (reintentar o darlo por hecho).
 * Sword no acepta montos de menos de un centavo: si un día cuesta menos, se
 * acumula con el siguiente.
 */
const db = require('./supabaseDb');
const schedule = require('./schedule');

const T_CONSUMO = 'ia_consumo';
const T_COBRO = 'ia_cobro';
const T_CONFIG = 'ia_config';
const MAX_INTENTOS = 12;

// gpt-4o-mini, USD por millón de tokens.
const DEFAULT = { precioEntrada: 0.15, precioCache: 0.075, precioSalida: 0.6, margenPct: 0, cobrarSword: false };

let faltaTabla = false; // sql/009 sin correr

const esFaltaTabla = (err) => /ia_consumo|ia_cobro|ia_config|does not exist|42P01|PGRST205/i.test(String(err && err.message));
const num = (v, def) => (v == null || v === '' || Number.isNaN(Number(v)) ? def : Number(v));
const redondear = (n, d) => Math.round(Number(n) * 10 ** d) / 10 ** d;

function sword() {
  return {
    url: process.env.SWORD_AJUSTE_URL || 'https://app.swordaisolutions.com/api/credits/adjust',
    caller: process.env.SWORD_AJUSTE_CALLER_ID || '',
    clave: process.env.SWORD_AJUSTE_API_KEY || '',
    cliente: process.env.SWORD_CLIENT_ID || process.env.AGENT_CLIENT_ID || '',
    concepto: process.env.SWORD_AJUSTE_CONCEPTO || 'cobranzas',
  };
}
function swordEstado() {
  const s = sword();
  const faltan = [];
  if (!s.caller) faltan.push('SWORD_AJUSTE_CALLER_ID');
  if (!s.clave) faltan.push('SWORD_AJUSTE_API_KEY');
  if (!s.cliente) faltan.push('SWORD_CLIENT_ID');
  return { listo: !faltan.length, faltan, cliente: s.cliente || null, concepto: s.concepto };
}

// ── Configuración (precios, ganancia, interruptor) ──
async function getConfig() {
  if (faltaTabla || !db.dbEnabled) return { ...DEFAULT, sinTabla: faltaTabla };
  try {
    const [r] = (await db.select(T_CONFIG, '?select=*&id=eq.1')) || [];
    if (!r) return { ...DEFAULT };
    return {
      precioEntrada: num(r.precio_entrada, DEFAULT.precioEntrada),
      precioCache: num(r.precio_cache, DEFAULT.precioCache),
      precioSalida: num(r.precio_salida, DEFAULT.precioSalida),
      margenPct: num(r.margen_pct, DEFAULT.margenPct),
      cobrarSword: r.cobrar_sword === true,
      updatedBy: r.updated_by || null,
      updatedAt: r.updated_at || null,
    };
  } catch (err) {
    if (esFaltaTabla(err)) { faltaTabla = true; console.warn('[ia-costo] faltan las tablas de costo (sql/009): no se registra el gasto'); return { ...DEFAULT, sinTabla: true }; }
    throw err;
  }
}

async function setConfig(patch, por) {
  const actual = await getConfig();
  if (actual.sinTabla) throw Object.assign(new Error('Falta correr sql/009 (tablas de costo de la IA)'), { status: 409 });
  const n = (k, min, max) => {
    if (!(k in patch)) return actual[k];
    const v = Number(patch[k]);
    if (!Number.isFinite(v) || v < min || v > max) throw Object.assign(new Error(`Valor inválido: ${k}`), { status: 400 });
    return v;
  };
  const next = {
    precioEntrada: n('precioEntrada', 0, 1000), precioCache: n('precioCache', 0, 1000), precioSalida: n('precioSalida', 0, 1000),
    margenPct: n('margenPct', 0, 500),
    cobrarSword: 'cobrarSword' in patch ? !!patch.cobrarSword : actual.cobrarSword,
  };
  await db.upsert(T_CONFIG, {
    id: 1, precio_entrada: next.precioEntrada, precio_cache: next.precioCache, precio_salida: next.precioSalida,
    margen_pct: next.margenPct, cobrar_sword: next.cobrarSword, updated_by: por || null, updated_at: new Date().toISOString(),
  }, 'id');
  return getConfig();
}

/** USD de una consulta: los tokens en caché se cobran a su precio, no al de entrada. */
function costoDe(uso, cfg) {
  const entrada = Math.max(0, (uso.entrada || 0) - (uso.cache || 0));
  return (entrada * cfg.precioEntrada + (uso.cache || 0) * cfg.precioCache + (uso.salida || 0) * cfg.precioSalida) / 1e6;
}

/**
 * Suma una consulta a la IA al día de hoy. No lanza: si falla, solo avisa (la
 * lectura de la llamada no se frena por la contabilidad).
 * @param uso { entrada, cache, salida } tokens de la respuesta de OpenAI
 */
async function registrar({ origen = 'fichas', modelo, llamadas = 0, uso }) {
  if (!uso || faltaTabla || !db.dbEnabled) return null;
  try {
    const cfg = await getConfig();
    if (cfg.sinTabla) return null;
    const dia = schedule.ymdInTz(new Date());
    const costo = costoDe(uso, cfg);
    const [r] = (await db.select(T_CONSUMO, `?select=*&dia=eq.${dia}&origen=eq.${origen}`)) || [];
    if (r && r.cobro_id) {
      // El día ya se cobró (no debería pasar: solo se cobran días cerrados). No se toca
      // esa fila: reabrirla haría cobrar dos veces lo que ya se mandó.
      console.warn(`[ia-costo] el ${dia} ya estaba cobrado; no se suma este gasto ($${costo.toFixed(6)})`);
      return costo;
    }
    const fila = {
      dia, origen, modelo: modelo || (r && r.modelo) || null,
      llamadas: num(r && r.llamadas, 0) + llamadas,
      consultas: num(r && r.consultas, 0) + 1,
      tokens_entrada: num(r && r.tokens_entrada, 0) + (uso.entrada || 0),
      tokens_cache: num(r && r.tokens_cache, 0) + (uso.cache || 0),
      tokens_salida: num(r && r.tokens_salida, 0) + (uso.salida || 0),
      costo_usd: redondear(num(r && r.costo_usd, 0) + costo, 6),
    };
    await db.upsert(T_CONSUMO, fila, 'dia,origen');
    return costo;
  } catch (err) {
    if (esFaltaTabla(err)) { faltaTabla = true; console.warn('[ia-costo] faltan las tablas de costo (sql/009): no se registra el gasto'); return null; }
    console.error('[ia-costo] no se pudo registrar el gasto:', err.message);
    return null;
  }
}

// ── Cobro en Sword ──
class SwordError extends Error {
  constructor(msg, { status = 0, seguro = false } = {}) { super(msg); this.status = status; this.seguro = seguro; }
}
const NO_LLEGO = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);

async function ajustar({ amount, note }) {
  const s = sword();
  const cuerpo = { callerId: Number(s.caller), apiKey: s.clave, clientId: Number(s.cliente), amount, operation: 'subtract', concept: s.concepto, note };
  let r;
  try {
    r = await fetch(s.url, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(cuerpo), signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    const codigo = (e.cause && e.cause.code) || e.code;
    throw new SwordError(`sin respuesta (${codigo || e.name}: ${e.message})`, { seguro: NO_LLEGO.has(codigo) });
  }
  const texto = await r.text();
  let j = null;
  try { j = texto ? JSON.parse(texto) : {}; } catch { /* no JSON */ }
  if (!r.ok || !j || j.success === false) {
    const motivo = (j && (j.error || j.message)) || texto.slice(0, 200) || '';
    throw new SwordError(`HTTP ${r.status} ${motivo}`.trim(), { status: r.status, seguro: r.status === 429 || r.status === 503 });
  }
  return j;
}

const diaCorto = (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('es-DO', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const restarDia = (ymd) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };

/** Arma el cobro con lo pendiente de los días ya cerrados (antes de hoy). */
async function cerrarDias(cfg, hoy) {
  const ayer = restarDia(hoy);
  const filas = (await db.select(T_CONSUMO, `?select=*&cobro_id=is.null&dia=lte.${ayer}&order=dia.asc`)) || [];
  if (!filas.length) return null;
  const costo = filas.reduce((s, f) => s + num(f.costo_usd, 0), 0);
  const monto = redondear(costo * (1 + cfg.margenPct / 100), 2);
  if (monto < 0.01) return null; // menos de un centavo: se acumula con el próximo día
  const desde = filas[0].dia;
  const hasta = filas[filas.length - 1].dia;
  const llamadas = filas.reduce((s, f) => s + num(f.llamadas, 0), 0);
  const modelos = [...new Set(filas.map((f) => f.modelo).filter(Boolean))].join(', ');
  const nota = [
    'Cobranzas · lectura de llamadas con IA',
    modelos || null,
    desde === hasta ? diaCorto(hasta) : `${diaCorto(desde)} al ${diaCorto(hasta)}`,
    `${llamadas} llamadas`,
    `costo $${costo.toFixed(4)}${cfg.margenPct ? ` + ${cfg.margenPct}%` : ''}`,
    `ref cob-ia-${hasta}`,
  ].filter(Boolean).join(' · ').slice(0, 500);
  let cobro;
  try {
    [cobro] = await db.insertReturn(T_COBRO, {
      dia: hasta, desde, costo_usd: redondear(costo, 6), margen_pct: cfg.margenPct, monto_usd: monto,
      llamadas, nota, estado: 'pendiente', intentos: 0,
    });
  } catch (err) {
    if (/duplicate|23505|unique/i.test(err.message)) return null; // otro proceso ya lo armó
    throw err;
  }
  const claves = filas.map((f) => `"${f.dia}"`).join(',');
  await db.update(T_CONSUMO, `?cobro_id=is.null&origen=in.(${[...new Set(filas.map((f) => f.origen))].join(',')})&dia=in.(${encodeURIComponent(claves)})`, { cobro_id: cobro.id });
  return cobro;
}

/** Manda los cobros pendientes. Solo reintenta solo cuando es seguro que no llegó. */
async function enviarPendientes() {
  const ahora = Date.now();
  const filas = (await db.select(T_COBRO, '?select=*&estado=in.(pendiente,reintentar)&order=id.asc&limit=5')) || [];
  const hechos = [];
  for (const c of filas) {
    if (c.estado === 'reintentar' && c.proximo_at && Date.parse(c.proximo_at) > ahora) continue;
    const intentos = num(c.intentos, 0) + 1;
    await db.update(T_COBRO, `?id=eq.${c.id}&estado=eq.${c.estado}`, { estado: 'enviando', intentos });
    try {
      const r = await ajustar({ amount: num(c.monto_usd, 0), note: c.nota });
      await db.update(T_COBRO, `?id=eq.${c.id}`, { estado: 'enviado', enviado_at: new Date().toISOString(), respuesta: JSON.stringify(r).slice(0, 500) });
      console.log(`[ia-costo] cobro ${c.id} enviado a Sword: $${c.monto_usd} (${c.nota})`);
      hechos.push({ id: c.id, estado: 'enviado' });
    } catch (err) {
      const reintentar = err.seguro && intentos < MAX_INTENTOS;
      const espera = Math.min(60, 2 ** (intentos - 1)) * 60000;
      await db.update(T_COBRO, `?id=eq.${c.id}`, {
        estado: reintentar ? 'reintentar' : 'revisar',
        proximo_at: reintentar ? new Date(ahora + espera).toISOString() : null,
        respuesta: String(err.message).slice(0, 500),
      });
      console.error(`[ia-costo] cobro ${c.id} ${reintentar ? 'no llegó, se reintenta' : 'quedó para revisar'}: ${err.message}`);
      hechos.push({ id: c.id, estado: reintentar ? 'reintentar' : 'revisar' });
    }
  }
  return hechos;
}

/** Cada vuelta del motor: cierra los días anteriores y manda lo pendiente (si está prendido). */
async function cobrar({ hoy = schedule.ymdInTz(new Date()) } = {}) {
  if (faltaTabla || !db.dbEnabled) return { omitido: 'sin tablas' };
  const cfg = await getConfig();
  if (cfg.sinTabla) return { omitido: 'sin tablas' };
  if (!cfg.cobrarSword) return { omitido: 'apagado' };
  if (!swordEstado().listo) return { omitido: 'sword sin configurar' };
  const cobro = await cerrarDias(cfg, hoy);
  const enviados = await enviarPendientes();
  return { cobro: cobro ? cobro.id : null, enviados };
}

/** Un cobro en 'revisar': el super admin lo manda de nuevo o lo da por hecho (ya está en Sword). */
async function resolver(id, accion, por) {
  const [c] = (await db.select(T_COBRO, `?select=*&id=eq.${Number(id)}`)) || [];
  if (!c) throw Object.assign(new Error('No existe ese cobro'), { status: 404 });
  if (c.estado !== 'revisar' && c.estado !== 'enviando') throw Object.assign(new Error('Ese cobro no está para revisar'), { status: 409 });
  if (accion === 'reintentar') await db.update(T_COBRO, `?id=eq.${c.id}`, { estado: 'pendiente', proximo_at: null, respuesta: `reintento pedido por ${por || 'super admin'}` });
  else if (accion === 'hecho') await db.update(T_COBRO, `?id=eq.${c.id}`, { estado: 'enviado', enviado_at: new Date().toISOString(), respuesta: `dado por hecho por ${por || 'super admin'}` });
  else throw Object.assign(new Error('Acción inválida'), { status: 400 });
  return true;
}

/** Resumen para el panel: hoy, este mes, lo que falta cobrar y los últimos cobros. */
async function resumen() {
  const config = await getConfig();
  const base = { config, sword: swordEstado(), modelo: process.env.FICHAS_MODEL || 'gpt-4o-mini', claveIa: !!process.env.OPENAI_API_KEY_FICHAS };
  if (config.sinTabla) return { ...base, sinTabla: true };
  const hoy = schedule.ymdInTz(new Date());
  const mes = `${hoy.slice(0, 7)}-01`;
  const filas = (await db.select(T_CONSUMO, `?select=*&dia=gte.${mes}&order=dia.asc`)) || [];
  const pendientes = (await db.select(T_CONSUMO, '?select=*&cobro_id=is.null')) || [];
  const cobros = (await db.select(T_COBRO, '?select=*&order=id.desc&limit=10')) || [];
  const suma = (rows) => ({ costo: redondear(rows.reduce((s, f) => s + num(f.costo_usd, 0), 0), 6), llamadas: rows.reduce((s, f) => s + num(f.llamadas, 0), 0) });
  return {
    ...base,
    hoy: suma(filas.filter((f) => f.dia === hoy)),
    mes: suma(filas),
    sinCobrar: suma(pendientes),
    desde: pendientes.length ? pendientes.map((f) => f.dia).sort()[0] : null,
    cobros: cobros.map((c) => ({
      id: c.id, desde: c.desde, dia: c.dia, monto: num(c.monto_usd, 0), costo: num(c.costo_usd, 0), margen: num(c.margen_pct, 0),
      llamadas: num(c.llamadas, 0), estado: c.estado, intentos: num(c.intentos, 0), respuesta: c.respuesta || null, enviadoAt: c.enviado_at || null,
    })),
  };
}

module.exports = { registrar, cobrar, cerrarDias, enviarPendientes, resolver, resumen, getConfig, setConfig, costoDe, swordEstado, DEFAULT, T_CONSUMO, T_COBRO, T_CONFIG };
