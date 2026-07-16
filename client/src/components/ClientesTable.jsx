import { Fragment, useMemo, useState } from 'react';
import { money, phoneFmt, num } from '../format';
import { usePaged } from '../usePaged';
import { INTENCION, intencionColor, intencionLabel } from '../constants';
import { setClientesEnabled, triggerCalls, resetIvr } from '../api';
import Pager from './Pager';
import QueuePanel from './QueuePanel';
import SchedulePanel from './SchedulePanel';
import ClientCalls from './ClientCalls';

const sortValue = {
  name: (c) => (c.name || '').toLowerCase(),
  enabled: (c) => (c.enabled ? 1 : 0),
  credito_ofrecido: (c) => c.credito_ofrecido || 0,
  deuda_total: (c) => c.deuda_total || 0,
  deuda_vencida: (c) => c.deuda_vencida || 0,
  pv: (c) => (c.deuda_total > 0 ? c.deuda_vencida / c.deuda_total : 0),
  util: (c) => (c.credito_ofrecido > 0 ? c.deuda_total / c.credito_ofrecido : 0),
  // Última llamada: los nunca llamados van al final.
  ultima: (c) => (c.ultimaLlamada ? new Date(c.ultimaLlamada.fecha).getTime() : 0),
};
const TEXT_COLS = new Set(['name']);

const EMPTY_FILTERS = {
  estado: 'todos',        // todos | activos | inactivos | ivr | sin_ivr
  intencion: '',          // intención de la última llamada ('' = todas)
  vencidoMin: '', vencidoMax: '',
  totalMin: '', totalMax: '',
  pvMin: '',              // % vencido mínimo
  utilMin: '',            // % utilización de crédito mínimo
  soloLlamables: false,   // con teléfono
  // ── Filtros de llamadas ──
  nLlamadasMin: '',       // nº de llamadas mínimo
  ultimaDesde: '', ultimaHasta: '',   // rango de fecha de la última llamada
  diasSinContacto: '',    // días desde la última llamada (o nunca) >= N
  conPromesa: false,      // la última llamada dejó una fecha de pago
};

const fmtFecha = (iso) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleDateString('es-MX', { day: '2-digit', month: 'short' }); }
  catch { return ''; }
};

const pctVenc = (c) => (c.deuda_total > 0 ? (c.deuda_vencida / c.deuda_total) * 100 : 0);
const pctUtil = (c) => (c.credito_ofrecido > 0 ? (c.deuda_total / c.credito_ofrecido) * 100 : 0);

export default function ClientesTable({ clientes, llamadas = [], onChanged }) {
  // Llamadas agrupadas por teléfono (más recientes primero).
  const callsByPhone = useMemo(() => {
    const map = new Map();
    for (const ll of llamadas) {
      if (!ll.phone) continue;
      if (!map.has(ll.phone)) map.set(ll.phone, []);
      map.get(ll.phone).push(ll);
    }
    for (const arr of map.values()) arr.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return map;
  }, [llamadas]);

  const [q, setQ] = useState('');
  const [f, setF] = useState(EMPTY_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [sortKey, setSortKey] = useState('deuda_vencida');
  const [sortDir, setSortDir] = useState('desc');
  const [sel, setSel] = useState(() => new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [openCall, setOpenCall] = useState(null); // phone de la fila con detalle abierto

  const setFilter = (k, v) => setF((prev) => ({ ...prev, [k]: v }));
  const numOr = (v, def) => (v === '' || v === null || isNaN(Number(v)) ? def : Number(v));

  // Aplica un preset: fija filtros (y opcionalmente el orden), limpia la búsqueda.
  const applyPreset = (filters, sort) => {
    setF({ ...EMPTY_FILTERS, ...filters });
    setQ('');
    if (sort) { setSortKey(sort.key); setSortDir(sort.dir); }
  };
  const hoyYMD = () => new Date().toLocaleDateString('en-CA');

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
      if (f.estado === 'ivr' && !c.ivr) return false;
      if (f.estado === 'sin_ivr' && c.ivr) return false;
      if (f.soloLlamables && (!c.phone || c.ivr)) return false;

      if (f.intencion) {
        const int = c.ultimaLlamada ? c.ultimaLlamada.intencion : 'no_contactado';
        if (int !== f.intencion) return false;
      }

      const venc = c.deuda_vencida || 0;
      const tot = c.deuda_total || 0;
      if (venc < vMin || venc > vMax) return false;
      if (tot < tMin || tot > tMax) return false;
      if (pctVenc(c) < pvMin) return false;
      if (pctUtil(c) < utilMin) return false;

      // ── Filtros de llamadas ──
      const nc = (callsByPhone.get(c.phone) || []).length;
      if (f.nLlamadasMin !== '' && nc < Number(f.nLlamadasMin)) return false;

      const ult = c.ultimaLlamada ? c.ultimaLlamada.fecha : null;
      if (f.ultimaDesde || f.ultimaHasta) {
        if (!ult) return false;
        const d = new Date(ult).toISOString().slice(0, 10);
        if (f.ultimaDesde && d < f.ultimaDesde) return false;
        if (f.ultimaHasta && d > f.ultimaHasta) return false;
      }
      if (f.diasSinContacto !== '') {
        const min = Number(f.diasSinContacto);
        const dias = ult ? Math.floor((Date.now() - new Date(ult).getTime()) / 86400000) : Infinity;
        if (dias < min) return false;
      }
      if (f.conPromesa && !(c.ultimaLlamada && c.ultimaLlamada.fechaPago)) return false;

      if (!t) return true;
      // Búsqueda por CUALQUIER valor: arma un "texto completo" del cliente.
      const ll = c.ultimaLlamada;
      const hay = [
        c.name, c.empresa, c.codigo, c.email, c.phone,
        c.deuda_total, c.deuda_vencida, c.credito_ofrecido,
        ll && intencionLabel(ll.intencion), ll && ll.fechaPago, ll && ll.notas,
        c.ivr ? 'ivr contestadora' : '', c.enabled ? 'activo' : 'inactivo',
      ].filter((x) => x !== null && x !== undefined && x !== '').join(' ').toLowerCase();

      if (hay.includes(t)) return true;
      // Si escribió números (teléfono, montos, código), compara solo dígitos.
      const digits = t.replace(/\D/g, '');
      return !!digits && hay.replace(/\D/g, '').includes(digits);
    });
  }, [clientes, q, f, callsByPhone]);

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

  // Llamables = con teléfono y NO marcados como IVR.
  const llamablesFiltrados = useMemo(() => filtered.filter((c) => c.phone && !c.ivr), [filtered]);
  const ivrEnGrupo = useMemo(() => filtered.filter((c) => c.ivr).length, [filtered]);
  const filtrosActivos = JSON.stringify(f) !== JSON.stringify(EMPTY_FILTERS) || q.trim() !== '';

  // ── Selección ──
  const selectable = (c) => c.phone && !c.ivr;
  const pageSelected = slice.length > 0 && slice.every((c) => !selectable(c) || sel.has(c.phone));
  const toggleAllPage = () => {
    const next = new Set(sel);
    if (pageSelected) slice.forEach((c) => next.delete(c.phone));
    else slice.forEach((c) => selectable(c) && next.add(c.phone));
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
      <div className="cola-header">
        <QueuePanel refreshKey={queueKey} />
        <SchedulePanel onSaved={() => setQueueKey((k) => k + 1)} />
      </div>

      <div className="toolbar">
        <input className="search" placeholder="Buscar por cualquier dato: nombre, código, teléfono, email, monto, intención…"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="search select" value={f.estado} onChange={(e) => setFilter('estado', e.target.value)}>
          <option value="todos">Todos los estados</option>
          <option value="activos">Solo activos</option>
          <option value="inactivos">Solo inactivos</option>
          <option value="ivr">Solo IVR / contestadora</option>
          <option value="sin_ivr">Excluir IVR</option>
        </select>
        <select className="search select" value={f.intencion} onChange={(e) => setFilter('intencion', e.target.value)}>
          <option value="">Cualquier última llamada</option>
          <option value="no_contactado">Nunca llamados</option>
          {Object.entries(INTENCION).filter(([k]) => k !== 'no_contactado').map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
        <button className={`mini-btn ${showFilters ? 'active' : ''}`} onClick={() => setShowFilters((s) => !s)}>
          ⚙ Filtros {filtrosActivos ? '•' : ''}
        </button>
      </div>

      {showFilters && (
        <div className="filters">
          <div className="filter-presets">
            <span className="filter-lbl">Deuda:</span>
            <button className="chip sm" onClick={() => applyPreset({ vencidoMin: '100000', soloLlamables: true }, { key: 'deuda_vencida', dir: 'desc' })}>Vencido &gt; $100k</button>
            <button className="chip sm" onClick={() => applyPreset({ vencidoMin: '500000', soloLlamables: true }, { key: 'deuda_vencida', dir: 'desc' })}>Vencido &gt; $500k</button>
            <button className="chip sm" onClick={() => applyPreset({ pvMin: '75', soloLlamables: true })}>+75% vencido</button>
            <button className="chip sm" onClick={() => applyPreset({ utilMin: '100', soloLlamables: true })}>Sobre su límite</button>
            <button className="chip sm" onClick={() => applyPreset({ vencidoMin: '1', soloLlamables: true })}>Con vencido</button>
          </div>
          <div className="filter-presets">
            <span className="filter-lbl">Llamadas:</span>
            <button className="chip sm" onClick={() => applyPreset({ nLlamadasMin: '1', soloLlamables: true }, { key: 'ultima', dir: 'desc' })}>🕐 Últimos llamados</button>
            <button className="chip sm" onClick={() => applyPreset({ ultimaDesde: hoyYMD(), soloLlamables: true }, { key: 'ultima', dir: 'desc' })}>Llamados hoy</button>
            <button className="chip sm" onClick={() => applyPreset({ intencion: 'no_contactado', soloLlamables: true })}>Nunca llamados</button>
            <button className="chip sm" onClick={() => applyPreset({ diasSinContacto: '7', soloLlamables: true }, { key: 'ultima', dir: 'asc' })}>Sin contacto 7d+</button>
            <button className="chip sm" onClick={() => applyPreset({ conPromesa: true, soloLlamables: true }, { key: 'ultima', dir: 'desc' })}>Con promesa</button>
            <button className="chip sm" onClick={() => applyPreset({ estado: 'ivr' })}>☎ Solo IVR</button>
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

          <div className="filter-sub">Llamadas</div>
          <div className="filter-grid">
            <label className="filter-field">
              <span>Nº de llamadas (mín.)</span>
              <input type="number" className="search" placeholder="0" value={f.nLlamadasMin} onChange={(e) => setFilter('nLlamadasMin', e.target.value)} />
            </label>
            <label className="filter-field">
              <span>Días sin contacto (mín.)</span>
              <input type="number" className="search" placeholder="ej. 7" value={f.diasSinContacto} onChange={(e) => setFilter('diasSinContacto', e.target.value)} />
            </label>
            <label className="filter-field">
              <span>Última llamada desde</span>
              <input type="date" className="search" value={f.ultimaDesde} onChange={(e) => setFilter('ultimaDesde', e.target.value)} />
            </label>
            <label className="filter-field">
              <span>Última llamada hasta</span>
              <input type="date" className="search" value={f.ultimaHasta} onChange={(e) => setFilter('ultimaHasta', e.target.value)} />
            </label>
            <label className="filter-field check">
              <input type="checkbox" checked={f.conPromesa} onChange={(e) => setFilter('conPromesa', e.target.checked)} />
              <span>Con promesa de pago</span>
            </label>
          </div>
        </div>
      )}

      {/* Resumen del grupo filtrado + acciones sobre TODO el grupo */}
      {filtrosActivos && (
        <div className="group-bar">
          <span className="group-count">
            <strong>{num(filtered.length)}</strong> coinciden · <strong>{num(llamablesFiltrados.length)}</strong> llamables
            {ivrEnGrupo > 0 && <> · <span style={{ color: 'var(--warning)' }}>{num(ivrEnGrupo)} IVR excluidos</span></>}
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
              <Th k="ultima">Última llamada</Th>
              <th>Acción</th>
            </tr>
          </thead>
          <tbody>
            {slice.map((c, i) => {
              const pv = Math.round(pctVenc(c));
              const abierta = openCall === c.phone && c.ultimaLlamada;
              const clientCalls = callsByPhone.get(c.phone) || [];
              const nCalls = clientCalls.length;
              const rowKey = (c.codigo || c.id || i) + '-' + i;
              return (
                <Fragment key={rowKey}>
                <tr
                  className={`${sel.has(c.phone) ? 'row-sel' : ''} ${c.ultimaLlamada ? 'row-clickable' : ''} ${abierta ? 'row-open' : ''}`}
                  onClick={(e) => {
                    // No desplegar si el click fue en un control (checkbox, switch, botón, link).
                    if (e.target.closest('button, input, a, label')) return;
                    if (c.ultimaLlamada) setOpenCall(abierta ? null : c.phone);
                  }}
                >
                  <td>
                    <input type="checkbox" disabled={!selectable(c)} checked={sel.has(c.phone)} onChange={() => toggleOne(c.phone)} />
                  </td>
                  <td>
                    {c.ivr ? (
                      <span className="ivr-badge" title={c.ivrDetalle || 'La llamada cayó en un IVR/contestadora'}>
                        ☎ IVR
                      </span>
                    ) : c.phone ? (
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
                    {c.ultimaLlamada ? (
                      <button
                        className={`ult-llamada as-btn ${abierta ? 'open' : ''}`}
                        title="Ver las llamadas de este cliente"
                        onClick={() => setOpenCall(abierta ? null : c.phone)}
                      >
                        <span className="pill" style={{ color: intencionColor(c.ultimaLlamada.intencion) }}>
                          <span className="pdot" style={{ background: intencionColor(c.ultimaLlamada.intencion) }} />
                          {intencionLabel(c.ultimaLlamada.intencion)}
                        </span>
                        <span className="ult-meta">
                          {abierta ? '▾ ' : '▸ '}{fmtFecha(c.ultimaLlamada.fecha)}
                          {nCalls > 1 && <> · <strong>{nCalls} llamadas</strong></>}
                        </span>
                      </button>
                    ) : (
                      <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>Nunca llamado</span>
                    )}
                  </td>
                  <td>
                    {c.ivr ? (
                      <button className="mini-btn" disabled={busy}
                        title="Quita la marca de IVR y permite volver a llamarlo (útil si consiguieron otro número)"
                        onClick={() => run(() => resetIvr(c.phone), 'Marca de IVR quitada. Ya se puede volver a llamar.')}>
                        ↺ Reactivar
                      </button>
                    ) : (
                      <button className="mini-btn call" disabled={busy || !c.phone} onClick={() => llamar([c.phone])}>
                        📞 Llamar ahora
                      </button>
                    )}
                  </td>
                </tr>
                {abierta && (
                  <tr className="call-detail-row">
                    <td colSpan={11}>
                      <ClientCalls calls={clientCalls} />
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
            {slice.length === 0 && (
              <tr><td colSpan={11} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 30 }}>Ningún cliente coincide con los filtros.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
