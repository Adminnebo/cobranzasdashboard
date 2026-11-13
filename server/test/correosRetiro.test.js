// Correos con "pago listo para retirar" → ficha de retiro + promesa, como un retiro pedido en una llamada.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const fake = require('./helpers/fakeDb');
require.cache[path.resolve(__dirname, '../services/supabaseDb.js')] = { exports: fake, loaded: true, id: 'fake' };
const correosRetiro = require('../services/correosRetiro');
const schedule = require('../services/schedule');

const t = (n) => fake.tablas[n] || [];
const ahora = new Date('2026-11-12T15:00:00Z'); // 11:00 en RD
const cfg = schedule.DEFAULT;
const clientes = [
  { phone: '8095550001', name: 'Ferretería Uno', codigo: 'C1', email: 'pagos@uno.com', deuda_vencida: 5000 },
  { phone: '8095550002', name: 'Colmado Dos', codigo: 'C2', email: 'dos@dos.com', deuda_vencida: 0 },
];
const listo = (id, extra = {}) => ({
  id, mio: false, de: 'Ana <pagos@uno.com>', fecha: '2026-11-11T14:00:00Z',
  etiqueta: { categoria: 'pago_listo', resumen: 'Tienen cheque disponible', fecha: null, version: 3, ...extra },
});
const correo = (mensajes, datos = { codigo: 'C1' }, para = ['pagos@uno.com']) => ({ id: 's1', hilo: 'h1', fecha: '2026-11-10T10:00:00Z', datos, para, mensajes: [{ id: 's1', mio: true }, ...mensajes] });

test.beforeEach(() => fake.reset());

test('pago listo → ficha de retiro y promesa abierta con la llave del correo; una sola vez', async () => {
  const correos = [correo([listo('r1', { fecha: '2026-11-14', retiro: { franja: 'tarde', frase: 'Pueden pasar el viernes en la tarde' } })])];
  const r = await correosRetiro.crear(correos, { ahora, datos: { clientes }, cfg });
  assert.equal(r.nuevos, 1);
  const [f] = t('llamada_ficha');
  assert.equal(f.llamada_key, 'correo:r1');
  assert.equal(f.modalidad, 'retiro');
  assert.equal(f.phone, '8095550001');
  assert.deepEqual(f.retiro, { fecha: '2026-11-14', franja: 'tarde', desde: cfg.retiroTarde.desde, hasta: cfg.retiroTarde.hasta, texto: 'Pueden pasar el viernes en la tarde' });
  const [p] = t('promesa_pago');
  assert.equal(p.llamada_key, 'correo:r1');
  assert.equal(p.estado, 'pendiente');
  assert.equal(p.origen, 'correo');
  assert.equal(p.fecha_prometida, '2026-11-14');
  assert.equal(p.monto_al_prometer, 5000);
  assert.equal(t('cliente_config')[0].estado_cobro, 'promesa');

  const otra = await correosRetiro.crear(correos, { ahora, datos: { clientes }, cfg });
  assert.equal(otra.nuevos, 0);
  assert.equal(t('promesa_pago').length, 1);
});

test('sin día (o un día que ya pasó) → hoy; la frase cae en el resumen', async () => {
  await correosRetiro.crear([correo([listo('r1', { fecha: '2026-11-01' })])], { ahora, datos: { clientes }, cfg });
  const [f] = t('llamada_ficha');
  assert.equal(f.retiro.fecha, '2026-11-12');
  assert.equal(f.retiro.texto, 'Tienen cheque disponible');
  assert.equal(f.retiro.franja, null);
});

test('una promesa abierta que no es retiro se reprograma; si ya es retiro, no se duplica', async () => {
  fake.tablas.promesa_pago = [{ id: 7, phone: '8095550001', estado: 'pendiente', llamada_key: 'log:99', created_at: '2026-11-05T10:00:00Z' }];
  await correosRetiro.crear([correo([listo('r1')])], { ahora, datos: { clientes }, cfg });
  const vieja = t('promesa_pago').find((p) => p.id === 7);
  assert.equal(vieja.estado, 'reprogramada');
  const nueva = t('promesa_pago').find((p) => p.llamada_key === 'correo:r1');
  assert.equal(nueva.promesa_anterior_id, '7');

  fake.reset();
  fake.tablas.promesa_pago = [{ id: 8, phone: '8095550001', estado: 'pendiente', llamada_key: 'log:100', created_at: '2026-11-05T10:00:00Z' }];
  fake.tablas.llamada_ficha = [{ llamada_key: 'log:100', phone: '8095550001', modalidad: 'retiro' }];
  const r = await correosRetiro.crear([correo([listo('r2')])], { ahora, datos: { clientes }, cfg });
  assert.equal(r.ya_era_retiro, 1);
  assert.equal(t('promesa_pago').length, 1);
  assert.equal(t('promesa_pago')[0].estado, 'pendiente');
});

test('no cuentan: otras categorías, respuestas viejas, sin cliente en la cartera o sin vencido', () => {
  const viejo = listo('v', {}); viejo.fecha = '2026-10-01T10:00:00Z';
  const c = correosRetiro.candidatos([
    correo([{ ...listo('a'), etiqueta: { categoria: 'promesa' } }, viejo]),
    correo([listo('b')], {}, ['nadie@x.com']),
    correo([listo('c')], { codigo: 'C2' }, []),
    correo([listo('d')], { telefono: '+1 (809) 555-0001' }, []),
  ], clientes, ahora);
  assert.deepEqual(c.map((x) => x.llave), ['correo:d']);
});
