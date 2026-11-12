const test = require('node:test');
const assert = require('node:assert');
const { crearClasificador, sinHtml } = require('../services/correosIa');

function escenario() {
  const pedidos = [], puestos = [], aIA = [];
  const correos = [{
    id: 's1', hilo: 'h1', asunto: 'Balance de Saldo', fecha: '2026-11-10T10:00:00Z',
    mensajes: [
      { id: 's1', mio: true, de: 'admin@x.com' },
      { id: 'r1', mio: false, de: 'Ana <ana@c.com>', asunto: 'Re: Balance' },
      { id: 'b1', mio: false, de: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', asunto: 'Delivery Status Notification (Failure)' },
      { id: 'r0', mio: false, de: 'Ana <ana@c.com>', etiqueta: { categoria: 'promesa' } },
    ],
  }, { id: 's2', hilo: null, mensajes: null }];
  const hilo = { mensajes: [
    { id: 's1', mio: true, texto: 'estado' },
    { id: 'r1', mio: false, de: 'Ana <ana@c.com>', asunto: 'Re: Balance', texto: 'Adjunto el comprobante de la transferencia',
      adjuntos: [{ nombre: 'transferencia.jpg', tipo: 'image/jpeg', bytes: 1000, parte: '2' }, { nombre: 'x.xlsx', tipo: 'application/vnd.ms-excel', parte: '3' }] },
    { id: 'b1', mio: false, de: 'mailer-daemon@googlemail.com' },
  ] };
  const servicio = async (metodo, ruta, cuerpo) => {
    pedidos.push(`${metodo} ${ruta}`);
    if (ruta === '/v1/correos') return { lectura: true, correos };
    if (ruta === '/v1/correos/hilo/h1') return hilo;
    if (ruta === '/v1/correos/etiquetas') { puestos.push(...cuerpo.items); return { guardadas: cuerpo.items.length }; }
    throw new Error('ruta inesperada ' + ruta);
  };
  const bajar = async (ruta) => { pedidos.push(`BAJAR ${ruta}`); return { tipo: 'image/jpeg', buffer: Buffer.from('jpg') }; };
  const ia = () => ({ chat: { completions: { create: async (p) => {
    aIA.push(p);
    return { model: 'gpt-4o-mini', usage: { prompt_tokens: 10, completion_tokens: 5 },
      choices: [{ message: { content: JSON.stringify({ categoria: 'comprobante', resumen: 'Envía comprobante de transferencia', monto: 'RD$ 5,000', fecha: '2026-11-11', confianza: 0.9 }) } }] };
  } } } });
  return { pedidos, puestos, aIA, servicio, bajar, ia };
}

test('solo lee las respuestas sin etiqueta (no rebotes), con la imagen adjunta, y guarda la etiqueta', async () => {
  const e = escenario();
  const r = await crearClasificador(e).vuelta();
  assert.deepStrictEqual(r, { leidas: 1 });
  assert.strictEqual(e.aIA.length, 1, 'una consulta: r1 (b1 es rebote, r0 ya tenía etiqueta)');
  const contenido = e.aIA[0].messages[1].content;
  assert.match(contenido[0].text, /comprobante de la transferencia/);
  assert.deepStrictEqual(contenido.slice(1).map((p) => p.type), ['image_url'], 'la imagen va; el Excel no');
  assert.ok(e.pedidos.includes('BAJAR /v1/correos/hilo/h1/adjunto/r1/2'));
  assert.deepStrictEqual(e.puestos.map((p) => [p.mensaje, p.hilo, p.etiqueta.categoria, p.etiqueta.monto, p.etiqueta.fecha]),
    [['r1', 'h1', 'comprobante', 'RD$ 5,000', '2026-11-11']]);
});

test('categoría desconocida queda en "otro"; si la IA rechaza el adjunto, reintenta solo con el texto', async () => {
  const e = escenario();
  let n = 0;
  e.ia = () => ({ chat: { completions: { create: async (p) => {
    n++;
    if (p.messages[1].content.length > 1) throw Object.assign(new Error('bad file'), { status: 400 });
    return { choices: [{ message: { content: '{"categoria":"inventada","resumen":"x"}' } }] };
  } } } });
  await crearClasificador(e).vuelta();
  assert.strictEqual(n, 2);
  assert.strictEqual(e.puestos[0].etiqueta.categoria, 'otro');
});

test('sin llave de OpenAI no hace nada; disparar no corre dos veces seguidas', async () => {
  const e = escenario();
  e.ia = () => null;
  assert.deepStrictEqual(await crearClasificador(e).vuelta(), { leidas: 0 });
  const e2 = escenario();
  const c = crearClasificador(e2);
  await c.disparar();
  assert.strictEqual(c.disparar(), null,'antes de 2 minutos no vuelve a correr');
  assert.strictEqual(e2.aIA.length, 1);
});

test('sinHtml deja el texto legible', () => {
  assert.strictEqual(sinHtml('<p>Hola&nbsp;<b>Ana</b></p><div>Pagué</div>'), 'Hola Ana\nPagué');
});
