// Retiro creado a mano (super admins): ficha de retiro + promesa 'manual', que va a logística con su monto.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const fake = require('./helpers/fakeDb');
require.cache[path.resolve(__dirname, '../services/supabaseDb.js')] = { exports: fake, loaded: true, id: 'fake' };
process.env.LOGISTICA_URL = 'https://logistica.test/';
process.env.LOGISTICA_TOKEN = 'tok-integracion';
const retiroManual = require('../services/retiroManual');
const rl = require('../services/retirosLogistica');
const promesas = require('../services/promesas');
const schedule = require('../services/schedule');

const t = (n) => fake.tablas[n] || [];
const ahora = new Date('2026-11-17T15:00:00Z'); // 11:00 en RD
const cfg = schedule.DEFAULT;
const ELIGIO = { phone: '8092420891', name: 'ELIGIO VALDEZ COMERCIAL S.R.L', codigo: '252', deuda_vencida: 0 };
const clientes = [ELIGIO, { phone: '8095550002', name: 'Sin Código', codigo: null, deuda_vencida: 900 }];
const op = { datos: { clientes }, cfg, ahora };

function fetchFalso() {
  const pedidos = [];
  const f = async (url, o) => {
    pedidos.push({ url, method: o.method, body: o.body ? JSON.parse(o.body) : null });
    return { status: 200, ok: true, text: async () => JSON.stringify({ estado: 'por_asignar', ruta: null }) };
  };
  f.pedidos = pedidos;
  return f;
}

test.beforeEach(() => fake.reset());

test('crea la promesa y la ficha de retiro, y va a logística con el monto aunque no tenga vencido', async () => {
  const r = await retiroManual.crear({ phone: '809-242-0891', monto: 100, nota: 'Retiro de prueba' }, 'jorge@x', op);
  assert.equal(r.fecha, '2026-11-17', 'sin fecha: hoy');
  assert.match(r.llave, /^manual:/);
  const [p] = t('promesa_pago');
  assert.equal(p.origen, 'manual');
  assert.equal(p.monto_al_prometer, 100);
  assert.equal(p.estado, 'pendiente');
  assert.equal(p.llamada_key, r.llave);
  const [f] = t('llamada_ficha');
  assert.equal(f.modalidad, 'retiro');
  assert.equal(f.retiro.texto, 'Retiro de prueba');
  assert.equal(f.retiro.fecha, '2026-11-17');
  assert.equal(t('cliente_config')[0].estado_cobro, 'promesa');

  // El motor lo manda a logística con su monto.
  const fx = fetchFalso();
  const s = await rl.sincronizar({ datos: { clientes }, fetchImpl: fx });
  assert.equal(s.enviados, 1);
  assert.equal(fx.pedidos[0].method, 'PUT');
  assert.equal(fx.pedidos[0].body.montoEsperado, 100);
  assert.equal(fx.pedidos[0].body.clienteCodigo, '252');
  assert.equal(fx.pedidos[0].body.frase, 'Retiro de prueba');

  // Sin vencido no se da por cumplida (sí se cerraría una promesa normal).
  await promesas.revisarAbiertas(new Map([[ELIGIO.phone, ELIGIO]]), cfg, { ahora: new Date('2026-11-18T15:00:00Z') });
  assert.equal(t('promesa_pago')[0].estado, 'pendiente');

  // Un segundo retiro para el mismo cliente no se duplica.
  await assert.rejects(retiroManual.crear({ phone: ELIGIO.phone, monto: 50 }, null, op), /ya tiene un retiro abierto/);
});

test('"No es retiro" sobre uno a mano cierra su promesa', async () => {
  const r = await retiroManual.crear({ phone: ELIGIO.phone, monto: 100 }, null, op);
  assert.equal(await retiroManual.deshacer('log:123'), false, 'solo los creados a mano');
  assert.equal(await retiroManual.deshacer(r.llave, 'jorge@x'), true);
  const [p] = t('promesa_pago');
  assert.equal(p.estado, 'cancelada');
  assert.equal(p.motivo_cierre, 'retiro a mano deshecho por jorge@x');
  assert.equal(await retiroManual.deshacer(r.llave), false, 'ya estaba cerrada');
});

test('valida monto, fecha y cliente', async () => {
  await assert.rejects(retiroManual.crear({ phone: ELIGIO.phone, monto: 0 }, null, op), /monto/);
  await assert.rejects(retiroManual.crear({ phone: ELIGIO.phone, monto: 'abc' }, null, op), /monto/);
  await assert.rejects(retiroManual.crear({ phone: ELIGIO.phone, monto: 10, fecha: '2026-11-16' }, null, op), /hoy o después/);
  await assert.rejects(retiroManual.crear({ phone: '8090000000', monto: 10 }, null, op), /no está en la cartera/);
  await assert.rejects(retiroManual.crear({ phone: '8095550002', monto: 10 }, null, op), /no tiene código/);
  await assert.rejects(retiroManual.crear({ phone: '123', monto: 10 }, null, op), /Teléfono/);
  const r = await retiroManual.crear({ phone: ELIGIO.phone, monto: 100, fecha: '2026-11-19' }, null, op);
  assert.equal(r.fecha, '2026-11-19');
  assert.equal(t('promesa_pago').length, 1);
});
