// Recorrido completo del motor con la base en memoria (sin Supabase ni OpenAI).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const fake = require('./helpers/fakeDb');
require.cache[path.resolve(__dirname, '../services/supabaseDb.js')] = { exports: fake, loaded: true, id: 'fake' };
delete process.env.OPENAI_API_KEY;
const promesas = require('../services/promesas');
const queue = require('../services/queue');

const TEL = '8095550001';
const cliente = { phone: TEL, name: 'Ferretería Uno', empresa: 'Ferretería Uno', deuda_total: 20000, deuda_vencida: 8000, credito_ofrecido: 0 };
const cfg = { promesaTope: 3, promesaMaxAtraso: 7, reintentoHoras: 2 };
const hoyISO = () => new Date().toISOString();
const clientes = () => new Map([[TEL, { ...cliente, _prueba: true }]]); // mismo día permitido (como un número de prueba)
const t = (n) => fake.tablas[n] || [];
const config = () => t('cliente_config').find((r) => r.phone === TEL) || {};
let idLlamada = 1000;
const llamada = (extra) => ({ id: ++idLlamada, phone: TEL, name: cliente.name, created_at: hoyISO(), fecha_pago: '', transcripcion: '', resultado: 'answered', ...extra });

test('ciclo: promete hoy -> se apaga -> follow up en cola -> no contesta -> reintento -> da fecha -> ya pagó', async () => {
  fake.reset();
  fake.tablas.cliente_config = [{ phone: TEL, enabled: true }];

  // 1) Llamada normal: "pago hoy" (sin IA: pago_inmediato usa el día de la llamada).
  let r = await promesas.procesarLlamadas([llamada({ agente: 'cobranzas', intencion_pago: 'pago_inmediato' })], clientes(), cfg);
  assert.equal(r.nueva_promesa, 1);
  assert.equal(t('promesa_pago').length, 1);
  assert.equal(config().enabled, false, 'se apaga el agente normal');
  assert.equal(config().estado_cobro, 'promesa');
  assert.equal(config().enabled_antes, true);

  // La misma llamada no se procesa dos veces.
  r = await promesas.procesarLlamadas([{ ...t('llamada_procesada')[0], id: idLlamada, phone: TEL, created_at: hoyISO(), agente: 'cobranzas', intencion_pago: 'pago_inmediato' }], clientes(), cfg);
  assert.equal(r.nuevas, 0);

  // 2) Ese día: sigue con vencido -> follow up a la cola, con su promesa y fecha.
  r = await promesas.revisarAbiertas(clientes(), cfg);
  assert.equal(r.follow_ups_encolados, 1);
  const cola = t('llamada_cola').filter((x) => x.estado === 'pendiente');
  assert.equal(cola.length, 1);
  assert.equal(cola[0].agente, 'seguimiento');
  assert.equal(cola[0].promesa_id, String(t('promesa_pago')[0].id));
  assert.ok(cola[0].fecha_prometida);
  assert.equal(t('promesa_pago')[0].estado, 'en_seguimiento');

  // 3) El follow up no contesta -> reintento 1 (a las 2 h).
  cola[0].estado = 'enviada';
  r = await promesas.procesarLlamadas([llamada({ agente: 'seguimiento', intencion_pago: 'no_contesta', resultado: 'no_answer' })], clientes(), cfg);
  assert.equal(r.reintento, 1);
  assert.equal(t('promesa_pago')[0].reintentos, 1);
  assert.ok(t('promesa_pago')[0].proximo_intento_at);

  // Llega la hora del reintento -> vuelve a la cola.
  t('promesa_pago')[0].proximo_intento_at = new Date(Date.now() - 1000).toISOString();
  r = await promesas.revisarAbiertas(clientes(), cfg);
  assert.equal(r.reintentos_encolados, 1);

  // 4) Contesta y da otra fecha -> promesa 2, la 1 queda reprogramada.
  t('llamada_cola').forEach((x) => { x.estado = 'enviada'; });
  const promesa1 = t('promesa_pago')[0];
  await promesas.procesarLlamadas([llamada({ agente: 'seguimiento', intencion_pago: 'pago_inmediato' })], clientes(), cfg);
  assert.equal(promesa1.estado, 'reprogramada');
  const promesa2 = t('promesa_pago').find((p) => p.estado === 'pendiente');
  assert.equal(promesa2.intento, 2);
  assert.equal(promesa2.promesa_anterior_id, String(promesa1.id));
  assert.equal(config().estado_cobro, 'promesa');
  assert.equal(config().enabled_antes, true, 'recuerda que estaba prendido');

  // 5) Dice que ya pagó -> "dice que pagó", apagado.
  await promesas.procesarLlamadas([llamada({ agente: 'cobranzas', intencion_pago: 'ya_pago' })], clientes(), cfg);
  assert.equal(promesa2.estado, 'dice_pago');
  assert.equal(config().estado_cobro, 'dice_pago');
  assert.equal(config().enabled, false);
});

test('follow up sin fecha -> vuelve a la lista normal como estaba', async () => {
  fake.reset();
  fake.tablas.cliente_config = [{ phone: TEL, enabled: true }];
  await promesas.procesarLlamadas([llamada({ agente: 'cobranzas', intencion_pago: 'pago_inmediato' })], clientes(), cfg);
  await promesas.revisarAbiertas(clientes(), cfg);
  t('llamada_cola').forEach((x) => { x.estado = 'enviada'; });
  await promesas.procesarLlamadas([llamada({ agente: 'seguimiento', intencion_pago: 'evasivo' })], clientes(), cfg);
  assert.equal(t('promesa_pago')[0].estado, 'incumplida');
  assert.equal(config().estado_cobro, null);
  assert.equal(config().enabled, true, 'vuelve a estar prendido');
});

test('si ya no tiene vencido el día prometido, la promesa se cumple y no se llama', async () => {
  fake.reset();
  fake.tablas.cliente_config = [{ phone: TEL, enabled: false }];
  await promesas.procesarLlamadas([llamada({ agente: 'cobranzas', intencion_pago: 'pago_inmediato' })], clientes(), cfg);
  const pagado = new Map([[TEL, { ...cliente, deuda_vencida: 0 }]]);
  const r = await promesas.revisarAbiertas(pagado, cfg);
  assert.equal(r.cumplidas, 1);
  assert.equal(t('llamada_cola').length, 0);
  assert.equal(config().enabled, false, 'estaba apagado antes: queda apagado');
  assert.equal(config().estado_cobro, null);
});

test('el follow up reemplaza la llamada normal pendiente del mismo cliente', async () => {
  fake.reset();
  await queue.enqueue([cliente], 'cron', null, 'principal');
  await queue.enqueue([{ ...cliente, promesa_id: '9', fecha_prometida: '2026-11-04' }], 'seguimiento', null, 'seguimiento');
  const pend = t('llamada_cola').filter((x) => x.estado === 'pendiente');
  assert.equal(pend.length, 1);
  assert.equal(pend[0].agente, 'seguimiento');
  assert.equal(t('llamada_cola').find((x) => x.agente === 'principal').detalle, 'reemplazada por follow up');
});

test('cliente real que promete "hoy": el follow up no sale hasta el día siguiente', async () => {
  fake.reset();
  fake.tablas.cliente_config = [{ phone: TEL, enabled: true }];
  const real = new Map([[TEL, cliente]]);
  await promesas.procesarLlamadas([llamada({ agente: 'cobranzas', intencion_pago: 'pago_inmediato' })], real, cfg);
  const r = await promesas.revisarAbiertas(real, cfg);
  assert.equal(r.follow_ups_encolados, undefined);
  assert.equal(t('llamada_cola').length, 0);
  // Al día siguiente (la llamada fue "ayer") sí se encola.
  t('promesa_pago')[0].fecha_llamada = new Date(Date.now() - 86400000).toISOString();
  t('promesa_pago')[0].fecha_prometida = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const r2 = await promesas.revisarAbiertas(real, cfg);
  assert.equal(r2.follow_ups_encolados, 1);
});
