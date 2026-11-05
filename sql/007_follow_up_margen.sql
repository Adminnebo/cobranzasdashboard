-- Margen del follow up: días hábiles después de la fecha prometida en que sale
-- la llamada (deja que el pago se refleje). 1 = "pago mañana" (jue) -> llama el vie.
-- Se edita en el panel de Horario de llamadas → Follow up.
alter table call_schedule add column if not exists follow_up_margen_dias integer not null default 1;

-- Los días por bloque del horario propio (cliente_config.horario) van dentro del
-- mismo jsonb: [{"start":"08:00","end":"08:30","dias":[2]}]. No requiere columna.
