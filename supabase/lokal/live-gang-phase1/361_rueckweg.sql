-- RÜCKWEG zu Migration 361 (Vier Augen bei Rechten, Strohmann-Schutz).
--
-- Nur nötig, wenn der Code auf einen Stand VOR Phase 1 zurückgerollt wird:
-- der alte Code ändert Admin-Rolle/Lohnrecht/Vertretung direkt, was die
-- Trigger aus 361 verweigern. Entfernt Trigger und Funktionen; die Tabelle
-- rechte_antraege (Protokoll der Anträge) BLEIBT.
-- Reihenfolge bei vollständigem Rückweg: 362_rueckweg → 361_rueckweg → 360_rueckweg.
-- Idempotent.

drop trigger if exists profiles_lohn_rechte_schutz on public.profiles;
drop trigger if exists roles_lohn_rechte_schutz on public.roles;
drop trigger if exists lohn_einstellungen_rechte_schutz on public.lohn_einstellungen;
drop trigger if exists lohn_einstellungen_rechte_schutz_truncate on public.lohn_einstellungen;
drop trigger if exists rechte_antraege_lohn_schutz on public.rechte_antraege;

drop function if exists public.lohn_rechte_schutz_profil();
drop function if exists public.lohn_rechte_schutz_rolle();
drop function if exists public.lohn_rechte_schutz_vertretung();
drop function if exists public.rechte_antrag_ausfuehren(uuid, uuid, text, text);
drop function if exists public.rolle_oeffnet_lohn(text);
drop function if exists public.rolle_oeffnet_lohn(text, jsonb);
