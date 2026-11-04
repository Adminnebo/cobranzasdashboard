-- Números de prueba: las llamadas a estos números no cuentan en métricas,
-- historial, asistente ni promesas, y en el panel solo las ven los super admins.
-- La lista se edita desde el panel (Llamadas → 🧪 Números de prueba).
-- Correr en el SQL editor de Supabase (mismo proyecto que Cobranzas_call_logs).

create table if not exists public.numeros_prueba (
  phone        text primary key,           -- últimos 10 dígitos, sin +1
  nota         text,
  agregado_por text,
  created_at   timestamptz not null default now()
);

-- Solo el servidor del panel la lee (con la service key): sin acceso público.
alter table public.numeros_prueba enable row level security;

insert into public.numeros_prueba (phone, nota, agregado_por)
values ('3395658425', 'Número de pruebas del equipo (follow up, 2026-11-04)', 'instalación')
on conflict (phone) do nothing;
