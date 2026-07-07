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

module.exports = { requireAuth, requireAdmin, isAdmin, publicConfig, authEnabled };
