import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchData, fetchAnalysis, fetchHistory, fetchMe } from './api';
import { money, moneyShort, pct, num } from './format';
import { intencionColor } from './constants';
import KpiCard from './components/KpiCard';
import BarList from './components/BarList';
import Donut from './components/Donut';
import CarteraTable from './components/CarteraTable';
import CallsTable from './components/CallsTable';
import ClientesTable from './components/ClientesTable';
import AiPanel from './components/AiPanel';
import HistoryCard from './components/HistoryCard';
import AssistantView from './components/AssistantView';
import Login from './components/Login';
import UsersAdmin from './components/UsersAdmin';
import { useAuth } from './auth/AuthProvider';

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: '📊' },
  { id: 'clientes', label: 'Clientes', icon: '👥' },
  { id: 'llamadas', label: 'Llamadas', icon: '📞' },
  { id: 'asistente', label: 'Asistente IA', icon: '🤖' },
];

export default function App() {
  const { loading: authLoading, authed, enabled: authEnabled, user, signOut } = useAuth();
  const [tab, setTab] = useState('dashboard');
  const [data, setData] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);
  const [analyzing, setAnalyzing] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [me, setMe] = useState(null);
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute('data-theme') || 'light');
  const llamadasCountRef = useRef(null);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) {}
  };

  const REFRESH_MS = 60000; // auto-refresh de llamadas cada minuto

  useEffect(() => {
    if (!authed) return; // no cargar datos sin sesión
    let mounted = true;
    setError(null); // limpia cualquier error previo al entrar autenticado

    const loadData = async (isPoll) => {
      try {
        const d = await fetchData();
        if (!mounted) return;
        setData(d);
        setLastUpdate(new Date());
        setError(null);
        // Solo re-analiza con IA si cambió el número de llamadas (evita gasto por minuto).
        if (isPoll && llamadasCountRef.current !== null && d.llamadas.length !== llamadasCountRef.current) {
          fetchAnalysis(true).then((a) => mounted && setAnalysis(a)).catch(() => {});
          fetchHistory().then((h) => mounted && setHistory(h)).catch(() => {});
        }
        llamadasCountRef.current = d.llamadas.length;
      } catch (e) {
        if (mounted) setError(e.message);
      }
    };

    loadData(false);
    fetchAnalysis().then((a) => mounted && setAnalysis(a)).catch((e) => mounted && setError(e.message)).finally(() => mounted && setAnalyzing(false));
    fetchHistory().then((h) => mounted && setHistory(h)).catch(() => {});
    fetchMe().then((r) => mounted && setMe(r)).catch(() => {});

    const id = setInterval(() => loadData(true), REFRESH_MS);
    return () => { mounted = false; clearInterval(id); };
  }, [authed]);

  const refreshAnalysis = () => {
    setAnalyzing(true);
    fetchAnalysis(true).then(setAnalysis).catch((e) => setError(e.message)).finally(() => setAnalyzing(false));
  };

  // Une cartera (deuda) + análisis IA + intención de la última llamada.
  const rows = useMemo(() => {
    if (!data || !analysis) return [];
    const clientById = new Map(data.clientes.map((c) => [c.phone, c]));
    const callByTel = new Map();
    for (const ll of data.llamadas) {
      const prev = callByTel.get(ll.phone);
      if (!prev || new Date(ll.created_at) > new Date(prev.created_at)) callByTel.set(ll.phone, ll);
    }
    return analysis.clientes.map((a) => {
      const c = clientById.get(a.phone) || {};
      const ll = callByTel.get(a.phone);
      return {
        ...a,
        deuda_total: c.deuda_total || 0,
        deuda_vencida: c.deuda_vencida || 0,
        credito_ofrecido: c.credito_ofrecido || 0,
        intencion: ll ? ll.intencion_pago : 'no_contactado',
      };
    });
  }, [data, analysis]);

  // ── Gate de autenticación ──
  if (authLoading) {
    return <div className="app"><div className="loading"><div className="spinner" />Cargando…</div></div>;
  }
  if (!authed) {
    return <Login />;
  }

  if (error) {
    return (
      <div className="app">
        <div className="loading" style={{ color: 'var(--critical)' }}>Error: {error}<br />¿Está corriendo el servidor en :3001?</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="app">
        <div className="loading"><div className="spinner" />Cargando cartera…</div>
      </div>
    );
  }

  const m = data.metrics;

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>Cobranzas IA · Panel de cartera</h1>
        </div>
        <div className="badges">
          <span className="badge live"><span className="dot pulse" />En vivo · cada 60s</span>
          {lastUpdate && (
            <span className="badge" title="Última actualización de llamadas">
              {lastUpdate.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
            </span>
          )}
          <span className="badge ai">
            {analysis?.generado_por === 'openai' ? `IA · ${analysis.modelo}` : 'Heurística (sin API key)'}
          </span>
          <button className="btn secondary icon-btn" onClick={toggleTheme} title={theme === 'dark' ? 'Tema claro' : 'Tema oscuro'} aria-label="Cambiar tema">
            {theme === 'dark' ? '☀️' : '🌙'}
          </button>
          <button className="btn secondary" onClick={refreshAnalysis} disabled={analyzing}>
            {analyzing ? 'Analizando…' : '↻ Re-analizar'}
          </button>
          {authEnabled && user && (
            <span className="badge user-badge" title={user.email}>
              {user.email}
              <button className="logout-btn" onClick={signOut} title="Cerrar sesión">Salir</button>
            </span>
          )}
        </div>
      </header>

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
            <span className="tab-ic">{t.icon}</span>{t.label}
            {t.id === 'clientes' && <span className="tab-count">{num(m.totalClientes)}</span>}
            {t.id === 'llamadas' && <span className="tab-count">{num(m.totalLlamadas)}</span>}
          </button>
        ))}
        {me && me.isAdmin && (
          <button className={`tab ${tab === 'usuarios' ? 'active' : ''}`} onClick={() => setTab('usuarios')}>
            <span className="tab-ic">🔐</span>Usuarios
          </button>
        )}
      </nav>

      {tab === 'dashboard' && (
        <DashboardView m={m} analysis={analysis} analyzing={analyzing} rows={rows} history={history} />
      )}

      {tab === 'clientes' && (
        <div className="card" style={{ padding: 0 }}>
          <ClientesTable clientes={data.clientes} />
        </div>
      )}

      {tab === 'llamadas' && (
        <div className="card" style={{ padding: 0 }}>
          <CallsTable llamadas={data.llamadas} />
        </div>
      )}

      {tab === 'asistente' && <AssistantView />}

      {tab === 'usuarios' && me && me.isAdmin && <UsersAdmin currentEmail={me.email} />}

      <div className="footer">
        Prototipo · fuente: {data.source}. Conecta los webhooks de n8n en <code>server/.env</code> para datos en vivo.
      </div>
    </div>
  );
}

function DashboardView({ m, analysis, analyzing, rows, history }) {
  const intencionSegments = m.intencionDistribucion.map((d) => ({
    label: d.label, value: d.count, color: intencionColor(d.key),
  }));

  const probDist = useMemo(() => {
    if (!analysis) return [];
    const c = { Alta: 0, Media: 0, Baja: 0 };
    for (const a of analysis.clientes) c[a.categoria] = (c[a.categoria] || 0) + 1;
    return [
      { label: 'Alta (≥65%)', value: c.Alta, color: 'var(--good)' },
      { label: 'Media (35-64%)', value: c.Media, color: 'var(--warning)' },
      { label: 'Baja (<35%)', value: c.Baja, color: 'var(--critical)' },
    ];
  }, [analysis]);

  return (
    <>
      {/* ── 1. Métricas puras ── */}
      <div className="section-title">1 · Métricas de cartera</div>
      <div className="grid kpis">
        <KpiCard label="Deuda total en cartera" value={money(m.deudaTotal)} accent="var(--series-1)"
          foot={`Ticket promedio ${money(m.ticketPromedio)}`} />
        <KpiCard label="Deuda vencida" value={money(m.deudaVencida)} accent="var(--critical)"
          foot={`${pct((m.deudaVencida / m.deudaTotal) * 100)} del total`} footTone="bad" />
        <KpiCard label="Recuperación estimada (IA)" value={analysis ? money(analysis.recuperacion_estimada) : '…'} accent="var(--good)"
          foot={analysis ? `${pct((analysis.recuperacion_estimada / m.deudaVencida) * 100)} de lo vencido` : 'Analizando…'} footTone="good" />
        <KpiCard label="Tasa de contacto" value={pct(m.tasaContacto)} accent="var(--series-2)"
          foot={`${num(m.clientesContactados)}/${num(m.totalClientes)} contactados`} />
        <KpiCard label="Compromisos de pago" value={num(m.llamadasConCompromiso)} accent="var(--series-5)"
          foot={`${pct(m.tasaCompromiso)} de las llamadas`} />
        <KpiCard label="Crédito ofrecido" value={money(m.creditoOfrecido)} accent="var(--series-3)"
          foot={`Utilización ${pct(m.utilizacionCredito)}`} />
      </div>

      {/* ── Tendencia de deuda ── */}
      <div className="section-title" style={{ marginTop: 20 }}>Tendencia de la deuda</div>
      <HistoryCard history={history} />

      {/* ── 2. Gráficos ── */}
      <div className="section-title">Distribución y severidad</div>
      <div className="grid charts">
        <div className="card">
          <h3>Intención de pago</h3>
          <div className="card-sub">Última llamada por cliente ({num(m.totalClientes)} clientes)</div>
          <Donut segments={intencionSegments} centerLabel="clientes" formatValue={num} />
        </div>

        <div className="card">
          <h3>Severidad de la deuda</h3>
          <div className="card-sub">Deuda total según % vencido del saldo</div>
          <BarList
            items={m.aging.map((a) => ({
              label: a.bucket,
              value: a.monto,
              color: a.bucket === '>75% vencido' ? 'var(--critical)' : a.bucket === '26–75% vencido' ? 'var(--serious)' : a.bucket === 'Vigente' ? 'var(--series-2)' : 'var(--warning)',
              display: `${moneyShort(a.monto)} · ${a.clientes}c`,
            }))}
          />
        </div>

        <div className="card">
          <h3>Probabilidad de pago (IA)</h3>
          <div className="card-sub">Clientes por categoría estimada</div>
          {analysis ? (
            <BarList items={probDist.map((d) => ({ ...d, display: `${num(d.value)} cliente${d.value === 1 ? '' : 's'}` }))} />
          ) : (
            <div className="loading" style={{ padding: 30 }}><div className="spinner" /></div>
          )}
        </div>
      </div>

      {/* Top deudores */}
      {m.topDeudores && m.topDeudores.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3>Top deudores por saldo vencido</h3>
          <div className="card-sub">Mayor concentración de deuda vencida</div>
          <BarList
            items={m.topDeudores.map((d) => ({
              label: d.name.length > 22 ? d.name.slice(0, 22) + '…' : d.name,
              value: d.monto,
              color: 'var(--series-6)',
              display: moneyShort(d.monto),
            }))}
          />
        </div>
      )}

      {/* ── 3. Análisis IA ── */}
      <div className="section-title">2 · Análisis con IA</div>
      {analysis ? <AiPanel analysis={analysis} /> : (
        <div className="card"><div className="loading" style={{ padding: 30 }}><div className="spinner" />Analizando cartera con IA…</div></div>
      )}

      {/* ── 4. Cartera priorizada ── */}
      <div className="section-title">Cartera priorizada · a quién cobrar primero</div>
      <div className="card" style={{ padding: 0 }}>
        {rows.length > 0 ? <CarteraTable rows={rows} /> : (
          <div className="loading" style={{ padding: 30 }}><div className="spinner" /></div>
        )}
      </div>
    </>
  );
}
