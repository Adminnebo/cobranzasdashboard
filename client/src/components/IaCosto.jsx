import { useEffect, useState } from 'react';
import { fetchIaConsumo, saveIaConfig, resolverCobroIa } from '../api';

const usd = (n, d = 2) => `US$ ${Number(n || 0).toFixed(d)}`;
const dia = (ymd) => (ymd ? new Date(`${String(ymd).slice(0, 10)}T12:00:00Z`).toLocaleDateString('es-DO', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
const ESTADO = {
  pendiente: ['por enviar', 'var(--text-muted)'],
  enviando: ['enviando… (si se queda así, revisar en Sword)', 'var(--warning)'],
  reintentar: ['no llegó, se reintenta solo', 'var(--warning)'],
  enviado: ['✓ en Sword', 'var(--good-ink)'],
  revisar: ['⚠ revisar en Sword', 'var(--critical)'],
};

/**
 * Lo que cuesta la IA que lee las llamadas (retiros, hora pedida, horario) y su
 * cobro en Sword. Solo super admins. Precios y ganancia se editan aquí.
 */
export default function IaCosto() {
  const [d, setD] = useState(null);
  const [form, setForm] = useState(null);
  const [err, setErr] = useState(null);
  const [saving, setSaving] = useState(false);

  const aplicar = (r) => {
    setD(r);
    setForm({ ...r.config });
  };
  useEffect(() => { fetchIaConsumo().then(aplicar).catch((e) => setErr(e.message)); }, []);

  if (err && !d) return <div className="sched-blocks"><div className="sched-lbl">Costo de la IA</div><div className="sched-err">{err}</div></div>;
  if (!d || !form) return <div className="sched-blocks"><div className="sched-lbl">Costo de la IA</div><div className="sched-tz">Cargando…</div></div>;

  const set = (p) => setForm((f) => ({ ...f, ...p }));
  const cambio = ['precioEntrada', 'precioCache', 'precioSalida', 'margenPct', 'cobrarSword'].some((k) => String(form[k]) !== String(d.config[k]));
  const guardar = async () => {
    if (form.cobrarSword && !d.config.cobrarSword && !window.confirm(
      `Prender el cobro en Sword\n\nCada día se descuenta del saldo del cliente ${d.sword.cliente || ''} lo que costó la IA el día anterior` +
      `${Number(form.margenPct) ? ` más ${form.margenPct}% de ganancia` : ' (al costo, sin ganancia)'}.` +
      `${d.sinCobrar && d.sinCobrar.costo > 0 ? `\n\nTambién se cobra lo acumulado sin cobrar desde el ${dia(d.desde)} (${usd(d.sinCobrar.costo, 4)} de costo).` : ''}\n\n¿Continuar?`)) return;
    setSaving(true); setErr(null);
    try {
      aplicar(await saveIaConfig({
        precioEntrada: Number(form.precioEntrada), precioCache: Number(form.precioCache), precioSalida: Number(form.precioSalida),
        margenPct: Number(form.margenPct), cobrarSword: !!form.cobrarSword,
      }));
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };
  const resolver = async (c, accion) => {
    const txt = accion === 'reintentar'
      ? `¿Mandar de nuevo el cobro de ${usd(c.monto)}?\n\nHazlo solo si en Sword NO aparece: si ya se aplicó, se cobraría dos veces.`
      : `¿Dar por hecho el cobro de ${usd(c.monto)}?\n\nHazlo si en Sword ya aparece descontado.`;
    if (!window.confirm(txt)) return;
    setErr(null);
    try { aplicar(await resolverCobroIa(c.id, accion)); } catch (e) { setErr(e.message); }
  };

  return (
    <div className="sched-blocks">
      <div className="sched-lbl">Costo de la IA que lee las llamadas</div>
      {d.sinTabla && <div className="sched-err">Falta correr sql/009 en Supabase: el gasto no se está registrando.</div>}
      {!d.claveIa && <div className="sched-err">Falta OPENAI_API_KEY_FICHAS en el servidor: la lectura de llamadas está en pausa.</div>}

      {!d.sinTabla && (
        <div className="ia-costo__nums">
          <div><b>{usd(d.hoy.costo, 4)}</b><span>hoy · {d.hoy.llamadas} llamadas</span></div>
          <div><b>{usd(d.mes.costo, 4)}</b><span>este mes · {d.mes.llamadas} llamadas</span></div>
          <div><b>{usd(d.sinCobrar.costo, 4)}</b><span>sin cobrar{d.desde ? ` desde ${dia(d.desde)}` : ''}</span></div>
        </div>
      )}

      <div className="sched-tz" style={{ margin: '8px 0 4px' }}>Modelo {d.modelo} · precio en US$ por millón de tokens</div>
      <div className="ia-costo__precios">
        <label><span>Entrada</span><input type="number" min="0" step="0.001" value={form.precioEntrada} onChange={(e) => set({ precioEntrada: e.target.value })} /></label>
        <label><span>En caché</span><input type="number" min="0" step="0.001" value={form.precioCache} onChange={(e) => set({ precioCache: e.target.value })} /></label>
        <label><span>Salida</span><input type="number" min="0" step="0.001" value={form.precioSalida} onChange={(e) => set({ precioSalida: e.target.value })} /></label>
      </div>
      <label className="sched-num">
        <span>Ganancia sobre el costo al cobrar (%)</span>
        <input type="number" min="0" max="500" value={form.margenPct} onChange={(e) => set({ margenPct: e.target.value })} />
      </label>
      <label className="sched-check">
        <input type="checkbox" checked={!!form.cobrarSword} disabled={!d.sword.listo && !form.cobrarSword} onChange={(e) => set({ cobrarSword: e.target.checked })} />
        Cobrar en Sword (un cobro por día, con lo del día anterior{d.sword.cliente ? `, cliente ${d.sword.cliente}` : ''})
      </label>
      {!d.sword.listo && <div className="sched-tz" style={{ color: 'var(--warning)' }}>Para cobrar falta en el servidor: {d.sword.faltan.join(', ')}.</div>}

      {d.cobros && d.cobros.length > 0 && (
        <div className="ia-costo__cobros">
          {d.cobros.map((c) => {
            const [txt, color] = ESTADO[c.estado] || [c.estado, 'var(--text-muted)'];
            return (
              <div key={c.id} className="ia-costo__cobro" title={c.respuesta || ''}>
                <span>{c.desde && c.desde !== c.dia ? `${dia(c.desde)}–${dia(c.dia)}` : dia(c.dia)}</span>
                <b>{usd(c.monto)}</b>
                <span style={{ color }}>{txt}</span>
                {(c.estado === 'revisar' || c.estado === 'enviando') && (
                  <span className="ia-costo__acc">
                    <button className="mini-btn" onClick={() => resolver(c, 'hecho')}>Ya está en Sword</button>
                    <button className="mini-btn" onClick={() => resolver(c, 'reintentar')}>Mandar de nuevo</button>
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="sched-tz" style={{ marginTop: 6 }}>
        Cuenta solo la lectura de llamadas (retiros, hora pedida, horario), que usa su propia llave. Cada llamada se lee una sola vez.
        No incluye el respaldo de promesas ni "Re-analizar", que usan otra llave. Si un día cuesta menos de un centavo, se cobra junto con el siguiente.
      </div>
      {err && <div className="sched-err">{err}</div>}
      {cambio && (
        <div style={{ marginTop: 8, textAlign: 'right' }}>
          <button className="btn" disabled={saving} onClick={guardar}>{saving ? 'Guardando…' : 'Guardar costo'}</button>
        </div>
      )}
    </div>
  );
}
