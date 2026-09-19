-- 235_lieferant_sieht_eigene_firma.sql
-- Lieferanten-Portal-User darf GENAU die eigene Firmen-Zeile in
-- public.lieferanten lesen (Header/Konto zeigen den Firmennamen via
-- Embed profiles_lieferant_id_fkey). Die bestehende SELECT-Policy
-- verlangt has_permission('lieferanten:view') — die Portal-Rolle hat
-- bewusst keine Permissions. Idempotent.

drop policy if exists "lieferant_sieht_eigene_firma" on public.lieferanten;
create policy "lieferant_sieht_eigene_firma"
  on public.lieferanten for select to authenticated
  using (
    id = (select lieferant_id from public.profiles where id = auth.uid())
  );
