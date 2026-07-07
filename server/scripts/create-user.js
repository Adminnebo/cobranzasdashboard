/**
 * Crea un usuario en Supabase Auth (solo admin). Requiere SUPABASE_URL y
 * SUPABASE_SERVICE_KEY en el .env.
 *
 * Uso:  node scripts/create-user.js correo@empresa.com "contraseña"
 */
require('dotenv').config();

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
const [, , email, password] = process.argv;

if (!url || !key) {
  console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY en el .env');
  process.exit(1);
}
if (!email || !password) {
  console.error('Uso: node scripts/create-user.js <email> <password>');
  process.exit(1);
}

(async () => {
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Error al crear usuario:', body.msg || body.error_description || JSON.stringify(body));
    process.exit(1);
  }
  console.log(`✅ Usuario creado: ${body.email} (id ${body.id})`);
})();
