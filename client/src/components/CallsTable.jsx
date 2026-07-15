import { Fragment, useMemo, useState } from 'react';
import { intencionColor, intencionLabel, INTENCION } from '../constants';
import { usePaged } from '../usePaged';
import { EMPTY_RANGE, makeInRange } from '../dateRange';
import Pager from './Pager';
import DateRange from './DateRange';

const fmtDate = (iso) => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
};

// Divide la transcripción en turnos AI / User para mostrarla como chat.
function Transcript({ text }) {
  if (!text) return <div style={{ color: 'var(--text-muted)' }}>Sin transcripción.</div>;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return (
    <div className="transcript">
      {lines.map((line, i) => {
        const m = line.match(/^(AI|Assistant|Agente|User|Usuario|Cliente)\s*:\s*(.*)$/i);
        const who = m ? m[1].toLowerCase() : null;
        const isAgent = who && /ai|assistant|agente/.test(who);
        const isUser = who && /user|usuario|cliente/.test(who);
        const body = m ? m[2] : line;
        return (
          <div key={i} className={`tr-line ${isAgent ? 'agent' : isUser ? 'user' : 'plain'}`}>
            {(isAgent || isUser) && <span className="tr-who">{isAgent ? 'Agente' : 'Cliente'}</span>}
            <span className="tr-body">{body}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function CallsTable({ llamadas }) {
  const [q, setQ] = useState('');
  const [intencion, setIntencion] = useState('');
  const [range, setRange] = useState(EMPTY_RANGE);
  const [openId, setOpenId] = useState(null);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    const inRange = makeInRange(range);
    return llamadas.filter((ll) => {
      if (!inRange(ll.created_at)) return false;
      if (intencion && ll.intencion_pago !== intencion) return false;
      if (!t) return true;
      return (
        (ll.name || '').toLowerCase().includes(t) ||
        (ll.notas || '').toLowerCase().includes(t) ||
        String(ll.phone || '').includes(t.replace(/\D/g, ''))
      );
    });
  }, [llamadas, q, intencion, range]);

  const { slice, pager } = usePaged(filtered, 25);

  if (llamadas.length === 0) {
    return (
      <div className="empty-state">
        <div style={{ fontSize: '1.6rem', marginBottom: 8 }}>📞</div>
        Aún no hay resultados de llamadas.<br />
        <span style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>
          Conecta el webhook de llamadas (<code>N8N_WEBHOOK_LLAMADAS</code>) para poblar esta sección.
        </span>
      </div>
    );
  }

  const rowKey = (ll) => ll.id ?? ll.phone + ll.created_at;

  return (
    <div>
      <div className="toolbar">
        <input className="search" placeholder="Buscar por cliente, teléfono o notas…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="search select" value={intencion} onChange={(e) => setIntencion(e.target.value)}>
          <option value="">Todas las intenciones</option>
          {Object.entries(INTENCION).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
        <DateRange value={range} onChange={setRange} />
      </div>
      <Pager p={pager} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th></th>
              <th>Fecha</th>
              <th>Cliente</th>
              <th>Intención</th>
              <th>Fecha de pago</th>
              <th>Notas</th>
              <th>Grabación</th>
            </tr>
          </thead>
          <tbody>
            {slice.map((ll) => {
              const k = rowKey(ll);
              const open = openId === k;
              return (
                <Fragment key={k}>
                  <tr className={`call-row ${open ? 'open' : ''}`} onClick={() => setOpenId(open ? null : k)} style={{ cursor: 'pointer' }}>
                    <td style={{ color: 'var(--text-muted)', width: 24 }}>{open ? '▾' : '▸'}</td>
                    <td style={{ color: 'var(--text-secondary)' }}>{fmtDate(ll.created_at)}</td>
                    <td style={{ fontWeight: 600 }}>{ll.name || ll.phone}</td>
                    <td>
                      <span className="pill" style={{ color: intencionColor(ll.intencion_pago) }}>
                        <span className="pdot" style={{ background: intencionColor(ll.intencion_pago) }} />
                        {intencionLabel(ll.intencion_pago)}
                      </span>
                    </td>
                    <td style={{ color: ll.fecha_pago ? 'var(--text-primary)' : 'var(--text-muted)' }}>{ll.fecha_pago || '—'}</td>
                    <td className="trunc" title={ll.notas}>{ll.notas}</td>
                    <td>{ll.grabacion ? <span className="a-link">{open ? '▾ Cerrar' : '▶ Escuchar'}</span> : '—'}</td>
                  </tr>
                  {open && (
                    <tr className="call-detail-row">
                      <td colSpan={7}>
                        <div className="call-detail">
                          {ll.grabacion ? (
                            <div className="call-audio">
                              <audio controls preload="metadata" src={`/api/recordings/proxy?url=${encodeURIComponent(ll.grabacion)}`} style={{ width: '100%' }}>
                                Tu navegador no soporta audio. <a href={ll.grabacion} target="_blank" rel="noreferrer">Descargar</a>
                              </audio>
                              <a className="a-link" href={ll.grabacion} target="_blank" rel="noreferrer" style={{ fontSize: '0.76rem' }}>Abrir en pestaña ↗</a>
                            </div>
                          ) : (
                            <div style={{ color: 'var(--text-muted)' }}>Sin grabación disponible.</div>
                          )}
                          {ll.notas && (
                            <div className="call-notes"><span className="cd-label">Resumen</span>{ll.notas}</div>
                          )}
                          <div className="cd-label">Transcripción</div>
                          <Transcript text={ll.transcripcion} />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {slice.length === 0 && (
              <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 30 }}>Sin resultados.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
