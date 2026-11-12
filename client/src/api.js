import { getAuthToken } from './auth/token';

function authHeaders(extra) {
  const t = getAuthToken();
  return { ...(extra || {}), ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}

async function get(path) {
  const res = await fetch(path, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function post(path, payload) {
  const res = await fetch(path, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function del(path) {
  const res = await fetch(path, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function patch(path, payload) {
  const res = await fetch(path, {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function put(path, payload) {
  const res = await fetch(path, {
    method: 'PUT',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const askAI = (question) => post('/api/ask', { question });
export const fetchChatHistory = () => get('/api/ask/history');
export const clearChatHistory = () => del('/api/ask/history');

// ── Llamadas ──
export const setClientesEnabled = (phones, enabled) => patch('/api/clientes/enabled', { phones, enabled });
export const setForzarFollowUp = (phone, forzar) => put('/api/clientes/forzar-follow-up', { phone, forzar });
export const setClientesHorario = (phones, horario) => put('/api/clientes/horario', { phones, horario });
// Hora en que el cliente pidió que lo llamen (null la quita) y "Listo" de 🙋 Por atender.
export const setCitaCliente = (phone, at) => put('/api/clientes/cita', { phone, at });
export const atencionListo = (phone) => post('/api/clientes/atencion/listo', { phone });
export const triggerCalls = (phones, origen = 'manual') => post('/api/calls/trigger', { phones, origen });
// Encola sin llamar al instante: espera turno y respeta el horario (general o propio).
export const enqueueCalls = (phones) => post('/api/calls/trigger', { phones, origen: 'manual', encolar: true });
export const fetchQueue = () => get('/api/calls/queue');
export const cancelQueue = () => del('/api/calls/queue');
export const fetchQueueLista = () => get('/api/calls/queue/lista');
export const quitarDeCola = (id) => del(`/api/calls/queue/${encodeURIComponent(id)}`);
export const resetIvr = (phone) => post(`/api/clientes/${phone}/ivr/reset`, {});
export const fetchLists = () => get('/api/lists');
export const createList = (name, phones) => post('/api/lists', { name, phones });
export const updateList = (id, payload) => put(`/api/lists/${id}`, payload);
export const deleteList = (id) => del(`/api/lists/${id}`);
export const fetchSchedule = () => get('/api/calls/schedule');
export const saveSchedule = (cfg) => put('/api/calls/schedule', cfg);
// Agentes de voz disponibles (el servidor proxea el servicio; la key no viaja al navegador).
export const fetchAgents = () => get('/api/agents');
export const enqueueEnabled = () => post('/api/calls/enqueue-enabled', {});

// ── Auth / usuarios ──
export const fetchMe = () => get('/api/me');
export const listUsers = () => get('/api/users');
export const createUser = (payload) => post('/api/users', payload);
export const updateUser = (id, payload) => patch(`/api/users/${id}`, payload);
export const deleteUser = (id) => del(`/api/users/${id}`);

export const fetchData = () => get('/api/data');

// Números de prueba (solo super admins): sus llamadas no cuentan y se ocultan al resto.
export const fetchPruebas = () => get('/api/pruebas');
export const fetchPromesasLista = () => get('/api/promesas/lista');
export const revisarPromesasAhora = () => post('/api/promesas/revisar', {});
export const reabrirPromesa = (id) => post(`/api/promesas/${encodeURIComponent(id)}/reabrir`, {});
export const marcarNoRetiro = (llamadaKey) => post('/api/fichas/no-retiro', { llamadaKey });
export const fetchRetiroSeguimiento = (externoId, fresco = false) => get(`/api/retiros/${encodeURIComponent(externoId)}/seguimiento${fresco ? '?fresco=1' : ''}`);
export const retiroVolverPendiente = (externoId) => post('/api/retiros/volver-pendiente', { externoId });
// Costo de la IA que lee las llamadas y su cobro en Sword (solo super admins).
export const fetchIaConsumo = () => get('/api/ia-consumo');
export const saveIaConfig = (cfg) => put('/api/ia-consumo/config', cfg);
export const resolverCobroIa = (id, accion) => post(`/api/ia-consumo/cobros/${encodeURIComponent(id)}`, { accion });
export const addPrueba = (phone, nota) => post('/api/pruebas', { phone, nota });
export const removePrueba = (phone) => del(`/api/pruebas/${encodeURIComponent(phone)}`);
export const fetchAnalysis = (refresh = false) => get(`/api/analyze${refresh ? '?refresh=1' : ''}`);
export const fetchHistory = () => get('/api/history');

// Cobros detectados con la foto diaria de las facturas abiertas del ERP.
export const fetchCobros = ({ desde, hasta } = {}) => {
  const q = new URLSearchParams();
  if (desde) q.set('desde', desde);
  if (hasta) q.set('hasta', hasta);
  const qs = q.toString();
  return get(`/api/cobros${qs ? `?${qs}` : ''}`);
};
export const fetchCobrosCliente = (codigo) => get(`/api/cobros/cliente/${encodeURIComponent(codigo)}`);
export const tomarFotoCobros = () => post('/api/cobros/foto', {});
export const fetchHealth = () => get('/api/health');

// Correo de cobranzas (Gmail u Outlook del cliente, vía correo-servicio).
export const fetchConfig = () => get('/api/config');
export const correoEstado = () => get('/api/correo');
export const fetchCorreos = (forzar = false) => get(`/api/correos${forzar ? '?forzar=1' : ''}`);
export const fetchCorreoHilo = (hilo) => get(`/api/correos/hilo/${encodeURIComponent(hilo)}`);
export const correoSesion = (proveedor = 'google') => post('/api/correo/sesion', { proveedor });
export const correoDesconectar = () => del('/api/correo');
export const correoPlantilla = () => get('/api/correo/plantilla');
export const guardarCorreoPlantilla = (p) => put('/api/correo/plantilla', p);
