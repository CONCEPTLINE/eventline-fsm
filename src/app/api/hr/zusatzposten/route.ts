// Einmalige Lohnposten je Person und Lohnmonat (Lohn-Umbau Phase 4,
// Tabelle lohn_zusatzposten, Migration 367):
//   - lohn            Lohnposten im Brutto (AHV-pflichtig / steuerbar wählbar),
//                     z. B. «Übernahme Quellensteuer durch die Firma»
//   - rueckerstattung Rückerstattung eines Abzugs (z. B. AHV/ALV unter CHF 2'500)
//   - spesen          effektive Spesen, nach dem Netto ausbezahlt
// Der Rechenkern rechnet sie in Brutto, Abzüge und Auszahlung (src/lib/lohn/kern).
//
// GET    /api/hr/zusatzposten?profile_id=…  — Posten der Person + wählbare Monate (gesperrt ja/nein)
// POST   /api/hr/zusatzposten               — erfassen { profile_id, jahr, monat, art, bezeichnung,
//                                             betrag, ahv_pflichtig, steuerbar, abzug_art, posten_begruendung }
// PATCH  /api/hr/zusatzposten               — ändern { id, …geänderte Felder, begruendung? }
// DELETE /api/hr/zusatzposten               — löschen { id, begruendung? }
//
// Geschrieben wird NUR über aendereLohndaten() (Protokoll alt/neu/wer per
// Trigger). Betrifft die Änderung einen abgerechneten (gesperrten) Lohnmonat,
// wird sie zum Antrag (Vier Augen, Anträge › Rechte & Lohndaten):
//   - Erfassen: Antrags-Begründung = Begründung des Postens (schon Pflicht)
//   - Ändern/Löschen: `begruendung` (sonst 409 «begruendung_noetig» → Modal)
// Zugriff: Lohnrecht + vertrautes Gerät; den eigenen Lohn ändert eine zweite
// Person (pruefeLohnAenderung, wie Lohnzeilen und Anstellung).

import { NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/search-escape";
import { todayLocalIso } from "@/lib/swiss-time";
import { LOHN_RECHT, pruefeLohnAenderung } from "@/lib/lohn/zugriff";
import { ladeName } from "@/lib/lohn/rechte-antraege";
import { aendereLohndaten, ANTRAG_HINWEIS_LOHN, type AenderungsErgebnis, type Operation } from "@/lib/lohn/aenderungen";
import { ABZUG_KLARTEXT, istFuenfRappen, type AbzugArt } from "@/lib/lohn/kern";
import { monatLabel } from "@/lib/lohn/monate";
import { formatChf } from "@/lib/format";

const SPALTEN =
  "id, profile_id, jahr, monat, art, bezeichnung, betrag, ahv_pflichtig, steuerbar, abzug_art, begruendung, created_at, created_by_name, updated_at, updated_by_name";

type Art = "lohn" | "rueckerstattung" | "spesen";
const ARTEN: Art[] = ["lohn", "rueckerstattung", "spesen"];
const ART_TEXT: Record<Art, string> = { lohn: "Lohn", rueckerstattung: "Rückerstattung", spesen: "Spesen" };
const ABZUG_ARTEN = Object.keys(ABZUG_KLARTEXT) as AbzugArt[];
/** Wählbare Lohnmonate: 15 zurück bis 1 voraus (älteres per Antrag über den Notweg). */
const MONATE_ZURUECK = 15;
const MONATE_VORAUS = 1;
const BETRAG_MAX = 100000;

interface Posten {
  profile_id: string;
  jahr: number;
  monat: number;
  art: Art;
  bezeichnung: string;
  betrag: number;
  ahv_pflichtig: boolean;
  steuerbar: boolean;
  abzug_art: AbzugArt | null;
  begruendung: string;
}

const fehler = (error: string, status = 400) => NextResponse.json({ success: false, error }, { status });

function monatsListe(heute: string): { jahr: number; monat: number }[] {
  const [j, m] = heute.split("-").map(Number);
  const out: { jahr: number; monat: number }[] = [];
  for (let i = -MONATE_ZURUECK; i <= MONATE_VORAUS; i++) {
    const idx = j * 12 + (m - 1) + i;
    out.push({ jahr: Math.floor(idx / 12), monat: (idx % 12) + 1 });
  }
  return out.reverse();
}

/** Ist der Lohnmonat abgerechnet? Dieselbe Regel wie der Sperr-Trigger (lohn_tag_gesperrt). */
async function gesperrt(admin: ReturnType<typeof createAdminClient>, jahr: number, monat: number): Promise<boolean> {
  const { data, error } = await admin.rpc("lohn_tag_gesperrt", { p_tabelle: "lohn_zusatzposten", p_tag: `${jahr}-${String(monat).padStart(2, "0")}-01` });
  if (error) throw new Error(`Monatssperre konnte nicht geprüft werden: ${error.message}`);
  return data === true;
}

/** Posten prüfen wie die DB (Migration 367) — mit Klartext statt Constraint-Namen. */
function pruefePosten(p: Posten): string | null {
  if (!Number.isInteger(p.jahr) || p.jahr < 2020 || p.jahr > 2100 || !Number.isInteger(p.monat) || p.monat < 1 || p.monat > 12) return "Lohnmonat ungültig";
  if (!ARTEN.includes(p.art)) return "Art ungültig";
  const bez = p.bezeichnung.trim();
  if (bez.length < 3 || bez.length > 80) return "Bezeichnung: 3–80 Zeichen";
  if (typeof p.betrag !== "number" || !Number.isFinite(p.betrag) || p.betrag === 0) return "Betrag fehlt";
  if (Math.abs(p.betrag) > BETRAG_MAX) return `Betrag über CHF ${formatChf(BETRAG_MAX, { ohnePrefix: true })} — bitte prüfen`;
  if (!istFuenfRappen(p.betrag)) return "Betrag in 5-Rappen-Schritten erfassen (z. B. 12.35)";
  if (p.art !== "lohn" && (p.ahv_pflichtig || p.steuerbar)) return "«AHV-pflichtig» und «steuerbar» gibt es nur bei Lohnposten";
  if (p.art === "rueckerstattung" && (!p.abzug_art || !ABZUG_ARTEN.includes(p.abzug_art))) return "Welcher Abzug wird zurückerstattet?";
  if (p.art !== "rueckerstattung" && p.abzug_art != null) return "Ein Abzug gehört nur zu einer Rückerstattung";
  if (p.begruendung.trim().length < 10) return "Begründung: mindestens 10 Zeichen";
  return null;
}

function beschreibe(p: Pick<Posten, "jahr" | "monat" | "art" | "bezeichnung" | "betrag" | "abzug_art">): string {
  const abzug = p.art === "rueckerstattung" && p.abzug_art ? ` (${ABZUG_KLARTEXT[p.abzug_art]})` : "";
  return `${monatLabel({ jahr: p.jahr, monat: p.monat })}, ${ART_TEXT[p.art]}${abzug} «${p.bezeichnung.trim()}» CHF ${formatChf(p.betrag, { ohnePrefix: true })}`;
}

function antwort(r: AenderungsErgebnis, mode: "angelegt" | "geaendert" | "geloescht") {
  if (r.modus === "begruendung_noetig") {
    return NextResponse.json(
      { success: false, code: "begruendung_noetig", error: `${r.meldung}. Bitte Begründung angeben — dann wird ein Antrag gestellt.`, betrifft_ab: r.betrifftAb },
      { status: 409 },
    );
  }
  if (r.modus === "antrag") return NextResponse.json({ success: true, mode: "antrag", antrag_id: r.antragId, hinweis: ANTRAG_HINWEIS_LOHN });
  return NextResponse.json({ success: true, mode, id: r.ids[0] ?? null });
}

const bool = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const zahl = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v.replace(",", ".")) : NaN);

async function ladePosten(admin: ReturnType<typeof createAdminClient>, id: string) {
  const { data, error } = await admin.from("lohn_zusatzposten").select(SPALTEN).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  return data as (Posten & { id: string; betrag: number | string }) | null;
}

export async function GET(req: Request) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  const pid = new URL(req.url).searchParams.get("profile_id") ?? "";
  if (!isUuid(pid)) return fehler("profile_id fehlt");
  const admin = createAdminClient();
  try {
    const { data, error } = await admin
      .from("lohn_zusatzposten")
      .select(SPALTEN)
      .eq("profile_id", pid)
      .order("jahr", { ascending: false })
      .order("monat", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(500);
    if (error) throw new Error(error.message);
    const posten = (data ?? []) as (Posten & { id: string })[];
    const { count: antraege, error: aErr } = await admin
      .from("lohn_aenderungs_antraege")
      .select("id", { count: "exact", head: true })
      .eq("bereich", "zusatzposten")
      .eq("profile_id", pid)
      .eq("status", "offen")
      .gt("gueltig_bis", new Date().toISOString());
    if (aErr) throw new Error(aErr.message);
    // Sperre je Monat (wählbare Monate und Monate bestehender Posten).
    const schluessel = new Map<string, { jahr: number; monat: number }>();
    for (const m of [...monatsListe(todayLocalIso()), ...posten.map((p) => ({ jahr: p.jahr, monat: p.monat }))]) {
      schluessel.set(`${m.jahr}-${m.monat}`, m);
    }
    const sperren = await Promise.all(Array.from(schluessel.values()).map(async (m) => [`${m.jahr}-${m.monat}`, await gesperrt(admin, m.jahr, m.monat)] as const));
    const istGesperrt = new Map(sperren);
    return NextResponse.json({
      success: true,
      posten: posten.map((p) => ({ ...p, betrag: Number(p.betrag), gesperrt: istGesperrt.get(`${p.jahr}-${p.monat}`) === true })),
      monate: monatsListe(todayLocalIso()).map((m) => ({ ...m, gesperrt: istGesperrt.get(`${m.jahr}-${m.monat}`) === true })),
      offene_antraege: antraege ?? 0,
    });
  } catch (e) {
    return fehler(e instanceof Error ? e.message : String(e), 500);
  }
}

export async function POST(req: Request) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return fehler("Body fehlt");
  const profileId = typeof b.profile_id === "string" && isUuid(b.profile_id) ? b.profile_id : null;
  if (!profileId) return fehler("profile_id fehlt");
  const admin = createAdminClient();
  const verbot = await pruefeLohnAenderung(admin, auth.user.id, profileId).catch((e: Error) => e.message);
  if (verbot) return fehler(verbot, 403);

  const art = String(b.art ?? "") as Art;
  const posten: Posten = {
    profile_id: profileId,
    jahr: Number(b.jahr),
    monat: Number(b.monat),
    art,
    bezeichnung: typeof b.bezeichnung === "string" ? b.bezeichnung : "",
    betrag: zahl(b.betrag),
    ahv_pflichtig: art === "lohn" ? bool(b.ahv_pflichtig) ?? true : false,
    steuerbar: art === "lohn" ? bool(b.steuerbar) ?? true : false,
    abzug_art: art === "rueckerstattung" ? ((typeof b.abzug_art === "string" ? b.abzug_art : null) as AbzugArt | null) : null,
    begruendung: typeof b.posten_begruendung === "string" ? b.posten_begruendung : "",
  };
  const ungueltig = pruefePosten(posten);
  if (ungueltig) return fehler(ungueltig);
  posten.bezeichnung = posten.bezeichnung.trim();
  posten.begruendung = posten.begruendung.trim().slice(0, 1000);

  try {
    const name = await ladeName(admin, auth.user.id);
    const { data: person, error: pErr } = await admin.from("profiles").select("full_name").eq("id", profileId).maybeSingle();
    if (pErr) throw new Error(pErr.message);
    if (!person) return fehler("Person nicht gefunden", 404);
    const zielName = (person.full_name as string | null) ?? null;
    const r = await aendereLohndaten(admin, {
      operationen: [{ op: "insert", tabelle: "lohn_zusatzposten", werte: { ...posten, created_by: auth.user.id, created_by_name: name } }],
      bereich: "zusatzposten",
      profileId,
      zielName,
      beschreibung: `Zusatzposten erfassen: ${zielName ?? profileId}, ${beschreibe(posten)}`,
      // Gesperrter Monat: die Begründung des Postens begründet den Antrag.
      begruendung: typeof b.begruendung === "string" && b.begruendung.trim().length >= 10 ? b.begruendung : posten.begruendung,
      akteurId: auth.user.id,
      akteurName: name,
    });
    return antwort(r, "angelegt");
  } catch (e) {
    return fehler(e instanceof Error ? e.message : String(e));
  }
}

export async function PATCH(req: Request) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return fehler("Body fehlt");
  const id = typeof b.id === "string" && isUuid(b.id) ? b.id : null;
  if (!id) return fehler("id fehlt");
  const admin = createAdminClient();
  try {
    const alt = await ladePosten(admin, id);
    if (!alt) return fehler("Posten nicht gefunden", 404);
    const verbot = await pruefeLohnAenderung(admin, auth.user.id, alt.profile_id).catch((e: Error) => e.message);
    if (verbot) return fehler(verbot, 403);

    const neu: Posten = { ...alt, betrag: Number(alt.betrag) };
    if ("jahr" in b) neu.jahr = Number(b.jahr);
    if ("monat" in b) neu.monat = Number(b.monat);
    if ("art" in b) neu.art = String(b.art) as Art;
    if ("bezeichnung" in b) neu.bezeichnung = typeof b.bezeichnung === "string" ? b.bezeichnung : "";
    if ("betrag" in b) neu.betrag = zahl(b.betrag);
    if ("ahv_pflichtig" in b) neu.ahv_pflichtig = bool(b.ahv_pflichtig) ?? false;
    if ("steuerbar" in b) neu.steuerbar = bool(b.steuerbar) ?? false;
    if ("abzug_art" in b) neu.abzug_art = (typeof b.abzug_art === "string" && b.abzug_art ? b.abzug_art : null) as AbzugArt | null;
    if ("posten_begruendung" in b) neu.begruendung = typeof b.posten_begruendung === "string" ? b.posten_begruendung : "";
    // Art gewechselt: Felder, die es nur bei einer Art gibt, folgen der Art.
    if (neu.art !== "lohn") { neu.ahv_pflichtig = false; neu.steuerbar = false; }
    if (neu.art !== "rueckerstattung") neu.abzug_art = null;
    const ungueltig = pruefePosten(neu);
    if (ungueltig) return fehler(ungueltig);
    neu.bezeichnung = neu.bezeichnung.trim();
    neu.begruendung = neu.begruendung.trim().slice(0, 1000);

    const werte: Record<string, unknown> = {};
    for (const k of ["jahr", "monat", "art", "bezeichnung", "betrag", "ahv_pflichtig", "steuerbar", "abzug_art", "begruendung"] as const) {
      const a = k === "betrag" ? Number(alt.betrag) : alt[k];
      if (a !== neu[k]) werte[k] = neu[k];
    }
    if (Object.keys(werte).length === 0) return NextResponse.json({ success: true, mode: "unveraendert", id });
    const name = await ladeName(admin, auth.user.id);
    const { data: person } = await admin.from("profiles").select("full_name").eq("id", alt.profile_id).maybeSingle();
    const zielName = (person?.full_name as string | null) ?? null;
    const op: Operation = { op: "update", tabelle: "lohn_zusatzposten", id, werte: { ...werte, updated_by: auth.user.id, updated_by_name: name } };
    const r = await aendereLohndaten(admin, {
      operationen: [op],
      bereich: "zusatzposten",
      profileId: alt.profile_id,
      zielName,
      beschreibung: `Zusatzposten ändern: ${zielName ?? alt.profile_id}, ${beschreibe(alt.art === neu.art && alt.jahr === neu.jahr && alt.monat === neu.monat ? neu : alt)}${
        alt.art !== neu.art || alt.jahr !== neu.jahr || alt.monat !== neu.monat || Number(alt.betrag) !== neu.betrag ? ` → ${beschreibe(neu)}` : ""
      }`,
      begruendung: typeof b.begruendung === "string" ? b.begruendung : null,
      akteurId: auth.user.id,
      akteurName: name,
    });
    return antwort(r, "geaendert");
  } catch (e) {
    return fehler(e instanceof Error ? e.message : String(e));
  }
}

export async function DELETE(req: Request) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const id = typeof b?.id === "string" && isUuid(b.id) ? b.id : null;
  if (!id) return fehler("id fehlt");
  const admin = createAdminClient();
  try {
    const alt = await ladePosten(admin, id);
    if (!alt) return fehler("Posten nicht gefunden", 404);
    const verbot = await pruefeLohnAenderung(admin, auth.user.id, alt.profile_id).catch((e: Error) => e.message);
    if (verbot) return fehler(verbot, 403);
    const name = await ladeName(admin, auth.user.id);
    const { data: person } = await admin.from("profiles").select("full_name").eq("id", alt.profile_id).maybeSingle();
    const zielName = (person?.full_name as string | null) ?? null;
    const r = await aendereLohndaten(admin, {
      operationen: [{ op: "delete", tabelle: "lohn_zusatzposten", id }],
      bereich: "zusatzposten",
      profileId: alt.profile_id,
      zielName,
      beschreibung: `Zusatzposten löschen: ${zielName ?? alt.profile_id}, ${beschreibe({ ...alt, betrag: Number(alt.betrag) })}`,
      begruendung: typeof b?.begruendung === "string" ? b.begruendung : null,
      akteurId: auth.user.id,
      akteurName: name,
    });
    return antwort(r, "geloescht");
  } catch (e) {
    return fehler(e instanceof Error ? e.message : String(e));
  }
}
