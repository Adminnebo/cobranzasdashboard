import { useEffect, useState } from 'react';
import { fetchQueue, cancelQueue } from '../api';
import { num } from '../format';
import ColaLista from './ColaLista';

/** Estado de la cola de llamadas. Se refresca solo cada 30s. */
export default function QueuePanel({ refreshKey }) {
  const [q, setQ] = useState(null);
  const [busy, setBusy] = useState(false);
  const [verLista, setVerLista] = useState(false);

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
      <span className={`queue-dot ${q.pendientes && (q.enHorario || q.algunaAbierta) ? 'live' : ''}`} />
      <span className="queue-main">
        {q.pendientes > 0 ? (
          <>
            <strong>{num(q.pendientes)}</strong> en cola
            {q.enHorario
              ? (q.modo === 'concurrencia'
                  ? <> · <strong>{q.activas ?? '?'}/{q.maxConcurrent}</strong> activas</>
                  : <> · 1/min · faltan ~<strong>{eta}</strong></>)
              : q.algunaAbierta
                ? <> · <span className="queue-paused">fuera del horario general: solo clientes con horario propio</span></>
                : <> · <span className="queue-paused">pausada fuera de horario</span></>}
            {q.esperandoHorario > 0 && <> · <strong>🕘 {num(q.esperandoHorario)}</strong> esperando su horario</>}
            {q.followUpsEnCola > 0 && <> · <strong>↩ {num(q.followUpsEnCola)}</strong> de follow up</>}
            {q.proximo && <> · siguiente: {q.proximo.nombre || q.proximo.phone}{q.proximo.agente === 'seguimiento' ? ' (follow up)' : ''}{q.proximo.horarioPropio ? ' (en su horario)' : ''}</>}
          </>
        ) : (
          <>
            Cola vacía · {num(q.enviadas24h)} llamadas en 24h{q.errores24h ? ` · ${q.errores24h} con error` : ''}
            {q.modo === 'concurrencia' && q.activas != null && <> · <strong>{q.activas}/{q.maxConcurrent}</strong> activas</>}
          </>
        )}
      </span>
      <span className="queue-hours">🕘 {q.horario}{q.clientesConHorario ? ` · ${q.clientesConHorario} con horario propio` : ''}</span>
      {q.pendientes > 0 && (
        <button className="mini-btn" onClick={() => setVerLista(true)} title="Ver quién está en la cola y en qué orden se va a llamar">
          📋 Ver cola
        </button>
      )}
      {verLista && <ColaLista onClose={() => setVerLista(false)} onChange={load} />}
      {q.pendientes > 0 && (
        <button className="mini-btn danger" disabled={busy} onClick={cancelar}>
          {busy ? '…' : 'Cancelar cola'}
        </button>
      )}
    </div>
  );
}
