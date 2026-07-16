/**
 * Asistente de cobranzas: responde preguntas libres y hace proyecciones usando
 * SOLO los datos de la cartera (clientes, llamadas, métricas e histórico).
 * Modelo: gpt-4.1-mini.
 */

const { getCachedData } = require('./cache');
const { computeMetrics } = require('./metrics');
const { getDailyHistory } = require('./history');
const clienteConfig = require('./clienteConfig');
const ivr = require('./ivr');
const promesas = require('./promesas');
const queue = require('./queue');

const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const MAX_CLIENTES = 1200; // tope para no disparar tokens
const MAX_LLAMADAS = 500;

const money = (n) => Math.round(n || 0).toLocaleString('es-MX');

// Costo estimado (USD/1M tokens). Tabla por modelo con match por prefijo.
const PRICING = {
  'gpt-4.1-nano': { in: 0.10, out: 0.40 },
  'gpt-4.1-mini': { in: 0.40, out: 1.60 },
  'gpt-4.1': { in: 2.00, out: 8.00 },
  'gpt-4o-mini': { in: 0.15, out: 0.60 },
  'gpt-4o': { in: 2.50, out: 10.00 },
  'gpt-5-nano': { in: 0.10, out: 0.40 },
  'gpt-5-mini': { in: 0.40, out: 1.60 },
  'gpt-5.2': { in: 2.00, out: 8.00 },
};
function estCost(model, pin = 0, pout = 0) {
  const m = (model || '').toLowerCase();
  let best = '';
  for (const k of Object.keys(PRICING)) if (m.startsWith(k) && k.length > best.length) best = k;
  const rate = PRICING[best] || { in: 0.40, out: 1.60 };
  return (pin / 1e6) * rate.in + (pout / 1e6) * rate.out;
}

function buildContext({ clientes, llamadas, metrics, history, enabledMap, ivrMap, callsByPhone, promesasResumen, colaEstado }) {
  const m = metrics;
  const clientByPhone = new Map(clientes.map((c) => [c.phone, c]));

  const resumen = [
    `Total clientes: ${m.totalClientes}`,
    `Deuda total: $${money(m.deudaTotal)}`,
    `Deuda vencida: $${money(m.deudaVencida)} (${m.deudaTotal ? Math.round((m.deudaVencida / m.deudaTotal) * 100) : 0}% del total)`,
    `Crédito ofrecido: $${money(m.creditoOfrecido)} (utilización ${m.utilizacionCredito}%)`,
    `Ticket promedio de deuda: $${money(m.ticketPromedio)}`,
    `Clientes contactados: ${m.clientesContactados} (tasa ${m.tasaContacto}%)`,
    `Clientes activos para llamar (enabled): ${m.clientesHabilitados}`,
    `Clientes marcados como IVR/contestadora: ${ivrMap.size}`,
    `Llamadas totales: ${m.totalLlamadas}; con compromiso de pago: ${m.llamadasConCompromiso}`,
  ].join('\n');

  const intencion = m.intencionDistribucion.map((d) => `  ${d.label}: ${d.count} (${d.pct}%)`).join('\n');
  const severidad = m.aging.map((a) => `  ${a.bucket}: $${money(a.monto)} (${a.clientes} clientes)`).join('\n');

  const hist = (history || []).slice(-30)
    .map((h) => `  ${h.date}: total $${money(h.deudaTotal)}, vencido $${money(h.deudaVencida)}${h.seeded ? ' (est.)' : ''}`)
    .join('\n');

  // Promesas de pago
  const pr = promesasResumen || {};
  const promesasCtx = [
    `Pendientes: ${pr.pendientes || 0} · cumplidas: ${pr.cumplidas || 0} · incumplidas: ${pr.incumplidas || 0}`,
    ...(pr.proximas || []).slice(0, 15).map((p) => `  ${p.nombre || p.phone} promete el ${p.fecha_prometida} ($${money(p.monto_al_prometer)})`),
  ].join('\n');

  // Cola de llamadas
  const cola = colaEstado
    ? `Pendientes en cola: ${colaEstado.pendientes} · enviadas 24h: ${colaEstado.enviadas24h} · horario: ${colaEstado.horario} · ${colaEstado.scheduleEnabled ? 'ACTIVO' : 'desactivado'}`
    : '';

  // Todas las llamadas (compactas, más recientes primero)
  const llamOrden = [...llamadas].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const llamTrunc = llamOrden.length > MAX_LLAMADAS;
  const llamadasCtx = llamOrden.slice(0, MAX_LLAMADAS)
    .map((l) => {
      const cli = clientByPhone.get(l.phone);
      const quien = cli ? cli.name : (l.name || '(sin cliente en cartera)');
      return `${(l.created_at || '').slice(0, 16)} | tel ${l.phone} | cliente: ${quien} | ${l.intencion_pago} | fecha_pago "${l.fecha_pago || ''}" | ${l.notas || ''}`;
    })
    .join('\n');

  // Clientes con TODO: deuda, estado enabled/ivr y su última llamada
  const orden = [...clientes].sort((a, b) => (b.deuda_total || 0) - (a.deuda_total || 0));
  const truncado = orden.length > MAX_CLIENTES;
  const filas = orden.slice(0, MAX_CLIENTES).map((c) => {
    const calls = callsByPhone.get(c.phone) || [];
    const ult = calls[0];
    const estado = ivrMap.has(c.phone) ? 'IVR' : enabledMap.get(c.phone) ? 'activo' : 'inactivo';
    const ultTxt = ult ? ` | últ.llamada ${(ult.created_at || '').slice(0, 10)} ${ult.intencion_pago}${ult.fecha_pago ? ` (promete ${ult.fecha_pago})` : ''}` : ' | sin llamadas';
    return `${c.name} | cód ${c.codigo || ''} | total ${money(c.deuda_total)} | vencido ${money(c.deuda_vencida)} | limite ${money(c.credito_ofrecido)} | tel ${c.phone} | ${estado} | ${calls.length} llamada(s)${ultTxt}`;
  }).join('\n');

  return [
    `# RESUMEN DE CARTERA\n${resumen}`,
    `\n# INTENCIÓN DE PAGO (distribución)\n${intencion}`,
    `\n# SEVERIDAD DE DEUDA (por % vencido)\n${severidad}`,
    hist ? `\n# HISTÓRICO DE DEUDA (últimos días)\n${hist}` : '',
    `\n# PROMESAS DE PAGO\n${promesasCtx}`,
    cola ? `\n# COLA DE LLAMADAS\n${cola}` : '',
    llamadasCtx ? `\n# LLAMADAS${llamTrunc ? ` (últimas ${MAX_LLAMADAS} de ${llamOrden.length})` : ''}\n${llamadasCtx}` : '',
    `\n# CLIENTES (ordenados por deuda total, moneda DOP)${truncado ? ` — mostrando top ${MAX_CLIENTES} de ${orden.length}` : ''}\n${filas}`,
  ].filter(Boolean).join('\n');
}

async function ask(question) {
  const { clientes, llamadas } = await getCachedData();
  const metrics = computeMetrics(clientes, llamadas);
  const [history, enabledMap, ivrMap, promesasResumen, colaEstado] = await Promise.all([
    getDailyHistory().catch(() => []),
    clienteConfig.getEnabledMap().catch(() => new Map()),
    ivr.getIvrMap().catch(() => new Map()),
    promesas.resumen().catch(() => ({})),
    queue.status().catch(() => null),
  ]);

  // Llamadas agrupadas por teléfono (recientes primero).
  const callsByPhone = new Map();
  for (const ll of llamadas) {
    if (!ll.phone) continue;
    if (!callsByPhone.has(ll.phone)) callsByPhone.set(ll.phone, []);
    callsByPhone.get(ll.phone).push(ll);
  }
  for (const arr of callsByPhone.values()) arr.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  if (!process.env.OPENAI_API_KEY) {
    return {
      noKey: true,
      answer: '⚠ Esta función necesita una OPENAI_API_KEY configurada en server/.env para responder con IA. Ya tienes el modelo listo (gpt-4.1-mini); solo agrega la key y reinicia.',
    };
  }

  const context = buildContext({ clientes, llamadas, metrics, history, enabledMap, ivrMap, callsByPhone, promesasResumen, colaEstado });

  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60000 });

  const system =
    'Eres un analista experto en cobranzas con acceso a TODA la operación: cartera de clientes ' +
    '(deuda, crédito, teléfono, código), estado de cada cliente (activo/inactivo para llamar, IVR), ' +
    'historial de llamadas (intención, fecha de pago prometida, notas), promesas de pago y su ' +
    'cumplimiento, la cola de llamadas y el histórico de deuda. Responde usando EXCLUSIVAMENTE esos ' +
    'datos (moneda: pesos dominicanos, DOP). Puedes calcular sumas, porcentajes, proyecciones, ' +
    'escenarios y segmentar clientes. Si algo no está en los datos, dilo claramente en vez de inventar. ' +
    'IMPORTANTE: para relacionar una llamada con su cliente usa EXACTAMENTE el teléfono (campo "tel"); ' +
    'cada línea de llamada ya trae "cliente:" con el nombre correcto resuelto por teléfono — úsalo, ' +
    'NO asocies por nombre ni por cercanía en la lista. Si un teléfono no está entre los clientes, dilo. ' +
    'Responde en español, conciso y accionable, con cifras en formato $1,234,567. ' +
    'Cuando ayude, usa listas o una tabla markdown corta. ' +
    'NO uses LaTeX ni notación matemática con \\[ \\], \\( \\) o comandos como \\times/\\text. ' +
    'Escribe las operaciones en texto plano, por ejemplo: "213,347,318 × 30% = 64,004,195".';

  const resp = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `DATOS:\n${context}\n\n---\nPREGUNTA: ${question}` },
    ],
  });

  const usage = resp.usage || {};
  return {
    answer: resp.choices[0].message.content,
    model: MODEL,
    usage,
    costUsd: estCost(MODEL, usage.prompt_tokens, usage.completion_tokens),
  };
}

module.exports = { ask };
