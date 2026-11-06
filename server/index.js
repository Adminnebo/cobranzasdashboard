require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');

const { getCachedData, cacheInfo, invalidate: invalidarCache } = require('./services/cache');
const pruebas = require('./services/pruebas');
const { computeMetrics } = require('./services/metrics');
const { analyzePortfolio } = require('./services/ai');
const { ask } = require('./services/ask');
const chatStore = require('./services/chatStore');
const correo = require('./services/correo');
const { requireAuth, requireAdmin, requireAdminRol, requirePlatform, requirePermission, publicConfig, authEnabled, perfilDe, plataformasDe, permisosDe } = require('./services/auth');
const users = require('./services/users');
const clienteConfig = require('./services/clienteConfig');
const callLists = require('./services/callLists');
const ivr = require('./services/ivr');
const calls = require('./services/calls');
const queue = require('./services/queue');
const schedule = require('./services/schedule');
const agents = require('./services/agents');
const promesas = require('./services/promesas');
const fichas = require('./services/fichas');
const iaCosto = require('./services/iaCosto');
const history = require('./services/history');
const cobros = require('./services/cobros');
const retirosLogistica = require('./services/retirosLogistica');

const app = express();

// ── Seguridad: cabeceras + rate limit ────────────────────────────────────────
const { hardening, rateLimit } = require('./security');
hardening(app);
app.use(cors());
app.use(express.json());

// Rate limit por IP SOLO para el panel. Endpoints de máquina/audio (health,
// config, recordings, hooks, avisos de logística) EXENTOS.
const esMaquinaCo = req => /^\/(health|config|recordings|hooks|logistica)/.test(req.path);
app.use('/api', rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
  max: Number(process.env.RATE_LIMIT_USER || 300),
  skip: esMaquinaCo
}));

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
// correo: la pestaña Correo (Gmail de cobranzas) solo aparece si el servicio está configurado.
app.get('/api/config', (req, res) => res.json({ ...publicConfig(), correo: correo.configurado() ? { embed: correo.embedUrl() } : null }));

// Proxy de grabaciones (público: el <audio> no puede mandar token). Con
// allowlist de hosts. Re-sirve el WAV con Content-Length + Range para que el
// reproductor inline funcione.
app.get('/api/recordings/proxy', require('./services/recordingProxy').handle);

// Avisos de logística sobre los retiros (por ubicar, en ruta, retirado…). Sin
// sesión: lo llama el servidor de logística con x-logistica-token.
app.post('/api/logistica/retiros/aviso', retirosLogistica.manejarAviso);

// A partir de aquí, todas las rutas /api requieren sesión (si la auth está activada).
app.use('/api', requireAuth);

// /api/me va ANTES del gate de plataforma: aunque el usuario no tenga acceso a
// cobranzas, el frontend necesita leer sus plataformas para mostrar la pantalla
// de "sin acceso" (y a qué sí puede entrar).
app.get('/api/me', async (req, res) => {
  const p = req.user ? await perfilDe(req.user.id) : null;
  res.json({
    email: req.user ? req.user.email : null,
    isAdmin: req.user ? !!req.user.isAdmin : false,
    role: (p && p.role) || null,
    platforms: plataformasDe(p && p.role, p && p.platforms),
    permissions: req.user && req.user.isAdmin ? permisosDe({ role: 'admin' }) : permisosDe(p || {})
  });
});

// El resto exige acceso a la plataforma 'cobranzas'.
app.use('/api', requirePlatform('cobranzas'));

// Super admin de profiles (o sin auth, en local). Las llamadas de prueba y su
// lista solo las ven ellos.
async function esSuperAdmin(req) {
  if (!authEnabled) return true;
  if (!req.user) return false;
  if (req.role) return req.role === 'super_admin';
  const p = await perfilDe(req.user.id).catch(() => null);
  return !!p && p.role === 'super_admin';
}
async function soloSuperAdmin(req, res, next) {
  if (await esSuperAdmin(req)) return next();
  return res.status(403).json({ error: 'Solo super admins' });
}

// Números de prueba: sus llamadas no cuentan y solo las ven super admins.
app.get('/api/pruebas', soloSuperAdmin, async (req, res) => {
  try { res.json({ numeros: await pruebas.list(true) }); }
  catch (err) { res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') }); }
});
app.post('/api/pruebas', soloSuperAdmin, async (req, res) => {
  try {
    const numeros = await pruebas.add(req.body && req.body.phone, req.body && req.body.nota, req.user ? req.user.email : null);
    invalidarCache();
    res.json({ numeros });
  } catch (err) { res.status(err.status || 500).json({ error: err.status ? err.message : (console.error(req.path, err), 'Error interno del servidor') }); }
});
app.delete('/api/pruebas/:phone', soloSuperAdmin, async (req, res) => {
  try { const numeros = await pruebas.remove(req.params.phone); invalidarCache(); res.json({ numeros }); }
  catch (err) { res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') }); }
});

// Fuentes + métricas puras (servidas desde el caché con TTL), con el flag
// enabled de cada cliente cruzado desde Supabase (cliente_config).
app.get('/api/data', async (req, res) => {
  try {
    const { clientes, llamadas, llamadasPrueba, source, cachedAt, cacheAgeMs } = await getCachedData();
    const superAdmin = await esSuperAdmin(req);

    let enabledMap = new Map();
    let ivrMap = new Map();
    let estadoMap = new Map();
    try {
      [enabledMap, ivrMap] = await Promise.all([clienteConfig.getEnabledMap(), ivr.getIvrMap()]);
    } catch (e) {
      console.error('[cliente_config] no disponible, todos disabled:', e.message);
    }
    // Estado de cobro (promesa / dice que pagó / pasar a una persona). Si las
    // columnas aún no existen (sql/003 sin correr), se sigue sin estados.
    try { estadoMap = await clienteConfig.getEstadoMap(); } catch (e) { /* sin estados */ }
    const horarioInfo = await clienteConfig.getHorarioInfoMap();
    const horarioMap = new Map([...horarioInfo].map(([k, v]) => [k, v.horario]));
    const [citaMap, atencionMap] = await Promise.all([clienteConfig.getCitaMap(), clienteConfig.getAtencionMap()]);
    const faseB = (phone) => {
      const ci = citaMap.get(phone); const at = atencionMap.get(phone);
      return {
        cita: ci ? { at: ci.at, texto: ci.texto, origen: ci.origen, movida: ci.movida } : null,
        atencionMotivo: at ? at.motivo : null, atencionAt: at ? at.at : null,
      };
    };
    const forzados = superAdmin ? await clienteConfig.getForzadosSet() : new Set();
    // Última llamada de cada cliente (para mostrar su status en la tabla).
    const ultimaPorTel = new Map();
    for (const ll of llamadas) {
      if (!ll.phone) continue;
      const prev = ultimaPorTel.get(ll.phone);
      if (!prev || new Date(ll.created_at) > new Date(prev.created_at)) ultimaPorTel.set(ll.phone, ll);
    }

    const conFlag = clientes.map((cRaw) => {
      const { _raw, ...c } = cRaw; // _raw es solo para el backend (Asistente)
      const i = ivrMap.get(c.phone);
      const ll = ultimaPorTel.get(c.phone);
      return {
        ...c,
        enabled: enabledMap.get(c.phone) === true,
        ivr: !!i,
        ivrTipo: i ? i.tipo : null,
        ivrDetalle: i ? i.detalle : null,
        ivrAt: i ? i.at : null,
        estadoCobro: (estadoMap.get(c.phone) || {}).estado || null,
        estadoDetalle: (estadoMap.get(c.phone) || {}).detalle || null,
        estadoAt: (estadoMap.get(c.phone) || {}).at || null,
        horario: horarioMap.get(c.phone) || null,
        horarioOrigen: (horarioInfo.get(c.phone) || {}).origen || null,
        horarioDetalle: (horarioInfo.get(c.phone) || {}).detalle || null,
        ...faseB(c.phone),
        forzarFollowUp: forzados.has(c.phone),
        ultimaLlamada: ll
          ? {
              fecha: ll.created_at,
              intencion: ll.intencion_pago,
              fechaPago: ll.fecha_pago || null,
              notas: ll.notas || null,
              transcripcion: ll.transcripcion || null,
              grabacion: ll.grabacion || null,
              agente: ll.agente,
              resultado: ll.resultado || null,
            }
          : null,
      };
    });

    const metrics = computeMetrics(conFlag, llamadas);
    // Números de prueba como clientes ficticios, al final y solo para super
    // admins (después de las métricas: no cuentan en nada).
    if (superAdmin) {
      for (const f of await pruebas.clientesFicticios(clientes).catch(() => [])) {
        const { _prueba, ...c } = f;
        const est = estadoMap.get(c.phone) || {};
        let ll = null;
        for (const x of llamadasPrueba || []) if (x.phone === c.phone && (!ll || new Date(x.created_at) > new Date(ll.created_at))) ll = x;
        conFlag.push({
          ...c, prueba: true, enabled: enabledMap.get(c.phone) === true, ivr: false,
          estadoCobro: est.estado || null, estadoDetalle: est.detalle || null, estadoAt: est.at || null,
          horario: horarioMap.get(c.phone) || null,
          horarioOrigen: (horarioInfo.get(c.phone) || {}).origen || null,
          horarioDetalle: (horarioInfo.get(c.phone) || {}).detalle || null,
          ...faseB(c.phone),
          ultimaLlamada: ll
            ? { fecha: ll.created_at, intencion: ll.intencion_pago, fechaPago: ll.fecha_pago || null, notas: ll.notas || null,
                transcripcion: ll.transcripcion || null, grabacion: ll.grabacion || null, agente: ll.agente, resultado: ll.resultado || null }
            : null,
        });
      }
    }
    // Las llamadas de prueba nunca entran en métricas; solo los super admins las ven.
    const visibles = superAdmin ? [...llamadas, ...(llamadasPrueba || [])] : llamadas;
    const llamadasSlim = visibles.map(({ _raw, ...l }) => l);
    res.json({ source, clientes: conFlag, llamadas: llamadasSlim, metrics, cachedAt, cacheAgeMs, verPruebas: superAdmin });
  } catch (err) {
    console.error('[/api/data]', err);
    res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') });
  }
});

// Activar / desactivar clientes para el cron de llamadas (uno o varios).
app.patch('/api/clientes/enabled', requirePermission('cobranzas.cliente_toggle'), async (req, res) => {
  try {
    const { phones, enabled } = req.body || {};
    if (!Array.isArray(phones) || !phones.length) return res.status(400).json({ error: 'Falta phones[]' });
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'Falta enabled (boolean)' });
    const por = req.user ? req.user.email : null;
    const out = await clienteConfig.setEnabled(phones, enabled, por);
    // La decisión de una persona manda sobre el follow up automático.
    await promesas.cancelarPorCambioManual(phones, por).catch((e) => console.error('[promesas] cancelar manual:', e.message));
    res.json(out);
  } catch (err) {
    console.error('[/api/clientes/enabled]', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : (console.error(req.path, err), 'Error interno del servidor') });
  }
});

// "Forzar follow up" en un cliente real sin vencido (pruebas). Solo super admins.
app.put('/api/clientes/forzar-follow-up', soloSuperAdmin, async (req, res) => {
  try {
    const { phone, forzar } = req.body || {};
    if (!phone || typeof forzar !== 'boolean') return res.status(400).json({ error: 'Falta phone y forzar (boolean)' });
    res.json(await clienteConfig.setForzado(phone, forzar, req.user ? req.user.email : null));
  } catch (err) {
    res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') });
  }
});

// Horario propio de uno o varios clientes. horario: [{start,end}] o null (sigue el general).
app.put('/api/clientes/horario', requirePermission('cobranzas.cliente_toggle'), async (req, res) => {
  try {
    const { phones, horario } = req.body || {};
    if (!Array.isArray(phones) || !phones.length) return res.status(400).json({ error: 'Falta phones[]' });
    const cfg = await schedule.get(true);
    const limpio = schedule.validarHorarioCliente(cfg, horario);
    res.json(await clienteConfig.setHorario(phones, limpio, req.user ? req.user.email : null, { origen: 'manual' }));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : (console.error(req.path, err), 'Error interno del servidor') });
  }
});

// Hora pedida a mano: { phone, at: ISO | null }. Manda sobre su horario y el general,
// solo para la próxima llamada. Tiene que ser a futuro y dentro del rango de horarios de cliente.
app.put('/api/clientes/cita', requirePermission('cobranzas.cliente_toggle'), async (req, res) => {
  try {
    const { phone, at } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'Falta phone' });
    const por = req.user ? req.user.email : null;
    if (!at) {
      if (!(await clienteConfig.setCita(String(phone), null, { updatedBy: por }))) return res.status(409).json({ error: 'Falta correr sql/013' });
      return res.json({ ok: true, cita: null });
    }
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'Fecha u hora inválida' });
    if (d.getTime() <= Date.now()) return res.status(400).json({ error: 'La hora tiene que ser a futuro' });
    const cfg = await schedule.get(true);
    const hhmm = schedule.minsAHhmm(schedule.partsInTz(d).mins);
    if (hhmm < cfg.horarioClienteDesde || hhmm >= cfg.horarioClienteHasta) {
      return res.status(400).json({ error: `La hora tiene que estar entre ${cfg.horarioClienteDesde} y ${cfg.horarioClienteHasta}` });
    }
    if (!(await clienteConfig.setCita(String(phone), d.toISOString(), { texto: 'puesta a mano', origen: 'manual', updatedBy: por }))) {
      return res.status(409).json({ error: 'Falta correr sql/013' });
    }
    res.json({ ok: true, cita: d.toISOString() });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : (console.error(req.path, err), 'Error interno del servidor') });
  }
});

// "Listo": una persona ya atendió a un cliente que la cola mandó a 🙋 Por atender.
app.post('/api/clientes/atencion/listo', requirePermission('cobranzas.cliente_toggle'), async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'Falta phone' });
    await clienteConfig.setAtencion(String(phone), null, req.user ? req.user.email : null);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') });
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
    res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') });
  }
});

// Asistente: pregunta libre / proyección sobre los datos de la cartera.
app.post('/api/ask', requirePermission('cobranzas.asistente'), async (req, res) => {
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
    res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') });
  }
});

// Historial del chat del Asistente (por usuario).
app.get('/api/ask/history', requirePermission('cobranzas.asistente'), async (req, res) => {
  try { res.json({ thread: await chatStore.getThread(req.user && req.user.email) }); }
  catch (err) { res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') }); }
});

app.delete('/api/ask/history', requirePermission('cobranzas.asistente'), async (req, res) => {
  try { await chatStore.clear(req.user && req.user.email); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') }); }
});

// Historial de deuda por día (agregado desde Supabase).
app.get('/api/history', async (req, res) => {
  try {
    res.json({ daily: await history.getDailyHistory(), tz: history.TZ });
  } catch (err) {
    res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') });
  }
});

// Cobros detectados comparando la foto diaria de la cartera del ERP con la anterior.
// Los nombres salen de la cartera del panel (mismo código de cliente del ERP).
app.get('/api/cobros', requirePermission('cobranzas.cartera'), async (req, res) => {
  try {
    const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : undefined);
    const [r, datos] = await Promise.all([
      cobros.resumen({ desde: ymd(req.query.desde), hasta: ymd(req.query.hasta) }),
      getCachedData().catch(() => ({ clientes: [] })),
    ]);
    const porCodigo = new Map((datos.clientes || []).filter((c) => c.codigo).map((c) => [String(c.codigo), c]));
    r.clientes = r.clientes.map((c) => {
      const k = porCodigo.get(c.codigo);
      return { ...c, nombre: k ? k.name : null, phone: k ? k.phone : null, deudaHoy: k ? k.deuda_total : null, enCartera: !!k };
    });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') });
  }
});

app.get('/api/cobros/cliente/:codigo', requirePermission('cobranzas.cartera'), async (req, res) => {
  try { res.json(await cobros.deCliente(req.params.codigo)); }
  catch (err) { res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') }); }
});

// Toma la foto ahora (reemplaza la de hoy). Solo admin.
app.post('/api/cobros/foto', requireAdmin, async (req, res) => {
  try { res.json(await cobros.tomarFoto({ origen: 'manual' })); }
  catch (err) { console.error(req.path, err); res.status(500).json({ error: err.message }); }
});

// Captura manual (útil para probar / forzar un punto).
app.post('/api/history/snapshot', async (req, res) => {
  try {
    const snap = await history.takeSnapshot('manual');
    res.json(snap);
  } catch (err) {
    res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') });
  }
});

// Lanza llamadas. 1 cliente = inmediata. Varios = se ENCOLAN (1 por minuto,
// dentro del horario laboral). La cola vive en Supabase y sobrevive reinicios.
app.post('/api/calls/trigger', requirePermission('cobranzas.llamadas'), async (req, res) => {
  try {
    const { phones, origen, encolar } = req.body || {};
    if (!Array.isArray(phones) || !phones.length) return res.status(400).json({ error: 'Falta phones[]' });
    if (!calls.callsEnabled) return res.status(503).json({ error: 'Llamadas no configuradas (falta N8N_CALL_URL)' });

    const { clientes } = await getCachedData();
    // Los números de prueba también se pueden llamar/encolar (como clientes ficticios).
    const ficticios = await pruebas.clientesFicticios(clientes).catch(() => []);
    const byPhone = new Map([...clientes, ...ficticios].map((c) => [c.phone, c]));
    const objetivo = phones.map((p) => byPhone.get(String(p))).filter((c) => c && c.phone);
    if (!objetivo.length) return res.status(404).json({ error: 'Ningún cliente coincide con esos teléfonos' });

    const por = req.user ? req.user.email : null;

    // Los marcados como IVR se excluyen del BULK/cron automáticamente. A mano
    // (origen 'manual') SÍ se permiten: es una decisión explícita del agente.
    const esManual = origen === 'manual';
    const ivrPhones = esManual ? new Set() : await ivr.getIvrPhones();
    const permitidos = objetivo.filter((c) => !ivrPhones.has(c.phone));
    const omitidosIvr = objetivo.length - permitidos.length;
    if (!permitidos.length) {
      return res.status(409).json({ error: `Omitido: ${omitidosIvr} cliente(s) están marcados como IVR y no se llaman.` });
    }

    // Una sola: se dispara al momento (no espera turno en la cola), salvo que
    // pidan encolarla (respeta el horario general y el propio del cliente).
    if (permitidos.length === 1 && !encolar) {
      const r = await calls.triggerBatch(permitidos, 'manual', por);
      return res.json({ ...r, inmediata: true, omitidosIvr });
    }

    // Varias: a la cola persistente (enqueue vuelve a filtrar IVR por seguridad).
    const r = await queue.enqueue(permitidos, origen === 'cron' ? 'cron' : 'bulk', por);
    const st = await queue.status();
    res.json({ ...r, encolado: true, enHorario: st.enHorario, horario: st.horario, minutosEstimados: st.minutosEstimados });
  } catch (err) {
    console.error('[/api/calls/trigger]', err);
    res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') });
  }
});

// ── Listas de llamadas (segmentos guardados) ──
app.get('/api/lists', requirePermission('cobranzas.llamadas'), async (req, res) => {
  try { res.json({ lists: await callLists.list() }); }
  catch (err) { res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') }); }
});

app.post('/api/lists', requirePermission('cobranzas.llamadas'), async (req, res) => {
  try {
    const { name, phones } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'Falta el nombre de la lista' });
    if (!Array.isArray(phones) || !phones.length) return res.status(400).json({ error: 'La lista no tiene clientes' });
    const row = await callLists.create(String(name).trim(), phones, req.user ? req.user.email : null);
    res.json({ ok: true, id: row && row.id });
  } catch (err) { res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') }); }
});

app.put('/api/lists/:id', requirePermission('cobranzas.llamadas'), async (req, res) => {
  try {
    const { name, phones } = req.body || {};
    res.json(await callLists.update(req.params.id, { name, phones }));
  } catch (err) { res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') }); }
});

app.delete('/api/lists/:id', requirePermission('cobranzas.llamadas'), async (req, res) => {
  try { res.json(await callLists.remove(req.params.id)); }
  catch (err) { res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') }); }
});

// Estado de la cola de llamadas.
app.get('/api/calls/queue', requirePermission('cobranzas.llamadas'), async (req, res) => {
  try { res.json(await queue.status()); }
  catch (err) { res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') }); }
});

// La cola completa, en el orden en que se va a llamar.
app.get('/api/calls/queue/lista', requirePermission('cobranzas.llamadas'), async (req, res) => {
  try { res.json(await queue.lista()); }
  catch (err) { res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') }); }
});

// Quitar UNA llamada de la cola. Si era un follow up, su promesa se cierra
// ("cancelada a mano") para que el motor no la vuelva a encolar.
app.delete('/api/calls/queue/:id', requirePermission('cobranzas.llamadas'), async (req, res) => {
  try {
    const por = req.user ? req.user.email : null;
    const row = await queue.quitar(req.params.id, por);
    if (!row) return res.status(404).json({ error: 'Esa llamada ya no está en la cola' });
    if (row.agente === 'seguimiento') {
      await promesas.cancelarPorCambioManual([row.phone], por);
      await clienteConfig.salirEstado(String(row.phone));
    }
    res.json({ ok: true, followUp: row.agente === 'seguimiento' });
  } catch (err) { res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') }); }
});

// Horario de llamadas (bloques) — configurado desde la UI.
app.get('/api/calls/schedule', requirePermission('cobranzas.horario'), async (req, res) => {
  try { res.json(await schedule.get(true)); }
  catch (err) { res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') }); }
});

app.put('/api/calls/schedule', requirePermission('cobranzas.horario'), async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {
      enabled: !!b.enabled, weekdaysOnly: !!b.weekdaysOnly, autoEnqueue: !!b.autoEnqueue, blocks: b.blocks,
    };
    // El agente solo se toca si viene en el body, para no borrarlo sin querer
    // al guardar otros ajustes. agentId '' o null => sin agente.
    if ('agentId' in b) {
      patch.agentId = b.agentId || null;
      patch.agentName = b.agentName || null;
    }
    // Ajustes del follow up: solo si vienen.
    for (const k of ['promesaTope', 'promesaMaxAtraso', 'reintentoHoras', 'horarioClienteDesde', 'horarioClienteHasta', 'followUpMargenDias', 'retiroManana', 'retiroTarde', 'horarioAuto', 'fuVentanaDias', 'fuReintentosDia1', 'fuSinFechaMismoDia', 'fuCadaDias', 'citaVentanaMin', 'maxMovidas']) if (k in b) patch[k] = b[k];
    const cfg = await schedule.set(patch, req.user ? req.user.email : null);
    res.json(cfg);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : (console.error(req.path, err), 'Error interno del servidor') });
  }
});

// Agentes de voz disponibles (para elegir quién llama). Se consulta desde el
// servidor: la API key nunca sale al navegador.
app.get('/api/agents', async (req, res) => {
  try { res.json(await agents.list()); }
  catch (err) { res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') }); }
});

// Encola manualmente a los clientes activos ahora (sin esperar al bloque).
app.post('/api/calls/enqueue-enabled', requirePermission('cobranzas.llamadas'), async (req, res) => {
  try {
    if (!calls.callsEnabled) return res.status(503).json({ error: 'Llamadas no configuradas (falta N8N_CALL_URL)' });
    const n = await queue.autoEnqueueEnabled();
    res.json({ encoladas: n });
  } catch (err) { res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') }); }
});

// Quita la marca de IVR (para reactivar a un cliente si consiguen otro número).
app.post('/api/clientes/:phone/ivr/reset', async (req, res) => {
  try { res.json(await ivr.desmarcar(req.params.phone)); }
  catch (err) { res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') }); }
});

// Fuerza la detección de IVR ahora (sin esperar al cron).
app.post('/api/ivr/revisar', async (req, res) => {
  try {
    const { llamadas } = await getCachedData(true);
    res.json(await ivr.sincronizar(llamadas));
  } catch (err) { res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') }); }
});

// Promesas de pago: resumen (pendientes / cumplidas / incumplidas).
app.get('/api/promesas', requirePermission('cobranzas.promesas'), async (req, res) => {
  try { res.json(await promesas.resumen()); }
  catch (err) { res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') }); }
});

// Lista de promesas para la pestaña Promesas, con el nombre de la cartera.
// Las de números de prueba solo las ven los super admins (marcadas "prueba").
app.get('/api/promesas/lista', requirePermission('cobranzas.promesas'), async (req, res) => {
  try {
    const [rows, { clientes }, setPruebas, superAdmin, cfg, fichasMap, logisticaMap] = await Promise.all([
      promesas.lista(), getCachedData(), pruebas.phones(), esSuperAdmin(req), schedule.get(), fichas.mapaReciente(),
      retirosLogistica.mapaPorLlamada(),
    ]);
    // Ficha de la llamada que dejó cada promesa (retiro, hora pedida). Si un
    // follow up reprogramó sin repetir cómo paga, vale lo dicho en la anterior.
    // Solo lo que dijo en la llamada de ESTA promesa (no se hereda de promesas anteriores).
    const fichaDe = (r) => {
      const fx = r.llamada_key ? fichasMap.get(r.llamada_key) : null;
      if (!fx) return null;
      return {
        key: fx.llamada_key, llamadaAt: fx.llamada_at || null,
        modalidad: fx.modalidad || null, retiro: fx.retiro || null, llamar: fx.llamar || null, disponibilidad: fx.disponibilidad || null,
      };
    };
    const porTel = new Map((clientes || []).map((c) => [String(c.phone), c]));
    // Los números de prueba con su nombre y su vencido ficticio (solo super admins).
    if (superAdmin) for (const f of await pruebas.clientesFicticios(clientes || []).catch(() => [])) porTel.set(f.phone, f);
    const out = [];
    for (const r of rows) {
      const prueba = setPruebas.has(pruebas.phoneKey(r.phone));
      if (prueba && !superAdmin) continue;
      const c = porTel.get(String(r.phone));
      out.push({
        id: r.id, phone: r.phone, prueba,
        nombre: (c && c.name) || r.nombre || (prueba ? 'Prueba' : null),
        empresa: c ? c.empresa : null,
        vencidoHoy: c ? c.deuda_vencida : null,
        estado: r.estado, intento: r.intento || 1, reintentos: r.reintentos || 0,
        fechaPrometida: r.fecha_prometida, textoOriginal: r.texto_original,
        followUpFecha: r.fecha_prometida ? schedule.fechaFollowUp(r.fecha_prometida, cfg) : null,
        ficha: fichaDe(r),
        // Cómo va el retiro en logística (si se mandó): estado, ruta, monto, RCP, error.
        logistica: (r.llamada_key && logisticaMap.get(r.llamada_key)) || null,
        prometidaEl: r.fecha_llamada, llamadaId: r.llamada_id || null, montoAlPrometer: r.monto_al_prometer,
        agente: r.agente, origen: r.origen,
        proximoIntento: r.proximo_intento_at, seguimientoAt: r.seguimiento_at,
        ventanaDesde: r.ventana_desde || null, ventanaHasta: r.ventana_hasta || null,
        cerradaAt: r.cerrada_at, motivoCierre: r.motivo_cierre,
        anteriorId: r.promesa_anterior_id, createdAt: r.created_at,
      });
    }
    res.json({ promesas: out, tope: cfg.promesaTope, followUpMargenDias: cfg.followUpMargenDias, retiroManana: cfg.retiroManana, retiroTarde: cfg.retiroTarde, superAdmin });
  } catch (err) { res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') }); }
});

// "No es retiro": corrección a mano de la ficha de una llamada.
app.post('/api/fichas/no-retiro', requirePermission('cobranzas.promesas'), async (req, res) => {
  try {
    await fichas.marcarNoRetiro((req.body || {}).llamadaKey, req.user ? req.user.email : null);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : (console.error(req.path, err), 'Error interno del servidor') });
  }
});

// Deshacer un "retirado" de logística (p. ej. una prueba): vuelve a pendiente. Solo super admins.
app.post('/api/retiros/volver-pendiente', soloSuperAdmin, async (req, res) => {
  try {
    res.json({ ok: true, ...(await retirosLogistica.volverAPendiente((req.body || {}).externoId, req.user ? req.user.email : null)) });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : (console.error(req.path, err), 'Error interno del servidor') });
  }
});

// Costo de la IA que lee las llamadas y su cobro en Sword (solo super admins).
app.get('/api/ia-consumo', soloSuperAdmin, async (req, res) => {
  try { res.json(await iaCosto.resumen()); }
  catch (err) { res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') }); }
});
app.put('/api/ia-consumo/config', soloSuperAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const patch = {};
    for (const k of ['precioEntrada', 'precioCache', 'precioSalida', 'margenPct', 'cobrarSword']) if (k in b) patch[k] = b[k];
    await iaCosto.setConfig(patch, req.user ? req.user.email : null);
    res.json(await iaCosto.resumen());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : (console.error(req.path, err), 'Error interno del servidor') });
  }
});
app.post('/api/ia-consumo/cobros/:id', soloSuperAdmin, async (req, res) => {
  try {
    await iaCosto.resolver(req.params.id, (req.body || {}).accion, req.user ? req.user.email : null);
    res.json(await iaCosto.resumen());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : (console.error(req.path, err), 'Error interno del servidor') });
  }
});

// Reabrir una promesa cerrada (pruebas). Solo super admins. Corre el motor
// enseguida: si la fecha ya llegó, el follow up entra a la cola.
app.post('/api/promesas/:id/reabrir', soloSuperAdmin, async (req, res) => {
  try {
    await promesas.reabrir(req.params.id, req.user ? req.user.email : null);
    const r = await promesas.correr({ fresco: true }).catch((e) => ({ error: e.message }));
    res.json({ ok: true, revision: r });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : (console.error(req.path, err), 'Error interno del servidor') });
  }
});

// Fuerza la revisión de promesas ahora (útil para probar sin esperar al cron).
app.post('/api/promesas/revisar', requirePermission('cobranzas.promesas'), async (req, res) => {
  try { res.json(await promesas.correr({ fresco: true })); }
  catch (err) { res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') }); }
});

// Cancelar todas las llamadas pendientes en la cola.
app.delete('/api/calls/queue', requirePermission('cobranzas.llamadas'), async (req, res) => {
  try { res.json(await queue.cancelarTodo()); }
  catch (err) { res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') }); }
});

// Últimos disparos (para auditar qué se lanzó y cuándo).
app.get('/api/calls/log', requirePermission('cobranzas.clientes'), async (req, res) => {
  try {
    const rows = await require('./services/supabaseDb')
      .select('llamada_disparo', '?select=*&order=created_at.desc&limit=100');
    res.json({ disparos: rows || [] });
  } catch (err) {
    res.status(500).json({ error: (console.error(req.path, err), 'Error interno del servidor') });
  }
});

// ── Administración de usuarios (solo admins) ──
// Correo de cobranzas (Gmail del cliente vía correo-servicio): admins y super admins.
app.use('/api/correo', requireAdminRol, correo.router);

app.get('/api/users', requireAdmin, async (req, res) => {
  try { res.json({ users: await users.listUsers() }); }
  catch (err) { res.status(err.status || 500).json({ error: err.status ? err.message : (console.error(req.path, err), 'Error interno del servidor') }); }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  try {
    const { email, password, admin } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
    if (String(password).length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    res.json(await users.createUser({ email: String(email).trim(), password: String(password), admin: !!admin }));
  } catch (err) { res.status(err.status || 500).json({ error: err.status ? err.message : (console.error(req.path, err), 'Error interno del servidor') }); }
});

app.patch('/api/users/:id', requireAdmin, async (req, res) => {
  try { res.json(await users.updateUser(req.params.id, req.body || {})); }
  catch (err) { res.status(err.status || 500).json({ error: err.status ? err.message : (console.error(req.path, err), 'Error interno del servidor') }); }
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  try {
    // Evitar que un admin se borre a sí mismo.
    if (req.user && req.params.id === req.user.id) return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta' });
    res.json(await users.deleteUser(req.params.id));
  } catch (err) { res.status(err.status || 500).json({ error: err.status ? err.message : (console.error(req.path, err), 'Error interno del servidor') }); }
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

  // Cobros: una foto al día de las facturas abiertas del ERP (al cierre, después
  // de que JH sincroniza). Al arrancar, si hoy no hay foto, se toma.
  if (cobros.erpConfigurado()) {
    const COBROS_CRON = process.env.COBROS_CRON || '30 22 * * *';
    cron.schedule(COBROS_CRON, () => cobros.tomarFoto({ origen: 'cron' }).catch((e) => console.error('[cron cobros]', e.message)), opts);
    cobros.ponerseAlDia().catch((e) => console.error('[cobros] inicio:', e.message));
    console.log(`  Cobros: foto diaria ${COBROS_CRON} (${history.TZ})`);
  } else {
    console.log('  Cobros: inactivo (faltan MSSQL_SERVER / MSSQL_USER / MSSQL_PASSWORD / MSSQL_DATABASE)');
  }

  // Worker de la cola: corre cada CALL_WORKER_INTERVAL_MS (default 15s). En cada
  // tick, si hay cupo de concurrencia (consultando VAPI) y estamos dentro de un
  // bloque del horario, lanza UNA llamada. Así llena los cupos rápido y mantiene
  // hasta CALL_MAX_CONCURRENT simultáneas. También auto-encola a los activos 1x/día.
  const WORKER_MS = parseInt(process.env.CALL_WORKER_INTERVAL_MS || '15000', 10);
  setInterval(() => queue.tick().catch((e) => console.error('[cola tick]', e.message)), WORKER_MS);

  // IVR: cada 10 min revisa las llamadas nuevas y desactiva a los que cayeron
  // en contestadora (para que el cron de las 10 ya no los tome).
  cron.schedule('*/10 * * * *', () => revisarIvr().catch((e) => console.error('[cron ivr]', e.message)), opts);

  // Motor de promesas / follow up: cada minuto registra las promesas de las
  // llamadas nuevas y encola los follow ups del día (entran en los lotes del
  // horario como las demás llamadas).
  // Variable nueva a propósito: PROMESA_CRON (la del motor viejo, 1×/día a las
  // 9:30) puede seguir puesta en el entorno y frenaría el follow up.
  const PROMESA_CRON = process.env.MOTOR_PROMESAS_CRON || '* * * * *';
  cron.schedule(PROMESA_CRON, () => promesas.correr().catch((e) => console.error('[cron promesas]', e.message)), opts);
  console.log(`  Promesas / follow up: ${PROMESA_CRON} (${history.TZ}) · follow up ${calls.followupEnabled ? 'ACTIVO' : 'no configurado (usa el principal)'}`);

  // Retiros → logística: cada minuto manda los retiros nuevos o cambiados y
  // cancela los que ya no van. Sin LOGISTICA_URL / LOGISTICA_TOKEN queda apagado.
  if (retirosLogistica.configurado()) {
    const RETIROS_CRON = process.env.RETIROS_LOGISTICA_CRON || '* * * * *';
    cron.schedule(RETIROS_CRON, () => retirosLogistica.sincronizar().catch((e) => console.error('[cron retiros-logistica]', e.message)), opts);
    console.log(`  Retiros a logística: ${RETIROS_CRON} (${history.TZ})${process.env.LOGISTICA_AVISO_TOKEN ? '' : ' · avisos de vuelta inactivos (falta LOGISTICA_AVISO_TOKEN)'}`);
  } else {
    console.log('  Retiros a logística: inactivo (faltan LOGISTICA_URL / LOGISTICA_TOKEN)');
  }

  const st = await queue.status().catch(() => null);
  console.log(`  Llamadas: ${calls.callsEnabled ? 'ACTIVO' : 'inactivo (falta N8N_CALL_URL)'}`);
  console.log(`  Cola: modo ${st ? st.modo : 'n/d'}${st && st.modo === 'concurrencia' ? ` (máx. ${st.maxConcurrent} simultáneas, vía VAPI)` : ' (1 cada 60s, sin VAPI)'}`);
  console.log(`  Horario (configurable en la UI): ${st ? (st.scheduleEnabled ? st.horario : 'DESACTIVADO') : 'n/d'}${st ? ` · pendientes: ${st.pendientes}` : ''}\n`);
});

// Marca como IVR (y desactiva) a los clientes cuyas llamadas cayeron en contestadora.
async function revisarIvr() {
  const { llamadas } = await getCachedData();
  return ivr.sincronizar(llamadas);
}


