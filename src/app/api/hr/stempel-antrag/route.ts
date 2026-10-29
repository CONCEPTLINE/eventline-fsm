// Stempel ändern über die Änderungsstelle der Lohndaten (Lohn-Umbau Phase 4).
//
// POST /api/hr/stempel-antrag
//   { op: "insert"|"update"|"delete", id?, user_id?, clock_in?, clock_out?,
//     lang_begruendung?, description?, begruendung }
//   → { success, mode: "direkt"|"antrag"|"begruendung_noetig", meldung?, id?, antrag_id? }
//
// Offene Monate: direkt (lohn_aenderung_direkt). Abgerechnete Monate (Sperre
// 5. des Folgemonats bzw. Lohnabrechnung schon erstellt): ANTRAG mit
// Begründung (≥ 10 Zeichen), den eine zweite Person (anderer Admin oder
// Vertretung) innert 24 h auf einem vertrauten Gerät bestätigt
// (/antraege, Reiter «Rechte & Lohndaten»). Ohne Begründung: 409
// mode «begruendung_noetig» (Klartext in meldung/error).
//
// Wer: Lohnrecht (lohn:manage) + vertrautes Gerät. Stempel einer anderen
// Person mit Lohnrecht ändert nur ein Admin oder die Vertretung (wie der Lohn).
// Genutzt von: Stempelzeiten-Ansicht (Desktop, Dialog «Antrag stellen») und
// der Statusspalte des Monatsabschlusses («Ende per Antrag setzen»).
//
// Prüft vorab (gilt auch vor Migration 368): keine Überschneidung mit einem
// anderen Stempel der Person, Stempel über 16 h nur mit lang_begruendung,
// Ende nach Beginn und nicht in der Zukunft.

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/search-escape";
import { LOHN_RECHT, pruefeLohnAenderung } from "@/lib/lohn/zugriff";
import { ladeName } from "@/lib/lohn/rechte-antraege";
import { aendereLohndaten, ANTRAG_HINWEIS_LOHN, type Operation } from "@/lib/lohn/aenderungen";
import { istLangerStempel, STEMPEL_LANG_STUNDEN } from "@/lib/lohn/stempel-pruefung";
import { findeUeberlappung, isoZuZuerich, stempelMeldung, ueberlappungsMeldung } from "@/lib/stempel-meldungen";
import { recipientsWithPermission } from "@/lib/notification-recipients";
import { notifySystem } from "@/lib/notification-service";
import { rechteAntraegeHref } from "@/lib/antraege-links";
import { logError } from "@/lib/log";

interface Stempel {
  id: string;
  user_id: string | null;
  clock_in: string;
  clock_out: string | null;
  lang_begruendung: string | null;
  description: string | null;
  job_id: string | null;
  project_id: string | null;
}

const ZEIT = new Intl.DateTimeFormat("de-CH", {
  timeZone: "Europe/Zurich", weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
});
const NUR_ZEIT = new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit" });

/** «Do, 10.09.2026, 10:00–16:00» bzw. «… 22:00 bis Fr, 11.09.2026, 04:00» / «… (offen)». */
function spanne(von: string, bis: string | null): string {
  const a = ZEIT.format(new Date(von));
  if (!bis) return `${a} (offen)`;
  return isoZuZuerich(von).datum === isoZuZuerich(bis).datum ? `${a}–${NUR_ZEIT.format(new Date(bis))}` : `${a} bis ${ZEIT.format(new Date(bis))}`;
}

function zeitpunkt(v: unknown): string | null | undefined {
  if (v === null || v === "") return null;
  if (typeof v !== "string") return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

function text(v: unknown, max: number): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
}

const fehler = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ success: false, error, ...extra }, { status });

/**
 * Brücke: Löschen eines Stempels nach der Sperre (5. des Folgemonats) bricht
 * in der Datenbank mit «nicht löschbar» ab (lohn_schutz_stempel, Migration
 * 367) statt mit der Sperr-Meldung «nur per Antrag», die aendereLohndaten()
 * erkennt. Hier deshalb der Antrag direkt — gleiche Felder und Meldung wie
 * aendereLohndaten(). Entfällt, sobald aendereLohndaten auch «nicht löschbar»
 * als Sperre erkennt.
 */
async function loeschAntrag(
  admin: SupabaseClient,
  a: { operationen: Operation[]; profileId: string; zielName: string | null; beschreibung: string; begruendung: string; betrifftAb: string; akteurId: string; akteurName: string | null },
): Promise<string> {
  const { data, error } = await admin
    .from("lohn_aenderungs_antraege")
    .insert({
      bereich: "stempel",
      profile_id: a.profileId,
      ziel_name: a.zielName,
      beschreibung: a.beschreibung,
      begruendung: a.begruendung,
      operationen: a.operationen,
      betrifft_ab: a.betrifftAb,
      beantragt_von: a.akteurId,
      beantragt_von_name: a.akteurName,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`Antrag konnte nicht gespeichert werden: ${error?.message ?? "keine Antwort"}`);
  try {
    const empfaenger = (await recipientsWithPermission(admin, LOHN_RECHT)).filter((id) => id !== a.akteurId);
    if (empfaenger.length > 0) {
      await notifySystem(admin, {
        recipients: empfaenger,
        title: "Lohndaten: Antrag wartet auf Bestätigung",
        message: `${a.akteurName ?? "Jemand"}: ${a.beschreibung} — Begründung: ${a.begruendung}`,
        link: rechteAntraegeHref(),
      });
    }
  } catch (e) {
    logError("hr.stempel-antrag.meldung", e);
  }
  return data.id as string;
}

export async function POST(req: Request) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  if (auth.isImpersonating) return fehler(403, "In «Ansicht als» nicht möglich.");
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return fehler(400, "Body fehlt");
  const op = b.op;
  if (op !== "insert" && op !== "update" && op !== "delete") return fehler(400, "op muss insert, update oder delete sein");
  const admin = createAdminClient();

  // Bestehender Stempel (update/delete)
  let alt: Stempel | null = null;
  if (op !== "insert") {
    const id = typeof b.id === "string" && isUuid(b.id) ? b.id : null;
    if (!id) return fehler(400, "id fehlt");
    const { data, error } = await admin
      .from("time_entries")
      .select("id, user_id, clock_in, clock_out, lang_begruendung, description, job_id, project_id")
      .eq("id", id)
      .maybeSingle();
    if (error) return fehler(500, error.message);
    if (!data) return fehler(404, "Stempel nicht gefunden (inzwischen gelöscht?)");
    alt = data as Stempel;
  }
  const userId = alt?.user_id ?? (typeof b.user_id === "string" && isUuid(b.user_id) ? b.user_id : null);
  if (!userId) return fehler(400, "user_id fehlt");
  if (userId !== auth.user.id) {
    const verbot = await pruefeLohnAenderung(admin, auth.user.id, userId).catch((e: Error) => e.message);
    if (verbot) return fehler(403, verbot.replace("Den Lohn", "Stempel"));
  }

  // Werte prüfen
  const werte: Record<string, unknown> = {};
  if (op !== "delete") {
    for (const k of ["clock_in", "clock_out"] as const) {
      if (!(k in b)) continue;
      const z = zeitpunkt(b[k]);
      if (z === undefined) return fehler(400, `${k === "clock_in" ? "Beginn" : "Ende"} ungültig`);
      if (k === "clock_in" && z === null) return fehler(400, "Beginn fehlt");
      werte[k] = z;
    }
    if ("lang_begruendung" in b) werte.lang_begruendung = text(b.lang_begruendung, 500);
    if ("description" in b) werte.description = text(b.description, 500);
    if (op === "insert") {
      if (!werte.clock_in) return fehler(400, "Beginn fehlt");
      if (!werte.clock_out) return fehler(400, "Ende fehlt");
      if (!werte.description) return fehler(400, "Beschreibung fehlt (was wurde gearbeitet?)");
      werte.user_id = userId;
    } else if (Object.keys(werte).length === 0) {
      return fehler(400, "Keine Änderung angegeben");
    }
  }

  const neuVon = (werte.clock_in as string | undefined) ?? alt?.clock_in ?? null;
  const neuBis = "clock_out" in werte ? (werte.clock_out as string | null) : (alt?.clock_out ?? null);
  if (op !== "delete" && neuVon) {
    if (neuBis && Date.parse(neuBis) < Date.parse(neuVon)) return fehler(400, "Das Ende liegt vor dem Beginn.");
    if (neuBis && Date.parse(neuBis) > Date.now() + 60_000) return fehler(400, "Das Ende liegt in der Zukunft.");
    const langText = "lang_begruendung" in werte ? (werte.lang_begruendung as string | null) : (alt?.lang_begruendung ?? null);
    if (istLangerStempel(neuVon, neuBis) && !langText) {
      return fehler(400, `Der Stempel dauert über ${STEMPEL_LANG_STUNDEN} Stunden — bitte die Endzeit prüfen. Stimmt sie, braucht es eine Begründung.`, { code: "lang_begruendung_noetig" });
    }
  }

  const [akteurName, zielName] = await Promise.all([ladeName(admin, auth.user.id), ladeName(admin, userId)]);

  // Überschneidung vorab (Klartext; die Datenbank-Regel 368 hält es ohnehin)
  if (op !== "delete" && neuVon) {
    const ueb = await findeUeberlappung(admin, { userId, von: neuVon, bis: neuBis, ohneId: alt?.id ?? null });
    if (ueb) return fehler(409, ueberlappungsMeldung(ueb, { person: zielName ?? "der Person" }), { code: "ueberlappung" });
  }

  const operationen: Operation[] = [
    op === "insert"
      ? { op: "insert", tabelle: "time_entries", werte }
      : op === "update"
        ? { op: "update", tabelle: "time_entries", id: alt!.id, werte }
        : { op: "delete", tabelle: "time_entries", id: alt!.id },
  ];
  const wer = zielName ?? userId;
  const beschreibung =
    op === "insert"
      ? `Stempel nachtragen: ${wer}, ${spanne(neuVon!, neuBis)}`
      : op === "update"
        ? `Stempel ändern: ${wer}, ${spanne(alt!.clock_in, alt!.clock_out)} → ${spanne(neuVon!, neuBis)}`
        : `Stempel löschen: ${wer}, ${spanne(alt!.clock_in, alt!.clock_out)}`;
  const begruendung = typeof b.begruendung === "string" ? b.begruendung : null;

  try {
    let r: Awaited<ReturnType<typeof aendereLohndaten>>;
    try {
      r = await aendereLohndaten(admin, {
        operationen,
        bereich: "stempel",
        profileId: userId,
        zielName,
        beschreibung,
        begruendung,
        akteurId: auth.user.id,
        akteurName,
      });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (op !== "delete" || !/nicht löschbar/.test(m)) throw e;
      const ab = isoZuZuerich(alt!.clock_in).datum;
      if ((begruendung ?? "").trim().length < 10) {
        r = { modus: "begruendung_noetig", meldung: `time_entries: die Änderung betrifft abgerechnete Monate (ab ${ab.split("-").reverse().join(".")}) — nur per Antrag`, betrifftAb: ab };
      } else {
        const antragId = await loeschAntrag(admin, {
          operationen, profileId: userId, zielName, beschreibung, begruendung: begruendung!.trim(), betrifftAb: ab, akteurId: auth.user.id, akteurName,
        });
        r = { modus: "antrag", antragId, gueltigBis: "", betrifftAb: ab };
      }
    }
    if (r.modus === "begruendung_noetig") {
      const meldung = `${stempelMeldung({ code: "P0001", message: r.meldung }, { person: wer })} Bitte eine Begründung (mind. 10 Zeichen) angeben — dann wird ein Antrag gestellt.`;
      return NextResponse.json({ success: false, mode: "begruendung_noetig", code: "begruendung_noetig", meldung, error: meldung, betrifft_ab: r.betrifftAb }, { status: 409 });
    }
    if (r.modus === "antrag") {
      return NextResponse.json({ success: true, mode: "antrag", antrag_id: r.antragId, meldung: ANTRAG_HINWEIS_LOHN });
    }
    return NextResponse.json({ success: true, mode: "direkt", id: r.ids[0] ?? alt?.id ?? null });
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    logError("hr.stempel-antrag", e, { op, userId });
    return fehler(400, stempelMeldung({ message: m }, { person: wer, sonst: m }));
  }
}
