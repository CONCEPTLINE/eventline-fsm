-- 284: Kundenwuensche aus dem Auftrags-Eingang (Leo 2026-10-02: "wiso
-- nimmt es bei Technik & Plan nicht die Technikwuensche der Kundin auf?").
-- Die Eingang-KI pflegt neu auch job_anforderungen. Herkunfts-Markierung
-- analog job_technik_positionen: Wiederverarbeitung eines Eingang-
-- Elements ersetzt dessen KI-Wuensche statt sie zu verdoppeln.

alter table job_anforderungen
  add column if not exists created_via text not null default 'manuell',
  add column if not exists quelle_item_id uuid references job_inbox_items(id) on delete set null;

create index if not exists job_anforderungen_quelle
  on job_anforderungen (quelle_item_id) where quelle_item_id is not null;
