import { Fragment, useEffect, useMemo, useState } from 'react';
import { fetchCobros, fetchCobrosCliente, tomarFotoCobros } from '../api';
import { money, num } from '../format';
import { EMPTY_RANGE } from '../dateRange';
import { usePaged } from '../usePaged';
import KpiCard from './KpiCard';
import BarList from './BarList';
import DateRange from './DateRange';
import Pager from './Pager';

const TIPO = {
  abono: { label: 'Abono', tip: 'La factura sigue abierta con menos saldo' },
  saldada: { label: 'Saldada', tip: 'La factura ya no está abierta: se pagó lo que quedaba (o se anuló / nota de crédito)' },
  inicial: { label: 'Pago inicial', tip: 'Factura nueva que llegó con parte ya pagada' },
};
const fechaCorta = (ymd) => {
  if (!ymd) return '—';
  const [y, m, d] = String(ymd).slice(0, 10).split('-');
  return `${d}/${m}/${y.slice(2)}`;
};
const hora = (iso) => (iso ? new Date(iso).toLocaleString('es-DO', { dateStyle: 'short', timeStyle: 'short' }) : '—');

/**
 * Lo cobrado, detectado comparando la foto diaria de las facturas abiertas del
 * ERP con la anterior. Todo se arma con lo que JH ya expone.
 */
export default function CobrosView({ esAdmin }) {
  const [range, setRange] = useState(EMPTY_RANGE);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [soloCartera, setSoloCartera] = useState(true);
  const [abierto, setAbierto] = useState(null);
  const [detalle, setDetalle] = useState({});
  const [tomando, setTomando] = useState(false);
  const [aviso, setAviso] = useState(null);

  const cargar = () => {
    setError(null);
    fetchCobros({ desde: range.from, hasta: range.to })
      .then(setData)
      .catch((e) => setError(e.message));
  };
  useEffect(cargar, [range.from, range.to]);

  const clientes = useMemo(
    () => (data ? data.clientes.filter((c) => !soloCartera || c.enCartera) : []),
    [data, soloCartera],
  );
  const { slice, start, pager } = usePaged(clientes, 25);

  const abrir = (codigo) => {
    if (abierto === codigo) { setAbierto(null); return; }
    setAbierto(codigo);
    if (!detalle[codigo]) {
      fetchCobrosCliente(codigo)
        .then((d) => setDetalle((p) => ({ ...p, [codigo]: d })))
        .catch((e) => setDetalle((p) => ({ ...p, [codigo]: { error: e.message } })));
    }
  };

  const tomarAhora = async () => {
    setTomando(true); setAviso(null);
    try {
      const r = await tomarFotoCobros();
      setAviso(`Foto del ${fechaCorta(r.fecha)}: ${num(r.facturas)} facturas abiertas${r.desde ? `, ${num(r.cobros)} cobros por ${money(r.cobrado)} desde el ${fechaCorta(r.desde)}` : ' (primera foto: los cobros se ven desde la próxima)'}.`);
      setDetalle({});
      cargar();
    } catch (e) {
      setAviso(`No se pudo tomar la foto: ${e.message}`);
    } finally {
      setTomando(false);
    }
  };

  if (error) return <div className="card"><div className="empty-state">No se pudieron cargar los cobros: {error}</div></div>;
  if (!data) return <div className="card"><div className="empty-state">Cargando cobros…</div></div>;

  const dias = data.dias;
  const totalCartera = clientes.reduce((s, c) => s + c.monto, 0);
  const promedio = dias.length ? data.total / dias.length : 0;
  const saldadas = dias.reduce((s, d) => s + d.saldadas, 0);
  const sinComparar = data.fotos < 2;

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div>
            <h3>Cobros detectados</h3>
            <div className="card-sub" style={{ marginBottom: 0 }}>
              Cada día se guarda una foto de las facturas abiertas del ERP y se compara con la anterior: si el saldo de una factura bajó, eso es lo cobrado.
              {data.primeraFoto
                ? <> Fotos desde el {fechaCorta(data.primeraFoto)} · última: {hora(data.ultimaFoto && data.ultimaFoto.tomado_en)}.</>
                : <> Todavía no hay fotos.</>}
              {!data.erp && !data.ultimaFoto && <> <b>El ERP no está configurado en este servidor</b> (faltan las variables MSSQL_*).</>}
            </div>
          </div>
          {esAdmin && data.erp && (
            <button className="btn secondary" onClick={tomarAhora} disabled={tomando} title="Reemplaza la foto de hoy con lo que dice el ERP ahora">
              {tomando ? 'Tomando foto…' : 'Tomar foto ahora'}
            </button>
          )}
        </div>
        {aviso && <div className="chart-note" style={{ marginTop: 10 }}>{aviso}</div>}
        <div className="toolbar" style={{ padding: '12px 0 0' }}>
          <DateRange value={range} onChange={setRange} />
        </div>
      </div>

      {sinComparar ? (
        <div className="card">
          <div className="empty-state">
            {data.fotos === 1
              ? <>Ya está la primera foto ({fechaCorta(data.primeraFoto)}). Los cobros aparecen con la siguiente, después del cierre de hoy.</>
              : <>Los cobros aparecen a partir de la segunda foto diaria.</>}
          </div>
        </div>
      ) : (
        <>
          <div className="grid kpis">
            <KpiCard label="Cobrado en el período" value={money(data.total)} foot={`${num(dias.length)} día(s) con cobros`} accent="var(--good)" />
            <KpiCard label="Promedio por día" value={money(promedio)} foot="días con cobros detectados" />
            <KpiCard label="Clientes que pagaron" value={num(data.clientes.length)} foot={`${num(data.clientes.filter((c) => c.enCartera).length)} de la cartera del panel`} />
            <KpiCard label="Facturas saldadas" value={num(saldadas)} foot="incluye anuladas / notas de crédito" />
          </div>

          <div className="card">
            <h3>Cobrado por día</h3>
            <div className="card-sub">Cada barra es lo que bajaron las facturas entre la foto anterior y la de ese día.</div>
            {dias.length
              ? <BarList items={[...dias].reverse().map((d) => ({ label: fechaCorta(d.fecha), value: d.monto, display: `${money(d.monto)} · ${num(d.clientes)} cl.` }))} formatValue={money} />
              : <div className="empty-state" style={{ padding: 24 }}>Sin cobros en este período.</div>}
          </div>
        </>
      )}

      {!sinComparar && (
        <div className="card" style={{ padding: 0 }}>
          <div className="toolbar" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <h3 style={{ margin: 0 }}>Por cliente</h3>
              <div className="card-sub" style={{ margin: 0 }}>{num(clientes.length)} clientes · {money(totalCartera)}</div>
            </div>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.83rem' }}>
              <input type="checkbox" checked={soloCartera} onChange={(e) => setSoloCartera(e.target.checked)} />
              Solo clientes de la cartera
            </label>
          </div>
          <Pager p={pager} />
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Cliente</th>
                  <th className="num">Cobrado</th>
                  <th className="num">Facturas</th>
                  <th className="num">Días con pago</th>
                  <th>Último pago</th>
                  <th className="num">Deuda hoy</th>
                </tr>
              </thead>
              <tbody>
                {slice.map((c, i) => (
                  <Fragment key={c.codigo}>
                    <tr onClick={() => abrir(c.codigo)} style={{ cursor: 'pointer' }}>
                      <td style={{ color: 'var(--text-muted)' }}>{start + i + 1}</td>
                      <td>
                        <div style={{ fontWeight: 600 }}>{c.nombre || `Cód. ${c.codigo}`}</div>
                        <div style={{ color: 'var(--text-muted)', fontSize: '0.76rem' }}>Cód. {c.codigo}{!c.enCartera && ' · fuera de la cartera del panel'}</div>
                      </td>
                      <td className="num" style={{ fontWeight: 600 }}>{money(c.monto)}</td>
                      <td className="num">{num(c.facturas)}</td>
                      <td className="num">{num(c.dias)}</td>
                      <td>{fechaCorta(c.ultimo)}</td>
                      <td className="num">{c.deudaHoy != null ? money(c.deudaHoy) : '—'}</td>
                    </tr>
                    {abierto === c.codigo && (
                      <tr>
                        <td colSpan={7} style={{ background: 'var(--surface-2, transparent)' }}>
                          <DetalleCliente d={detalle[c.codigo]} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {!slice.length && (
                  <tr><td colSpan={7} className="empty-state" style={{ padding: 24 }}>Sin cobros en este período.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function DetalleCliente({ d }) {
  if (!d) return <div style={{ padding: 8, color: 'var(--text-muted)' }}>Cargando…</div>;
  if (d.error) return <div style={{ padding: 8 }}>No se pudo cargar: {d.error}</div>;
  const saldos = d.saldos || [];
  const primero = saldos[0], ultimo = saldos[saldos.length - 1];
  return (
    <div style={{ padding: '6px 4px 10px' }}>
      {primero && ultimo && saldos.length > 1 && (
        <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: 8 }}>
          Saldo en el ERP: {money(primero.balance)} el {fechaCorta(primero.fecha)} → {money(ultimo.balance)} el {fechaCorta(ultimo.fecha)}
          {' '}(vencido {money(primero.vencido)} → {money(ultimo.vencido)})
        </div>
      )}
      <table>
        <thead>
          <tr>
            <th>Visto el</th>
            <th>Entre fotos</th>
            <th>Factura</th>
            <th>Tipo</th>
            <th className="num">Cobrado</th>
            <th className="num">Saldo antes</th>
            <th className="num">Saldo después</th>
          </tr>
        </thead>
        <tbody>
          {d.cobros.map((c) => (
            <tr key={`${c.fecha}-${c.sec_fact}`}>
              <td>{fechaCorta(c.fecha)}</td>
              <td style={{ color: 'var(--text-muted)' }}>{fechaCorta(c.desde)} → {fechaCorta(c.fecha)}</td>
              <td>{c.n_factura || c.sec_fact}</td>
              <td title={(TIPO[c.tipo] || {}).tip}>{(TIPO[c.tipo] || { label: c.tipo }).label}</td>
              <td className="num" style={{ fontWeight: 600 }}>{money(c.monto)}</td>
              <td className="num">{c.resta_antes != null ? money(c.resta_antes) : '—'}</td>
              <td className="num">{money(c.resta_despues)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
