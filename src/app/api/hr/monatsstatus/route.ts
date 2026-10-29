// GET /api/hr/monatsstatus?month=YYYY-MM — Statusspalte «Monatsabschluss» in
// Lohn › Monatsstunden (Lohn-Umbau Phase 4). Je interne Person:
//   fehlt / erstellt / blockiert / Korrektur / Fehler / ausbezahlt — bzw.
//   «offen» (Monat noch nicht gesperrt) und «keine» (keine Abrechnung nötig).
// Regeln: bestimmeMonatsStatus (src/lib/lohn/lauf.ts). Alles aus der DB:
//   - gültige Fassung: lohn_fassungen_gueltig (Papierkorb zählt nicht)
//   - ausbezahlt: nicht stornierte lohn_auszahlungen der letzten Fassung;
//     Altbestand gilt als ausbezahlt (Datum = auszahlungsdatum, «übernommen»)
//   - Korrektur: offener lohn_korrektur_vorschlaege oder unbezahlte Korrekturfassung
//   - blockiert: ladeStempelProbleme im gesperrten Monat ohne Fassung
//   - Fehler: letzter Lauf (lohn_lauf) mit Fehler für Person/Monat
//   - nötig: Lohnzeile/Anstellung wie der Lauf (abrechnungsZeile)
// Stempel-Probleme werden auch für offene Monate mitgeliefert (dezenter Hinweis).
// Zugriff: Lohnrecht + vertrautes Gerät.

import { NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { PORTAL_ROLLEN_IN } from "@/lib/roles";
import { todayLocalIso } from "@/lib/swiss-time";
import { LOHN_RECHT } from "@/lib/lohn/zugriff";
import { ladeAlleSeiten } from "@/lib/lohn/daten";
import { istMonatGesperrt, monatSchluessel, sperrtAb } from "@/lib/lohn/monate";
import { ladeStempelProbleme, type StempelProblem } from "@/lib/lohn/stempel-pruefung";
import {
  abrechnungsZeile,
  bestimmeMonatsStatus,
  lohnzeilenFuerAbrechnung,
  type AnstellungZeile,
  type CompZeile,
  type LaufErgebnisZeile,
  type MonatsStatus,
} from "@/lib/lohn/lauf";

export const dynamic = "force-dynamic";

/** So viele Läufe zurück wird nach dem letzten Ergebnis je Person/Monat gesucht. */
const LAEUFE_ZURUECK = 40;

interface FassungRoh {
  id: string;
  profile_id: string;
  fassung: number;
  art: "regulaer" | "korrektur" | "altbestand";
  auszahlungsdatum: string;
  auszahlungsdatum_geschaetzt: boolean;
  auszahlung: number | string;
  wage_document_id: string | null;
}

export interface MonatsStatusZeile {
  profile_id: string;
  status: MonatsStatus;
  /** Klartext für Tooltip/Dialog. */
  text: string;
  fassung: {
    momentaufnahme_id: string;
    fassung: number;
    art: FassungRoh["art"];
    auszahlungsdatum: string;
    geschaetzt: boolean;
    /** An diesem Tag auszuzahlen (Korrektur: Differenz). */
    betrag: number;
    wage_document_id: string | null;
  } | null;
  auszahlung: {
    id: string | null;
    ausbezahlt_am: string;
    betrag: number;
    erfasst_von_name: string | null;
    erfasst_at: string | null;
    uebernommen: boolean;
  } | null;
  korrektur_vorschlag: boolean;
  stempel: StempelProblem[];
  fehler: string | null;
}

const tag = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};

export async function GET(req: Request) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  const month = new URL(req.url).searchParams.get("month");
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return NextResponse.json({ success: false, error: "Ungültiger Monat (erwartet YYYY-MM)" }, { status: 400 });
  }
  const m = { jahr: Number(month.slice(0, 4)), monat: Number(month.slice(5, 7)) };
  const gesperrt = istMonatGesperrt(m, todayLocalIso());
  const admin = createAdminClient();

  try {
    const profile = await ladeAlleSeiten<{ id: string; is_active: boolean | null }>(
      (a, b) => admin.from("profiles").select("id, is_active").not("role", "in", PORTAL_ROLLEN_IN).order("id").range(a, b),
      "Profile",
    );
    const ids = profile.map((p) => p.id);

    const [comps, anstellungen, fassungen, docs, auszahlungen, vorschlaege, stempel, laeufe] = await Promise.all([
      ladeAlleSeiten<CompZeile>(
        (a, b) => admin.from("employee_compensation").select("profile_id, effective_from, effective_to, wage_exempt, auto_lohnabrechnung").order("id").range(a, b),
        "Lohnzeilen",
      ),
      ladeAlleSeiten<AnstellungZeile & { id: string }>(
        (a, b) => admin.from("lohn_anstellungen").select("id, profile_id, eintritt, austritt").order("id").range(a, b),
        "Anstellungen",
      ),
      ladeAlleSeiten<FassungRoh>(
        (a, b) => admin.from("lohn_fassungen_gueltig")
          .select("id, profile_id, fassung, art, auszahlungsdatum, auszahlungsdatum_geschaetzt, auszahlung, wage_document_id")
          .eq("jahr", m.jahr).eq("monat", m.monat).order("profile_id").range(a, b),
        "Fassungen",
      ),
      ladeAlleSeiten<{ id: string; profile_id: string; archived_at: string | null }>(
        (a, b) => admin.from("wage_documents").select("id, profile_id, archived_at")
          .eq("doc_type", "lohnabrechnung").eq("year", m.jahr).eq("period_month", m.monat).is("superseded_at", null).order("id").range(a, b),
        "Lohnabrechnungen",
      ),
      ladeAlleSeiten<{ id: string; momentaufnahme_id: string; ausbezahlt_am: string; betrag: number | string; erfasst_von_name: string | null; erfasst_at: string }>(
        (a, b) => admin.from("lohn_auszahlungen").select("id, momentaufnahme_id, ausbezahlt_am, betrag, erfasst_von_name, erfasst_at")
          .eq("jahr", m.jahr).eq("monat", m.monat).is("storniert_at", null).order("id").range(a, b),
        "Auszahlungen",
      ),
      ladeAlleSeiten<{ profile_id: string }>(
        (a, b) => admin.from("lohn_korrektur_vorschlaege").select("profile_id").eq("jahr", m.jahr).eq("monat", m.monat).eq("status", "offen").order("id").range(a, b),
        "Korrektur-Vorschläge",
      ),
      ladeStempelProbleme(admin, ids, m.jahr, m.monat),
      admin.from("lohn_lauf").select("ergebnisse").neq("status", "pausiert").order("gestartet_at", { ascending: false }).limit(LAEUFE_ZURUECK),
    ]);
    if (laeufe.error) throw new Error(`Läufe konnten nicht geladen werden: ${laeufe.error.message}`);

    // Jüngstes Lauf-Ergebnis je Person für diesen Monat.
    const letztesErgebnis = new Map<string, LaufErgebnisZeile>();
    for (const l of (laeufe.data ?? []) as { ergebnisse: LaufErgebnisZeile[] | null }[]) {
      for (const e of l.ergebnisse ?? []) {
        if (e.monat === month && !letztesErgebnis.has(e.profile_id)) letztesErgebnis.set(e.profile_id, e);
      }
    }
    const compsJe = new Map<string, CompZeile[]>();
    for (const c of comps) compsJe.set(c.profile_id, [...(compsJe.get(c.profile_id) ?? []), c]);
    const anstJe = new Map<string, AnstellungZeile[]>();
    for (const a of anstellungen) anstJe.set(a.profile_id, [...(anstJe.get(a.profile_id) ?? []), a]);
    const fassungJe = new Map(fassungen.map((f) => [f.profile_id, f]));
    const auszahlungJe = new Map(auszahlungen.map((a) => [a.momentaufnahme_id, a]));
    const vorschlag = new Set(vorschlaege.map((v) => v.profile_id));
    const gueltigeDoks = new Set(docs.filter((d) => !d.archived_at).map((d) => d.profile_id));
    const papierkorb = new Set(docs.filter((d) => d.archived_at).map((d) => d.profile_id));

    const zeilen: MonatsStatusZeile[] = profile.map((p) => {
      const f = fassungJe.get(p.id) ?? null;
      const anst = anstJe.get(p.id) ?? [];
      const zeilenP = lohnzeilenFuerAbrechnung(compsJe.get(p.id) ?? [], p.is_active === true, anst);
      // Inaktiv ohne bekannten Austritt: «nötig», sobald im Monat eine Lohnzeile gilt (der Lauf gibt dann einen Hinweis).
      const noetig = zeilenP === null ? abrechnungsZeile(compsJe.get(p.id) ?? [], anst, m) !== null : abrechnungsZeile(zeilenP, anst, m) !== null;
      const auszahlung = f ? auszahlungJe.get(f.id) ?? null : null;
      const probleme = stempel.get(p.id) ?? [];
      const letztes = letztesErgebnis.get(p.id);
      const laufFehler = letztes && !letztes.ok && !letztes.blockiert ? (letztes.fehler ?? "unbekannter Fehler") : null;
      const status = bestimmeMonatsStatus({
        gesperrt,
        noetig,
        fassungArt: f?.art ?? null,
        manuell: !f && gueltigeDoks.has(p.id),
        ausbezahlt: !!auszahlung,
        vorschlagOffen: vorschlag.has(p.id),
        stempelProbleme: probleme.length,
        laufFehler,
      });
      const altbestand = f?.art === "altbestand";
      const text = (() => {
        switch (status) {
          case "offen": return `Monat noch offen — gesperrt ab ${tag(sperrtAb(m))}`;
          case "keine": return "Keine Abrechnung nötig (kein Lohn oder nicht angestellt)";
          case "fehlt": return papierkorb.has(p.id) ? "Abrechnung liegt im Papierkorb — wiederherstellen oder neu erstellen" : "Noch keine Abrechnung";
          case "erstellt": return f ? `Fassung ${f.fassung} erstellt — Auszahlung ${tag(f.auszahlungsdatum)}${f.auszahlungsdatum_geschaetzt ? " (geschätzt)" : ""}` : "Hochgeladene Abrechnung (ohne Momentaufnahme)";
          case "blockiert": return "Stempel prüfen — die Abrechnung wäre sonst zu tief";
          case "korrektur": return vorschlag.has(p.id) ? "Korrektur-Vorschlag offen (Lohndokumente › Korrektur-Vorschläge)" : `Korrekturfassung ${f?.fassung ?? ""} — Auszahlung der Differenz offen`;
          case "fehler": return `Letzter Lauf: ${laufFehler}`;
          case "ausbezahlt": return altbestand && !auszahlung
            ? `Übernommen (Altbestand) — ausbezahlt am ${tag(f!.auszahlungsdatum)}`
            : `Ausbezahlt am ${tag(auszahlung!.ausbezahlt_am)}`;
        }
      })();
      return {
        profile_id: p.id,
        status,
        text,
        fassung: f
          ? {
              momentaufnahme_id: f.id,
              fassung: f.fassung,
              art: f.art,
              auszahlungsdatum: f.auszahlungsdatum,
              geschaetzt: f.auszahlungsdatum_geschaetzt,
              betrag: Number(f.auszahlung),
              wage_document_id: f.wage_document_id,
            }
          : null,
        auszahlung: auszahlung
          ? { id: auszahlung.id, ausbezahlt_am: auszahlung.ausbezahlt_am, betrag: Number(auszahlung.betrag), erfasst_von_name: auszahlung.erfasst_von_name, erfasst_at: auszahlung.erfasst_at, uebernommen: false }
          : altbestand && f
            ? { id: null, ausbezahlt_am: f.auszahlungsdatum, betrag: Number(f.auszahlung), erfasst_von_name: null, erfasst_at: null, uebernommen: true }
            : null,
        korrektur_vorschlag: vorschlag.has(p.id),
        stempel: probleme,
        fehler: laufFehler,
      };
    });

    return NextResponse.json(
      { success: true, month: monatSchluessel(m), gesperrt, sperrt_ab: sperrtAb(m), zeilen },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
