import { useEffect, useRef, useState } from 'react';
import { fetchSchedule, saveSchedule } from '../api';

/** Configura el horario de llamadas (bloques) desde la UI. */
export default function SchedulePanel({ onSaved }) {
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const ref = useRef(null);

  useEffect(() => { fetchSchedule().then(setCfg).catch(() => {}); }, []);

  // Cerrar al hacer click fuera.
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  if (!cfg) return null;

  const set = (patch) => setCfg((c) => ({ ...c, ...patch }));
  const setBlock = (i, k, v) => set({ blocks: cfg.blocks.map((b, j) => (j === i ? { ...b, [k]: v } : b)) });
  const addBlock = () => set({ blocks: [...cfg.blocks, { start: '09:00', end: '12:00' }] });
  const removeBlock = (i) => set({ blocks: cfg.blocks.filter((_, j) => j !== i) });

  const guardar = async () => {
    setErr(null);
    // Validación: cada bloque fin > inicio.
    for (const b of cfg.blocks) {
      if (!b.start || !b.end || b.end <= b.start) { setErr('Cada bloque debe tener fin mayor que inicio.'); return; }
    }
    if (cfg.enabled && !cfg.blocks.length) { setErr('Agrega al menos un bloque horario.'); return; }
    setSaving(true);
    try {
      const saved = await saveSchedule({
        enabled: cfg.enabled, weekdaysOnly: cfg.weekdaysOnly, autoEnqueue: cfg.autoEnqueue, blocks: cfg.blocks,
      });
      setCfg(saved);
      setOpen(false);
      if (onSaved) onSaved();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const resumen = cfg.enabled
    ? `${cfg.blocks.map((b) => `${b.start}–${b.end}`).join(', ')}${cfg.weekdaysOnly ? ' · L-V' : ''}`
    : 'Desactivado';

  return (
    <div className="sched-wrap" ref={ref}>
      <button className={`btn secondary sched-btn ${cfg.enabled ? 'on' : ''}`} onClick={() => setOpen((o) => !o)}>
        ⏰ Horario de llamadas <span className="sched-summary">{resumen}</span>
      </button>

      {open && (
        <div className="sched-pop">
          <label className="sched-toggle">
            <input type="checkbox" checked={cfg.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
            <span><strong>Llamadas automáticas</strong> — el sistema llama dentro de los bloques</span>
          </label>

          <div className="sched-blocks">
            <div className="sched-lbl">Bloques horarios</div>
            {cfg.blocks.map((b, i) => (
              <div className="sched-block" key={i}>
                <input type="time" value={b.start} onChange={(e) => setBlock(i, 'start', e.target.value)} />
                <span>a</span>
                <input type="time" value={b.end} onChange={(e) => setBlock(i, 'end', e.target.value)} />
                <button className="sched-x" onClick={() => removeBlock(i)} disabled={cfg.blocks.length <= 1} title="Quitar bloque">✕</button>
              </div>
            ))}
            <button className="mini-btn" onClick={addBlock}>+ Agregar bloque</button>
          </div>

          <label className="sched-check">
            <input type="checkbox" checked={cfg.weekdaysOnly} onChange={(e) => set({ weekdaysOnly: e.target.checked })} />
            Solo lunes a viernes
          </label>
          <label className="sched-check">
            <input type="checkbox" checked={cfg.autoEnqueue} onChange={(e) => set({ autoEnqueue: e.target.checked })} />
            Encolar a los clientes activos automáticamente (1×/día)
          </label>

          {err && <div className="sched-err">{err}</div>}

          <div className="sched-actions">
            <span className="sched-tz">Zona: {cfg.tz}</span>
            <button className="btn" onClick={guardar} disabled={saving}>{saving ? 'Guardando…' : 'Guardar'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
