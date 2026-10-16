// /api/partner/anfragen/[id] — Detail einer EIGENEN Anfrage im Partnerportal.
//
// GET  → Anfrage (nur die angezeigten Felder), Termine (Name der zugeteilten
//        Person statt ID), Dokumente (ohne Ablage-Pfad; Laden ueber
//        /dokumente?dok=…). Fremde/nicht vorhandene Auftraege: 404.
// POST { aktion: "titel", titel }      → Titel (Entwurf/Anfrage), RPC
//                                        partner_update_title als Partner
// POST { aktion: "notizen", notizen }  → gemeinsame Notizen (Entwurf/Anfrage/
//                                        bestaetigt), wie bisher die RPC
//                                        partner_update_notes
// POST { aktion: "absenden" }          → Entwurf an EVENTLINE (RPC
//                                        partner_submit_anfrage als Partner,
//                                        inkl. Benachrichtigung)
// Rechte: lesen = eine Portal-Leserecht, aendern = partner:anfragen:edit,
// absenden = partner:anfragen:create.

import { NextRequest, NextResponse } from "next/server";
import {
  requirePartnerPortal,
  eigeneAnfrageLaden,
  interneNamen,
  anfrageDokumente,
  partnerFehler,
  partnerRpcFehler,
} from "@/lib/partner-portal-server";
import { istNachreichbar, NOTIZEN_MAX, PARTNER_NACHREICHEN_STATUS } from "@/lib/partner-anfrage";
import { logError } from "@/lib/log";

const DETAIL_SPALTEN =
  "job_number, title, description, start_date, end_date, notes, partner_response_message, " +
  "contact_person, contact_phone, contact_email, partner_aenderung";

interface DetailZeile {
  job_number: number | null;
  title: string;
  description: string | null;
  start_date: string | null;
  end_date: string | null;
  notes: string | null;
  partner_response_message: string | null;
  contact_person: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  partner_aenderung: unknown;
  [k: string]: unknown;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePartnerPortal();
  if (gate.error) return gate.error;
  if (!gate.darfLesen) return partnerFehler("Kein Zugriff", 403);
  const { id } = await params;
  const geladen = await eigeneAnfrageLaden<DetailZeile>(gate, id, DETAIL_SPALTEN);
  if (!geladen.ok) return geladen.antwort;
  const j = geladen.job;

  try {
    const [termineRes, dokumente] = await Promise.all([
      gate.admin
        .from("job_appointments")
        .select("id, title, start_time, end_time, description, zeit_modus, assigned_to")
        .eq("job_id", j.id)
        // Gleichzeitige Termine stabil in Anlege-Reihenfolge
        .order("start_time")
        .order("created_at"),
      anfrageDokumente(gate.admin, j.id),
    ]);
    if (termineRes.error) throw termineRes.error;
    const termine = (termineRes.data ?? []) as {
      id: string; title: string; start_time: string; end_time: string | null;
      description: string | null; zeit_modus: string; assigned_to: string | null;
    }[];
    const namen = await interneNamen(gate.admin, termine.map((t) => t.assigned_to));

    return NextResponse.json({
      success: true,
      anfrage: {
        id: j.id,
        job_number: j.job_number,
        title: j.title,
        description: j.description,
        start_date: j.start_date,
        end_date: j.end_date,
        status: j.status,
        notes: j.notes,
        partner_response_message: j.partner_response_message,
        accepted_at: j.accepted_at,
        rejected_at: j.rejected_at,
        contact_person: j.contact_person,
        contact_phone: j.contact_phone,
        contact_email: j.contact_email,
        // Nur das Signal «Aenderung wartet auf EVENTLINE» — der Vorher-Stand
        // ist fuer den Vergleich im Firmenportal.
        partner_aenderung: j.partner_aenderung != null,
      },
      termine: termine.map((t) => ({
        id: t.id,
        title: t.title,
        start_time: t.start_time,
        end_time: t.end_time,
        description: t.description,
        zeit_modus: t.zeit_modus,
        zugewiesen: t.assigned_to ? namen.get(t.assigned_to) ?? null : null,
      })),
      dokumente: dokumente.map((d) => ({ id: d.id, name: d.name, file_size: d.file_size, created_at: d.created_at })),
    });
  } catch (e) {
    logError("api.partner.anfragen.detail", e, { jobId: j.id });
    return partnerFehler("Anfrage konnte nicht geladen werden", 500);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePartnerPortal();
  if (gate.error) return gate.error;
  const { id } = await params;
  const b = ((await req.json().catch(() => null)) ?? {}) as { aktion?: unknown; titel?: unknown; notizen?: unknown };

  const recht = b.aktion === "absenden" ? "partner:anfragen:create" : "partner:anfragen:edit";
  if (b.aktion !== "titel" && b.aktion !== "notizen" && b.aktion !== "absenden") return partnerFehler("Unbekannte Aktion", 400);
  if (!gate.darf(recht)) return partnerFehler("Keine Berechtigung für diese Aktion", 403);

  const geladen = await eigeneAnfrageLaden(gate, id);
  if (!geladen.ok) return geladen.antwort;
  const jobId = geladen.job.id;

  try {
    if (b.aktion === "titel") {
      if (typeof b.titel !== "string") return partnerFehler("Titel fehlt", 400);
      // Pruefung, Normalisierung und Status-Regel macht die bestehende RPC —
      // ausgefuehrt im Namen des Partners (Verlauf zeigt den Partner).
      const { data, error } = await gate.admin.rpc("partnerportal_titel", {
        p_actor: gate.userId,
        p_job_id: jobId,
        p_title: b.titel,
      });
      if (error) {
        logError("api.partner.anfragen.titel", error, { jobId });
        const f = partnerRpcFehler(error.message, "Titel konnte nicht gespeichert werden");
        return partnerFehler(f.error, f.status);
      }
      return NextResponse.json({ success: true, titel: typeof data === "string" ? data : null });
    }

    if (b.aktion === "notizen") {
      if (b.notizen != null && typeof b.notizen !== "string") return partnerFehler("Ungültige Notizen", 400);
      const text = ((b.notizen as string | null) ?? "").trim();
      if (text.length > NOTIZEN_MAX) return partnerFehler("Notizen sind zu lang", 400);
      if (!istNachreichbar(geladen.job.status)) {
        return partnerFehler("Notizen können in diesem Status nicht mehr geändert werden", 409);
      }
      // Status-Bedingung im UPDATE selbst: aendert EVENTLINE gleichzeitig den
      // Status (z.B. abgeschlossen), greift nichts mehr.
      const { count, error } = await gate.admin
        .from("jobs")
        .update({ notes: text || null }, { count: "exact" })
        .eq("id", jobId)
        .in("status", [...PARTNER_NACHREICHEN_STATUS]);
      if (error) throw error;
      if (count === 0) return partnerFehler("Notizen können in diesem Status nicht mehr geändert werden", 409);
      return NextResponse.json({ success: true });
    }

    // absenden
    const { error } = await gate.admin.rpc("partnerportal_absenden", { p_actor: gate.userId, p_job_id: jobId });
    if (error) {
      logError("api.partner.anfragen.absenden", error, { jobId });
      const f = partnerRpcFehler(error.message, "Anfrage konnte nicht abgeschickt werden");
      return partnerFehler(f.error, f.status);
    }
    return NextResponse.json({ success: true });
  } catch (e) {
    logError("api.partner.anfragen.aktion", e, { jobId, aktion: b.aktion });
    return partnerFehler("Speichern fehlgeschlagen", 500);
  }
}
