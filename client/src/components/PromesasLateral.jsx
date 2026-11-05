import { useMemo, useState } from 'react';
import { money } from '../format';
import { dia, siguiente, ymdRD } from './PromesasView';

const DIAS_ATENCION = 7; // escaladas / sin nueva fecha de los últimos N días

/**
 * Agrupa las promesas para el panel lateral de Clientes:
 *   hoy      → follow up en curso o con fecha de hoy (o atrasada)
 *   proximas → esperando una fecha futura, de la más cercana a la más lejana
 *   atencion → escaladas o sin nueva fecha en los últimos días
 */
export function agruparPromesas(promesas) {
  const hoy = ymdRD(new Date());
  const corte = Date.now() - DIAS_ATENCION * 86400000;
  const out = { hoy: [], proximas: [], atencion: [] };
  for (const p of promesas || []) {
    // Fecha en que sale el follow up (la prometida + el margen); "pago hoy" sale el mismo día.
    const fecha = String(p.followUpFecha || p.fechaPrometida || '').slice(0, 10);
    const pagoHoy = p.prometidaEl && ymdRD(new Date(p.prometidaEl)) === String(p.fechaPrometida).slice(0, 10);
    if (p.estado === 'en_seguimiento' || (p.estado === 'pendiente' && (pagoHoy ? String(p.fechaPrometida).slice(0, 10) : fecha) <= hoy)) out.hoy.push(p);
    else if (p.estado === 'pendiente') out.proximas.push(p);
    else if ((p.estado === 'escalada' || p.estado === 'incumplida') && Date.parse(p.cerradaAt || 0) >= corte) out.atencion.push(p);
  }
  out.proximas.sort((a, b) => String(a.followUpFecha || a.fechaPrometida).localeCompare(String(b.followUpFecha || b.fechaPrometida)));
  out.atencion.sort((a, b) => String(b.cerradaAt).localeCompare(String(a.cerradaAt)));
  return out;
}

function Item({ p, cls, linea, onPick }) {
  return (
    <button className={`prom-item ${cls || ''}`} onClick={() => onPick(p.phone)} title="Ir a este cliente en la lista">
      <span className="prom-item__l1">
        <span className="prom-item__name">
          {p.nombre || p.phone}
          {p.prueba && <span className="tag-prueba">Prueba</span>}
          {p.ficha && p.ficha.modalidad === 'retiro' && <span className="prom-item__tag" title="Pidió que pasen a retirar el pago">🚚</span>}
        </span>
        {p.vencidoHoy != null && <span className="prom-item__num">{money(p.vencidoHoy)}</span>}
      </span>
      <span className={`prom-item__l2 ${p.estado === 'en_seguimiento' ? 'live' : ''}`}>{linea}</span>
    </button>
  );
}

/** Texto corto del retiro: "vie 6 nov · tarde 14:00–18:00". */
export function retiroTexto(p) {
  const r = (p.ficha && p.ficha.retiro) || {};
  const fecha = r.fecha || String(p.fechaPrometida || '').slice(0, 10);
  const franja = r.desde ? `${r.franja === 'manana' ? 'mañana ' : r.franja === 'tarde' ? 'tarde ' : ''}${r.desde}–${r.hasta}` : 'hora sin definir';
  return `${fecha ? dia(fecha) : 'sin fecha'} · ${franja}`;
}

/**
 * Retiros: promesas abiertas en las que el cliente pidió que pasen a buscar el
 * pago. Agrupadas por el día del retiro.
 */
export function agruparRetiros(promesas) {
  const hoy = ymdRD(new Date());
  const manana = ymdRD(new Date(Date.now() + 86400000));
  const out = { hoy: [], manana: [], proximos: [] };
  for (const p of promesas || []) {
    if (!(p.estado === 'pendiente' || p.estado === 'en_seguimiento')) continue;
    if (!p.ficha || p.ficha.modalidad !== 'retiro') continue;
    const f = (p.ficha.retiro && p.ficha.retiro.fecha) || String(p.fechaPrometida || '').slice(0, 10);
    p._retiroFecha = f;
    if (f <= hoy) out.hoy.push(p); else if (f === manana) out.manana.push(p); else out.proximos.push(p);
  }
  const orden = (a, b) => String(a._retiroFecha).localeCompare(String(b._retiroFecha))
    || String((a.ficha.retiro || {}).desde || '99').localeCompare(String((b.ficha.retiro || {}).desde || '99'));
  out.hoy.sort(orden); out.manana.sort(orden); out.proximos.sort(orden);
  return out;
}

/** Panel lateral de Clientes: promesas y retiros. Click en uno → ese cliente en la lista. */
export default function PromesasLateral({ data, error, onPick, onVerTodas }) {
  const [vista, setVista] = useState('promesas');
  const g = useMemo(() => agruparPromesas(data && data.promesas), [data]);
  const ret = useMemo(() => agruparRetiros(data && data.promesas), [data]);
  const nRetiros = ret.hoy.length + ret.manana.length + ret.proximos.length;
  const pagoHoyHora = data && data.pagoHoyHora;
  const linRetiro = (p) => `${retiroTexto(p)}${p.ficha.retiro && p.ficha.retiro.texto ? ` · "${p.ficha.retiro.texto}"` : ''}`;

  if (vista === 'retiros') {
    return (
      <aside className="card prom-side">
        <div className="prom-side__head">
          <div className="prom-side__tabs">
            <button onClick={() => setVista('promesas')}>⏳ Promesas</button>
            <button className="on">🚚 Retiros{nRetiros ? ` · ${nRetiros}` : ''}</button>
          </div>
          <div className="prom-side__chips">
            <div><b>{ret.hoy.length}</b><span>hoy</span></div>
            <div><b>{ret.manana.length}</b><span>mañana</span></div>
            <div><b>{ret.proximos.length}</b><span>próximos</span></div>
          </div>
        </div>
        <div className="prom-side__body">
          {error && <div className="sched-err" style={{ padding: 14 }}>No se pudieron cargar: {error}</div>}
          {data && !nRetiros && (
            <div className="prom-side__empty">Nadie pidió que pasen a retirar el pago. Aparecen aquí cuando el cliente lo dice en una llamada.</div>
          )}
          {ret.hoy.length > 0 && <div className="prom-side__sec">Hoy</div>}
          {ret.hoy.map((p) => <Item key={p.id} p={p} cls="hoy" onPick={onPick} linea={linRetiro(p)} />)}
          {ret.manana.length > 0 && <div className="prom-side__sec">Mañana</div>}
          {ret.manana.map((p) => <Item key={p.id} p={p} onPick={onPick} linea={linRetiro(p)} />)}
          {ret.proximos.length > 0 && <div className="prom-side__sec">Próximos</div>}
          {ret.proximos.map((p) => <Item key={p.id} p={p} onPick={onPick} linea={linRetiro(p)} />)}
        </div>
        <div className="prom-side__foot"><span className="cl-meta">Lo lee la IA de lo que dice el cliente. Si ya no debe, sale de la lista.</span></div>
      </aside>
    );
  }

  return (
    <aside className="card prom-side">
      <div className="prom-side__head">
        <div className="prom-side__tabs">
          <button className="on">⏳ Promesas</button>
          <button onClick={() => setVista('retiros')}>🚚 Retiros{nRetiros ? ` · ${nRetiros}` : ''}</button>
        </div>
        <div className="prom-side__chips">
          <div><b>{g.hoy.length}</b><span>para hoy</span></div>
          <div><b>{g.proximas.length}</b><span>próximas</span></div>
          <div><b className={g.atencion.length ? 'alerta' : ''}>{g.atencion.length}</b><span>necesitan a alguien</span></div>
        </div>
      </div>
      <div className="prom-side__body">
        {error && <div className="sched-err" style={{ padding: 14 }}>No se pudieron cargar: {error}</div>}
        {!data && !error && <div className="prom-side__empty">Cargando…</div>}
        {data && !g.hoy.length && !g.proximas.length && !g.atencion.length && (
          <div className="prom-side__empty">No hay promesas abiertas.</div>
        )}
        {g.hoy.length > 0 && <div className="prom-side__sec">Para hoy</div>}
        {g.hoy.map((p) => <Item key={p.id} p={p} cls="hoy" onPick={onPick} linea={siguiente(p, pagoHoyHora)} />)}
        {g.proximas.length > 0 && <div className="prom-side__sec">Próximas</div>}
        {g.proximas.map((p) => (
          <Item key={p.id} p={p} onPick={onPick}
            linea={`promete ${dia(p.fechaPrometida)}${p.followUpFecha && p.followUpFecha !== String(p.fechaPrometida).slice(0, 10) ? ` · follow up ${dia(p.followUpFecha)}` : ''} · ${p.intento || 1}.ª${p.textoOriginal ? ` · "${p.textoOriginal}"` : ''}`} />
        ))}
        {g.atencion.length > 0 && <div className="prom-side__sec">Necesitan a alguien</div>}
        {g.atencion.map((p) => (
          <Item key={p.id} p={p} cls="alerta" onPick={onPick}
            linea={p.estado === 'escalada' ? (p.motivoCierre || 'Varias promesas incumplidas') : (p.motivoCierre || 'Sin nueva fecha')} />
        ))}
      </div>
      {onVerTodas && (
        <div className="prom-side__foot">
          <button className="a-link" onClick={onVerTodas}>Ver todas, con historial →</button>
        </div>
      )}
    </aside>
  );
}
