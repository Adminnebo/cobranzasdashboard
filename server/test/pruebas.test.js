// Números de prueba como clientes ficticios (solo super admins, no cuentan).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const fake = require('./helpers/fakeDb');
require.cache[path.resolve(__dirname, '../services/supabaseDb.js')] = { exports: fake, loaded: true, id: 'fake' };
const pruebas = require('../services/pruebas');

test('cada número de prueba es un cliente ficticio con vencido, con su nota como nombre', async () => {
  fake.reset();
  fake.tablas.numeros_prueba = [
    { phone: '3395658425', nota: 'Nebo Support Edmond' },
    { phone: '8095550009', nota: null },
    { phone: '8095550001', nota: 'ya es cliente real' },
  ];
  const reales = [{ phone: '8095550001', name: 'Ferretería Uno' }];
  const f = await pruebas.clientesFicticios(reales);
  assert.equal(f.length, 2, 'no duplica a un cliente real');
  assert.equal(f[0].name, 'Nebo Support Edmond');
  assert.equal(f[1].name, 'Número de prueba');
  assert.equal(f[0].deuda_vencida, 12500);
  assert.equal(f[0]._prueba, true);
});
