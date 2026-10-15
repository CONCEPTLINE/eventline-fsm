// /api/entwuerfe/[id] — Detail lesen, aendern, soft-loeschen.
//
// GET: Draft + zugehoerige Notizen (chronologisch neueste zuerst).
// PATCH: Teilweise Update (title, kunde, ort, datum, owner, status, notes ...).
// DELETE: Soft-Delete via is_deleted=true (Records leben weiter, tauchen
//         nur nicht mehr in Listen auf).

import { NextResponse } from "next/server";
import { requireUser, requirePermission } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { entwurfArchiviert, ENTWURF_ARCHIV_MELDUNG } from "@/lib/archiv";
import { archivAntwort, archivAntwortAusFehler } from "@/lib/archiv-server";

const DETAIL_SELECT = `
  id,
  draft_number,
  title,
  description,
  status,
  source,
  source_lead_id,
  customer_id,
  customer_name,
  contact_person,
  contact_email,
  contact_phone,
  location_id,
  location_name,
  room_id,
  expected_start_date,
  expected_end_date,
  guest_count,
  owner_id,
  general_notes,
  converted_to_job_id,
  converted_at,
  created_by,
  created_at,
  updated_at,
  customer:customers(id, name, email, phone),
  location:locations(id, name, address_street, address_zip, address_city),
  room:rooms(id, name),
  owner:profiles!job_drafts_owner_id_fkey(id, full_name)
`;

const NOTES_SELECT = `
  id,
  draft_id,
  author_id,
  kind,
  body,
  created_at,
  author:profiles!job_draft_notes_author_id_fkey(id, full_name)
`;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser();
  if (auth.error) return auth.error;
  const { id } = await params;

  const supabase = await createClient();
  const [draftRes, notesRes] = await Promise.all([
    supabase.from("job_drafts").select(DETAIL_SELECT).eq("id", id).eq("is_deleted", false).maybeSingle(),
    supabase.from("job_draft_notes").select(NOTES_SELECT).eq("draft_id", id).order("created_at", { ascending: false }),
  ]);
  if (draftRes.error) return NextResponse.json({ success: false, error: draftRes.error.message }, { status: 500 });
  if (!draftRes.data) return NextResponse.json({ success: false, error: "Entwurf nicht gefunden" }, { status: 404 });
  if (notesRes.error) return NextResponse.json({ success: false, error: notesRes.error.message }, { status: 500 });

  return NextResponse.json({ success: true, draft: draftRes.data, notes: notesRes.data ?? [] });
}

// PATCH — Nur die uebergebenen Felder werden geschrieben. Undefined
// heisst "nicht anfassen", null heisst "explizit leeren".
interface PatchBody {
  title?: string;
  description?: string | null;
  customer_id?: string | null;
  customer_name?: string | null;
  contact_person?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  location_id?: string | null;
  location_name?: string | null;
  room_id?: string | null;
  expected_start_date?: string | null;
  expected_end_date?: string | null;
  guest_count?: number | null;
  owner_id?: string | null;
  status?: "aktiv" | "wartet_auf_kunde" | "storniert" | "umgewandelt";
  general_notes?: string | null;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Write-Endpoint: requirePermission statt requireUser — verhindert dass
  // ein User ohne 'auftraege:edit' die RLS auf der DB-Seite selbst tragen
  // muss (defense-in-depth, konsistent mit /convert-Route).
  const auth = await requirePermission("auftraege:edit");
  if (auth.error) return auth.error;
  const { id } = await params;

  const body = (await req.json().catch(() => null)) as PatchBody | null;
  if (!body) return NextResponse.json({ success: false, error: "Payload fehlt" }, { status: 400 });

  const update: Record<string, unknown> = {};
  const keys: (keyof PatchBody)[] = [
    "title", "description",
    "customer_id", "customer_name",
    "contact_person", "contact_email", "contact_phone",
    "location_id", "location_name", "room_id",
    "expected_start_date", "expected_end_date",
    "guest_count", "owner_id",
    "status", "general_notes",
  ];
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(body, k)) {
      const v = body[k];
      // Leere Strings zu NULL — sonst landet " " ins Feld und die Owner-/Kunden-
      // Selects zeigen einen Platzhalter statt "leer".
      if (typeof v === "string" && v.trim() === "") update[k] = null;
      else update[k] = v;
    }
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ success: false, error: "Nichts zu aendern" }, { status: 400 });
  }

  const supabase = await createClient();

  // Archiv = nur lesen (src/lib/archiv.ts): stornierte/umgewandelte Entwuerfe
  // aendern sich nicht mehr — einzige Ausnahme ist «Wieder aktivieren»
  // (storniert → aktiv/wartet_auf_kunde, nur der Status). Die DB sperrt
  // zusaetzlich (Migration 342).
  const { data: vorher, error: vorherErr } = await supabase
    .from("job_drafts")
    .select("status")
    .eq("id", id)
    .eq("is_deleted", false)
    .maybeSingle();
  if (vorherErr) return NextResponse.json({ success: false, error: vorherErr.message }, { status: 500 });
  if (!vorher) return NextResponse.json({ success: false, error: "Entwurf nicht gefunden" }, { status: 404 });
  if (entwurfArchiviert(vorher.status as string)) {
    const nurStatus = Object.keys(update).length === 1 && "status" in update;
    const reaktivieren =
      nurStatus && vorher.status === "storniert" && (update.status === "aktiv" || update.status === "wartet_auf_kunde");
    if (!reaktivieren) return archivAntwort(ENTWURF_ARCHIV_MELDUNG);
  }

  const { error, count } = await supabase
    .from("job_drafts")
    .update(update, { count: "exact" })
    .eq("id", id)
    .eq("is_deleted", false);

  if (error) {
    return archivAntwortAusFehler(error) ?? NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
  if (count === 0) return NextResponse.json({ success: false, error: "Entwurf nicht gefunden" }, { status: 404 });
  return NextResponse.json({ success: true });
}

// DELETE — Soft-Delete. Kein Cascade an Notizen (die bleiben, Query filtert
// via join). Bewusst nicht hart geloescht damit versehentliches Loeschen
// via History-Log rueckgaengig gemacht werden kann.
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission("auftraege:edit");
  if (auth.error) return auth.error;
  const { id } = await params;

  const supabase = await createClient();
  const { error, count } = await supabase
    .from("job_drafts")
    .update({ is_deleted: true }, { count: "exact" })
    .eq("id", id)
    .eq("is_deleted", false);

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  if (count === 0) return NextResponse.json({ success: false, error: "Entwurf nicht gefunden" }, { status: 404 });
  return NextResponse.json({ success: true });
}
