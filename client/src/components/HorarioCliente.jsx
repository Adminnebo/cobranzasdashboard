import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchSchedule } from '../api';

// Días: 1 = lunes … 7 = domingo.
export const DIAS = [[1, 'L', 'lun'], [2, 'M', 'mar'], [3, 'X', 'mié'], [4, 'J', 'jue'], [5, 'V', 'vie'], [6, 'S', 'sáb'], [7, 'D', 'dom']];
const diasTexto = (dias) => {
  if (!dias || !dias.length) return '';
  const set = new Set(dias);
  if ([1, 2, 3, 4, 5].every((d) => set.has(d)) && set.size === 5) return 'L–V ';
  return DIAS.filter(([n]) => set.has(n)).map(([, , c]) => c).join(', ') + ' ';
};
export const horarioTexto = (h) => (h || []).map((b) => `${diasTexto(b.dias)}${b.start}–${b.end}`).join(' · ');

/**
 * Horario propio de uno o varios clientes. Si el cliente tiene uno, el bot lo
 * llama solo dentro de esas horas (y antes que al resto mientras estén
 * abiertas); si no, sigue el horario general.
 *
 * variant: 'chip' (muestra el horario, va bajo el nombre) | 'btn' (🕘 en Acción)
 *          | 'bulk' (para la selección) | 'menu' (opción del menú ⋯ de la fila).
 */
export default function HorarioCliente({ horario, origen, detalle, count = 1, onSave, disabled, variant = 'btn' }) {
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
  const boton = variant === 'menu'
    ? (
      <button ref={btnRef} className="row-menu__item" disabled={disabled} onClick={() => (open ? setOpen(false) : abrir())}>
        🕘 {tiene ? 'Cambiar horario propio…' : 'Horario propio…'}
      </button>
    )
    : variant === 'chip'
    ? (
      <button ref={btnRef} className={`horario-chip ${origen === 'ia' ? 'horario-chip--ia' : ''}`} disabled={disabled} onClick={() => (open ? setOpen(false) : abrir())}
        title={origen === 'ia'
          ? `Horario que dio el cliente (lo puso el sistema${detalle ? `: ${detalle}` : ''}). El bot lo llama solo en estas horas. Click para cambiarlo; si lo cambias tú, el sistema ya no lo toca.`
          : 'Horario propio: el bot lo llama solo en estas horas, antes que al resto. Click para cambiarlo.'}>
        {origen === 'ia' ? '🤖' : '🕘'} {horarioTexto(horario)}
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
          {origen === 'ia' && (
            <div className="horario-ia-nota">🤖 Lo puso el sistema con lo que dijo el cliente{detalle ? `: ${detalle}` : ''}. Si lo guardas, queda como puesto a mano y el sistema ya no lo cambia.</div>
          )}
          <div className="sched-tz" style={{ marginTop: -4 }}>
            El bot lo llama solo en estas horas, y antes que al resto. Puede salirse del horario general{cfg ? ` (${horarioTexto(cfg.blocks)})` : ''}, pero no de {desde}–{hasta}. Marca días en un bloque para que valga solo esos días (ej. solo martes); sin días, valen los del horario general.
          </div>
          <div>
            {blocks.map((b, i) => (
              <div className="horario-bloque" key={i}>
                <div className="sched-block">
                  <input type="time" min={desde} max={hasta} value={b.start} onChange={(e) => setBlock(i, 'start', e.target.value)} />
                  <span>a</span>
                  <input type="time" min={desde} max={hasta} value={b.end} onChange={(e) => setBlock(i, 'end', e.target.value)} />
                  <button className="sched-x" onClick={() => setBlocks((bs) => bs.filter((_, j) => j !== i))} disabled={blocks.length <= 1} title="Quitar bloque">✕</button>
                </div>
                <div className="horario-dias" role="group" aria-label="Días del bloque">
                  {DIAS.map(([n, letra, corto]) => {
                    const on = (b.dias || []).includes(n);
                    return (
                      <button key={n} type="button" className={`horario-dia ${on ? 'on' : ''}`} title={corto}
                        onClick={() => setBlock(i, 'dias', on ? (b.dias || []).filter((x) => x !== n) : [...(b.dias || []), n].sort())}>
                        {letra}
                      </button>
                    );
                  })}
                  <span className="horario-dias__nota">{b.dias && b.dias.length ? '' : 'días del general'}</span>
                </div>
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
