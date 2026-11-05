// Ficha de la llamada: retiro, hora pedida y horario que se repite (IA simulada).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const fake = require('./helpers/fakeDb');
require.cache[path.resolve(__dirname, '../services/supabaseDb.js')] = { exports: fake, loaded: true, id: 'fake' };
const schedule = require('../services/schedule');
const fichas = require('../services/fichas');

const cfg = { ...schedule.DEFAULT, enabled: true, horarioAuto: true };
const TR = 'AI: Saludos, le habla Camila.\nUser: Sí, dígame.\nAI: ¿Para cuándo el pago?\nUser: Pasen a retirarlo el viernes en la tarde.';
const llamada = (id, extra = {}) => ({ id, phone: '8095550001', created_at: new Date().toISOString(), resultado: 'answered', intencion_pago: 'fecha_especifica', transcripcion: TR, ...extra });

test('normalizar: retiro en la tarde usa las horas configuradas', () => {
  const f = fichas.normalizarFicha({ modalidad: 'retiro', retiro: { fecha: '2026-11-06', franja: 'tarde', texto: 'el viernes en la tarde' } }, cfg);
  assert.deepEqual(f.retiro, { fecha: '2026-11-06', franja: 'tarde', desde: '14:00', hasta: '18:00', texto: 'el viernes en la tarde' });
  const g = fichas.normalizarFicha({ modalidad: 'retiro', retiro: { franja: 'hora', desde: '10:00', texto: 'pasen a las 10' } }, cfg);
  assert.equal(g.retiro.hasta, '11:00', 'una sola hora: una hora de ventana');
});

test('normalizar: descarta basura, hora pedida y disponibilidad recortada al rango', () => {
  const f = fichas.normalizarFicha({ modalidad: 'cheque', llamar: { fecha: 'mañana', hora: '15:00' },
    disponibilidad: { bloques: [{ dias: [2], desde: '07:00', hasta: '08:30' }, { desde: '21:00' }], texto: 'los martes temprano' } }, cfg);
  assert.equal(f.modalidad, null);
  assert.deepEqual(f.llamar, { fecha: null, hora: '15:00', texto: null });
  assert.deepEqual(f.disponibilidad, { bloques: [{ start: '08:00', end: '08:30', dias: [2] }], texto: 'los martes temprano' });
  assert.equal(fichas.normalizarFicha(null, cfg).modalidad, null);
});

test('procesar: guarda la ficha, ajusta el horario si no hay uno a mano y no repite', async () => {
  fake.reset();
  fake.tablas.cliente_config = [{ phone: '8095550001', enabled: true }];
  let consultas = 0;
  const extraer = async (items) => {
    consultas++;
    return new Map(items.map((i) => [i.id, { modalidad: 'retiro', retiro: { franja: 'tarde', fecha: '2026-11-06', texto: 'Pasen a retirarlo el viernes en la tarde' },
      disponibilidad: { bloques: [{ dias: [2, 4], desde: '10:00', hasta: '10:30' }], texto: 'martes y jueves a las 10' } }]));
  };
  const r = await fichas.procesar([llamada(1), llamada(2, { resultado: 'no_answer' })], cfg, { extraer });
  assert.equal(r.nuevas, 1, 'la no contestada no se lee');
  assert.equal(r.retiros, 1);
  assert.equal(r.horarios, 1);
  const cc = fake.tablas.cliente_config[0];
  assert.deepEqual(cc.horario, [{ start: '10:00', end: '10:30', dias: [2, 4] }]);
  assert.equal(cc.horario_origen, 'ia');
  assert.match(cc.horario_detalle, /martes y jueves a las 10/);
  assert.equal(fake.tablas.llamada_ficha[0].modalidad, 'retiro');

  await fichas.procesar([llamada(1)], cfg, { extraer });
  assert.equal(consultas, 1, 'ya tenía ficha: no vuelve a la IA');
});

test('horario automático apagado: guarda la ficha pero no toca el horario', async () => {
  fake.reset();
  fake.tablas.cliente_config = [{ phone: '8095550001', enabled: true }];
  const extraer = async (items) => new Map(items.map((i) => [i.id, { disponibilidad: { bloques: [{ desde: '09:00', hasta: '10:00' }] } }]));
  const r = await fichas.procesar([llamada(5)], { ...cfg, horarioAuto: false }, { extraer });
  assert.equal(r.horarios, 0);
  assert.equal(fake.tablas.cliente_config[0].horario, undefined);
  assert.deepEqual(fake.tablas.llamada_ficha[0].disponibilidad.bloques, [{ start: '09:00', end: '10:00' }]);
});

test('procesar: un horario puesto a mano no se pisa; si la IA falla, se reintenta', async () => {
  fake.reset();
  const manual = [{ start: '15:00', end: '16:00' }];
  fake.tablas.cliente_config = [{ phone: '8095550001', enabled: true, horario: manual, horario_origen: 'manual' }];
  const extraer = async (items) => new Map(items.map((i) => [i.id, { disponibilidad: { bloques: [{ desde: '09:00', hasta: '10:00' }] } }]));
  const r = await fichas.procesar([llamada(7)], cfg, { extraer });
  assert.equal(r.horarios, 0);
  assert.deepEqual(fake.tablas.cliente_config[0].horario, manual);

  const falla = async () => { throw new Error('timeout'); };
  const r2 = await fichas.procesar([llamada(8)], cfg, { extraer: falla });
  assert.equal(r2.nuevas, 0);
  assert.equal((fake.tablas.llamada_ficha || []).some((f) => f.llamada_key === 'log:8'), false, 'sin marcar: se reintenta');
});

test('retiro: sin la frase del cliente, o con una que dijo Camila, no cuenta', () => {
  const tr = 'AI: Si quiere, podemos pasar a buscar el pago.\nUser: No, yo lo deposito mañana.';
  assert.equal(fichas.citaDelCliente('yo lo deposito mañana', tr), true);
  assert.equal(fichas.citaDelCliente('podemos pasar a buscar el pago', tr), false, 'eso lo dijo Camila');
  assert.equal(fichas.citaDelCliente('vengan a recoger el cheque', tr), false, 'inventada');
  const sinCita = fichas.normalizarFicha({ modalidad: 'retiro', retiro: { franja: 'tarde' } }, cfg, tr);
  assert.equal(sinCita.modalidad, null);
  assert.equal(sinCita.retiro, null);
  const deCamila = fichas.normalizarFicha({ modalidad: 'retiro', retiro: { franja: 'tarde', texto: 'podemos pasar a buscar el pago' } }, cfg, tr);
  assert.equal(deCamila.modalidad, null);
  const bien = fichas.normalizarFicha({ modalidad: 'retiro', retiro: { franja: 'tarde', texto: 'pasen a retirarlo el viernes' } }, cfg, TR);
  assert.equal(bien.modalidad, 'retiro');
});

test('procesar: si la IA respondió ilegible, se marca con error y no se vuelve a pagar', async () => {
  fake.reset();
  fake.tablas.cliente_config = [{ phone: '8095550001', enabled: true }];
  let consultas = 0;
  const extraer = async () => { consultas++; return { mapa: new Map(), error: 'respuesta ilegible de la IA' }; };
  await fichas.procesar([llamada(21)], cfg, { extraer });
  const f = fake.tablas.llamada_ficha.find((x) => x.llamada_key === 'log:21');
  assert.equal(f.error, 'respuesta ilegible de la IA');
  assert.equal(f.modalidad, null);
  await fichas.procesar([llamada(21)], cfg, { extraer });
  assert.equal(consultas, 1, 'no se repite');
});

test('"No es retiro": corrige la ficha a mano', async () => {
  fake.reset();
  fake.tablas.llamada_ficha = [{ llamada_key: 'log:30', phone: '8095550001', modalidad: 'retiro', retiro: { franja: 'tarde' } }];
  await fichas.marcarNoRetiro('log:30', 'ana@jh.com');
  assert.equal(fake.tablas.llamada_ficha[0].modalidad, 'no_retiro');
  assert.equal(fake.tablas.llamada_ficha[0].corregida_por, 'ana@jh.com');
  await assert.rejects(() => fichas.marcarNoRetiro('log:99'), /no tiene ficha/);
});
