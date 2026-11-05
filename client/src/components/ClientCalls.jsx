import { useEffect, useState } from 'react';
import { intencionColor, intencionLabel } from '../constants';
import CallDetail from './CallDetail';
import AgenteTag from './AgenteTag';

const fmt = (iso) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
};

const idDe = (ll, i) => ll.id ?? (ll.phone + '-' + ll.created_at + '-' + i);

/** La llamada a desplegar sola: por id, por hora exacta, o la más reciente. */
function buscar(calls, abrir) {
  if (!abrir || !calls || !calls.length) return null;
  let i = abrir.id != null ? calls.findIndex((ll) => ll.id != null && String(ll.id) === String(abrir.id)) : -1;
  if (i < 0 && abrir.at) i = calls.findIndex((ll) => ll.created_at && Date.parse(ll.created_at) === Date.parse(abrir.at));
  if (i < 0) i = 0;
  return idDe(calls[i], i);
}

/**
 * Lista de llamadas de un cliente; cada una desplegable (grabación + transcripción).
 * `abrir` ({ id, at }) despliega esa llamada sola (al venir desde Promesas).
 */
export default function ClientCalls({ calls, abrir = null }) {
  const [open, setOpen] = useState(() => buscar(calls, abrir));
  useEffect(() => { if (abrir) setOpen(buscar(calls, abrir)); }, [abrir]); // eslint-disable-line react-hooks/exhaustive-deps
  const foco = abrir ? buscar(calls, abrir) : null;
  if (!calls || !calls.length) {
    return <div style={{ padding: 14, color: 'var(--text-muted)' }}>Este cliente no tiene llamadas registradas.</div>;
  }
  return (
    <div className="client-calls">
      <div className="cc-title">
        {calls.length} llamada{calls.length === 1 ? '' : 's'} · 📞 {calls.filter((l) => l.agente !== 'seguimiento').length} de cobranzas · ↩ {calls.filter((l) => l.agente === 'seguimiento').length} de follow up
      </div>
      {calls.map((ll, i) => {
        const id = idDe(ll, i);
        const abierta = open === id;
        return (
          <div className={`cc-item ${abierta ? 'open' : ''} ${foco === id ? 'cc-item--foco' : ''}`} key={id} id={foco === id ? 'cc-foco' : undefined}>
            <button className="cc-head" onClick={() => setOpen(abierta ? null : id)}>
              <span className="cc-caret">{abierta ? '▾' : '▸'}</span>
              <span className="cc-fecha">{fmt(ll.created_at)}</span>
              <AgenteTag ll={ll} />
              {ll.prueba && <span className="tag-prueba">Prueba</span>}
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
