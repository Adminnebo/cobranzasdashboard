-- Revamp del follow up: estados del cliente, cadena de promesas y reintentos.
-- Correr en el SQL editor de Supabase (mismo proyecto que llamada_cola y
-- promesa_pago) ANTES de desplegar la rama feat/follow-up-revamp: el panel
-- nuevo escribe en estas columnas y sin ellas la cola no puede encolar.
-- Todo es "if not exists": se puede correr dos veces.

-- 1) Promesas: una por llamada (antes era una por teléfono + fecha, y una
--    segunda "mañana" del mismo cliente se perdía), con cadena e intentos.
alter table public.promesa_pago
  add column if not exists llamada_key         text,        -- id de la llamada que la originó
  add column if not exists intento             int not null default 1,  -- 1.ª, 2.ª, 3.ª promesa seguida
  add column if not exists promesa_anterior_id text,        -- la que reemplaza (reprogramada)
  add column if not exists agente              text,        -- cobranzas | seguimiento
  add column if not exists origen              text,        -- structured | ia (si la sacó la IA de la transcripción)
  add column if not exists reintentos          int not null default 0,  -- follow ups sin contestar
  add column if not exists proximo_intento_at  timestamptz, -- cuándo reintentar el follow up
  add column if not exists cerrada_at          timestamptz,
  add column if not exists motivo_cierre       text;

create unique index if not exists promesa_pago_llamada_key
  on public.promesa_pago (llamada_key) where llamada_key is not null;

-- La regla vieja "una promesa por teléfono y fecha" choca con la cadena
-- (un cliente puede volver a prometer la misma fecha). Se quita si existe,
-- sea constraint o índice único.
do $$
declare r record;
begin
  for r in select conname from pg_constraint
           where conrelid = 'public.promesa_pago'::regclass and contype = 'u'
             and pg_get_constraintdef(oid) ilike '%(phone, fecha_prometida)%' loop
    execute format('alter table public.promesa_pago drop constraint %I', r.conname);
  end loop;
  for r in select indexname from pg_indexes
           where schemaname = 'public' and tablename = 'promesa_pago'
             and indexdef ilike '%unique%(phone, fecha_prometida)%' loop
    execute format('drop index public.%I', r.indexname);
  end loop;
  -- Estados nuevos (en_seguimiento, reprogramada, dice_pago, escalada, vieja):
  -- si la columna estado tenía un CHECK con la lista vieja, se quita.
  for r in select conname from pg_constraint
           where conrelid = 'public.promesa_pago'::regclass and contype = 'c'
             and pg_get_constraintdef(oid) ilike '%estado%' loop
    execute format('alter table public.promesa_pago drop constraint %I', r.conname);
  end loop;
end $$;

-- 2) Cola: la llamada del follow up lleva su promesa y la fecha prometida.
alter table public.llamada_cola
  add column if not exists promesa_id      text,
  add column if not exists fecha_prometida date;

-- 3) Estado de cobro del cliente: promesa | dice_pago | escalar (vacío = normal).
--    enabled_antes guarda si estaba prendido, para devolverlo igual al salir.
alter table public.cliente_config
  add column if not exists estado_cobro   text,
  add column if not exists estado_at      timestamptz,
  add column if not exists estado_detalle text,
  add column if not exists enabled_antes  boolean;

-- 4) Ajustes del follow up (editables en el panel, en Horario de llamadas).
alter table public.call_schedule
  add column if not exists promesa_tope        int,  -- promesas incumplidas seguidas antes de pasar a una persona (3)
  add column if not exists promesa_max_atraso  int,  -- días máx. de atraso para todavía llamar (7)
  add column if not exists reintento_horas     int;  -- horas hasta reintentar el follow up el mismo día (2)

-- 5) Llamadas ya procesadas por el motor (para no reprocesarlas cada 5 min).
create table if not exists public.llamada_procesada (
  llamada_key text primary key,
  phone       text,
  accion      text,
  detalle     text,
  at          timestamptz not null default now()
);
alter table public.llamada_procesada enable row level security;
