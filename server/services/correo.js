// Correo de cobranzas: el Gmail del cliente conectado con OAuth de Nebo AI (correo-servicio).
// Este servidor guarda la clave del cliente (CORREO_CLAVE) y reenvía; el navegador nunca la ve.
// Sin CORREO_URL + CORREO_CLAVE no hay pestaña ni rutas: el panel queda como siempre.
const express = require('express');

const URL_BASE = () => String(process.env.CORREO_URL || '').replace(/\/+$/, '');
const CLAVE = () => process.env.CORREO_CLAVE || '';
const configurado = () => !!(URL_BASE() && CLAVE());
const embedUrl = () => `${URL_BASE()}/embed.js`;

async function servicio(metodo, ruta, cuerpo) {
  const r = await fetch(URL_BASE() + ruta, {
    method: metodo,
    headers: { 'x-api-key': CLAVE(), 'content-type': 'application/json' },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    signal: AbortSignal.timeout(20000),
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

module.exports = { router, configurado, embedUrl };
