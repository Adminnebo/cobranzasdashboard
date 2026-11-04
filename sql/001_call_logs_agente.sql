-- Fase 1 del follow up: guardar qué agente hizo cada llamada y cómo terminó.
-- Correr en el SQL editor de Supabase (proyecto de Nebo, el de Cobranzas_call_logs)
-- ANTES de cambiar el nodo "HTTP Request1" del flujo "Cobranzas Handler":
-- si el nodo manda columnas que no existen, Supabase rechaza la fila y la
-- llamada se pierde.

-- 1) Columnas nuevas (no tocan las existentes; se puede correr dos veces).
alter table public."Cobranzas_call_logs"
  add column if not exists agente_id      text,     -- body.agent.id (Sword)
  add column if not exists agente_nombre  text,     -- body.agent.name
  add column if not exists sword_call_id  text,     -- body.call.id
  add column if not exists duracion_seg   numeric,  -- body.call.duration
  add column if not exists resultado      text,     -- body.call.outcome (answered, …)
  add column if not exists motivo_fin     text,     -- body.call.endedReason
  add column if not exists etapa          text;     -- body.structuredData.etapa

-- Para contar llamadas por cliente y agente sin recorrer toda la tabla.
create index if not exists cobranzas_call_logs_phone_fecha
  on public."Cobranzas_call_logs" (phone, created_at desc);

-- 2) Historial: el agente de follow up hizo UNA llamada real antes de este
--    cambio (9-oct-2026 ~13:01 hora RD, n8n "Follow Up Agent", ejecución
--    460066, teléfono terminado en 4915). Primero mirar qué fila es:
select id, created_at, phone, intencion_pago, left(notas, 80) as notas
from public."Cobranzas_call_logs"
where created_at between '2026-10-09 17:00+00' and '2026-10-09 19:00+00'
  and right(regexp_replace(phone, '\D', '', 'g'), 4) = '4915';

-- RESULTADO (corrido el 2026-11-04): 0 filas. El reporte de esa llamada nunca
-- llegó a "Cobranzas Handler" (sin ejecuciones entre 13:04 UTC del 9-oct y el
-- 10-oct), así que no hay nada que marcar y el update de abajo NO se corrió.
--
-- Si sale exactamente una fila, marcarla como del follow up:
-- update public."Cobranzas_call_logs"
--    set agente_id = 'cmrksxyke000bf69lt9nw4322',
--        agente_nombre = 'JH Cobranzas (Follow Up)'
--  where created_at between '2026-10-09 17:00+00' and '2026-10-09 19:00+00'
--    and right(regexp_replace(phone, '\D', '', 'g'), 4) = '4915';

-- El resto de filas viejas se deja sin agente: el panel las cuenta como del
-- agente principal (es lo que fueron) y las marca como "inferidas".
