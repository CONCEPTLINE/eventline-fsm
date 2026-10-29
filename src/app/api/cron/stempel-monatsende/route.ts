// Cron: Erinnerung vor der Monatssperre (Lohn-Umbau Phase 4, vercel.json:
// täglich am 1.–4. morgens Zürich).
//
// Am 5. des Monats wird der Vormonat gesperrt und abgerechnet. Ein offener
// Stempel (kein Ende) zählt in der Abrechnung nicht — der Lohnlauf blockiert
// dann den Monat (src/lib/lohn/lauf.ts). Darum vorher:
//   - 1.–4.: JEDE Person mit offenen Stempeln, die im Vormonat begonnen haben
//     (Ortszeit Zürich), bekommt eine Erinnerung im Klartext («bis 4.
//     ausstempeln, am 5. wird der Monat abgeschlossen») — Typ stempel_reminder
//     über den Benachrichtigungsdienst (In-App/Push/Mail je Kanal-Einstellung).
//   - 3./4.: zusätzlich eine Übersicht an die Lohnverwaltung (alle mit
//     Lohnrecht): offene + ungeprüfte lange Stempel des Vormonats, ohne Beträge.
// Idempotent je Tag: wer heute (Zürich) schon erinnert wurde, bekommt bei einer
// Cron-Wiederholung nichts mehr (Nachweis = Meldung mit resource_type
// «stempel_monatsende» bzw. «…_uebersicht» seit Mitternacht; nie gebündelt).
// Grenze: Wer die In-App-Meldung dieses Typs abgeschaltet hat, hinterlässt
// keinen Nachweis — eine Wiederholung am selben Tag kann Push/Mail doppeln.
//
// Wartung «Lohn» (Migration 363): nichts versenden (wie der Lohnlauf).
// SYSTEMWEG: nur mit CRON_SECRET (zeitsicher verglichen), kein Benutzer.
// ?heute=YYYY-MM-DD nur ausserhalb der Produktion (Prüfskript).

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { istCronAufruf } from "@/lib/geheimnis";
import { ladeWartungStreng } from "@/lib/wartung-server";
import { logError } from "@/lib/log";
import { localDateIso, localTimeHM, todayLocalIso } from "@/lib/swiss-time";
import { PORTAL_ROLLEN_IN } from "@/lib/roles";
import { recipientsWithPermission } from "@/lib/notification-recipients";
import {
  STEMPEL_MONATSENDE_PERSON,
  STEMPEL_MONATSENDE_UEBERSICHT,
  notifyStempelMonatsende,
  notifyStempelMonatsendeUebersicht,
} from "@/lib/notification-service";
import { ladeAlleSeiten } from "@/lib/lohn/daten";
import { monatLabel, monatSchluessel, type LohnMonat } from "@/lib/lohn/monate";
import { ladeStempelProbleme, stempelProblemText } from "@/lib/lohn/stempel-pruefung";
import { LOHN_RECHT } from "@/lib/lohn/zugriff";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MONATSNAMEN = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

/** Mitternacht (Zürich) des Tages als ISO-Zeitpunkt. */
function zuerichMitternacht(tag: string): string {
  const [y, m, d] = tag.split("-").map(Number);
  for (const stunden of [1, 2, 0]) {
    const t = new Date(Date.UTC(y, m - 1, d) - stunden * 3600_000);
    if (localDateIso(t) === tag && localTimeHM(t) === "00:00") return t.toISOString();
  }
  return new Date(Date.UTC(y, m - 1, d) - 3600_000).toISOString();
}

const lokalerMonat = (iso: string) => localDateIso(new Date(iso)).slice(0, 7);

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: "CRON_SECRET fehlt in der Server-Config" }, { status: 503 });
  }
  if (!istCronAufruf(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const param = new URL(request.url).searchParams.get("heute");
  const heute = param && process.env.NODE_ENV !== "production" && /^\d{4}-\d{2}-\d{2}$/.test(param) ? param : todayLocalIso();
  const [jahr, monat, tag] = heute.split("-").map(Number);
  if (tag < 1 || tag > 4) return NextResponse.json({ status: "nicht_faellig", heute });

  let wartung;
  try {
    wartung = await ladeWartungStreng();
  } catch (e) {
    logError("cron.stempel-monatsende.wartung", e);
    return NextResponse.json({ status: "fehler", meldung: "Wartungsstand nicht lesbar — nichts versendet" }, { status: 500 });
  }
  if (wartung.bereiche.includes("lohn")) return NextResponse.json({ status: "pausiert", heute, meldung: "Lohn in Wartung — keine Erinnerungen" });

  const vm: LohnMonat = monat === 1 ? { jahr: jahr - 1, monat: 12 } : { jahr, monat: monat - 1 };
  const vmKey = monatSchluessel(vm);
  const label = monatLabel(vm);
  const fristText = `4. ${MONATSNAMEN[monat - 1]}`;
  const sperreText = `5. ${MONATSNAMEN[monat - 1]}`;
  // «Heute schon erinnert» zählt ab Mitternacht des ECHTEN Tages (auch wenn das Prüfskript ?heute= setzt).
  const seit = zuerichMitternacht(todayLocalIso());
  const admin = createAdminClient();

  try {
    // --- 1. Personen mit offenen Stempeln des Vormonats -----------------------
    const von = new Date(Date.UTC(vm.jahr, vm.monat - 1, 1) - 24 * 3600_000).toISOString();
    const bis = new Date(Date.UTC(vm.jahr, vm.monat, 1) + 24 * 3600_000).toISOString();
    const offene = (await ladeAlleSeiten<{ id: string; user_id: string | null; clock_in: string }>(
      (a, b) => admin.from("time_entries").select("id, user_id, clock_in").is("clock_out", null)
        .gte("clock_in", von).lt("clock_in", bis).order("clock_in").order("id").range(a, b),
      "Offene Stempel",
    )).filter((t) => t.user_id && lokalerMonat(t.clock_in) === vmKey);

    const jePerson = new Map<string, { id: string; clock_in: string }[]>();
    for (const t of offene) jePerson.set(t.user_id!, [...(jePerson.get(t.user_id!) ?? []), t]);
    const personIds = [...jePerson.keys()];

    let erinnert = 0;
    let schonHeute = 0;
    if (personIds.length > 0) {
      const [aktiv, schon] = await Promise.all([
        ladeAlleSeiten<{ id: string }>(
          (a, b) => admin.from("profiles").select("id").in("id", personIds).eq("is_active", true).order("id").range(a, b),
          "Profile",
        ),
        ladeAlleSeiten<{ user_id: string }>(
          (a, b) => admin.from("notifications").select("user_id").eq("type", "stempel_reminder").eq("resource_type", STEMPEL_MONATSENDE_PERSON)
            .in("user_id", personIds).gte("created_at", seit).order("id").range(a, b),
          "Erinnerungen von heute",
        ),
      ]);
      const aktivSet = new Set(aktiv.map((p) => p.id));
      const schonSet = new Set(schon.map((n) => n.user_id));
      for (const id of personIds) {
        if (!aktivSet.has(id)) continue;
        if (schonSet.has(id)) { schonHeute++; continue; }
        const stempel = jePerson.get(id)!;
        await notifyStempelMonatsende(admin, {
          userId: id,
          entryId: stempel[0].id,
          beginne: stempel.map((s) => s.clock_in),
          monatLabel: label,
          fristText,
          sperreText,
        });
        erinnert++;
      }
    }

    // --- 2. Am 3./4.: Übersicht an die Lohnverwaltung ---------------------------
    let uebersicht = 0;
    let uebersichtSchon = 0;
    if (tag >= 3) {
      const profile = await ladeAlleSeiten<{ id: string; full_name: string | null }>(
        (a, b) => admin.from("profiles").select("id, full_name").not("role", "in", PORTAL_ROLLEN_IN).order("id").range(a, b),
        "Profile",
      );
      const probleme = await ladeStempelProbleme(admin, profile.map((p) => p.id), vm.jahr, vm.monat);
      if (probleme.size > 0) {
        const name = new Map(profile.map((p) => [p.id, p.full_name ?? "?"]));
        const alle = [...probleme.entries()].sort((a, b) => (name.get(a[0]) ?? "").localeCompare(name.get(b[0]) ?? "", "de-CH"));
        const zeilen = alle.map(([id, p]) => `${name.get(id)}: ${stempelProblemText(p).replace(/^Stempel prüfen: /, "")}`);
        const offen = alle.reduce((n, [, p]) => n + p.filter((x) => x.art === "offen").length, 0);
        const lang = alle.reduce((n, [, p]) => n + p.filter((x) => x.art === "lang").length, 0);
        const empfaenger = await recipientsWithPermission(admin, LOHN_RECHT);
        const schon = empfaenger.length === 0 ? [] : await ladeAlleSeiten<{ user_id: string }>(
          (a, b) => admin.from("notifications").select("user_id").eq("type", "stempel_reminder").eq("resource_type", STEMPEL_MONATSENDE_UEBERSICHT)
            .in("user_id", empfaenger).gte("created_at", seit).order("id").range(a, b),
          "Übersichten von heute",
        );
        const schonSet = new Set(schon.map((n) => n.user_id));
        const neu = empfaenger.filter((id) => !schonSet.has(id));
        uebersichtSchon = empfaenger.length - neu.length;
        if (neu.length > 0) {
          await notifyStempelMonatsendeUebersicht(admin, { recipients: neu, monatLabel: label, monat: vmKey, sperreText, offen, lang, zeilen });
          uebersicht = neu.length;
        }
      }
    }

    return NextResponse.json({
      status: "ok",
      heute,
      monat: vmKey,
      offene_stempel: offene.length,
      erinnert,
      schon_heute: schonHeute,
      uebersicht,
      uebersicht_schon_heute: uebersichtSchon,
    });
  } catch (e) {
    logError("cron.stempel-monatsende", e);
    return NextResponse.json({ status: "fehler", meldung: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
