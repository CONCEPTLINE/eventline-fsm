import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ladeAlleSeiten, utcNach, utcVor } from "@/lib/lohn/daten";
import { istMonatGesperrtDb } from "@/lib/lohn/abrechnung";
import { ladeStempelProbleme } from "@/lib/lohn/stempel-pruefung";
import { ladeLohnEinstellungen, nachLaufBis } from "@/lib/lohn/zugriff";
import { speichereBexioFassung } from "@/lib/lohn/fassung";
import { meldeNeueAbrechnung } from "@/lib/lohn/zustellung";
import { PORTAL_ROLLEN_IN } from "@/lib/roles";
import type { Ausgefuehrt } from "./aufruf";
import type { FlowAusweis } from "./ausweis";
import {
  interneProfile,
  monatText,
  nachtraeglichGeaendert,
  PERSONEN_ANSTELLUNG_AB,
  personenAuswahl,
  STAMMDATEN_SAETZE,
  stammdatenPerson,
  vergleichAusMomentaufnahme,
  zaehleUeberlappungen,
  type AblageAnfrage,
  type MomentaufnahmeRoh,
  type MonatsAnfrage,
  type PersonenKandidat,
  type StammdatenAnfrage,
  type StammdatenAnstellungRoh,
  type StammdatenLohnzeileRoh,
  type StammdatenProfilRoh,
  type StempelAenderung,
} from "./regeln";

// Daten der Trust-flow-Schnittstelle (nur Server, Admin-Client). Antworten ohne
// Namen (ausser /personen und /stammdaten, dafür sind sie da) und ohne Stempel-IDs;
// Personen-ID ist die ERP-Profil-ID, die Trust flow in «Personal bearbeiten» zuordnet.

const STUECK = 150;
function inStuecken<T>(liste: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < liste.length; i += STUECK) out.push(liste.slice(i, i + STUECK));
  return out;
}

interface AnstellungZeile {
  profile_id: string;
  eintritt: string;
  austritt: string | null;
}

/** Interne ERP-Profile unter den signierten IDs (unabhängig von Anstellung und «aktiv») — in Anfrage-Reihenfolge. */
export async function nurInterne(admin: SupabaseClient, ids: string[]): Promise<string[]> {
  const profile: { id: string; role: string | null }[] = [];
  for (const teil of inStuecken(ids)) {
    profile.push(...(await ladeAlleSeiten<{ id: string; role: string | null }>(
      (a, b) => admin.from("profiles").select("id, role").in("id", teil).order("id").range(a, b),
      "Profile",
    )));
  }
  return interneProfile(ids, profile);
}

/** ERP-Profile mit Lohn-Anstellung (lohn_anstellungen), die [von, bis] (lokale Tage) berührt — in Anfrage-Reihenfolge.
 *  Nur noch für /vergleich (Lohnmonate ≤ 2026-11, ERP-Momentaufnahmen). */
export async function mitAnstellung(admin: SupabaseClient, ids: string[], von: string, bis: string): Promise<string[]> {
  const zeilen: AnstellungZeile[] = [];
  for (const teil of inStuecken(ids)) {
    zeilen.push(...(await ladeAlleSeiten<AnstellungZeile>(
      (a, b) => admin.from("lohn_anstellungen").select("profile_id, eintritt, austritt").in("profile_id", teil).order("id").range(a, b),
      "Anstellungen",
    )));
  }
  const treffer = new Set(zeilen.filter((z) => z.eintritt <= bis && (z.austritt == null || z.austritt >= von)).map((z) => z.profile_id));
  return ids.filter((id) => treffer.has(id));
}

// ---------------------------------------------------------------------------
// POST /api/flow/stempel
// ---------------------------------------------------------------------------
export async function stempelAntwort(admin: SupabaseClient, a: MonatsAnfrage): Promise<Ausgefuehrt> {
  const monat = monatText(a.jahr, a.monat);
  // Personen: Trust flow bestimmt sie (eigene Anstellungen) und signiert sie in `profile`;
  // das ERP liefert jedes interne Profil davon — auch Ausgetretene (Entscheid Backoffice 30.10.).
  const [gesperrt, personen] = await Promise.all([istMonatGesperrtDb(admin, a.jahr, a.monat), nurInterne(admin, a.profile)]);

  type StempelZeile = { user_id: string; clock_in: string; clock_out: string | null; ueberlappung_altfall: boolean | null };
  type AenderungZeile = { profile_id: string; occurred_at: string; alt_in: string | null; alt_out: string | null; neu_in: string | null; neu_out: string | null };
  const stempel: StempelZeile[] = [];
  const aenderungen: AenderungZeile[] = [];
  for (const teil of inStuecken(personen)) {
    const [s, ae] = await Promise.all([
      // Genau die Stempel, die das ERP dem Kern für diesen Monat gibt (src/lib/lohn/daten.ts, monatsEingabe).
      ladeAlleSeiten<StempelZeile>(
        (x, y) => admin.from("time_entries").select("user_id, clock_in, clock_out, ueberlappung_altfall").in("user_id", teil)
          .gte("clock_in", utcVor(a.von)).lt("clock_in", utcNach(a.bis)).order("id").range(x, y),
        "Stempelzeiten",
      ),
      // Stempel-Änderungen nach der Sperre (Antrag/Notweg) — nur sie stehen für Stempel in lohn_aenderungen.
      ladeAlleSeiten<AenderungZeile>(
        (x, y) => admin.from("lohn_aenderungen")
          .select("profile_id, occurred_at, alt_in:alt->>clock_in, alt_out:alt->>clock_out, neu_in:neu->>clock_in, neu_out:neu->>clock_out")
          .eq("tabelle", "time_entries").in("quelle", ["antrag", "notweg"]).in("profile_id", teil)
          .gte("occurred_at", utcVor(a.von)).order("id").range(x, y),
        "Stempel-Änderungen",
      ),
    ]);
    stempel.push(...s);
    aenderungen.push(...ae);
  }
  const probleme = await ladeStempelProbleme(admin, personen, a.jahr, a.monat);

  const antwortPersonen = personen.map((id) => {
    const eigene = stempel
      .filter((s) => s.user_id === id)
      .sort((x, y) => new Date(x.clock_in).getTime() - new Date(y.clock_in).getTime()
        || (x.clock_out ? new Date(x.clock_out).getTime() : Infinity) - (y.clock_out ? new Date(y.clock_out).getTime() : Infinity));
    const p = probleme.get(id) ?? [];
    return {
      erp_profil_id: id,
      stempel: eigene.map((s) => ({ start: s.clock_in, ende: s.clock_out })),
      probleme: {
        offen: p.filter((x) => x.art === "offen").length,
        ueberlappend: zaehleUeberlappungen(eigene.map((s) => ({ start: s.clock_in, ende: s.clock_out, altfall: s.ueberlappung_altfall === true })), monat),
        lang_ungeprueft: p.filter((x) => x.art === "lang").length,
      },
    };
  });

  const aend: StempelAenderung[] = aenderungen.map((z) => ({
    profileId: z.profile_id,
    occurredAt: z.occurred_at,
    alt: z.alt_in ? { clock_in: z.alt_in, clock_out: z.alt_out } : null,
    neu: z.neu_in ? { clock_in: z.neu_in, clock_out: z.neu_out } : null,
  }));

  return {
    ok: true,
    geliefert: antwortPersonen.length,
    body: {
      monat_gesperrt: gesperrt,
      personen: antwortPersonen,
      nachtraeglich_geaendert: nachtraeglichGeaendert(aend, a.von.slice(0, 7), monat),
    },
  };
}

// ---------------------------------------------------------------------------
// POST /api/flow/personen
// ---------------------------------------------------------------------------
export async function personenAntwort(admin: SupabaseClient): Promise<Ausgefuehrt> {
  // Aktive interne Profile wie bisher, dazu inaktive mit einer ERP-Anstellung, die ab Dezember 2026 noch läuft.
  const [aktive, laufendeZeilen] = await Promise.all([
    ladeAlleSeiten<PersonenKandidat>(
      (a, b) => admin.from("profiles").select("id, full_name, role, is_active").eq("is_active", true).not("role", "in", PORTAL_ROLLEN_IN).order("id").range(a, b),
      "Profile",
    ),
    ladeAlleSeiten<{ profile_id: string }>(
      (a, b) => admin.from("lohn_anstellungen").select("profile_id").or(`austritt.is.null,austritt.gte.${PERSONEN_ANSTELLUNG_AB}`).order("id").range(a, b),
      "Anstellungen",
    ),
  ]);
  const laufend = new Set(laufendeZeilen.map((z) => z.profile_id.toLowerCase()));
  const schonDa = new Set(aktive.map((p) => p.id.toLowerCase()));
  const weitere: PersonenKandidat[] = [];
  for (const teil of inStuecken([...laufend].filter((id) => !schonDa.has(id)))) {
    weitere.push(...(await ladeAlleSeiten<PersonenKandidat>(
      (a, b) => admin.from("profiles").select("id, full_name, role, is_active").in("id", teil).not("role", "in", PORTAL_ROLLEN_IN).order("id").range(a, b),
      "Profile",
    )));
  }
  const personen = personenAuswahl([...aktive, ...weitere], laufend);
  return { ok: true, geliefert: personen.length, body: { personen } };
}

// ---------------------------------------------------------------------------
// POST /api/flow/stammdaten (A6)
// ---------------------------------------------------------------------------
/** Spalten aus employee_compensation: gültig ab, Ansatz, «kein Lohn», Standard-Schalter und die drei Sätze,
 *  die Trust flow übernimmt — bewusst KEINE übrigen Sätze, Arbeitgebersätze, Notizen. */
const STAMMDATEN_LOHN_SPALTEN = `profile_id, effective_from, hourly_wage_chf, wage_exempt, uses_standard_lohn, ${STAMMDATEN_SAETZE.join(", ")}`;

export async function stammdatenAntwort(admin: SupabaseClient, a: StammdatenAnfrage): Promise<Ausgefuehrt> {
  // Personen wie /stempel: jedes interne ERP-Profil aus dem signierten `profile` (auch ausgetreten/inaktiv);
  // Partner-/Lieferanten-Zugänge und unbekannte IDs fallen weg.
  type ProfilZeile = StammdatenProfilRoh & { role: string | null };
  const profile: ProfilZeile[] = [];
  for (const teil of inStuecken(a.profile)) {
    profile.push(...(await ladeAlleSeiten<ProfilZeile>(
      (x, y) => admin.from("profiles").select("id, role, full_name, birthdate").in("id", teil).order("id").range(x, y),
      "Profile",
    )));
  }
  const personen = interneProfile(a.profile, profile);
  const anstellungen: StammdatenAnstellungRoh[] = [];
  const lohnzeilen: StammdatenLohnzeileRoh[] = [];
  for (const teil of inStuecken(personen)) {
    const [an, lz] = await Promise.all([
      ladeAlleSeiten<StammdatenAnstellungRoh>(
        (x, y) => admin.from("lohn_anstellungen").select("profile_id, eintritt, austritt, vertragsart").in("profile_id", teil).order("id").range(x, y),
        "Anstellungen",
      ),
      ladeAlleSeiten<StammdatenLohnzeileRoh>(
        (x, y) => admin.from("employee_compensation").select(STAMMDATEN_LOHN_SPALTEN).in("profile_id", teil).order("id").range(x, y) as unknown as PromiseLike<{ data: StammdatenLohnzeileRoh[] | null; error: { message: string } | null }>,
        "Lohnzeilen",
      ),
    ]);
    anstellungen.push(...an);
    lohnzeilen.push(...lz);
  }
  const je = new Map(profile.map((p) => [p.id.toLowerCase(), p]));
  const liste = personen.map((id) => stammdatenPerson(je.get(id)!, anstellungen, lohnzeilen));
  return { ok: true, geliefert: liste.length, body: { personen: liste } };
}

// ---------------------------------------------------------------------------
// POST /api/flow/vergleich (nur Lohnmonate ≤ 2026-11)
// ---------------------------------------------------------------------------
export async function vergleichAntwort(admin: SupabaseClient, a: MonatsAnfrage): Promise<Ausgefuehrt> {
  const [gesperrt, personen] = await Promise.all([istMonatGesperrtDb(admin, a.jahr, a.monat), mitAnstellung(admin, a.profile, a.von, a.bis)]);
  const zeilen: MomentaufnahmeRoh[] = [];
  for (const teil of inStuecken(personen)) {
    zeilen.push(...(await ladeAlleSeiten<MomentaufnahmeRoh>(
      (x, y) => admin.from("lohn_fassungen_gueltig")
        .select("profile_id, fassung, art, kern_version, pruefsumme, auszahlungsdatum, brutto, ahv_lohn, alv_lohn, uvg_lohn, uvg_art, " +
          "positionen:ergebnis->positionen, nbu:ergebnis->nbu, bisher:eingaben->kern->bisher")
        .eq("jahr", a.jahr).eq("monat", a.monat).in("profile_id", teil).order("profile_id").range(x, y) as unknown as PromiseLike<{ data: MomentaufnahmeRoh[] | null; error: { message: string } | null }>,
      "Momentaufnahmen",
    )));
  }
  const je = new Map(zeilen.map((z) => [z.profile_id, z]));
  const liste = personen.map((id) => {
    const m = je.get(id);
    return { erp_profil_id: id, momentaufnahme: m ? vergleichAusMomentaufnahme(m) : null };
  });
  return {
    ok: true,
    geliefert: liste.length,
    body: { monat: monatText(a.jahr, a.monat), monat_gesperrt: gesperrt, personen: liste },
  };
}

// ---------------------------------------------------------------------------
// POST /api/flow/lohnabrechnung (A5)
// ---------------------------------------------------------------------------
const ablehnen = (status: number, code: string, meldung: string): Ausgefuehrt => ({ ok: false, status, code, meldung });

export async function lohnabrechnungAblegen(
  admin: SupabaseClient,
  a: AblageAnfrage,
  pdf: Uint8Array,
  ausweis: FlowAusweis,
  abrufId: string,
): Promise<Ausgefuehrt> {
  // Person: internes ERP-Profil (kein Partner-/Lieferanten-Zugang), auch ausgetreten —
  // die Anstellungen führt Trust flow (Entscheid Backoffice 30.10.).
  if ((await nurInterne(admin, [a.profileId])).length === 0) {
    return ablehnen(422, "person_unbekannt", "Keine Mitarbeiterin / kein Mitarbeiter mit dieser ERP-Profil-ID.");
  }
  const einst = await ladeLohnEinstellungen(admin);
  if (!nachLaufBis(einst.laufBis, { jahr: a.jahr, monat: a.monat })) {
    return ablehnen(422, "erp_monat", "Für diesen Lohnmonat rechnet das ERP — keine Lohnabrechnung aus Bexio.");
  }

  const r = await speichereBexioFassung(admin, {
    profileId: a.profileId,
    jahr: a.jahr,
    monat: a.monat,
    fassung: a.fassung,
    pdf,
    pdfSha256: a.sha256,
    flowAbrufId: abrufId,
    flowSub: ausweis.sub,
  });
  if (r.modus === "abgelehnt") return ablehnen(r.code === "erp_monat" ? 422 : 409, r.code, r.meldung);
  if (r.modus === "vorhanden") {
    return { ok: true, geliefert: 0, body: { ok: true, modus: "vorhanden", dokument_id: r.id, erp_fassung: r.version } };
  }
  // Wie bei ERP-Abrechnungen: «liegt bereit» an die Person (ohne Beträge), Zustellnachweis. Wirft nie.
  await meldeNeueAbrechnung(admin, {
    profileId: a.profileId,
    jahr: a.jahr,
    monat: a.monat,
    wageDocumentId: r.id,
    art: a.fassung > 1 ? "korrektur" : "regulaer",
  });
  return { ok: true, geliefert: 1, body: { ok: true, modus: "abgelegt", dokument_id: r.id, erp_fassung: r.version } };
}
