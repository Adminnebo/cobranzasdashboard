import { useEffect, useRef, useState } from 'react';
import { fetchSchedule, saveSchedule } from '../api';
import IaCosto from './IaCosto';

/** Configura el horario de llamadas (bloques). El agente que llama ya guardado se conserva tal cual. */
export default function SchedulePanel({ onSaved, superAdmin = false }) {
  const [open, setOpen] = useState(false);
  const [cfg, setCfg] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const ref = useRef(null);

  const rangoInicial = useRef(null);
  const margenInicial = useRef(null);
  const extrasInicial = useRef(null);
  useEffect(() => {
    fetchSchedule().then((c) => { rangoInicial.current = `${c.horarioClienteDesde}-${c.horarioClienteHasta}`; margenInicial.current = c.followUpMargenDias; extrasInicial.current = JSON.stringify([c.retiroManana, c.retiroTarde, c.horarioAuto]); setCfg(c); }).catch(() => {});
  }, []);

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
    if (cfg.horarioClienteDesde && cfg.horarioClienteHasta && cfg.horarioClienteHasta <= cfg.horarioClienteDesde) {
      setErr('El rango del horario por cliente tiene que terminar después de empezar.'); return;
    }
    // El rango solo se manda si cambió (así no hace falta sql/004 para guardar lo demás).
    const rango = `${cfg.horarioClienteDesde}-${cfg.horarioClienteHasta}` !== rangoInicial.current
      ? { horarioClienteDesde: cfg.horarioClienteDesde, horarioClienteHasta: cfg.horarioClienteHasta }
      : {};
    // Y el margen del follow up (sql/007).
    if (cfg.followUpMargenDias != null && Number(cfg.followUpMargenDias) !== Number(margenInicial.current)) rango.followUpMargenDias = Number(cfg.followUpMargenDias);
    // Retiros y horario automático (sql/008): solo si cambiaron.
    if (JSON.stringify([cfg.retiroManana, cfg.retiroTarde, cfg.horarioAuto]) !== extrasInicial.current) {
      for (const [k, f] of [['retiroManana', cfg.retiroManana], ['retiroTarde', cfg.retiroTarde]]) {
        if (f && f.hasta <= f.desde) { setErr('Las horas de los retiros tienen que terminar después de empezar.'); return; }
        rango[k] = f;
      }
      rango.horarioAuto = cfg.horarioAuto !== false;
    }
    setSaving(true);
    try {
      const saved = await saveSchedule({
        ...rango,
        enabled: cfg.enabled, weekdaysOnly: cfg.weekdaysOnly, autoEnqueue: cfg.autoEnqueue, blocks: cfg.blocks,
        agentId: cfg.agentId || null, agentName: cfg.agentName || null,
        promesaTope: Number(cfg.promesaTope), promesaMaxAtraso: Number(cfg.promesaMaxAtraso), reintentoHoras: Number(cfg.reintentoHoras),
      });
      rangoInicial.current = `${saved.horarioClienteDesde}-${saved.horarioClienteHasta}`;
      margenInicial.current = saved.followUpMargenDias;
      extrasInicial.current = JSON.stringify([saved.retiroManana, saved.retiroTarde, saved.horarioAuto]);
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

          {/* Follow up automático: tope de promesas, atraso máximo y reintentos. */}
          <div className="sched-blocks">
            <div className="sched-lbl">Follow up</div>
            <label className="sched-num">
              <span>Promesas incumplidas seguidas antes de pasar a una persona</span>
              <input type="number" min="1" max="10" value={cfg.promesaTope ?? 3} onChange={(e) => set({ promesaTope: e.target.value })} />
            </label>
            <label className="sched-num">
              <span>Días de atraso máximo para todavía llamar</span>
              <input type="number" min="0" max="60" value={cfg.promesaMaxAtraso ?? 7} onChange={(e) => set({ promesaMaxAtraso: e.target.value })} />
            </label>
            <label className="sched-num">
              <span>Días hábiles después de la fecha prometida para llamar (con 1: si promete el jueves, lo llama el viernes; "pago hoy" → mañana)</span>
              <input type="number" min="1" max="5" value={cfg.followUpMargenDias ?? 1} onChange={(e) => set({ followUpMargenDias: e.target.value })} />
            </label>
            <label className="sched-num">
              <span>Horas para reintentar si no contesta (2.º intento al día siguiente)</span>
              <input type="number" min="1" max="8" value={cfg.reintentoHoras ?? 2} onChange={(e) => set({ reintentoHoras: e.target.value })} />
            </label>
          </div>

          <div className="sched-blocks">
            <div className="sched-lbl">Lo que dice el cliente</div>
            <label className="sched-check" style={{ marginBottom: 8 }}>
              <input type="checkbox" checked={cfg.horarioAuto !== false} onChange={(e) => set({ horarioAuto: e.target.checked })} />
              Ajustar solo el horario propio cuando el cliente da uno ("solo puedo los martes a las 10"). Nunca cambia uno puesto a mano.
            </label>
            <div className="sched-tz" style={{ marginBottom: 6 }}>Retiros: horas de "en la mañana" y "en la tarde"</div>
            {[['retiroManana', 'Mañana', { desde: '08:00', hasta: '12:00' }], ['retiroTarde', 'Tarde', { desde: '14:00', hasta: '18:00' }]].map(([k, lbl, def]) => {
              const f = cfg[k] || def;
              return (
                <div className="sched-block" key={k}>
                  <span style={{ width: 52 }}>{lbl}</span>
                  <input type="time" value={f.desde} onChange={(e) => set({ [k]: { ...f, desde: e.target.value } })} />
                  <span>a</span>
                  <input type="time" value={f.hasta} onChange={(e) => set({ [k]: { ...f, hasta: e.target.value } })} />
                </div>
              );
            })}
          </div>

          {/* Rango dentro del cual puede caer el horario propio de un cliente. */}
          <div className="sched-blocks">
            <div className="sched-lbl">Horario propio de un cliente</div>
            <div className="sched-tz" style={{ marginBottom: 7 }}>
              Un cliente puede tener su propio horario (en Clientes, 🕘). Puede salirse de los bloques de arriba, pero siempre dentro de este rango.
            </div>
            <div className="sched-block">
              <input type="time" value={cfg.horarioClienteDesde || '08:00'} onChange={(e) => set({ horarioClienteDesde: e.target.value })} />
              <span>a</span>
              <input type="time" value={cfg.horarioClienteHasta || '19:00'} onChange={(e) => set({ horarioClienteHasta: e.target.value })} />
            </div>
          </div>

          {/* Costo de la IA y su cobro en Sword: solo super admins. */}
          {superAdmin && <IaCosto />}

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
