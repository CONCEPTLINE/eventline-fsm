-- Gewarpte Fassung des Layer-Quellbilds: zeilenweise auf den Grundriss
-- eingepasst (Zug-Korrespondenzen als Stuetzstellen), liegt direkt in
-- Basis-Koordinaten. Das Original (bild_path) bleibt erhalten.
alter table public.location_plan_layer
  add column if not exists warp_path text;
