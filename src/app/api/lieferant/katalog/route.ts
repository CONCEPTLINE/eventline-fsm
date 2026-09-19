// GET /api/lieferant/katalog — liefert dem eingeloggten LIEFERANTEN-Portal-
// User die signed URL seines Firmen-Mietkatalogs (PDF im documents-Bucket).
// Absichtlich server-seitig mit Admin-Client: der Lieferant braucht so
// keinerlei Storage-Rechte. Zugriff strikt auf die EIGENE Firma begrenzt.
// Auch Staff (Admin, View-As) darf abrufen — dann via ?lieferant_id=.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api-auth";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(req: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role, lieferant_id, is_active")
    .eq("id", auth.effectiveUserId)
    .maybeSingle();
  if (!profile || profile.is_active === false) {
    return NextResponse.json({ success: false, error: "Kein Zugriff" }, { status: 403 });
  }

  // Lieferant: immer die eigene Firma. Admin/Staff: via Query-Param
  // (z.B. Vorschau aus den Einstellungen).
  let lieferantId: string | null = null;
  if (profile.role === "lieferant") {
    lieferantId = profile.lieferant_id;
  } else if (profile.role === "admin") {
    const q = req.nextUrl.searchParams.get("lieferant_id");
    lieferantId = q && UUID_RE.test(q) ? q : null;
  }
  if (!lieferantId) {
    return NextResponse.json({ success: false, error: "Kein Zugriff" }, { status: 403 });
  }

  const { data: firma } = await admin
    .from("lieferanten")
    .select("katalog_path, katalog_name, katalog_updated_at")
    .eq("id", lieferantId)
    .maybeSingle();

  // Produktbild-URLs fuer alle Artikel der Firma (Batch-Signierung; der
  // Portal-User hat bewusst keinerlei direkte Storage-Rechte).
  const bilder: Record<string, string> = {};
  const { data: artikel } = await admin
    .from("lieferant_katalog_artikel")
    .select("id, bild_path")
    .eq("lieferant_id", lieferantId)
    .not("bild_path", "is", null);
  if (artikel?.length) {
    const paths = artikel.map((a) => a.bild_path as string);
    const { data: signedList } = await admin.storage.from("documents").createSignedUrls(paths, 3600);
    for (let i = 0; i < artikel.length; i++) {
      const s = signedList?.[i];
      if (s?.signedUrl && !s.error) bilder[artikel[i].id] = s.signedUrl;
    }
  }

  let pdfUrl: string | null = null;
  if (firma?.katalog_path) {
    const { data: signed } = await admin.storage.from("documents").createSignedUrl(firma.katalog_path, 3600);
    pdfUrl = signed?.signedUrl ?? null;
  }

  return NextResponse.json({
    success: true,
    url: pdfUrl,
    name: firma?.katalog_name ?? null,
    updated_at: firma?.katalog_updated_at ?? null,
    bilder,
  });
}
