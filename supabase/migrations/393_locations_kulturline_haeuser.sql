-- 393: Vier Häuser als Locations anlegen (Leo, 26.11.2026): Querfeldhalle,
-- Palazzo Liestal, Trafohalle Bottmingen, Freie Gemeinschaftsbank — damit sie
-- im Planungsbrett unter «Ressourcen» Personal aufnehmen.
--
-- Idempotent: ein Haus wird nur angelegt, wenn es noch keine Location mit
-- passendem Namen gibt (auch archivierte zählen). Bestehende Einträge bleiben
-- unverändert. Dieselben Angaben wie src/lib/ressourcen/haeuser.ts (dort legt
-- der Knopf «Anlegen» dasselbe über die Oberfläche an).
-- Koordinaten: OpenStreetMap (Nominatim), 26.11.2026. Plätze und Technik aus
-- den Kooperationskonzepten, dort nicht bestätigt.

insert into public.locations (name, address_street, address_zip, address_city, capacity, technical_details, notes, latitude, longitude)
select v.name, v.street, v.zip, v.city, v.capacity, v.technik, v.notiz, v.lat, v.lng
from (values
  ('Querfeldhalle', '%querfeld%', 'Dornacherstrasse 192', '4053', 'Basel', null::integer,
   null::text,
   'Träger: Zirkusschule Basel (ZSB). Über KULTURLINE.',
   47.5411522::numeric, 7.5928740::numeric),
  ('Palazzo Liestal', '%palazzo%', 'Poststrasse 2', '4410', 'Liestal', 70,
   'Theatersaal mit Tribünenbestuhlung, Bar, Garderobe, Schminkraum. Technik laut Konzept betriebsbereit.',
   'Träger: Kulturhaus Palazzo AG. Über KULTURLINE. Rund 70 Plätze laut Konzept, nicht bestätigt.',
   47.4840401::numeric, 7.7322536::numeric),
  ('Trafohalle Bottmingen', '%trafohalle%', 'Therwilerstrasse 56', '4103', 'Bottmingen', 100,
   'Halle ca. 360 m², unbeheizt, Saison Ende März bis Ende Oktober. Haustechnik nicht bekannt.',
   'Träger: Trägerverein Leimentale. Über KULTURLINE. Ca. 100 Sitzplätze, nicht vom Verein bestätigt.',
   47.5196255::numeric, 7.5678395::numeric),
  ('Freie Gemeinschaftsbank', '%gemeinschaftsbank%', 'Meret Oppenheim-Strasse 10', '4053', 'Basel', 140,
   'Saal im Erdgeschoss ca. 16 x 9.5 m mit Podestbühne, Beamer, Theaterbeleuchtung, Mikrofonen. Tagungsraum im Dachgeschoss ca. 48 m² für 20 bis 50 Personen.',
   'Träger: Freie Gemeinschaftsbank Genossenschaft. Über KULTURLINE. Mietzeit ab 17 Uhr.',
   47.5468427::numeric, 7.5855310::numeric)
) as v(name, muster, street, zip, city, capacity, technik, notiz, lat, lng)
where not exists (
  select 1 from public.locations l where l.name ilike v.muster
);
