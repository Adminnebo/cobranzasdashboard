/**
 * Cobros detectados a diario.
 *
 * El ERP de JH no expone los pagos. Lo que sí expone (SQL Server, base simJH):
 *   - Hist_FacturasCxCAI: cada factura abierta con su saldo (Resta)
 *   - Hist_BalancesClientesIA: el saldo de cada cliente
 * Las dos tablas solo tienen el día de hoy. Por eso aquí se toma una foto al
 * día y se compara con la anterior:
 *   - la factura sigue y su Resta bajó   -> abono (lo que bajó)
 *   - la factura ya no está               -> saldada (lo que le quedaba)
 *   - factura nueva con parte ya pagada   -> inicial (Total - Resta)
 * Una factura que desaparece también puede ser una anulación o nota de crédito;
 * el ERP no deja distinguirlo.
 */

const db = require('./supabaseDb');
const { ymdInTz, TZ } = require('./schedule');

const LOTE = 500;          // filas por INSERT a Supabase
const PAGINA = 1000;       // tope de filas por SELECT de PostgREST
const DIAS_FOTO = 90;      // días que se guardan las facturas de cada foto
const MIN_PROPORCION = 0.5; // una foto con menos de la mitad de facturas que la anterior se descarta
const CENTAVO = 0.005;

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const env = (...ks) => { for (const k of ks) if (process.env[k]) return process.env[k]; return ''; };

// ── SQL Server (ERP de JH) ──────────────────────────────────────────────────
const sqlConfig = () => ({
  server: env('MSSQL_SERVER', 'MSSQL_HOST'),
  port: parseInt(env('MSSQL_PORT') || '1433', 10),
  user: env('MSSQL_USER'),
  password: env('MSSQL_PASSWORD'),
  database: env('MSSQL_DATABASE'),
  options: { encrypt: env('MSSQL_ENCRYPT') === 'true', trustServerCertificate: true },
  requestTimeout: 120000,
  pool: { max: 2, min: 0, idleTimeoutMillis: 30000 },
});
const erpConfigurado = () => { const c = sqlConfig(); return !!(c.server && c.user && c.password && c.database); };

async function leerErp() {
  const sql = require('mssql');
  const pool = await new sql.ConnectionPool(sqlConfig()).connect();
  try {
    const f = await pool.request().query(
      `SELECT SecFact, nFactura, Cliente, Empresa, Fecha, Vencimiento, Total, Resta FROM Hist_FacturasCxCAI`);
    const c = await pool.request().query(
      `SELECT Codigo, Balance, Vencido, Limite FROM Hist_BalancesClientesIA
        WHERE FechaHora = (SELECT MAX(FechaHora) FROM Hist_BalancesClientesIA)`);
    return { facturas: f.recordset, clientes: c.recordset };
  } finally {
    await pool.close().catch(() => {});
  }
}

const fechaIso = (v) => (v == null || v === '' ? null : new Date(v).toISOString());

/** Filas del ERP -> filas de cxc_factura_foto (sin la fecha de la foto). */
function normalizarFacturas(rows) {
  const vistas = new Map();
  for (const r of rows || []) {
    const sec = Number(r.SecFact);
    if (!Number.isFinite(sec)) continue;
    let resta = r2(r.Resta);
    if (Math.abs(resta) < CENTAVO) resta = 0; // el ERP guarda residuos tipo 1e-13
    vistas.set(sec, {
      sec_fact: sec,
      n_factura: r.nFactura != null ? Number(r.nFactura) : null,
      cliente: r.Cliente != null ? Number(r.Cliente) : null,
      empresa: r.Empresa != null ? Number(r.Empresa) : null,
      fecha_factura: fechaIso(r.Fecha),
      vencimiento: fechaIso(r.Vencimiento),
      total: r2(r.Total),
      resta,
    });
  }
  return [...vistas.values()];
}

function normalizarClientes(rows) {
  const vistos = new Map();
  for (const r of rows || []) {
    const codigo = Number(r.Codigo);
    if (!Number.isFinite(codigo)) continue;
    vistos.set(codigo, { codigo, balance: r2(r.Balance), vencido: r2(r.Vencido), limite: r2(r.Limite) });
  }
  return [...vistos.values()];
}

/**
 * Compara dos fotos de facturas y devuelve lo cobrado entre ambas.
 * `antes` y `ahora` son filas normalizadas (sec_fact, resta, total, ...).
 */
function detectarCobros(antes, ahora, { fecha, desde }) {
  const ahoraPor = new Map(ahora.map((f) => [f.sec_fact, f]));
  const antesPor = new Map(antes.map((f) => [f.sec_fact, f]));
  const out = [];
  const fila = (f, tipo, monto, restaAntes, restaDespues) => ({
    fecha, desde, sec_fact: f.sec_fact, cliente: f.cliente, n_factura: f.n_factura, empresa: f.empresa,
    tipo, monto: r2(monto), resta_antes: restaAntes == null ? null : r2(restaAntes), resta_despues: r2(restaDespues),
  });

  for (const a of antes) {
    const h = ahoraPor.get(a.sec_fact);
    if (!h) {
      if (a.resta >= CENTAVO * 2) out.push(fila(a, 'saldada', a.resta, a.resta, 0));
    } else if (a.resta - h.resta >= CENTAVO * 2) {
      out.push(fila(h, h.resta < CENTAVO ? 'saldada' : 'abono', a.resta - h.resta, a.resta, h.resta));
    }
  }
  for (const h of ahora) {
    if (antesPor.has(h.sec_fact)) continue;
    const pagado = h.total - h.resta;
    if (h.total > 0 && pagado >= CENTAVO * 2) out.push(fila(h, 'inicial', pagado, null, h.resta));
  }
  return out;
}

// ── Supabase ────────────────────────────────────────────────────────────────
async function selectTodo(tabla, query) {
  const out = [];
  for (let offset = 0; ; offset += PAGINA) {
    const filas = await db.select(tabla, `${query}&limit=${PAGINA}&offset=${offset}`);
    out.push(...(filas || []));
    if (!filas || filas.length < PAGINA) return out;
  }
}
async function insertarPorLotes(tabla, filas) {
  for (let i = 0; i < filas.length; i += LOTE) await db.insert(tabla, filas.slice(i, i + LOTE));
}
const restarDias = (ymd, n) => {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

async function fotoAnterior(fecha) {
  const r = await db.select('cxc_foto', `?select=*&completa=is.true&fecha=lt.${fecha}&order=fecha.desc&limit=1`);
  return (r && r[0]) || null;
}

let enCurso = null;

/**
 * Toma la foto de hoy y detecta lo cobrado desde la anterior. Volver a tomarla
 * el mismo día la reemplaza (y recalcula los cobros de ese día).
 */
function tomarFoto(opts = {}) {
  if (enCurso) return enCurso;
  enCurso = tomarFotoAhora(opts).finally(() => { enCurso = null; });
  return enCurso;
}

async function tomarFotoAhora({ origen = 'cron', leer = leerErp, ahora = new Date() } = {}) {
  if (leer === leerErp && !erpConfigurado()) throw new Error('ERP no configurado (MSSQL_SERVER / MSSQL_USER / MSSQL_PASSWORD / MSSQL_DATABASE)');
  const fecha = ymdInTz(ahora);
  const erp = await leer();
  const facturas = normalizarFacturas(erp.facturas);
  const clientes = normalizarClientes(erp.clientes);

  const previa = await fotoAnterior(fecha);
  if (!facturas.length) throw new Error('El ERP devolvió 0 facturas abiertas; no se guarda la foto');
  if (previa && previa.facturas && facturas.length < previa.facturas * MIN_PROPORCION) {
    throw new Error(`El ERP devolvió ${facturas.length} facturas contra ${previa.facturas} de la foto del ${previa.fecha}; parece una sincronización a medias, no se guarda`);
  }

  // Marca la foto como incompleta mientras se escribe: si algo falla a mitad,
  // nadie la usa para comparar.
  await db.upsert('cxc_foto', { fecha, tomado_en: ahora.toISOString(), origen, completa: false }, 'fecha');
  await db.del('cxc_factura_foto', `?fecha=eq.${fecha}`);
  await insertarPorLotes('cxc_factura_foto', facturas.map((f) => ({ fecha, ...f })));
  await db.del('cxc_cliente_foto', `?fecha=eq.${fecha}`);
  await insertarPorLotes('cxc_cliente_foto', clientes.map((c) => ({ fecha, ...c })));

  let cobros = [];
  if (previa) {
    const antes = await selectTodo('cxc_factura_foto', `?select=sec_fact,n_factura,cliente,empresa,total,resta&fecha=eq.${previa.fecha}&order=sec_fact.asc`);
    cobros = detectarCobros(antes.map((f) => ({ ...f, resta: Number(f.resta), total: Number(f.total) })), facturas, { fecha, desde: previa.fecha });
  }
  await db.del('cobro_detectado', `?fecha=eq.${fecha}`);
  await insertarPorLotes('cobro_detectado', cobros);

  const resumen = {
    completa: true,
    facturas: facturas.length,
    resta_total: r2(facturas.reduce((s, f) => s + f.resta, 0)),
    clientes: clientes.length,
    desde: previa ? previa.fecha : null,
    cobros: cobros.length,
    cobrado: r2(cobros.reduce((s, c) => s + c.monto, 0)),
  };
  await db.update('cxc_foto', `?fecha=eq.${fecha}`, resumen);

  // Las facturas de cada foto solo hacen falta para comparar con la siguiente.
  await db.del('cxc_factura_foto', `?fecha=lt.${restarDias(fecha, DIAS_FOTO)}`).catch((e) => console.error('[cobros] limpieza:', e.message));

  console.log(`[cobros] foto ${fecha} (${origen}): ${resumen.facturas} facturas, ${resumen.cobros} cobros = ${resumen.cobrado}${previa ? ` desde ${previa.fecha}` : ' (primera foto, sin comparar)'}`);
  return { fecha, ...resumen };
}

/** Si hoy todavía no hay foto completa, la toma (al arrancar el servidor). */
async function ponerseAlDia() {
  if (!erpConfigurado()) return null;
  const hoy = ymdInTz();
  const r = await db.select('cxc_foto', `?select=fecha&fecha=eq.${hoy}&completa=is.true`);
  if (r && r.length) return null;
  return tomarFoto({ origen: 'inicio' });
}

// ── Lectura para el panel ───────────────────────────────────────────────────
async function resumen({ desde, hasta } = {}) {
  const fotos = await db.select('cxc_foto', '?select=*&order=fecha.desc&limit=400');
  let q = '?select=fecha,desde,sec_fact,cliente,tipo,monto&order=fecha.asc,sec_fact.asc';
  if (desde) q += `&fecha=gte.${desde}`;
  if (hasta) q += `&fecha=lte.${hasta}`;
  const cobros = await selectTodo('cobro_detectado', q);

  const dias = new Map();
  const clientes = new Map();
  for (const c of cobros) {
    const monto = Number(c.monto) || 0;
    const d = dias.get(c.fecha) || { fecha: c.fecha, desde: c.desde, monto: 0, abonos: 0, saldadas: 0, iniciales: 0, clientes: new Set() };
    d.monto += monto;
    if (c.tipo === 'abono') d.abonos++; else if (c.tipo === 'saldada') d.saldadas++; else d.iniciales++;
    d.clientes.add(c.cliente);
    dias.set(c.fecha, d);

    const k = String(c.cliente);
    const cl = clientes.get(k) || { codigo: k, monto: 0, facturas: 0, dias: new Set(), ultimo: null };
    cl.monto += monto;
    cl.facturas++;
    cl.dias.add(c.fecha);
    if (!cl.ultimo || c.fecha > cl.ultimo) cl.ultimo = c.fecha;
    clientes.set(k, cl);
  }

  const completas = (fotos || []).filter((f) => f.completa);
  return {
    tz: TZ,
    erp: erpConfigurado(),
    ultimaFoto: completas[0] || null,
    primeraFoto: completas.length ? completas[completas.length - 1].fecha : null,
    fotos: completas.length,
    total: r2(cobros.reduce((s, c) => s + (Number(c.monto) || 0), 0)),
    dias: [...dias.values()].map((d) => ({ ...d, monto: r2(d.monto), clientes: d.clientes.size })),
    clientes: [...clientes.values()]
      .map((c) => ({ ...c, monto: r2(c.monto), dias: c.dias.size }))
      .sort((a, b) => b.monto - a.monto),
  };
}

async function deCliente(codigo) {
  const c = encodeURIComponent(String(codigo));
  const [cobros, saldos] = await Promise.all([
    db.select('cobro_detectado', `?select=*&cliente=eq.${c}&order=fecha.desc,sec_fact.asc&limit=500`),
    db.select('cxc_cliente_foto', `?select=fecha,balance,vencido,limite&codigo=eq.${c}&order=fecha.asc&limit=400`),
  ]);
  return { codigo: String(codigo), cobros: cobros || [], saldos: saldos || [] };
}

module.exports = {
  tomarFoto, ponerseAlDia, resumen, deCliente, erpConfigurado,
  // para tests
  detectarCobros, normalizarFacturas, normalizarClientes,
};
