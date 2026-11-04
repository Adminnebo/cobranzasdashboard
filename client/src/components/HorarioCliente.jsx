import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchSchedule } from '../api';

export const horarioTexto = (h) => (h || []).map((b) => `${b.start}–${b.end}`).join(', ');

/**
 * Horario propio de uno o varios clientes. Si el cliente tiene uno, el bot lo
 * llama solo dentro de esas horas (y antes que al resto mientras estén
 * abiertas); si no, sigue el horario general.
 *
 * variant: 'chip' (muestra el horario, va bajo el nombre) | 'btn' (🕘 en Acción)
 *          | 'bulk' (para la selección).
 */
export default function HorarioCliente({ horario, count = 1, onSave, disabled, variant = 'btn' }) {
  const [open, setOpen] = useState(false);
  const [blocks, setBlocks] = useState([]);
  const [cfg, setCfg] = useState(null);
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);

  const abrir = () => {
    setBlocks(horario && horario.length ? horario.map((b) => ({ ...b })) : [{ start: '08:00', end: '10:00' }]);
    setErr(null);
    setOpen(true);
    fetchSchedule().then(setCfg).catch(() => {});
  };

  // El popover va en un portal con posición fija: la tabla tiene scroll y lo cortaría.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const ancho = 300;
    const left = Math.max(12, Math.min(window.innerWidth - ancho - 12, r.left));
    const abajo = window.innerHeight - r.bottom > 300;
    setPos(abajo ? { left, top: r.bottom + 6 } : { left, bottom: window.innerHeight - r.top + 6 });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const fuera = (e) => {
      if (popRef.current && !popRef.current.contains(e.target) && !btnRef.current.contains(e.target)) setOpen(false);
    };
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

  const desde = (cfg && cfg.horarioClienteDesde) || '08:00';
  const hasta = (cfg && cfg.horarioClienteHasta) || '19:00';
  const setBlock = (i, k, v) => setBlocks((bs) => bs.map((b, j) => (j === i ? { ...b, [k]: v } : b)));

  const guardar = async (valor) => {
    setErr(null);
    if (valor) {
      for (const b of valor) {
        if (!b.start || !b.end || b.end <= b.start) { setErr('Cada bloque debe terminar después de empezar.'); return; }
        if (b.start < desde || b.end > hasta) { setErr(`Tiene que estar entre ${desde} y ${hasta}.`); return; }
      }
    }
    setSaving(true);
    try { await onSave(valor); setOpen(false); }
    catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const tiene = horario && horario.length > 0;
  const boton = variant === 'chip'
    ? (
      <button ref={btnRef} className="horario-chip" disabled={disabled} onClick={() => (open ? setOpen(false) : abrir())}
        title="Horario propio: el bot lo llama solo en estas horas, antes que al resto. Click para cambiarlo.">
        🕘 {horarioTexto(horario)}
      </button>
    )
    : (
      <button ref={btnRef} className="mini-btn" disabled={disabled} onClick={() => (open ? setOpen(false) : abrir())}
        title={variant === 'bulk' ? 'Poner el mismo horario a los seleccionados' : 'Ponerle un horario propio a este cliente'}>
        {variant === 'bulk' ? `🕘 Horario a ${count}` : '🕘'}
      </button>
    );

  return (
    <>
      {boton}
      {open && pos && createPortal(
        <div className="horario-pop" ref={popRef} style={pos} onClick={(e) => e.stopPropagation()}>
          <div className="sched-lbl">
            Horario propio{count > 1 ? ` de ${count} clientes` : ''}
          </div>
          <div className="sched-tz" style={{ marginTop: -4 }}>
            El bot lo llama solo en estas horas, y antes que al resto. Puede salirse del horario general{cfg ? ` (${horarioTexto(cfg.blocks)})` : ''}, pero no de {desde}–{hasta}. Los días son los del horario general.
          </div>
          <div>
            {blocks.map((b, i) => (
              <div className="sched-block" key={i}>
                <input type="time" min={desde} max={hasta} value={b.start} onChange={(e) => setBlock(i, 'start', e.target.value)} />
                <span>a</span>
                <input type="time" min={desde} max={hasta} value={b.end} onChange={(e) => setBlock(i, 'end', e.target.value)} />
                <button className="sched-x" onClick={() => setBlocks((bs) => bs.filter((_, j) => j !== i))} disabled={blocks.length <= 1} title="Quitar bloque">✕</button>
              </div>
            ))}
            <button className="mini-btn" onClick={() => setBlocks((bs) => [...bs, { start: '15:00', end: '17:00' }])}>+ Agregar bloque</button>
          </div>
          {err && <div className="sched-err">{err}</div>}
          <div className="sched-actions">
            {(tiene || count > 1)
              ? <button className="mini-btn danger" disabled={saving} onClick={() => guardar(null)} title="Vuelve a seguir el horario general">Quitar (usar el general)</button>
              : <span />}
            <button className="btn" disabled={saving} onClick={() => guardar(blocks)}>{saving ? 'Guardando…' : 'Guardar'}</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
