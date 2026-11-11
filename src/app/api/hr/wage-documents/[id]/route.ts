// GET    /api/hr/wage-documents/[id] → signierter Download-Link (5 min)
//          - eigene gültige Dokumente: jeder Mitarbeiter (nicht in «Ansicht als»)
//            → zählt als «geöffnet» (Zustellnachweis, Phase 4); Abrufe durch
//            die Lohnverwaltung oder in «Ansicht als» zählen nie
//          - alle anderen: Lohnrecht + vertrautes Gerät

import { NextResponse } from "next/server";
import { requireUser, requireTrustedDevice, pruefeVertrautesGeraet } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { protokolliereZugriff, geraetHashAusCookies } from "@/lib/finanzen/zugriffe";
import { ZUGRIFF_AKTION } from "@/lib/finanzen/types";
import { EIGENE_DOKUMENTE_VERBOTEN, LOHN_BUCKET } from "@/lib/lohn/fassung";
import { LOHN_RECHT } from "@/lib/lohn/zugriff";
import { isUuid } from "@/lib/search-escape";
import { zaehleGeoeffnet } from "@/lib/lohn/zustellung";

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
  // Die Person selbst hat ihr Dokument geöffnet (nie die Lohnverwaltung).
  if (eigenes) await zaehleGeoeffnet(admin, id, auth.user.id);

  const fassung = Number(doc.version ?? 1) > 1 ? `_Fassung${doc.version}` : "";
  const filename = doc.doc_type === "lohnabrechnung"
    ? `Lohnabrechnung_${doc.year}-${String(doc.period_month).padStart(2, "0")}${fassung}.pdf`
    : `Lohnausweis_${doc.year}${fassung}.pdf`;

  return NextResponse.json({ success: true, url: signed.signedUrl, filename });
}
