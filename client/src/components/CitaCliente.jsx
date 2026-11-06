import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// RD es UTC−4 todo el año.
const partes = (iso) => {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santo_Domingo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = (t) => f.find((p) => p.type === t).value;
  return { fecha: `${g('year')}-${g('month')}-${g('day')}`, hora: `${g('hour') === '24' ? '00' : g('hour')}:${g('minute')}` };
};
const manana = () => {
  const d = new Date(Date.now() + 86400000);
  return partes(d.toISOString()).fecha;
};

/** "vie 6 nov · 3:00 p. m." */
export function citaTexto(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const dia = d.toLocaleDateString('es-DO', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'America/Santo_Domingo' });
  const h = d.toLocaleTimeString('es-DO', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Santo_Domingo' });
  return `${dia} · ${h}`;
}

/**
 * Hora en que el cliente pidió que lo llamen ("llámenme mañana a las 3"). Manda
 * sobre su horario propio y el general, solo para la próxima llamada.
 * variant: 'chip' (bajo el nombre, si tiene una) | 'menu' (opción del menú ⋯).
 */
export default function CitaCliente({ cita, onSave, disabled, variant = 'menu' }) {
  const [open, setOpen] = useState(false);
  const [fecha, setFecha] = useState('');
  const [hora, setHora] = useState('15:00');
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);

  const abrir = () => {
    if (cita && cita.at) { const p = partes(cita.at); setFecha(p.fecha); setHora(p.hora); }
    else { setFecha(manana()); setHora('15:00'); }
    setErr(null);
    setOpen(true);
  };

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const ancho = 280;
    const left = Math.max(12, Math.min(window.innerWidth - ancho - 12, r.left));
    const abajo = window.innerHeight - r.bottom > 240;
    setPos(abajo ? { left, top: r.bottom + 6 } : { left, bottom: window.innerHeight - r.top + 6 });
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const fuera = (e) => { if (popRef.current && !popRef.current.contains(e.target) && !btnRef.current.contains(e.target)) setOpen(false); };
    const cerrar = () => setOpen(false);
    document.addEventListener('mousedown', fuera);
    window.addEventListener('scroll', cerrar, true);
    window.addEventListener('resize', cerrar);
    return () => {
      document.removeEventListener('mousedown', fuera);
      window.removeEventListener('scroll', cerrar, true);
      window.removeEventListener('resize', cerrar);
    };
  }, [open]);

  const guardar = async (quitar) => {
    setErr(null);
    let at = null;
    if (!quitar) {
      if (!fecha || !hora) { setErr('Pon el día y la hora.'); return; }
      at = new Date(`${fecha}T${hora}:00-04:00`).toISOString();
    }
    setSaving(true);
    try { await onSave(at); setOpen(false); }
    catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const tiene = !!(cita && cita.at);
  const boton = variant === 'chip'
    ? (
      <button ref={btnRef} className={`horario-chip cita-chip ${cita && cita.origen === 'ia' ? 'horario-chip--ia' : ''}`} disabled={disabled} onClick={() => (open ? setOpen(false) : abrir())}
        title={`${cita && cita.origen === 'ia' ? 'Lo pidió el cliente en una llamada' : 'Hora puesta a mano'}${cita && cita.texto && cita.origen === 'ia' ? `: "${cita.texto}"` : ''}. La próxima llamada sale a esa hora, por encima de su horario y del general.${cita && cita.movida ? ` Ya se movió ${cita.movida} vez(es) porque no alcanzó a salir.` : ''} Click para cambiarla.`}>
        📞 {citaTexto(cita.at)}{cita.movida ? ` ↪${cita.movida}` : ''}
      </button>
    )
    : (
      <button ref={btnRef} className="row-menu__item" disabled={disabled} onClick={() => (open ? setOpen(false) : abrir())}>
        📞 {tiene ? 'Cambiar la hora para llamarlo…' : 'Llamarlo a una hora…'}
      </button>
    );

  return (
    <>
      {variant === 'chip' && !tiene ? null : boton}
      {open && pos && createPortal(
        <div className="horario-pop" ref={popRef} style={{ ...pos, width: 280 }} onClick={(e) => e.stopPropagation()}>
          <div className="sched-lbl">Llamarlo a una hora</div>
          <div className="sched-tz" style={{ marginTop: -4 }}>
            Solo para la próxima llamada: sale a esa hora (y hasta media hora después), aunque esté fuera de su horario o del general. Si no alcanza a salir, pasa al siguiente día hábil a la misma hora.
          </div>
          <div className="sched-block">
            <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
            <input type="time" value={hora} onChange={(e) => setHora(e.target.value)} />
          </div>
          {err && <div className="sched-err">{err}</div>}
          <div className="sched-actions">
            {tiene ? <button className="mini-btn danger" disabled={saving} onClick={() => guardar(true)}>Quitar</button> : <span />}
            <button className="btn" disabled={saving} onClick={() => guardar(false)}>{saving ? 'Guardando…' : 'Guardar'}</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
