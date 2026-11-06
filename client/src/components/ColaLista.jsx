import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchQueueLista, quitarDeCola } from '../api';
import { money, num, phoneFmt } from '../format';
import { horarioTexto } from './HorarioCliente';

const ESTADO = {
  lista:             { label: 'Lista para salir', color: 'var(--good-ink)' },
  esperando_horario: { label: 'Esperando su horario', color: 'var(--warning)' },
  esperando_cita:    { label: 'Esperando la hora que pidió', color: 'var(--series-1)' },
  fuera_de_horario:  { label: 'Fuera de horario', color: 'var(--text-muted)' },
};
const ORIGEN = { cron: 'automática del día', bulk: 'masiva', manual: 'a mano', seguimiento: 'motor de follow up', cita: 'hora que pidió' };

const momento = (iso) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('es-DO', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
};
const dia = (ymd) => new Date(String(ymd).slice(0, 10) + 'T12:00:00Z')
  .toLocaleDateString('es-DO', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** La cola completa, en el orden en que el bot va a llamar. Se refresca cada 15 s. */
export default function ColaLista({ onClose, onChange }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [q, setQ] = useState('');
  const [quitando, setQuitando] = useState(null);

  const load = () => fetchQueueLista().then((d) => { setData(d); setErr(null); }).catch((e) => setErr(e.message));

  useEffect(() => {
    load();
    const id = setInterval(load, 15000);
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => { clearInterval(id); window.removeEventListener('keydown', esc); };
  }, []);

  const quitar = async (it) => {
    const quien = it.nombre || phoneFmt(it.phone);
    const aviso = it.agente === 'seguimiento'
      ? `¿Quitar el follow up de ${quien}?\n\nTambién se cierra su promesa (queda "Cancelada a mano") y el cliente vuelve a como estaba antes del follow up.`
      : `¿Quitar a ${quien} de la cola?`;
    if (!window.confirm(aviso)) return;
    setQuitando(it.id);
    try { await quitarDeCola(it.id); await load(); onChange && onChange(); }
    catch (e) { setErr(e.message); }
    finally { setQuitando(null); }
  };

  const t = q.trim().toLowerCase();
  const items = (data ? data.items : []).filter((it) => !t
    || (it.nombre || '').toLowerCase().includes(t)
    || (it.empresa || '').toLowerCase().includes(t)
    || String(it.phone || '').includes(t.replace(/\D/g, '') || '§'));
  const listas = data ? data.items.filter((it) => it.estado === 'lista').length : 0;

  return createPortal(
    <div className="pagos-modal" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pagos-modal__box cola-modal" role="dialog" aria-label="Cola de llamadas">
        <div className="pagos-modal__bar">
          <span>Cola de llamadas{data ? ` · ${num(data.total)}` : ''}</span>
          <button className="mini-btn" onClick={onClose}>Cerrar</button>
        </div>
        <div className="toolbar">
          <input className="search" placeholder="Buscar por cliente o teléfono…" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="sched-tz">
            {data && <>{num(listas)} pueden salir ahora · horario {data.horario}{data.enabled ? '' : ' · llamadas apagadas'} · se actualiza cada 15 s</>}
          </span>
        </div>
        {err && <div className="sched-err" style={{ padding: '0 14px 10px' }}>{err}</div>}
        <div className="table-wrap cola-wrap">
          <table>
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Cliente</th>
                <th>Llamada</th>
                <th>Estado</th>
                <th className="num">Vencido</th>
                <th>Entró a la cola</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!data && !err && (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 30 }}>Cargando…</td></tr>
              )}
              {items.map((it) => {
                const e = ESTADO[it.estado] || ESTADO.fuera_de_horario;
                return (
                  <tr key={it.id}>
                    <td className="num" style={{ color: 'var(--text-muted)' }}>{it.pos}</td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{it.nombre || phoneFmt(it.phone)}</div>
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.76rem' }}>{phoneFmt(it.phone)}{it.empresa ? ` · ${it.empresa}` : ''}</div>
                    </td>
                    <td>
                      {it.agente === 'seguimiento' ? '↩ Follow up' : '📞 Cobranzas'}
                      {it.fecha_prometida && <div style={{ color: 'var(--text-muted)', fontSize: '0.76rem' }}>prometió el {dia(it.fecha_prometida)}</div>}
                    </td>
                    <td>
                      <span className="pill" style={{ color: e.color }}>
                        <span className="pdot" style={{ background: e.color }} />{e.label}
                      </span>
                      {it.cita && <div style={{ color: 'var(--series-1)', fontSize: '0.76rem', marginTop: 3 }}>📞 pidió {dia(it.cita.dia)} · {it.cita.desde}–{it.cita.hasta}</div>}
                      {!it.cita && it.horario && <div style={{ color: 'var(--text-muted)', fontSize: '0.76rem', marginTop: 3 }}>🕘 {horarioTexto(it.horario)}</div>}
                      {it.estado === 'lista' && it.disponible != null && it.disponible <= 60 && (
                        <div style={{ color: 'var(--warning)', fontSize: '0.76rem', marginTop: 2 }} title="Por eso va antes que las que tienen más tiempo">⏱ le quedan {it.disponible} min hoy</div>
                      )}
                      {it.movida > 0 && it.detalle && <div style={{ color: 'var(--critical)', fontSize: '0.76rem', marginTop: 2, whiteSpace: 'normal', maxWidth: 260 }}>↪ {it.detalle}</div>}
                    </td>
                    <td className="num">{money(it.deuda_vencida)}</td>
                    <td style={{ color: 'var(--text-secondary)', fontSize: '0.82rem' }}>
                      {momento(it.created_at)}
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.76rem' }}>
                        {ORIGEN[it.origen] || it.origen || ''}{it.encolada_por ? ` · ${it.encolada_por}` : ''}
                      </div>
                    </td>
                    <td>
                      <button className="mini-btn danger" disabled={quitando === it.id} onClick={() => quitar(it)}
                        title={it.agente === 'seguimiento' ? 'Quitar de la cola y cerrar su promesa' : 'Quitar de la cola'}>
                        {quitando === it.id ? '…' : 'Quitar'}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {data && !items.length && (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 30 }}>
                  {data.total ? 'Nadie coincide con la búsqueda.' : 'La cola está vacía.'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        {data && data.total > data.items.length && (
          <div className="sched-tz" style={{ padding: '8px 14px' }}>Se muestran las primeras {num(data.items.length)} de {num(data.total)}.</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
