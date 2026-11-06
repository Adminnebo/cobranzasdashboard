-- Fase B de la cola: hora pedida por el cliente, llamadas que no alcanzan a
-- salir en su ventana corta y "necesita a una persona" puesto por la cola.
alter table cliente_config add column if not exists cita_at         timestamptz;
alter table cliente_config add column if not exists cita_texto      text;
alter table cliente_config add column if not exists cita_origen     text;     -- ia | manual
alter table cliente_config add column if not exists cita_movida     integer not null default 0;
alter table cliente_config add column if not exists atencion_motivo text;
alter table cliente_config add column if not exists atencion_at     timestamptz;

alter table llamada_cola add column if not exists movida     integer not null default 0;
alter table llamada_cola add column if not exists movida_dia date;

alter table call_schedule add column if not exists cita_ventana_min integer not null default 30;
alter table call_schedule add column if not exists max_movidas      integer not null default 2;
