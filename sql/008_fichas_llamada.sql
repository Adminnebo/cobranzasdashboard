-- Ficha de cada llamada contestada (la lee la IA de la transcripción):
-- si quiere que pasen a retirar el pago, si pidió una hora para que lo llamen,
-- y si dio un horario que se repite (con eso se ajusta solo su horario propio).
create table if not exists llamada_ficha (
  llamada_key      text primary key,          -- igual que llamada_procesada / promesa_pago.llamada_key
  phone            text not null,
  llamada_at       timestamptz,
  modalidad        text,                      -- 'retiro' | 'transferencia' | 'otro' | null
  retiro           jsonb,                     -- {fecha, franja, desde, hasta, texto}
  llamar           jsonb,                     -- {fecha, hora, texto}  (una sola vez)
  disponibilidad   jsonb,                     -- {bloques:[{start,end,dias}], texto}
  horario_aplicado boolean not null default false,
  created_at       timestamptz not null default now()
);
create index if not exists llamada_ficha_phone_idx on llamada_ficha (phone);
create index if not exists llamada_ficha_at_idx on llamada_ficha (llamada_at);

-- De dónde salió el horario propio: 'manual' (una persona) o 'ia' (lo dijo el cliente).
-- Un horario puesto a mano nunca lo pisa el sistema.
alter table cliente_config add column if not exists horario_origen text;
alter table cliente_config add column if not exists horario_detalle text;

-- Ajustes (Horario de llamadas): horas de "mañana"/"tarde" para retiros y
-- el interruptor del horario automático.
alter table call_schedule add column if not exists retiro_manana_desde text not null default '08:00';
alter table call_schedule add column if not exists retiro_manana_hasta text not null default '12:00';
alter table call_schedule add column if not exists retiro_tarde_desde  text not null default '14:00';
alter table call_schedule add column if not exists retiro_tarde_hasta  text not null default '18:00';
-- Arranca apagado: se prende en el panel cuando se revisó que la IA lee bien.
alter table call_schedule add column if not exists horario_auto boolean not null default false;
