import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchSchedule, saveSchedule } from '../api';
import IaCosto from './IaCosto';

// ── Fechas (YYYY-MM-DD, sin zona) ──
const aFecha = (ymd) => new Date(`${ymd}T12:00:00Z`);
const ymdDe = (d) => d.toISOString().slice(0, 10);
const masDias = (ymd, n) => { const d = aFecha(ymd); d.setUTCDate(d.getUTCDate() + n); return ymdDe(d); };
const finde = (ymd) => { const w = aFecha(ymd).getUTCDay(); return w === 0 || w === 6; };
const masHabiles = (ymd, n) => { let d = ymd; let f = n; while (f > 0) { d = masDias(d, 1); if (!finde(d)) f--; } return d; };
const diaCorto = (ymd) => aFecha(ymd).toLocaleDateString('es-DO', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const num = (v, def) => (v === '' || v == null || Number.isNaN(Number(v)) ? def : Number(v));

/**
 * Simula el follow up de una promesa con los ajustes actuales (igual que el motor):
 * primer follow up = fecha prometida + margen (hábiles); ventana de N días de
 * calendario; el primer día 1 + reintentos; después una llamada cada K días. Una
 * llamada que cae en fin de semana (si solo se llama L–V) sale el lunes.
 */
export function ejemploFollowUp(cfg, hoy = new Date()) {
  const margen = Math.max(1, num(cfg.followUpMargenDias, 1));
  const ventana = Math.max(1, num(cfg.fuVentanaDias, 7));
  const cada = Math.max(1, num(cfg.fuCadaDias, 1));
  const reintentos = Math.max(0, num(cfg.fuReintentosDia1, 1));
  // Ejemplo: promete pagar el próximo lunes.
  let promete = ymdDe(new Date(Date.UTC(hoy.getFullYear(), hoy.getMonth(), hoy.getDate())));
  do { promete = masDias(promete, 1); } while (aFecha(promete).getUTCDay() !== 1);
  const desde = masHabiles(promete, margen);
  const hasta = masDias(desde, ventana - 1);
  const llamadas = [{ ymd: desde, n: 1 + reintentos }];
  let cursor = desde;
  for (;;) {
    let sig = masDias(cursor, cada);
    if (cfg.weekdaysOnly !== false) while (finde(sig)) sig = masDias(sig, 1);
    if (sig > hasta) break;
    llamadas.push({ ymd: sig, n: 1 });
    cursor = sig;
  }
  return { promete, desde, hasta, vuelve: masDias(hasta, 1), llamadas, total: llamadas.reduce((s, l) => s + l.n, 0) };
}

const PESTANAS = [
  { id: 'horario', label: 'Horario' },
  { id: 'fu', label: 'Follow up' },
  { id: 'cliente', label: 'Lo que dice el cliente' },
  { id: 'costo', label: 'Costo de la IA', soloSuper: true },
];

// Ajustes que necesitan un SQL propio: solo se mandan si cambiaron (así guardar
// lo demás funciona aunque falte ese SQL).
const OPCIONALES = ['followUpMargenDias', 'fuVentanaDias', 'fuReintentosDia1', 'fuSinFechaMismoDia', 'fuCadaDias', 'retiroManana', 'retiroTarde', 'horarioAuto', 'horarioClienteDesde', 'horarioClienteHasta'];

function Fila({ titulo, ayuda, children, nuevo }) {
  return (
    <div className={`aj-fila ${nuevo ? 'aj-fila--nuevo' : ''}`}>
      <div className="aj-fila__txt"><b>{titulo}</b>{ayuda && <small>{ayuda}</small>}</div>
      <div className="aj-fila__ctl">{children}</div>
    </div>
  );
}

/** "⚙ Ajustes de llamadas": horario, follow up, lo que dice el cliente y costo de la IA. */
export default function SchedulePanel({ onSaved, superAdmin = false }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('horario');
  const [cfg, setCfg] = useState(null);
  const [inicial, setInicial] = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  useEffect(() => { fetchSchedule().then((c) => { setCfg(c); setInicial(c); }).catch(() => {}); }, []);
  useEffect(() => {
    if (!open) return undefined;
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [open]);

  const ej = useMemo(() => (cfg ? ejemploFollowUp(cfg) : null), [cfg]);
  if (!cfg) return null;

  const set = (patch) => setCfg((c) => ({ ...c, ...patch }));
  const setBlock = (i, k, v) => set({ blocks: cfg.blocks.map((b, j) => (j === i ? { ...b, [k]: v } : b)) });
  const cambio = JSON.stringify(cfg) !== JSON.stringify(inicial);

  const cerrar = () => {
    if (cambio && !window.confirm('Hay cambios sin guardar. ¿Cerrar igual?')) return;
    setCfg(inicial); setErr(null); setOpen(false);
  };

  const guardar = async () => {
    setErr(null);
    for (const b of cfg.blocks) {
      if (!b.start || !b.end || b.end <= b.start) { setErr('Horario: cada bloque tiene que terminar después de empezar.'); setTab('horario'); return; }
    }
    if (cfg.enabled && !cfg.blocks.length) { setErr('Horario: agrega al menos un bloque.'); setTab('horario'); return; }
    if (cfg.horarioClienteHasta <= cfg.horarioClienteDesde) { setErr('Horario: el rango del horario propio tiene que terminar después de empezar.'); setTab('horario'); return; }
    for (const k of ['retiroManana', 'retiroTarde']) {
      const f = cfg[k];
      if (f && f.hasta <= f.desde) { setErr('Lo que dice el cliente: las horas de los retiros tienen que terminar después de empezar.'); setTab('cliente'); return; }
    }
    const body = {
      enabled: cfg.enabled, weekdaysOnly: cfg.weekdaysOnly, autoEnqueue: cfg.autoEnqueue, blocks: cfg.blocks,
      agentId: cfg.agentId || null, agentName: cfg.agentName || null,
      promesaTope: num(cfg.promesaTope, 3), reintentoHoras: num(cfg.reintentoHoras, 2),
    };
    for (const k of OPCIONALES) {
      if (JSON.stringify(cfg[k]) === JSON.stringify(inicial[k])) continue;
      body[k] = typeof inicial[k] === 'number' ? num(cfg[k], inicial[k]) : cfg[k];
    }
    setSaving(true);
    try {
      const saved = await saveSchedule(body);
      setCfg(saved); setInicial(saved);
      setOpen(false);
      if (onSaved) onSaved();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const resumen = cfg.enabled
    ? `${cfg.blocks.map((b) => `${b.start}–${b.end}`).join(', ')}${cfg.weekdaysOnly ? ' · L-V' : ''}`
    : 'Llamadas apagadas';

  return (
    <div className="sched-wrap">
      <button className={`btn secondary sched-btn ${cfg.enabled ? 'on' : ''}`} onClick={() => setOpen(true)}>
        ⚙ Ajustes de llamadas <span className="sched-summary">{resumen}</span>
      </button>

      {open && createPortal(
        <div className="pagos-modal" onMouseDown={(e) => { if (e.target === e.currentTarget) cerrar(); }}>
          <div className="pagos-modal__box aj-modal" role="dialog" aria-label="Ajustes de llamadas">
            <div className="pagos-modal__bar">
              <span>Ajustes de llamadas</span>
              <button className="mini-btn" onClick={cerrar}>Cerrar</button>
            </div>
            <div className="aj-tabs" role="tablist">
              {PESTANAS.filter((p) => !p.soloSuper || superAdmin).map((p) => (
                <button key={p.id} role="tab" aria-selected={tab === p.id} className={tab === p.id ? 'on' : ''} onClick={() => setTab(p.id)}>{p.label}</button>
              ))}
            </div>

            <div className="aj-body">
              {tab === 'horario' && (
                <>
                  <div className="aj-grupo">
                    <h4>Llamadas</h4>
                    <Fila titulo="Llamadas automáticas" ayuda="Apagado, el sistema no llama a nadie (ni el follow up).">
                      <input type="checkbox" checked={cfg.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
                    </Fila>
                    <Fila titulo="Encolar a los clientes activos 1 vez al día" ayuda="Los prendidos con vencido entran solos a la cola al abrir el horario.">
                      <input type="checkbox" checked={cfg.autoEnqueue} onChange={(e) => set({ autoEnqueue: e.target.checked })} />
                    </Fila>
                  </div>
                  <div className="aj-grupo">
                    <h4>Cuándo se llama</h4>
                    {cfg.blocks.map((b, i) => (
                      <div className="sched-block" key={i}>
                        <input type="time" value={b.start} onChange={(e) => setBlock(i, 'start', e.target.value)} />
                        <span>a</span>
                        <input type="time" value={b.end} onChange={(e) => setBlock(i, 'end', e.target.value)} />
                        <button className="sched-x" onClick={() => set({ blocks: cfg.blocks.filter((_, j) => j !== i) })} disabled={cfg.blocks.length <= 1} title="Quitar bloque">✕</button>
                      </div>
                    ))}
                    <div><button className="mini-btn" onClick={() => set({ blocks: [...cfg.blocks, { start: '14:00', end: '17:00' }] })}>+ Agregar bloque</button></div>
                    <Fila titulo="Solo de lunes a viernes">
                      <input type="checkbox" checked={cfg.weekdaysOnly} onChange={(e) => set({ weekdaysOnly: e.target.checked })} />
                    </Fila>
                  </div>
                  <div className="aj-grupo">
                    <h4>Horario propio de un cliente</h4>
                    <Fila titulo="Rango permitido" ayuda="Un cliente puede tener su propio horario (🕘 en Clientes). Puede salirse de los bloques de arriba, pero nunca de este rango.">
                      <input type="time" value={cfg.horarioClienteDesde || '08:00'} onChange={(e) => set({ horarioClienteDesde: e.target.value })} />
                      <span>a</span>
                      <input type="time" value={cfg.horarioClienteHasta || '19:00'} onChange={(e) => set({ horarioClienteHasta: e.target.value })} />
                    </Fila>
                  </div>
                </>
              )}

              {tab === 'fu' && (
                <>
                  <div className="aj-grupo">
                    <h4>Cuándo empieza</h4>
                    <Fila titulo="Primera llamada de follow up" ayuda={'Días hábiles después de la fecha que prometió. "Pago hoy" cuenta desde hoy.'}>
                      <input type="number" min="1" max="5" value={cfg.followUpMargenDias ?? 1} onChange={(e) => set({ followUpMargenDias: e.target.value })} />
                      <span>días hábiles</span>
                    </Fila>
                  </div>
                  <div className="aj-grupo">
                    <h4>Cómo insiste</h4>
                    <Fila titulo="El primer día, si no contesta" ayuda="Reintentos además de la primera llamada, solo si todavía queda horario ese día.">
                      <input type="number" min="0" max="6" value={cfg.fuReintentosDia1 ?? 1} onChange={(e) => set({ fuReintentosDia1: e.target.value })} />
                      <span>reintentos, cada</span>
                      <input type="number" min="1" max="8" value={cfg.reintentoHoras ?? 2} onChange={(e) => set({ reintentoHoras: e.target.value })} />
                      <span>h</span>
                    </Fila>
                    <Fila titulo="El primer día, si contesta sin dar fecha">
                      <select value={cfg.fuSinFechaMismoDia ? 'mismo' : 'siguiente'} onChange={(e) => set({ fuSinFechaMismoDia: e.target.value === 'mismo' })}>
                        <option value="siguiente">lo vuelve a llamar otro día</option>
                        <option value="mismo">reintenta ese mismo día</option>
                      </select>
                    </Fila>
                    <Fila titulo="Los días siguientes" ayuda="Una llamada por día que le toca, conteste o no, hasta que dé una fecha nueva.">
                      <span>una llamada cada</span>
                      <input type="number" min="1" max="7" value={cfg.fuCadaDias ?? 1} onChange={(e) => set({ fuCadaDias: e.target.value })} />
                      <span>día(s)</span>
                    </Fila>
                    <Fila titulo="Días que el follow up intenta antes de volver al agente principal de cobranzas" ayuda="Días de calendario desde la primera llamada de follow up. Una fecha nueva los reinicia.">
                      <input type="number" min="1" max="30" value={cfg.fuVentanaDias ?? 7} onChange={(e) => set({ fuVentanaDias: e.target.value })} />
                      <span>días</span>
                    </Fila>
                  </div>
                  <div className="aj-grupo">
                    <h4>Cuándo pasa a una persona</h4>
                    <Fila titulo="Promesas seguidas sin cumplir" ayuda="En la última: si da otra fecha o se acaba su ventana, pasa a 🙋 Por atender.">
                      <input type="number" min="1" max="10" value={cfg.promesaTope ?? 3} onChange={(e) => set({ promesaTope: e.target.value })} />
                      <span>promesas</span>
                    </Fila>
                  </div>
                  {ej && (
                    <div className="aj-ejemplo" aria-live="polite">
                      <div><b>Ejemplo:</b> si promete pagar el {diaCorto(ej.promete)} y no da una fecha nueva…</div>
                      <ol>
                        {ej.llamadas.map((l) => (
                          <li key={l.ymd}><span>{diaCorto(l.ymd)}</span>{l.n > 1 ? <em>hasta {l.n} llamadas</em> : <em>1 llamada</em>}</li>
                        ))}
                        <li className="fin"><span>{diaCorto(ej.vuelve)}</span><em>vuelve al agente principal</em></li>
                      </ol>
                      <div className="aj-ejemplo__tot">Hasta {ej.total} llamadas de follow up por promesa. Cada llamada gasta minutos en Sword.</div>
                    </div>
                  )}
                </>
              )}

              {tab === 'cliente' && (
                <>
                  <div className="aj-grupo">
                    <h4>Horario que da el cliente</h4>
                    <Fila titulo="Ajustar solo el horario propio" ayuda={'Cuando el cliente dice un horario que se repite ("solo puedo los martes a las 10"). Nunca cambia uno puesto a mano.'}>
                      <input type="checkbox" checked={cfg.horarioAuto === true} onChange={(e) => set({ horarioAuto: e.target.checked })} />
                    </Fila>
                  </div>
                  <div className="aj-grupo">
                    <h4>Retiros</h4>
                    {[['retiroManana', '"En la mañana"', { desde: '08:00', hasta: '12:00' }], ['retiroTarde', '"En la tarde"', { desde: '14:00', hasta: '18:00' }]].map(([k, lbl, def]) => {
                      const f = cfg[k] || def;
                      return (
                        <Fila key={k} titulo={lbl} ayuda="Horas que se anotan cuando pide que pasen a buscar el pago en esa franja.">
                          <input type="time" value={f.desde} onChange={(e) => set({ [k]: { ...f, desde: e.target.value } })} />
                          <span>a</span>
                          <input type="time" value={f.hasta} onChange={(e) => set({ [k]: { ...f, hasta: e.target.value } })} />
                        </Fila>
                      );
                    })}
                  </div>
                </>
              )}

              {tab === 'costo' && superAdmin && <IaCosto />}
            </div>

            {tab !== 'costo' && (
              <div className="aj-pie">
                <span className="sched-tz">Zona: {cfg.tz}{cambio ? ' · hay cambios sin guardar' : ''}</span>
                {err && <span className="sched-err">{err}</span>}
                <button className="btn" onClick={guardar} disabled={saving || !cambio}>{saving ? 'Guardando…' : 'Guardar'}</button>
              </div>
            )}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
