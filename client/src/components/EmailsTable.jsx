import { Fragment, useMemo, useState } from 'react';
import { usePaged } from '../usePaged';
import { EMPTY_RANGE, makeInRange } from '../dateRange';
import { fmtFechaCorreo } from '../correos';
import Pager from './Pager';
import DateRange from './DateRange';
import HiloCorreo from './HiloCorreo';

/** Estado de la respuesta de un correo: respondió / sin respuesta / no se sabe (sin lectura). */
export function RespuestaPill({ correo }) {
  if (correo.respuestas === null) return <span className="pill pill--correo-nose" title="El panel todavía no puede leer el buzón">—</span>;
  if (correo.respuestas.length) {
    const n = correo.respuestas.length;
    return (
      <span className="pill pill--correo-si" title={`Última respuesta: ${fmtFechaCorreo(correo.ultimaRespuesta.fecha)}`}>
        <span className="pdot" />↩ Respondió{n > 1 ? ` (${n})` : ''} · {fmtFechaCorreo(correo.ultimaRespuesta.fecha)}
      </span>
    );
  }
  return <span className="pill pill--correo-no"><span className="pdot" />Sin respuesta</span>;
}

/**
 * Pestaña Emails: todos los correos de cobranza enviados (por n8n vía correo-servicio), con su
 * cliente y si contestó. Cada fila se despliega con el hilo completo, como una llamada.
 */
export default function EmailsTable({ estado, onRecargar }) {
  const { correos = [], cargando, error, motivo, sincronizando, cuenta } = estado;
  const [q, setQ] = useState('');
  const [resp, setResp] = useState('');
  const [range, setRange] = useState(EMPTY_RANGE);
  const [openId, setOpenId] = useState(null);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    const digitos = t.replace(/\D/g, '');
    const inRange = makeInRange(range);
    return correos.filter((c) => {
      if (!inRange(c.fecha)) return false;
      if (resp === 'si' && !(c.respuestas && c.respuestas.length)) return false;
      if (resp === 'no' && !(c.respuestas && !c.respuestas.length)) return false;
      if (!t) return true;
      return (
        (c.nombre || '').toLowerCase().includes(t)
        || (c.asunto || '').toLowerCase().includes(t)
        || (c.para || []).some((e) => e.includes(t))
        || (c.cliente && c.cliente.codigo && String(c.cliente.codigo).toLowerCase().includes(t))
        || (digitos.length >= 4 && String(c.phone || '').includes(digitos))
      );
    });
  }, [correos, q, resp, range]);

  const { slice, pager } = usePaged(filtered, 25);
  const conRespuesta = filtered.filter((c) => c.respuestas && c.respuestas.length).length;
  const sabe = filtered.some((c) => c.respuestas !== null);

  if (cargando && !correos.length) return <div className="empty-state">Cargando los correos…</div>;
  if (error && !correos.length) {
    return <div className="empty-state"><div style={{ fontSize: '1.6rem', marginBottom: 8 }}>📧</div>{error}</div>;
  }
  if (!correos.length) {
    return (
      <div className="empty-state">
        <div style={{ fontSize: '1.6rem', marginBottom: 8 }}>📧</div>
        Todavía no hay correos enviados{cuenta ? <> desde <b>{cuenta}</b></> : null}.
        {sincronizando && <><br /><span style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }}>Leyendo el buzón…</span></>}
      </div>
    );
  }

  return (
    <div>
      {(motivo || sincronizando) && (
        <div className={`correo-aviso ${motivo ? 'correo-aviso--mal' : ''}`}>
          {motivo || 'Leyendo el buzón: las respuestas van apareciendo…'}
          {motivo && <button className="mini-btn" onClick={() => onRecargar(true)}>Reintentar</button>}
        </div>
      )}
      <div className="toolbar">
        <input className="search" placeholder="Buscar por cliente, correo, código o asunto…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="search select" value={resp} onChange={(e) => setResp(e.target.value)}>
          <option value="">Con y sin respuesta</option>
          <option value="si">↩ Respondieron</option>
          <option value="no">Sin respuesta</option>
        </select>
        <DateRange value={range} onChange={setRange} />
        <button className="mini-btn" disabled={sincronizando} onClick={() => onRecargar(true)} title="Volver a mirar el buzón ahora">↻ Actualizar</button>
      </div>
      <div className="correo-resumen">
        📧 <b>{filtered.length}</b> correo{filtered.length === 1 ? '' : 's'}
        {sabe && <> · ↩ <b>{conRespuesta}</b> con respuesta ({filtered.length ? Math.round((conRespuesta / filtered.length) * 100) : 0}%)</>}
        {cuenta && <span className="correo-resumen__cuenta"> · enviados desde {cuenta}</span>}
      </div>
      <Pager p={pager} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th></th>
              <th>Fecha</th>
              <th>Cliente</th>
              <th>Para</th>
              <th>Asunto</th>
              <th>Respuesta</th>
            </tr>
          </thead>
          <tbody>
            {slice.map((c) => {
              const k = c.id || `${c.fecha}-${(c.para || []).join(',')}`;
              const open = openId === k;
              return (
                <Fragment key={k}>
                  <tr className={`call-row ${open ? 'open' : ''}`} onClick={() => setOpenId(open ? null : k)} style={{ cursor: 'pointer' }}>
                    <td style={{ color: 'var(--text-muted)', width: 24 }}>{open ? '▾' : '▸'}</td>
                    <td style={{ color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{fmtFechaCorreo(c.fecha)}</td>
                    <td style={{ fontWeight: 600 }}>
                      {c.nombre || <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>Sin cliente en cartera</span>}
                      {c.cliente && c.cliente.codigo && <span className="correo-cod">Cód. {c.cliente.codigo}</span>}
                    </td>
                    <td className="correo-para">{(c.para || []).join(', ') || '—'}</td>
                    <td className="correo-asunto">{c.asunto || '—'}</td>
                    <td><RespuestaPill correo={c} /></td>
                  </tr>
                  {open && (
                    <tr className="call-detail-row">
                      <td colSpan={6}><HiloCorreo correo={c} /></td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {slice.length === 0 && (
              <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 24 }}>Ningún correo con esos filtros.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pager p={pager} />
    </div>
  );
}
