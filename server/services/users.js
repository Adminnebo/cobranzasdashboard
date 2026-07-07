/**
 * Gestión de usuarios vía Supabase Admin API (requiere SUPABASE_SERVICE_KEY).
 * Usado solo por endpoints protegidos con requireAdmin.
 */

const { isAdmin } = require('./auth');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

function adminHeaders() {
  return { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
}

function assertConfigured() {
  if (!SUPABASE_URL || !SERVICE_KEY) {
    const e = new Error('Falta SUPABASE_URL o SUPABASE_SERVICE_KEY');
    e.status = 500;
    throw e;
  }
}

async function call(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin${path}`, { ...opts, headers: adminHeaders() });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const e = new Error(body.msg || body.error_description || body.error || `Supabase ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return body;
}

// Aplana el usuario a lo mínimo que necesita el frontend.
function slim(u) {
  return {
    id: u.id,
    email: u.email,
    role: isAdmin(u) ? 'admin' : 'user',
    createdAt: u.created_at,
    lastSignInAt: u.last_sign_in_at || null,
    confirmed: !!(u.email_confirmed_at || u.confirmed_at),
  };
}

async function listUsers() {
  assertConfigured();
  const body = await call('/users?per_page=200');
  const users = Array.isArray(body) ? body : (body.users || []);
  return users.map(slim).sort((a, b) => (a.email > b.email ? 1 : -1));
}

async function createUser({ email, password, admin }) {
  assertConfigured();
  const u = await call('/users', {
    method: 'POST',
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      app_metadata: { role: admin ? 'admin' : 'user' },
    }),
  });
  return slim(u);
}

async function deleteUser(id) {
  assertConfigured();
  await call(`/users/${id}`, { method: 'DELETE' });
  return { ok: true };
}

// Cambia rol (admin/user) y/o contraseña.
async function updateUser(id, { admin, password }) {
  assertConfigured();
  const body = {};
  if (typeof admin === 'boolean') body.app_metadata = { role: admin ? 'admin' : 'user' };
  if (password) body.password = password;
  const u = await call(`/users/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  return slim(u);
}

module.exports = { listUsers, createUser, deleteUser, updateUser };
