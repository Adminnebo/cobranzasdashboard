import { useCallback, useEffect, useState } from 'react';
import { fetchRetiroSeguimiento } from '../api';

const TZ = 'America/Santo_Domingo';
const hora = (iso) => (iso ? new Date(iso).toLocaleTimeString('es-DO', { hour: 'numeric', minute: '2-digit', timeZone: TZ }) : '');
const diaHora = (iso) => (iso ? new Date(iso).toLocaleString('es-DO', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: TZ }) : '');
const dia = (ymd) => (ymd ? new Date(`${String(ymd).slice(0, 10)}T12:00:00Z`).toLocaleDateString('es-DO', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
const pesos = (cent) => `RD$ ${(cent / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const hace = (iso, ahora) => {
  if (!iso) return '';
  const m = Math.max(0, Math.round((ahora - Date.parse(iso)) / 60000));
  return m < 1 ? 'hace un momento' : m < 60 ? `hace ${m} min` : `hace ${Math.round(m / 60)} h`;
};
const ACTUALIZAR_MS = 60000;

/** Minutos que faltan para que llegue: de la hora estimada si la hay, si no del cálculo de logística. */
function faltan(s, ahora) {
  if (s.etaEn && Number.isFinite(Date.parse(s.etaEn))) return Math.round((Date.parse(s.etaEn) - ahora) / 60000);
  return s.etaMin;
}

/**
 * Los 4 pasos del retiro: lo recibió logística → repartidor asignado → en camino → retirado.
 * Cada uno: { titulo, detalle, estado: 'hecho' | 'actual' | 'pendiente' | 'mal' }.
 */
export function pasosRetiro(local, lg, ahora) {
  const s = lg || local || {};
  const estado = s.estado || null;
  const ruta = s.ruta || (local && local.ruta) || null;
  const asignado = ruta && ruta.repartidor
    ? `${ruta.repartidor}${ruta.referencia ? ` · ruta ${ruta.referencia}` : ''}${ruta.fecha ? ` del ${dia(ruta.fecha)}` : ''}`
    : ruta && ruta.referencia ? `Ruta ${ruta.referencia}${ruta.fecha ? ` del ${dia(ruta.fecha)}` : ''} (sin repartidor todavía)` : '';
  const cerrado = estado === 'retirado' || estado === 'no_retirado';
  const pasos = [];

  pasos.push(local && local.enviado
    ? { titulo: 'Lo recibió logística', detalle: local.enviadoAt ? diaHora(local.enviadoAt) : '', estado: 'hecho' }
    : { titulo: 'Todavía no llegó a logística', detalle: (local && local.error) || 'Se manda solo en el próximo minuto.', estado: local && local.error ? 'mal' : 'actual' });

  if (estado === 'cancelado') {
    pasos.push({ titulo: 'Cancelado en logística', detalle: s.motivo || '', estado: 'mal' });
    return pasos;
  }
  if (estado === 'por_ubicar') pasos.push({ titulo: 'Sin repartidor todavía', detalle: 'Logística está buscando la ubicación del cliente.', estado: 'actual' });
  else if (estado === 'por_asignar' || !estado) pasos.push({ titulo: 'Sin repartidor todavía', detalle: s.motivo || 'Esperando que logística lo meta en una ruta.', estado: local && local.enviado ? 'actual' : 'pendiente' });
  else pasos.push({ titulo: 'Repartidor asignado', detalle: asignado, estado: 'hecho' });

  if (cerrado) pasos.push({ titulo: 'Fue a buscarlo', detalle: s.atendidoEn ? `Llegó ${diaHora(s.atendidoEn)}` : '', estado: 'hecho' });
  else if (estado === 'en_ruta' && (s.etaMin != null || s.etaEn)) {
    const m = faltan(s, ahora);
    const partes = [
      m != null && m <= 0 ? 'llegando' : m != null ? `llega en ~${m} min${s.etaEn ? ` (${hora(s.etaEn)})` : ''}` : '',
      s.paradasAntes != null ? (s.paradasAntes === 0 ? 'es su próxima parada' : `${s.paradasAntes} parada${s.paradasAntes === 1 ? '' : 's'} antes`) : '',
      s.distanciaKm != null ? `${s.distanciaKm.toLocaleString('es-DO', { maximumFractionDigits: 1 })} km` : '',
    ].filter(Boolean);
    pasos.push({ titulo: 'En camino', detalle: partes.join(' · '), estado: 'actual', gps: s.camion });
  } else if (estado === 'en_ruta') pasos.push({ titulo: 'Todavía no sale', detalle: 'Su ruta no ha empezado o no tiene la ubicación del camión.', estado: 'actual' });
  else pasos.push({ titulo: 'En camino', detalle: '', estado: 'pendiente' });

  if (estado === 'retirado') {
    pasos.push({ titulo: 'Retirado', detalle: [s.montoCent != null ? pesos(s.montoCent) : null, s.rcp, s.atendidoEn ? hora(s.atendidoEn) : null].filter(Boolean).join(' · '), estado: 'hecho', foto: s.fotoUrl || (local && local.fotoUrl) || null });
  } else if (estado === 'no_retirado') pasos.push({ titulo: 'No se pudo retirar', detalle: s.motivo || '', estado: 'mal' });
  else pasos.push({ titulo: 'Retirado', detalle: '', estado: 'pendiente' });
  return pasos;
}

/**
 * Vista del estado de un retiro (Por atender → Retiros): quién lo tiene, si va
 * en camino y cuánto falta, y la foto al retirarlo. Pregunta a logística al
 * abrirla y cada minuto mientras está abierta.
 */
export default function RetiroEstado({ externoId, lgLista, onVerLlamada, porCorreo = false }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [ahora, setAhora] = useState(Date.now());

  const cargar = useCallback(async (fresco = false) => {
    if (!externoId) return;
    setCargando(true);
    try { setD(await fetchRetiroSeguimiento(externoId, fresco)); setErr(null); }
    catch (e) { setErr(e.message); }
    finally { setCargando(false); }
  }, [externoId]);

  useEffect(() => {
    cargar();
    const t1 = setInterval(() => cargar(), ACTUALIZAR_MS);
    const t2 = setInterval(() => setAhora(Date.now()), 30000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [cargar]);

  const local = (d && d.local) || lgLista || null;
  const lg = d ? d.logistica : null;
  const pasos = pasosRetiro(local, lg, ahora);
  const gps = pasos.find((p) => p.gps);
  const foto = pasos.find((p) => p.foto);

  return (
    <div className="retiro-estado">
      {local && local.prueba ? (
        <div className="retiro-estado__nota">🧪 Número de prueba: el retiro no se manda a logística.</div>
      ) : (
        <ol className="retiro-pasos">
          {pasos.map((p, i) => (
            <li key={i} className={`retiro-paso retiro-paso--${p.estado}`}>
              <span className="retiro-paso__punto" aria-hidden="true">{p.estado === 'hecho' ? '✓' : p.estado === 'mal' ? '!' : ''}</span>
              <span className="retiro-paso__txt">
                <b>{p.titulo}</b>
                {p.detalle && <span>{p.detalle}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
      {gps && gps.gps && gps.gps.minutosSinGps != null && gps.gps.minutosSinGps > 10 && (
        <div className="retiro-estado__nota retiro-estado__nota--aviso">
          La última ubicación del camión es de hace {Math.round(gps.gps.minutosSinGps)} min: la hora de llegada puede no ser exacta.
        </div>
      )}
      {foto && foto.foto && (
        <a className="retiro-foto" href={foto.foto} target="_blank" rel="noreferrer" title="Abrir la foto en grande">
          <img src={foto.foto} alt="Foto del pago retirado" loading="lazy" />
        </a>
      )}
      {d && d.error && <div className="retiro-estado__nota retiro-estado__nota--aviso">{d.error}. Se muestra lo último que avisó.</div>}
      {err && <div className="retiro-estado__nota retiro-estado__nota--aviso">{err}</div>}
      <div className="retiro-estado__pie">
        <span>{cargando ? 'Consultando a logística…' : d && d.consultadoEn ? `Logística, ${hace(d.consultadoEn, ahora)}` : ''}</span>
        <span className="retiro-estado__acc">
          <button className="mini-btn" disabled={cargando} onClick={() => cargar(true)}>↻ Actualizar</button>
          {onVerLlamada && <button className="mini-btn" onClick={onVerLlamada}>{porCorreo ? '📧 Ver el correo' : '🎧 Ver la llamada'}</button>}
        </span>
      </div>
    </div>
  );
}
