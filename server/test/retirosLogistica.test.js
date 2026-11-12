// Retiros → logística: motor (PUT / DELETE / reintentos) y aviso de vuelta, con la base en memoria.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const fake = require('./helpers/fakeDb');
require.cache[path.resolve(__dirname, '../services/supabaseDb.js')] = { exports: fake, loaded: true, id: 'fake' };
delete process.env.OPENAI_API_KEY;
process.env.LOGISTICA_URL = 'https://logistica.test/';
process.env.LOGISTICA_TOKEN = 'tok-integracion';
process.env.LOGISTICA_AVISO_TOKEN = 'tok-aviso';
const rl = require('../services/retirosLogistica');
const fichas = require('../services/fichas');

const TEL = '8095550001';
const t = (n) => fake.tablas[n] || [];
const fila = (ext = 'log:500') => t('retiro_logistica').find((r) => r.externo_id === ext);
const config = () => t('cliente_config').find((r) => r.phone === TEL) || {};
const datos = (extra = {}) => ({ clientes: [{ phone: TEL, name: 'Ferretería Uno', codigo: '1234', deuda_vencida: 8000, ...extra }] });
let seq = 0;
const ahoraISO = () => new Date(Date.now() - 1000 + seq++).toISOString();

function promesa(id, extra = {}) {
  return { id, phone: TEL, nombre: 'Ferretería Uno', llamada_key: `log:${id}00`, fecha_prometida: '2026-11-10', monto_al_prometer: 10000,
    estado: 'pendiente', intento: 1, created_at: ahoraISO(), ...extra };
}
function ficha(key, extra = {}) {
  return { llamada_key: key, phone: TEL, llamada_at: new Date().toISOString(), modalidad: 'retiro',
    retiro: { fecha: '2026-11-10', franja: 'tarde', desde: '14:00', hasta: '18:00', texto: 'Pasen a buscar el cheque el martes en la tarde' }, ...extra };
}
function sembrar() {
  fake.reset();
  fake.tablas.cliente_config = [{ phone: TEL, enabled: false, estado_cobro: 'promesa', estado_detalle: '2026-11-10', enabled_antes: true }];
  fake.tablas.promesa_pago = [promesa(5)];
  fake.tablas.llamada_ficha = [ficha('log:500')];
}

/** fetch simulado: guarda los pedidos y responde lo que diga `responder`. */
function fetchFalso(responder = () => ({ status: 200, body: { externoId: 'log:500', estado: 'por_ubicar', ruta: null } })) {
  const pedidos = [];
  const f = async (url, opts) => {
    pedidos.push({ url, method: opts.method, headers: opts.headers, body: opts.body ? JSON.parse(opts.body) : null });
    const r = responder({ url, method: opts.method });
    if (r instanceof Error) throw r;
    return { status: r.status, ok: r.status >= 200 && r.status < 300, text: async () => (r.body ? JSON.stringify(r.body) : '') };
  };
  f.pedidos = pedidos;
  return f;
}

function resFalso() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

test('manda solo los retiros de promesas abiertas, con el cuerpo del contrato', async () => {
  sembrar();
  fake.tablas.promesa_pago.push(
    promesa(6, { phone: '8095550002' }),                    // retiro, pero el cliente no tiene código
    promesa(7, { estado: 'cumplida' }),                      // cerrada: no va
    promesa(8),                                              // ficha de transferencia: no va
  );
  fake.tablas.llamada_ficha.push(ficha('log:600', { phone: '8095550002' }), ficha('log:700'), ficha('log:800', { modalidad: 'transferencia', retiro: null }));
  const d = { clientes: [...datos().clientes, { phone: '8095550002', name: 'Sin Código', codigo: '' }] };

  const f = fetchFalso();
  const r = await rl.sincronizar({ datos: d, fetchImpl: f });
  assert.equal(r.enviados, 1);
  assert.equal(f.pedidos.length, 1);
  const p = f.pedidos[0];
  assert.equal(p.method, 'PUT');
  assert.equal(p.url, 'https://logistica.test/api/integraciones/retiros/log%3A500');
  assert.equal(p.headers['x-integracion-token'], 'tok-integracion');
  assert.deepEqual(p.body, {
    clienteCodigo: '1234', nombre: 'Ferretería Uno', telefono: TEL, fecha: '2026-11-10', franja: 'tarde', desde: '14:00', hasta: '18:00',
    frase: 'Pasen a buscar el cheque el martes en la tarde', montoEsperado: 10000, promesaId: '5',
  });
  const x = fila();
  assert.equal(x.estado, 'por_ubicar', 'guarda el estado que devolvió el PUT');
  assert.equal(x.cliente_codigo, '1234');
  assert.equal(x.promesa_id, '5');
  assert.ok(x.enviado_hash && x.enviado_at);
  assert.equal(fila('log:600').error, 'el cliente no tiene código en la cartera');
  assert.equal(fila('log:600').enviado_at, undefined);
  assert.equal(fila('log:700'), undefined);
  assert.equal(fila('log:800'), undefined);
});

test('sin cambios no se reenvía; si cambia la ficha, sí', async () => {
  sembrar();
  const f = fetchFalso();
  await rl.sincronizar({ datos: datos(), fetchImpl: f });
  await rl.sincronizar({ datos: datos(), fetchImpl: f });
  assert.equal(f.pedidos.length, 1, 'igual que lo enviado: no se vuelve a mandar');

  t('llamada_ficha')[0].retiro = { ...t('llamada_ficha')[0].retiro, franja: 'hora', desde: '10:00', hasta: '11:00' };
  await rl.sincronizar({ datos: datos(), fetchImpl: f });
  assert.equal(f.pedidos.length, 2);
  assert.equal(f.pedidos[1].method, 'PUT');
  assert.equal(f.pedidos[1].body.desde, '10:00');
  assert.equal(fila().enviado.desde, '10:00');
});

test('"No es retiro" → DELETE una sola vez', async () => {
  sembrar();
  const f = fetchFalso(({ method }) => (method === 'DELETE' ? { status: 200, body: { externoId: 'log:500', estado: 'cancelado' } } : { status: 200, body: { estado: 'por_asignar' } }));
  await rl.sincronizar({ datos: datos(), fetchImpl: f });
  await fichas.marcarNoRetiro('log:500', 'equipo@jh');
  const r = await rl.sincronizar({ datos: datos(), fetchImpl: f });
  assert.equal(r.cancelados, 1);
  assert.equal(f.pedidos[1].method, 'DELETE');
  assert.equal(f.pedidos[1].url, 'https://logistica.test/api/integraciones/retiros/log%3A500');
  assert.ok(fila().cancelado_at);
  assert.equal(fila().estado, 'cancelado');
  await rl.sincronizar({ datos: datos(), fetchImpl: f });
  assert.equal(f.pedidos.length, 2, 'ya cancelado: no se repite');
});

test('promesa cancelada → DELETE; cumplida no; 409 queda como final', async () => {
  sembrar();
  fake.tablas.promesa_pago.push(promesa(6));
  fake.tablas.llamada_ficha.push(ficha('log:600'));
  const f = fetchFalso(({ method }) => (method === 'DELETE' ? { status: 409, body: { estado: 'retirado', rcp: 'RCP-0001' } } : { status: 200, body: { estado: 'por_ubicar' } }));
  await rl.sincronizar({ datos: datos(), fetchImpl: f });
  assert.equal(f.pedidos.length, 2);

  t('promesa_pago').find((p) => p.id === 5).estado = 'cancelada';
  t('promesa_pago').find((p) => p.id === 6).estado = 'cumplida';
  const r = await rl.sincronizar({ datos: datos(), fetchImpl: f });
  assert.equal(r.ya_atendidos, 1);
  assert.equal(f.pedidos.length, 3);
  assert.equal(f.pedidos[2].method, 'DELETE');
  assert.match(f.pedidos[2].url, /log%3A500$/);
  assert.equal(fila().estado, 'retirado');
  assert.ok(fila().cancelado_at);
  assert.match(fila().error, /409/);
  assert.equal(fila('log:600').cancelado_at, null, 'cumplida (ya no debe): no se cancela');

  await rl.sincronizar({ datos: datos(), fetchImpl: f });
  assert.equal(f.pedidos.length, 3, 'tras el 409 no se reintenta');
});

test('retirado: no se cancela ni se reenvía aunque luego digan "No es retiro"', async () => {
  sembrar();
  const f = fetchFalso();
  await rl.sincronizar({ datos: datos(), fetchImpl: f });
  await rl.recibirAviso({ externoId: 'log:500', estado: 'retirado', montoCent: 1000000, rcp: 'RCP-0012', atendidoEn: new Date().toISOString(), ruta: { referencia: 'R-0012', fecha: '2026-11-10', repartidor: 'Lendy' } });
  await fichas.marcarNoRetiro('log:500', 'equipo@jh');
  t('llamada_ficha')[0].retiro = null;
  await rl.sincronizar({ datos: datos(), fetchImpl: f });
  assert.equal(f.pedidos.length, 1, 'solo el PUT inicial');
  assert.equal(fila().cancelado_at, null);
});

test('logística caída: guarda el error y espera 1, 2, 4… min antes de reintentar', async () => {
  sembrar();
  const f = fetchFalso(() => ({ status: 502, body: { error: 'bad gateway' } }));
  const t0 = new Date();
  const r = await rl.sincronizar({ datos: datos(), fetchImpl: f, ahora: t0 });
  assert.equal(r.errores, 1);
  assert.match(fila().error, /502/);
  assert.equal(fila().intentos, 1);
  assert.equal(Date.parse(fila().proximo_intento_at), t0.getTime() + 60000);
  assert.equal(fila().enviado_hash, undefined, 'no quedó como enviado');

  await rl.sincronizar({ datos: datos(), fetchImpl: f, ahora: new Date(t0.getTime() + 30000) });
  assert.equal(f.pedidos.length, 1, 'antes del minuto no reintenta');

  const t1 = new Date(t0.getTime() + 61000);
  await rl.sincronizar({ datos: datos(), fetchImpl: f, ahora: t1 });
  assert.equal(f.pedidos.length, 2);
  assert.equal(fila().intentos, 2);
  assert.equal(Date.parse(fila().proximo_intento_at), t1.getTime() + 120000);

  // Sin red (timeout): tampoco revienta.
  const caido = fetchFalso(() => new Error('The operation was aborted due to timeout'));
  const t2 = new Date(t1.getTime() + 121000);
  const r2 = await rl.sincronizar({ datos: datos(), fetchImpl: caido, ahora: t2 });
  assert.equal(r2.errores, 1);
  assert.equal(fila().intentos, 3);
  assert.match(fila().error, /timeout/);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(rl.esperaMin), [1, 2, 4, 8, 16, 30, 30]);

  // Vuelve logística: se manda y se limpia el error.
  const ok = fetchFalso();
  await rl.sincronizar({ datos: datos(), fetchImpl: ok, ahora: new Date(t2.getTime() + 5 * 60000) });
  assert.equal(fila().error, null);
  assert.equal(fila().intentos, 0);
  assert.ok(fila().enviado_hash);
});

test('a lo sumo 20 pedidos por vuelta', async () => {
  sembrar();
  for (let i = 10; i < 35; i++) {
    fake.tablas.promesa_pago.push(promesa(i, { phone: `80955510${i}` }));
    fake.tablas.llamada_ficha.push(ficha(`log:${i}00`, { phone: `80955510${i}` }));
  }
  const d = { clientes: [...datos().clientes, ...Array.from({ length: 25 }, (_, k) => ({ phone: `80955510${k + 10}`, name: `C${k}`, codigo: String(k + 10) }))] };
  const f = fetchFalso();
  const r = await rl.sincronizar({ datos: d, fetchImpl: f });
  assert.equal(f.pedidos.length, 20);
  assert.equal(r.para_la_proxima, 6);
  await rl.sincronizar({ datos: d, fetchImpl: f });
  assert.equal(f.pedidos.length, 26, 'los que faltaban salen en la próxima vuelta');
});

test('sin LOGISTICA_URL no hace nada', async () => {
  sembrar();
  const antes = process.env.LOGISTICA_URL;
  delete process.env.LOGISTICA_URL;
  try {
    const f = fetchFalso();
    const r = await rl.sincronizar({ datos: datos(), fetchImpl: f });
    assert.ok(r.omitida);
    assert.equal(f.pedidos.length, 0);
    assert.equal(rl.configurado(), false);
  } finally { process.env.LOGISTICA_URL = antes; }
});

test('aviso: 503 sin token configurado, 401 con token malo, 200 guarda', async () => {
  sembrar();
  const antes = process.env.LOGISTICA_AVISO_TOKEN;
  delete process.env.LOGISTICA_AVISO_TOKEN;
  let res = resFalso();
  await rl.manejarAviso({ headers: { 'x-logistica-token': 'tok-aviso' }, body: { externoId: 'log:500', estado: 'en_ruta' } }, res);
  assert.equal(res.statusCode, 503);
  process.env.LOGISTICA_AVISO_TOKEN = antes;

  res = resFalso();
  await rl.manejarAviso({ headers: { 'x-logistica-token': 'otro' }, body: { externoId: 'log:500', estado: 'en_ruta' } }, res);
  assert.equal(res.statusCode, 401);
  res = resFalso();
  await rl.manejarAviso({ headers: {}, body: { externoId: 'log:500', estado: 'en_ruta' } }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(t('retiro_logistica').length, 0);

  res = resFalso();
  await rl.manejarAviso({ headers: { 'x-logistica-token': 'tok-aviso' }, body: { externoId: 'log:500', estado: 'raro' } }, res);
  assert.equal(res.statusCode, 400);

  res = resFalso();
  await rl.manejarAviso({ headers: { 'x-logistica-token': 'tok-aviso' }, body: {
    externoId: 'log:500', estado: 'en_ruta', fecha: '2026-11-10', ruta: { referencia: 'R-0012', fecha: '2026-11-10', repartidor: 'Lendy' },
    motivo: null, montoCent: null, rcp: null, atendidoEn: null,
  } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  const x = fila();
  assert.equal(x.estado, 'en_ruta');
  assert.deepEqual(x.ruta, { referencia: 'R-0012', fecha: '2026-11-10', repartidor: 'Lendy' });
  assert.equal(x.fecha, '2026-11-10');
  assert.equal(x.phone, TEL, 'sin fila previa: toma el cliente de la promesa');
  assert.equal(config().estado_cobro, 'promesa', 'en ruta no cambia nada del cliente');
  assert.equal(t('promesa_pago')[0].estado, 'pendiente');

  // Otro estado no cierra la promesa.
  await rl.recibirAviso({ externoId: 'log:500', estado: 'no_retirado', motivo: 'No estaba el encargado' });
  assert.equal(fila().estado, 'no_retirado');
  assert.equal(fila().motivo, 'No estaba el encargado');
  assert.equal(t('promesa_pago')[0].estado, 'pendiente');

  const mapa = await rl.mapaPorLlamada();
  assert.equal(mapa.get('log:500').estado, 'no_retirado');
  assert.equal(mapa.get('log:500').motivo, 'No estaba el encargado');
});

test('retirado → el cliente pasa a "dice que pagó" con la nota, y su promesa se cierra', async () => {
  sembrar();
  await rl.sincronizar({ datos: datos(), fetchImpl: fetchFalso() });
  const res = resFalso();
  const aviso = { externoId: 'log:500', estado: 'retirado', fecha: '2026-11-10', ruta: { referencia: 'R-0012', fecha: '2026-11-10', repartidor: 'Lendy' },
    motivo: null, montoCent: 1000000, rcp: 'RCP-0012', atendidoEn: '2026-11-10T15:20:00Z' };
  await rl.manejarAviso({ headers: { 'x-logistica-token': 'tok-aviso' }, body: aviso }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.dicePago, true);

  const c = config();
  assert.equal(c.estado_cobro, 'dice_pago');
  assert.equal(c.estado_detalle, 'Retirado por logística: RD$ 10,000 con el RCP-0012');
  assert.equal(c.enabled, false);
  assert.equal(c.enabled_antes, true, 'recuerda que estaba prendido');
  assert.equal(c.updated_by, 'sistema (logística)');
  const p = t('promesa_pago')[0];
  assert.equal(p.estado, 'dice_pago', 'igual que cuando dice en la llamada que ya pagó: el follow up no lo llama');
  assert.equal(p.motivo_cierre, 'Retirado por logística: RD$ 10,000 con el RCP-0012');
  const x = fila();
  assert.equal(x.estado, 'retirado');
  assert.equal(x.monto_cent, 1000000);
  assert.equal(x.rcp, 'RCP-0012');
  assert.equal(x.atendido_en, '2026-11-10T15:20:00Z');

  // Aviso repetido (logística reintenta): no vuelve a tocar al cliente.
  const at = c.estado_at;
  const res2 = resFalso();
  await rl.manejarAviso({ headers: { 'x-logistica-token': 'tok-aviso' }, body: aviso }, res2);
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.body.dicePago, false);
  assert.equal(config().estado_at, at);

  assert.equal(rl.notaRetirado({ montoCent: 1234550, rcp: null }), 'Retirado por logística: RD$ 12,345.5');
  assert.equal(rl.notaRetirado({ montoCent: null, rcp: 'RCP-9' }), 'Retirado por logística con el RCP-9');
});

test('volver a pendiente: si logística ya no lo tiene, deshace el retirado, reabre la promesa y lo vuelve a mandar', async () => {
  sembrar();
  await rl.sincronizar({ datos: datos(), fetchImpl: fetchFalso() });
  const sigue = fetchFalso(() => ({ status: 200, body: { externoId: 'log:500', estado: 'por_ubicar' } }));
  await assert.rejects(rl.volverAPendiente('log:500', null, { fetchImpl: sigue }), /no está como retirado/);
  await rl.recibirAviso({ externoId: 'log:500', estado: 'retirado', montoCent: 1000000, rcp: 'RCP-0012', atendidoEn: '2026-11-10T15:20:00Z' });
  assert.equal(t('promesa_pago')[0].estado, 'dice_pago');

  // Logística todavía lo tiene retirado: no se toca nada (el motor lo volvería a traer).
  const retirado = fetchFalso(() => ({ status: 200, body: { externoId: 'log:500', estado: 'retirado', montoCent: 1000000, rcp: 'RCP-0012' } }));
  await assert.rejects(rl.volverAPendiente('log:500', 'admin@x', { fetchImpl: retirado }), /Anúlalo allá/);
  assert.equal(retirado.pedidos[0].method, 'GET');
  assert.match(retirado.pedidos[0].url, /log%3A500\/seguimiento$|log:500\/seguimiento$/);
  assert.equal(t('promesa_pago')[0].estado, 'dice_pago');
  assert.equal(fila().estado, 'retirado');

  // Logística no responde: tampoco.
  await assert.rejects(rl.volverAPendiente('log:500', null, { fetchImpl: fetchFalso(() => new Error('timeout')) }), /No se pudo confirmar/);
  assert.equal(fila().estado, 'retirado');

  // Logística no lo tiene (404): se limpia aquí y el motor lo vuelve a mandar.
  const r = await rl.volverAPendiente('log:500', 'admin@x', { fetchImpl: fetchFalso(() => ({ status: 404 })) });
  assert.equal(r.promesaReabierta, true);
  assert.equal(t('promesa_pago')[0].estado, 'pendiente');
  assert.equal(config().estado_cobro, 'promesa', 'sale de "dice que pagó"');
  const x = fila();
  assert.equal(x.estado, null);
  assert.equal(x.rcp, null);
  assert.equal(x.monto_cent, null);

  // Próxima vuelta del motor: se vuelve a mandar y queda lo que responda logística.
  const f = fetchFalso(() => ({ status: 200, body: { externoId: 'log:500', estado: 'por_asignar' } }));
  const s = await rl.sincronizar({ datos: datos(), fetchImpl: f });
  assert.equal(s.enviados, 1);
  assert.equal(f.pedidos[0].method, 'PUT');
  assert.equal(fila().estado, 'por_asignar');
  await assert.rejects(rl.volverAPendiente('nada'), /no existe/);
});

test('volver a pendiente: si logística ya lo anuló y el aviso no llegó, queda como está allá', async () => {
  sembrar();
  await rl.sincronizar({ datos: datos(), fetchImpl: fetchFalso() });
  await rl.recibirAviso({ externoId: 'log:500', estado: 'retirado', montoCent: 1000000, rcp: 'RCP-0012', fotoUrl: 'https://logistica.test/c/a/foto' });
  const anulado = fetchFalso(() => ({ status: 200, body: { externoId: 'log:500', estado: 'en_ruta', ruta: { referencia: 'R-0012', repartidor: 'Lendy' },
    montoCent: null, rcp: null, fotoUrl: null } }));
  const r = await rl.volverAPendiente('log:500', 'admin@x', { fetchImpl: anulado });
  assert.deepEqual(r, { promesaReabierta: true, enLogistica: 'en_ruta' });
  assert.equal(t('promesa_pago')[0].estado, 'pendiente');
  const x = fila();
  assert.equal(x.estado, 'en_ruta');
  assert.equal(x.ruta.repartidor, 'Lendy');
  assert.equal(x.rcp, null);
  assert.equal(x.foto_url, null);
  assert.ok(x.enviado_hash, 'sigue enviado: el motor no lo vuelve a mandar');
});

test('logística anula un retirado: la promesa se reabre y se borran monto, RCP y foto', async () => {
  sembrar();
  await rl.sincronizar({ datos: datos(), fetchImpl: fetchFalso() });
  await rl.recibirAviso({ externoId: 'log:500', estado: 'retirado', ruta: { referencia: 'R-0012', repartidor: 'Lendy' },
    montoCent: 1000000, rcp: 'RCP-0012', atendidoEn: '2026-11-10T15:20:00Z', fotoUrl: 'https://logistica.test/c/a/foto' });
  assert.equal(t('promesa_pago')[0].estado, 'dice_pago');
  assert.equal((await rl.atendidos()).length, 1);

  // Anulado con la ruta ya cerrada: logística lo deja por asignar (aviso sin fotoUrl, por si acaso).
  const r = await rl.recibirAviso({ externoId: 'log:500', estado: 'por_asignar', motivo: 'Retiro anulado por Ana: era una prueba' });
  assert.deepEqual(r, { dicePago: false, promesaReabierta: true });
  assert.equal(t('promesa_pago')[0].estado, 'pendiente');
  assert.equal(config().estado_cobro, 'promesa', 'sale de "dice que pagó"');
  const x = fila();
  assert.equal(x.estado, 'por_asignar');
  assert.equal(x.monto_cent, null);
  assert.equal(x.rcp, null);
  assert.equal(x.foto_url, null);
  assert.equal(x.motivo, 'Retiro anulado por Ana: era una prueba');
  assert.equal((await rl.atendidos()).length, 0, 'sale del historial de llamadas');

  // Aviso repetido: no vuelve a tocar la promesa.
  const r2 = await rl.recibirAviso({ externoId: 'log:500', estado: 'por_asignar' });
  assert.equal(r2.promesaReabierta, false);
  // Y si lo vuelven a retirar, cierra otra vez como siempre.
  await rl.recibirAviso({ externoId: 'log:500', estado: 'retirado', montoCent: 900000, rcp: 'RCP-0013' });
  assert.equal(t('promesa_pago')[0].estado, 'dice_pago');
});

test('foto: el aviso guarda fotoUrl (solo https) y sale en atendidos para el historial', async () => {
  sembrar();
  await rl.sincronizar({ datos: datos(), fetchImpl: fetchFalso() });
  const foto = 'https://logistica.neboaiconsulting.com/c/abc123/foto';
  await rl.recibirAviso({ externoId: 'log:500', estado: 'retirado', ruta: { referencia: 'R-0012', repartidor: 'Lendy' },
    montoCent: 500000, rcp: 'RCP-7', atendidoEn: '2026-11-10T15:20:00Z', fotoUrl: foto });
  assert.equal(fila().foto_url, foto);
  const at = await rl.atendidos();
  assert.equal(at.length, 1);
  assert.equal(at[0].phone, TEL);
  assert.equal(at[0].fotoUrl, foto);
  assert.equal(at[0].montoCent, 500000);
  assert.equal(at[0].ruta.repartidor, 'Lendy');

  assert.equal(rl.fotoValida('http://x.test/foto'), null, 'solo https');
  assert.equal(rl.fotoValida('javascript:alert(1)'), null);
  assert.equal(rl.fotoValida(null), null);
  // Aviso sin el campo (formato viejo): no borra la foto guardada.
  await rl.recibirAviso({ externoId: 'log:500', estado: 'retirado', montoCent: 500000, rcp: 'RCP-7' });
  assert.equal(fila().foto_url, foto);
  // Volver a pendiente la borra.
  await rl.volverAPendiente('log:500', null, { fetchImpl: fetchFalso(() => ({ status: 404 })) });
  assert.equal(fila().foto_url, null);
  assert.equal((await rl.atendidos()).length, 0);
});

test('seguimiento: pregunta a logística, normaliza y guarda 1 min', async () => {
  sembrar();
  await rl.sincronizar({ datos: datos(), fetchImpl: fetchFalso() });
  const resp = { externoId: 'log:500', estado: 'en_ruta', fecha: '2026-11-10', ruta: { referencia: 'R-0012', fecha: '2026-11-10', repartidor: 'Lendy' },
    camion: { lat: 19.2, lng: -70.5, registradaEn: '2026-11-10T14:00:00Z', minutosSinGps: 2 }, paradasAntes: 3, distanciaKm: 4.2,
    etaMin: 25, etaEn: '2026-11-10T14:27:00Z', fotoUrl: null, montoCent: null, rcp: null, atendidoEn: null, calculadoEn: '2026-11-10T14:02:00Z' };
  const f = fetchFalso(() => ({ status: 200, body: resp }));
  const ahora = Date.now();
  const r = await rl.seguimiento('log:500', { ahora, fetchImpl: f });
  assert.equal(f.pedidos[0].method, 'GET');
  assert.equal(f.pedidos[0].url, 'https://logistica.test/api/integraciones/retiros/log%3A500/seguimiento');
  assert.equal(r.local.estado, 'por_ubicar', 'lo guardado se manda igual');
  assert.equal(r.logistica.estado, 'en_ruta');
  assert.equal(r.logistica.ruta.repartidor, 'Lendy');
  assert.equal(r.logistica.etaMin, 25);
  assert.equal(r.logistica.paradasAntes, 3);
  assert.equal(r.logistica.camion.minutosSinGps, 2);

  await rl.seguimiento('log:500', { ahora: ahora + 30000, fetchImpl: f });
  assert.equal(f.pedidos.length, 1, 'dentro del minuto no vuelve a preguntar');
  await rl.seguimiento('log:500', { ahora: ahora + 61000, fetchImpl: f });
  assert.equal(f.pedidos.length, 2);

  const caida = fetchFalso(() => new Error('ECONNREFUSED'));
  const e = await rl.seguimiento('log:500', { ahora: ahora + 200000, fetchImpl: caida });
  assert.equal(e.logistica, null);
  assert.match(e.error, /no respondió/);
  assert.equal(e.local.externoId, 'log:500');
  await assert.rejects(rl.seguimiento('nada'), /no existe/);
});

test('el id para logística sale de la llamada_key, limpio', () => {
  assert.equal(rl.externoDe('log:123'), 'log:123');
  assert.equal(rl.externoDe('8095550001|2026-11-06T10:00:00.000Z'), '8095550001|2026-11-06T10:00:00.000Z');
  assert.equal(rl.externoDe('a b/c'), 'a_b_c');
});

test('número de prueba: no se manda; si ya se había mandado, se cancela', async () => {
  const pruebas = require('../services/pruebas');
  sembrar();
  const f = fetchFalso(({ method }) => (method === 'DELETE' ? { status: 200, body: { externoId: 'log:500', estado: 'cancelado' } } : { status: 200, body: { estado: 'por_asignar' } }));
  await rl.sincronizar({ datos: datos(), fetchImpl: f });
  assert.equal(f.pedidos.length, 1, 'antes de estar en la lista, va');

  await pruebas.add(TEL, 'Prueba', 'equipo@nebo');
  const r = await rl.sincronizar({ datos: datos(), fetchImpl: f });
  assert.equal(r.cancelados, 1);
  assert.equal(f.pedidos[1].method, 'DELETE');

  fake.tablas.promesa_pago.push(promesa(6));
  fake.tablas.llamada_ficha.push(ficha('log:600'));
  const r2 = await rl.sincronizar({ datos: datos(), fetchImpl: f });
  assert.equal(r2.prueba, 2);
  assert.equal(f.pedidos.length, 2, 'el nuevo de un número de prueba no se manda');
  assert.equal(fila('log:600').error, 'número de prueba: no va a logística');
  assert.equal(fila('log:600').enviado_at, undefined);
  const mapa = await rl.mapaPorLlamada();
  assert.deepEqual([mapa.get('log:600').prueba, mapa.get('log:600').error], [true, null]);
  await pruebas.remove(TEL);
});
