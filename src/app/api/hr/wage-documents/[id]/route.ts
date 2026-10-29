// GET    /api/hr/wage-documents/[id] → signierter Download-Link (5 min)
//          - eigene gültige Dokumente: jeder Mitarbeiter (nicht in «Ansicht als»)
//          - alle anderen: Lohnrecht + vertrautes Gerät
// DELETE /api/hr/wage-documents/[id] → in den PAPIERKORB (archivieren).
//          Body optional { grund }. Nie endgültig löschen: Zeile und Datei
//          bleiben, jede Aktion steht im Protokoll (lohn_dokument_protokoll).
//          Lohnrecht + vertrautes Gerät.
// Wiederherstellen: POST ./wiederherstellen

import { NextResponse } from "next/server";
import { requireUser, requireTrustedDevice, pruefeVertrautesGeraet } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { protokolliereZugriff, geraetHashAusCookies } from "@/lib/finanzen/zugriffe";
import { ZUGRIFF_AKTION } from "@/lib/finanzen/types";
import { EIGENE_DOKUMENTE_VERBOTEN, LOHN_BUCKET } from "@/lib/lohn/fassung";
import { LOHN_RECHT } from "@/lib/lohn/zugriff";
import { isUuid } from "@/lib/search-escape";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser({ wartung: "lohn" });
  if (auth.error) return auth.error;
  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ success: false, error: "Nicht gefunden" }, { status: 404 });

  const admin = createAdminClient();
  const { data: doc, error } = await admin
    .from("wage_documents")
    .select("storage_path, doc_type, year, period_month, profile_id, version, archived_at, superseded_at")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  if (!doc) return NextResponse.json({ success: false, error: "Nicht gefunden" }, { status: 404 });

  const eigenes = doc.profile_id === auth.user.id && !auth.isImpersonating && !doc.archived_at && !doc.superseded_at;
  if (!eigenes) {
    // Fremdes (oder eigenes archiviertes/ersetztes) Dokument: Lohnrecht + Gerät.
    const supabase = await createClient();
    const { data: recht, error: rErr } = await supabase.rpc("has_permission", { perm: LOHN_RECHT });
    if (rErr || recht !== true) return NextResponse.json({ success: false, error: "Nicht gefunden" }, { status: 404 });
    if ((await pruefeVertrautesGeraet(auth.user.id)) !== "vertraut") {
      return NextResponse.json({ success: false, error: "device_not_trusted", message: "Dieses Geraet ist nicht als vertraut markiert." }, { status: 403 });
    }
    await protokolliereZugriff({ actorProfileId: auth.user.id, bereich: "lohn", aktion: ZUGRIFF_AKTION.LOHN_DOKUMENT_LINK, zielProfileId: doc.profile_id as string, geraetHash: await geraetHashAusCookies(), details: { doc_type: doc.doc_type as string, jahr: doc.year as number } });
  }

  const { data: signed, error: signErr } = await admin.storage.from(LOHN_BUCKET).createSignedUrl(doc.storage_path as string, 300);
  if (signErr || !signed) return NextResponse.json({ success: false, error: signErr?.message ?? "Signing failed" }, { status: 500 });

  const fassung = Number(doc.version ?? 1) > 1 ? `_Fassung${doc.version}` : "";
  const filename = doc.doc_type === "lohnabrechnung"
    ? `Lohnabrechnung_${doc.year}-${String(doc.period_month).padStart(2, "0")}${fassung}.pdf`
    : `Lohnausweis_${doc.year}${fassung}.pdf`;

  return NextResponse.json({ success: true, url: signed.signedUrl, filename });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
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
  const { error } = await admin.rpc("lohn_dokument_archivieren", {
    p_id: id,
    p_actor: auth.user.id,
    p_actor_name: (me?.full_name as string | null) ?? null,
    p_grund: grund,
  });
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 });
  return NextResponse.json({ success: true });
}
