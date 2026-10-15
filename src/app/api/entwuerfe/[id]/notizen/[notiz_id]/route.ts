// /api/entwuerfe/[id]/notizen/[notiz_id] — Notiz loeschen.
//
// Hart-Delete: die Notizen-Historie ist kein Rechnungs-relevantes Konstrukt,
// deshalb ist ein echtes Delete OK. RLS bestimmt wer loeschen darf
// (auftraege:edit). Wir stellen zusaetzlich sicher dass die Notiz zum
// angegebenen Draft gehoert (Guard gegen URL-Manipulation).

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { archivAntwortAusFehler } from "@/lib/archiv-server";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string; notiz_id: string }> },
) {
  const auth = await requireUser();
  if (auth.error) return auth.error;
  const { id: draftId, notiz_id: noteId } = await params;

  const supabase = await createClient();
  const { error, count } = await supabase
    .from("job_draft_notes")
    .delete({ count: "exact" })
    .eq("id", noteId)
    .eq("draft_id", draftId);

  if (error) {
    // Archivierter Entwurf (Migration 342, PT409) → 409 mit der DB-Meldung.
    return archivAntwortAusFehler(error) ?? NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
  if (count === 0) return NextResponse.json({ success: false, error: "Notiz nicht gefunden" }, { status: 404 });
  return NextResponse.json({ success: true });
}
