/**
 * Autenticación vía Supabase Auth. El frontend hace login con Supabase y manda
 * el JWT (access_token) en Authorization: Bearer.
 *
 * Supabase firma los tokens de usuario con claves asimétricas (ES256/RS256) vía
 * su JWKS público; los tokens legacy (anon/service) usan HS256 con el JWT secret.
 * Verificamos ambos: JWKS para asimétricos, JWT secret para HS256.
 *
 * Opt-in: sin SUPABASE_URL + SUPABASE_ANON_KEY la auth queda DESACTIVADA.
 */

const jwt = require('jsonwebtoken');
const { createRemoteJWKSet, jwtVerify } = require('jose');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';
// Para leer profiles.platforms (control de acceso por plataforma) hace falta la
// service key. Sin ella, no se limita (modo compatible).
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const PLATAFORMAS = ['inbox', 'cotizaciones', 'cobranzas'];
const _perfilCache = new Map();     // userId -> { info, exp }

// Lee rol + plataformas de public.profiles (por REST, con la service key).
async function perfilDe(userId) {
  if (!userId || !SUPABASE_URL || !SERVICE_KEY) return null;
  const hit = _perfilCache.get(userId);
  if (hit && hit.exp > Date.now()) return hit.info;
  try {
    const r = await fetch(SUPABASE_URL + '/rest/v1/profiles?id=eq.' + userId + '&select=role,platforms',
      { headers: { apikey: SERVICE_KEY, Authorization: 'Bearer ' + SERVICE_KEY } });
    const rows = r.ok ? await r.json() : [];
    const info = rows[0] || {};
    _perfilCache.set(userId, { info, exp: Date.now() + 60000 });
    return info;
  } catch { return null; }
}

function plataformasDe(role, platforms) {
  if (role === 'super_admin' || role === 'admin') return PLATAFORMAS.slice();
  return Array.isArray(platforms) ? platforms : PLATAFORMAS.slice();
}

// Admins bootstrap: emails en ADMIN_EMAILS (coma-separados). Además, cualquier
// usuario con app_metadata.role === 'admin' también es admin.
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

const authEnabled = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

function isAdmin(user) {
  if (!user) return false;
  const roleClaim = user.app_metadata && user.app_metadata.role;
  if (roleClaim === 'admin') return true;
  return ADMIN_EMAILS.includes((user.email || '').toLowerCase());
}

// JWKS remoto de Supabase (cachea y rota claves solo).
const JWKS = SUPABASE_URL
  ? createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`))
  : null;

function algOf(token) {
  try {
    return JSON.parse(Buffer.from(token.split('.')[0], 'base64').toString()).alg;
  } catch {
    return null;
  }
}

async function verifyToken(token) {
  // HS256 = token legacy firmado con el JWT secret.
  if (algOf(token) === 'HS256') {
    if (!JWT_SECRET) throw new Error('HS256 sin JWT secret');
    return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  }
  // Asimétrico (ES256/RS256) = verificar contra el JWKS del proyecto.
  const { payload } = await jwtVerify(token, JWKS, {
    issuer: `${SUPABASE_URL}/auth/v1`,
  });
  return payload;
}

// Middleware: exige un Bearer token válido (si la auth está activada).
async function requireAuth(req, res, next) {
  if (!authEnabled) return next();
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    const payload = await verifyToken(token);
    req.user = {
      id: payload.sub,
      email: payload.email,
      role: payload.role,
      app_metadata: payload.app_metadata || {},
    };
    req.user.isAdmin = isAdmin(req.user);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

// Exige acceso a una plataforma (aquí, 'cobranzas'). Si no hay service key para
// leer profiles, no bloquea (modo compatible). super_admin/admin siempre pasan.
function requirePlatform(key) {
  return async (req, res, next) => {
    if (!authEnabled) return next();
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    if (!SERVICE_KEY) return next();               // sin service key no podemos leer profiles: no limitamos
    const p = await perfilDe(req.user.id);
    const perms = plataformasDe(p && p.role, p && p.platforms);
    req.role = (p && p.role) || null;
    req.platforms = perms;
    if (!perms.includes(key)) return res.status(403).json({ error: 'Sin acceso a esta plataforma', platform: key });
    next();
  };
}

// Exige que el usuario autenticado sea admin.
function requireAdmin(req, res, next) {
  // Si la auth está apagada, no hay control de admin: bloquea por seguridad.
  if (!authEnabled) return res.status(403).json({ error: 'Auth no configurada' });
  if (!req.user || !req.user.isAdmin) return res.status(403).json({ error: 'Requiere permisos de administrador' });
  next();
}

function publicConfig() {
  return {
    enabled: authEnabled,
    supabaseUrl: SUPABASE_URL || null,
    supabaseAnonKey: SUPABASE_ANON_KEY || null,
  };
}

module.exports = { requireAuth, requireAdmin, requirePlatform, isAdmin, publicConfig, authEnabled, perfilDe, plataformasDe, PLATAFORMAS };
