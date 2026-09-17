import { useEffect } from 'react';

// Página de pago de lo que se debe. Solo se monta al abrir el popup, así que
// quien no tiene pagos.ver nunca la descarga.
const PAGOS_URL = 'https://app.swordaisolutions.com/pay/d88e8d1ea5e5ff6ce37d500263adc1a75117da6b5e968bd9?embed=1';

export default function PagosModal({ onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="pagos-modal" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pagos-modal__box" role="dialog" aria-label="Lo que se debe">
        <div className="pagos-modal__bar">
          <span>Lo que se debe</span>
          <button className="btn secondary icon-btn" onClick={onClose} title="Cerrar" aria-label="Cerrar">✕</button>
        </div>
        <iframe className="pagos-modal__frame" src={PAGOS_URL} title="Pagar" />
      </div>
    </div>
  );
}
