// GET /api/bildschirm/vertrieb — zweite Ansicht des Buero-Bildschirms
// (Leo 2026-10-30): Vertrieb im gleichen Aufbau wie das Firmen-Dashboard —
// offene Gespraeche (Agenda), Kampagnen, Zuletzt im Vertrieb, Als Naechstes,
// Aufmerksamkeit. Zugang wie /api/bildschirm/daten nur ueber das
// Bildschirm-Cookie, rein lesend. Bewusst nur Firmennamen, Ort, Status,
// Zaehler und Zeitpunkte — keine Mailadressen, Ansprechpersonen, Betreffs,
// Mailtexte oder Betraege (der Monitor ist fuer alle im Buero sichtbar).

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { bildschirmSession } from "@/lib/bildschirm";
import { localDateIso, plusTage, todayLocalIso } from "@/lib/swiss-time";
import { zurichMidnightIso } from "@/lib/dashboard-admin-data";
import { NACHFASS_MAX, NACHFASS_TAGE } from "@/lib/vertrieb/nachfassen";
import type {
  BildschirmVertrieb, BildschirmKampagne, BildschirmGespraech, BildschirmVertriebEreignis,
  BildschirmVertriebSchritt, VertriebStatus,
} from "@/lib/bildschirm-typen";

export const dynamic = "force-dynamic";

const GESPRAECH_STATUS = ["geantwortet", "anrufen", "termin", "offerte"] as const;
const GESPRAECHE_LIMIT = 60;
/** «Zuletzt im Vertrieb»: Auswahl aus 30 Zurich-Tagen, Liste so lang. */
const ZULETZT_LISTE = 12;
/** «Als Naechstes»: so weit voraus. */
const NAECHSTES_TAGE = 21;
const TAG_MS = 86_400_000;

type KontaktRow = {
  id: string;
  kampagne_id: string;
  firma: string;
  ort: string | null;
  status: VertriebStatus;
  mail_geplant_am: string | null;
  mail_gesendet_am: string | null;
  letzte_antwort_am: string | null;
  antworten_anzahl: number;
  nachfass_anzahl: number;
  nachgefasst_am: string | null;
  updated_at: string;
};

export async function GET(req: NextRequest) {
  const session = await bildschirmSession(req);
  if (!session) {
    return NextResponse.json({ success: false, error: "Bildschirm nicht verbunden" }, { status: 401 });
  }
  const admin = createAdminClient();
  const heute = todayLocalIso();
  const seit7 = new Date(zurichMidnightIso(plusTage(heute, -6))).toISOString();
  const seit30 = new Date(zurichMidnightIso(plusTage(heute, -29))).toISOString();
  const bis = plusTage(heute, NAECHSTES_TAGE);

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
          .select("id, kampagne_id, firma, ort, status, mail_geplant_am, mail_gesendet_am, letzte_antwort_am, antworten_anzahl, nachfass_anzahl, nachgefasst_am, updated_at")
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
        id: k.id as string, name: k.name as string, kontakte: 0, geplant: 0, angeschrieben: 0, antworten: 0,
      }]),
    );
    const achtung = { antworten_offen: 0, anrufen: 0, nachfassen: 0, unzustellbar: 0 };
    const gespraeche: BildschirmGespraech[] = [];
    const antworten: BildschirmVertriebEreignis[] = [];
    // Versand bzw. Nachfassen je Zurich-Tag und Kampagne.
    const versendet = new Map<string, { tag: string; kamp: string; zeit: string; n: number }>();
    const schritte = new Map<string, BildschirmVertriebSchritt>();
    const schritt = (art: "versand" | "nachfassen", tag: string, kamp: string, zeit: string | null) => {
      const key = `${art}:${kamp}:${tag}`;
      const s = schritte.get(key) ?? { id: key, art, tag, zeit, anzahl: 0, kampagne: kampName.get(kamp) ?? "" };
      s.anzahl++;
      if (zeit && (!s.zeit || zeit < s.zeit)) s.zeit = zeit;
      schritte.set(key, s);
    };

    for (const k of kontakte) {
      const kamp = kampagnen.get(k.kampagne_id);
      if (!kamp) continue;
      kamp.kontakte++;
      if (k.status === "geplant") {
        kamp.geplant++;
        if (k.mail_geplant_am) {
          const tag = localDateIso(new Date(k.mail_geplant_am));
          if (tag <= bis) schritt("versand", tag < heute ? heute : tag, k.kampagne_id, new Date(k.mail_geplant_am).toISOString());
        }
      }
      if (k.mail_gesendet_am) {
        kamp.angeschrieben++;
        if (k.mail_gesendet_am >= seit30) {
          const tag = localDateIso(new Date(k.mail_gesendet_am));
          const key = `${k.kampagne_id}:${tag}`;
          const zeit = new Date(k.mail_gesendet_am).toISOString();
          const v = versendet.get(key) ?? { tag, kamp: k.kampagne_id, zeit, n: 0 };
          v.n++;
          if (zeit > v.zeit) v.zeit = zeit;
          versendet.set(key, v);
        }
      }
      if (k.antworten_anzahl > 0 || k.letzte_antwort_am) kamp.antworten++;
      if (k.letzte_antwort_am && k.letzte_antwort_am >= seit30) {
        const zeit = new Date(k.letzte_antwort_am).toISOString();
        antworten.push({
          id: `antwort:${k.id}`,
          art: k.status === "kein_bedarf" ? "kein_bedarf" : k.status === "unzustellbar" ? "unzustellbar" : "antwort",
          zeit, tag: localDateIso(new Date(zeit)), titel: k.firma, kampagne: kamp.name,
        });
      }
      if ((GESPRAECH_STATUS as readonly string[]).includes(k.status)) {
        gespraeche.push({
          id: k.id, firma: k.firma, kampagne: kamp.name, ort: k.ort?.trim() || null,
          status: k.status as BildschirmGespraech["status"],
          seit: new Date(k.letzte_antwort_am ?? k.updated_at).toISOString(),
        });
      }
      if (k.status === "geantwortet") achtung.antworten_offen++;
      if (k.status === "anrufen") achtung.anrufen++;
      if (k.status === "unzustellbar") achtung.unzustellbar++;
      // Gleiche Regel wie vertrieb_kampagne_uebersicht (Migration 366).
      const letzte = k.nachgefasst_am ?? k.mail_gesendet_am;
      if (k.status === "gesendet" && k.antworten_anzahl === 0 && k.nachfass_anzahl < NACHFASS_MAX && letzte) {
        const faellig = localDateIso(new Date(new Date(letzte).getTime() + NACHFASS_TAGE * TAG_MS));
        if (faellig <= heute) achtung.nachfassen++;
        if (faellig <= bis) schritt("nachfassen", faellig < heute ? heute : faellig, k.kampagne_id, null);
      }
    }

    // Offene Gespraeche: Status-Reihenfolge, darin die aeltesten zuerst
    // (wer am laengsten wartet, steht oben).
    const rang = (s: string) => GESPRAECH_STATUS.indexOf(s as (typeof GESPRAECH_STATUS)[number]);
    gespraeche.sort((a, b) => rang(a.status) - rang(b.status) || (a.seit < b.seit ? -1 : a.seit > b.seit ? 1 : 0));

    const ereignisse: BildschirmVertriebEreignis[] = [
      ...antworten,
      ...[...versendet.values()].map((v) => ({
        id: `versand:${v.kamp}:${v.tag}`, art: "versand" as const, zeit: v.zeit, tag: v.tag,
        titel: `${v.n} ${v.n === 1 ? "Mail" : "Mails"}`, kampagne: kampName.get(v.kamp) ?? "",
      })),
    ].sort((a, b) => (a.zeit < b.zeit ? 1 : a.zeit > b.zeit ? -1 : 0));

    const body: BildschirmVertrieb = {
      success: true,
      jetzt: new Date().toISOString(),
      gespraeche: gespraeche.slice(0, GESPRAECHE_LIMIT),
      kampagnen: [...kampagnen.values()].filter((k) => k.kontakte > 0),
      zuletzt: {
        anzahl_7_tage: ereignisse.filter((e) => e.zeit >= seit7).length,
        seit_7_tage: seit7,
        liste: ereignisse.slice(0, ZULETZT_LISTE),
      },
      naechstes: [...schritte.values()].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : a.art === "versand" ? -1 : 1)),
      achtung,
    };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unbekannter Fehler";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
