import { useEffect, useState } from 'react';
import { intencionColor, intencionLabel } from '../constants';
import CallDetail from './CallDetail';
import AgenteTag from './AgenteTag';
import HiloCorreo from './HiloCorreo';
import { RespuestaPill, EtiquetaIA } from './EmailsTable';
import { retiroVolverPendiente } from '../api';

const fmt = (iso) => {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
};

const idDe = (ll, i) => ll.id ?? (ll.phone + '-' + ll.created_at + '-' + i);
const pesos = (cent) => `RD$ ${(cent / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** Un retiro que logística atendió, en el historial: cuándo, cuánto, quién y la foto. */
function RetiroItem({ r, abierta, onToggle, superAdmin = false, onChanged }) {
  const ok = r.estado === 'retirado';
  const [revirtiendo, setRevirtiendo] = useState(false);
  const [aviso, setAviso] = useState(null);
  // Super admins: deshacer un "retirado" (p. ej. una prueba) y dejarlo como retiro pendiente.
  const volverPendiente = async () => {
    if (!window.confirm('¿Volver este retiro a pendiente?\n\n' +
      'Primero se pregunta a logística. Si allá todavía está como retirado, hay que anularlo allá ' +
      '(Retiros → este retiro → Anular retiro) y aquí vuelve solo a pendiente.\n\n' +
      'Si logística ya no lo tiene como retirado: se borran el monto, el RCP y la foto, su promesa se reabre ' +
      'y el cliente sale de "dice que pagó". No se le llama: sigue siendo un retiro.')) return;
    setRevirtiendo(true); setAviso(null);
    try { await retiroVolverPendiente(r.externoId); if (onChanged) await onChanged(); }
    catch (e) { setAviso(e.message); }
    finally { setRevirtiendo(false); }
  };
  const ruta = r.ruta || {};
  const quien = [ruta.repartidor, ruta.referencia].filter(Boolean).join(' · ');
  return (
    <div className={`cc-item cc-item--retiro ${ok ? '' : 'cc-item--retiro-mal'} ${abierta ? 'open' : ''}`}>
      <button className="cc-head" onClick={onToggle}>
        <span className="cc-caret">{abierta ? '▾' : '▸'}</span>
        <span className="cc-fecha">{fmt(r.atendidoEn || r.actualizadoAt)}</span>
        <span className={`estado-cobro retiro-log__pill ${ok ? 'retiro-log__pill--ok' : 'retiro-log__pill--mal'}`}>{ok ? '🚚 Retirado' : '❌ No retirado'}</span>
        {ok && r.montoCent != null && <span className="cc-fp"><strong>{pesos(r.montoCent)}</strong></span>}
        <span className="cc-notas">{[ok ? r.rcp : r.motivo, quien].filter(Boolean).join(' · ')}</span>
        {r.fotoUrl && <span className="cc-audio-ic" title="Tiene foto">📷</span>}
      </button>
      {abierta && (
        <div className="cc-retiro">
          <div className="cc-retiro__datos">
            <div><span>Cuándo</span><b>{fmt(r.atendidoEn || r.actualizadoAt)}</b></div>
            {ok && <div><span>Monto</span><b>{r.montoCent != null ? pesos(r.montoCent) : '—'}</b></div>}
            {ok && <div><span>Recibo</span><b>{r.rcp || '—'}</b></div>}
            {!ok && <div><span>Motivo</span><b>{r.motivo || '—'}</b></div>}
            <div><span>Repartidor</span><b>{ruta.repartidor || '—'}{ruta.referencia ? ` (${ruta.referencia})` : ''}</b></div>
          </div>
          {r.fotoUrl
            ? <a className="retiro-foto" href={r.fotoUrl} target="_blank" rel="noreferrer" title="Abrir la foto en grande"><img src={r.fotoUrl} alt="Foto del pago retirado" loading="lazy" /></a>
            : <div className="cc-retiro__sinfoto">Sin foto.</div>}
          {ok && superAdmin && r.externoId && (
            <div className="cc-retiro__acc">
              <button className="mini-btn" disabled={revirtiendo} onClick={volverPendiente}
                title="Solo super admins: deshacer el retirado (p. ej. una prueba) y dejarlo como retiro pendiente">
                {revirtiendo ? '…' : '↺ Volver a pendiente'}
              </button>
              {aviso && <div className="cc-retiro__aviso">{aviso}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Un correo de cobranza enviado, en el historial: asunto y si contestó; se despliega con el hilo. */
function CorreoItem({ co, abierta, onToggle }) {
  const respondio = co.respuestas && co.respuestas.length > 0;
  return (
    <div className={`cc-item cc-item--correo ${respondio ? 'cc-item--correo-si' : co.rebote ? 'cc-item--correo-rebote' : ''} ${abierta ? 'open' : ''}`}>
      <button className="cc-head" onClick={onToggle}>
        <span className="cc-caret">{abierta ? '▾' : '▸'}</span>
        <span className="cc-fecha">{fmt(co.fecha)}</span>
        <span className="agente-tag correo-tag">📧 Correo</span>
        <RespuestaPill correo={co} />
        {co.ia && <EtiquetaIA ia={co.ia} />}
        <span className="cc-notas">{(co.ia && co.ia.resumen) || co.asunto || (co.para || []).join(', ')}</span>
      </button>
      {abierta && <HiloCorreo correo={co} />}
    </div>
  );
}

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
export default function ClientCalls({ calls, retiros = [], correos = [], abrir = null, superAdmin = false, onChanged }) {
  const [open, setOpen] = useState(() => buscar(calls, abrir));
  useEffect(() => { if (abrir) setOpen(buscar(calls, abrir)); }, [abrir]); // eslint-disable-line react-hooks/exhaustive-deps
  const foco = abrir ? buscar(calls, abrir) : null;
  if ((!calls || !calls.length) && !retiros.length && !correos.length) {
    return <div style={{ padding: 14, color: 'var(--text-muted)' }}>Este cliente no tiene llamadas registradas.</div>;
  }
  // Llamadas y retiros atendidos, juntos y por fecha (más recientes primero).
  const fechaDe = (x) => Date.parse(x) || 0;
  const items = [
    ...(calls || []).map((ll, i) => ({ tipo: 'llamada', ll, i, at: fechaDe(ll.created_at) })),
    ...retiros.map((r) => ({ tipo: 'retiro', r, at: fechaDe(r.atendidoEn || r.actualizadoAt) })),
    ...correos.map((co) => ({ tipo: 'correo', co, at: fechaDe(co.fecha) })),
  ].sort((a, b) => b.at - a.at);
  const nRet = retiros.filter((r) => r.estado === 'retirado').length;
  return (
    <div className="client-calls">
      <div className="cc-title">
        {calls.length} llamada{calls.length === 1 ? '' : 's'} · 📞 {calls.filter((l) => l.agente !== 'seguimiento').length} de cobranzas · ↩ {calls.filter((l) => l.agente === 'seguimiento').length} de follow up
        {retiros.length > 0 && ` · 🚚 ${nRet} retiro${nRet === 1 ? '' : 's'}${retiros.length > nRet ? ` (${retiros.length - nRet} sin retirar)` : ''}`}
        {correos.length > 0 && ` · 📧 ${correos.length} correo${correos.length === 1 ? '' : 's'} (↩ ${correos.filter((co) => co.respuestas && co.respuestas.length).length} con respuesta)`}
      </div>
      {items.map((it) => {
        if (it.tipo === 'correo') {
          const cid = `correo-${it.co.id || it.at}`;
          return <CorreoItem key={cid} co={it.co} abierta={open === cid} onToggle={() => setOpen(open === cid ? null : cid)} />;
        }
        if (it.tipo === 'retiro') {
          const rid = `retiro-${it.r.externoId}`;
          return <RetiroItem key={rid} r={it.r} abierta={open === rid} onToggle={() => setOpen(open === rid ? null : rid)} superAdmin={superAdmin} onChanged={onChanged} />;
        }
        const { ll, i } = it;
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
