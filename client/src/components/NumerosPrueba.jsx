import { useEffect, useRef, useState } from 'react';
import { fetchPruebas, addPrueba, removePrueba } from '../api';

/**
 * Lista de números de prueba. Solo se dibuja si el servidor la entrega
 * (super admins); para el resto la petición da 403 y el botón no aparece.
 */
export default function NumerosPrueba({ onChanged }) {
  const [numeros, setNumeros] = useState(null);
  const [open, setOpen] = useState(false);
  const [tel, setTel] = useState('');
  const [nota, setNota] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);

  useEffect(() => { fetchPruebas().then((r) => setNumeros(r.numeros || [])).catch(() => setNumeros(null)); }, []);
  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  if (numeros === null) return null;

  const run = async (fn) => {
    setErr(null); setBusy(true);
    try { const r = await fn(); setNumeros(r.numeros || []); if (onChanged) onChanged(); return true; }
    catch (e) { setErr(e.message); return false; }
    finally { setBusy(false); }
  };
  const agregar = async () => { if (await run(() => addPrueba(tel, nota))) { setTel(''); setNota(''); } };

  return (
    <div className="sched-wrap" ref={ref}>
      <button className="chip sm" onClick={() => setOpen((o) => !o)} title="Las llamadas a estos números no cuentan y solo las ven los super admins">
        🧪 Números de prueba ({numeros.length})
      </button>
      {open && (
        <div className="sched-pop">
          <div className="sched-lbl">Números de prueba</div>
          <div className="sched-tz">Sus llamadas no cuentan en métricas ni promesas, y solo las ven los super admins.</div>
          {numeros.length === 0 && <div className="sched-tz">Sin números.</div>}
          {numeros.map((n) => (
            <div key={n.phone} className="sched-block">
              <span style={{ fontWeight: 600 }}>{n.phone}</span>
              <span className="sched-tz" style={{ flex: 1 }}>{n.nota || ''}</span>
              <button className="chip sm" disabled={busy} onClick={() => run(() => removePrueba(n.phone))}>Quitar</button>
            </div>
          ))}
          <div className="sched-block">
            <input className="search" placeholder="Teléfono" value={tel} onChange={(e) => setTel(e.target.value)} style={{ width: 130 }} />
            <input className="search" placeholder="Nota (opcional)" value={nota} onChange={(e) => setNota(e.target.value)} style={{ flex: 1 }} />
            <button className="btn" disabled={busy || !tel.trim()} onClick={agregar}>Agregar</button>
          </div>
          {err && <div className="sched-err">{err}</div>}
        </div>
      )}
    </div>
  );
}
