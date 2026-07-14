import { useMemo, useState } from 'react';
import { money, phoneFmt, num } from '../format';
import { usePaged } from '../usePaged';
import { setClientesEnabled, triggerCalls } from '../api';
import Pager from './Pager';

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

export default function ClientesTable({ clientes, onChanged }) {
  const [q, setQ] = useState('');
  const [soloHabilitados, setSoloHabilitados] = useState(false);
  const [sortKey, setSortKey] = useState('deuda_vencida');
  const [sortDir, setSortDir] = useState('desc');
  const [sel, setSel] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const toggleSort = (key) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(TEXT_COLS.has(key) ? 'asc' : 'desc'); }
  };

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return clientes.filter((c) => {
      if (soloHabilitados && !c.enabled) return false;
      if (!t) return true;
      return (
        (c.name || '').toLowerCase().includes(t) ||
        (c.empresa || '').toLowerCase().includes(t) ||
        (c.email || '').toLowerCase().includes(t) ||
        String(c.phone || '').includes(t.replace(/\D/g, ''))
      );
    });
  }, [clientes, q, soloHabilitados]);

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

  // ── Selección ──
  const pageSelected = slice.length > 0 && slice.every((c) => sel.has(c.phone));
  const toggleAllPage = () => {
    const next = new Set(sel);
    if (pageSelected) slice.forEach((c) => next.delete(c.phone));
    else slice.forEach((c) => next.add(c.phone));
    setSel(next);
  };
  const toggleOne = (phone) => {
    const next = new Set(sel);
    next.has(phone) ? next.delete(phone) : next.add(phone);
    setSel(next);
  };

  // ── Acciones ──
  const run = async (fn, okMsg) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fn();
      setMsg({ type: 'ok', text: typeof okMsg === 'function' ? okMsg(r) : okMsg });
      if (onChanged) onChanged();
    } catch (e) {
      setMsg({ type: 'err', text: e.message });
    } finally { setBusy(false); }
  };

  const setEnabled = (phones, enabled) =>
    run(() => setClientesEnabled(phones, enabled),
      `${phones.length} cliente(s) ${enabled ? 'activados' : 'desactivados'}.`);

  const llamar = (phones) =>
    run(() => triggerCalls(phones, phones.length > 1 ? 'bulk' : 'manual'), (r) => {
      if (r.enSegundoPlano) {
        return `${r.encoladas} llamada(s) encoladas · 1 por minuto (~${r.duracionMin} min)` +
          (r.truncado ? ` · se truncó a ${r.encoladas} de ${r.total} por seguridad` : '');
      }
      return r.fallidas
        ? `Llamada fallida: ${(r.detalles && r.detalles[0] && r.detalles[0].error) || 'error'}`
        : '📞 Llamada lanzada.';
    });

  const selArr = [...sel];
  const caret = (k) => (k === sortKey ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const Th = ({ k, children, cls }) => (
    <th className={`${cls || ''} sortable ${k === sortKey ? 'sorted' : ''}`} onClick={() => toggleSort(k)}>
      {children}<span className="caret">{caret(k)}</span>
    </th>
  );

  return (
    <div>
      <div className="toolbar">
        <input className="search" placeholder="Buscar por nombre, código, teléfono o email…"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="user-admin-check">
          <input type="checkbox" checked={soloHabilitados} onChange={(e) => setSoloHabilitados(e.target.checked)} />
          Solo activos
        </label>
      </div>

      {/* Barra de acciones masivas */}
      {selArr.length > 0 && (
        <div className="bulkbar">
          <span className="bulk-count">{num(selArr.length)} seleccionado(s)</span>
          <button className="mini-btn" disabled={busy} onClick={() => setEnabled(selArr, true)}>Activar</button>
          <button className="mini-btn" disabled={busy} onClick={() => setEnabled(selArr, false)}>Desactivar</button>
          <button className="btn call-btn" disabled={busy} onClick={() => llamar(selArr)}>
            {busy ? 'Lanzando…' : `📞 Llamar a ${selArr.length}`}
          </button>
          <button className="mini-btn" onClick={() => setSel(new Set())}>Limpiar</button>
        </div>
      )}

      {msg && (
        <div className={`bulk-msg ${msg.type}`}>{msg.text}</div>
      )}

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
              const pv = c.deuda_total > 0 ? Math.round((c.deuda_vencida / c.deuda_total) * 100) : 0;
              return (
                <tr key={(c.codigo || c.id || i) + '-' + i} className={sel.has(c.phone) ? 'row-sel' : ''}>
                  <td>
                    <input type="checkbox" disabled={!c.phone} checked={sel.has(c.phone)} onChange={() => toggleOne(c.phone)} />
                  </td>
                  <td>
                    {c.phone ? (
                      <button
                        className={`switch ${c.enabled ? 'on' : ''}`}
                        disabled={busy}
                        title={c.enabled ? 'Activo: entra en el cron diario' : 'Inactivo: no se llama'}
                        onClick={() => setEnabled([c.phone], !c.enabled)}
                      >
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
              <tr><td colSpan={10} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 30 }}>Sin resultados.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
