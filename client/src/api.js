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

// ── Llamadas ──
export const setClientesEnabled = (phones, enabled) => patch('/api/clientes/enabled', { phones, enabled });
export const triggerCalls = (phones, origen = 'manual') => post('/api/calls/trigger', { phones, origen });
export const fetchQueue = () => get('/api/calls/queue');
export const cancelQueue = () => del('/api/calls/queue');
export const resetIvr = (phone) => post(`/api/clientes/${phone}/ivr/reset`, {});
export const fetchSchedule = () => get('/api/calls/schedule');
export const saveSchedule = (cfg) => put('/api/calls/schedule', cfg);
export const enqueueEnabled = () => post('/api/calls/enqueue-enabled', {});

// ── Auth / usuarios ──
export const fetchMe = () => get('/api/me');
export const listUsers = () => get('/api/users');
export const createUser = (payload) => post('/api/users', payload);
export const updateUser = (id, payload) => patch(`/api/users/${id}`, payload);
export const deleteUser = (id) => del(`/api/users/${id}`);

export const fetchData = () => get('/api/data');
export const fetchAnalysis = (refresh = false) => get(`/api/analyze${refresh ? '?refresh=1' : ''}`);
export const fetchHistory = () => get('/api/history');
export const fetchHealth = () => get('/api/health');
