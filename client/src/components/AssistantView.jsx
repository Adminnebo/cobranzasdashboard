import { useEffect, useRef, useState } from 'react';
import { askAI, fetchChatHistory, clearChatHistory } from '../api';
import { renderMd } from '../md';

const EJEMPLOS = [
  '¿Quiénes son los 10 clientes que más deben y cuánto suman?',
  '¿Cuántos clientes superan su línea de crédito y por cuánto?',
  'Si recuperamos el 40% de la deuda vencida, ¿cuánto entra y de quiénes conviene empezar?',
  'Proyecta la deuda total a 30 días si la tendencia actual continúa.',
  'Agrupa la deuda vencida por severidad y dame un plan de cobro priorizado.',
  '¿Qué clientes tienen crédito alto pero poca deuda (oportunidad de venta)?',
];

export default function AssistantView() {
  const [q, setQ] = useState('');
  const [thread, setThread] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const endRef = useRef(null);

  // Cargar el chat guardado al entrar.
  useEffect(() => {
    fetchChatHistory()
      .then((r) => setThread((r.thread || []).map((m) => ({ q: m.q, a: m.a, meta: m.meta }))))
      .catch(() => {});
  }, []);

  const limpiar = async () => {
    if (!window.confirm('¿Borrar el historial del chat?')) return;
    setThread([]);
    try { await clearChatHistory(); } catch (e) {}
  };

  const send = async (question) => {
    const text = (question ?? q).trim();
    if (!text || loading) return;
    setError(null);
    setLoading(true);
    setQ('');
    const entry = { q: text, a: null, meta: null };
    setThread((t) => [...t, entry]);
    try {
      const res = await askAI(text);
      setThread((t) => t.map((e, i) => (i === t.length - 1 ? { ...e, a: res.answer, meta: res } : e)));
    } catch (err) {
      setError(err.message);
      setThread((t) => t.map((e, i) => (i === t.length - 1 ? { ...e, a: `Error: ${err.message}` } : e)));
    } finally {
      setLoading(false);
      setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), 60);
    }
  };

  const onKey = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  };

  return (
    <div>
      <div className="asst-head">
        <div className="section-title" style={{ margin: '8px 0' }}>Asistente IA · pregunta o proyecta sobre tu cartera</div>
        {thread.length > 0 && (
          <button className="mini-btn danger" onClick={limpiar}>🗑 Limpiar chat</button>
        )}
      </div>

      {thread.length === 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <h3>Pregúntale a la IA sobre tus datos</h3>
          <div className="card-sub">Busca, calcula y proyecta usando la cartera de clientes, llamadas e histórico. Prueba con:</div>
          <div className="chips">
            {EJEMPLOS.map((ex, i) => (
              <button key={i} className="chip" onClick={() => send(ex)}>{ex}</button>
            ))}
          </div>
        </div>
      )}

      <div className="thread">
        {thread.map((e, i) => (
          <div key={i} className="qa">
            <div className="qa-q"><span className="qa-badge">Tú</span>{e.q}</div>
            <div className="qa-a">
              <span className="qa-badge ai">IA</span>
              {e.a === null ? (
                <span className="qa-typing"><span className="spinner sm" />Analizando la cartera…</span>
              ) : (
                <div className="md" dangerouslySetInnerHTML={{ __html: renderMd(e.a) }} />
              )}
              {e.meta && e.meta.usage && (
                <div className="qa-meta">
                  {e.meta.model} · {e.meta.usage.total_tokens} tokens · ${(e.meta.costUsd || 0).toFixed(4)}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {error && <div style={{ color: 'var(--critical)', fontSize: '0.85rem', margin: '8px 2px' }}>{error}</div>}

      <div className="ask-bar">
        <textarea
          className="ask-input"
          rows={2}
          placeholder="Escribe tu pregunta… (Enter para enviar, Shift+Enter para salto de línea)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          disabled={loading}
        />
        <button className="btn" onClick={() => send()} disabled={loading || !q.trim()}>
          {loading ? 'Pensando…' : 'Preguntar'}
        </button>
      </div>
    </div>
  );
}
