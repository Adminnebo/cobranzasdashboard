import { createContext, useContext, useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { setAuthToken } from './token';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: true, enabled: false, supabase: null, session: null });

  useEffect(() => {
    let subscription;
    (async () => {
      let cfg;
      try {
        cfg = await (await fetch('/api/config')).json();
      } catch {
        cfg = { enabled: false };
      }

      // Auth desactivada en el server -> app abierta (como antes).
      if (!cfg.enabled || !cfg.supabaseUrl || !cfg.supabaseAnonKey) {
        setState({ loading: false, enabled: false, supabase: null, session: null });
        return;
      }

      const supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true },
      });

      const { data: { session } } = await supabase.auth.getSession();
      setAuthToken(session?.access_token || null);
      setState({ loading: false, enabled: true, supabase, session });

      const { data } = supabase.auth.onAuthStateChange((_evt, s) => {
        setAuthToken(s?.access_token || null);
        setState((prev) => ({ ...prev, session: s }));
      });
      subscription = data.subscription;
    })();

    return () => { if (subscription) subscription.unsubscribe(); };
  }, []);

  const value = {
    loading: state.loading,
    enabled: state.enabled,
    session: state.session,
    user: state.session?.user || null,
    // Autenticado si la auth está apagada, o si hay sesión.
    authed: !state.enabled || !!state.session,
    signIn: (email, password) => state.supabase.auth.signInWithPassword({ email, password }),
    signOut: () => (state.supabase ? state.supabase.auth.signOut() : Promise.resolve()),
  };

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
