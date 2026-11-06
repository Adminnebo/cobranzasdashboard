/**
 * Retiros → logística (logistica.neboaiconsulting.com).
 *
 * Cuando el cliente pide en una llamada que pasen a buscar el pago (ficha con
 * modalidad 'retiro'), el retiro se manda a logística para que lo meta en una
 * ruta. Logística avisa después cómo va (por ubicar, en ruta, retirado…).
 *
 * Motor (cada minuto, RETIROS_LOGISTICA_CRON):
 *   - Los retiros de promesas abiertas (los mismos que muestra la pestaña
 *     🚚 Retiros) que nunca se mandaron o cambiaron → PUT (idempotente).
 *   - Los que se mandaron y ya no están porque la ficha pasó a "No es retiro"
 *     o la promesa se cerró sin pago → DELETE (cancelar). No se cancela lo que
 *     logística ya cerró (retirado, no retirado, cancelado).
 *   - Si logística no responde: se guarda el error y se reintenta con espera
 *     creciente (1, 2, 4… hasta 30 min). Nunca tumba el cron.
 *   - A lo sumo MAX_LLAMADAS pedidos por vuelta, TIMEOUT_MS cada uno.
 *
 * Aviso (POST /api/logistica/retiros/aviso, sin sesión, con x-logistica-token):
 *   guarda lo que dice logística. Si quedó "retirado", el cliente pasa a "dice
 *   que pagó" (no se le llama), con la nota del monto y el RCP.
 *
 * Todo queda en la tabla retiro_logistica (sql/012).
 */

const crypto = require('crypto');
const db = require('./supabaseDb');
const fichas = require('./fichas');
const promesas = require('./promesas');
const pruebas = require('./pruebas');
const { safeEqual } = require('../security');

const TABLE = 'retiro_logistica';
const MAX_LLAMADAS = 20;
const TIMEOUT_MS = 10000;
const ESPERA_MAX_MIN = 30;
const DIAS_FILAS = 60; // filas de los últimos N días (las fichas que se miran son de 45)

const ABIERTAS = ['pendiente', 'en_seguimiento'];
// Promesas cerradas sin pago: su retiro se cancela en logística. 'cumplida'
// (ya no debe) no: puede que logística mismo lo haya cobrado.
const CERRADAS_SIN_PAGO = new Set(['cancelada', 'incumplida', 'escalada', 'vieja', 'sin_llamada', 'reprogramada', 'dice_pago']);
const ESTADOS = new Set(['por_ubicar', 'por_asignar', 'en_ruta', 'retirado', 'no_retirado', 'cancelado']);
// Lo que logística ya cerró: no se reenvía ni se cancela.
const FINALES = new Set(['retirado', 'no_retirado', 'cancelado']);
const EXTERNO_OK = /^[\w.:|+-]{1,200}$/;
const SIN_CODIGO = 'el cliente no tiene código en la cartera';
const DE_PRUEBA = 'número de prueba: no va a logística';

const base = () => (process.env.LOGISTICA_URL || '').trim().replace(/\/+$/, '');
const configurado = () => !!(base() && process.env.LOGISTICA_TOKEN);

/** La llamada_key de la ficha, con solo los caracteres que acepta logística. */
const externoDe = (llamadaKey) => String(llamadaKey || '').replace(/[^\w.:|+-]/g, '_').slice(0, 200);
const hashDe = (body) => crypto.createHash('sha1').update(JSON.stringify(body)).digest('hex');
const tablaFaltaErr = (err) => /retiro_logistica|does not exist|42P01|PGRST205/i.test(String(err && err.message));

let tablaFaltaHasta = 0; // sql/012 sin correr: no insistir en cada vuelta
let corriendo = false;
const avisados = new Set(); // "sin código" ya anotado en el log (una vez por retiro)

// ── Cuerpo que se manda ──────────────────────────────────────────────────────
/** Cuerpo del PUT a logística para una promesa con su ficha y su cliente de la cartera. */
function cuerpo(p, ficha, cliente) {
  const r = (ficha && ficha.retiro) || {};
  const monto = Number(p.monto_al_prometer);
  return {
    clienteCodigo: String(cliente.codigo),
    nombre: cliente.name || p.nombre || null,
    telefono: String(p.phone),
    fecha: r.fecha || String(p.fecha_prometida || '').slice(0, 10) || null,
    franja: r.franja || null,
    desde: r.desde || null,
    hasta: r.hasta || null,
    frase: r.texto || null,
    montoEsperado: p.monto_al_prometer != null && Number.isFinite(monto) ? monto : null,
    promesaId: p.id != null ? String(p.id) : null,
  };
}

/** Campos de un aviso (o de la respuesta del PUT) para guardar en la fila. */
function camposAviso(a) {
  if (!a || typeof a !== 'object' || !ESTADOS.has(a.estado)) return {};
  const ruta = a.ruta && typeof a.ruta === 'object'
    ? { referencia: a.ruta.referencia || null, fecha: a.ruta.fecha || null, repartidor: a.ruta.repartidor || null }
    : null;
  const cent = Number(a.montoCent);
  return {
    estado: a.estado,
    ruta,
    motivo: a.motivo ? String(a.motivo).slice(0, 500) : null,
    monto_cent: a.montoCent != null && Number.isFinite(cent) ? Math.round(cent) : null,
    rcp: a.rcp ? String(a.rcp).slice(0, 100) : null,
    atendido_en: a.atendidoEn || null,
    ...(a.fecha ? { fecha: String(a.fecha).slice(0, 10) } : {}),
  };
}

const guardar = (externoId, patch) =>
  db.upsert(TABLE, { externo_id: externoId, ...patch, actualizado_at: new Date().toISOString() }, 'externo_id');

/** Espera antes del próximo intento: 1, 2, 4, 8, 16, 30, 30… minutos. */
const esperaMin = (intentos) => Math.min(2 ** Math.max(0, intentos - 1), ESPERA_MAX_MIN);

async function fallo(prev, externoId, error, ahoraMs, extra = {}) {
  const intentos = ((prev && prev.intentos) || 0) + 1;
  await guardar(externoId, {
    ...extra,
    error: String(error).slice(0, 300),
    intentos,
    proximo_intento_at: new Date(ahoraMs + esperaMin(intentos) * 60000).toISOString(),
  });
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
async function pedir(fetchImpl, method, externoId, body) {
  const res = await fetchImpl(`${base()}/api/integraciones/retiros/${encodeURIComponent(externoId)}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-integracion-token': process.env.LOGISTICA_TOKEN },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: res.status, ok: res.ok, json, text };
}

const errorHttp = (r) => `logística respondió ${r.status}${r.json && r.json.error ? `: ${r.json.error}` : r.text ? `: ${r.text.slice(0, 120)}` : ''}`;

// ── Motor ────────────────────────────────────────────────────────────────────
/**
 * Una vuelta del motor. Nunca lanza: los errores quedan en el log y en la fila.
 * @param {object} [opts]  para pruebas: ahora (Date), datos ({ clientes }), fetchImpl
 */
async function sincronizar({ ahora = new Date(), datos = null, fetchImpl = fetch } = {}) {
  if (!configurado()) return { omitida: 'sin LOGISTICA_URL / LOGISTICA_TOKEN' };
  if (!db.dbEnabled) return { omitida: 'Supabase no configurado' };
  if (Date.now() < tablaFaltaHasta) return { omitida: 'falta la tabla retiro_logistica (sql/012)' };
  if (corriendo) return { omitida: 'ya está corriendo' };
  corriendo = true;
  try {
    return await vuelta(ahora, datos, fetchImpl);
  } catch (err) {
    if (tablaFaltaErr(err)) {
      tablaFaltaHasta = Date.now() + 15 * 60000;
      console.warn('[retiros-logistica] falta la tabla retiro_logistica (sql/012): no se mandan retiros');
      return { omitida: 'falta la tabla retiro_logistica (sql/012)' };
    }
    console.error('[retiros-logistica] falló:', err.message);
    return { error: err.message };
  } finally {
    corriendo = false;
  }
}

async function vuelta(ahora, datos, fetchImpl) {
  const ahoraMs = ahora.getTime();
  const data = datos || await require('./cache').getCachedData();
  const clientes = (data.clientes || []).filter((c) => c.phone);
  // Sin cartera no se sabe el código de nadie: mejor no tocar nada esta vuelta.
  if (!clientes.length) return { omitida: 'cartera vacía' };
  const porTel = new Map(clientes.map((c) => [String(c.phone), c]));

  const desde = new Date(ahoraMs - DIAS_FILAS * 86400000).toISOString();
  const [rows, fichasMap, filas, setPruebas] = await Promise.all([
    promesas.lista(), fichas.mapaReciente(), db.select(TABLE, `?select=*&created_at=gte.${desde}`), pruebas.phones(),
  ]);
  // Los números de prueba (🧪 en el panel) nunca van a las rutas de los repartidores.
  const esPrueba = (phone) => setPruebas.has(pruebas.phoneKey(phone));
  const previos = new Map((filas || []).map((f) => [f.externo_id, f]));
  const cuenta = {};
  const sumar = (k) => { cuenta[k] = (cuenta[k] || 0) + 1; };
  let presupuesto = MAX_LLAMADAS;
  const enEspera = (prev) => prev && prev.proximo_intento_at && Date.parse(prev.proximo_intento_at) > ahoraMs;

  // 1. Retiros vigentes: lo mismo que muestra la pestaña 🚚 Retiros.
  const vigentes = new Set();
  const porEnviar = [];
  for (const p of rows || []) {
    if (!ABIERTAS.includes(p.estado)) continue;
    const fx = p.llamada_key ? fichasMap.get(p.llamada_key) : null;
    if (!fx || fx.modalidad !== 'retiro') continue;
    const ext = externoDe(fx.llamada_key);
    if (!EXTERNO_OK.test(ext)) continue;
    const prev = previos.get(ext);
    if (esPrueba(p.phone)) {
      // No es vigente: si se mandó antes de estar en la lista, el paso 2 lo cancela.
      if (!prev) await guardar(ext, { llamada_key: fx.llamada_key, promesa_id: String(p.id), phone: String(p.phone), error: DE_PRUEBA });
      sumar('prueba');
      continue;
    }
    vigentes.add(ext);
    if (prev && FINALES.has(prev.estado)) continue; // logística ya lo cerró
    const c = porTel.get(String(p.phone));
    const fila = { llamada_key: fx.llamada_key, promesa_id: String(p.id), phone: String(p.phone) };
    if (!c || !c.codigo) {
      if (!avisados.has(ext)) { avisados.add(ext); console.warn(`[retiros-logistica] ${p.phone}: ${SIN_CODIGO}, no se manda a logística`); }
      if (!prev || prev.error !== SIN_CODIGO) await guardar(ext, { ...fila, error: SIN_CODIGO });
      sumar('sin_codigo');
      continue;
    }
    const body = cuerpo(p, fx, c);
    const hash = hashDe(body);
    if (prev && prev.enviado_hash === hash && !prev.cancelado_at && !prev.error) continue; // ya está igual en logística
    if (enEspera(prev)) continue;
    porEnviar.push({ ext, prev, body, hash, fila: { ...fila, cliente_codigo: body.clienteCodigo } });
  }

  // 2. Cancelar los que se mandaron y ya no van (primero: evita un viaje en vano).
  const porCancelar = [...previos.values()].filter((f) => f.enviado_at && !f.cancelado_at && !FINALES.has(f.estado)
    && !vigentes.has(f.externo_id) && !enEspera(f));
  if (porCancelar.length) {
    const lista = (vals) => encodeURIComponent(vals.map((v) => `"${String(v).replace(/"/g, '')}"`).join(','));
    const keys = porCancelar.map((f) => f.llamada_key).filter(Boolean);
    const ids = porCancelar.map((f) => f.promesa_id).filter(Boolean);
    const [fx, ps] = await Promise.all([
      keys.length ? db.select('llamada_ficha', `?select=llamada_key,modalidad&llamada_key=in.(${lista(keys)})`) : [],
      ids.length ? db.select('promesa_pago', `?select=id,estado&id=in.(${lista(ids)})`) : [],
    ]);
    const modalidad = new Map((fx || []).map((r) => [r.llamada_key, r.modalidad]));
    const estadoProm = new Map((ps || []).map((r) => [String(r.id), r.estado]));
    for (const f of porCancelar) {
      const noRetiro = modalidad.get(f.llamada_key) === 'no_retiro';
      const sinPago = CERRADAS_SIN_PAGO.has(estadoProm.get(String(f.promesa_id)));
      if (!noRetiro && !sinPago && !esPrueba(f.phone)) continue;
      if (presupuesto <= 0) break;
      presupuesto--;
      try {
        const r = await pedir(fetchImpl, 'DELETE', f.externo_id);
        const at = new Date().toISOString();
        if (r.ok) {
          await guardar(f.externo_id, { ...camposAviso(r.json), estado: (r.json && ESTADOS.has(r.json.estado)) ? r.json.estado : 'cancelado',
            cancelado_at: at, error: null, intentos: 0, proximo_intento_at: null });
          sumar('cancelados');
        } else if (r.status === 404) {
          // Logística nunca lo tuvo: no hay nada que cancelar.
          await guardar(f.externo_id, { cancelado_at: at, error: null, intentos: 0, proximo_intento_at: null });
          sumar('cancelados');
        } else if (r.status === 409) {
          // Ya lo atendieron: queda como está en logística, no se reintenta.
          await guardar(f.externo_id, { ...camposAviso(r.json), cancelado_at: at,
            error: 'no se pudo cancelar: logística ya lo había atendido (409)', intentos: 0, proximo_intento_at: null });
          sumar('ya_atendidos');
        } else {
          await fallo(f, f.externo_id, errorHttp(r), ahoraMs);
          sumar('errores');
        }
      } catch (err) {
        await fallo(f, f.externo_id, `no se pudo cancelar en logística: ${err.message}`, ahoraMs).catch(() => {});
        sumar('errores');
      }
    }
  }

  // 3. Mandar los nuevos o cambiados.
  for (const x of porEnviar) {
    if (presupuesto <= 0) { sumar('para_la_proxima'); continue; }
    presupuesto--;
    try {
      const r = await pedir(fetchImpl, 'PUT', x.ext, x.body);
      if (!r.ok) {
        await fallo(x.prev, x.ext, errorHttp(r), ahoraMs, x.fila);
        sumar('errores');
        continue;
      }
      await guardar(x.ext, {
        ...x.fila, ...camposAviso(r.json),
        enviado: x.body, enviado_hash: x.hash, enviado_at: new Date().toISOString(), cancelado_at: null,
        error: null, intentos: 0, proximo_intento_at: null,
      });
      avisados.delete(x.ext);
      sumar('enviados');
    } catch (err) {
      await fallo(x.prev, x.ext, `no llegó a logística: ${err.message}`, ahoraMs, x.fila).catch(() => {});
      sumar('errores');
    }
  }

  if (Object.keys(cuenta).some((k) => k !== 'sin_codigo' && k !== 'prueba')) console.log('[retiros-logistica]', JSON.stringify(cuenta));
  return cuenta;
}

// ── Aviso de logística ───────────────────────────────────────────────────────
const montoTexto = (cent) => (cent / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** "Retirado por logística: RD$ 10,000 con el RCP-0012" */
function notaRetirado(a) {
  const cent = Number(a.montoCent);
  const monto = a.montoCent != null && Number.isFinite(cent) ? `: RD$ ${montoTexto(cent)}` : '';
  return `Retirado por logística${monto}${a.rcp ? ` con el ${a.rcp}` : ''}`;
}

const errStatus = (status, msg) => Object.assign(new Error(msg), { status });

/** Guarda un aviso de logística. Retirado → el cliente pasa a "dice que pagó". */
async function recibirAviso(b) {
  const a = b || {};
  const ext = String(a.externoId || '');
  if (!EXTERNO_OK.test(ext)) throw errStatus(400, 'externoId inválido');
  if (!ESTADOS.has(a.estado)) throw errStatus(400, 'estado inválido');

  const [prev] = (await db.select(TABLE, `?select=*&externo_id=eq.${encodeURIComponent(ext)}`)) || [];
  let phone = prev && prev.phone;
  let extra = {};
  if (!phone) {
    // Un retiro que no está en la tabla (raro): se busca su promesa por la llamada.
    const [p] = (await db.select('promesa_pago', `?select=id,phone,llamada_key&llamada_key=eq.${encodeURIComponent(ext)}&order=created_at.desc&limit=1`)) || [];
    if (p) { phone = String(p.phone); extra = { phone, llamada_key: p.llamada_key, promesa_id: String(p.id) }; }
  }

  let dicePago = false;
  if (a.estado === 'retirado' && phone) {
    // Primero el cliente: si falla, se responde error y logística reintenta el aviso.
    dicePago = await promesas.dicePagoPorRetiro(phone, notaRetirado(a));
  }
  await guardar(ext, { ...extra, ...camposAviso(a) });
  return { dicePago };
}

/** Handler de Express para POST /api/logistica/retiros/aviso (sin sesión: lo llama logística). */
async function manejarAviso(req, res) {
  const esperado = process.env.LOGISTICA_AVISO_TOKEN || '';
  if (!esperado) return res.status(503).json({ error: 'Avisos de logística no configurados (falta LOGISTICA_AVISO_TOKEN)' });
  if (!safeEqual((req.headers || {})['x-logistica-token'], esperado)) return res.status(401).json({ error: 'Token inválido' });
  try {
    const r = await recibirAviso(req.body);
    return res.json({ ok: true, ...r });
  } catch (err) {
    if (!err.status) console.error('[retiros-logistica] aviso falló:', err.message);
    return res.status(err.status || 500).json({ error: err.status ? err.message : 'Error interno del servidor' });
  }
}

// ── Para la pestaña Retiros ─────────────────────────────────────────────────
/** Map<llamada_key, estado en logística> para /api/promesas/lista. Vacío si falta sql/012. */
async function mapaPorLlamada() {
  try {
    const desde = new Date(Date.now() - DIAS_FILAS * 86400000).toISOString();
    const rows = await db.select(TABLE, `?select=externo_id,llamada_key,estado,ruta,motivo,monto_cent,rcp,atendido_en,error,enviado_at,actualizado_at&created_at=gte.${desde}`);
    return new Map((rows || []).filter((r) => r.llamada_key).map((r) => [r.llamada_key, {
      estado: r.estado || null, ruta: r.ruta || null, motivo: r.motivo || null,
      montoCent: r.monto_cent != null ? Number(r.monto_cent) : null, rcp: r.rcp || null,
      atendidoEn: r.atendido_en || null, error: r.error === DE_PRUEBA ? null : (r.error || null), prueba: r.error === DE_PRUEBA,
      enviado: !!r.enviado_at, actualizadoAt: r.actualizado_at || null,
    }]));
  } catch (err) { return new Map(); }
}

module.exports = {
  sincronizar, manejarAviso, recibirAviso, mapaPorLlamada, configurado,
  // puras (pruebas)
  cuerpo, externoDe, esperaMin, notaRetirado, TABLE,
};
