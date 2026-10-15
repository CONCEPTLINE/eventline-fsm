// /api/entwuerfe/[id]/notizen — Neue Notiz zu einem Draft anhaengen.
//
// Die chronologische Historie (Anrufe, Mails, Meetings, generelle Notizen)
// haengt an job_draft_notes. Autor wird server-seitig aus der Session
// gezogen — Client kann keinen fremden Autor injecten.

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { entwurfArchiviert, ENTWURF_ARCHIV_MELDUNG } from "@/lib/archiv";
import { archivAntwort } from "@/lib/archiv-server";

type NoteKind = "notiz" | "anruf" | "mail" | "meeting";
const ALLOWED_KINDS: NoteKind[] = ["notiz", "anruf", "mail", "meeting"];

interface Body {
  kind?: NoteKind;
  body?: string;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if (auth.error) return auth.error;
  const { id: draftId } = await params;

  const body = (await req.json().catch(() => null)) as Body | null;
  const text = body?.body?.trim();
  if (!text) {
    return NextResponse.json({ success: false, error: "Notiz-Text fehlt" }, { status: 400 });
  }
  const kind: NoteKind = body?.kind && ALLOWED_KINDS.includes(body.kind) ? body.kind : "notiz";

  const supabase = await createClient();

  // Existiert der Draft und ist er nicht soft-geloescht? Sonst kein
  // Notiz-Anhaengen (sonst waeren Notizen zu Ghost-Drafts moeglich).
  const { data: draft, error: draftErr } = await supabase
    .from("job_drafts")
    .select("id, status")
    .eq("id", draftId)
    .eq("is_deleted", false)
    .maybeSingle();
  if (draftErr) return NextResponse.json({ success: false, error: draftErr.message }, { status: 500 });
  if (!draft) return NextResponse.json({ success: false, error: "Entwurf nicht gefunden" }, { status: 404 });
  // Archiv = nur lesen (src/lib/archiv.ts): keine neuen Notizen an
  // stornierten/umgewandelten Entwuerfen.
  if (entwurfArchiviert(draft.status as string)) return archivAntwort(ENTWURF_ARCHIV_MELDUNG);

  const { data, error } = await supabase
    .from("job_draft_notes")
    .insert({
      draft_id: draftId,
      // dev-mode: effective user
      author_id: auth.effectiveUserId,
      kind,
      body: text,
    })
    .select("id, draft_id, author_id, kind, body, created_at")
    .single();

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, note: data });
}
