import { useState } from 'react';
import { useAuth } from '../auth/AuthProvider';

export default function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { error } = await signIn(email.trim(), password);
      if (error) setError(traducir(error.message));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo">💼</div>
        <h1>Cobranzas IA</h1>
        <p className="login-sub">Inicia sesión para acceder al panel</p>

        <label className="login-label">Correo</label>
        <input className="login-input" type="email" autoComplete="username" value={email}
          onChange={(e) => setEmail(e.target.value)} placeholder="tu@empresa.com" required />

        <label className="login-label">Contraseña</label>
        <input className="login-input" type="password" autoComplete="current-password" value={password}
          onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" required />

        {error && <div className="login-error">{error}</div>}

        <button className="btn login-btn" type="submit" disabled={loading || !email || !password}>
          {loading ? 'Entrando…' : 'Iniciar sesión'}
        </button>
        <p className="login-foot">¿No tienes cuenta? Contacta al administrador.</p>
      </form>
    </div>
  );
}

function traducir(msg) {
  const m = (msg || '').toLowerCase();
  if (m.includes('invalid login')) return 'Correo o contraseña incorrectos.';
  if (m.includes('email not confirmed')) return 'El correo no está confirmado.';
  return msg;
}
