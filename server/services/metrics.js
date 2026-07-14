/**
 * Métricas PURAS (sin IA): se calculan determinísticamente sobre las dos
 * fuentes unidas por teléfono. Alimentan la primera fila del dashboard.
 */

// Orden fijo + etiqueta legible de cada intención (usado también para colores en el front).
const INTENCION_LABELS = {
  pago_inmediato: 'Pago inmediato',
  fecha_especifica: 'Fecha específica',
  negociacion: 'Negociación / plan',
  promesa_vaga: 'Promesa vaga',
  disputa: 'Disputa',
  sin_intencion: 'Sin intención',
  no_contesta: 'No contesta',
};

// Intenciones que cuentan como "compromiso de pago" para la tasa correspondiente.
const INTENCION_CON_COMPROMISO = new Set(['pago_inmediato', 'fecha_especifica', 'negociacion']);

const round2 = (n) => Math.round(n * 100) / 100;

// Sin días de mora en la fuente: clasificamos por SEVERIDAD = % vencido / total.
function severityBucket(c) {
  const total = c.deuda_total || 0;
  const venc = c.deuda_vencida || 0;
  if (venc <= 0) return 'Vigente';
  const ratio = total > 0 ? venc / total : 1;
  if (ratio <= 0.25) return '≤25% vencido';
  if (ratio <= 0.75) return '26–75% vencido';
  return '>75% vencido';
}

const AGING_ORDER = ['>75% vencido', '26–75% vencido', '≤25% vencido', 'Vigente'];

function computeMetrics(clientes, llamadas) {
  const totalClientes = clientes.length;

  // Índice de la última llamada por teléfono (por si hubiera varias).
  const llamadaPorTel = new Map();
  for (const ll of llamadas) {
    const prev = llamadaPorTel.get(ll.phone);
    if (!prev || new Date(ll.created_at) > new Date(prev.created_at)) {
      llamadaPorTel.set(ll.phone, ll);
    }
  }

  const clientesContactados = clientes.filter((c) => llamadaPorTel.has(c.phone)).length;

  // Totales de cartera.
  const deudaTotal = round2(clientes.reduce((s, c) => s + (c.deuda_total || 0), 0));
  const deudaVencida = round2(clientes.reduce((s, c) => s + (c.deuda_vencida || 0), 0));
  const creditoOfrecido = round2(clientes.reduce((s, c) => s + (c.credito_ofrecido || 0), 0));
  const creditoUtilizado = deudaTotal;
  const utilizacionCredito = creditoOfrecido > 0 ? round2((creditoUtilizado / creditoOfrecido) * 100) : 0;

  // Distribución de intención (incluye "no_contactado" para los no llamados).
  const intencionCounts = {};
  for (const key of Object.keys(INTENCION_LABELS)) intencionCounts[key] = 0;
  intencionCounts.no_contactado = 0;
  for (const c of clientes) {
    const ll = llamadaPorTel.get(c.phone);
    const key = ll ? ll.intencion_pago : 'no_contactado';
    intencionCounts[key] = (intencionCounts[key] || 0) + 1;
  }
  const intencionDistribucion = Object.entries(intencionCounts)
    .filter(([, v]) => v > 0)
    .map(([key, count]) => ({
      key,
      label: key === 'no_contactado' ? 'No contactado' : INTENCION_LABELS[key],
      count,
      pct: totalClientes ? round2((count / totalClientes) * 100) : 0,
    }));

  const llamadasConCompromiso = llamadas.filter((ll) => INTENCION_CON_COMPROMISO.has(ll.intencion_pago)).length;
  const tasaCompromiso = llamadas.length ? round2((llamadasConCompromiso / llamadas.length) * 100) : 0;

  // Severidad de la deuda (buckets por % vencido), sumando deuda_total.
  const agingMap = {};
  for (const b of AGING_ORDER) agingMap[b] = { bucket: b, monto: 0, clientes: 0 };
  for (const c of clientes) {
    const b = severityBucket(c);
    agingMap[b].monto = round2(agingMap[b].monto + (c.deuda_total || 0));
    agingMap[b].clientes += 1;
  }
  const aging = AGING_ORDER.map((b) => agingMap[b]).filter((x) => x.clientes > 0);

  // Top deudores por saldo vencido (fallback a deuda total).
  const topDeudores = [...clientes]
    .map((c) => ({ name: c.name, empresa: c.empresa, monto: (c.deuda_vencida || 0) || (c.deuda_total || 0), vencido: c.deuda_vencida || 0 }))
    .sort((a, b) => b.monto - a.monto)
    .slice(0, 8);

  // Recuperación comprometida: deuda_total de clientes con compromiso de pago.
  const clientesConTel = new Set([...llamadaPorTel.keys()]);
  let recuperacionComprometida = 0;
  for (const c of clientes) {
    const ll = llamadaPorTel.get(c.phone);
    if (ll && INTENCION_CON_COMPROMISO.has(ll.intencion_pago)) {
      recuperacionComprometida = round2(recuperacionComprometida + (c.deuda_total || 0));
    }
  }

  return {
    totalClientes,
    clientesHabilitados: clientes.filter((c) => c.enabled).length,
    clientesContactados,
    tasaContacto: totalClientes ? round2((clientesContactados / totalClientes) * 100) : 0,
    totalLlamadas: llamadas.length,
    llamadasConCompromiso,
    tasaCompromiso,
    deudaTotal,
    deudaVencida,
    creditoOfrecido,
    creditoUtilizado,
    utilizacionCredito,
    recuperacionComprometida,
    ticketPromedio: totalClientes ? round2(deudaTotal / totalClientes) : 0,
    intencionDistribucion,
    aging,
    topDeudores,
    _clientesConTel: clientesConTel.size, // interno
  };
}

module.exports = { computeMetrics, INTENCION_LABELS, INTENCION_CON_COMPROMISO };
