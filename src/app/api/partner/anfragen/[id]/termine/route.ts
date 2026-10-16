// /api/partner/anfragen/[id]/termine — Termine einer EIGENEN Anfrage, solange
// sie noch beim Partner liegt (Entwurf / Anfrage). Recht partner:anfragen:edit.
//
// POST { aktion: "anlegen", titel, start, ende, beschreibung, zeit_modus }
// POST { aktion: "aendern", terminId, titel, start, ende, beschreibung, zeit_modus }
// POST { aktion: "loeschen", terminId }
//
// Gleiche Regeln wie bisher (RLS appointments_*_partner, RPC
// partner_update_termin, Trigger protect_last_termin_for_partner_anfrage):
// Titel + Beginn Pflicht, Zeitfenster-Art fix/verschiebbar/deadline («Fertig
// bis» ohne Endzeit), Termin im Veranstaltungszeitraum, bei einer
// abgeschickten Anfrage bleibt mindestens ein Termin.

import { NextRequest, NextResponse } from "next/server";
import { requirePartnerPortal, eigeneAnfrageLaden, partnerFehler } from "@/lib/partner-portal-server";
import { istPartnerOffen, terminPruefen, PARTNER_OFFENE_STATUS } from "@/lib/partner-anfrage";
import { isUuid } from "@/lib/search-escape";
import { logError } from "@/lib/log";

const GESPERRT = "Termine können nur geändert werden, solange die Anfrage noch nicht bestätigt ist";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePartnerPortal();
  if (gate.error) return gate.error;
  if (!gate.darf("partner:anfragen:edit")) return partnerFehler("Keine Berechtigung für diese Aktion", 403);
  const { id } = await params;
  const b = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  if (b.aktion !== "anlegen" && b.aktion !== "aendern" && b.aktion !== "loeschen") {
    return partnerFehler("Unbekannte Aktion", 400);
  }

  const geladen = await eigeneAnfrageLaden<{ start_date: string | null; end_date: string | null }>(gate, id, "start_date, end_date");
  if (!geladen.ok) return geladen.antwort;
  const job = geladen.job;
  if (!istPartnerOffen(job.status)) return partnerFehler(GESPERRT, 409);
  const { admin } = gate;

  try {
    // Termin gehoert zu DIESER Anfrage (sonst «nicht gefunden»).
    let terminId: string | null = null;
    if (b.aktion !== "anlegen") {
      if (typeof b.terminId !== "string" || !isUuid(b.terminId)) return partnerFehler("Ungültiger Termin", 400);
      const { data: t, error: tErr } = await admin
        .from("job_appointments").select("id").eq("id", b.terminId).eq("job_id", job.id).maybeSingle();
      if (tErr) throw tErr;
      if (!t) return partnerFehler("Termin nicht gefunden", 404);
      terminId = t.id as string;
    }

    if (b.aktion === "loeschen") {
      // Abgeschickte Anfrage: der letzte Termin bleibt (EVENTLINE braucht ein
      // Datum + Zeit). Zuerst einen neuen Termin anlegen, dann den alten loeschen.
      if (job.status === "partner_anfrage") {
        const { count, error: cErr } = await admin
          .from("job_appointments").select("id", { count: "exact", head: true }).eq("job_id", job.id);
        if (cErr) throw cErr;
        if ((count ?? 0) <= 1) {
          return partnerFehler("Mindestens ein Termin muss in dieser Phase bleiben. Zuerst neuen Termin anlegen, dann den alten löschen.", 409);
        }
      }
      const { count, error } = await admin
        .from("job_appointments").delete({ count: "exact" }).eq("id", terminId!).eq("job_id", job.id);
      if (error) throw error;
      if (count === 0) return partnerFehler("Termin nicht gefunden", 404);
      return NextResponse.json({ success: true });
    }

    const pruefung = terminPruefen(
      { titel: b.titel, start: b.start, ende: b.ende, beschreibung: b.beschreibung, zeit_modus: b.zeit_modus },
      { start_date: job.start_date, end_date: job.end_date },
    );
    if (!pruefung.ok) return partnerFehler(pruefung.fehler, 400);
    const werte = {
      title: pruefung.termin.titel,
      start_time: pruefung.termin.start,
      end_time: pruefung.termin.ende,
      description: pruefung.termin.beschreibung,
      zeit_modus: pruefung.termin.zeitModus,
    };

    // Status nochmals im Schreibvorgang absichern (EVENTLINE kann parallel
    // bestaetigen): nur solange die Anfrage beim Partner liegt.
    const { data: nochOffen, error: sErr } = await admin
      .from("jobs").select("id").eq("id", job.id).in("status", [...PARTNER_OFFENE_STATUS]).maybeSingle();
    if (sErr) throw sErr;
    if (!nochOffen) return partnerFehler(GESPERRT, 409);

    if (b.aktion === "anlegen") {
      const { data: neu, error } = await admin
        .from("job_appointments").insert({ job_id: job.id, ...werte }).select("id").single();
      if (error) throw error;
      return NextResponse.json({ success: true, id: neu.id as string });
    }

    const { count, error } = await admin
      .from("job_appointments").update(werte, { count: "exact" }).eq("id", terminId!).eq("job_id", job.id);
    if (error) throw error;
    if (count === 0) return partnerFehler("Termin nicht gefunden", 404);
    return NextResponse.json({ success: true });
  } catch (e) {
    logError("api.partner.anfragen.termine", e, { jobId: job.id, aktion: b.aktion });
    return partnerFehler("Termin konnte nicht gespeichert werden", 500);
  }
}
