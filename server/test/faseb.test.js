// Fase B: hora pedida, menos disponibilidad primero y ventanas cortas que no alcanzan.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const fake = require('./helpers/fakeDb');
require.cache[path.resolve(__dirname, '../services/supabaseDb.js')] = { exports: fake, loaded: true, id: 'fake' };
delete process.env.OPENAI_API_KEY;
const schedule = require('../services/schedule');
const queue = require('../services/queue');
const promesas = require('../services/promesas');
const fichas = require('../services/fichas');

// Santo Domingo es UTC-4 todo el año. Jueves 5 y viernes 6 de noviembre de 2026.
const hora = (hhmm, dia = '2026-11-05') => new Date(`${dia}T${hhmm}:00-04:00`);
const cfg = { ...schedule.DEFAULT, enabled: true, weekdaysOnly: true, blocks: [{ start: '09:00', end: '11:45' }, { start: '14:00', end: '17:45' }] };
const t = (n) => fake.tablas[n] || [];
const sembrarConfig = async (extra = {}) => {
  fake.tablas.call_schedule = [{ id: 1, enabled: true, weekdays_only: true, blocks: cfg.blocks, cita_ventana_min: 30, max_movidas: 2, ...extra }];
  return schedule.get(true);
};

test('hora pedida: espera su hora, sale en sus 30 min aunque esté fuera del horario general', () => {
  const cita = hora('18:30').toISOString(); // después del horario general (cierra 17:45)
  assert.equal(schedule.ventanaLlamada(cfg, { cita }, hora('10:00')).espera, 'cita');
  assert.equal(schedule.ventanaLlamada(cfg, { cita }, hora('10:00')).abierto, false, 'el general abierto no cuenta');
  const v = schedule.ventanaLlamada(cfg, { cita }, hora('18:40'));
  assert.equal(v.abierto, true);
  assert.equal(v.disponible, 20);
  assert.equal(schedule.ventanaLlamada(cfg, { cita }, hora('19:01')).abierto, false, 'se pasó su ventana');
  assert.equal(schedule.ventanaLlamada(cfg, { cita: hora('15:00', '2026-11-06').toISOString() }, hora('15:10')).espera, 'cita', 'es mañana');
  assert.equal(schedule.ventanaLlamada({ ...cfg, enabled: false }, { cita }, hora('18:40')).abierto, false, 'llamadas apagadas');
});

test('cola: entre las que pueden salir, primero la que menos tiempo le queda hoy', () => {
  const rows = [
    { id: 1, phone: 'A', created_at: '2026-11-05T12:00:00Z' },                       // general
    { id: 2, phone: 'B', created_at: '2026-11-05T12:05:00Z', agente: 'seguimiento' }, // general, follow up
    { id: 3, phone: 'C', created_at: '2026-11-05T12:10:00Z' },                       // propio 9:50–10:00
    { id: 4, phone: 'D', created_at: '2026-11-05T11:00:00Z' },                       // pidió las 15:00
  ];
  const horarios = new Map([['C', [{ start: '09:50', end: '10:00' }]]]);
  const citas = new Map([['D', { at: hora('15:00').toISOString() }]]);
  const orden = queue.ordenCola(rows, horarios, cfg, hora('09:55'), citas).map((x) => x.r.phone);
  assert.deepEqual(orden.slice(0, 3), ['C', 'B', 'A'], 'C tiene 5 min; B y A todo el día (follow up primero)');
  assert.equal(orden[3], 'D', 'D espera su hora');
  assert.equal(queue.elegirSiguiente(rows, horarios, cfg, hora('15:05'), citas).phone, 'D', 'a su hora, D tiene 25 min: va primero');
  assert.equal(queue.algunaAbierta({ ...cfg, blocks: [] }, new Map(), hora('15:05'), citas), true, 'la hora pedida abre la cola');
});

test('ventana corta perdida: pasa al día siguiente con el motivo; a la 3.ª, a una persona', async () => {
  fake.reset();
  await sembrarConfig();
  fake.tablas.cliente_config = [{ phone: 'C', enabled: true, horario: [{ start: '09:50', end: '10:00' }] }];
  fake.tablas.llamada_cola = [{ id: 7, phone: 'C', estado: 'pendiente', agente: 'principal', created_at: hora('08:00').toISOString() }];
  let r = await queue.revisarPerdidas(hora('09:58'));
  assert.equal(r.movidas, undefined, 'todavía está en su ventana');
  r = await queue.revisarPerdidas(hora('10:05'));
  assert.equal(r.movidas, 1);
  assert.match(t('llamada_cola')[0].detalle, /No alcanzó a salir en su horario \(09:50–10:00\).*\(1 de 2\)/);
  await queue.revisarPerdidas(hora('16:00'));
  assert.equal(t('llamada_cola')[0].movida, 1, 'se cuenta una vez por día');
  await queue.revisarPerdidas(hora('10:05', '2026-11-06'));
  assert.equal(t('llamada_cola')[0].movida, 2);
  r = await queue.revisarPerdidas(hora('10:05', '2026-11-09'));
  assert.equal(r.a_persona, 1);
  assert.equal(t('llamada_cola')[0].estado, 'cancelada');
  assert.match(fake.tablas.cliente_config[0].atencion_motivo, /3 días seguidos/);
});

test('ventana corta: si entró a la cola después de que cerró, no la perdió', async () => {
  fake.reset();
  await sembrarConfig();
  fake.tablas.cliente_config = [{ phone: 'C', enabled: true, horario: [{ start: '09:50', end: '10:00' }] }];
  fake.tablas.llamada_cola = [{ id: 8, phone: 'C', estado: 'pendiente', created_at: hora('10:30').toISOString() }];
  const r = await queue.revisarPerdidas(hora('11:00'));
  assert.equal(r.movidas, undefined);
});

test('hora pedida perdida: se mueve al siguiente día hábil a la misma hora', async () => {
  fake.reset();
  await sembrarConfig();
  fake.tablas.cliente_config = [{ phone: 'D', enabled: true, cita_at: hora('15:00').toISOString(), cita_texto: 'llámenme a las 3' }];
  fake.tablas.llamada_cola = [{ id: 9, phone: 'D', estado: 'pendiente', created_at: hora('09:00').toISOString() }];
  await queue.revisarPerdidas(hora('15:40'));
  assert.equal(fake.tablas.cliente_config[0].cita_at, hora('15:00', '2026-11-06').toISOString());
  assert.equal(fake.tablas.cliente_config[0].cita_movida, 1);
  assert.match(t('llamada_cola')[0].detalle, /la hora que pidió \(15:00–15:30\)/);
});

test('ficha: "llámenme mañana a las 3" se guarda como hora pedida; fuera de rango o en el pasado, no', async () => {
  fake.reset();
  const ll = { phone: 'E', created_at: hora('11:00').toISOString() };
  const ahora = hora('11:05');
  assert.equal(await fichas.aplicarCita('E', { llamar: { fecha: '2026-11-06', hora: '15:00', texto: 'mañana a las 3' } }, ll, cfg, ahora), true);
  assert.equal(t('cliente_config')[0].cita_at, hora('15:00', '2026-11-06').toISOString());
  assert.equal(t('cliente_config')[0].cita_origen, 'ia');
  assert.equal(await fichas.aplicarCita('E', { llamar: { fecha: '2026-11-06', hora: '21:00' } }, ll, cfg, ahora), false, 'fuera de 08:00–19:00');
  assert.equal(await fichas.aplicarCita('E', { llamar: { fecha: '2026-11-04', hora: '15:00' } }, ll, cfg, ahora), false, 'ya pasó');
  // Sin fecha: hoy si la hora no pasó; si no, el siguiente día hábil (el vie 6 a las 10).
  await fichas.aplicarCita('E', { llamar: { fecha: null, hora: '10:00' } }, ll, cfg, ahora);
  assert.equal(t('cliente_config')[0].cita_at, hora('10:00', '2026-11-06').toISOString());
});

test('hora pedida de hoy: asegura una llamada (follow up si tiene promesa; si no, la principal si está prendido)', async () => {
  fake.reset();
  await sembrarConfig();
  const cli = (phone) => ({ phone, name: phone, deuda_total: 100, deuda_vencida: 50 });
  fake.tablas.cliente_config = [
    { phone: 'P', enabled: false, estado_cobro: 'promesa', cita_at: hora('15:00').toISOString() },
    { phone: 'N', enabled: true, cita_at: hora('16:00').toISOString() },
    { phone: 'X', enabled: false, cita_at: hora('16:00').toISOString() },
  ];
  fake.tablas.promesa_pago = [{ id: 30, phone: 'P', estado: 'pendiente', fecha_prometida: '2026-11-09', intento: 1 }];
  const mapa = new Map([['P', cli('P')], ['N', cli('N')], ['X', cli('X')]]);
  const r = await promesas.asegurarCitas(mapa, cfg, { ahora: hora('08:30') });
  assert.equal(r.citas_follow_up, 1);
  assert.equal(r.citas_principal, 1);
  const cola = t('llamada_cola').filter((x) => x.estado === 'pendiente');
  assert.deepEqual(cola.map((x) => `${x.phone}:${x.agente}`).sort(), ['N:principal', 'P:seguimiento']);
  assert.equal(t('promesa_pago')[0].estado, 'en_seguimiento');
  assert.equal(t('promesa_pago')[0].ventana_desde, '2026-11-05', 'la ventana empieza el día de la hora pedida');
  // Ya en la cola: no se agrega otra.
  const r2 = await promesas.asegurarCitas(mapa, cfg, { ahora: hora('08:31') });
  assert.deepEqual(r2, {});
});
