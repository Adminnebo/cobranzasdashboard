import { useState } from 'react';
import { intencionColor, intencionLabel } from '../constants';
import CallDetail from './CallDetail';

const fmt = (iso) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
};

/** Lista de llamadas de un cliente; cada una desplegable (grabación + transcripción). */
export default function ClientCalls({ calls }) {
  const [open, setOpen] = useState(null);
  if (!calls || !calls.length) {
    return <div style={{ padding: 14, color: 'var(--text-muted)' }}>Este cliente no tiene llamadas registradas.</div>;
  }
  return (
    <div className="client-calls">
      <div className="cc-title">{calls.length} llamada{calls.length === 1 ? '' : 's'}</div>
      {calls.map((ll, i) => {
        const id = ll.id ?? (ll.phone + '-' + ll.created_at + '-' + i);
        const abierta = open === id;
        return (
          <div className={`cc-item ${abierta ? 'open' : ''}`} key={id}>
            <button className="cc-head" onClick={() => setOpen(abierta ? null : id)}>
              <span className="cc-caret">{abierta ? '▾' : '▸'}</span>
              <span className="cc-fecha">{fmt(ll.created_at)}</span>
              <span className="pill" style={{ color: intencionColor(ll.intencion_pago) }}>
                <span className="pdot" style={{ background: intencionColor(ll.intencion_pago) }} />
                {intencionLabel(ll.intencion_pago)}
              </span>
              {ll.fecha_pago && <span className="cc-fp">promete: <strong>{ll.fecha_pago}</strong></span>}
              <span className="cc-notas">{ll.notas}</span>
              {ll.grabacion && <span className="cc-audio-ic" title="Tiene grabación">🎧</span>}
            </button>
            {abierta && (
              <CallDetail call={{ grabacion: ll.grabacion, notas: ll.notas, transcripcion: ll.transcripcion }} />
            )}
          </div>
        );
      })}
    </div>
  );
}
