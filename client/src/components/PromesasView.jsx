import { useEffect, useMemo, useState } from 'react';
import { fetchPromesasLista, revisarPromesasAhora } from '../api';
import { money } from '../format';

// Estados de una promesa (los pone el motor del follow up).
const ESTADOS = {
  pendiente:      { label: 'Esperando la fecha', color: 'var(--text-secondary)', abierta: true },
  en_seguimiento: { label: 'Follow up en curso', color: 'var(--good-ink)', abierta: true },
  cumplida:       { label: 'Cumplida',           color: 'var(--good-ink)' },
  reprogramada:   { label: 'Reprogramada',       color: 'var(--text-secondary)' },
  dice_pago:      { label: 'Dice que pagó',      color: 'var(--text-secondary)' },
  incumplida:     { label: 'Sin nueva fecha',    color: 'var(--serious)' },
  escalada:       { label: 'Pasar a una persona', color: 'var(--critical)' },
  vieja:          { label: 'Vencida sin llamar', color: 'var(--text-muted)' },
  cancelada:      { label: 'Cancelada a mano',   color: 'var(--text-muted)' },
  sin_llamada:    { label: 'No se pudo llamar',  color: 'var(--text-muted)' },
};
const estadoDe = (e) => ESTADOS[e] || { label: e || '—', color: 'var(--text-muted)' };

const dia = (ymd) => {
  if (!ymd) return '—';
  const d = new Date(String(ymd).slice(0, 10) + 'T12:00:00Z');
  return d.toLocaleDateString('es-DO', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
};
const momento = (iso) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('es-DO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
};

/** Qué sigue con una promesa abierta, en palabras. */
function siguiente(p) {
  if (p.estado === 'pendiente') return `Follow up el ${dia(p.fechaPrometida)} si sigue debiendo`;
  if (p.estado === 'en_seguimiento') {
    if (p.proximoIntento) return `No contestó · reintento ${p.reintentos} de 2: ${momento(p.proximoIntento)}`;
    return `Llamada de follow up en cola o en curso (desde ${momento(p.seguimientoAt)})`;
  }
  return p.motivoCierre || '';
}

/** Pestaña Promesas: cada promesa de pago, su estado y qué sigue. */
export default function PromesasView() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [verTodas, setVerTodas] = useState(false);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(null);
  const [revisando, setRevisando] = useState(false);

  const load = () => fetchPromesasLista()
    .then((d) => { setData(d); setErr(null); setAt(new Date()); })
    .catch((e) => setErr(e.message));

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    return () => clearInterval(id);
  }, []);

  // Corre el motor ya (lee las llamadas recién terminadas) y recarga la lista.
  const ahora = async () => {
    setRevisando(true);
    try { await revisarPromesasAhora(); } catch (e) { setErr(e.message); }
    await load();
    setRevisando(false);
  };

  const lista = data ? data.promesas : [];
  const cuenta = useMemo(() => {
    const c = {};
    for (const p of lista) c[p.estado] = (c[p.estado] || 0) + 1;
    return c;
  }, [lista]);

  const filtradas = useMemo(() => {
    const t = q.trim().toLowerCase();
    return lista.filter((p) => {
      if (!verTodas && !estadoDe(p.estado).abierta) return false;
      if (!t) return true;
      return (p.nombre || '').toLowerCase().includes(t) || String(p.phone || '').includes(t.replace(/\D/g, '') || '§');
    });
  }, [lista, verTodas, q]);

  if (err) return <div className="card"><div className="sched-err">No se pudieron cargar las promesas: {err}</div></div>;
  if (!data) return <div className="card" style={{ color: 'var(--text-muted)' }}>Cargando promesas…</div>;

  const abiertas = (cuenta.pendiente || 0) + (cuenta.en_seguimiento || 0);
  const chips = [
    ['Abiertas', abiertas],
    ['Cumplidas', cuenta.cumplida || 0],
    ['Reprogramadas', cuenta.reprogramada || 0],
    ['Dice que pagó', cuenta.dice_pago || 0],
    ['Pasar a una persona', cuenta.escalada || 0],
    ['Sin nueva fecha', cuenta.incumplida || 0],
  ];

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="promesas-head">
        {chips.map(([k, v]) => (
          <div key={k} className="promesas-chip"><strong>{v}</strong><span>{k}</span></div>
        ))}
      </div>
      <div className="toolbar">
        <input className="search" placeholder="Buscar por cliente o teléfono…" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="sched-check" style={{ margin: 0 }}>
          <input type="checkbox" checked={verTodas} onChange={(e) => setVerTodas(e.target.checked)} />
          Ver también las cerradas
        </label>
        <button className="btn" onClick={ahora} disabled={revisando} title="Lee las llamadas recién terminadas y actualiza las promesas ahora">
          {revisando ? 'Actualizando…' : '↻ Actualizar ahora'}
        </button>
        <span className="sched-tz">
          Tope: {data.tope} promesas incumplidas seguidas · actualizado {at ? at.toLocaleTimeString('es-DO', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—'} (cada 15 s)
        </span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Cliente</th>
              <th>Estado</th>
              <th>Fecha prometida</th>
              <th>Prometió el</th>
              <th>Promesa</th>
              <th className="num">Vencido hoy</th>
              <th>Qué sigue</th>
            </tr>
          </thead>
          <tbody>
            {filtradas.map((p) => {
              const e = estadoDe(p.estado);
              return (
                <tr key={p.id}>
                  <td>
                    <div style={{ fontWeight: 600 }}>
                      {p.nombre || p.phone}
                      {p.prueba && <span className="tag-prueba" title="Número de prueba: solo lo ven los super admins">Prueba</span>}
                    </div>
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.76rem' }}>{p.phone}{p.empresa ? ` · ${p.empresa}` : ''}</div>
                  </td>
                  <td>
                    <span className="pill" style={{ color: e.color }}>
                      <span className="pdot" style={{ background: e.color }} />{e.label}
                    </span>
                  </td>
                  <td title={p.textoOriginal ? `Dijo: "${p.textoOriginal}"` : ''}>
                    {dia(p.fechaPrometida)}
                    {p.textoOriginal && <div style={{ color: 'var(--text-muted)', fontSize: '0.76rem' }}>"{p.textoOriginal}"</div>}
                  </td>
                  <td style={{ color: 'var(--text-secondary)' }}>
                    {momento(p.prometidaEl)}
                    <div style={{ color: 'var(--text-muted)', fontSize: '0.76rem' }}>
                      {p.agente === 'seguimiento' ? '↩ al follow up' : '📞 a cobranzas'}{p.origen === 'ia' ? ' · leída por IA' : ''}
                    </div>
                  </td>
                  <td>{p.intento}.ª{p.intento >= data.tope ? ' (última)' : ''}</td>
                  <td className="num">{p.vencidoHoy == null ? '—' : money(p.vencidoHoy)}</td>
                  <td style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }}>{siguiente(p)}</td>
                </tr>
              );
            })}
            {!filtradas.length && (
              <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 30 }}>
                {verTodas ? 'Sin promesas.' : 'No hay promesas abiertas. Marca "Ver también las cerradas" para ver el historial.'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
