-- Follow up con ventana: desde la primera llamada de follow up, cuántos días
-- (de calendario) insiste antes de devolver al cliente al agente principal,
-- y con qué ritmo. Configurable en Ajustes de llamadas → Follow up.
alter table call_schedule add column if not exists fu_ventana_dias        integer not null default 7;
alter table call_schedule add column if not exists fu_reintentos_dia1     integer not null default 1;
alter table call_schedule add column if not exists fu_sin_fecha_mismo_dia boolean not null default false;
alter table call_schedule add column if not exists fu_cada_dias           integer not null default 1;

-- Cada promesa guarda su ventana (se llena al empezar el follow up).
alter table promesa_pago add column if not exists ventana_desde date;
alter table promesa_pago add column if not exists ventana_hasta date;
