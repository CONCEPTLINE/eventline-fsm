// GET /api/bildschirm/vertrieb — zweite Ansicht des Buero-Bildschirms
// (Leo 2026-10-30): Stand der Vertriebs-Kampagnen, wechselt alle 2 Minuten
// mit dem Firmen-Dashboard. Zugang wie /api/bildschirm/daten nur ueber das
// Bildschirm-Cookie, rein lesend. Bewusst nur Zaehler, Firmennamen und
// Zeitpunkte — keine Mailadressen, Ansprechpersonen, Betreffs, Mailtexte
// oder Betraege (der Monitor ist fuer alle im Buero sichtbar).

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { bildschirmSession } from "@/lib/bildschirm";
import { todayLocalIso, localDateIso, plusTage } from "@/lib/swiss-time";
import { NACHFASS_MAX, NACHFASS_TAGE } from "@/lib/vertrieb/nachfassen";
import type {
  BildschirmVertrieb, BildschirmKampagne, BildschirmVertriebWoche, BildschirmAntwort, VertriebStatus,
} from "@/lib/bildschirm-typen";

export const dynamic = "force-dynamic";

/** Wochen im Diagramm: 7 vergangene, die laufende, die naechste (geplant). */
const WOCHEN_ZURUECK = 7;
const WOCHEN_VOR = 1;
const ANTWORTEN_LISTE = 12;
const IM_GESPRAECH: VertriebStatus[] = ["geantwortet", "termin", "offerte", "auftrag", "anrufen"];

type KontaktRow = {
  id: string;
  kampagne_id: string;
  firma: string;
  status: VertriebStatus;
  mail_geplant_am: string | null;
  mail_gesendet_am: string | null;
  letzte_antwort_am: string | null;
  antworten_anzahl: number;
  nachfass_anzahl: number;
  nachgefasst_am: string | null;
};

/** ISO-Kalenderwoche eines YYYY-MM-DD (wie /api/bildschirm/daten). */
function isoWoche(iso: string): number {
  const d = new Date(`${iso}T00:00:00Z`);
  const tag = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - tag + 3);
  const ersterDo = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  ersterDo.setUTCDate(ersterDo.getUTCDate() - ((ersterDo.getUTCDay() + 6) % 7) + 3);
  return 1 + Math.round((d.getTime() - ersterDo.getTime()) / (7 * 86400000));
}

export async function GET(req: NextRequest) {
  const session = await bildschirmSession(req);
  if (!session) {
    return NextResponse.json({ success: false, error: "Bildschirm nicht verbunden" }, { status: 401 });
  }
  const admin = createAdminClient();
  const heute = todayLocalIso();
  const jetzt = Date.now();

  try {
    const { data: kampRows, error: kampErr } = await admin
      .from("vertrieb_kampagnen")
      .select("id, name, sortierung, created_at")
      .eq("aktiv", true)
      .order("sortierung")
      .order("created_at");
    if (kampErr) throw new Error(kampErr.message);
    const kampIds = (kampRows ?? []).map((k) => k.id as string);

    // Alle Kontakte aktiver Kampagnen — per Keyset (id), nie per Offset:
    // Offset-Seiten ueberlappen bei gleichzeitigen Updates des Abgleichs.
    const kontakte: KontaktRow[] = [];
    if (kampIds.length > 0) {
      let nach: string | null = null;
      for (;;) {
        let q = admin
          .from("vertrieb_kampagne_kontakte")
          .select("id, kampagne_id, firma, status, mail_geplant_am, mail_gesendet_am, letzte_antwort_am, antworten_anzahl, nachfass_anzahl, nachgefasst_am")
          .in("kampagne_id", kampIds)
          .order("id")
          .limit(1000);
        if (nach) q = q.gt("id", nach);
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        const seite = (data ?? []) as KontaktRow[];
        kontakte.push(...seite);
        if (seite.length < 1000) break;
        nach = seite[seite.length - 1].id;
      }
    }

    const kampName = new Map((kampRows ?? []).map((k) => [k.id as string, k.name as string]));
    const kampagnen = new Map<string, BildschirmKampagne>(
      (kampRows ?? []).map((k) => [k.id as string, {
        id: k.id as string, name: k.name as string, kontakte: 0, geplant: 0, angeschrieben: 0,
        antworten: 0, im_gespraech: 0, kein_bedarf: 0, unzustellbar: 0,
      }]),
    );

    // Wochenraster: Montag der laufenden Woche als Anker.
    const wt = (new Date(`${heute}T12:00:00Z`).getUTCDay() + 6) % 7;
    const montag = plusTage(heute, -wt);
    const wochen: BildschirmVertriebWoche[] = [];
    for (let i = -WOCHEN_ZURUECK; i <= WOCHEN_VOR; i++) {
      const start = plusTage(montag, i * 7);
      wochen.push({ kw: isoWoche(start), start, ende: plusTage(start, 6), gesendet: 0, antworten: 0, geplant: 0 });
    }
    const woche = (iso: string | null) => {
      if (!iso) return null;
      const tag = localDateIso(new Date(iso));
      return wochen.find((w) => tag >= w.start && tag <= w.ende) ?? null;
    };

    const pipeline = { geplant: 0, angeschrieben: 0, antworten: 0, termin: 0, offerte: 0, auftrag: 0 };
    const achtung = { antworten_offen: 0, anrufen: 0, nachfassen: 0, unzustellbar: 0, geplant: 0, geplant_ab: null as string | null };
    const nachfassGrenze = jetzt - NACHFASS_TAGE * 86400000;

    for (const k of kontakte) {
      const kamp = kampagnen.get(k.kampagne_id);
      if (!kamp) continue;
      kamp.kontakte++;
      const gesendet = !!k.mail_gesendet_am;
      const hatAntwort = k.antworten_anzahl > 0 || !!k.letzte_antwort_am;
      if (k.status === "geplant") {
        kamp.geplant++;
        pipeline.geplant++;
        achtung.geplant++;
        if (k.mail_geplant_am && (!achtung.geplant_ab || k.mail_geplant_am < achtung.geplant_ab)) achtung.geplant_ab = k.mail_geplant_am;
        const w = woche(k.mail_geplant_am);
        if (w) w.geplant++;
      }
      if (gesendet) {
        kamp.angeschrieben++;
        pipeline.angeschrieben++;
        const w = woche(k.mail_gesendet_am);
        if (w) w.gesendet++;
      }
      if (hatAntwort) {
        kamp.antworten++;
        pipeline.antworten++;
        const w = woche(k.letzte_antwort_am);
        if (w) w.antworten++;
      }
      if (IM_GESPRAECH.includes(k.status)) kamp.im_gespraech++;
      if (k.status === "kein_bedarf") kamp.kein_bedarf++;
      if (k.status === "unzustellbar") { kamp.unzustellbar++; achtung.unzustellbar++; }
      if (k.status === "termin") pipeline.termin++;
      if (k.status === "offerte") pipeline.offerte++;
      if (k.status === "auftrag") pipeline.auftrag++;
      if (k.status === "geantwortet") achtung.antworten_offen++;
      if (k.status === "anrufen") achtung.anrufen++;
      // Gleiche Regel wie vertrieb_kampagne_uebersicht (Migration 366).
      const letzte = k.nachgefasst_am ?? k.mail_gesendet_am;
      if (k.status === "gesendet" && k.antworten_anzahl === 0 && k.nachfass_anzahl < NACHFASS_MAX
          && letzte && new Date(letzte).getTime() < nachfassGrenze) achtung.nachfassen++;
    }

    const antworten: BildschirmAntwort[] = kontakte
      .filter((k) => k.letzte_antwort_am && kampagnen.has(k.kampagne_id))
      .sort((a, b) => (b.letzte_antwort_am! < a.letzte_antwort_am! ? -1 : 1))
      .slice(0, ANTWORTEN_LISTE)
      .map((k) => ({
        id: k.id,
        firma: k.firma,
        kampagne: kampName.get(k.kampagne_id) ?? "",
        status: k.status,
        zeit: new Date(k.letzte_antwort_am!).toISOString(),
      }));

    const body: BildschirmVertrieb = {
      success: true,
      jetzt: new Date().toISOString(),
      pipeline,
      kampagnen: [...kampagnen.values()].filter((k) => k.kontakte > 0),
      wochen,
      antworten,
      achtung,
    };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unbekannter Fehler";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
