import { useMemo, useState } from 'react';
import { money, phoneFmt, num } from '../format';
import { usePaged } from '../usePaged';
import { setClientesEnabled, triggerCalls } from '../api';
import Pager from './Pager';
import QueuePanel from './QueuePanel';

const sortValue = {
  name: (c) => (c.name || '').toLowerCase(),
  enabled: (c) => (c.enabled ? 1 : 0),
  credito_ofrecido: (c) => c.credito_ofrecido || 0,
  deuda_total: (c) => c.deuda_total || 0,
  deuda_vencida: (c) => c.deuda_vencida || 0,
  pv: (c) => (c.deuda_total > 0 ? c.deuda_vencida / c.deuda_total : 0),
  util: (c) => (c.credito_ofrecido > 0 ? c.deuda_total / c.credito_ofrecido : 0),
};
const TEXT_COLS = new Set(['name']);

const EMPTY_FILTERS = {
  estado: 'todos',        // todos | activos | inactivos
  vencidoMin: '', vencidoMax: '',
  totalMin: '', totalMax: '',
  pvMin: '',              // % vencido mínimo
  utilMin: '',            // % utilización de crédito mínimo
  soloLlamables: false,   // con teléfono
};

const pctVenc = (c) => (c.deuda_total > 0 ? (c.deuda_vencida / c.deuda_total) * 100 : 0);
const pctUtil = (c) => (c.credito_ofrecido > 0 ? (c.deuda_total / c.credito_ofrecido) * 100 : 0);

export default function ClientesTable({ clientes, onChanged }) {
  const [q, setQ] = useState('');
  const [f, setF] = useState(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [sortKey, setSortKey] = useState('deuda_vencida');
  const [sortDir, setSortDir] = useState('desc');
  const [sel, setSel] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const setFilter = (k, v) => setF((prev) => ({ ...prev, [k]: v }));
  const numOr = (v, def) => (v === '' || v === null || isNaN(Number(v)) ? def : Number(v));

  const toggleSort = (key) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(TEXT_COLS.has(key) ? 'asc' : 'desc'); }
  };

  // ── Filtrado ──
  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    const vMin = numOr(f.vencidoMin, -Infinity), vMax = numOr(f.vencidoMax, Infinity);
    const tMin = numOr(f.totalMin, -Infinity), tMax = numOr(f.totalMax, Infinity);
    const pvMin = numOr(f.pvMin, -Infinity);
    const utilMin = numOr(f.utilMin, -Infinity);

    return clientes.filter((c) => {
      if (f.estado === 'activos' && !c.enabled) return false;
      if (f.estado === 'inactivos' && c.enabled) return false;
      if (f.soloLlamables && !c.phone) return false;

      const venc = c.deuda_vencida || 0;
      const tot = c.deuda_total || 0;
      if (venc < vMin || venc > vMax) return false;
      if (tot < tMin || tot > tMax) return false;
      if (pctVenc(c) < pvMin) return false;
      if (pctUtil(c) < utilMin) return false;

      if (!t) return true;
      return (
        (c.name || '').toLowerCase().includes(t) ||
        (c.empresa || '').toLowerCase().includes(t) ||
        (c.email || '').toLowerCase().includes(t) ||
        String(c.phone || '').includes(t.replace(/\D/g, ''))
      );
    });
  }, [clientes, q, f]);

  const sorted = useMemo(() => {
    const val = sortValue[sortKey];
    if (!val) return filtered;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return 0;
    });
  }, [filtered, sortKey, sortDir]);

  const { slice, start, pager } = usePaged(sorted, 25);

  // Solo los que se pueden llamar (tienen teléfono).
  const llamablesFiltrados = useMemo(() => filtered.filter((c) => c.phone), [filtered]);
  const filtrosActivos = JSON.stringify(f) !== JSON.stringify(EMPTY_FILTERS) || q.trim() !== '';

  // ── Selección ──
  const pageSelected = slice.length > 0 && slice.every((c) => !c.phone || sel.has(c.phone));
  const toggleAllPage = () => {
    const next = new Set(sel);
    if (pageSelected) slice.forEach((c) => next.delete(c.phone));
    else slice.forEach((c) => c.phone && next.add(c.phone));
    setSel(next);
  };
  const toggleOne = (phone) => {
    const next = new Set(sel);
    next.has(phone) ? next.delete(phone) : next.add(phone);
    setSel(next);
  };
  const selectAllFiltered = () => setSel(new Set(llamablesFiltrados.map((c) => c.phone)));

  // ── Acciones ──
  const run = async (fn, okMsg) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fn();
      setMsg({ type: 'ok', text: typeof okMsg === 'function' ? okMsg(r) : okMsg });
      setQueueKey((k) => k + 1); // refresca el panel de la cola
      if (onChanged) onChanged();
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    } finally { setBusy(false); }
  };

  const setEnabled = (phones, enabled) =>
    run(() => setClientesEnabled(phones, enabled),
      `${phones.length} cliente(s) ${enabled ? 'activados' : 'desactivados'}.`);

  const llamar = (phones) => {
    const h = Math.floor(phones.length / 60), mm = phones.length % 60;
    const eta = h ? `${h}h ${mm}min` : `${mm} min`;
    if (phones.length > 5 && !window.confirm(
      `Vas a encolar ${phones.length} llamadas REALES.\n\n` +
      `Se lanzan 1 por minuto dentro del horario laboral (9:00–18:00, L–V).\n` +
      `Tiempo estimado: ~${eta}.\n\n¿Continuar?`
    )) return;

    return run(() => triggerCalls(phones, phones.length > 1 ? 'bulk' : 'manual'), (r) => {
      if (r.inmediata) {
        return r.fallidas
          ? `Llamada fallida: ${(r.detalles && r.detalles[0] && r.detalles[0].error) || 'error'}`
          : '📞 Llamada lanzada.';
      }
      const eh = Math.floor(r.minutosEstimados / 60), em = r.minutosEstimados % 60;
      return `${r.encoladas} encoladas${r.yaEnCola ? ` (${r.yaEnCola} ya estaban en cola)` : ''} · ` +
        `1 por minuto · ~${eh ? `${eh}h ${em}min` : `${em} min`}` +
        (r.enHorario ? '' : ' · en pausa hasta el horario laboral');
    });
  };
  const [queueKey, setQueueKey] = useState(0);

  const selArr = [...sel];
  const caret = (k) => (k === sortKey ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const Th = ({ k, children, cls }) => (
    <th className={`${cls || ''} sortable ${k === sortKey ? 'sorted' : ''}`} onClick={() => toggleSort(k)}>
      {children}<span className="caret">{caret(k)}</span>
    </th>
  );

  return (
    <div>
      <QueuePanel refreshKey={queueKey} />

      <div className="toolbar">
        <input className="search" placeholder="Buscar por nombre, código, teléfono o email…"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="search select" value={f.estado} onChange={(e) => setFilter('estado', e.target.value)}>
          <option value="todos">Todos los estados</option>
          <option value="activos">Solo activos</option>
          <option value="inactivos">Solo inactivos</option>
        </select>
        <button className={`mini-btn ${showFilters ? 'active' : ''}`} onClick={() => setShowFilters((s) => !s)}>
          ⚙ Filtros {filtrosActivos ? '•' : ''}
        </button>
      </div>

      {showFilters && (
        <div className="filters">
          <div className="filter-presets">
            <span className="filter-lbl">Rápidos:</span>
            <button className="chip sm" onClick={() => setF({ ...EMPTY_FILTERS, vencidoMin: '100000', soloLlamables: true })}>Vencido &gt; $100k</button>
            <button className="chip sm" onClick={() => setF({ ...EMPTY_FILTERS, vencidoMin: '500000', soloLlamables: true })}>Vencido &gt; $500k</button>
            <button className="chip sm" onClick={() => setF({ ...EMPTY_FILTERS, pvMin: '75', soloLlamables: true })}>+75% vencido</button>
            <button className="chip sm" onClick={() => setF({ ...EMPTY_FILTERS, utilMin: '100', soloLlamables: true })}>Sobre su límite</button>
            <button className="chip sm" onClick={() => setF({ ...EMPTY_FILTERS, vencidoMin: '1', soloLlamables: true })}>Con vencido</button>
            <button className="chip sm danger" onClick={() => { setF(EMPTY_FILTERS); setQ(''); }}>✕ Limpiar</button>
          </div>

          <div className="filter-grid">
            <label className="filter-field">
              <span>Deuda vencida (mín.)</span>
              <input type="number" className="search" placeholder="0" value={f.vencidoMin} onChange={(e) => setFilter('vencidoMin', e.target.value)} />
            </label>
            <label className="filter-field">
              <span>Deuda vencida (máx.)</span>
              <input type="number" className="search" placeholder="∞" value={f.vencidoMax} onChange={(e) => setFilter('vencidoMax', e.target.value)} />
            </label>
            <label className="filter-field">
              <span>Deuda total (mín.)</span>
              <input type="number" className="search" placeholder="0" value={f.totalMin} onChange={(e) => setFilter('totalMin', e.target.value)} />
            </label>
            <label className="filter-field">
              <span>Deuda total (máx.)</span>
              <input type="number" className="search" placeholder="∞" value={f.totalMax} onChange={(e) => setFilter('totalMax', e.target.value)} />
            </label>
            <label className="filter-field">
              <span>% vencido (mín.)</span>
              <input type="number" className="search" placeholder="0" value={f.pvMin} onChange={(e) => setFilter('pvMin', e.target.value)} />
            </label>
            <label className="filter-field">
              <span>% utilización crédito (mín.)</span>
              <input type="number" className="search" placeholder="0" value={f.utilMin} onChange={(e) => setFilter('utilMin', e.target.value)} />
            </label>
            <label className="filter-field check">
              <input type="checkbox" checked={f.soloLlamables} onChange={(e) => setFilter('soloLlamables', e.target.checked)} />
              <span>Solo con teléfono (llamables)</span>
            </label>
          </div>
        </div>
      )}

      {/* Resumen del grupo filtrado + acciones sobre TODO el grupo */}
      {filtrosActivos && (
        <div className="group-bar">
          <span className="group-count">
            <strong>{num(filtered.length)}</strong> coinciden · <strong>{num(llamablesFiltrados.length)}</strong> llamables
            {' · '}vencido del grupo: <strong>{money(filtered.reduce((s, c) => s + (c.deuda_vencida || 0), 0))}</strong>
          </span>
          <button className="mini-btn" disabled={busy || !llamablesFiltrados.length} onClick={selectAllFiltered}>
            Seleccionar los {num(llamablesFiltrados.length)} llamables
          </button>
          <button className="mini-btn" disabled={busy || !llamablesFiltrados.length}
            onClick={() => setEnabled(llamablesFiltrados.map((c) => c.phone), true)}>
            Activar el grupo
          </button>
          <button className="mini-btn" disabled={busy || !llamablesFiltrados.length}
            onClick={() => setEnabled(llamablesFiltrados.map((c) => c.phone), false)}>
            Desactivar el grupo
          </button>
        </div>
      )}

      {/* Barra de acciones sobre la selección */}
      {selArr.length > 0 && (
        <div className="bulkbar">
          <span className="bulk-count">{num(selArr.length)} seleccionado(s)</span>
          <button className="mini-btn" disabled={busy} onClick={() => setEnabled(selArr, true)}>Activar</button>
          <button className="mini-btn" disabled={busy} onClick={() => setEnabled(selArr, false)}>Desactivar</button>
          <button className="btn call-btn" disabled={busy} onClick={() => llamar(selArr)}>
            {busy ? 'Lanzando…' : `📞 Llamar a ${num(selArr.length)}`}
          </button>
          <button className="mini-btn" onClick={() => setSel(new Set())}>Limpiar selección</button>
        </div>
      )}

      {msg && <div className={`bulk-msg ${msg.type}`}>{msg.text}</div>}

      <Pager p={pager} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th style={{ width: 30 }}>
                <input type="checkbox" checked={pageSelected} onChange={toggleAllPage} title="Seleccionar página" />
              </th>
              <Th k="enabled">Llamar</Th>
              <th>#</th>
              <Th k="name">Cliente</Th>
              <th>Teléfono</th>
              <Th k="credito_ofrecido" cls="num">Crédito</Th>
              <Th k="deuda_total" cls="num">Deuda total</Th>
              <Th k="deuda_vencida" cls="num">Vencida</Th>
              <Th k="pv" cls="num">% venc.</Th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            {slice.map((c, i) => {
              const pv = Math.round(pctVenc(c));
              return (
                <tr key={(c.codigo || c.id || i) + '-' + i} className={sel.has(c.phone) ? 'row-sel' : ''}>
                  <td>
                    <input type="checkbox" disabled={!c.phone} checked={sel.has(c.phone)} onChange={() => toggleOne(c.phone)} />
                  </td>
                  <td>
                    {c.phone ? (
                      <button className={`switch ${c.enabled ? 'on' : ''}`} disabled={busy}
                        title={c.enabled ? 'Activo: entra en el cron diario' : 'Inactivo: no se llama'}
                        onClick={() => setEnabled([c.phone], !c.enabled)}>
                        <span className="knob" />
                      </button>
                    ) : (
                      <span className="no-phone" title="Sin teléfono: su deuda cuenta, pero no se puede llamar">—</span>
                    )}
                  </td>
                  <td style={{ color: 'var(--text-muted)' }}>{start + i + 1}</td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{c.name}</div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.76rem' }}>{c.empresa}</div>
                  </td>
                  <td style={{ fontVariantNumeric: 'tabular-nums', color: c.phone ? undefined : 'var(--text-muted)' }}>
                    {c.phone ? phoneFmt(c.phone) : 'sin teléfono'}
                  </td>
                  <td className="num">{money(c.credito_ofrecido)}</td>
                  <td className="num">{money(c.deuda_total)}</td>
                  <td className="num" style={{ color: c.deuda_vencida > 0 ? 'var(--critical)' : 'var(--text-muted)' }}>
                    {money(c.deuda_vencida)}
                  </td>
                  <td className="num" style={{ color: pv > 75 ? 'var(--critical)' : pv > 25 ? 'var(--serious)' : 'var(--text-secondary)' }}>{pv}%</td>
                  <td>
                    <button className="mini-btn call" disabled={busy || !c.phone} onClick={() => llamar([c.phone])}>
                      📞 Llamar ahora
                    </button>
                  </td>
                </tr>
              );
            })}
            {slice.length === 0 && (
              <tr><td colSpan={10} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 30 }}>Ningún cliente coincide con los filtros.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
