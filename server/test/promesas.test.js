const test = require('node:test');
const assert = require('node:assert/strict');
const { decidir, fechaDeLlamada, proximoReintento, inicioDelDia, llamadaKey } = require('../services/promesas');

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

test('follow up de la 3.ª promesa incumplida => pasar a una persona', () => {
  assert.equal(decidir(fu('fecha_especifica'), { abierta: enSeg({ intento: 3 }), fecha: '2026-11-12', tope: TOPE }).accion, 'escalar');
  assert.equal(decidir(fu('evasivo'), { abierta: enSeg({ intento: 3 }), fecha: null, tope: TOPE }).accion, 'escalar');
});

test('follow up no contestado: 2 reintentos y después vuelve a la lista normal', () => {
  assert.equal(decidir(fu('no_contesta'), { abierta: enSeg({ reintentos: 0 }), fecha: null, tope: TOPE }).accion, 'reintento');
  assert.equal(decidir(fu('no_contesta'), { abierta: enSeg({ reintentos: 1 }), fecha: null, tope: TOPE }).accion, 'reintento');
  assert.equal(decidir(fu('no_contesta'), { abierta: enSeg({ reintentos: 2 }), fecha: null, tope: TOPE }).accion, 'incumplida');
});

test('follow up sin fecha (se niega, evasivo) => vuelve a la lista normal', () => {
  assert.equal(decidir(fu('sin_intencion'), { abierta: enSeg(), fecha: null, tope: TOPE }).accion, 'incumplida');
  assert.equal(decidir(fu('evasivo'), { abierta: enSeg(), fecha: null, tope: TOPE }).accion, 'incumplida');
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

test('reintentos: el primero a las N horas, el segundo al inicio del día siguiente (hora RD)', () => {
  const ahora = new Date('2026-11-04T15:00:00Z'); // 11:00 en RD
  assert.equal(proximoReintento(0, ahora, 2).toISOString(), '2026-11-04T17:00:00.000Z');
  assert.equal(proximoReintento(1, ahora, 2).toISOString(), '2026-11-05T04:00:00.000Z'); // 00:00 RD
  assert.equal(inicioDelDia('2026-11-05').toISOString(), '2026-11-05T04:00:00.000Z');
});

test('llamadaKey: por id de la fila, o teléfono + hora si no hay id', () => {
  assert.equal(llamadaKey({ id: 1121, phone: '3395658425' }), 'log:1121');
  assert.equal(llamadaKey({ phone: '3395658425', created_at: 'x' }), '3395658425|x');
});

