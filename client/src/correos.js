// Correos enviados por n8n (correo-servicio) → con su cliente de la cartera y sus respuestas.
//
// Cliente: por el teléfono que n8n mandó en los datos (los envíos nuevos lo traen), si no por el
// código, y si no por la dirección a la que se envió (los correos viejos solo tienen eso).
// Respuestas: los mensajes del hilo que no mandamos nosotros, desde este envío hasta el siguiente
// envío del mismo hilo (si hubiera varios en un hilo, cada respuesta va con el envío que contesta).

// Aviso de que el correo no se entregó (rebote del servidor de correo): no es una respuesta.
const REMITENTE_REBOTE = /mailer-daemon|postmaster@|mail delivery (subsystem|system)|microsoftexchange|noreply-dmarc/i;
const ASUNTO_REBOTE = /delivery status notification|undeliverable|undelivered mail|returned mail|delivery (has )?failed|failure notice|mail delivery failed|no se (pudo|puede) entregar|no entregado|entrega fallida|devuelto/i;
export const esRebote = (m) => !!m && !m.mio && (REMITENTE_REBOTE.test(m.de || '') || ASUNTO_REBOTE.test(m.asunto || ''));

// Lo que contestó el cliente, leído con IA en el servidor (correosIa.js). En orden de prioridad:
// si un correo tiene varias respuestas, manda la más importante para cobranza.
export const CATEGORIAS_CORREO = {
  comprobante: { label: 'Envió comprobante', icon: '🧾', color: 'var(--good-ink)' },
  ya_pago: { label: 'Dice que ya pagó', icon: '✅', color: 'var(--good-ink)' },
  pago_listo: { label: 'Pago listo para retirar', icon: '💵', color: 'var(--good-ink)' },
  nota_credito: { label: 'Nota de crédito', icon: '📝', color: 'var(--series-1)' },
  no_pagara: { label: 'No va a pagar', icon: '⛔', color: 'var(--critical)' },
  disputa: { label: 'No está de acuerdo', icon: '⚠️', color: 'var(--serious)' },
  promesa: { label: 'Va a pagar', icon: '📅', color: 'var(--series-5)' },
  consulta: { label: 'Pide información', icon: '❓', color: 'var(--text-secondary)' },
  equivocado: { label: 'No es el contacto', icon: '🚫', color: 'var(--serious)' },
  otro: { label: 'Otro', icon: '💬', color: 'var(--text-muted)' },
};
const PRIORIDAD = Object.keys(CATEGORIAS_CORREO);
export const principal = (etiquetas) => {
  const conCat = (etiquetas || []).filter((e) => e && CATEGORIAS_CORREO[e.categoria]);
  if (!conCat.length) return null;
  return conCat.reduce((a, b) => (PRIORIDAD.indexOf(b.categoria) < PRIORIDAD.indexOf(a.categoria) ? b : a));
};

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
    const llegados = c.mensajes
      ? c.mensajes.filter((m) => !m.mio && (Date.parse(m.fecha) || 0) >= desde && (siguiente === undefined || (Date.parse(m.fecha) || 0) < siguiente))
      : null;
    const respuestas = llegados ? llegados.filter((m) => !esRebote(m)) : null;
    const rebote = llegados ? llegados.find(esRebote) || null : null;
    return {
      ...c,
      cliente: cliente ? { phone: cliente.phone, name: cliente.name, codigo: cliente.codigo } : null,
      nombre: (cliente && cliente.name) || d.nombre || '',
      phone: (cliente && cliente.phone) || (d.telefono ? phoneKey(d.telefono) : ''),
      respuestas, // null = no se pudo leer el buzón (no se sabe). Sin los rebotes.
      rebote, // el aviso de que no se entregó (dirección inexistente, buzón lleno…), o null
      ultimaRespuesta: respuestas && respuestas.length ? respuestas[respuestas.length - 1] : null,
      // La etiqueta de IA que manda entre sus respuestas ({ categoria, resumen, monto, fecha }), o null.
      ia: respuestas ? principal(respuestas.map((m) => m.etiqueta)) : null,
      // Respuestas que la IA todavía no leyó.
      sinLeer: respuestas ? respuestas.filter((m) => !m.etiqueta).length : 0,
    };
  });
}

export const fmtFechaCorreo = (iso) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
};
