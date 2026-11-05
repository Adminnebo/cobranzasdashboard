-- Costo de la IA que lee las llamadas (fichas) y su cobro en Sword.
-- Una fila por día y origen con lo gastado; un cobro por día cerrado.
create table if not exists ia_consumo (
  dia            date not null,
  origen         text not null,
  modelo         text,
  llamadas       integer not null default 0,
  consultas      integer not null default 0,
  tokens_entrada bigint  not null default 0,
  tokens_cache   bigint  not null default 0,
  tokens_salida  bigint  not null default 0,
  costo_usd      numeric(14,6) not null default 0,
  cobro_id       bigint,
  primary key (dia, origen)
);
create index if not exists ia_consumo_cobro_idx on ia_consumo (cobro_id);

create table if not exists ia_cobro (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  dia         date not null unique,      -- último día que cubre (uno por día: evita cobrar dos veces)
  desde       date,
  costo_usd   numeric(14,6) not null default 0,
  margen_pct  numeric not null default 0,
  monto_usd   numeric(12,2) not null,
  llamadas    integer not null default 0,
  nota        text,
  estado      text not null default 'pendiente',  -- pendiente | enviando | reintentar | enviado | revisar
  intentos    integer not null default 0,
  proximo_at  timestamptz,
  respuesta   text,
  enviado_at  timestamptz
);

create table if not exists ia_config (
  id             integer primary key default 1,
  precio_entrada numeric not null default 0.15,   -- USD por millón de tokens (gpt-4o-mini)
  precio_cache   numeric not null default 0.075,
  precio_salida  numeric not null default 0.6,
  margen_pct     numeric not null default 0,      -- ganancia sobre el costo
  cobrar_sword   boolean not null default false,  -- se prende desde el panel
  updated_by     text,
  updated_at     timestamptz not null default now()
);
insert into ia_config (id) values (1) on conflict (id) do nothing;

-- Fichas: error de lectura (no se vuelve a pagar) y quién la corrigió a mano.
alter table llamada_ficha add column if not exists error text;
alter table llamada_ficha add column if not exists corregida_por text;
