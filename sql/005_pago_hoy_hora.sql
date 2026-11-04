-- "Pago hoy": hora a la que sale el follow up de una promesa hecha hoy para hoy
-- (antes salía minutos después de colgar con los números de prueba y al día
-- siguiente con los clientes reales). Editable en Horario de llamadas → Follow up.
-- Sin la columna el panel usa 17:00 y todo funciona; solo no se puede cambiar la hora.
-- Se puede correr dos veces.
alter table public.call_schedule
  add column if not exists pago_hoy_hora text;
