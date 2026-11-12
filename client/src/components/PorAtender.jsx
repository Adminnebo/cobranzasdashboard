import { Fragment, useMemo, useState } from 'react';
import { marcarNoRetiro, atencionListo, retiroVolverPendiente } from '../api';
import RetiroEstado from './RetiroEstado';
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
      // El detalle es la fecha de la llamada, o una nota (retirado por logística).
      const esFecha = /^\d{4}-\d{2}-\d{2}/.test(c.estadoDetalle || '');
      const dijo = !c.estadoDetalle ? 'Dijo que pagó' : esFecha ? `Dijo que pagó el ${fechaCorta(c.estadoDetalle)}` : c.estadoDetalle;
      out.push({ c, motivo: `💬 ${dijo} y sigue el vencido`, desde: c.estadoAt });
    } else if (c.atencionMotivo) {
      // La cola no pudo llamarlo en su horario varios días seguidos: lo llama una persona.
      out.push({ c, motivo: `🕘 ${c.atencionMotivo}`, desde: c.atencionAt, listo: true });
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

/**
 * Promesas abiertas en las que el cliente pidió que pasen a buscar el pago, por día del retiro.
 * Aparte, en `retirados`, los que logística retiró hoy (su promesa ya se cerró como
 * "dice que pagó"): se ven para saber que se cobró, pero no cuentan como pendientes.
 */
export function agruparRetiros(promesas) {
  const hoy = ymdRD(new Date());
  const manana = ymdRD(new Date(Date.now() + 86400000));
  const out = { hoy: [], manana: [], proximos: [], retirados: [] };
  for (const p of promesas || []) {
    if (!p.ficha || p.ficha.modalidad !== 'retiro') continue;
    const f = (p.ficha.retiro && p.ficha.retiro.fecha) || String(p.fechaPrometida || '').slice(0, 10);
    const item = { ...p, _retiroFecha: f };
    if (!(p.estado === 'pendiente' || p.estado === 'en_seguimiento')) {
      const lg = p.logistica;
      const cuando = lg && (lg.atendidoEn || lg.actualizadoAt);
      if (lg && lg.estado === 'retirado' && cuando && ymdRD(new Date(cuando)) === hoy) out.retirados.push(item);
      continue;
    }
    if (f <= hoy) out.hoy.push(item); else if (f === manana) out.manana.push(item); else out.proximos.push(item);
  }
  const orden = (a, b) => String(a._retiroFecha).localeCompare(String(b._retiroFecha))
    || String((a.ficha.retiro || {}).desde || '99').localeCompare(String((b.ficha.retiro || {}).desde || '99'));
  out.hoy.sort(orden); out.manana.sort(orden); out.proximos.sort(orden); out.retirados.sort(orden);
  return out;
}

const pesos = (cent) => `RD$ ${(cent / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/**
 * Cómo va el retiro en logística, para la pastilla: { txt, cls, tip } o null si
 * no se ha mandado. Con error (no llegó, sin código) sale aparte el aviso.
 */
export function logisticaPill(lg) {
  if (!lg || !lg.estado) return null;
  const r = lg.ruta || {};
  switch (lg.estado) {
    case 'por_ubicar': return { txt: '📍 Por ubicar', cls: '', tip: 'Logística todavía no tiene la ubicación del cliente.' };
    case 'por_asignar': return { txt: '⏳ Por asignar', cls: '', tip: lg.motivo || 'Esperando que logística lo meta en una ruta.' };
    case 'en_ruta': {
      const det = [r.referencia, r.repartidor].filter(Boolean).join(' · ');
      return { txt: `🚚 En ruta${det ? ` ${det}` : ''}`, cls: 'ruta', tip: `En la ruta${r.referencia ? ` ${r.referencia}` : ''}${r.fecha ? ` del ${dia(r.fecha)}` : ''}${r.repartidor ? `, con ${r.repartidor}` : ''}.` };
    }
    case 'retirado': {
      const det = [lg.montoCent != null ? pesos(lg.montoCent) : null, lg.rcp].filter(Boolean).join(' · ');
      return { txt: `✅ Retirado${det ? ` ${det}` : ''}`, cls: 'ok', tip: `Logística retiró el pago${lg.atendidoEn ? ` el ${fechaCorta(lg.atendidoEn)}` : ''}. El cliente quedó en "dice que pagó": no se le llama.` };
    }
    case 'no_retirado': return { txt: `❌ No retirado${lg.motivo ? `: ${lg.motivo}` : ''}`, cls: 'mal', tip: lg.motivo || 'Logística pasó y no pudo retirar el pago.' };
    case 'cancelado': return { txt: 'Cancelado', cls: '', tip: 'El retiro se canceló en logística.' };
    default: return null;
  }
}

/** Pastillas de logística de un retiro (estado + aviso si no llegó). */
function LogisticaPills({ lg }) {
  if (!lg) return null;
  if (lg.prueba && !lg.estado) {
    return <span className="retiro-log"><span className="estado-cobro retiro-log__pill" title="Es un número de prueba: el retiro no se manda a las rutas de logística.">🧪 Prueba: no va a logística</span></span>;
  }
  const e = logisticaPill(lg);
  if (!e && !lg.error) return null;
  return (
    <span className="retiro-log">
      {e && <span className={`estado-cobro retiro-log__pill ${e.cls ? `retiro-log__pill--${e.cls}` : ''}`} title={e.tip}>{e.txt}</span>}
      {lg.error && <span className="estado-cobro retiro-log__pill retiro-log__pill--aviso" title={lg.error}>⚠ No llegó a logística</span>}
    </span>
  );
}

function Item({ nombre, prueba, monto, linea, extra, cls, onClick, titulo, accion, abierto }) {
  return (
    <div className={`asis-item ${cls || ''} ${abierto ? 'asis-item--abierto' : ''}`}>
      <button className="asis-item__main" onClick={onClick} title={titulo || 'Ir a este cliente en Clientes y llamadas'}>
        <span className="asis-item__l1">
          <span className="asis-item__name">{nombre}{prueba && <span className="tag-prueba">Prueba</span>}</span>
          {monto != null && <span className="asis-item__num">{money(monto)}</span>}
        </span>
        <span className="asis-item__l2">{linea}</span>
        {extra}
      </button>
      {accion}
    </div>
  );
}

// "log:123" → 123 (el id de la llamada en la tabla de llamadas).
const esCorreo = (k) => /^correo:/.test(String(k || ''));
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
export default function PorAtender({ clientes, prom, verRetiros, onPick, onCambio, onRecargar }) {
  const [corrigiendo, setCorrigiendo] = useState(null);
  const [abierto, setAbierto] = useState(null); // retiro con su estado desplegado
  const [atendiendo, setAtendiendo] = useState(null);
  const [errAt, setErrAt] = useState(null);

  const listo = async (c) => {
    setAtendiendo(c.phone); setErrAt(null);
    try { await atencionListo(c.phone); if (onRecargar) await onRecargar(); }
    catch (e) { setErrAt(e.message); }
    finally { setAtendiendo(null); }
  };
  const [errRet, setErrRet] = useState(null);

  const lista = useMemo(() => necesitanAlguien(clientes), [clientes]);
  const ret = useMemo(() => agruparRetiros(prom && prom.promesas), [prom]);
  const nRet = ret.hoy.length + ret.manana.length + ret.proximos.length;
  const ir = (phone, llamada) => onPick(String(phone), llamada || null);

  const noEsRetiro = async (p) => {
    if (!window.confirm(`¿${p.nombre || phoneFmt(p.phone)} no pidió que pasen a buscar el pago?\n\nSale de la lista de retiros y su promesa vuelve al follow up normal, con llamadas.`)) return;
    setCorrigiendo(p.id); setErrRet(null);
    try { await marcarNoRetiro(p.ficha.key); if (onCambio) await onCambio(); }
    catch (e) { setErrRet(e.message); }
    finally { setCorrigiendo(null); }
  };

  // Super admins: deshacer un "retirado" (p. ej. lo marcaron en una prueba).
  const volverPendiente = async (p) => {
    if (!window.confirm(`¿Volver a pendiente el retiro de ${p.nombre || phoneFmt(p.phone)}?\n\n` +
      'Primero se pregunta a logística. Si allá todavía está como retirado, hay que anularlo allá ' +
      '(Retiros → este retiro → Anular retiro) y aquí vuelve solo a pendiente.\n\n' +
      'Si logística ya no lo tiene como retirado: se borra el "retirado" (monto, RCP y foto), su promesa se reabre ' +
      'y el cliente sale de "dice que pagó". No se le llama: sigue siendo un retiro.')) return;
    setCorrigiendo(p.id); setErrRet(null);
    try { await retiroVolverPendiente(p.logistica.externoId); if (onCambio) await onCambio(); }
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
          {errAt && <div className="sched-err" style={{ padding: '8px 14px' }}>{errAt}</div>}
          {lista.map(({ c, motivo, desde, listo: conListo }) => (
            <Item key={c.phone} nombre={c.name || phoneFmt(c.phone)} prueba={c.prueba} monto={c.deuda_vencida} cls="alerta"
              linea={`${motivo}${desde ? ` · desde ${fechaCorta(desde)}` : ''}`} onClick={() => ir(c.phone)}
              accion={conListo && (
                <button className="asis-item__accion" disabled={atendiendo === c.phone} onClick={() => listo(c)}
                  title="Ya lo atendió una persona: sacarlo de la lista">
                  {atendiendo === c.phone ? '…' : '✓ Listo'}
                </button>
              )} />
          ))}
        </div>
        <div className="aten-col__foot">Los de 🙋 y 💬: ningún agente los llama; salen cuando alguien los vuelve a prender en Clientes, o cuando ya no deben. Los de 🕘: la cola no pudo llamarlos en su horario varios días; salen con ✓ Listo.</div>
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
            {prom && !nRet && !ret.retirados.length && <div className="asis-empty">Nadie pidió que pasen a retirar el pago. Aparecen aquí cuando el cliente lo pide en una llamada.</div>}
            {[['hoy', 'Hoy'], ['manana', 'Mañana'], ['proximos', 'Próximos'], ['retirados', 'Retirados hoy']].map(([k, lbl]) => ret[k].length > 0 && (
              <div key={k}>
                <div className="asis-sec">{lbl}</div>
                {ret[k].map((p) => (
                  <Fragment key={p.id}>
                  <Item nombre={p.nombre || phoneFmt(p.phone)} prueba={p.prueba} monto={p.vencidoHoy} cls={k === 'hoy' ? 'hoy' : ''} abierto={abierto === p.id}
                    linea={`${esCorreo(p.ficha.key) ? '📧 ' : ''}${retiroTexto(p)}${p.ficha.retiro && p.ficha.retiro.texto ? ` · "${p.ficha.retiro.texto}"` : ''}`}
                    extra={(
                      <>
                        {p.direccion && <span className="asis-item__l2" title={p.direccionRef ? `Referencia: ${p.direccionRef}` : undefined}>📍 {p.direccion}</span>}
                        <LogisticaPills lg={p.logistica} />
                      </>
                    )}
                    titulo="Ver cómo va el retiro: repartidor, si va en camino, cuánto falta y la foto"
                    onClick={() => setAbierto(abierto === p.id ? null : p.id)}
                    accion={k === 'retirados'
                      ? (prom.superAdmin && p.logistica && p.logistica.externoId && (
                        <button className="asis-item__accion" disabled={corrigiendo === p.id} onClick={() => volverPendiente(p)}
                          title="Solo super admins: deshacer el retirado (p. ej. una prueba). Lo de verdad se anula en logística; esto es por si su aviso no llegó">
                          {corrigiendo === p.id ? '…' : '↺ Volver a pendiente'}
                        </button>
                      ))
                      : p.ficha.key && (
                        <button className="asis-item__accion" disabled={corrigiendo === p.id} onClick={() => noEsRetiro(p)}
                          title="La IA se equivocó: sacarlo de los retiros">
                          {corrigiendo === p.id ? '…' : 'No es retiro'}
                        </button>
                      )} />
                  {abierto === p.id && (
                    <RetiroEstado externoId={p.logistica && p.logistica.externoId} lgLista={p.logistica}
                      porCorreo={esCorreo(p.ficha.key)}
                      onVerLlamada={() => ir(p.phone, esCorreo(p.ficha.key) ? {} : { id: idDeKey(p.ficha.key) || p.llamadaId, at: p.ficha.llamadaAt || p.prometidaEl })} />
                  )}
                  </Fragment>
                ))}
              </div>
            ))}
          </div>
          <div className="aten-col__foot">Lo lee la IA de la llamada o de la respuesta al correo (📧): entra solo si el cliente pidió que pasen a buscar el pago, con su frase, y se manda a logística. A estos clientes no se les llama. Toca uno para ver cómo va (repartidor, si va en camino, cuánto falta, la foto) y oír la llamada o leer el correo; si la IA se equivocó, "No es retiro" (también se cancela en logística). Si ya no debe, sale solo.</div>
        </section>
      )}
    </div>
  );
}
