import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/api-auth";
import { logError } from "@/lib/log";

// POST /api/jobs/{id}/mark-invoice-skipped — Auftrag als "Rechnung
// nicht gestellt" markieren mit Begruendung. Job verschwindet danach
// aus der Abrechnungs-Liste, taucht aber im Job-Detail mit dem Grund
// auf (damit nachvollziehbar bleibt warum keine Rechnung).
//
// Permission: abrechnung:edit (Admins haben automatisch durch).
//
// Validation:
//   - reason: nicht leer, max 500 Zeichen.
//   - Job muss existieren, status='abgeschlossen', noch nicht abgerechnet
//     und noch nicht als skipped markiert.

interface Body {
  reason?: unknown;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requirePermission("abrechnung:edit");
  if (auth.error) return auth.error;
  const { id } = await params;

  const body = (await request.json().catch(() => null)) as Body | null;
  const raw = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!raw) {
    return NextResponse.json({ success: false, error: "Begründung ist Pflicht" }, { status: 400 });
  }
  if (raw.length > 500) {
    return NextResponse.json({ success: false, error: "Begründung zu lang (max 500 Zeichen)" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: existing } = await admin
    .from("jobs")
    .select("id, status, invoiced_at, invoice_skipped_at, is_deleted")
    .eq("id", id)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ success: false, error: "Auftrag nicht gefunden" }, { status: 404 });
  }
  if (existing.is_deleted) {
    return NextResponse.json({ success: false, error: "Auftrag ist gelöscht" }, { status: 400 });
  }
  if (existing.status !== "abgeschlossen") {
    return NextResponse.json({ success: false, error: "Auftrag ist nicht abgeschlossen" }, { status: 400 });
  }
  if (existing.invoiced_at) {
    return NextResponse.json({ success: false, error: "Auftrag wurde bereits als abgerechnet markiert" }, { status: 400 });
  }
  if (existing.invoice_skipped_at) {
    return NextResponse.json({ success: false, error: "Auftrag wurde bereits als 'nicht zu stellen' markiert" }, { status: 400 });
  }

  const { error } = await admin
    .from("jobs")
    .update({
      invoice_skipped_at: new Date().toISOString(),
      invoice_skipped_reason: raw,
      invoice_skipped_by: auth.user.id,
    })
    .eq("id", id);

  if (error) {
    logError("api.jobs.mark-invoice-skipped", error, { userId: auth.user.id, jobId: id });
    return NextResponse.json({ success: false, error: "Speichern fehlgeschlagen" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
