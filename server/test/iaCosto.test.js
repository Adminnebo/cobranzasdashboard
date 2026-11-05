// Costo de la IA que lee las llamadas y su cobro en Sword (fetch simulado).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const fake = require('./helpers/fakeDb');
require.cache[path.resolve(__dirname, '../services/supabaseDb.js')] = { exports: fake, loaded: true, id: 'fake' };
const schedule = require('../services/schedule');
const iaCosto = require('../services/iaCosto');

const HOY = schedule.ymdInTz(new Date());
const antes = (n) => { const d = new Date(`${HOY}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const t = (n) => fake.tablas[n] || [];

const ENV = { SWORD_AJUSTE_CALLER_ID: '7', SWORD_AJUSTE_API_KEY: 'k', SWORD_CLIENT_ID: '16' };
function conSword(fn) {
  return async () => {
    const prev = {}; for (const k of Object.keys(ENV)) { prev[k] = process.env[k]; process.env[k] = ENV[k]; }
    const fetchPrev = global.fetch;
    try { await fn(); } finally {
      for (const k of Object.keys(ENV)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
      global.fetch = fetchPrev;
    }
  };
}
const config = (extra = {}) => { fake.tablas.ia_config = [{ id: 1, precio_entrada: 0.15, precio_cache: 0.075, precio_salida: 0.6, margen_pct: 0, cobrar_sword: true, ...extra }]; };
const respuesta = (status, body) => async (url, opts) => {
  respuesta.ultimo = { url, body: JSON.parse(opts.body) };
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
};

test('costo: los tokens en caché van a su precio', () => {
  const c = iaCosto.costoDe({ entrada: 1_000_000, cache: 400_000, salida: 100_000 }, iaCosto.DEFAULT);
  assert.equal(Number(c.toFixed(6)), Number((0.6 * 0.15 + 0.4 * 0.075 + 0.1 * 0.6).toFixed(6)));
});

test('registrar: suma las consultas del día en una sola fila', async () => {
  fake.reset();
  await iaCosto.registrar({ modelo: 'gpt-4o-mini', llamadas: 8, uso: { entrada: 10000, cache: 0, salida: 1000 } });
  await iaCosto.registrar({ modelo: 'gpt-4o-mini', llamadas: 3, uso: { entrada: 5000, cache: 0, salida: 500 } });
  const [f] = t('ia_consumo');
  assert.equal(t('ia_consumo').length, 1);
  assert.equal(f.dia, HOY);
  assert.equal(f.llamadas, 11);
  assert.equal(f.consultas, 2);
  assert.equal(f.costo_usd, Number(((15000 * 0.15 + 1500 * 0.6) / 1e6).toFixed(6)));
});

test('cobrar: apagado o sin claves de Sword no hace nada', conSword(async () => {
  fake.reset();
  config({ cobrar_sword: false });
  fake.tablas.ia_consumo = [{ dia: antes(1), origen: 'fichas', costo_usd: 0.5, llamadas: 100, cobro_id: null }];
  assert.deepEqual(await iaCosto.cobrar({ hoy: HOY }), { omitido: 'apagado' });
  config();
  delete process.env.SWORD_AJUSTE_API_KEY;
  assert.deepEqual(await iaCosto.cobrar({ hoy: HOY }), { omitido: 'sword sin configurar' });
  assert.equal(t('ia_cobro').length, 0);
}));

test('cobrar: un cobro con los días cerrados (no el de hoy), con ganancia, y no se repite', conSword(async () => {
  fake.reset();
  config({ margen_pct: 30 });
  fake.tablas.ia_consumo = [
    { dia: antes(2), origen: 'fichas', modelo: 'gpt-4o-mini', costo_usd: 0.004, llamadas: 20, cobro_id: null },
    { dia: antes(1), origen: 'fichas', modelo: 'gpt-4o-mini', costo_usd: 0.1, llamadas: 300, cobro_id: null },
    { dia: HOY, origen: 'fichas', modelo: 'gpt-4o-mini', costo_usd: 0.05, llamadas: 90, cobro_id: null },
  ];
  global.fetch = respuesta(200, { success: true });
  const r = await iaCosto.cobrar({ hoy: HOY });
  assert.equal(t('ia_cobro').length, 1);
  const c = t('ia_cobro')[0];
  assert.equal(c.monto_usd, 0.14, '(0.004 + 0.1) × 1.30 = 0.1352 → 0.14');
  assert.equal(c.estado, 'enviado');
  assert.equal(c.dia, antes(1));
  assert.equal(r.enviados[0].estado, 'enviado');
  assert.deepEqual(respuesta.ultimo.body, { callerId: 7, apiKey: 'k', clientId: 16, amount: 0.14, operation: 'subtract', concept: 'cobranzas', note: c.nota });
  assert.match(c.nota, /320 llamadas/);
  assert.equal(t('ia_consumo').find((f) => f.dia === HOY).cobro_id, null, 'hoy no se cobra todavía');

  await iaCosto.cobrar({ hoy: HOY });
  assert.equal(t('ia_cobro').length, 1, 'no vuelve a cobrar lo mismo');
}));

test('cobrar: menos de un centavo se acumula con el día siguiente', conSword(async () => {
  fake.reset();
  config();
  fake.tablas.ia_consumo = [{ dia: antes(1), origen: 'fichas', costo_usd: 0.003, llamadas: 10, cobro_id: null }];
  global.fetch = respuesta(200, { success: true });
  await iaCosto.cobrar({ hoy: HOY });
  assert.equal(t('ia_cobro').length, 0);
  assert.equal(t('ia_consumo')[0].cobro_id, null);
}));

test('enviar: si no llegó se reintenta solo; si se cortó a mitad queda para revisar', conSword(async () => {
  fake.reset();
  config();
  fake.tablas.ia_consumo = [{ dia: antes(1), origen: 'fichas', costo_usd: 0.2, llamadas: 10, cobro_id: null }];
  global.fetch = async () => { const e = new Error('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; };
  await iaCosto.cobrar({ hoy: HOY });
  assert.equal(t('ia_cobro')[0].estado, 'reintentar');
  assert.ok(t('ia_cobro')[0].proximo_at);

  t('ia_cobro')[0].proximo_at = new Date(Date.now() - 1000).toISOString();
  global.fetch = respuesta(500, { error: 'boom' });
  await iaCosto.cobrar({ hoy: HOY });
  assert.equal(t('ia_cobro')[0].estado, 'revisar');

  let llamadas = 0;
  global.fetch = async (...a) => { llamadas++; return respuesta(200, { success: true })(...a); };
  await iaCosto.cobrar({ hoy: HOY });
  assert.equal(llamadas, 0, 'en revisar no se manda solo');
  await iaCosto.resolver(t('ia_cobro')[0].id, 'hecho', 'super@nebo');
  assert.equal(t('ia_cobro')[0].estado, 'enviado');
}));
