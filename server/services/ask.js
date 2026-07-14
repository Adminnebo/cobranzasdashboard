/**
 * Asistente de cobranzas: responde preguntas libres y hace proyecciones usando
 * SOLO los datos de la cartera (clientes, llamadas, métricas e histórico).
 * Modelo: gpt-4.1-mini.
 */

const { getCachedData } = require('./cache');
const { computeMetrics } = require('./metrics');
const { buildPortfolio } = require('./ai');
const { getDailyHistory } = require('./history');

const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
const MAX_CLIENTES = 1000; // tope para no disparar tokens

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

function buildContext(clientes, llamadas, metrics, history) {
  const m = metrics;
  const portfolio = buildPortfolio(clientes, llamadas);

  const resumen = [
    `Total clientes: ${m.totalClientes}`,
    `Deuda total: $${money(m.deudaTotal)}`,
    `Deuda vencida: $${money(m.deudaVencida)} (${m.deudaTotal ? Math.round((m.deudaVencida / m.deudaTotal) * 100) : 0}% del total)`,
    `Crédito ofrecido: $${money(m.creditoOfrecido)} (utilización ${m.utilizacionCredito}%)`,
    `Ticket promedio de deuda: $${money(m.ticketPromedio)}`,
    `Clientes contactados: ${m.clientesContactados} (tasa ${m.tasaContacto}%)`,
    `Llamadas: ${m.totalLlamadas}; con compromiso de pago: ${m.llamadasConCompromiso}`,
  ].join('\n');

  const intencion = m.intencionDistribucion.map((d) => `  ${d.label}: ${d.count} (${d.pct}%)`).join('\n');
  const severidad = m.aging.map((a) => `  ${a.bucket}: $${money(a.monto)} (${a.clientes} clientes)`).join('\n');

  const hist = (history || []).slice(-30)
    .map((h) => `  ${h.date}: total $${money(h.deudaTotal)}, vencido $${money(h.deudaVencida)}${h.seeded ? ' (est.)' : ''}`)
    .join('\n');

  const orden = [...clientes].sort((a, b) => (b.deuda_total || 0) - (a.deuda_total || 0));
  const truncado = orden.length > MAX_CLIENTES;
  const filas = orden.slice(0, MAX_CLIENTES)
    .map((c) => `${c.name} | total ${money(c.deuda_total)} | vencido ${money(c.deuda_vencida)} | limite ${money(c.credito_ofrecido)} | tel ${c.phone}`)
    .join('\n');

  // Detalle de llamadas (si hay): intención + notas por cliente contactado.
  const llamadasCtx = portfolio.filter((p) => p.contactado)
    .map((p) => `${p.name} | intención ${p.intencion_pago} | fecha_pago "${p.fecha_pago}" | ${p.notas}`)
    .join('\n');

  return [
    `# RESUMEN DE CARTERA\n${resumen}`,
    `\n# INTENCIÓN DE PAGO (por cliente, última llamada)\n${intencion}`,
    `\n# SEVERIDAD DE DEUDA (por % vencido)\n${severidad}`,
    hist ? `\n# HISTÓRICO DE DEUDA (últimos días)\n${hist}` : '',
    llamadasCtx ? `\n# RESULTADOS DE LLAMADAS\n${llamadasCtx}` : '',
    `\n# CLIENTES (ordenados por deuda total, moneda DOP)${truncado ? ` — mostrando top ${MAX_CLIENTES} de ${orden.length}` : ''}\n${filas}`,
  ].filter(Boolean).join('\n');
}

async function ask(question) {
  const { clientes, llamadas } = await getCachedData();
  const metrics = computeMetrics(clientes, llamadas);
  const history = await getDailyHistory().catch(() => []);

  if (!process.env.OPENAI_API_KEY) {
    return {
      noKey: true,
      answer: '⚠ Esta función necesita una OPENAI_API_KEY configurada en server/.env para responder con IA. Ya tienes el modelo listo (gpt-4.1-mini); solo agrega la key y reinicia.',
    };
  }

  const context = buildContext(clientes, llamadas, metrics, history);

  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60000 });

  const system =
    'Eres un analista experto en cobranzas. Respondes preguntas y haces proyecciones usando ' +
    'EXCLUSIVAMENTE los datos proporcionados de la cartera (moneda: pesos dominicanos, DOP). ' +
    'Puedes calcular sumas, porcentajes, proyecciones y escenarios ("qué pasaría si..."). ' +
    'Si la pregunta pide algo que no está en los datos, dilo claramente en vez de inventar. ' +
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
