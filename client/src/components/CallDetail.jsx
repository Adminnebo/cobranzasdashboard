/**
 * Detalle de una llamada: reproductor de audio (vía proxy) + resumen +
 * transcripción tipo chat. Reutilizable en Llamadas y en Clientes.
 * `call` = { grabacion, notas, transcripcion }
 */
export default function CallDetail({ call }) {
  if (!call) return null;
  return (
    <div className="call-detail">
      {call.grabacion ? (
        <div className="call-audio">
          <audio controls preload="metadata" src={`/api/recordings/proxy?url=${encodeURIComponent(call.grabacion)}`} style={{ width: '100%' }}>
            Tu navegador no soporta audio. <a href={call.grabacion} target="_blank" rel="noreferrer">Descargar</a>
          </audio>
          <a className="a-link" href={call.grabacion} target="_blank" rel="noreferrer" style={{ fontSize: '0.76rem' }}>Abrir en pestaña ↗</a>
        </div>
      ) : (
        <div style={{ color: 'var(--text-muted)', marginBottom: 12 }}>Sin grabación disponible.</div>
      )}

      {call.notas && (
        <div className="call-notes"><span className="cd-label">Resumen</span>{call.notas}</div>
      )}

      <div className="cd-label">Transcripción</div>
      <Transcript text={call.transcripcion} />
    </div>
  );
}

function Transcript({ text }) {
  if (!text) return <div style={{ color: 'var(--text-muted)' }}>Sin transcripción.</div>;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return (
    <div className="transcript">
      {lines.map((line, i) => {
        const m = line.match(/^(AI|Assistant|Agente|User|Usuario|Cliente)\s*:\s*(.*)$/i);
        const who = m ? m[1].toLowerCase() : null;
        const isAgent = who && /ai|assistant|agente/.test(who);
        const isUser = who && /user|usuario|cliente/.test(who);
        const body = m ? m[2] : line;
        return (
          <div key={i} className={`tr-line ${isAgent ? 'agent' : isUser ? 'user' : 'plain'}`}>
            {(isAgent || isUser) && <span className="tr-who">{isAgent ? 'Agente' : 'Cliente'}</span>}
            <span className="tr-body">{body}</span>
          </div>
        );
      })}
    </div>
  );
}
