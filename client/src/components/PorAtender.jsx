import { useMemo, useState } from 'react';
import { marcarNoRetiro } from '../api';
import { money, phoneFmt } from '../format';
import { dia, ymdRD } from './PromesasView';

const DIAS_DICE_PAGO = 2; // "dijo que pagó" pasa a una persona si a los N días sigue el vencido

const fechaCorta = (iso) => {
  if (!iso) return '';
  const s = String(iso);
  return dia(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ymdRD(new Date(s)));
};

/**
 * Clientes con vencido que necesitan a una persona: ningún agente los llama
 * hasta que alguien los revise y los vuelva a prender en Clientes.
 *   escalar   → varias promesas incumplidas seguidas
 *   dice_pago → dijo que pagó, pero a los días sigue con vencido
 */
export function necesitanAlguien(clientes) {
  const corte = Date.now() - DIAS_DICE_PAGO * 86400000;
  const out = [];
  for (const c of clientes || []) {
    if ((c.deuda_vencida || 0) <= 0 && !c.prueba) continue; // ya no debe: nadie tiene que hacer nada
    if (c.estadoCobro === 'escalar') {
      out.push({ c, motivo: `🙋 ${c.estadoDetalle || 'Varias promesas incumplidas'}`, desde: c.estadoAt });
    } else if (c.estadoCobro === 'dice_pago' && c.estadoAt && Date.parse(c.estadoAt) <= corte) {
      out.push({ c, motivo: `💬 Dijo que pagó${c.estadoDetalle ? ` el ${fechaCorta(c.estadoDetalle)}` : ''} y sigue el vencido`, desde: c.estadoAt });
    }
  }
  return out.sort((a, b) => (b.c.deuda_vencida || 0) - (a.c.deuda_vencida || 0));
}

/** Texto corto del retiro: "vie, 6 nov · tarde 14:00–18:00". */
export function retiroTexto(p) {
  const r = (p.ficha && p.ficha.retiro) || {};
  const fecha = r.fecha || String(p.fechaPrometida || '').slice(0, 10);
  const franja = r.desde ? `${r.franja === 'manana' ? 'mañana ' : r.franja === 'tarde' ? 'tarde ' : ''}${r.desde}–${r.hasta}` : 'hora sin definir';
  return `${fecha ? dia(fecha) : 'sin fecha'} · ${franja}`;
}

/** Promesas abiertas en las que el cliente pidió que pasen a buscar el pago, por día del retiro. */
export function agruparRetiros(promesas) {
  const hoy = ymdRD(new Date());
  const manana = ymdRD(new Date(Date.now() + 86400000));
  const out = { hoy: [], manana: [], proximos: [] };
  for (const p of promesas || []) {
    if (!(p.estado === 'pendiente' || p.estado === 'en_seguimiento')) continue;
    if (!p.ficha || p.ficha.modalidad !== 'retiro') continue;
    const f = (p.ficha.retiro && p.ficha.retiro.fecha) || String(p.fechaPrometida || '').slice(0, 10);
    const item = { ...p, _retiroFecha: f };
    if (f <= hoy) out.hoy.push(item); else if (f === manana) out.manana.push(item); else out.proximos.push(item);
  }
  const orden = (a, b) => String(a._retiroFecha).localeCompare(String(b._retiroFecha))
    || String((a.ficha.retiro || {}).desde || '99').localeCompare(String((b.ficha.retiro || {}).desde || '99'));
  out.hoy.sort(orden); out.manana.sort(orden); out.proximos.sort(orden);
  return out;
}

function Item({ nombre, prueba, monto, linea, cls, onClick, titulo, accion }) {
  return (
    <div className={`asis-item ${cls || ''}`}>
      <button className="asis-item__main" onClick={onClick} title={titulo || 'Ir a este cliente en Clientes y llamadas'}>
        <span className="asis-item__l1">
          <span className="asis-item__name">{nombre}{prueba && <span className="tag-prueba">Prueba</span>}</span>
          {monto != null && <span className="asis-item__num">{money(monto)}</span>}
        </span>
        <span className="asis-item__l2">{linea}</span>
      </button>
      {accion}
    </div>
  );
}

// "log:123" → 123 (el id de la llamada en la tabla de llamadas).
const idDeKey = (k) => (/^log:/.test(String(k || '')) ? String(k).slice(4) : null);

/** Cuántos hay por atender (para el globito de la pestaña). */
export function contarPorAtender(clientes, prom) {
  const r = agruparRetiros(prom && prom.promesas);
  return necesitanAlguien(clientes).length + r.hoy.length + r.manana.length + r.proximos.length;
}

/**
 * Pestaña "Por atender": quién necesita a una persona y quién pidió que pasen a
 * buscar el pago. Click en uno → ese cliente en Clientes y llamadas.
 * @param prom      respuesta de /api/promesas/lista (la carga App, también para el globito)
 * @param onCambio  recargar prom tras corregir un retiro
 */
export default function PorAtender({ clientes, prom, verRetiros, onPick, onCambio }) {
  const [corrigiendo, setCorrigiendo] = useState(null);
  const [errRet, setErrRet] = useState(null);

  const lista = useMemo(() => necesitanAlguien(clientes), [clientes]);
  const ret = useMemo(() => agruparRetiros(prom && prom.promesas), [prom]);
  const nRet = ret.hoy.length + ret.manana.length + ret.proximos.length;
  const ir = (phone, llamada) => onPick(String(phone), llamada || null);

  const noEsRetiro = async (p) => {
    if (!window.confirm(`¿${p.nombre || phoneFmt(p.phone)} no pidió que pasen a buscar el pago?\n\nSale de la lista de retiros (la promesa sigue igual).`)) return;
    setCorrigiendo(p.id); setErrRet(null);
    try { await marcarNoRetiro(p.ficha.key); if (onCambio) await onCambio(); }
    catch (e) { setErrRet(e.message); }
    finally { setCorrigiendo(null); }
  };

  return (
    <div className="aten-grid">
      <section className="card aten-col">
        <div className="aten-col__head">
          <h3>🙋 Necesitan a una persona</h3>
          <span className={`aten-n ${lista.length ? 'alerta' : ''}`}>{lista.length}</span>
        </div>
        <div className="aten-col__body">
          {!lista.length && <div className="asis-empty">Nadie necesita a una persona ahora.</div>}
          {lista.map(({ c, motivo, desde }) => (
            <Item key={c.phone} nombre={c.name || phoneFmt(c.phone)} prueba={c.prueba} monto={c.deuda_vencida} cls="alerta"
              linea={`${motivo}${desde ? ` · desde ${fechaCorta(desde)}` : ''}`} onClick={() => ir(c.phone)} />
          ))}
        </div>
        <div className="aten-col__foot">Ningún agente los llama. Salen de aquí cuando alguien los vuelve a prender en Clientes, o cuando ya no deben.</div>
      </section>

      {verRetiros && (
        <section className="card aten-col">
          <div className="aten-col__head">
            <h3>🚚 Retiros</h3>
            <span className={`aten-n ${nRet ? 'hay' : ''}`}>{nRet}</span>
          </div>
          <div className="aten-col__body">
            {!prom && <div className="asis-empty">Cargando…</div>}
            {errRet && <div className="sched-err" style={{ padding: '8px 14px' }}>{errRet}</div>}
            {prom && !nRet && <div className="asis-empty">Nadie pidió que pasen a retirar el pago. Aparecen aquí cuando el cliente lo pide en una llamada.</div>}
            {[['hoy', 'Hoy'], ['manana', 'Mañana'], ['proximos', 'Próximos']].map(([k, lbl]) => ret[k].length > 0 && (
              <div key={k}>
                <div className="asis-sec">{lbl}</div>
                {ret[k].map((p) => (
                  <Item key={p.id} nombre={p.nombre || phoneFmt(p.phone)} prueba={p.prueba} monto={p.vencidoHoy} cls={k === 'hoy' ? 'hoy' : ''}
                    linea={`${retiroTexto(p)}${p.ficha.retiro && p.ficha.retiro.texto ? ` · "${p.ficha.retiro.texto}"` : ''}`}
                    titulo="Ver la llamada donde lo pidió (en Clientes y llamadas)"
                    onClick={() => ir(p.phone, { id: idDeKey(p.ficha.key) || p.llamadaId, at: p.ficha.llamadaAt || p.prometidaEl })}
                    accion={p.ficha.key && (
                      <button className="asis-item__accion" disabled={corrigiendo === p.id} onClick={() => noEsRetiro(p)}
                        title="La IA se equivocó: sacarlo de los retiros">
                        {corrigiendo === p.id ? '…' : 'No es retiro'}
                      </button>
                    )} />
                ))}
              </div>
            ))}
          </div>
          <div className="aten-col__foot">Lo lee la IA de la llamada: entra solo si el cliente pidió que pasen a buscar el pago, con su frase. Toca uno para oír la llamada; si la IA se equivocó, "No es retiro". Si ya no debe, sale solo.</div>
        </section>
      )}
    </div>
  );
}
