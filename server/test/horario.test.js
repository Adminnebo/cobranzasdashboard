// Horario por cliente: ventana propia, prioridad en la cola y guardado.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const fake = require('./helpers/fakeDb');
require.cache[path.resolve(__dirname, '../services/supabaseDb.js')] = { exports: fake, loaded: true, id: 'fake' };
const schedule = require('../services/schedule');
const queue = require('../services/queue');
const clienteConfig = require('../services/clienteConfig');

// Santo Domingo es UTC-4 todo el año. Miércoles 4-nov-2026.
const hora = (hhmm, dia = '2026-11-04') => new Date(`${dia}T${hhmm}:00-04:00`);
const cfg = {
  ...schedule.DEFAULT,
  enabled: true,
  weekdaysOnly: true,
  blocks: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
};
const MANANA = [{ start: '08:00', end: '10:00' }];

test('sin horario propio sigue el general', () => {
  assert.equal(schedule.abiertoPara(cfg, null, hora('09:30')), true);
  assert.equal(schedule.abiertoPara(cfg, null, hora('08:30')), false);
  assert.equal(schedule.abiertoPara(cfg, [], hora('13:00')), false);
});

test('con horario propio manda el suyo, aunque salga del general', () => {
  assert.equal(schedule.abiertoPara(cfg, MANANA, hora('08:30')), true, 'antes del general');
  assert.equal(schedule.abiertoPara(cfg, MANANA, hora('11:00')), false, 'el general abierto no cuenta');
  assert.equal(schedule.abiertoPara(cfg, [{ start: '12:00', end: '14:00' }], hora('13:00')), true, 'en el hueco del almuerzo');
});

test('los días y el interruptor general también valen para el horario propio', () => {
  assert.equal(schedule.abiertoPara(cfg, MANANA, hora('08:30', '2026-11-07')), false, 'sábado con L–V');
  assert.equal(schedule.abiertoPara({ ...cfg, enabled: false }, MANANA, hora('08:30')), false);
});

test('el horario propio se recorta al rango permitido (08:00–19:00)', () => {
  assert.deepEqual(schedule.bloquesCliente(cfg, [{ start: '06:00', end: '09:00' }]), [{ start: '08:00', end: '09:00' }]);
  assert.equal(schedule.bloquesCliente(cfg, [{ start: '20:00', end: '21:00' }]), null, 'fuera del rango: sigue el general');
  assert.equal(schedule.abiertoPara(cfg, [{ start: '06:00', end: '07:30' }], hora('09:30')), true, 'sin bloque válido usa el general');
});

test('validar: rechaza bloques fuera del rango o al revés, ordena y acepta vacío', () => {
  assert.throws(() => schedule.validarHorarioCliente(cfg, [{ start: '07:00', end: '09:00' }]), /entre 08:00 y 19:00/);
  assert.throws(() => schedule.validarHorarioCliente(cfg, [{ start: '10:00', end: '09:00' }]), /inválido/);
  assert.equal(schedule.validarHorarioCliente(cfg, null), null);
  assert.equal(schedule.validarHorarioCliente(cfg, []), null);
  assert.deepEqual(
    schedule.validarHorarioCliente(cfg, [{ start: '15:00', end: '16:00' }, { start: '08:00', end: '09:00' }]),
    [{ start: '08:00', end: '09:00' }, { start: '15:00', end: '16:00' }],
  );
  const amplio = { ...cfg, horarioClienteDesde: '07:00', horarioClienteHasta: '20:00' };
  assert.deepEqual(schedule.validarHorarioCliente(amplio, [{ start: '07:00', end: '08:00' }]), [{ start: '07:00', end: '08:00' }]);
});

const fila = (id, phone, extra = {}) => ({ id, phone, nombre: phone, agente: 'principal', created_at: `2026-11-04T1${id}:00:00Z`, ...extra });

test('cola: horario propio abierto va primero, luego follow ups, luego orden de llegada', () => {
  const rows = [
    fila(1, 'A'),
    fila(2, 'B', { agente: 'seguimiento' }),
    fila(3, 'C'),
  ];
  const horarios = new Map([['C', [{ start: '09:00', end: '10:00' }]]]);
  assert.equal(queue.elegirSiguiente(rows, horarios, cfg, hora('09:30')).phone, 'C', 'su ventana está abierta');
  assert.equal(queue.elegirSiguiente(rows, horarios, cfg, hora('10:30')).phone, 'B', 'ventana de C cerrada: follow up');
  assert.equal(queue.elegirSiguiente(rows.filter((r) => r.phone !== 'B'), horarios, cfg, hora('10:30')).phone, 'A');
});

test('cola: fuera del general solo salen los que tienen su ventana abierta', () => {
  const rows = [fila(1, 'A'), fila(2, 'B', { agente: 'seguimiento' }), fila(3, 'C')];
  const horarios = new Map([['C', MANANA]]);
  assert.equal(queue.elegirSiguiente(rows, horarios, cfg, hora('08:15')).phone, 'C');
  assert.equal(queue.elegirSiguiente(rows, horarios, cfg, hora('13:00')), null, 'almuerzo: nadie');
  assert.equal(queue.algunaAbierta(cfg, horarios, hora('08:15')), true);
  assert.equal(queue.algunaAbierta(cfg, horarios, hora('13:00')), false);
  assert.equal(queue.algunaAbierta(cfg, new Map(), hora('08:15')), false);
});

test('guardar horario: no toca enabled ni el estado de cobro; los nuevos quedan apagados', async () => {
  fake.reset();
  fake.tablas.cliente_config = [{ phone: '8095550001', enabled: true, estado_cobro: 'promesa', enabled_antes: true }];
  await clienteConfig.setHorario(['8095550001', '8095550002'], MANANA, 'yo@nebo');
  const [a, b] = ['8095550001', '8095550002'].map((p) => fake.tablas.cliente_config.find((r) => r.phone === p));
  assert.deepEqual(a.horario, MANANA);
  assert.equal(a.enabled, true);
  assert.equal(a.estado_cobro, 'promesa');
  assert.equal(b.enabled, false);
  const map = await clienteConfig.getHorarioMap();
  assert.equal(map.size, 2);

  await clienteConfig.setHorario(['8095550001'], null, 'yo@nebo');
  assert.equal(fake.tablas.cliente_config.find((r) => r.phone === '8095550001').horario, null);
  assert.equal((await clienteConfig.getHorarioMap()).size, 1);
});

test('lista de la cola: las que pueden salir primero, en el orden del bot; luego las que esperan', () => {
  const rows = [fila(1, 'A'), fila(2, 'B', { agente: 'seguimiento' }), fila(3, 'C'), fila(4, 'D')];
  const horarios = new Map([['C', [{ start: '09:00', end: '10:00' }]], ['D', [{ start: '15:00', end: '16:00' }]]]);
  const orden = queue.ordenCola(rows, horarios, cfg, hora('09:30'));
  assert.deepEqual(orden.map((x) => x.r.phone), ['C', 'B', 'A', 'D']);
  assert.deepEqual(orden.map((x) => x.abierto), [true, true, true, false], 'D espera su horario de la tarde');
  assert.equal(queue.elegirSiguiente(rows, horarios, cfg, hora('09:30')).phone, orden[0].r.phone);
});

test('quitar una de la cola: solo la pendiente, queda cancelada con quién la quitó', async () => {
  fake.reset();
  fake.tablas.llamada_cola = [
    { id: 1, phone: 'A', estado: 'pendiente', agente: 'principal', created_at: '2026-11-05T12:00:00Z' },
    { id: 2, phone: 'B', estado: 'enviada', agente: 'principal', created_at: '2026-11-05T11:00:00Z' },
  ];
  const row = await queue.quitar(1, 'yo@nebo');
  assert.equal(row.phone, 'A');
  const a = fake.tablas.llamada_cola.find((r) => r.id === 1);
  assert.equal(a.estado, 'cancelada');
  assert.match(a.detalle, /quitada a mano \(yo@nebo\)/);
  assert.equal(await queue.quitar(2, 'yo@nebo'), null, 'una ya enviada no se toca');
  assert.equal(fake.tablas.llamada_cola.find((r) => r.id === 2).estado, 'enviada');
});

test('horario propio con días: solo esos días, aunque el general sea L–V', () => {
  const MARTES_8 = [{ start: '08:00', end: '08:30', dias: [2] }];
  assert.equal(schedule.abiertoPara(cfg, MARTES_8, hora('08:10', '2026-11-03')), true, 'martes 08:10');
  assert.equal(schedule.abiertoPara(cfg, MARTES_8, hora('08:10', '2026-11-04')), false, 'miércoles no');
  const SABADO = [{ start: '10:00', end: '11:00', dias: [6] }];
  assert.equal(schedule.abiertoPara(cfg, SABADO, hora('10:15', '2026-11-07')), true, 'sábado: mandan sus días');
  const MIXTO = [{ start: '10:00', end: '10:30', dias: [2, 4, 5] }, { start: '16:00', end: '16:30', dias: [4] }];
  assert.equal(schedule.abiertoPara(cfg, MIXTO, hora('16:10', '2026-11-05')), true, 'jueves 16:10');
  assert.equal(schedule.abiertoPara(cfg, MIXTO, hora('16:10', '2026-11-06')), false, 'viernes 16:10 no');
  assert.equal(schedule.abiertoPara(cfg, MIXTO, hora('10:05', '2026-11-06')), true, 'viernes 10:05');
  assert.equal(schedule.abiertoPara(cfg, [{ start: '08:00', end: '09:00' }], hora('08:30', '2026-11-07')), false, 'sin días: los del general');
  assert.equal(schedule.abiertoPara({ ...cfg, enabled: false }, MARTES_8, hora('08:10', '2026-11-03')), false, 'interruptor general');
});

test('validar días: limpia, ordena, rechaza lo que no es lista y deja sin días si viene vacío', () => {
  assert.deepEqual(schedule.validarHorarioCliente(cfg, [{ start: '10:00', end: '10:30', dias: [5, 2, 2, 9, '4'] }]), [{ start: '10:00', end: '10:30', dias: [2, 4, 5] }]);
  assert.deepEqual(schedule.validarHorarioCliente(cfg, [{ start: '10:00', end: '10:30', dias: [] }]), [{ start: '10:00', end: '10:30' }]);
  assert.throws(() => schedule.validarHorarioCliente(cfg, [{ start: '10:00', end: '10:30', dias: 'martes' }]), /lista/);
});

test('días hábiles y fecha del follow up con margen', () => {
  assert.equal(schedule.sumarHabiles('2026-11-05', 1), '2026-11-06', 'jue + 1 = vie');
  assert.equal(schedule.sumarHabiles('2026-11-06', 1), '2026-11-09', 'vie + 1 = lun');
  assert.equal(schedule.sumarHabiles('2026-11-06', 0), '2026-11-06');
  assert.equal(schedule.fechaFollowUp('2026-11-05', { followUpMargenDias: 1 }), '2026-11-06');
  assert.equal(schedule.fechaFollowUp('2026-11-05', {}), '2026-11-05', 'sin margen: el mismo día');
});
