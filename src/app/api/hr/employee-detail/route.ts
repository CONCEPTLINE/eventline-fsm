// GET /api/hr/employee-detail?profile_id=...&year=YYYY[&month=M]
//
// Lohn-Details einer Person für ein Jahr — gerechnet vom Rechenkern
// (src/lib/lohn/kern über daten.ts), wie Lohnabrechnung und Monatstabelle:
//   - Bezugsmonat (month, Standard: laufender Monat bzw. Dezember):
//     Brutto, Netto, Abzüge mit NBU nach 7/87, Sätze nach Auszahlungsdatum
//   - Jahres-Stunden (gestempelt; geplant/rapportiert zur Information)
//   - Nächte (eine Nacht = Abend 23 Uhr bis Morgen 6 Uhr, zählt im Jahr ihres
//     Beginns; bis 24/Jahr 25 %, danach Zeitzuschlag 10 %) mit Rang
//   - Sonn-/Feiertage (Sa 23 – So 23; bis 6/Jahr 50 %) mit Rang
//
// Zugriff: lohn:manage + vertrautes Gerät (Lohndaten).

import { NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayLocalIso, localTimeHM } from "@/lib/swiss-time";
import { protokolliereZugriff, geraetHashAusCookies } from "@/lib/finanzen/zugriffe";
import { ZUGRIFF_AKTION } from "@/lib/finanzen/types";
import { isUuid } from "@/lib/search-escape";
import {
  NACHT_MAX_JE_JAHR,
  SONNTAG_MAX_JE_JAHR,
  feiertageBaselStadtJahre,
  jahresEinsaetze,
  lohnzeileAm,
} from "@/lib/lohn/kern";
import { bereichMitVormonaten, ladeAlleSeiten, ladeLohnPersonen, monatKey, rechneMonate } from "@/lib/lohn/daten";
import { ladeInfoMinuten } from "@/lib/lohn/info-minuten";

export async function GET(req: Request) {
  const auth = await requireTrustedDevice("lohn:manage");
  if (auth.error) return auth.error;
  const admin = createAdminClient();

  const url = new URL(req.url);
  const profileId = url.searchParams.get("profile_id") ?? "";
  if (!isUuid(profileId)) return NextResponse.json({ success: false, error: "profile_id fehlt" }, { status: 400 });
  const [heuteJahr, heuteMonat] = todayLocalIso().split("-").map(Number);
  const yearParam = url.searchParams.get("year");
  const year = yearParam && /^\d{4}$/.test(yearParam) ? Number(yearParam) : heuteJahr;
  const monthParam = url.searchParams.get("month");
  const monat = monthParam && /^(?:[1-9]|1[0-2])$/.test(monthParam) ? Number(monthParam) : year === heuteJahr ? heuteMonat : 12;
  await protokolliereZugriff({ actorProfileId: auth.user.id, bereich: "lohn", aktion: ZUGRIFF_AKTION.LOHN_DETAIL, zielProfileId: profileId, geraetHash: await geraetHashAusCookies(), details: { jahr: year } });

  try {
    const monate = [{ jahr: year, monat }, { jahr: year, monat: 12 }];
    const [personen, info, eintraege] = await Promise.all([
      ladeLohnPersonen(admin, [profileId], bereichMitVormonaten(monate)),
      ladeInfoMinuten(admin, [profileId], `${year}-01-01`, `${year}-12-31`),
      ladeAlleSeiten<{ id: string; entry_number: number; clock_in: string; clock_out: string | null }>(
        (a, b) => admin.from("time_entries").select("id, entry_number, clock_in, clock_out").eq("user_id", profileId)
          .gte("clock_in", `${year - 1}-12-30T00:00:00Z`).lt("clock_in", `${year + 1}-01-02T00:00:00Z`).order("id").range(a, b),
        "Stempelzeiten",
      ),
    ]);
    const p = personen.get(profileId);
    if (!p) return NextResponse.json({ success: false, error: "Mitarbeiter nicht gefunden" }, { status: 404 });

    const { ergebnisse } = await rechneMonate(admin, [profileId], [{ jahr: year, monat }], { personen });
    const r = ergebnisse.get(profileId)?.get(monatKey(year, monat));
    const e = r?.ok ? r.ergebnis : null;

    // Nächte und Sonn-/Feiertage des Jahres mit Rang — dieselbe Regel wie die Abrechnung.
    const feiertage = feiertageBaselStadtJahre(year - 1, year + 1);
    const jahr = jahresEinsaetze(p.stempel, p.person.anstellungen, feiertage, year);
    // Welche Stempel gehören zu welcher Nacht / welchem Sonntag (Anzeige)?
    const zuNacht = new Map<string, { entry_number: number; start_local: string; end_local: string }[]>();
    const zuSonntag = new Map<string, { entry_number: number; start_local: string; end_local: string }[]>();
    for (const t of eintraege) {
      if (!t.clock_out) continue;
      const einzeln = jahresEinsaetze([{ start: t.clock_in, ende: t.clock_out }], null, feiertage, year);
      const eintrag = { entry_number: t.entry_number, start_local: localTimeHM(new Date(t.clock_in)), end_local: localTimeHM(new Date(t.clock_out)) };
      for (const n of einzeln.naechte) zuNacht.set(n.datum, [...(zuNacht.get(n.datum) ?? []), eintrag]);
      for (const s of einzeln.sonntage) zuSonntag.set(s.datum, [...(zuSonntag.get(s.datum) ?? []), eintrag]);
    }

    let geplant = 0;
    let rapport = 0;
    for (const m of info.geplant.get(profileId)?.values() ?? []) geplant += m;
    for (const m of info.rapport.get(profileId)?.values() ?? []) rapport += m;

    const zeile = lohnzeileAm(p.lohnzeilen, `${year}-${String(monat).padStart(2, "0")}-15`) ?? p.lohnzeilen.at(-1) ?? null;
    const agPct = e ? Object.values(e.saetze.ag).reduce((s, v) => s + v, 0) : 0;
    return NextResponse.json({
      success: true,
      profile: { id: p.profileId, full_name: p.name, role: p.role, email: p.email },
      year,
      compensation: zeile
        ? {
            hourly_wage_chf: zeile.stundenlohn,
            employer_costs_chf_per_hour: (zeile.stundenlohn * agPct) / 100,
            effective_from: zeile.gueltigAb,
            notes: p.lohnzeilenRoh.find((z) => z.id === zeile.id)?.notes ?? null,
            ahv_iv_eo_pct: e?.saetze.an.ahvIvEo ?? 0,
            alv_pct: e?.saetze.an.alv ?? 0,
            nbu_pct: e?.saetze.an.nbu ?? 0,
            bvg_pct: e?.saetze.an.bvg ?? 0,
            ktg_pct: e?.saetze.an.ktg ?? 0,
            quellensteuer_pct: e?.saetze.an.quellensteuer ?? 0,
            nbu: { jahr: year, monat, versichert: e?.nbu.versichert ?? false, hinweis: e ? e.nbu.begruendung : r && !r.ok ? r.fehler : "" },
          }
        : null,
      // Bezugsmonat: dieselben Zahlen wie Lohnabrechnung und Monatstabelle.
      monat: {
        jahr: year,
        monat,
        fehler: r && !r.ok ? r.fehler : null,
        minuten: e?.mengen.minuten ?? 0,
        brutto: e?.brutto ?? null,
        netto: e?.netto ?? null,
        total_abzuege: e?.totalAbzuege ?? null,
        positionen: e?.positionen ?? [],
        hinweise: e?.hinweise.map((h) => h.text) ?? [],
      },
      hours: { stempel_minutes: jahr.minuten, geplant_minutes: geplant, rapport_minutes: rapport },
      night: {
        count: jahr.naechte.length,
        limit: NACHT_MAX_JE_JAHR,
        dates: jahr.naechte.map((n) => ({ date: n.datum, label: n.mitZuschlag ? `${n.rang}. Nacht` : `${n.rang}. Nacht — Zeitzuschlag`, entries: zuNacht.get(n.datum) ?? [] })),
        surcharge_pct: 25,
        note: "Eine Nacht = 23 bis 6 Uhr, zählt im Jahr ihres Beginns. Bis 24 Nächte/Jahr 25 % Lohnzuschlag, ab der 25. Zeitzuschlag 10 % (ArG Art. 17b).",
      },
      sunday_holiday: {
        count: jahr.sonntage.length,
        limit: SONNTAG_MAX_JE_JAHR,
        dates: jahr.sonntage.map((s) => ({ date: s.datum, label: s.name, entries: zuSonntag.get(s.datum) ?? [] })),
        surcharge_pct: 50,
        note: "Sonntag = Samstag 23 bis Sonntag 23 Uhr, Feiertage gleich. Bis 6 Sonn-/Feiertage/Jahr 50 % Lohnzuschlag, danach Ersatzruhe (ArG Art. 19/20).",
      },
      base_wage_for_surcharge: zeile?.stundenlohn ?? 0,
    });
  } catch (err) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
