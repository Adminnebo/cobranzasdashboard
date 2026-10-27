import { useEffect, useRef, useState } from 'react';
import { correoEstado, correoSesion, correoDesconectar, correoPlantilla, guardarCorreoPlantilla } from '../api';

// Pestaña Correo: la tarjeta "Conectar Gmail / Outlook" y el editor de la plantilla del correo de
// cobranza, los dos de Nebo AI (embed.js de correo-servicio). Todas las llamadas van a nuestro
// servidor, que es quien guarda la clave del servicio.

// Campos que n8n manda en `datos` al enviar (ya formateados). El ejemplo se ve en la vista previa.
const CAMPOS = [
  { clave: 'nombre', etiqueta: 'Nombre', ejemplo: 'Juan Pérez' },
  { clave: 'deuda_total', etiqueta: 'Deuda total', ejemplo: 'RD$ 48,300.00' },
  { clave: 'deuda_vencida', etiqueta: 'Deuda vencida', ejemplo: 'RD$ 12,500.00' },
  { clave: 'dias_mora', etiqueta: 'Días de mora', ejemplo: '15' },
  { clave: 'credito_ofrecido', etiqueta: 'Crédito ofrecido', ejemplo: 'RD$ 20,000.00' },
  { clave: 'ultimo_pago', etiqueta: 'Último pago', ejemplo: '02/10/2026' },
  { clave: 'fecha_promesa', etiqueta: 'Fecha prometida', ejemplo: '30/10/2026' },
  { clave: 'telefono', etiqueta: 'Teléfono', ejemplo: '809-555-0101' },
];

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
  const editor = useRef(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let montados = [];
    let vivo = true;
    cargarScript(embed).then((NeboCorreo) => {
      if (!vivo || !caja.current) return;
      montados.push(NeboCorreo.montar(caja.current, {
        estado: correoEstado,
        sesion: correoSesion,
        desconectar: correoDesconectar,
        titulo: 'Correo para cobranzas',
        descripcion: 'Conecta el Gmail u Outlook desde el que saldrán los correos de cobranza.',
      }));
      // Una versión vieja del embed no trae el editor: la tarjeta de conexión sigue sola.
      if (NeboCorreo.plantilla && editor.current) {
        montados.push(NeboCorreo.plantilla(editor.current, {
          leer: correoPlantilla,
          guardar: guardarCorreoPlantilla,
          campos: CAMPOS,
          titulo: 'Plantilla del correo de cobranza',
        }));
      }
    }).catch((e) => vivo && setError(e.message));
    return () => { vivo = false; montados.forEach((m) => m && m.desmontar()); };
  }, [embed]);

  if (error) return <div className="card"><p style={{ color: 'var(--danger, #dc2626)' }}>{error}</p></div>;
  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="card"><div ref={caja} /></div>
      <div ref={editor} />
    </div>
  );
}
