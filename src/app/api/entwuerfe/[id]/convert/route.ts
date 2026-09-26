// /api/entwuerfe/[id]/convert — Draft -> echter Auftrag.
//
// Ein Klick der aus einem Draft einen job-Record macht:
//   1. Draft laden (nicht bereits umgewandelt, nicht storniert, nicht deleted).
//   2. Freitext-Kunde (customer_name ohne customer_id) → neuen Customer
//      anlegen (oder existierenden per case-insensitive Name-Match wieder-
//      verwenden). Location-Freitext (location_name ohne location_id) wird
//      NICHT als Location angelegt, sondern landet auf jobs.external_address.
//   3. Passenden Job in public.jobs anlegen (status='offen', priority='normal').
//   4. Draft-Row auf status='umgewandelt' setzen und converted_to_job_id +
//      converted_at fuellen. Der Draft-Record BLEIBT (fuer Historie/Statistik).
//
// job_type-Mapping:
//   - location_id gesetzt & customer_id NULL           -> 'location'
//   - customer_id gesetzt (mit/ohne location_id)        -> 'extern'
//   - beides NULL                                       -> 'extern'
//     (Rueckfall-Case; UI validiert vorher dass mindestens ein Ansprechpartner-
//      Namen existiert, sonst ist die Umwandlung nicht sinnvoll)
//
// Wenn expected_start_date/expected_end_date fehlen wird der Auftrag ohne
// Datum angelegt (das UI zwingt den User dann im Auftrag-Detail zum
// Nachpflegen bevor freigegeben werden kann).
//
// Auth-Modell: requirePermission("auftraege:create") — die Umwandlung LEGT
// einen Auftrag AN, das ist die create-Kompetenz (nicht edit). Wir gehen
// ueber Admin-Client, weil
// wir zwei Writes in einer HTTP-Response bearbeiten und einen partial-
// Failure sauber melden wollen ohne dass RLS in der zweiten Query auf
// eine unerwartete Row-Sicht faellt.

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission("auftraege:create");
  if (auth.error) return auth.error;
  const { id: draftId } = await params;

  const admin = createAdminClient();

  // 1) Draft laden
  const { data: draft, error: draftErr } = await admin
    .from("job_drafts")
    .select("*")
    .eq("id", draftId)
    .eq("is_deleted", false)
    .maybeSingle();
  if (draftErr) return NextResponse.json({ success: false, error: draftErr.message }, { status: 500 });
  if (!draft) return NextResponse.json({ success: false, error: "Entwurf nicht gefunden" }, { status: 404 });

  // Audit-Fix g1: Owner-Check auf job_drafts.owner_id. Ohne diese Gate
  // konnte JEDER mit der Auftrags-Permission einen fremden Draft (z.B. "in Klaerung
  // beim Kollegen") umwandeln und damit dem Kollegen die Arbeit wegnehmen.
  // Admins duerfen immer.
  if (draft.owner_id && draft.owner_id !== auth.user.id) {
    const { data: me } = await admin
      .from("profiles")
      .select("role")
      .eq("id", auth.user.id)
      .maybeSingle();
    if (me?.role !== "admin") {
      return NextResponse.json(
        { success: false, error: "Nur der Owner oder ein Admin kann diesen Entwurf umwandeln" },
        { status: 403 },
      );
    }
  }

  if (draft.status === "umgewandelt" || draft.converted_to_job_id) {
    return NextResponse.json(
      { success: false, error: "Dieser Entwurf wurde bereits umgewandelt", jobId: draft.converted_to_job_id },
      { status: 409 },
    );
  }
  if (draft.status === "storniert") {
    return NextResponse.json({ success: false, error: "Stornierte Entwuerfe koennen nicht umgewandelt werden" }, { status: 400 });
  }
  if (!draft.title?.trim()) {
    return NextResponse.json({ success: false, error: "Titel fehlt" }, { status: 400 });
  }

  // 2) Freitext-Kunde bei Bedarf materialisieren:
  //    customer_name (ohne customer_id) → Row in customers anlegen ODER
  //    per case-insensitive Name-Match wiederverwenden. Fehler blockiert
  //    die Umwandlung — der Draft bleibt intakt, User kann's nochmal.
  let effectiveCustomerId: string | null = draft.customer_id ?? null;
  let customerCreated = false;
  if (!effectiveCustomerId && draft.customer_name?.trim()) {
    const nameTrim = draft.customer_name.trim();
    // 2a) Duplikat-Check (case-insensitive). Auch inaktive Kunden matchen —
    //     einen "gleichen Namen" nochmal anzulegen ist immer falsch, egal
    //     ob der bestehende gerade inaktiv ist.
    const { data: existing, error: dupErr } = await admin
      .from("customers")
      .select("id")
      .ilike("name", nameTrim)
      .limit(1)
      .maybeSingle();
    if (dupErr) {
      return NextResponse.json({ success: false, error: dupErr.message }, { status: 500 });
    }
    if (existing) {
      effectiveCustomerId = existing.id;
    } else {
      const { data: newCust, error: custErr } = await admin
        .from("customers")
        .insert({
          name: nameTrim,
          type: "company",
          email: draft.contact_email?.trim() || null,
          phone: draft.contact_phone?.trim() || null,
          notes: draft.contact_person?.trim()
            ? `Ansprechperson: ${draft.contact_person.trim()}`
            : null,
        })
        .select("id")
        .single();
      if (custErr || !newCust) {
        return NextResponse.json(
          { success: false, error: custErr?.message ?? "Kunde konnte nicht angelegt werden" },
          { status: 500 },
        );
      }
      effectiveCustomerId = newCust.id;
      customerCreated = true;
    }
  }

  // 3) job_type ableiten. Bei Freitext-Location (location_name ohne
  //    location_id) fahren wir immer 'extern' — auch wenn kein Kunde da
  //    ist. Sonst wuerden wir einen 'location'-Auftrag ohne location_id
  //    anlegen, was semantisch falsch waere.
  const hasLocationFreitext = !draft.location_id && draft.location_name?.trim();
  const jobType: "location" | "extern" =
    draft.location_id && !effectiveCustomerId ? "location" : "extern";

  const jobPayload = {
    title: draft.title,
    description: draft.description ?? draft.general_notes ?? null,
    status: "offen" as const,
    priority: "normal" as const,
    job_type: jobType,
    customer_id: jobType === "extern" ? effectiveCustomerId : null,
    location_id: draft.location_id ?? null,
    room_id: draft.room_id ?? null,
    // Freitext-Location landet hier — es wird bewusst KEINE locations-Row
    // erzeugt (Leo 2026-09-06). Bei ausgewaehlter Location bleibt das Feld leer.
    external_address: hasLocationFreitext ? draft.location_name!.trim() : null,
    start_date: draft.expected_start_date ?? null,
    end_date: draft.expected_end_date ?? null,
    guest_count: draft.guest_count ?? null,
    contact_person: draft.contact_person ?? null,
    contact_phone: draft.contact_phone ?? null,
    contact_email: draft.contact_email ?? null,
    created_by: auth.user.id,
  };

  const { data: newJob, error: jobErr } = await admin
    .from("jobs")
    .insert(jobPayload)
    .select("id, job_number")
    .single();
  if (jobErr || !newJob) {
    return NextResponse.json(
      { success: false, error: jobErr?.message ?? "Auftrag konnte nicht angelegt werden" },
      { status: 500 },
    );
  }

  // 4) Draft archivieren (status=umgewandelt + Verweis auf den neuen Job)
  const { error: updateErr } = await admin
    .from("job_drafts")
    .update({
      status: "umgewandelt",
      converted_to_job_id: newJob.id,
      converted_at: new Date().toISOString(),
    })
    .eq("id", draftId);
  if (updateErr) {
    // Best-effort rollback: den frisch angelegten Job wieder als deleted
    // markieren, sonst haben wir einen Auftrag ohne Draft-Backlink. Wir
    // melden den Original-Fehler — den Rollback-Fehler (falls einer) nur
    // loggen, damit der Nutzer nicht doppelt verwirrt wird (Audit-Finding).
    const { error: rollbackErr } = await admin
      .from("jobs")
      .update({ is_deleted: true })
      .eq("id", newJob.id);
    if (rollbackErr) {
      logError("entwuerfe.convert.rollback", rollbackErr, {
        draftId,
        jobId: newJob.id,
        originalError: updateErr.message,
      });
    }
    return NextResponse.json({ success: false, error: updateErr.message }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    jobId: newJob.id,
    jobNumber: newJob.job_number,
    // Client kann eine "Kunde XY neu angelegt"-Toast zeigen wenn erwuenscht.
    customerCreated,
    redirectUrl: `/auftraege/${newJob.id}`,
  });
}
