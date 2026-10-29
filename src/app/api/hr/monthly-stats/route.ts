// GET /api/hr/monthly-stats?month=YYYY-MM
//
// Monatstabelle Lohn: je Mitarbeiter Stunden, Brutto, Netto, Vollkosten —
// gerechnet vom EINEN Rechenkern (src/lib/lohn/kern über daten.ts), also
// exakt wie Lohnabrechnung, Excel, Lohn-Details und «Mein Monat»:
// Lohn tageweise, Sonntag Sa 23–So 23 (bis 6/Jahr 50 %), Nacht 23–6 (bis
// 24 Nächte/Jahr 25 %, danach Zeitzuschlag 10 %), 1. August 0,39 %,
// Ferienzuschlag nach Alter, NBU nach 7/87, Sätze nach Auszahlungsdatum.
// Geplant/Rapport nur zur Information. Kern-Fehler (fehlende Daten) stehen
// je Zeile in `fehler` — nie stille Ersatzwerte.
//
// BVG-Vorschau 3 Monate: Ist + geplante künftige Termine (Puffer 20 %),
// ebenfalls mit dem Kern (src/lib/lohn/prognose.ts).
//
// Zugriff: lohn:manage + vertrautes Gerät.

import { NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { PORTAL_ROLLEN_IN } from "@/lib/roles";
import { protokolliereZugriff, geraetHashAusCookies } from "@/lib/finanzen/zugriffe";
import { ZUGRIFF_AKTION } from "@/lib/finanzen/types";
import { feiertageBaselStadtJahre, firmensatzAm, jahresEinsaetze, jeLokalerStunde, lohnzeileAm, type Stempel } from "@/lib/lohn/kern";
import { ladeAlleSeiten, ladeFirmensaetze, ladeLohnPersonen, bereichMitVormonaten, monatKey, rechneMonate, regelAuszahlungsdatum, type LohnPerson, type RechenErgebnis } from "@/lib/lohn/daten";
import { ladeInfoMinuten, summeImMonat } from "@/lib/lohn/info-minuten";
import { monthRange, mitPuffer, termineAlsStempel } from "@/lib/lohn/prognose";
import { ladeLohnEinstellungen } from "@/lib/lohn/zugriff";

function minutenImMonat(stempel: Stempel[], prefix: string): number {
  let n = 0;
  for (const s of stempel) {
    if (!s.ende) continue;
    jeLokalerStunde(new Date(s.start).getTime(), new Date(s.ende).getTime(), (d, _h, m) => { if (d.startsWith(prefix)) n += m; });
  }
  return n;
}

const naechsterMonat = (j: number, m: number) => (m === 12 ? { jahr: j + 1, monat: 1 } : { jahr: j, monat: m + 1 });

export async function GET(req: Request) {
  const auth = await requireTrustedDevice("lohn:manage");
  if (auth.error) return auth.error;
  const admin = createAdminClient();

  const month = new URL(req.url).searchParams.get("month");
  if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return NextResponse.json({ success: false, error: "Ungültiger Monat (erwartet YYYY-MM)" }, { status: 400 });
  }
  await protokolliereZugriff({ actorProfileId: auth.user.id, bereich: "lohn", aktion: ZUGRIFF_AKTION.LOHN_MONATSSTUNDEN, geraetHash: await geraetHashAusCookies(), details: { monat: month } });
  const jahr = Number(month.slice(0, 4));
  const monat = Number(month.slice(5, 7));
  const prefix = `${month}-`;
  const m0 = { jahr, monat };
  const m1 = naechsterMonat(jahr, monat);
  const m2 = naechsterMonat(m1.jahr, m1.monat);
  const vorschau = [m0, m1, m2];

  try {
    const profile = await ladeAlleSeiten<{ id: string; full_name: string | null; role: string; is_active: boolean | null }>(
      (a, b) => admin.from("profiles").select("id, full_name, role, is_active").not("role", "in", PORTAL_ROLLEN_IN).order("id").range(a, b),
      "Profile",
    );
    const ids = profile.map((p) => p.id);
    const r0 = monthRange(jahr, monat);
    const r2 = monthRange(m2.jahr, m2.monat);
    const [personen, info, einst, firmensaetze] = await Promise.all([
      ladeLohnPersonen(admin, ids, bereichMitVormonaten(vorschau)),
      ladeInfoMinuten(admin, ids, r0.start, r2.end),
      ladeLohnEinstellungen(admin),
      ladeFirmensaetze(admin),
    ]);

    // Geplante künftige Termine (Vorschau) als zusätzliche «Stempel».
    const termine = await ladeAlleSeiten<{ id: string; assigned_to: string; start_time: string; end_time: string | null }>(
      (a, b) => admin.from("job_appointments").select("id, assigned_to, start_time, end_time").in("assigned_to", ids)
        .gte("start_time", `${r0.start}T00:00:00Z`).lt("start_time", `${r2.end}T23:59:59Z`).order("id").range(a, b),
      "Termine",
    );
    const jetzt = Date.now();
    const plan = new Map<string, Stempel[]>();
    for (const t of termine) {
      const l = plan.get(t.assigned_to) ?? [];
      l.push(...termineAlsStempel([t], jetzt));
      plan.set(t.assigned_to, l);
    }

    // Wer erscheint: aktiv oder Minuten im Monat; ohne Lohn (wage_exempt am Monatsersten) nie.
    const sichtbar = profile.filter((p) => {
      const lp = personen.get(p.id);
      const z = lp ? lohnzeileAm(lp.lohnzeilen, r0.start) : null;
      if (z?.ohneLohn) return false;
      const stempelMin = lp ? minutenImMonat(lp.stempel, prefix) : 0;
      return p.is_active === true || stempelMin > 0 || summeImMonat(info.geplant.get(p.id), prefix) > 0 || summeImMonat(info.rapport.get(p.id), prefix) > 0;
    });
    const mitLohn = sichtbar.filter((p) => (personen.get(p.id)?.lohnzeilen.length ?? 0) > 0).map((p) => p.id);
    const [ist, mitPlan] = await Promise.all([
      rechneMonate(admin, mitLohn, vorschau, { personen, firmensaetze }),
      rechneMonate(admin, mitLohn, vorschau, { personen, firmensaetze, zusatzStempel: plan }),
    ]);
    const bvgThresholdChf = firmensatzAm(firmensaetze, regelAuszahlungsdatum(jahr, monat, einst.auszahlungArbeitstag))?.bvgSchwelleMonat ?? null;
    const feiertage = feiertageBaselStadtJahre(jahr - 1, jahr + 1);

    const brutto = (r: RechenErgebnis | undefined) => (r?.ok ? r.ergebnis.brutto : null);
    const employees = sichtbar
      .map((p) => {
        const lp = personen.get(p.id) as LohnPerson | undefined;
        const r = ist.ergebnisse.get(p.id)?.get(monatKey(jahr, monat));
        const e = r?.ok ? r.ergebnis : null;
        const zeile = lp ? lohnzeileAm(lp.lohnzeilen, r0.end) ?? lohnzeileAm(lp.lohnzeilen, r0.start) : null;
        const pos = (art: string) => (e ? e.positionen.filter((x) => x.lohnart === art).reduce((s, x) => s + x.betrag, 0) : 0);
        const nacht = pos("nacht");
        const sonntag = pos("sonntag");
        const agPct = e ? Object.values(e.saetze.ag).reduce((s, v) => s + v, 0) : 0;
        const anPct = e ? e.abzuege.reduce((s, a) => s + a.prozent, 0) : 0;
        const vorschauChf = vorschau.map((m) => {
          const k = monatKey(m.jahr, m.monat);
          const i = brutto(ist.ergebnisse.get(p.id)?.get(k));
          const mp = brutto(mitPlan.ergebnisse.get(p.id)?.get(k));
          return i == null || mp == null ? 0 : mitPuffer(i, mp);
        });
        const naechteJahr = e ? e.mengen.naechteImJahrVorMonat + e.mengen.naechte.filter((n) => n.datum.startsWith(`${jahr}-`)).length : 0;
        const zeitzuschlagJahr = lp && e
          ? jahresEinsaetze(lp.stempel, lp.person.anstellungen, feiertage, jahr).naechte
              .filter((n) => !n.mitZuschlag && n.datum <= r0.end).reduce((sum, n) => sum + n.minuten * 0.1, 0)
          : 0;
        return {
          profile_id: p.id,
          full_name: p.full_name ?? "?",
          role: p.role,
          is_active: p.is_active === true,
          stempel_minutes: e ? e.mengen.minuten : lp ? minutenImMonat(lp.stempel, prefix) : 0,
          geplant_minutes: summeImMonat(info.geplant.get(p.id), prefix),
          rapport_minutes: summeImMonat(info.rapport.get(p.id), prefix),
          hourly_wage_chf: zeile && !zeile.ohneLohn ? zeile.stundenlohn : null,
          uses_standard_lohn: !zeile?.eigeneSaetze,
          employer_pct: agPct,
          employer_costs_chf_per_hour: zeile ? (zeile.stundenlohn * agPct) / 100 : null,
          effective_basis: "stempel" as const,
          base_lohnkosten_chf: e ? Number((e.brutto - nacht - sonntag).toFixed(2)) : null,
          lohnkosten_chf: e ? e.brutto : null,
          vollkosten_chf: e ? e.vollkosten : null,
          nettolohn_chf: e ? e.netto : null,
          total_deduction_pct: anPct,
          nbu_hinweis: e && e.saetze.an.nbu > 0 ? `NBU: ${e.nbu.begruendung}` : null,
          night_surcharge_chf: nacht,
          sunhol_surcharge_chf: sonntag,
          total_surcharge_chf: Number((nacht + sonntag).toFixed(2)),
          night_eligible_minutes: e?.mengen.nachtMinutenMitZuschlag ?? 0,
          sunhol_eligible_minutes: e?.mengen.sonntagMinutenMitZuschlag ?? 0,
          bvg_forecast_3_months_chf: vorschauChf,
          night_time_comp_minutes_this_month: e?.mengen.zeitzuschlagMinuten ?? 0,
          ytd_night_time_comp_minutes: zeitzuschlagJahr,
          night_shifts_over_limit_this_month: e ? e.mengen.naechte.filter((n) => !n.mitZuschlag).length : 0,
          ytd_night_shifts_total: naechteJahr,
          night_over_limit: (e?.mengen.naechteImJahrVorMonat ?? 0) >= 24,
          sunhol_over_limit: (e?.mengen.sonntageImJahrVorMonat ?? 0) >= 6,
          fehler: r && !r.ok ? r.fehler : null,
          hinweise: e ? e.hinweise.map((h) => h.text) : [],
        };
      })
      .sort((a, b) => Number(b.is_active) - Number(a.is_active) || a.full_name.localeCompare(b.full_name, "de-CH"));

    return NextResponse.json({
      success: true,
      month,
      employees,
      bvgThresholdChf,
      bvgForecastMonthLabels: vorschau.map((m) => monthRange(m.jahr, m.monat).label),
    });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
