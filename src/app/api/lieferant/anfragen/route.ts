// GET /api/lieferant/anfragen?zeit=aktuell|vergangen&q=… — Technik-Anfragen
// des eingeloggten Lieferanten (Portal). Admin-Client mit strikter
// Whitelist: Titel/Nummer/Datum/Ort/Gaeste/Status + Technik-Zaehler — nie
// Preise, Stunden oder Dokumente. Sichtbar erst nach der ersten Anfrage.
// Filter, Suche und Sortierung (Eventdatum) laufen in der DB; ein Fehler
// ist ein Fehler, nie eine leere Liste.
//
// Stand je Anfrage (aus Sicht des Lieferanten):
//   storniert / abgeschlossen — Auftrag geschlossen
//   geaendert   — EVENTLINE hat seit dem Bezug (vorherige Anfrage-Runde,
//                 sonst die erste Anfrage) Positionen neu angelegt, geaendert
//                 oder entfernt, und der Lieferant hat danach noch nicht reagiert
//   beantwortet — der Lieferant hat seit der letzten Anfrage reagiert
//   neu         — noch keine Reaktion auf die letzte Anfrage

import { NextRequest, NextResponse } from "next/server";
import { requireLieferantPortal, technikGesperrt, lieferantPortalUserIds, zuerichHeuteBeginnIso } from "@/lib/technik-server";
import { aenderungsBasis, type AnfrageStatus } from "@/lib/technik";
import { logError } from "@/lib/log";

type Ein<T> = T | T[] | null;
const eins = <T,>(v: Ein<T> | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

interface JobZeile {
  id: string;
  title: string;
  job_number: number | null;
  status: string;
  start_date: string | null;
  end_date: string | null;
  guest_count: number | null;
  event_type: string | null;
  external_address: string | null;
  location: Ein<{ name: string | null; address_city: string | null }>;
  room: Ein<{ name: string | null; address_city: string | null }>;
  zuweisung: Ein<{ angefragt_at: string; vorige_angefragt_at: string | null; anfrage_runden: number | null; lieferant_id: string }>;
}

const INT4_MAX = 2147483647;

export async function GET(req: NextRequest) {
  const gate = await requireLieferantPortal();
  if (gate.error) return gate.error;
  const { admin, lieferantId } = gate;

  const zeit = req.nextUrl.searchParams.get("zeit") === "vergangen" ? "vergangen" : "aktuell";
  // Suche: nur Buchstaben/Ziffern/Leer/.-' — sonst bricht die Filter-Syntax.
  const suche = (req.nextUrl.searchParams.get("q") ?? "").replace(/[^\p{L}\p{N}\s.\-']/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);

  try {
    const heute = zuerichHeuteBeginnIso();
    let q = admin
      .from("jobs")
      .select(
        "id, title, job_number, status, start_date, end_date, guest_count, event_type, external_address, " +
        "location:locations(name, address_city), room:rooms(name, address_city), " +
        "zuweisung:job_lieferanten!inner(angefragt_at, vorige_angefragt_at, anfrage_runden, lieferant_id)",
      )
      .eq("zuweisung.lieferant_id", lieferantId)
      .not("zuweisung.angefragt_at", "is", null)
      .eq("is_deleted", false);
    // Vergangen = Event vorbei (Ende, sonst Beginn, vor heute in Zuerich).
    q = zeit === "vergangen"
      ? q.or(`end_date.lt."${heute}",and(end_date.is.null,start_date.lt."${heute}")`)
      : q.or(`end_date.gte."${heute}",and(end_date.is.null,start_date.gte."${heute}"),and(end_date.is.null,start_date.is.null)`);
    if (suche) {
      const nummer = /^\d+$/.test(suche) && Number(suche) <= INT4_MAX ? Number(suche) : null;
      q = nummer !== null
        ? q.or(`title.ilike."*${suche}*",job_number.eq.${nummer}`)
        : q.ilike("title", `%${suche}%`);
    }
    const { data, error } = await q
      .order("start_date", { ascending: zeit === "aktuell", nullsFirst: false })
      .limit(200);
    if (error) throw error;
    const jobs = (data ?? []) as unknown as JobZeile[];

    const ids = jobs.map((j) => j.id);
    const portalUser = await lieferantPortalUserIds(admin, lieferantId);
    const [posRes, revRes, aktRes] = ids.length
      ? await Promise.all([
          admin.from("job_technik_positionen").select("job_id, status, created_at, inhalt_geaendert_at").in("job_id", ids),
          admin.from("job_technik_reviews").select("job_id").in("job_id", ids).eq("status", "offen"),
          admin
            .from("job_technik_aktivitaet")
            .select("job_id, actor_id, aktion, created_at")
            .in("job_id", ids)
            .or(portalUser.length
              ? `actor_id.in.(${portalUser.join(",")}),aktion.in.(position_geloescht,ki_entfernt)`
              : "aktion.in.(position_geloescht,ki_entfernt)"),
        ])
      : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }];
    for (const r of [posRes, revRes, aktRes]) if (r.error) throw r.error;

    const positionen = (posRes.data ?? []) as { job_id: string; status: string; created_at: string; inhalt_geaendert_at: string | null }[];
    const offeneReviews = (revRes.data ?? []) as { job_id: string }[];
    const aktivitaet = (aktRes.data ?? []) as { job_id: string; actor_id: string | null; aktion: string; created_at: string }[];
    const portalSet = new Set(portalUser);

    const anfragen = jobs.map((j) => {
      const z = eins(j.zuweisung)!;
      const runden = z.anfrage_runden ?? 1;
      const basis = Date.parse(aenderungsBasis({ angefragtAt: z.angefragt_at, vorigeAngefragtAt: z.vorige_angefragt_at, runden }) ?? z.angefragt_at);
      const pos = positionen.filter((p) => p.job_id === j.id);
      const akt = aktivitaet.filter((a) => a.job_id === j.id);
      let aenderung = 0;
      for (const p of pos) {
        const c = Date.parse(p.created_at);
        const g = p.inhalt_geaendert_at ? Date.parse(p.inhalt_geaendert_at) : 0;
        if (c > basis) aenderung = Math.max(aenderung, c);
        if (g > basis) aenderung = Math.max(aenderung, g);
      }
      let reaktion = 0;
      for (const a of akt) {
        const t = Date.parse(a.created_at);
        if (a.actor_id && portalSet.has(a.actor_id)) reaktion = Math.max(reaktion, t);
        else if ((a.aktion === "position_geloescht" || a.aktion === "ki_entfernt") && t > basis) aenderung = Math.max(aenderung, t);
      }
      const anfrageStatus: AnfrageStatus =
        j.status === "storniert" ? "storniert"
        : j.status === "abgeschlossen" ? "abgeschlossen"
        : aenderung && reaktion < aenderung ? "geaendert"
        : reaktion > Date.parse(z.angefragt_at) ? "beantwortet"
        : "neu";
      const loc = eins(j.location);
      const room = eins(j.room);
      return {
        jobId: j.id,
        titel: j.title,
        jobNumber: j.job_number,
        status: j.status,
        anfrageStatus,
        gesperrt: technikGesperrt(j.status),
        startDate: j.start_date,
        endDate: j.end_date,
        gaeste: j.guest_count,
        eventTyp: j.event_type,
        ort: loc ? [loc.name, loc.address_city].filter(Boolean).join(", ")
          : room ? [room.name, room.address_city].filter(Boolean).join(", ")
          : (j.external_address ?? "").trim() || null,
        angefragtAt: z.angefragt_at,
        runden,
        positionen: pos.length,
        bestaetigt: pos.filter((p) => p.status === "bestaetigt").length,
        offenePunkte: offeneReviews.filter((r) => r.job_id === j.id).length,
      };
    });

    return NextResponse.json({ success: true, zeit, anfragen });
  } catch (e) {
    logError("api.lieferant.anfragen", e);
    return NextResponse.json({ success: false, error: "Laden fehlgeschlagen" }, { status: 500 });
  }
}
