// GET /api/hr/mein-lohn?jahr=YYYY — Seite «Lohn» (/lohn) der eingeloggten Person.
//
// Liefert NUR eigene Daten (echtes Konto). In «Ansicht als» keine Lohndaten der
// angesehenen Person (wie /api/hr/wage-documents): { ansicht_als: true }.
//
// Antwort:
//   { jahr, jahre: [neueste zuerst], heute_monat: "YYYY-MM",
//     monate: [{ monat: 1–12, minuten, laufend, abrechnung: Dokument | null }]  (neueste zuerst),
//     lohnausweis: Dokument | null,
//     wahl: { wahl, version, gewaehlt_at, quelle } | null, version_aktuell }
//   Dokument = { id, erhalten_at, neu }  — neu = bereitgestellt, aber noch nie selbst geöffnet.
//
// Monate: vom ersten Monat mit Daten (Stempel oder Lohndokument; im Jahr davor → Januar)
// bis zum aktuellen Monat (vergangene Jahre: Dezember). Stunden: gleiche Regel wie
// der Rechenkern und Trust flow (src/lib/lohn/stunden.ts). Keine Beträge.

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ladeAlleSeiten } from "@/lib/lohn/daten";
import { lokalesDatum } from "@/lib/lohn/kern";
import { jahrAbfrageGrenzen, minutenJeMonat } from "@/lib/lohn/stunden";
import { DIGITAL_EINWILLIGUNG_VERSION, ladeAktuelleWahl } from "@/lib/lohn/zustellung";

export const dynamic = "force-dynamic";

const fehler = (e: unknown, status = 500) =>
  NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status });

interface DocZeile {
  id: string;
  doc_type: "lohnabrechnung" | "lohnausweis";
  year: number;
  period_month: number | null;
  uploaded_at: string;
}

export async function GET(req: Request) {
  const auth = await requireUser({ wartung: "lohn" });
  if (auth.error) return auth.error;
  if (auth.isImpersonating) {
    return NextResponse.json({ success: true, ansicht_als: true }, { headers: { "Cache-Control": "no-store" } });
  }
  const ich = auth.user.id;
  const heute = lokalesDatum(Date.now());
  const heuteJahr = Number(heute.slice(0, 4));
  const heuteMonat = Number(heute.slice(5, 7));
  const roh = new URL(req.url).searchParams.get("jahr");
  const jahr = roh && /^\d{4}$/.test(roh) ? Number(roh) : heuteJahr;
  if (jahr < 2020 || jahr > heuteJahr) return fehler("Jahr ungültig", 400);

  const admin = createAdminClient();
  try {
    const g = jahrAbfrageGrenzen(jahr);
    const [stempel, docs, ersterStempel, ersteDoks, wahl] = await Promise.all([
      ladeAlleSeiten<{ clock_in: string; clock_out: string | null }>(
        (a, b) => admin.from("time_entries").select("clock_in, clock_out").eq("user_id", ich)
          .gte("clock_in", g.von).lt("clock_in", g.bis).order("id").range(a, b),
        "Stempelzeiten",
      ),
      admin.from("wage_documents").select("id, doc_type, year, period_month, uploaded_at")
        .eq("profile_id", ich).eq("year", jahr).is("archived_at", null).is("superseded_at", null),
      admin.from("time_entries").select("clock_in").eq("user_id", ich).order("clock_in", { ascending: true }).limit(1).maybeSingle(),
      admin.from("wage_documents").select("year, period_month").eq("profile_id", ich).is("archived_at", null).is("superseded_at", null)
        .order("year", { ascending: true }).order("period_month", { ascending: true, nullsFirst: false }).limit(1).maybeSingle(),
      ladeAktuelleWahl(admin, ich),
    ]);
    const err = docs.error ?? ersterStempel.error ?? ersteDoks.error;
    if (err) throw new Error(`Lohn konnte nicht geladen werden: ${err.message}`);
    const dokumente = (docs.data ?? []) as DocZeile[];

    // Zustellnachweis (bereitgestellt / geöffnet) der Dokumente dieses Jahres.
    const ids = dokumente.map((d) => d.id);
    const zustellung = new Map<string, { bereitgestellt_at: string | null; erstmals_geoeffnet_at: string | null }>();
    if (ids.length > 0) {
      const { data: z, error: zErr } = await admin.from("lohn_dokument_zustellung")
        .select("wage_document_id, bereitgestellt_at, erstmals_geoeffnet_at").in("wage_document_id", ids);
      if (zErr) throw new Error(`Zustellung konnte nicht geladen werden: ${zErr.message}`);
      for (const r of z ?? []) zustellung.set(r.wage_document_id as string, r as { bereitgestellt_at: string | null; erstmals_geoeffnet_at: string | null });
    }
    const alsDokument = (d: DocZeile) => {
      const z = zustellung.get(d.id);
      return { id: d.id, erhalten_at: z?.bereitgestellt_at ?? d.uploaded_at, neu: !!z && !z.erstmals_geoeffnet_at };
    };

    // Erster Monat mit Daten (Stempel oder Lohndokument) — bestimmt Jahresauswahl und Beginn der Liste.
    const kandidaten: string[] = [];
    if (ersterStempel.data?.clock_in) kandidaten.push(lokalesDatum(new Date(ersterStempel.data.clock_in as string).getTime()).slice(0, 7));
    if (ersteDoks.data) {
      const d = ersteDoks.data as { year: number; period_month: number | null };
      kandidaten.push(`${d.year}-${String(d.period_month ?? 12).padStart(2, "0")}`);
    }
    const erster = kandidaten.sort()[0] ?? null;
    const ersterJahr = erster ? Math.min(Number(erster.slice(0, 4)), heuteJahr) : heuteJahr;
    const jahre: number[] = [];
    for (let j = heuteJahr; j >= Math.max(2020, ersterJahr); j--) jahre.push(j);

    const bis = jahr === heuteJahr ? heuteMonat : 12;
    let von: number;
    if (!erster || Number(erster.slice(0, 4)) > jahr) von = jahr === heuteJahr ? heuteMonat : 13; // keine Daten: nur der laufende Monat
    else if (Number(erster.slice(0, 4)) < jahr) von = 1;
    else von = Math.min(Number(erster.slice(5, 7)), bis);

    const minuten = minutenJeMonat(stempel.map((s) => ({ start: s.clock_in, ende: s.clock_out })));
    const monate = [];
    for (let m = bis; m >= von; m--) {
      const doc = dokumente.find((d) => d.doc_type === "lohnabrechnung" && d.period_month === m);
      monate.push({
        monat: m,
        minuten: minuten.get(`${jahr}-${String(m).padStart(2, "0")}`) ?? 0,
        laufend: jahr === heuteJahr && m === heuteMonat,
        abrechnung: doc ? alsDokument(doc) : null,
      });
    }
    const ausweis = dokumente.find((d) => d.doc_type === "lohnausweis");

    return NextResponse.json(
      {
        success: true,
        jahr,
        jahre,
        heute_monat: heute.slice(0, 7),
        monate,
        lohnausweis: ausweis ? alsDokument(ausweis) : null,
        wahl: wahl ? { wahl: wahl.wahl, version: wahl.version, gewaehlt_at: wahl.gewaehlt_at, quelle: wahl.quelle } : null,
        version_aktuell: DIGITAL_EINWILLIGUNG_VERSION,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return fehler(e);
  }
}
