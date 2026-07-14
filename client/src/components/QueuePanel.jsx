import { useEffect, useState } from 'react';
import { fetchQueue, cancelQueue } from '../api';
import { num } from '../format';

/** Estado de la cola de llamadas. Se refresca solo cada 30s. */
export default function QueuePanel({ refreshKey }) {
  const [q, setQ] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => fetchQueue().then(setQ).catch(() => {});

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [refreshKey]);

  if (!q) return null;

  const cancelar = async () => {
    if (!window.confirm(`¿Cancelar las ${q.pendientes} llamadas pendientes?`)) return;
    setBusy(true);
    try { await cancelQueue(); await load(); }
    finally { setBusy(false); }
  };

  const horas = Math.floor(q.minutosEstimados / 60);
  const mins = q.minutosEstimados % 60;
  const eta = horas ? `${horas}h ${mins}min` : `${mins} min`;

  return (
    <div className={`queue-panel ${q.pendientes ? 'active' : ''}`}>
      <span className={`queue-dot ${q.pendientes && q.enHorario ? 'live' : ''}`} />
      <span className="queue-main">
        {q.pendientes > 0 ? (
          <>
            <strong>{num(q.pendientes)}</strong> en cola
            {q.enHorario
              ? <> · llamando 1/min · faltan ~<strong>{eta}</strong></>
              : <> · <span className="queue-paused">pausada fuera de horario</span></>}
            {q.proximo && <> · siguiente: {q.proximo.nombre || q.proximo.phone}</>}
          </>
        ) : (
          <>Cola vacía · {num(q.enviadas24h)} llamadas en 24h{q.errores24h ? ` · ${q.errores24h} con error` : ''}</>
        )}
      </span>
      <span className="queue-hours">🕘 {q.horario}</span>
      {q.pendientes > 0 && (
        <button className="mini-btn danger" disabled={busy} onClick={cancelar}>
          {busy ? '…' : 'Cancelar cola'}
        </button>
      )}
    </div>
  );
}
