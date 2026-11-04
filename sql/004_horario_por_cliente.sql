-- Horario propio por cliente (fase 3 del follow up).
-- Correr en el SQL editor de Supabase (mismo proyecto que cliente_config y
-- call_schedule) ANTES de mergear la rama feat/horario-por-cliente.
-- Sin estas columnas el panel sigue funcionando (todos con el horario general),
-- pero no se puede guardar un horario propio ni cambiar el rango permitido.
-- Todo es "if not exists": se puede correr dos veces.

-- 1) Horario propio del cliente: lista de bloques [{"start":"08:00","end":"10:00"}].
--    Vacío (null) = sigue el horario general.
alter table public.cliente_config
  add column if not exists horario jsonb;

-- 2) Rango dentro del cual puede caer el horario propio de un cliente
--    (editable en Horario de llamadas). Por defecto 08:00–19:00.
alter table public.call_schedule
  add column if not exists horario_cliente_desde text,
  add column if not exists horario_cliente_hasta text;
