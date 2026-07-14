import { money } from '../format';
import { intencionColor, intencionLabel, probColor } from '../constants';
import { usePaged } from '../usePaged';
import Pager from './Pager';

/**
 * Tabla de cartera priorizada por IA (rows ya vienen ordenadas por prioridad).
 */
export default function CarteraTable({ rows }) {
  const { slice, start, pager } = usePaged(rows, 25);

  return (
    <div>
      <Pager p={pager} />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Cliente</th>
              <th>Intención (última llamada)</th>
              <th className="num">Deuda total</th>
              <th className="num">Vencida</th>
              <th className="num">% venc.</th>
              <th>Prob. pago (IA)</th>
              <th className="num">Recup. esperada</th>
              <th>Acción recomendada</th>
            </tr>
          </thead>
          <tbody>
            {slice.map((r, i) => (
              <tr key={`${r.phone || 'sin-tel'}-${start + i}`}>
                <td style={{ color: 'var(--text-muted)' }}>{start + i + 1}</td>
                <td>
                  <div style={{ fontWeight: 600 }}>{r.name}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.76rem' }}>{r.empresa}</div>
                </td>
                <td>
                  <span className="pill" style={{ color: intencionColor(r.intencion) }}>
                    <span className="pdot" style={{ background: intencionColor(r.intencion) }} />
                    {intencionLabel(r.intencion)}
                  </span>
                </td>
                <td className="num">{money(r.deuda_total)}</td>
                <td className="num" style={{ color: r.deuda_vencida > 0 ? 'var(--critical)' : 'var(--text-muted)' }}>
                  {money(r.deuda_vencida)}
                </td>
                <td className="num">{r.deuda_total > 0 ? Math.round((r.deuda_vencida / r.deuda_total) * 100) : 0}%</td>
                <td>
                  <span className="prob">
                    <span className="prob-bar">
                      <span className="prob-fill" style={{ width: `${r.probabilidad_pago}%`, background: probColor(r.probabilidad_pago) }} />
                    </span>
                    <span className="prob-num" style={{ color: probColor(r.probabilidad_pago) }}>{r.probabilidad_pago}%</span>
                  </span>
                </td>
                <td className="num" style={{ fontWeight: 600 }}>{money(r.monto_esperado)}</td>
                <td className="trunc" title={r.accion_recomendada}>{r.accion_recomendada}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
