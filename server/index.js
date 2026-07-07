require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const { getCachedData, cacheInfo } = require('./services/cache');
const { computeMetrics } = require('./services/metrics');
const { analyzePortfolio } = require('./services/ai');
const { ask } = require('./services/ask');
const { requireAuth, requireAdmin, publicConfig, authEnabled } = require('./services/auth');
const users = require('./services/users');
const history = require('./services/history');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;

// Cache simple en memoria del análisis IA (evita re-llamar a OpenAI en cada refresh).
let analysisCache = null;

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
    ai: process.env.OPENAI_API_KEY ? 'openai' : 'heuristica',
    auth: authEnabled,
    cache: cacheInfo(),
  });
});

// Config pública para inicializar Supabase en el frontend (no expone secretos).
app.get('/api/config', (req, res) => res.json(publicConfig()));

// A partir de aquí, todas las rutas /api requieren sesión (si la auth está activada).
app.use('/api', requireAuth);

// Fuentes + métricas puras (servidas desde el caché con TTL).
app.get('/api/data', async (req, res) => {
  try {
    const { clientes, llamadas, source, cachedAt, cacheAgeMs } = await getCachedData();
    const metrics = computeMetrics(clientes, llamadas);
    res.json({ source, clientes, llamadas, metrics, cachedAt, cacheAgeMs });
  } catch (err) {
    console.error('[/api/data]', err);
    res.status(500).json({ error: err.message });
  }
});

// Análisis IA (probabilidades, priorización, resumen). ?refresh=1 fuerza recálculo.
// Se invalida solo cuando cambia el número de llamadas respecto al último análisis.
let analyzedLlamadas = -1;
app.get('/api/analyze', async (req, res) => {
  try {
    const { clientes, llamadas } = await getCachedData();
    const stale = llamadas.length !== analyzedLlamadas;
    if (analysisCache && req.query.refresh !== '1' && !stale) {
      return res.json({ ...analysisCache, cached: true });
    }
    const analysis = await analyzePortfolio(clientes, llamadas);
    analysisCache = analysis;
    analyzedLlamadas = llamadas.length;
    res.json({ ...analysis, cached: false });
  } catch (err) {
    console.error('[/api/analyze]', err);
    res.status(500).json({ error: err.message });
  }
});

// Asistente: pregunta libre / proyección sobre los datos de la cartera.
app.post('/api/ask', async (req, res) => {
  try {
    const question = (req.body && req.body.question || '').toString().trim();
    if (!question) return res.status(400).json({ error: 'Falta la pregunta.' });
    if (question.length > 2000) return res.status(400).json({ error: 'Pregunta demasiado larga.' });
    const result = await ask(question);
    res.json(result);
  } catch (err) {
    console.error('[/api/ask]', err);
    res.status(500).json({ error: err.message });
  }
});

// Historial de deuda por día (agregado) + histórico crudo.
app.get('/api/history', (req, res) => {
  try {
    res.json({ daily: history.getDailyHistory(), tz: history.TZ });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Captura manual (útil para probar / forzar un punto).
app.post('/api/history/snapshot', async (req, res) => {
  try {
    const snap = await history.takeSnapshot('manual');
    res.json(snap);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Info del usuario actual (para el frontend: mostrar email + si es admin).
app.get('/api/me', (req, res) => {
  res.json({
    email: req.user ? req.user.email : null,
    isAdmin: req.user ? !!req.user.isAdmin : false,
  });
});

// ── Administración de usuarios (solo admins) ──
app.get('/api/users', requireAdmin, async (req, res) => {
  try { res.json({ users: await users.listUsers() }); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  try {
    const { email, password, admin } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
    if (String(password).length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    res.json(await users.createUser({ email: String(email).trim(), password: String(password), admin: !!admin }));
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

app.patch('/api/users/:id', requireAdmin, async (req, res) => {
  try { res.json(await users.updateUser(req.params.id, req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    // Evitar que un admin se borre a sí mismo.
    if (req.user && req.params.id === req.user.id) return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta' });
    res.json(await users.deleteUser(req.params.id));
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

// En producción, el mismo server sirve el build del cliente (SPA).
const clientDist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  // Fallback SPA: cualquier ruta que no sea /api devuelve index.html.
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  console.log('[cobranzas-dashboard] Sirviendo cliente estático desde client/dist');
}

app.listen(PORT, async () => {
  console.log(`\n[cobranzas-dashboard] API en http://localhost:${PORT}`);
  console.log(`  IA: ${process.env.OPENAI_API_KEY ? `OpenAI (${process.env.OPENAI_MODEL || 'gpt-4.1-mini'})` : 'heurística (sin OPENAI_API_KEY)'}`);
  console.log(`  Datos: ${(process.env.USE_DEMO_DATA ?? 'true') !== 'false' ? 'demo' : 'n8n/supabase'}`);

  // Histórico: seed inicial + captura de tomas ya pasadas hoy.
  try {
    await history.ensureSeed();
    await history.catchUp();
  } catch (err) {
    console.error('[history] init falló:', err.message);
  }

  // Tomas programadas: 4:00 y 16:00 (zona horaria configurable).
  const opts = { timezone: history.TZ };
  cron.schedule('0 4 * * *', () => history.takeSnapshot('AM').catch((e) => console.error('[cron AM]', e.message)), opts);
  cron.schedule('0 16 * * *', () => history.takeSnapshot('PM').catch((e) => console.error('[cron PM]', e.message)), opts);
  console.log(`  Tomas programadas: 04:00 y 16:00 (${history.TZ})\n`);
});
