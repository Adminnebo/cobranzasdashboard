import { useEffect, useState } from 'react';
import { fetchCorreoHilo, abrirAdjuntoCorreo } from '../api';
import { fmtFechaCorreo, esRebote } from '../correos';

const VISIBLE = /^(application\/pdf|image\/(png|jpe?g|gif|webp)|text\/plain)$/;

/** Un adjunto: al pulsarlo se abre (PDF, imagen) o se descarga. */
function Adjunto({ hilo, mensaje, a }) {
  const [estado, setEstado] = useState(null); // null | 'bajando' | mensaje de error
  if (!a.parte) return <span className="hilo__adjunto">📎 {a.nombre}{a.bytes ? ` · ${kb(a.bytes)}` : ''}</span>;
  const abrir = () => {
    // La pestaña se abre ya (en el clic) para que el navegador no la bloquee; se llena al bajar.
    const ventana = VISIBLE.test(a.tipo || '') ? window.open('', '_blank') : null;
    setEstado('bajando');
    abrirAdjuntoCorreo(hilo, mensaje, a.parte, a.nombre, ventana).then(
      () => setEstado(null),
      (e) => { if (ventana) ventana.close(); setEstado(e.message || 'No se pudo abrir'); },
    );
  };
  return (
    <button type="button" className="hilo__adjunto hilo__adjunto--btn" onClick={abrir} disabled={estado === 'bajando'}
      title={VISIBLE.test(a.tipo || '') ? 'Abrir el adjunto' : 'Descargar el adjunto'}>
      📎 {a.nombre}{a.bytes ? ` · ${kb(a.bytes)}` : ''}
      {estado === 'bajando' && ' · abriendo…'}
      {estado && estado !== 'bajando' && <span className="hilo__adjunto-error"> · {estado}</span>}
    </button>
  );
}

const kb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/**
 * Un correo enviado desplegado: el hilo completo (lo que mandamos y lo que contestó el cliente).
 * El HTML ya viene limpio del servicio (sin scripts, estilos, imágenes ni lo citado).
 */
export default function HiloCorreo({ correo }) {
  const [estado, setEstado] = useState({ cargando: !!correo.hilo, mensajes: null, error: null });
  useEffect(() => {
    if (!correo.hilo) return undefined;
    let vivo = true;
    setEstado({ cargando: true, mensajes: null, error: null });
    fetchCorreoHilo(correo.hilo).then(
      (r) => vivo && setEstado({ cargando: false, mensajes: r.mensajes || [], error: null }),
      (e) => vivo && setEstado({ cargando: false, mensajes: null, error: e.message || 'No se pudo abrir el correo.' }),
    );
    return () => { vivo = false; };
  }, [correo.hilo]);

  if (!correo.hilo) {
    return (
      <div className="hilo hilo--vacio">
        Enviado a <b>{(correo.para || []).join(', ') || '—'}</b>{correo.asunto ? <> · «{correo.asunto}»</> : null}.
        <div className="hilo__nota">El contenido y las respuestas se ven cuando el panel puede leer el buzón.</div>
      </div>
    );
  }
  if (estado.cargando) return <div className="hilo hilo--vacio">Abriendo el correo…</div>;
  if (estado.error) return <div className="hilo hilo--vacio hilo--error">{estado.error}</div>;

  return (
    <div className="hilo">
      {estado.mensajes.map((m) => {
        const esEste = m.id === correo.id;
        // Del cliente se muestra el texto (sin lo citado); lo nuestro, con su formato.
        const usarTexto = !m.mio && m.texto;
        const rebote = esRebote(m);
        const tipo = m.mio ? 'mio' : rebote ? 'rebote' : 'cliente';
        return (
          <div key={m.id} className={`hilo__msg hilo__msg--${tipo} ${esEste ? 'hilo__msg--este' : ''}`}>
            <div className="hilo__cab">
              <span className={`hilo__quien hilo__quien--${tipo}`}>{m.mio ? '📤 Enviado' : rebote ? '❌ No se entregó' : '↩ Respuesta del cliente'}</span>
              <span className="hilo__de" title={m.de}>{m.mio ? `a ${(m.para || []).join(', ')}` : m.de}</span>
              <span className="hilo__fecha">{fmtFechaCorreo(m.fecha)}</span>
            </div>
            {m.asunto && <div className="hilo__asunto">{m.asunto}</div>}
            {usarTexto
              ? <div className="hilo__cuerpo hilo__cuerpo--texto">{m.texto}</div>
              : m.html
                ? <div className="hilo__cuerpo" dangerouslySetInnerHTML={{ __html: m.html }} />
                : <div className="hilo__cuerpo hilo__cuerpo--texto">{m.texto || m.extracto || '(sin contenido)'}</div>}
            {m.adjuntos && m.adjuntos.length > 0 && (
              <div className="hilo__adjuntos">
                {m.adjuntos.map((a, i) => <Adjunto key={i} hilo={correo.hilo} mensaje={m.id} a={a} />)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
