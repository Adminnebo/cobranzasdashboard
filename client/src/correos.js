// Correos enviados por n8n (correo-servicio) → con su cliente de la cartera y sus respuestas.
//
// Cliente: por el teléfono que n8n mandó en los datos (los envíos nuevos lo traen), si no por el
// código, y si no por la dirección a la que se envió (los correos viejos solo tienen eso).
// Respuestas: los mensajes del hilo que no mandamos nosotros, desde este envío hasta el siguiente
// envío del mismo hilo (si hubiera varios en un hilo, cada respuesta va con el envío que contesta).

const phoneKey = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const correosDe = (v) => (String(v || '').toLowerCase().match(/[^\s<>(),;:"']+@[^\s<>(),;:"']+\.[^\s<>(),;:"']+/g) || []);

export function vincularCorreos(correos = [], clientes = []) {
  const porTel = new Map(), porCodigo = new Map(), porCorreo = new Map();
  for (const c of clientes) {
    if (c.phone) porTel.set(c.phone, c);
    if (c.codigo) porCodigo.set(String(c.codigo).trim().toLowerCase(), c);
    for (const e of correosDe(c.email)) if (!porCorreo.has(e)) porCorreo.set(e, c);
  }

  // Envíos de cada hilo en orden, para repartir las respuestas.
  const enviosDeHilo = new Map();
  for (const c of correos) {
    if (!c.hilo) continue;
    if (!enviosDeHilo.has(c.hilo)) enviosDeHilo.set(c.hilo, []);
    enviosDeHilo.get(c.hilo).push(Date.parse(c.fecha) || 0);
  }
  for (const l of enviosDeHilo.values()) l.sort((a, b) => a - b);

  return correos.map((c) => {
    const d = c.datos || {};
    const cliente = (d.telefono && porTel.get(phoneKey(d.telefono)))
      || (d.codigo && porCodigo.get(String(d.codigo).trim().toLowerCase()))
      || (c.para || []).map((e) => porCorreo.get(String(e).toLowerCase())).find(Boolean)
      || null;
    const desde = Date.parse(c.fecha) || 0;
    const siguiente = c.hilo ? (enviosDeHilo.get(c.hilo) || []).find((t) => t > desde) : undefined;
    const respuestas = c.mensajes
      ? c.mensajes.filter((m) => !m.mio && (Date.parse(m.fecha) || 0) >= desde && (siguiente === undefined || (Date.parse(m.fecha) || 0) < siguiente))
      : null;
    return {
      ...c,
      cliente: cliente ? { phone: cliente.phone, name: cliente.name, codigo: cliente.codigo } : null,
      nombre: (cliente && cliente.name) || d.nombre || '',
      phone: (cliente && cliente.phone) || (d.telefono ? phoneKey(d.telefono) : ''),
      respuestas, // null = no se pudo leer el buzón (no se sabe)
      ultimaRespuesta: respuestas && respuestas.length ? respuestas[respuestas.length - 1] : null,
    };
  });
}

export const fmtFechaCorreo = (iso) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
};
