import { useEffect, useRef, useState } from 'react';
import { fetchLists, deleteList } from '../api';
import { num } from '../format';

/** Botón "Listas" con dropdown para cargar/eliminar listas de llamadas guardadas. */
export default function ListsPanel({ refreshKey, onLoad }) {
  const [open, setOpen] = useState(false);
  const [lists, setLists] = useState(null);
  const [busy, setBusy] = useState(null);
  const ref = useRef(null);

  const load = () => fetchLists().then((r) => setLists(r.lists || [])).catch(() => setLists([]));
  useEffect(() => { load(); }, [refreshKey]);

  useEffect(() => {
    if (!open) return;
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  const eliminar = async (l) => {
    if (!window.confirm(`¿Eliminar la lista "${l.name}"?`)) return;
    setBusy(l.id);
    try { await deleteList(l.id); await load(); }
    finally { setBusy(null); }
  };

  const cargar = (l) => { onLoad(l.phones || []); setOpen(false); };

  const total = lists ? lists.length : 0;

  return (
    <div className="lists-wrap" ref={ref}>
      <button className="btn secondary" onClick={() => setOpen((o) => !o)}>
        📋 Listas {total > 0 && <span className="tab-count">{total}</span>}
      </button>
      {open && (
        <div className="lists-pop">
          <div className="sched-lbl">Listas de llamadas guardadas</div>
          {!lists && <div className="sched-tz">Cargando…</div>}
          {lists && lists.length === 0 && (
            <div className="sched-tz">Aún no tienes listas. Filtra o selecciona clientes y guárdalos como lista.</div>
          )}
          {lists && lists.map((l) => (
            <div className="list-item" key={l.id}>
              <button className="list-load" onClick={() => cargar(l)} title="Cargar esta lista (selecciona sus clientes)">
                <strong>{l.name}</strong>
                <span className="list-meta">{num(l.count)} cliente(s){l.createdBy ? ` · ${l.createdBy.split('@')[0]}` : ''}</span>
              </button>
              <button className="sched-x" disabled={busy === l.id} onClick={() => eliminar(l)} title="Eliminar lista">✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
