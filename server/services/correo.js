// Correo de cobranzas: el Gmail del cliente conectado con OAuth de Nebo AI (correo-servicio).
// Este servidor guarda la clave del cliente (CORREO_CLAVE) y reenvía; el navegador nunca la ve.
// Sin CORREO_URL + CORREO_CLAVE no hay pestaña ni rutas: el panel queda como siempre.
const express = require('express');

const URL_BASE = () => String(process.env.CORREO_URL || '').replace(/\/+$/, '');
const CLAVE = () => process.env.CORREO_CLAVE || '';
const configurado = () => !!(URL_BASE() && CLAVE());
const embedUrl = () => `${URL_BASE()}/embed.js`;

async function servicio(metodo, ruta, cuerpo, { espera = 20000 } = {}) {
  const r = await fetch(URL_BASE() + ruta, {
    method: metodo,
    headers: { 'x-api-key': CLAVE(), 'content-type': 'application/json' },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    signal: AbortSignal.timeout(espera),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.message || `El servicio de correo respondió ${r.status}`);
    e.status = r.status >= 500 ? 502 : r.status;
    throw e;
  }
  return j;
}

const router = express.Router();
router.use((req, res, next) => (configurado() ? next() : res.status(404).json({ error: 'Correo no configurado' })));
const manejar = (fn) => (req, res) => fn(req).then((j) => res.json(j), (e) => res.status(e.status || 500).json({ error: e.message }));

router.get('/', manejar(() => servicio('GET', '/v1/conexion')));
// El origen del panel va al servicio para que la ventana de Google avise solo a esta página.
// proveedor: 'google' (Gmail) o 'microsoft' (Outlook, vía Zernio).
router.post('/sesion', manejar((req) => servicio('POST', '/v1/conexion/sesion', {
  origen: req.get('origin') || null,
  proveedor: req.body && req.body.proveedor === 'microsoft' ? 'microsoft' : 'google',
})));
router.delete('/', manejar(() => servicio('DELETE', '/v1/conexion')));

// Plantilla del correo de cobranza (la limpia y la guarda el servicio; n8n la usa al enviar con datos).
router.get('/plantilla', manejar(() => servicio('GET', '/v1/plantilla')));
router.put('/plantilla', manejar((req) => servicio('PUT', '/v1/plantilla', {
  asunto: String((req.body && req.body.asunto) || ''),
  html: String((req.body && req.body.html) || ''),
  por: (req.user && req.user.email) || null,
})));

// Correos enviados a los clientes y sus respuestas (pestaña Emails e historial de cada cliente). Es de
// solo lectura y la ve quien ve las llamadas. El servicio solo entrega los hilos de los correos que
// mandó n8n por él, nunca el resto del buzón.
const lectura = express.Router();
lectura.use((req, res, next) => (configurado() ? next() : res.status(404).json({ error: 'Correo no configurado' })));
lectura.get('/', manejar((req) => servicio('GET', `/v1/correos${req.query.forzar === '1' ? '?forzar=1' : ''}`, null, { espera: 30000 })));
lectura.get('/hilo/:hilo', manejar((req) => {
  const hilo = String(req.params.hilo || '');
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(hilo)) return Promise.reject(Object.assign(new Error('Hilo no válido'), { status: 400 }));
  return servicio('GET', `/v1/correos/hilo/${hilo}`, null, { espera: 30000 });
}));

// Un adjunto del hilo (el PDF que mandamos o lo que adjuntó el cliente): se pasa tal cual.
lectura.get('/hilo/:hilo/adjunto/:mensaje/:parte', async (req, res) => {
  const ok = (v) => /^[A-Za-z0-9_.-]{1,100}$/.test(String(v || ''));
  const { hilo, mensaje, parte } = req.params;
  if (!ok(hilo) || !ok(mensaje) || !ok(parte)) return res.status(400).json({ error: 'Adjunto no válido' });
  try {
    const r = await fetch(`${URL_BASE()}/v1/correos/hilo/${hilo}/adjunto/${mensaje}/${parte}`, {
      headers: { 'x-api-key': CLAVE() }, signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      return res.status(r.status >= 500 ? 502 : r.status).json({ error: j.message || `El servicio de correo respondió ${r.status}` });
    }
    for (const h of ['content-type', 'content-disposition']) if (r.headers.get(h)) res.set(h, r.headers.get(h));
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    res.status(502).json({ error: e.message || 'No se pudo bajar el adjunto' });
  }
});

module.exports = { router, lectura, configurado, embedUrl };
