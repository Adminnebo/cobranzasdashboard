// Mapeo intención -> color (escala de calidad de pago, mejor a peor) y etiqueta.
// El color sigue a la entidad; el orden es semántico (verde=paga, rojo=no paga).
export const INTENCION = {
  pago_inmediato:   { label: 'Pago inmediato',   color: 'var(--q-1)' },
  fecha_especifica: { label: 'Fecha específica', color: 'var(--q-2)' },
  negociacion:      { label: 'Negociación',      color: 'var(--q-3)' },
  promesa_vaga:     { label: 'Promesa vaga',     color: 'var(--q-4)' },
  no_contesta:      { label: 'No contesta',      color: 'var(--q-5)' },
  disputa:          { label: 'Disputa',          color: 'var(--q-6)' },
  sin_intencion:    { label: 'Sin intención',    color: 'var(--q-7)' },
  ivr:              { label: 'IVR / contestadora', color: 'var(--q-8)' },
  no_contactado:    { label: 'No contactado',    color: 'var(--q-8)' },
};

export const intencionColor = (key) => (INTENCION[key] || INTENCION.no_contactado).color;
export const intencionLabel = (key) => (INTENCION[key] || { label: key }).label;

// Categoría de probabilidad -> estado.
export const CATEGORIA = {
  Alta:  { color: 'var(--good)' },
  Media: { color: 'var(--warning)' },
  Baja:  { color: 'var(--critical)' },
};

export const probColor = (p) => (p >= 65 ? 'var(--good)' : p >= 35 ? 'var(--warning)' : 'var(--critical)');
