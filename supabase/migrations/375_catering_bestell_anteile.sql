-- 375: Getränke-Catering — Mix-Anteile je Sorte (Grundlage der Bestellliste), Stand Karte 02.11.2026.
--
-- Bisher trug nur je eine Zeile pro Kategorie einen Mix-Anteil (Bier: Birra Moretti 35 %, Softdrinks: Eptinger rot 35 %).
-- Für die Bestellliste («wie viel von was») braucht jede verkaufte Sorte ihren eigenen Anteil. Die Kategorie-Summen
-- bleiben gleich (Bier 35 %, Softdrinks 35 %), die Sorten innerhalb haben denselben Einkaufs- und Verkaufspreis.
-- Der Durchschnittspreis der Kalkulation ändert sich dadurch NICHT (Mindestumsatz und Richtwerte bleiben gleich).
--
-- Die Verteilung ist eine Annahme (Bier 80 % Birra Moretti, 20 % alkoholfrei; Softdrinks Eptinger rot/blau je 2/7,
-- Coca-Cola 2/7, Coca-Cola Zero 1/7) und in Einstellungen → Catering je Zeile änderbar.
--
-- Nur Daten, idempotent (Werte werden gesetzt, nicht addiert), nur für Zeilen, die es mit diesem Namen gibt.

update public.catering_getraenke set mix_anteil = 0.28 where kategorie = 'bier'      and name = 'Birra Moretti'              and einheit = '33 cl';
update public.catering_getraenke set mix_anteil = 0.07 where kategorie = 'bier'      and name = 'Birra Moretti, alkoholfrei'  and einheit = '33 cl';
update public.catering_getraenke set mix_anteil = 0.10 where kategorie = 'softdrink' and name = 'Eptinger rot';
update public.catering_getraenke set mix_anteil = 0.10 where kategorie = 'softdrink' and name = 'Eptinger blau';
update public.catering_getraenke set mix_anteil = 0.10 where kategorie = 'softdrink' and name = 'Coca-Cola';
update public.catering_getraenke set mix_anteil = 0.05 where kategorie = 'softdrink' and name = 'Coca-Cola Zero';
