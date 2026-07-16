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
const chatStore = require('./services/chatStore');
const { requireAuth, requireAdmin, publicConfig, authEnabled } = require('./services/auth');
const users = require('./services/users');
const clienteConfig = require('./services/clienteConfig');
const ivr = require('./services/ivr');
const calls = require('./services/calls');
const queue = require('./services/queue');
const schedule = require('./services/schedule');
const promesas = require('./services/promesas');
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

// Proxy de grabaciones (público: el <audio> no puede mandar token). Con
// allowlist de hosts. Re-sirve el WAV con Content-Length + Range para que el
// reproductor inline funcione.
app.get('/api/recordings/proxy', require('./services/recordingProxy').handle);

// A partir de aquí, todas las rutas /api requieren sesión (si la auth está activada).
app.use('/api', requireAuth);

// Fuentes + métricas puras (servidas desde el caché con TTL), con el flag
// enabled de cada cliente cruzado desde Supabase (cliente_config).
app.get('/api/data', async (req, res) => {
  try {
    const { clientes, llamadas, source, cachedAt, cacheAgeMs } = await getCachedData();

    let enabledMap = new Map();
    let ivrMap = new Map();
    try {
      [enabledMap, ivrMap] = await Promise.all([clienteConfig.getEnabledMap(), ivr.getIvrMap()]);
    } catch (e) {
      console.error('[cliente_config] no disponible, todos disabled:', e.message);
    }
    // Última llamada de cada cliente (para mostrar su status en la tabla).
    const ultimaPorTel = new Map();
    for (const ll of llamadas) {
      if (!ll.phone) continue;
      const prev = ultimaPorTel.get(ll.phone);
      if (!prev || new Date(ll.created_at) > new Date(prev.created_at)) ultimaPorTel.set(ll.phone, ll);
    }

    const conFlag = clientes.map((c) => {
      const i = ivrMap.get(c.phone);
      const ll = ultimaPorTel.get(c.phone);
      return {
        ...c,
        enabled: enabledMap.get(c.phone) === true,
        ivr: !!i,
        ivrDetalle: i ? i.detalle : null,
        ivrAt: i ? i.at : null,
        ultimaLlamada: ll
          ? {
              fecha: ll.created_at,
              intencion: ll.intencion_pago,
              fechaPago: ll.fecha_pago || null,
              notas: ll.notas || null,
              transcripcion: ll.transcripcion || null,
              grabacion: ll.grabacion || null,
            }
          : null,
      };
    });

    const metrics = computeMetrics(conFlag, llamadas);
    res.json({ source, clientes: conFlag, llamadas, metrics, cachedAt, cacheAgeMs });
  } catch (err) {
    console.error('[/api/data]', err);
    res.status(500).json({ error: err.message });
  }
});

// Activar / desactivar clientes para el cron de llamadas (uno o varios).
app.patch('/api/clientes/enabled', async (req, res) => {
  try {
    const { phones, enabled } = req.body || {};
    if (!Array.isArray(phones) || !phones.length) return res.status(400).json({ error: 'Falta phones[]' });
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'Falta enabled (boolean)' });
    const out = await clienteConfig.setEnabled(phones, enabled, req.user ? req.user.email : null);
    res.json(out);
  } catch (err) {
    console.error('[/api/clientes/enabled]', err);
    res.status(err.status || 500).json({ error: err.message });
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
    // Persistir el intercambio en el chat del usuario.
    if (req.user && result.answer && !result.noKey) {
      chatStore.append(req.user.email, question, result.answer, {
        model: result.model, usage: result.usage, costUsd: result.costUsd,
      }).catch(() => {});
    }
    res.json(result);
  } catch (err) {
    console.error('[/api/ask]', err);
    res.status(500).json({ error: err.message });
  }
});

// Historial del chat del Asistente (por usuario).
app.get('/api/ask/history', async (req, res) => {
  try { res.json({ thread: await chatStore.getThread(req.user && req.user.email) }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/ask/history', async (req, res) => {
  try { await chatStore.clear(req.user && req.user.email); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Historial de deuda por día (agregado desde Supabase).
app.get('/api/history', async (req, res) => {
  try {
    res.json({ daily: await history.getDailyHistory(), tz: history.TZ });
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

// Lanza llamadas. 1 cliente = inmediata. Varios = se ENCOLAN (1 por minuto,
// dentro del horario laboral). La cola vive en Supabase y sobrevive reinicios.
app.post('/api/calls/trigger', async (req, res) => {
  try {
    const { phones, origen } = req.body || {};
    if (!Array.isArray(phones) || !phones.length) return res.status(400).json({ error: 'Falta phones[]' });
    if (!calls.callsEnabled) return res.status(503).json({ error: 'Llamadas no configuradas (falta N8N_CALL_URL)' });

    const { clientes } = await getCachedData();
    const byPhone = new Map(clientes.map((c) => [c.phone, c]));
    const objetivo = phones.map((p) => byPhone.get(String(p))).filter((c) => c && c.phone);
    if (!objetivo.length) return res.status(404).json({ error: 'Ningún cliente coincide con esos teléfonos' });

    const por = req.user ? req.user.email : null;

    // Los marcados como IVR no se llaman nunca (ni siquiera a mano).
    const ivrPhones = await ivr.getIvrPhones();
    const permitidos = objetivo.filter((c) => !ivrPhones.has(c.phone));
    const omitidosIvr = objetivo.length - permitidos.length;
    if (!permitidos.length) {
      return res.status(409).json({ error: `Omitido: ${omitidosIvr} cliente(s) están marcados como IVR y no se llaman.` });
    }

    // Una sola: se dispara al momento (no espera turno en la cola).
    if (permitidos.length === 1) {
      const r = await calls.triggerBatch(permitidos, 'manual', por);
      return res.json({ ...r, inmediata: true, omitidosIvr });
    }

    // Varias: a la cola persistente (enqueue vuelve a filtrar IVR por seguridad).
    const r = await queue.enqueue(permitidos, origen === 'cron' ? 'cron' : 'bulk', por);
    const st = await queue.status();
    res.json({ ...r, encolado: true, enHorario: st.enHorario, horario: st.horario, minutosEstimados: st.minutosEstimados });
  } catch (err) {
    console.error('[/api/calls/trigger]', err);
    res.status(500).json({ error: err.message });
  }
});

// Estado de la cola de llamadas.
app.get('/api/calls/queue', async (req, res) => {
  try { res.json(await queue.status()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Horario de llamadas (bloques) — configurado desde la UI.
app.get('/api/calls/schedule', async (req, res) => {
  try { res.json(await schedule.get(true)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/calls/schedule', async (req, res) => {
  try {
    const { enabled, weekdaysOnly, autoEnqueue, blocks } = req.body || {};
    const cfg = await schedule.set(
      { enabled: !!enabled, weekdaysOnly: !!weekdaysOnly, autoEnqueue: !!autoEnqueue, blocks },
      req.user ? req.user.email : null
    );
    res.json(cfg);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// Encola manualmente a los clientes activos ahora (sin esperar al bloque).
app.post('/api/calls/enqueue-enabled', async (req, res) => {
  try {
    if (!calls.callsEnabled) return res.status(503).json({ error: 'Llamadas no configuradas (falta N8N_CALL_URL)' });
    const n = await queue.autoEnqueueEnabled();
    res.json({ encoladas: n });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Quita la marca de IVR (para reactivar a un cliente si consiguen otro número).
app.post('/api/clientes/:phone/ivr/reset', async (req, res) => {
  try { res.json(await ivr.desmarcar(req.params.phone)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Fuerza la detección de IVR ahora (sin esperar al cron).
app.post('/api/ivr/revisar', async (req, res) => {
  try {
    const { llamadas } = await getCachedData(true);
    res.json(await ivr.sincronizar(llamadas));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Promesas de pago: resumen (pendientes / cumplidas / incumplidas).
app.get('/api/promesas', async (req, res) => {
  try { res.json(await promesas.resumen()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Fuerza la revisión de promesas ahora (útil para probar sin esperar al cron).
app.post('/api/promesas/revisar', async (req, res) => {
  try { res.json(await revisarPromesas()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Cancelar todas las llamadas pendientes en la cola.
app.delete('/api/calls/queue', async (req, res) => {
  try { res.json(await queue.cancelarTodo()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Últimos disparos (para auditar qué se lanzó y cuándo).
app.get('/api/calls/log', async (req, res) => {
  try {
    const rows = await require('./services/supabaseDb')
      .select('llamada_disparo', '?select=*&order=created_at.desc&limit=100');
    res.json({ disparos: rows || [] });
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
  console.log(`  Tomas programadas: 04:00 y 16:00 (${history.TZ})`);

  // Worker de la cola: cada minuto saca UNA llamada (si estamos dentro de un
  // bloque del horario configurado en la UI). También auto-encola a los activos
  // 1x/día al entrar al primer bloque.
  cron.schedule('* * * * *', () => queue.tick().catch((e) => console.error('[cola tick]', e.message)), opts);

  // IVR: cada 10 min revisa las llamadas nuevas y desactiva a los que cayeron
  // en contestadora (para que el cron de las 10 ya no los tome).
  cron.schedule('*/10 * * * *', () => revisarIvr().catch((e) => console.error('[cron ivr]', e.message)), opts);

  // Promesas: cada día a las 9:30 (antes del cron de las 10) detecta promesas
  // nuevas y encola al SUB-AGENTE a quienes prometieron y no pagaron.
  const PROMESA_CRON = process.env.PROMESA_CRON || '30 9 * * *';
  cron.schedule(PROMESA_CRON, () => revisarPromesas().catch((e) => console.error('[cron promesas]', e.message)), opts);
  console.log(`  Promesas: ${PROMESA_CRON} (${history.TZ}) · sub-agente ${calls.followupEnabled ? 'ACTIVO' : 'no configurado (usa el principal)'} · gracia ${promesas.GRACIA_DIAS} día(s)`);

  const st = await queue.status().catch(() => null);
  console.log(`  Llamadas: ${calls.callsEnabled ? 'ACTIVO' : 'inactivo (falta N8N_CALL_URL)'}`);
  console.log(`  Horario (configurable en la UI): ${st ? (st.scheduleEnabled ? st.horario : 'DESACTIVADO') : 'n/d'}${st ? ` · pendientes: ${st.pendientes}` : ''}\n`);
});

// Marca como IVR (y desactiva) a los clientes cuyas llamadas cayeron en contestadora.
async function revisarIvr() {
  const { llamadas } = await getCachedData();
  return ivr.sincronizar(llamadas);
}

// Promesas de pago: (1) detecta promesas nuevas en las llamadas, (2) revisa las
// vencidas y encola al sub-agente a quien prometió y sigue debiendo.
async function revisarPromesas() {
  const { clientes, llamadas } = await getCachedData(true);
  const sync = await promesas.sincronizar(llamadas, clientes);
  const rev = await promesas.revisarIncumplidas(clientes);
  return { ...sync, ...rev };
}

