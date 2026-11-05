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

  // 3) El follow up no contesta -> sigue en la ventana (reintento a las 2 h o mañana).
  assert.ok(t('promesa_pago')[0].ventana_desde && t('promesa_pago')[0].ventana_hasta, 'guarda su ventana');
  cola[0].estado = 'enviada';
  r = await promesas.procesarLlamadas([llamada({ agente: 'seguimiento', intencion_pago: 'no_contesta', resultado: 'no_answer' })], clientes(), cfg);
  assert.equal(r.seguir, 1);
  assert.equal(t('promesa_pago')[0].estado, 'en_seguimiento');
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

test('follow up sin fecha: sigue en la ventana; en su último día vuelve a la lista normal como estaba', async () => {
  fake.reset();
  fake.tablas.cliente_config = [{ phone: TEL, enabled: true }];
  await promesas.procesarLlamadas([llamada({ agente: 'cobranzas', intencion_pago: 'pago_inmediato' })], clientes(), cfg);
  await promesas.revisarAbiertas(clientes(), cfg);
  t('llamada_cola').forEach((x) => { x.estado = 'enviada'; });
  await promesas.procesarLlamadas([llamada({ agente: 'seguimiento', intencion_pago: 'evasivo' })], clientes(), cfg);
  assert.equal(t('promesa_pago')[0].estado, 'en_seguimiento', 'ventana de 7 días: sigue');

  // Con una ventana de 1 día, hoy es el último: contesta sin fecha y vuelve a la lista normal.
  fake.reset();
  fake.tablas.cliente_config = [{ phone: TEL, enabled: true }];
  const cfg1 = { ...cfg, fuVentanaDias: 1 };
  await promesas.procesarLlamadas([llamada({ agente: 'cobranzas', intencion_pago: 'pago_inmediato' })], clientes(), cfg1);
  await promesas.revisarAbiertas(clientes(), cfg1);
  t('llamada_cola').forEach((x) => { x.estado = 'enviada'; });
  await promesas.procesarLlamadas([llamada({ agente: 'seguimiento', intencion_pago: 'evasivo' })], clientes(), cfg1);
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

test('promete "hoy": el follow up sale N días hábiles después (mínimo el siguiente día hábil)', async () => {
  fake.reset();
  fake.tablas.cliente_config = [{ phone: TEL, enabled: true }];
  const real = new Map([[TEL, cliente]]);
  const cfg1 = { ...cfg, followUpMargenDias: 1 };
  await promesas.procesarLlamadas([llamada({ agente: 'cobranzas', intencion_pago: 'pago_inmediato' })], real, cfg1);
  const r = await promesas.revisarAbiertas(real, cfg1);
  assert.equal(r.follow_ups_encolados, undefined, 'hoy no sale');
  assert.equal(t('llamada_cola').length, 0);
  // Si la fecha fue hace 3 días, el siguiente día hábil ya pasó: sale.
  const hace3 = new Date(Date.now() - 3 * 86400000).toISOString();
  t('promesa_pago')[0].fecha_llamada = hace3;
  t('promesa_pago')[0].fecha_prometida = hace3.slice(0, 10);
  const r2 = await promesas.revisarAbiertas(real, cfg1);
  assert.equal(r2.follow_ups_encolados, 1);
});

test('si la cola no acepta el follow up (IVR), la promesa se cierra sin llamada, no como "no contestó"', async () => {
  fake.reset();
  fake.tablas.cliente_config = [{ phone: TEL, enabled: true }];
  await promesas.procesarLlamadas([llamada({ agente: 'cobranzas', intencion_pago: 'pago_inmediato' })], clientes(), cfg);
  fake.tablas.cliente_config[0].ivr = true; // cae en IVR antes del follow up
  const r = await promesas.revisarAbiertas(clientes(), cfg);
  assert.equal(r.sin_llamada, 1);
  assert.equal(t('promesa_pago')[0].estado, 'sin_llamada');
  assert.equal(t('promesa_pago')[0].reintentos || 0, 0);
  assert.equal(config().enabled, false);
  assert.equal(config().estado_cobro, null);
});

test('follow up ya pendiente en cola (sin el id de esta promesa) no cuenta como sin resultado', async () => {
  fake.reset();
  fake.tablas.cliente_config = [{ phone: TEL, enabled: true }];
  await promesas.procesarLlamadas([llamada({ agente: 'cobranzas', intencion_pago: 'pago_inmediato' })], clientes(), cfg);
  await promesas.revisarAbiertas(clientes(), cfg);
  t('llamada_cola')[0].promesa_id = 'otra';
  const r = await promesas.revisarAbiertas(clientes(), cfg);
  assert.deepEqual(r, {});
  assert.equal(t('promesa_pago')[0].reintentos || 0, 0);
});

test('forzar follow up: sin vencido la promesa no se cierra y el follow up se marca igual', async () => {
  fake.reset();
  fake.tablas.cliente_config = [{ phone: TEL, enabled: true }];
  const alDia = { ...cliente, deuda_vencida: 0 };
  await promesas.procesarLlamadas([llamada({ agente: 'cobranzas', intencion_pago: 'pago_inmediato' })], new Map([[TEL, alDia]]), cfg);
  // Sin forzar: se cierra como cumplida.
  let r = await promesas.revisarAbiertas(new Map([[TEL, alDia]]), cfg);
  assert.equal(r.cumplidas, 1);
  // Forzado: otra promesa, queda abierta y va a la cola.
  await promesas.procesarLlamadas([llamada({ agente: 'cobranzas', intencion_pago: 'pago_inmediato' })], new Map([[TEL, alDia]]), cfg);
  r = await promesas.revisarAbiertas(new Map([[TEL, { ...alDia, _forzar: true }]]), cfg);
  assert.equal(r.cumplidas, undefined);
  assert.equal(r.follow_ups_encolados, 1);
});

test('forzar follow up con IVR: el follow up entra a la cola igual (la llamada normal no)', async () => {
  fake.reset();
  fake.tablas.cliente_config = [{ phone: TEL, enabled: true }];
  await promesas.procesarLlamadas([llamada({ agente: 'cobranzas', intencion_pago: 'pago_inmediato' })], clientes(), cfg);
  Object.assign(fake.tablas.cliente_config[0], { ivr: true, forzar_follow_up: true });
  const r = await promesas.revisarAbiertas(clientes(), cfg);
  assert.equal(r.follow_ups_encolados, 1);
  assert.equal(t('promesa_pago')[0].estado, 'en_seguimiento');
  const normal = await queue.enqueue([cliente], 'bulk', null, 'principal');
  assert.equal(normal.omitidosIvr, 1, 'la llamada normal sigue filtrada por IVR');
});

test('reabrir una promesa cerrada sin llamada: vuelve a esperar y el motor la encola', async () => {
  fake.reset();
  fake.tablas.cliente_config = [{ phone: TEL, enabled: true }];
  await promesas.procesarLlamadas([llamada({ agente: 'cobranzas', intencion_pago: 'pago_inmediato' })], clientes(), cfg);
  fake.tablas.cliente_config[0].ivr = true;
  await promesas.revisarAbiertas(clientes(), cfg);
  const p = t('promesa_pago')[0];
  assert.equal(p.estado, 'sin_llamada');
  await assert.rejects(() => promesas.reabrir('no-existe'), /no existe/);

  fake.tablas.cliente_config[0].forzar_follow_up = true;
  await promesas.reabrir(p.id, 'yo@nebo');
  assert.equal(p.estado, 'pendiente');
  assert.equal(p.cerrada_at, null);
  assert.equal(config().estado_cobro, 'promesa');
  await assert.rejects(() => promesas.reabrir(p.id), /ya está abierta/);
  const r = await promesas.revisarAbiertas(clientes(), cfg);
  assert.equal(r.follow_ups_encolados, 1);
  assert.equal(t('llamada_cola').filter((x) => x.estado === 'pendiente' && x.agente === 'seguimiento').length, 1);
});

test('margen: "pago mañana" no llama el día prometido sino el día hábil siguiente', async () => {
  fake.reset();
  fake.tablas.cliente_config = [{ phone: TEL, enabled: true }];
  const ayer = new Date(Date.now() - 86400000).toISOString();
  const hoyYmd = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santo_Domingo' }).format(new Date());
  // Promesa hecha ayer para hoy.
  fake.tablas.promesa_pago = [{ id: 'p1', phone: TEL, estado: 'pendiente', fecha_prometida: hoyYmd, fecha_llamada: ayer, intento: 1, created_at: ayer }];
  let r = await promesas.revisarAbiertas(clientes(), { ...cfg, followUpMargenDias: 1 });
  assert.equal(r.follow_ups_encolados, undefined, 'con margen 1 hoy no sale');
  assert.equal(t('promesa_pago')[0].estado, 'pendiente');
  r = await promesas.revisarAbiertas(clientes(), { ...cfg, followUpMargenDias: 0 });
  assert.equal(r.follow_ups_encolados, 1, 'sin margen sale el mismo día');
});

test('cola: a quien desapareció de la cartera (pagó todo) no se le llama; sin cartera no se marca', () => {
  const item = { id: 1, phone: TEL, deuda_vencida: 8000 };
  const pruebasSet = new Set(['3395658425']);
  assert.equal(queue.decidirAlMarcar(item, { clientes: [cliente], pruebasSet }).accion, 'llamar');
  const fuera = queue.decidirAlMarcar(item, { clientes: [{ ...cliente, phone: '8090000000' }], pruebasSet });
  assert.equal(fuera.accion, 'cancelar');
  assert.match(fuera.motivo, /ya no está en la cartera/);
  assert.equal(queue.decidirAlMarcar({ id: 2, phone: '3395658425' }, { clientes: [cliente], pruebasSet }).accion, 'llamar', 'número de prueba');
  assert.equal(queue.decidirAlMarcar(item, { clientes: [{ ...cliente, deuda_vencida: 0 }], pruebasSet }).accion, 'cancelar');
  assert.equal(queue.decidirAlMarcar(item, { clientes: [{ ...cliente, deuda_vencida: 0 }], pruebasSet, forzado: true }).accion, 'llamar');
  assert.equal(queue.decidirAlMarcar(item, { clientes: [], pruebasSet }).accion, 'esperar');
});

test('motor: si el cliente desaparece de la cartera, a la hora su promesa queda cumplida', async () => {
  fake.reset();
  fake.tablas.cliente_config = [{ phone: TEL, enabled: true }];
  await promesas.procesarLlamadas([llamada({ agente: 'cobranzas', intencion_pago: 'fecha_especifica', fecha_pago: '' })], clientes(), cfg);
  // Promesa abierta a mano (sin IA para la fecha).
  fake.tablas.promesa_pago = [{ id: 77, phone: TEL, estado: 'pendiente', fecha_prometida: '2026-11-20', intento: 1 }];
  fake.tablas.cliente_config = [{ phone: TEL, enabled: false, estado_cobro: 'promesa', enabled_antes: true }];
  const vacia = new Map();
  const t0 = new Date('2026-11-10T14:00:00Z');
  await promesas.revisarAbiertas(vacia, cfg, { ahora: t0, carteraOk: false });
  await promesas.revisarAbiertas(vacia, cfg, { ahora: new Date(t0.getTime() + 3 * 3600000), carteraOk: false });
  assert.equal(t('promesa_pago')[0].estado, 'pendiente', 'cartera incompleta: no se toca');
  await promesas.revisarAbiertas(vacia, cfg, { ahora: t0 });
  assert.equal(t('promesa_pago')[0].estado, 'pendiente', 'recién falta: espera');
  const r = await promesas.revisarAbiertas(vacia, cfg, { ahora: new Date(t0.getTime() + 61 * 60000) });
  assert.equal(r.cumplidas_sin_cartera, 1);
  assert.equal(t('promesa_pago')[0].estado, 'cumplida');
  assert.match(t('promesa_pago')[0].motivo_cierre, /deuda total en 0/);
  assert.equal(config().estado_cobro, null);
  assert.equal(config().enabled, true, 'vuelve como estaba');
});

test('estados: "dice que pagó" con vencido en 0 vuelve a la normalidad; "pasar a una persona" no se toca', async () => {
  fake.reset();
  fake.tablas.promesa_pago = [];
  fake.tablas.cliente_config = [
    { phone: TEL, enabled: false, estado_cobro: 'dice_pago', enabled_antes: true },
    { phone: '8095550002', enabled: false, estado_cobro: 'escalar', enabled_antes: true },
  ];
  const mapa = new Map([[TEL, { ...cliente, deuda_vencida: 0 }], ['8095550002', { ...cliente, phone: '8095550002', deuda_vencida: 0 }]]);
  const r = await promesas.limpiarEstados(mapa);
  assert.equal(r.dice_pago_confirmado, 1);
  assert.equal(config().estado_cobro, null);
  assert.equal(config().enabled, true);
  assert.equal(t('cliente_config').find((x) => x.phone === '8095550002').estado_cobro, 'escalar');
  // Con vencido sigue en pausa.
  fake.tablas.cliente_config[0] = { phone: TEL, enabled: false, estado_cobro: 'dice_pago', enabled_antes: true };
  await promesas.limpiarEstados(new Map([[TEL, cliente]]));
  assert.equal(config().estado_cobro, 'dice_pago');
});

test('ventana: al acabarse sin fecha nueva cancela el follow up en cola y vuelve al agente principal', async () => {
  fake.reset();
  fake.tablas.cliente_config = [{ phone: TEL, enabled: false, estado_cobro: 'promesa', enabled_antes: true }];
  fake.tablas.promesa_pago = [{ id: 50, phone: TEL, estado: 'en_seguimiento', fecha_prometida: '2026-11-09', intento: 1,
    ventana_desde: '2026-11-11', ventana_hasta: '2026-11-17', proximo_intento_at: '2026-11-18T04:00:00.000Z' }];
  fake.tablas.llamada_cola = [{ id: 9, phone: TEL, agente: 'seguimiento', estado: 'pendiente', promesa_id: '50' }];
  const r = await promesas.revisarAbiertas(new Map([[TEL, cliente]]), cfg, { ahora: new Date('2026-11-18T14:00:00Z') });
  assert.equal(r.fin_ventana_incumplida, 1);
  assert.equal(t('promesa_pago')[0].estado, 'incumplida');
  assert.equal(t('llamada_cola')[0].estado, 'cancelada');
  assert.equal(config().estado_cobro, null);
  assert.equal(config().enabled, true, 'vuelve al agente principal como estaba');
});

test('ventana: una promesa a la que nunca se pudo llamar en su ventana se cierra como vieja', async () => {
  fake.reset();
  fake.tablas.cliente_config = [{ phone: TEL, enabled: false, estado_cobro: 'promesa', enabled_antes: true }];
  fake.tablas.promesa_pago = [{ id: 51, phone: TEL, estado: 'pendiente', fecha_prometida: '2026-11-02', intento: 1 }];
  const r = await promesas.revisarAbiertas(new Map([[TEL, cliente]]), { ...cfg, followUpMargenDias: 1, fuVentanaDias: 7 }, { ahora: new Date('2026-11-12T14:00:00Z') });
  assert.equal(r.viejas, 1);
  assert.equal(t('llamada_cola').length, 0);
});

test('ventana: promesa que ya estaba en follow up sin ventana la empieza hoy', async () => {
  fake.reset();
  fake.tablas.cliente_config = [{ phone: TEL, enabled: false, estado_cobro: 'promesa', enabled_antes: true }];
  fake.tablas.promesa_pago = [{ id: 52, phone: TEL, estado: 'en_seguimiento', fecha_prometida: '2026-10-20', intento: 1, proximo_intento_at: '2026-11-12T04:00:00.000Z' }];
  await promesas.revisarAbiertas(new Map([[TEL, cliente]]), { ...cfg, fuVentanaDias: 7 }, { ahora: new Date('2026-11-12T14:00:00Z') });
  assert.equal(t('promesa_pago')[0].ventana_desde, '2026-11-12');
  assert.equal(t('promesa_pago')[0].ventana_hasta, '2026-11-18');
  assert.equal(t('promesa_pago')[0].estado, 'en_seguimiento');
});
