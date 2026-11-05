// Cobros detectados comparando fotos diarias de la cartera del ERP.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const fake = require('./helpers/fakeDb');
require.cache[path.resolve(__dirname, '../services/supabaseDb.js')] = { exports: fake, loaded: true, id: 'fake' };
const cobros = require('../services/cobros');

const t = (n) => fake.tablas[n] || [];
const fac = (SecFact, Cliente, Total, Resta, extra = {}) => ({ SecFact, nFactura: SecFact + 1000, Cliente, Empresa: 2, Fecha: '2026-11-01T10:00:00Z', Vencimiento: '2026-12-01T10:00:00Z', Total, Resta, ...extra });
const cli = (Codigo, Balance, Vencido = 0) => ({ Codigo, Balance, Vencido, Limite: 5000 });
const erp = (facturas, clientes = []) => async () => ({ facturas, clientes });
// Mediodía en Santo Domingo (UTC-4) del día dado.
const dia = (ymd) => new Date(`${ymd}T16:00:00Z`);

test.beforeEach(() => fake.reset());

test('la primera foto se guarda pero no detecta cobros', async () => {
  const r = await cobros.tomarFoto({ leer: erp([fac(1, 10, 100, 100), fac(2, 10, 50, 20)], [cli(10, 120)]), ahora: dia('2026-11-05') });
  assert.equal(r.fecha, '2026-11-05');
  assert.equal(r.facturas, 2);
  assert.equal(r.cobros, 0);
  assert.equal(r.desde, null);
  assert.equal(t('cxc_factura_foto').length, 2);
  assert.equal(t('cxc_cliente_foto').length, 1);
  assert.equal(t('cxc_foto')[0].completa, true);
  assert.equal(t('cobro_detectado').length, 0);
});

test('abono, saldada, inicial; las facturas nuevas sin pago y las que suben no cuentan', async () => {
  await cobros.tomarFoto({ leer: erp([fac(1, 10, 100, 100), fac(2, 10, 50, 50), fac(3, 20, 80, 80), fac(4, 30, 10, 10)]), ahora: dia('2026-11-05') });
  const r = await cobros.tomarFoto({
    leer: erp([
      fac(1, 10, 100, 60),        // abono de 40
      // la 2 desapareció: saldada 50
      fac(3, 20, 80, 90),         // subió (ajuste): no es cobro
      fac(4, 30, 10, 1e-13),      // quedó en residuo: saldada 10
      fac(5, 20, 200, 200),       // nueva sin pago
      fac(6, 30, 300, 100),       // nueva con 200 pagados
    ]),
    ahora: dia('2026-11-06'),
  });
  assert.equal(r.desde, '2026-11-05');
  const porSec = Object.fromEntries(t('cobro_detectado').map((c) => [c.sec_fact, c]));
  assert.deepEqual(Object.keys(porSec).map(Number).sort((a, b) => a - b), [1, 2, 4, 6]);
  assert.equal(porSec[1].tipo, 'abono'); assert.equal(porSec[1].monto, 40); assert.equal(porSec[1].resta_despues, 60);
  assert.equal(porSec[2].tipo, 'saldada'); assert.equal(porSec[2].monto, 50); assert.equal(porSec[2].cliente, 10);
  assert.equal(porSec[4].tipo, 'saldada'); assert.equal(porSec[4].monto, 10);
  assert.equal(porSec[6].tipo, 'inicial'); assert.equal(porSec[6].monto, 200);
  assert.equal(r.cobrado, 300);
  assert.equal(porSec[1].fecha, '2026-11-06');
  assert.equal(porSec[1].desde, '2026-11-05');
});

test('repetir la foto del mismo día la reemplaza sin duplicar cobros', async () => {
  await cobros.tomarFoto({ leer: erp([fac(1, 10, 100, 100), fac(2, 10, 50, 50)]), ahora: dia('2026-11-05') });
  await cobros.tomarFoto({ leer: erp([fac(1, 10, 100, 70), fac(2, 10, 50, 50)]), ahora: dia('2026-11-06') });
  const r = await cobros.tomarFoto({ leer: erp([fac(1, 10, 100, 40), fac(2, 10, 50, 50)]), ahora: new Date('2026-11-07T01:00:00Z') }); // 21:00 del 6 en RD
  assert.equal(r.fecha, '2026-11-06');
  assert.equal(r.desde, '2026-11-05');
  const delDia = t('cobro_detectado').filter((c) => c.fecha === '2026-11-06');
  assert.equal(delDia.length, 1);
  assert.equal(delDia[0].monto, 60);
  assert.equal(t('cxc_factura_foto').filter((f) => f.fecha === '2026-11-06').length, 2);
  assert.equal(t('cxc_foto').length, 2);
});

test('si faltan días compara con la última foto completa', async () => {
  await cobros.tomarFoto({ leer: erp([fac(1, 10, 100, 100), fac(2, 10, 50, 50)]), ahora: dia('2026-11-05') });
  fake.tablas.cxc_foto.push({ fecha: '2026-11-06', completa: false, facturas: null }); // una foto que se cortó a mitad
  const r = await cobros.tomarFoto({ leer: erp([fac(1, 10, 100, 30), fac(2, 10, 50, 50)]), ahora: dia('2026-11-08') });
  assert.equal(r.desde, '2026-11-05');
  assert.equal(r.cobrado, 70);
});

test('una sincronización a medias del ERP no se guarda ni inventa cobros', async () => {
  const muchas = Array.from({ length: 10 }, (_, i) => fac(i + 1, 10, 100, 100));
  await cobros.tomarFoto({ leer: erp(muchas), ahora: dia('2026-11-05') });
  await assert.rejects(cobros.tomarFoto({ leer: erp(muchas.slice(0, 3)), ahora: dia('2026-11-06') }), /a medias/);
  await assert.rejects(cobros.tomarFoto({ leer: erp([]), ahora: dia('2026-11-06') }), /0 facturas/);
  assert.equal(t('cobro_detectado').length, 0);
  assert.deepEqual(t('cxc_foto').map((f) => f.fecha), ['2026-11-05']);
});

test('resumen por día y por cliente; detalle de un cliente', async () => {
  await cobros.tomarFoto({ leer: erp([fac(1, 10, 100, 100), fac(2, 20, 50, 50), fac(3, 20, 40, 40)], [cli(10, 100), cli(20, 90)]), ahora: dia('2026-11-05') });
  await cobros.tomarFoto({ leer: erp([fac(1, 10, 100, 80), fac(3, 20, 40, 40)], [cli(10, 80), cli(20, 40)]), ahora: dia('2026-11-06') });
  await cobros.tomarFoto({ leer: erp([fac(1, 10, 100, 50)], [cli(10, 50)]), ahora: dia('2026-11-07') });

  const r = await cobros.resumen({});
  assert.equal(r.total, 20 + 50 + 30 + 40);
  assert.equal(r.fotos, 3);
  assert.equal(r.primeraFoto, '2026-11-05');
  assert.equal(r.ultimaFoto.fecha, '2026-11-07');
  assert.deepEqual(r.dias.map((d) => [d.fecha, d.monto, d.clientes]), [['2026-11-06', 70, 2], ['2026-11-07', 70, 2]]);
  assert.deepEqual(r.clientes.map((c) => [c.codigo, c.monto, c.facturas, c.ultimo]), [['20', 90, 2, '2026-11-07'], ['10', 50, 2, '2026-11-07']]);

  const solo7 = await cobros.resumen({ desde: '2026-11-07', hasta: '2026-11-07' });
  assert.equal(solo7.total, 70);

  const d = await cobros.deCliente('10');
  assert.equal(d.cobros.length, 2);
  assert.equal(d.cobros[0].fecha, '2026-11-07');
  assert.deepEqual(d.saldos.map((s) => s.balance), [100, 80, 50]);
});

test('lee todas las páginas de la foto anterior (más de 1000 facturas)', async () => {
  const antes = Array.from({ length: 2500 }, (_, i) => fac(i + 1, 10, 10, 10));
  await cobros.tomarFoto({ leer: erp(antes), ahora: dia('2026-11-05') });
  const r = await cobros.tomarFoto({ leer: erp(antes.slice(0, 2400)), ahora: dia('2026-11-06') });
  assert.equal(r.cobros, 100);
  assert.equal(r.cobrado, 1000);
});
