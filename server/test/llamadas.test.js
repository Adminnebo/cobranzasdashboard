const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLlamada, getData } = require('../data/source');
const { tipoDeAgente } = require('../services/agents');

const SEGUIMIENTO = 'cmrksxyke000bf69lt9nw4322';
const COBRANZAS = 'cmrkqs0j90009f69lxz1scrwr';

test('fila vieja sin agente cuenta como cobranzas (inferido)', () => {
  const l = normalizeLlamada({ id: 1, created_at: '2026-10-01T14:00:00Z', phone: '+18095551234', intencion_pago: 'ninguno' });
  assert.equal(l.agente, 'cobranzas');
  assert.equal(l.agente_inferido, true);
  assert.equal(l.agente_id, null);
  assert.equal(l.duracion_seg, null);
});

test('fila nueva con el agente de follow up', () => {
  const l = normalizeLlamada({
    id: 2, phone: '+18095551234', agente_id: SEGUIMIENTO, agente_nombre: 'JH Cobranzas (Follow Up)',
    sword_call_id: 98765, duracion_seg: '39.7', resultado: 'answered', motivo_fin: 'assistant-ended-call', etapa: 'Con intencion de pagar',
  });
  assert.equal(l.agente, 'seguimiento');
  assert.equal(l.agente_inferido, false);
  assert.equal(l.sword_call_id, '98765');
  assert.equal(l.duracion_seg, 39.7);
  assert.equal(l.resultado, 'answered');
  assert.equal(l.motivo_fin, 'assistant-ended-call');
  assert.equal(l.etapa, 'Con intencion de pagar');
});

test('agente principal por id, aunque Sword le cambie el nombre', () => {
  assert.deepEqual(tipoDeAgente(COBRANZAS, 'JH Cobranzas (Imported)'), { tipo: 'cobranzas', inferido: false });
});

test('agente desconocido: se deduce del nombre', () => {
  assert.equal(tipoDeAgente('otro-id', 'Agente Seguimiento JDL').tipo, 'seguimiento');
  assert.equal(tipoDeAgente('otro-id', 'Follow-Up 2').tipo, 'seguimiento');
  assert.equal(tipoDeAgente('otro-id', 'Cobros').tipo, 'cobranzas');
});

test('AGENT_LIST acepta tipo explícito', () => {
  const antes = process.env.AGENT_LIST;
  process.env.AGENT_LIST = 'a1:Camila:cobranzas,a2:Camila 2:seguimiento,a3:Recordatorio Follow Up';
  try {
    assert.equal(tipoDeAgente('a1').tipo, 'cobranzas');
    assert.equal(tipoDeAgente('a2').tipo, 'seguimiento');
    assert.equal(tipoDeAgente('a3').tipo, 'seguimiento');
    // Los ids fijos siguen reconociéndose aunque AGENT_LIST no los incluya.
    assert.equal(tipoDeAgente(SEGUIMIENTO).tipo, 'seguimiento');
  } finally {
    if (antes === undefined) delete process.env.AGENT_LIST; else process.env.AGENT_LIST = antes;
  }
});

test('demo: cruza por teléfono y trae un follow up', async () => {
  const antes = process.env.USE_DEMO_DATA;
  process.env.USE_DEMO_DATA = 'true';
  try {
    const { clientes, llamadas } = await getData();
    const tels = new Set(clientes.map((c) => c.phone));
    assert.ok(llamadas.every((l) => tels.has(l.phone)), 'todas las llamadas demo cruzan con un cliente');
    assert.equal(llamadas.filter((l) => l.agente === 'seguimiento').length, 1);
  } finally {
    if (antes === undefined) delete process.env.USE_DEMO_DATA; else process.env.USE_DEMO_DATA = antes;
  }
});

test('sin respuesta según Sword => no_contesta, aunque la IA diga otra cosa', () => {
  const a = normalizeLlamada({ phone: '8095551234', resultado: 'no_answer', intencion_pago: 'ninguno' });
  assert.equal(a.intencion_pago, 'no_contesta');
  const b = normalizeLlamada({ phone: '8095551234', resultado: 'no_answer' });
  assert.equal(b.intencion_pago, 'no_contesta');
});

test('contestada conserva la intención; fila vieja sin resultado también', () => {
  assert.equal(normalizeLlamada({ phone: '8095551234', resultado: 'answered', intencion_pago: 'fecha_especifica' }).intencion_pago, 'fecha_especifica');
  assert.equal(normalizeLlamada({ phone: '8095551234', intencion_pago: 'evasivo' }).intencion_pago, 'evasivo');
  assert.equal(normalizeLlamada({ phone: '8095551234', resultado: 'answered' }).intencion_pago, 'sin_dato');
});

test('las llamadas a números de prueba se separan del resto', () => {
  const { separar, phoneKey } = require('../services/pruebas');
  const set = new Set([phoneKey('+1 339 565 8425')]);
  const ll = [{ id: 1, phone: '3395658425' }, { id: 2, phone: '8095551234' }];
  const { reales, pruebas } = separar(ll, set);
  assert.deepEqual(reales.map((l) => l.id), [2]);
  assert.deepEqual(pruebas.map((l) => [l.id, l.prueba]), [[1, true]]);
  assert.deepEqual(separar(ll, new Set()).reales.length, 2);
});
