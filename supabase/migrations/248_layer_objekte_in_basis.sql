-- Objekte eines Layers koennen direkt in BASIS-Koordinaten (Grundriss-
-- Pixel) liegen statt in Quell-Pixeln: die KI verortet die Inhalte
-- verzerrter Plaene (Beleuchtungsplan mit gestreckter Buehne) semantisch
-- im Grundriss — ein linearer Layer-Transform kann das nicht.
alter table public.location_plan_layer
  add column if not exists objekte_in_basis boolean not null default false;
