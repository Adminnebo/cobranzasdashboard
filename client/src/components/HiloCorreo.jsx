import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { fetchCorreoHilo, bajarAdjuntoCorreo } from '../api';
import { fmtFechaCorreo, esRebote } from '../correos';
import { EtiquetaIA } from './EmailsTable';

const ES_IMAGEN = /^image\/(png|jpe?g|gif|webp|bmp)$/;
const ES_PDF = /^application\/pdf$/;
const MAX_PREVIA = 15 * 1024 * 1024; // más pesado que esto, solo se descarga a pedido

const descargar = (url, nombre) => {
  const el = document.createElement('a');
  el.href = url; el.download = nombre || 'adjunto';
  document.body.appendChild(el); el.click(); el.remove();
};

/** El adjunto ampliado, encima del panel. Se cierra con Esc, la ✕ o tocando fuera. */
function Ampliado({ a, url, onCerrar }) {
  useEffect(() => {
    const tecla = (e) => { if (e.key === 'Escape') onCerrar(); };
    document.addEventListener('keydown', tecla);
    const antes = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', tecla); document.body.style.overflow = antes; };
  }, [onCerrar]);
  return createPortal(
    <div className="adj-modal" role="dialog" aria-modal="true" aria-label={a.nombre} onClick={onCerrar}>
      <div className="adj-modal__barra" onClick={(e) => e.stopPropagation()}>
        <span className="adj-modal__nombre">📎 {a.nombre}</span>
        <button type="button" className="mini-btn" onClick={() => descargar(url, a.nombre)}>⬇ Descargar</button>
        <button type="button" className="mini-btn" onClick={onCerrar} aria-label="Cerrar">✕</button>
      </div>
      <div className="adj-modal__cuerpo">
        {ES_PDF.test(a.tipo)
          ? <iframe className="adj-modal__pdf" src={url} title={a.nombre} />
          : <img className="adj-modal__img" src={url} alt={a.nombre} onClick={(e) => e.stopPropagation()} />}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Un adjunto dentro del mensaje: las imágenes en miniatura y los PDF con su vista previa; al
 * pulsarlos se amplían encima del panel. Lo demás (Excel, Word…) se descarga.
 */
function Adjunto({ hilo, mensaje, a }) {
  const tipo = a.tipo || '';
  const previa = !!a.parte && (ES_IMAGEN.test(tipo) || ES_PDF.test(tipo)) && (!a.bytes || a.bytes <= MAX_PREVIA);
  const [url, setUrl] = useState(null);
  const [error, setError] = useState(null);
  const [bajando, setBajando] = useState(false);
  const [grande, setGrande] = useState(false);

  // Las vistas previas se bajan al abrir el hilo; la URL se suelta al cerrarlo.
  useEffect(() => {
    if (!previa) return undefined;
    let vivo = true, creada = null;
    bajarAdjuntoCorreo(hilo, mensaje, a.parte).then(
      (blob) => { if (!vivo) return; creada = URL.createObjectURL(blob); setUrl(creada); },
      (e) => vivo && setError(e.message || 'No se pudo cargar'),
    );
    return () => { vivo = false; if (creada) URL.revokeObjectURL(creada); };
  }, [hilo, mensaje, a.parte, previa]);

  const etiqueta = <>📎 {a.nombre}{a.bytes ? ` · ${kb(a.bytes)}` : ''}</>;

  if (!previa) {
    if (!a.parte) return <span className="hilo__adjunto">{etiqueta}</span>;
    const bajar = () => {
      setBajando(true); setError(null);
      bajarAdjuntoCorreo(hilo, mensaje, a.parte).then((blob) => {
        const u = URL.createObjectURL(blob);
        descargar(u, a.nombre);
        setTimeout(() => URL.revokeObjectURL(u), 60000);
      }, (e) => setError(e.message || 'No se pudo bajar')).finally(() => setBajando(false));
    };
    return (
      <button type="button" className="hilo__adjunto hilo__adjunto--btn" onClick={bajar} disabled={bajando} title="Descargar el adjunto">
        {etiqueta}{bajando && ' · bajando…'}{error && <span className="hilo__adjunto-error"> · {error}</span>}
      </button>
    );
  }

  return (
    <figure className={`adj-previa ${ES_PDF.test(tipo) ? 'adj-previa--pdf' : 'adj-previa--img'}`}>
      <button type="button" className="adj-previa__marco" onClick={() => url && setGrande(true)} disabled={!url} title="Ampliar">
        {error
          ? <span className="adj-previa__nada hilo__adjunto-error">{error}</span>
          : !url
            ? <span className="adj-previa__nada">Cargando…</span>
            : ES_PDF.test(tipo)
              ? <iframe className="adj-previa__pdf" src={`${url}#toolbar=0&navpanes=0&view=FitH`} title={a.nombre} tabIndex={-1} />
              : <img className="adj-previa__img" src={url} alt={a.nombre} />}
        {url && <span className="adj-previa__ampliar">⤢ Ampliar</span>}
      </button>
      <figcaption className="adj-previa__pie">{etiqueta}</figcaption>
      {grande && url && <Ampliado a={a} url={url} onCerrar={() => setGrande(false)} />}
    </figure>
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

  // Las etiquetas de la IA vienen en el resumen de la lista (no en el hilo completo).
  const etiquetas = new Map((correo.mensajes || []).filter((x) => x.etiqueta).map((x) => [x.id, x.etiqueta]));
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
            {!m.mio && !rebote && etiquetas.get(m.id) && <div className="hilo__ia"><EtiquetaIA ia={etiquetas.get(m.id)} conResumen /></div>}
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
