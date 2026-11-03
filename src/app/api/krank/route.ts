// /api/krank — Krank melden (ohne Freigabe).
//
// GET  ?ab=YYYY-MM-DD[&bis=YYYY-MM-DD]  → { einsaetze: BetroffenerEinsatz[] }
//      Eigene Auftrags-Einsaetze im Zeitraum (ohne «bis»: Vorschau bis zum
//      Tag, ab dem das Arztzeugnis faellig ist).
// POST { ab, bis | null }              → { id }
//      Legt die Abwesenheit Typ «krank» direkt als «genehmigt» an
//      (approved_by_name «Krankmeldung», keine Freigabe noetig) und
//      benachrichtigt ferien:approve (Admins inkl.) und die Projektleitung
//      der betroffenen Auftraege — nur «krank gemeldet» + Zeitraum, nie eine
//      Diagnose (DSG Art. 5). Kein Freitext-Feld.
//
// Nur interne Konten; «Ansicht als» ist nur-lesen (Middleware 423).

import { NextRequest, NextResponse } from "next/server";
import { requireInternal } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { plusTage, todayLocalIso } from "@/lib/swiss-time";
import { personenMitRecht } from "@/lib/rechte-empfaenger";
import { notifyKrankGemeldet, notifyKrankProjektleitung } from "@/lib/notification-service";
import { betroffenBis, ladeBetroffeneEinsaetze } from "@/lib/krank-server";
import { KRANKMELDUNG } from "@/lib/krank";

export const dynamic = "force-dynamic";

const DATUM = /^\d{4}-\d{2}-\d{2}$/;
/** «Ab» darf hoechstens so weit zurueck bzw. voraus liegen. */
const AB_ZURUECK_TAGE = 14;
const AB_VORAUS_TAGE = 7;
const MAX_DAUER_TAGE = 90;

function pruefe(ab: unknown, bis: unknown): { ab: string; bis: string | null } | string {
  if (typeof ab !== "string" || !DATUM.test(ab)) return "Ab-Datum fehlt";
  const heute = todayLocalIso();
  if (ab < plusTage(heute, -AB_ZURUECK_TAGE)) return `Ab-Datum liegt mehr als ${AB_ZURUECK_TAGE} Tage zurück — bitte im Büro melden`;
  if (ab > plusTage(heute, AB_VORAUS_TAGE)) return "Ab-Datum liegt zu weit in der Zukunft";
  if (bis === null || bis === undefined || bis === "") return { ab, bis: null };
  if (typeof bis !== "string" || !DATUM.test(bis)) return "Bis-Datum ungültig";
  if (bis < ab) return "«Bis» liegt vor «Ab»";
  if (bis > plusTage(ab, MAX_DAUER_TAGE)) return `Höchstens ${MAX_DAUER_TAGE} Tage auf einmal`;
  return { ab, bis };
}

const fehler = (text: string, status = 400) => NextResponse.json({ success: false, error: text }, { status });

export async function GET(req: NextRequest) {
  const auth = await requireInternal();
  if (auth.error) return auth.error;
  const p = new URL(req.url).searchParams;
  const z = pruefe(p.get("ab"), p.get("bis"));
  if (typeof z === "string") return fehler(z);
  try {
    const einsaetze = await ladeBetroffeneEinsaetze(createAdminClient(), auth.effectiveUserId, z.ab, betroffenBis(z.ab, z.bis));
    return NextResponse.json(
      // Projektleitung bleibt serverseitig (nur fuer die Benachrichtigung).
      { success: true, einsaetze: einsaetze.map((e) => ({ id: e.id, start: e.start, ende: e.ende, job_number: e.job_number, titel: e.titel })) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    logError("api.krank.einsaetze", e, { userId: auth.effectiveUserId });
    return fehler("Einsätze konnten nicht geladen werden", 500);
  }
}

export async function POST(req: NextRequest) {
  const auth = await requireInternal();
  if (auth.error) return auth.error;
  const ich = auth.user.id;
  const body = (await req.json().catch(() => null)) as { ab?: unknown; bis?: unknown } | null;
  const z = pruefe(body?.ab, body?.bis);
  if (typeof z === "string") return fehler(z);

  const admin = createAdminClient();
  try {
    // Keine zweite laufende Krankmeldung, die «Ab» schon abdeckt.
    const { data: laufend, error: lErr } = await admin
      .from("time_off")
      .select("id, start_date, end_date, ende_offen")
      .eq("user_id", ich)
      .eq("type", "krank")
      .eq("status", "genehmigt")
      .lte("start_date", z.bis ?? z.ab)
      .or(`ende_offen.eq.true,end_date.gte.${z.ab}`)
      .limit(1);
    if (lErr) throw new Error(lErr.message);
    if ((laufend ?? []).length > 0) {
      return fehler("Für diesen Zeitraum bist du schon krank gemeldet. Unter «Meine Anfragen» kannst du sie anpassen («Wieder gesund»).", 409);
    }

    const { data: neu, error } = await admin
      .from("time_off")
      .insert({
        user_id: ich,
        type: "krank",
        status: "genehmigt",
        start_date: z.ab,
        end_date: z.bis ?? z.ab,
        ende_offen: z.bis === null,
        approved_at: new Date().toISOString(),
        approved_by_name: KRANKMELDUNG,
      })
      .select("id")
      .single();
    if (error || !neu) throw new Error(error?.message ?? "Speichern fehlgeschlagen");

    // Benachrichtigen — Fehler hier blockieren die Meldung nicht.
    try {
      const [{ data: prof }, approver, einsaetze] = await Promise.all([
        admin.from("profiles").select("full_name").eq("id", ich).maybeSingle(),
        personenMitRecht(admin, "ferien:approve"),
        ladeBetroffeneEinsaetze(admin, ich, z.ab, betroffenBis(z.ab, z.bis)),
      ]);
      const name = (prof?.full_name as string | undefined) ?? "Jemand";
      const approverIds = approver.map((p) => p.id).filter((id) => id !== ich);
      await notifyKrankGemeldet(admin, { recipients: approverIds, timeOffId: neu.id, name, ab: z.ab, bis: z.bis, einsaetze: einsaetze.length });

      // Projektleitung je Person einmal, mit ihren betroffenen Auftraegen.
      // Wer schon als Freigabe-Person benachrichtigt wurde, bekommt trotzdem
      // die Auftrags-Nachricht (sie sagt, WELCHE Einsaetze betroffen sind).
      const jeLeitung = new Map<string, { jobId: string; auftraege: Set<string> }>();
      for (const e of einsaetze) {
        if (!e.project_lead_id || e.project_lead_id === ich) continue;
        const eintrag = jeLeitung.get(e.project_lead_id) ?? { jobId: e.job_id, auftraege: new Set<string>() };
        eintrag.auftraege.add(`INT-${e.job_number} ${e.titel}`);
        jeLeitung.set(e.project_lead_id, eintrag);
      }
      await Promise.all(
        Array.from(jeLeitung.entries()).map(([lead, v]) =>
          notifyKrankProjektleitung(admin, { recipients: [lead], name, ab: z.ab, bis: z.bis, auftraege: Array.from(v.auftraege), jobId: v.jobId }),
        ),
      );
    } catch (e) {
      logError("api.krank.notify", e, { userId: ich });
    }

    return NextResponse.json({ success: true, id: neu.id });
  } catch (e) {
    logError("api.krank.melden", e, { userId: ich });
    return fehler("Krankmeldung konnte nicht gespeichert werden", 500);
  }
}
