-- Retiros que se mandan a logística (logistica.neboaiconsulting.com) y lo
-- último que logística avisó de cada uno. Una fila por retiro: el externo_id
-- es la llamada_key de la ficha (la llamada donde el cliente pidió que pasen
-- a buscar el pago). Lo llena el motor de retiros (cada minuto) y el aviso
-- POST /api/logistica/retiros/aviso.
create table if not exists public.retiro_logistica (
  externo_id         text primary key,          -- llamada_key de la ficha (limpia para logística)
  llamada_key        text,                      -- igual que llamada_ficha / promesa_pago.llamada_key
  promesa_id         text,
  phone              text,
  cliente_codigo     text,                      -- código del cliente en el ERP

  -- Lo que se mandó
  enviado            jsonb,                     -- último cuerpo enviado (PUT)
  enviado_hash       text,                      -- para no reenviar lo mismo
  enviado_at         timestamptz,
  cancelado_at       timestamptz,               -- se pidió cancelar (DELETE) y quedó resuelto

  -- Lo último que avisó logística
  estado             text,                      -- por_ubicar | por_asignar | en_ruta | retirado | no_retirado | cancelado
  ruta               jsonb,                     -- {referencia, fecha, repartidor}
  motivo             text,
  monto_cent         bigint,                    -- lo retirado, en centavos
  rcp                text,                      -- recibo de caja provisional
  atendido_en        timestamptz,
  fecha              text,                      -- fecha del retiro (YYYY-MM-DD)

  -- Errores y reintentos al hablar con logística
  error              text,
  intentos           integer not null default 0,
  proximo_intento_at timestamptz,

  created_at         timestamptz not null default now(),
  actualizado_at     timestamptz not null default now()
);
create index if not exists retiro_logistica_llamada_idx on public.retiro_logistica (llamada_key);
create index if not exists retiro_logistica_promesa_idx on public.retiro_logistica (promesa_id);
create index if not exists retiro_logistica_phone_idx on public.retiro_logistica (phone);

-- Solo el servidor del panel la lee (con la service key): sin acceso público.
alter table public.retiro_logistica enable row level security;
