import { useEffect, useRef, useState } from 'react';
import { correoEstado, correoSesion, correoDesconectar } from '../api';

// Tarjeta "Conectar Gmail" de Nebo AI (embed.js de correo-servicio). Las tres llamadas van a
// nuestro servidor, que es quien guarda la clave del servicio.
function cargarScript(src) {
  if (window.NeboCorreo) return Promise.resolve(window.NeboCorreo);
  return new Promise((ok, mal) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => (window.NeboCorreo ? ok(window.NeboCorreo) : mal(new Error('El botón de correo no cargó.')));
    s.onerror = () => mal(new Error('No se pudo cargar el botón de correo.'));
    document.head.appendChild(s);
  });
}

export default function CorreoPanel({ embed }) {
  const caja = useRef(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let montado = null;
    let vivo = true;
    cargarScript(embed).then((NeboCorreo) => {
      if (!vivo || !caja.current) return;
      montado = NeboCorreo.montar(caja.current, {
        estado: correoEstado,
        sesion: correoSesion,
        desconectar: correoDesconectar,
        titulo: 'Correo para cobranzas',
        descripcion: 'Conecta el Gmail desde el que saldrán los correos de cobranza. Solo se pide permiso para enviar: Nebo AI no lee tu buzón.',
      });
    }).catch((e) => vivo && setError(e.message));
    return () => { vivo = false; if (montado) montado.desmontar(); };
  }, [embed]);

  return (
    <div className="card">
      {error ? <p style={{ color: 'var(--danger, #dc2626)' }}>{error}</p> : <div ref={caja} />}
    </div>
  );
}
