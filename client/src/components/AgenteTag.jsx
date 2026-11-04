import { agenteDe } from '../constants';

/** Etiqueta del agente que hizo la llamada (📞 Cobranzas / ↩ Follow up). */
export default function AgenteTag({ ll }) {
  const a = agenteDe(ll);
  const fu = ll && ll.agente === 'seguimiento';
  return (
    <span className={`agente-tag ${fu ? 'agente-tag--fu' : ''}`} title={a.tip + (ll && ll.agente_inferido ? ' · registro anterior, sin dato de agente' : '')}>
      {a.icon} {a.label}
    </span>
  );
}
