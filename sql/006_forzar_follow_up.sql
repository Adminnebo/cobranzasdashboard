-- "Forzar follow up": a un cliente real se le hace el follow up aunque no tenga
-- vencido (para probar con un cliente al día). Lo activan los super admins en
-- Clientes (botón 🧪). Sin la columna no hay excepciones y todo sigue igual.
-- Se puede correr dos veces.
alter table public.cliente_config
  add column if not exists forzar_follow_up boolean not null default false;
