-- Schritt 2 zu 260: Der neue Standort-Dokumente-Code ist deployt.
-- Erst ein zweiter idempotenter Backfill-Lauf (falls im Deploy-Fenster
-- noch ueber den Alt-Code ins JSON hochgeladen wurde), dann werden die
-- JSON-Arrays im zweckentfremdeten Feld geleert — technical_details
-- ist damit wieder ausschliesslich das Freitext-Feld der Raeume.

insert into public.documents (name, storage_path, created_at, folder, location_id)
select
  d->>'name',
  d->>'path',
  coalesce(nullif(d->>'uploaded_at', '')::timestamptz, now()),
  nullif(d->>'folder', ''),
  l.id
from public.locations l
cross join lateral jsonb_array_elements(l.technical_details::jsonb) as d
where l.technical_details like '[%'
  and coalesce(d->>'path', '') <> ''
  and not exists (select 1 from public.documents x where x.storage_path = d->>'path');

update public.locations
set technical_details = null
where technical_details like '[%';
