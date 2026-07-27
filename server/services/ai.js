/**
 * Capa de IA del dashboard. Toma la cartera (clientes + su última llamada) y
 * produce el análisis: probabilidad de pago por cliente, categoría, acción
 * recomendada, prioridad, monto esperado + un resumen ejecutivo y riesgos.
 *
 * Modelo por defecto: gpt-4.1-mini (barato y suficiente para clasificación +
 * razonamiento corto). Si no hay OPENAI_API_KEY, cae a un análisis heurístico
 * determinístico para que el prototipo corra sin credenciales.
 */

const { INTENCION_CON_COMPROMISO } = require('./metrics');

const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

// ── Une cada cliente con su última llamada ──────────────────────────────────
function buildPortfolio(clientes, llamadas) {
  const byTel = new Map();
  for (const ll of llamadas) {
    const prev = byTel.get(ll.phone);
    if (!prev || new Date(ll.created_at) > new Date(prev.created_at)) byTel.set(ll.phone, ll);
  }
  return clientes.map((c) => {
    const ll = byTel.get(c.phone) || null;
    return {
      phone: c.phone,
      name: c.name,
      empresa: c.empresa,
      deuda_total: c.deuda_total,
      deuda_vencida: c.deuda_vencida,
      credito_ofrecido: c.credito_ofrecido,
      dias_mora: c.dias_mora,
      contactado: !!ll,
      intencion_pago: ll ? ll.intencion_pago : 'no_contactado',
      fecha_pago: ll ? ll.fecha_pago : '',
      notas: ll ? ll.notas : '',
      transcripcion: ll ? ll.transcripcion : '',
    };
  });
}

// ── Heurística de respaldo (sin OpenAI) ─────────────────────────────────────
const BASE_PROB = {
  ya_pago: 99,
  pago_inmediato: 92,
  fecha_especifica: 78,
  proximo_corte: 62,
  negociacion: 55,
  promesa_vaga: 38,
  ninguno: 28,
  sin_dato: 25,
  no_contesta: 22,
  evasivo: 15,
  disputa: 18,
  sin_intencion: 8,
  no_contactado: 30,
};

function heuristicClient(p) {
  let prob = BASE_PROB[p.intencion_pago] ?? 30;
  // Severidad: entre más alto el % vencido, menor la probabilidad de pago.
  const ratio = p.deuda_total > 0 ? (p.deuda_vencida || 0) / p.deuda_total : (p.deuda_vencida > 0 ? 1 : 0);
  if (ratio > 0.75) prob -= 15;
  else if (ratio > 0.25) prob -= 8;
  else if (p.deuda_vencida <= 0) prob += 8;
  // Refuerzo por días de mora si la fuente los trae.
  if (p.dias_mora > 90) prob -= 10;
  else if (p.dias_mora > 60) prob -= 5;
  prob = Math.max(3, Math.min(97, Math.round(prob)));

  const categoria = prob >= 65 ? 'Alta' : prob >= 35 ? 'Media' : 'Baja';
  const montoEsperado = Math.round((p.deuda_vencida || p.deuda_total || 0) * (prob / 100));

  let accion;
  if (p.intencion_pago === 'no_contactado') accion = 'Realizar primer intento de contacto';
  else if (p.intencion_pago === 'disputa') accion = 'Escalar a aclaración de cuenta / facturación';
  else if (p.intencion_pago === 'sin_intencion') accion = 'Evaluar reestructura o pase a legal';
  else if (p.intencion_pago === 'promesa_vaga' || p.intencion_pago === 'no_contesta') accion = 'Reagendar seguimiento en 3-5 días';
  else if (p.intencion_pago === 'negociacion') accion = 'Autorizar plan/quita y formalizar';
  else accion = 'Confirmar y dar seguimiento a la fecha comprometida';

  return {
    phone: p.phone,
    name: p.name,
    empresa: p.empresa,
    probabilidad_pago: prob,
    categoria,
    monto_esperado: montoEsperado,
    prioridad: Math.round((prob / 100) * (p.deuda_vencida || p.deuda_total || 0)),
    accion_recomendada: accion,
    razon: `Intención "${p.intencion_pago}"; vencido $${(p.deuda_vencida || 0).toLocaleString('es-MX')} de $${(p.deuda_total || 0).toLocaleString('es-MX')}.`,
  };
}

function heuristicAnalysis(portfolio) {
  const clientes = portfolio.map(heuristicClient).sort((a, b) => b.prioridad - a.prioridad);
  const recuperacionEstimada = clientes.reduce((s, c) => s + c.monto_esperado, 0);
  const alta = clientes.filter((c) => c.categoria === 'Alta').length;
  const baja = clientes.filter((c) => c.categoria === 'Baja').length;
  const disputas = portfolio.filter((p) => p.intencion_pago === 'disputa').length;

  const resumen =
    `De ${portfolio.length} clientes en cartera, ${alta} tienen alta probabilidad de pago y ${baja} baja. ` +
    `La recuperación estimada ponderada por probabilidad es de $${recuperacionEstimada.toLocaleString('es-MX')}. ` +
    (disputas ? `Hay ${disputas} disputa(s) que requieren aclaración de cuenta antes de poder cobrar. ` : '') +
    `Priorizar los casos de mayor monto vencido con intención de pago concreta.`;

  return {
    generado_por: 'heuristica',
    modelo: null,
    resumen_ejecutivo: resumen,
    recuperacion_estimada: recuperacionEstimada,
    riesgos: buildRiesgos(portfolio),
    clientes,
  };
}

function buildRiesgos(portfolio) {
  const riesgos = [];
  const incobrables = portfolio.filter((p) => p.intencion_pago === 'sin_intencion');
  const totalMora = portfolio.filter((p) => p.deuda_total > 0 && p.deuda_vencida / p.deuda_total > 0.75);
  const disputas = portfolio.filter((p) => p.intencion_pago === 'disputa');
  if (incobrables.length)
    riesgos.push(`${incobrables.length} cliente(s) sin intención de pago — riesgo de incobrable por $${incobrables.reduce((s, p) => s + p.deuda_vencida, 0).toLocaleString('es-MX')}.`);
  if (totalMora.length)
    riesgos.push(`${totalMora.length} cliente(s) con +75% de su saldo vencido concentran $${totalMora.reduce((s, p) => s + p.deuda_vencida, 0).toLocaleString('es-MX')} vencidos.`);
  if (disputas.length)
    riesgos.push(`${disputas.length} disputa(s) bloquean cobro hasta resolver aclaraciones/notas de crédito.`);
  return riesgos;
}

// ── Análisis con OpenAI (gpt-4.1-mini) ──────────────────────────────────────
async function openaiAnalysis(portfolio) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 60000 });

  const system =
    'Eres un analista de cobranzas. Recibes una cartera de clientes con su deuda y el resultado ' +
    'de la última llamada del agente de voz IA. Para cada cliente estima la probabilidad de pago ' +
    '(0-100) basándote en la intención declarada, la transcripción, los días de mora y el monto. ' +
    'Devuelve SOLO JSON válido con el esquema indicado, en español. Sé conciso y accionable.';

  const schema = {
    resumen_ejecutivo: 'string (2-4 frases sobre el estado de la cartera)',
    recuperacion_estimada: 'number (suma de montos esperados ponderados por probabilidad)',
    riesgos: ['string'],
    clientes: [
      {
        phone: 'string',
        probabilidad_pago: 'number 0-100',
        categoria: 'Alta | Media | Baja',
        monto_esperado: 'number',
        prioridad: 'number (monto_vencido * probabilidad/100, para ordenar a quién cobrar primero)',
        accion_recomendada: 'string corta',
        razon: 'string corta',
      },
    ],
  };

  const user =
    `ESQUEMA de salida (JSON):\n${JSON.stringify(schema, null, 2)}\n\n` +
    `CARTERA (${portfolio.length} clientes):\n${JSON.stringify(portfolio, null, 2)}`;

  const resp = await client.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  });

  const parsed = JSON.parse(resp.choices[0].message.content);

  // Enriquecemos con nombre/empresa (el modelo solo devuelve phone) y ordenamos.
  const byTel = new Map(portfolio.map((p) => [p.phone, p]));
  const clientes = (parsed.clientes || [])
    .map((c) => {
      const p = byTel.get(c.phone) || {};
      return { ...c, name: p.name, empresa: p.empresa };
    })
    .sort((a, b) => (b.prioridad || 0) - (a.prioridad || 0));

  return {
    generado_por: 'openai',
    modelo: MODEL,
    usage: resp.usage || null,
    resumen_ejecutivo: parsed.resumen_ejecutivo || '',
    recuperacion_estimada: parsed.recuperacion_estimada || clientes.reduce((s, c) => s + (c.monto_esperado || 0), 0),
    riesgos: parsed.riesgos && parsed.riesgos.length ? parsed.riesgos : buildRiesgos(portfolio),
    clientes,
  };
}

async function analyzePortfolio(clientes, llamadas) {
  const portfolio = buildPortfolio(clientes, llamadas);
  const contactados = portfolio.filter((p) => p.contactado);
  const noContactados = portfolio.filter((p) => !p.contactado);

  // Sin key o sin nadie contactado -> todo heurístico.
  if (!process.env.OPENAI_API_KEY || contactados.length === 0) {
    return heuristicAnalysis(portfolio);
  }

  try {
    // La IA solo razona sobre los contactados (transcripción + intención).
    const ai = await openaiAnalysis(contactados);
    // Los no contactados se rellenan con heurística (primer contacto pendiente).
    const extra = noContactados.map(heuristicClient);
    const clientesAll = [...ai.clientes, ...extra].sort((a, b) => (b.prioridad || 0) - (a.prioridad || 0));
    const recuperacion = clientesAll.reduce((s, c) => s + (c.monto_esperado || 0), 0);
    return {
      ...ai,
      clientes: clientesAll,
      recuperacion_estimada: Math.round(recuperacion),
      riesgos: ai.riesgos && ai.riesgos.length ? ai.riesgos : buildRiesgos(portfolio),
      analizados_ia: contactados.length,
      analizados_heuristica: noContactados.length,
    };
  } catch (err) {
    console.error('[ai] OpenAI falló, usando heurística:', err.message);
    const fallback = heuristicAnalysis(portfolio);
    fallback.aviso = `OpenAI no disponible (${err.message}). Mostrando análisis heurístico.`;
    return fallback;
  }
}

module.exports = { analyzePortfolio, buildPortfolio };
