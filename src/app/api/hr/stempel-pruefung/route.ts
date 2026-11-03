// GET /api/hr/stempel-pruefung?monat=YYYY-MM — Stempelzeiten › Prüfen.
//
// Je interne Person (aktiv oder mit Stempeln im Monat): gestempelte Stunden
// (gleiche Regel wie Rechenkern und Trust flow, src/lib/lohn/stunden.ts), was
// vor der Lohnabrechnung zu prüfen ist (offene Stempel, Stempel über 16 h ohne
// «geprüft» — src/lib/lohn/stempel-pruefung.ts), lange Schichten im Monat und
// offene Anträge, die DIESEN Monat betreffen — Stempel-Änderungs-Tickets: neuer
// Beginn (data.neu_start) bzw. Beginn des korrigierten Stempels (data.time_entry_id);
// Stempel-Anträge der Lohnverwaltung: Beginn je Operation (werte.clock_in) bzw.
// des betroffenen Stempels (id), sonst betrifft_ab. Ein Antrag ohne erkennbares
// Datum zählt in jedem Monat (nie verschluckt).
// KEINE Beträge — Löhne rechnet Trust flow. Dazu: Monat gesperrt (is_time_entry_locked)
// und ab wann.
//
// Zugriff: lohn:manage + vertrautes Gerät (wie die Aktionen «Stempel ist korrekt» /
// «Ende setzen», /api/hr/stempel-pruefen und /api/hr/stempel-antrag).

import { NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { PORTAL_ROLLEN_IN } from "@/lib/roles";
import { protokolliereZugriff, geraetHashAusCookies } from "@/lib/finanzen/zugriffe";
import { ZUGRIFF_AKTION } from "@/lib/finanzen/types";
import { ladeAlleSeiten } from "@/lib/lohn/daten";
import { istMonatGesperrtDb } from "@/lib/lohn/abrechnung";
import { LOHN_RECHT } from "@/lib/lohn/zugriff";
import { ladeStempelProbleme, STEMPEL_LANG_MS } from "@/lib/lohn/stempel-pruefung";
import { minutenJeMonat } from "@/lib/lohn/stunden";
import { sperrtAb } from "@/lib/lohn/monate";
import { lokalesDatum } from "@/lib/lohn/kern";

export const dynamic = "force-dynamic";

const fehler = (e: unknown, status = 500) =>
  NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status });

export async function GET(req: Request) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  const monatText = new URL(req.url).searchParams.get("monat");
  if (!monatText || !/^\d{4}-(0[1-9]|1[0-2])$/.test(monatText)) return fehler("Ungültiger Monat (erwartet YYYY-MM)", 400);
  const jahr = Number(monatText.slice(0, 4));
  const monat = Number(monatText.slice(5, 7));
  const admin = createAdminClient();
  await protokolliereZugriff({ actorProfileId: auth.user.id, bereich: "lohn", aktion: ZUGRIFF_AKTION.LOHN_MONATSSTUNDEN, geraetHash: await geraetHashAusCookies(), details: { monat: monatText, ansicht: "stempel-pruefen" } });

  try {
    // Stempel, die den Monat berühren (Ortszeit): Beginn ab 2 Tage vor dem Ersten, bis 1 Tag nach dem Letzten.
    const von = new Date(Date.UTC(jahr, monat - 1, 1) - 2 * 86_400_000).toISOString();
    const bis = new Date(Date.UTC(jahr, monat, 1) + 86_400_000).toISOString();
    type StempelZeile = { user_id: string; clock_in: string; clock_out: string | null; lang_begruendung: string | null; geprueft_at: string | null };
    const jetzt = new Date().toISOString();
    const [profile, stempel, tickets, antraege, gesperrt] = await Promise.all([
      ladeAlleSeiten<{ id: string; full_name: string | null; is_active: boolean | null }>(
        (a, b) => admin.from("profiles").select("id, full_name, is_active").not("role", "in", PORTAL_ROLLEN_IN).order("id").range(a, b),
        "Profile",
      ),
      ladeAlleSeiten<StempelZeile>(
        (a, b) => admin.from("time_entries").select("user_id, clock_in, clock_out, lang_begruendung, geprueft_at")
          .gte("clock_in", von).lt("clock_in", bis).order("id").range(a, b),
        "Stempelzeiten",
      ),
      ladeAlleSeiten<{ created_by: string | null; data: Record<string, unknown> | null }>(
        (a, b) => admin.from("tickets").select("created_by, data").eq("type", "stempel_aenderung").eq("status", "offen").order("id").range(a, b),
        "Stempel-Tickets",
      ),
      ladeAlleSeiten<{ profile_id: string | null; operationen: unknown; betrifft_ab: string | null }>(
        (a, b) => admin.from("lohn_aenderungs_antraege").select("profile_id, operationen, betrifft_ab").eq("bereich", "stempel").eq("status", "offen")
          .gt("gueltig_bis", jetzt).order("id").range(a, b),
        "Stempel-Anträge",
      ),
      istMonatGesperrtDb(admin, jahr, monat),
    ]);

    const jePerson = new Map<string, StempelZeile[]>();
    for (const s of stempel) jePerson.set(s.user_id, [...(jePerson.get(s.user_id) ?? []), s]);

    // Offene Anträge → betroffene Lohnmonate (Ortszeit). Beginn bestehender Stempel über ihre ID.
    type Op = { id?: unknown; werte?: { clock_in?: unknown } | null };
    const ops = (a: { operationen: unknown }) => (Array.isArray(a.operationen) ? a.operationen : []) as Op[];
    const stempelIds = new Set<string>();
    for (const t of tickets) if (typeof t.data?.time_entry_id === "string") stempelIds.add(t.data.time_entry_id);
    for (const a of antraege) for (const o of ops(a)) if (typeof o.id === "string") stempelIds.add(o.id);
    const beginnVon = new Map<string, string>();
    const idListe = [...stempelIds];
    for (let i = 0; i < idListe.length; i += 150) {
      const teil = idListe.slice(i, i + 150);
      const zeilen = await ladeAlleSeiten<{ id: string; clock_in: string }>(
        (a, b) => admin.from("time_entries").select("id, clock_in").in("id", teil).order("id").range(a, b),
        "Stempel der Anträge",
      );
      for (const z of zeilen) beginnVon.set(z.id, z.clock_in);
    }
    const monatAus = (iso: unknown): string | null =>
      typeof iso === "string" && !Number.isNaN(new Date(iso).getTime()) ? lokalesDatum(new Date(iso).getTime()).slice(0, 7) : null;
    const betrifftMonat = (monate: (string | null)[]) => {
      const bekannt = monate.filter((m): m is string => !!m);
      return bekannt.length === 0 || bekannt.includes(monatText); // ohne Datum: immer zeigen
    };
    const offeneAntraege = new Map<string, number>();
    const zaehle = (id: string) => offeneAntraege.set(id, (offeneAntraege.get(id) ?? 0) + 1);
    for (const t of tickets) {
      if (!t.created_by) continue;
      const alt = typeof t.data?.time_entry_id === "string" ? beginnVon.get(t.data.time_entry_id) : undefined;
      if (betrifftMonat([monatAus(t.data?.neu_start), monatAus(alt)])) zaehle(t.created_by);
    }
    for (const a of antraege) {
      if (!a.profile_id) continue;
      const monate: (string | null)[] = ops(a).flatMap((o) => [monatAus(o.werte?.clock_in), typeof o.id === "string" ? monatAus(beginnVon.get(o.id)) : null]);
      const ohneDatum = !monate.some((m) => m !== null);
      if (ohneDatum && a.betrifft_ab) monate.push(a.betrifft_ab.slice(0, 7));
      if (betrifftMonat(monate)) zaehle(a.profile_id);
    }

    const minutenVon = (id: string) => minutenJeMonat((jePerson.get(id) ?? []).map((s) => ({ start: s.clock_in, ende: s.clock_out }))).get(monatText) ?? 0;
    const sichtbar = profile
      .map((p) => ({ p, minuten: minutenVon(p.id) }))
      .filter(({ p, minuten }) => p.is_active === true || minuten > 0 || (offeneAntraege.get(p.id) ?? 0) > 0);
    const probleme = await ladeStempelProbleme(admin, sichtbar.map(({ p }) => p.id), jahr, monat);

    const personen = sichtbar
      .map(({ p, minuten }) => {
        // Lange Schichten: abgeschlossene Stempel über 16 h, die im Monat beginnen (Ortszeit).
        const lange = (jePerson.get(p.id) ?? []).filter((s) => s.clock_out
          && new Date(s.clock_out).getTime() - new Date(s.clock_in).getTime() > STEMPEL_LANG_MS
          && lokalesDatum(new Date(s.clock_in).getTime()).startsWith(monatText));
        return {
          profile_id: p.id,
          name: p.full_name ?? "?",
          is_active: p.is_active === true,
          minuten,
          probleme: probleme.get(p.id) ?? [],
          lange: {
            anzahl: lange.length,
            mit_begruendung: lange.filter((s) => (s.lang_begruendung ?? "").trim() !== "").length,
            geprueft: lange.filter((s) => s.geprueft_at).length,
          },
          antraege_offen: offeneAntraege.get(p.id) ?? 0,
        };
      })
      .sort((a, b) => Number(b.is_active) - Number(a.is_active) || a.name.localeCompare(b.name, "de-CH"));

    return NextResponse.json(
      { success: true, monat: monatText, gesperrt, sperrt_ab: sperrtAb({ jahr, monat }), personen },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return fehler(e);
  }
}
