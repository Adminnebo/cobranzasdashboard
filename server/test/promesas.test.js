const test = require('node:test');
const assert = require('node:assert/strict');
const { decidir, fechaDeLlamada, inicioDelDia, llamadaKey } = require('../services/promesas');
const schedule = require('../services/schedule');

const TOPE = 3;
const normal = (intencion) => ({ agente: 'cobranzas', intencion_pago: intencion });
const fu = (intencion) => ({ agente: 'seguimiento', intencion_pago: intencion });
const enSeg = (extra = {}) => ({ id: 7, estado: 'en_seguimiento', intento: 1, reintentos: 0, ...extra });

test('agente normal: da fecha => promesa nueva (intento 1)', () => {
  assert.deepEqual(decidir(normal('fecha_especifica'), { abierta: null, fecha: '2026-11-10', tope: TOPE }),
    { accion: 'nueva_promesa', fecha: '2026-11-10', intento: 1 });
});

test('agente normal: sin fecha o no contesta => nada (sigue en la lista normal)', () => {
  assert.equal(decidir(normal('no_contesta'), { abierta: null, fecha: null, tope: TOPE }).accion, 'nada');
  assert.equal(decidir(normal('evasivo'), { abierta: null, fecha: null, tope: TOPE }).accion, 'nada');
});

test('"ya pagué" con cualquier agente => dice_pago', () => {
  assert.equal(decidir(normal('ya_pago'), { abierta: null, fecha: null, tope: TOPE }).accion, 'dice_pago');
  assert.equal(decidir(fu('ya_pago'), { abierta: enSeg(), fecha: null, tope: TOPE }).accion, 'dice_pago');
});

test('follow up con fecha nueva => reprograma y sube el intento', () => {
  assert.deepEqual(decidir(fu('fecha_especifica'), { abierta: enSeg(), fecha: '2026-11-11', tope: TOPE }),
    { accion: 'reprogramar', fecha: '2026-11-11', intento: 2 });
});

// Ventana de ejemplo: promete el lun 9 nov, 2 días hábiles de margen → 1.er follow up el mié 11; 7 días → hasta el mar 17.
const VENT = { ventana_desde: '2026-11-11', ventana_hasta: '2026-11-17' };
const CFG = { reintentoHoras: 2, fuReintentosDia1: 1, fuCadaDias: 1, fuVentanaDias: 7, fuSinFechaMismoDia: false };
const rd = (dia, hora) => new Date(`${dia}T${hora}:00-04:00`);
const ctx = (abierta, hoy, hora, cfg = CFG) => ({ abierta, fecha: null, tope: TOPE, hoy, ahora: rd(hoy, hora), cfg });

test('ventana: empieza N días hábiles después de la fecha prometida y dura 7 días de calendario', () => {
  const desde = schedule.fechaFollowUp('2026-11-09', { followUpMargenDias: 2 });
  assert.equal(desde, '2026-11-11');
  assert.equal(schedule.finVentana(desde, { fuVentanaDias: 7 }), '2026-11-17');
});

test('3.ª promesa: con fecha nueva pasa a una persona; sin fecha, al acabarse su ventana', () => {
  assert.equal(decidir(fu('fecha_especifica'), { ...ctx(enSeg({ intento: 3, ...VENT }), '2026-11-12', '10:00'), fecha: '2026-11-20' }).accion, 'escalar');
  assert.equal(decidir(fu('evasivo'), ctx(enSeg({ intento: 3, ...VENT }), '2026-11-12', '10:00')).accion, 'seguir', 'todavía en la ventana');
  assert.equal(decidir(fu('evasivo'), ctx(enSeg({ intento: 3, ...VENT }), '2026-11-17', '10:00')).accion, 'escalar', 'último día');
});

test('ventana, primer día: si no contesta reintenta a las X horas; agotados, al día siguiente', () => {
  const d1 = decidir(fu('no_contesta'), ctx(enSeg(VENT), '2026-11-11', '11:00'));
  assert.deepEqual(d1, { accion: 'seguir', proximo: rd('2026-11-11', '13:00').toISOString(), reintento: true });
  const d2 = decidir(fu('no_contesta'), ctx(enSeg({ ...VENT, reintentos: 1 }), '2026-11-11', '13:00'));
  assert.deepEqual(d2, { accion: 'seguir', proximo: inicioDelDia('2026-11-12').toISOString(), reintento: false });
});

test('ventana, primer día: el reintento que no cabe en el horario de hoy pasa al día siguiente', () => {
  const cfg = { ...CFG, blocks: [{ start: '09:00', end: '12:00' }] };
  const d = decidir(fu('no_contesta'), ctx(enSeg(VENT), '2026-11-11', '11:00', cfg));
  assert.equal(d.proximo, inicioDelDia('2026-11-12').toISOString());
});

test('ventana: contesta sin fecha → al día siguiente (o el mismo día si así está configurado)', () => {
  assert.equal(decidir(fu('evasivo'), ctx(enSeg(VENT), '2026-11-11', '11:00')).proximo, inicioDelDia('2026-11-12').toISOString());
  const mismo = decidir(fu('evasivo'), ctx(enSeg(VENT), '2026-11-11', '11:00', { ...CFG, fuSinFechaMismoDia: true }));
  assert.equal(mismo.reintento, true);
});

test('ventana: ritmo cada 2 días y fin de la ventana sin fecha → vuelve al agente principal', () => {
  assert.equal(decidir(fu('no_contesta'), ctx(enSeg({ ...VENT, reintentos: 1 }), '2026-11-11', '15:00', { ...CFG, fuCadaDias: 2 })).proximo,
    inicioDelDia('2026-11-13').toISOString());
  assert.equal(decidir(fu('no_contesta'), ctx(enSeg(VENT), '2026-11-16', '10:00', { ...CFG, fuCadaDias: 2 })).accion, 'incumplida', 'el 18 ya está fuera');
  assert.equal(decidir(fu('sin_intencion'), ctx(enSeg(VENT), '2026-11-17', '10:00')).accion, 'incumplida');
});

test('llamada normal con fecha mientras hay promesa abierta => reprograma sin contar incumplida', () => {
  assert.deepEqual(decidir(normal('fecha_especifica'), { abierta: { id: 1, estado: 'pendiente', intento: 2 }, fecha: '2026-11-20', tope: TOPE }),
    { accion: 'reprogramar', fecha: '2026-11-20', intento: 2 });
});

test('follow up sin promesa abierta (p.ej. disparado a mano) se trata como llamada normal', () => {
  assert.equal(decidir(fu('fecha_especifica'), { abierta: null, fecha: '2026-11-10', tope: TOPE }).accion, 'nueva_promesa');
});

test('fechaDeLlamada: "paga hoy" sin texto usa el día de la llamada; ya pagó o se niega nunca es promesa', () => {
  assert.equal(fechaDeLlamada('pago_inmediato', null, '2026-11-04T15:00:00Z'), '2026-11-04');
  assert.equal(fechaDeLlamada('fecha_especifica', '2026-11-05', '2026-11-04T15:00:00Z'), '2026-11-05');
  assert.equal(fechaDeLlamada('fecha_especifica', null, '2026-11-04T15:00:00Z'), null);
  assert.equal(fechaDeLlamada('ya_pago', '2026-11-05', '2026-11-04T15:00:00Z'), null);
  assert.equal(fechaDeLlamada('sin_intencion', '2026-11-05', '2026-11-04T15:00:00Z'), null);
});

test('inicioDelDia: medianoche en hora RD', () => {
  assert.equal(inicioDelDia('2026-11-05').toISOString(), '2026-11-05T04:00:00.000Z');
});

test('llamadaKey: por id de la fila, o teléfono + hora si no hay id', () => {
  assert.equal(llamadaKey({ id: 1121, phone: '3395658425' }), 'log:1121');
  assert.equal(llamadaKey({ phone: '3395658425', created_at: 'x' }), '3395658425|x');
});

