// GET /api/hr/wage-documents/[id] → signed download URL (5min)
// DELETE /api/hr/wage-documents/[id] → admin only, removes row + storage

import { NextResponse } from "next/server";
import { requireUser, requireAdmin } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const BUCKET = "lohndokumente";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if (auth.error) return auth.error;
  const { id } = await params;

  // RLS auf wage_documents stellt sicher dass User nur eigene + Admin alle laden kann
  const supabase = await createClient();
  const { data: doc, error } = await supabase
    .from("wage_documents")
    .select("storage_path, doc_type, year, period_month")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  if (!doc) return NextResponse.json({ success: false, error: "Nicht gefunden" }, { status: 404 });

  const admin = createAdminClient();
  const { data: signed, error: signErr } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(doc.storage_path, 300); // 5 min
  if (signErr || !signed) return NextResponse.json({ success: false, error: signErr?.message ?? "Signing failed" }, { status: 500 });

  const filename = doc.doc_type === "lohnabrechnung"
    ? `Lohnabrechnung_${doc.year}-${String(doc.period_month).padStart(2, "0")}.pdf`
    : `Lohnausweis_${doc.year}.pdf`;

  return NextResponse.json({ success: true, url: signed.signedUrl, filename });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const { id } = await params;

  const admin = createAdminClient();
  const { data: doc } = await admin
    .from("wage_documents")
    .select("storage_path")
    .eq("id", id)
    .maybeSingle();
  // Row ZUERST loeschen — falls Storage-Remove failed, ist die Row weg
  // und das File ist orphan (sichtbar ueber Storage-Cleanup), aber kein
  // dangling-Reference. Andersrum waere der User-Eintrag inkonsistent
  // wenn Storage already weg ist und Row-delete failed.
  const { error } = await admin.from("wage_documents").delete().eq("id", id);
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  if (doc?.storage_path) {
    // Best-effort — wenn fehlschlaegt, orphan im Bucket (kann via Cleanup-Job)
    const { error: stErr } = await admin.storage.from(BUCKET).remove([doc.storage_path]);
    if (stErr) {
      // Log silent — Row ist weg, das ist wichtig.
      console.warn("[wage-documents/delete] Storage-remove failed:", stErr.message);
    }
  }
  return NextResponse.json({ success: true });
}
