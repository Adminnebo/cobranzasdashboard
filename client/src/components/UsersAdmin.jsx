import { useEffect, useState } from 'react';
import { listUsers, createUser, updateUser, deleteUser } from '../api';

const fmtDate = (iso) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' }); }
  catch { return '—'; }
};

export default function UsersAdmin({ currentEmail }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [admin, setAdmin] = useState(false);
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState(null);

  const load = () => {
    setError(null);
    listUsers().then((r) => setUsers(r.users)).catch((e) => setError(e.message));
  };
  useEffect(load, []);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setCreating(true);
    try {
      await createUser({ email: email.trim(), password, admin });
      setEmail(''); setPassword(''); setAdmin(false);
      load();
    } catch (err) { setError(err.message); }
    finally { setCreating(false); }
  };

  const toggleAdmin = async (u) => {
    setBusyId(u.id);
    try { await updateUser(u.id, { admin: u.role !== 'admin' }); load(); }
    catch (err) { setError(err.message); }
    finally { setBusyId(null); }
  };

  const remove = async (u) => {
    if (!window.confirm(`¿Eliminar a ${u.email}? Esta acción no se puede deshacer.`)) return;
    setBusyId(u.id);
    try { await deleteUser(u.id); load(); }
    catch (err) { setError(err.message); }
    finally { setBusyId(null); }
  };

  return (
    <div>
      <div className="section-title" style={{ marginTop: 8 }}>Usuarios · administración de accesos</div>

      <div className="card" style={{ marginBottom: 16 }}>
        <h3>Crear usuario</h3>
        <div className="card-sub">Los usuarios creados aquí sirven para ambos dashboards (mismo Supabase).</div>
        <form className="user-form" onSubmit={submit}>
          <input className="search" type="email" placeholder="correo@empresa.com" value={email}
            onChange={(e) => setEmail(e.target.value)} required style={{ minWidth: 220 }} />
          <input className="search" type="text" placeholder="Contraseña (mín. 6)" value={password}
            onChange={(e) => setPassword(e.target.value)} required style={{ minWidth: 180, flex: '0 0 auto' }} />
          <label className="user-admin-check">
            <input type="checkbox" checked={admin} onChange={(e) => setAdmin(e.target.checked)} /> Admin
          </label>
          <button className="btn" type="submit" disabled={creating || !email || !password}>
            {creating ? 'Creando…' : '+ Crear'}
          </button>
        </form>
        {error && <div className="login-error" style={{ marginTop: 12 }}>{error}</div>}
      </div>

      <div className="card" style={{ padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Correo</th>
                <th>Rol</th>
                <th>Creado</th>
                <th>Último acceso</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {users === null && (
                <tr><td colSpan={5} style={{ padding: 30 }}><div className="spinner" /></td></tr>
              )}
              {users && users.length === 0 && (
                <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 30 }}>Sin usuarios.</td></tr>
              )}
              {users && users.map((u) => (
                <tr key={u.id}>
                  <td style={{ fontWeight: 600 }}>
                    {u.email}
                    {u.email === currentEmail && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> (tú)</span>}
                  </td>
                  <td>
                    <span className="pill" style={{ color: u.role === 'admin' ? 'var(--series-5)' : 'var(--text-secondary)' }}>
                      <span className="pdot" style={{ background: u.role === 'admin' ? 'var(--series-5)' : 'var(--baseline)' }} />
                      {u.role === 'admin' ? 'Admin' : 'Usuario'}
                    </span>
                  </td>
                  <td style={{ color: 'var(--text-secondary)' }}>{fmtDate(u.createdAt)}</td>
                  <td style={{ color: 'var(--text-secondary)' }}>{fmtDate(u.lastSignInAt)}</td>
                  <td>
                    <button className="mini-btn" disabled={busyId === u.id} onClick={() => toggleAdmin(u)}>
                      {u.role === 'admin' ? 'Quitar admin' : 'Hacer admin'}
                    </button>
                    <button className="mini-btn danger" disabled={busyId === u.id || u.email === currentEmail} onClick={() => remove(u)}>
                      Eliminar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
