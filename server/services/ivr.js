/**
 * Detección de "no se alcanzó a una persona" en dos categorías:
 *
 *  - IVR de empresa (menú de opciones, "marque la extensión", central
 *    telefónica): es PERMANENTE -> se marca y se desactiva de una.
 *  - Buzón de voz (contestadora / se dejó mensaje): puede ser temporal ->
 *    se reintenta hasta IVR_MAX_BUZON veces (buzones consecutivos) antes de
 *    desactivar.
 *
 * Al desactivar, el cliente queda enabled=false (no se le vuelve a llamar) y con
 * ivr=true. El dato llega en el RESUMEN de la llamada (campo `notas`).
 */

const db = require('./supabaseDb');

const TABLE = 'cliente_config';
const MAX_BUZON = parseInt(process.env.IVR_MAX_BUZON || '3', 10);

// IVR de empresa: menú/extensión/central -> permanente.
const IVR_EMPRESA_RE = new RegExp(
  [
    '\\bivr\\b',
    'men[uú]\\s*(de\\s*opciones|autom)',
    'men[uú]\\s*automat',
    'marque\\s+(la\\s+)?(extensi[oó]n|opci[oó]n|n[uú]mero)',
    'presione\\s+\\d', 'oprima\\s+\\d',
    'central\\s*telef[oó]nica',
    'opci[oó]n\\s+de\\s+(contabilidad|ventas|soporte|cuentas)',
    'sistema\\s*de\\s*opciones',
  ].join('|'),
  'i'
);

// Buzón de voz / contestadora -> temporal (reintentable).
const BUZON_RE = new RegExp(
  [
    'buz[oó]n',
    'contestador',
    'm[aá]quina\\s*contestadora',
    'grabaci[oó]n\\s*(de\\s*mensajes|autom)',
    'sistema\\s*autom[aá]tico',
    'dej[oó]\\s*(un\\s*)?mensaje',
    'se\\s*dej[oó]\\s*mensaje',
    'voicemail',
    'no\\s*fue\\s*atendida\\s*por\\s*una\\s*persona',
    'no\\s*(contest[oó]|atendi[oó])\\s*una?\\s*persona',
  ].join('|'),
  'i'
);

/** Devuelve 'ivr' | 'buzon' | null para una llamada. */
function tipoIVR(ll) {
  if (!ll) return null;
  const int = String(ll.intencion_pago || '').toLowerCase();
  if (int === 'ivr') return 'ivr';
  const texto = `${ll.notas || ''}\n${ll.transcripcion || ''}`;
  if (IVR_EMPRESA_RE.test(texto)) return 'ivr';
  if (BUZON_RE.test(texto)) return 'buzon';
  return null;
}

/** Compatibilidad: ¿la llamada cayó en IVR o buzón? */
const esIVR = (ll) => tipoIVR(ll) !== null;

function evidencia(ll) {
  const notas = String((ll && ll.notas) || '');
  return notas.slice(0, 160) || 'Detectado en la transcripción';
}

async function getIvrPhones() {
  const rows = await db.select(TABLE, '?select=phone&ivr=is.true');
  return new Set((rows || []).map((r) => String(r.phone)));
}

async function getIvrMap() {
  const rows = await db.select(TABLE, '?select=phone,ivr,ivr_tipo,ivr_at,ivr_detalle&ivr=is.true');
  const m = new Map();
  for (const r of rows || []) m.set(String(r.phone), { at: r.ivr_at, detalle: r.ivr_detalle, tipo: r.ivr_tipo });
  return m;
}

/**
 * Recorre las llamadas y marca (desactivando) a los clientes que:
 *  - cayeron en un IVR de empresa (una vez basta), o
 *  - acumularon MAX_BUZON buzones consecutivos (los más recientes).
 * Idempotente: se recalcula del historial, no re-marca los ya marcados.
 */
async function sincronizar(llamadas) {
  // Agrupa por teléfono, más recientes primero.
  const byPhone = new Map();
  for (const ll of llamadas) {
    if (!ll.phone) continue;
    if (!byPhone.has(ll.phone)) byPhone.set(ll.phone, []);
    byPhone.get(ll.phone).push(ll);
  }
  for (const arr of byPhone.values()) arr.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  const yaMarcados = await getIvrPhones();
  const rows = [];

  for (const [phone, calls] of byPhone) {
    if (yaMarcados.has(phone)) continue;

    // IVR de empresa en cualquier llamada -> permanente.
    const empresa = calls.find((c) => tipoIVR(c) === 'ivr');
    if (empresa) {
      rows.push({ phone, tipo: 'ivr', detalle: evidencia(empresa), at: empresa.created_at });
      continue;
    }

    // Racha de buzones consecutivos desde la llamada más reciente.
    let streak = 0;
    let last = null;
    for (const c of calls) {
      if (tipoIVR(c) === 'buzon') { streak++; if (!last) last = c; }
      else break; // una llamada con persona corta la racha
    }
    if (streak >= MAX_BUZON) {
      rows.push({ phone, tipo: 'buzon', detalle: `Buzón ${streak}x. ${evidencia(last)}`, at: last.created_at });
    }
  }

  if (!rows.length) return { detectados: 0, nuevos: 0 };

  const payload = rows.map((r) => ({
    phone: r.phone,
    enabled: false,          // se apaga: no se le llama más
    ivr: true,
    ivr_tipo: r.tipo,        // 'ivr' | 'buzon'
    ivr_at: r.at || new Date().toISOString(),
    ivr_detalle: r.detalle,
    updated_at: new Date().toISOString(),
    updated_by: 'sistema (IVR)',
  }));
  await db.upsert(TABLE, payload, 'phone');
  const nIvr = rows.filter((r) => r.tipo === 'ivr').length;
  console.log(`[ivr] ${rows.length} marcados y desactivados (${nIvr} IVR empresa, ${rows.length - nIvr} buzón agotado)`);
  return { detectados: rows.length, nuevos: rows.length, phones: rows.map((r) => r.phone) };
}

async function desmarcar(phone) {
  await db.upsert(TABLE, {
    phone: String(phone),
    ivr: false, ivr_tipo: null, ivr_at: null, ivr_detalle: null,
    updated_at: new Date().toISOString(),
  }, 'phone');
  return { ok: true };
}

module.exports = { esIVR, tipoIVR, sincronizar, getIvrPhones, getIvrMap, desmarcar, MAX_BUZON };
