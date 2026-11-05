-- Cobros detectados a diario comparando fotos de la cartera del ERP de JH.
--
-- JH no expone una tabla de pagos: Hist_FacturasCxCAI (facturas abiertas con
-- su saldo) y Hist_BalancesClientesIA (saldo por cliente) solo guardan el día
-- de hoy. Aquí se guarda una foto por día y, al tomarla, se compara con la
-- foto anterior: si el saldo (Resta) de una factura bajó, es un abono; si la
-- factura desapareció, se saldó (o se anuló: el ERP no lo distingue).

-- Una fila por foto. `completa` solo pasa a true cuando están guardadas todas
-- las facturas y los cobros: una foto a medias nunca se usa para comparar.
create table if not exists cxc_foto (
  fecha        date primary key,            -- día de la foto (America/Santo_Domingo)
  tomado_en    timestamptz not null default now(),
  origen       text,                        -- cron | inicio | manual
  completa     boolean not null default false,
  facturas     integer,
  resta_total  numeric(16,2),
  clientes     integer,
  desde        date,                        -- foto con la que se comparó
  cobros       integer,
  cobrado      numeric(16,2)
);

-- Facturas abiertas en cada foto. Se guardan 90 días (para comparar basta la
-- anterior); lo detectado queda para siempre en cobro_detectado.
create table if not exists cxc_factura_foto (
  fecha          date   not null,
  sec_fact       bigint not null,
  n_factura      bigint,
  cliente        integer,
  empresa        integer,
  fecha_factura  timestamptz,
  vencimiento    timestamptz,
  total          numeric(14,2),
  resta          numeric(14,2),
  primary key (fecha, sec_fact)
);
create index if not exists cxc_factura_foto_cliente_idx on cxc_factura_foto (cliente, fecha);

-- Saldo de cada cliente en cada foto (para ver la evolución y proyectar).
create table if not exists cxc_cliente_foto (
  fecha    date    not null,
  codigo   integer not null,
  balance  numeric(14,2),
  vencido  numeric(14,2),
  limite   numeric(14,2),
  primary key (fecha, codigo)
);
create index if not exists cxc_cliente_foto_codigo_idx on cxc_cliente_foto (codigo, fecha);

-- Lo cobrado: una fila por factura que bajó entre dos fotos.
--   abono    = la factura sigue abierta con menos saldo
--   saldada  = la factura ya no está (pagada del todo, o anulada / nota de crédito)
--   inicial  = factura nueva que ya llegó con parte pagada
create table if not exists cobro_detectado (
  fecha          date   not null,           -- foto en la que se vio
  sec_fact       bigint not null,
  desde          date,                      -- foto anterior (el cobro ocurrió entre ambas)
  cliente        integer,
  n_factura      bigint,
  empresa        integer,
  tipo           text   not null,
  monto          numeric(14,2) not null,
  resta_antes    numeric(14,2),
  resta_despues  numeric(14,2),
  primary key (fecha, sec_fact)
);
create index if not exists cobro_detectado_cliente_idx on cobro_detectado (cliente, fecha);
