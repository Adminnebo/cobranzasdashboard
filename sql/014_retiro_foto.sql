-- Foto del retiro que manda logística (efectivo o cheque), para el historial
-- de llamadas del cliente y la vista del estado del retiro en Por atender.
-- Es el enlace público de logística (/c/<token>/foto), solo cuando quedó retirado.
alter table public.retiro_logistica add column if not exists foto_url text;
