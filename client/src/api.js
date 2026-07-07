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

export const askAI = (question) => post('/api/ask', { question });

export const fetchData = () => get('/api/data');
export const fetchAnalysis = (refresh = false) => get(`/api/analyze${refresh ? '?refresh=1' : ''}`);
export const fetchHistory = () => get('/api/history');
export const fetchHealth = () => get('/api/health');
