// POST /api/hr/wage-documents/[id]/wiederherstellen — Dokument aus dem
// Papierkorb zurückholen. Protokolliert (lohn_dokument_protokoll). Abgelehnt,
// wenn es für den Zeitraum schon eine gültige Fassung gibt.
// Lohnrecht + vertrautes Gerät.

import { NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { LOHN_RECHT } from "@/lib/lohn/zugriff";
import { EIGENE_DOKUMENTE_VERBOTEN } from "@/lib/lohn/fassung";
import { isUuid } from "@/lib/search-escape";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ success: false, error: "Nicht gefunden" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as { grund?: unknown } | null;
  const grund = typeof body?.grund === "string" ? body.grund.trim().slice(0, 500) : null;

  const admin = createAdminClient();
  const { data: doc, error: docErr } = await admin.from("wage_documents").select("profile_id").eq("id", id).maybeSingle();
  if (docErr) return NextResponse.json({ success: false, error: docErr.message }, { status: 500 });
  if (!doc) return NextResponse.json({ success: false, error: "Nicht gefunden" }, { status: 404 });
  if (doc.profile_id === auth.user.id) return NextResponse.json({ success: false, error: EIGENE_DOKUMENTE_VERBOTEN }, { status: 403 });
  const { data: me, error: meErr } = await admin.from("profiles").select("full_name").eq("id", auth.user.id).maybeSingle();
  if (meErr) return NextResponse.json({ success: false, error: meErr.message }, { status: 500 });
  const { error } = await admin.rpc("lohn_dokument_wiederherstellen", {
    p_id: id,
    p_actor: auth.user.id,
    p_actor_name: (me?.full_name as string | null) ?? null,
    p_grund: grund,
  });
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 });
  return NextResponse.json({ success: true });
}
