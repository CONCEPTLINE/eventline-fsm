// GET /api/lieferant/katalog — der Mietkatalog einer Lieferanten-Firma als
// Daten: aktive Artikel (Whitelist-Felder), signierte Produktbild-URLs und
// die signierte URL des Original-PDFs. Admin-Client: der Portal-User braucht
// so weder Storage-Rechte noch Leserechte auf lieferanten bzw.
// lieferant_katalog_artikel.
//
//   ohne Parameter         → Lieferantenportal: Katalog der EIGENEN Firma
//                            (requireLieferantPortal; «Ansicht als» liefert
//                            den Katalog der angesehenen Person)
//   ?lieferant_id=<uuid>   → interner Staff (Katalog-Fenster auf /lieferanten),
//                            Recht lieferanten:view (Admins via has_permission)

import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/api-auth";
import { requireLieferantPortal } from "@/lib/technik-server";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Gueltigkeit der signierten URLs (eine Sitzung am Katalog). */
const URL_GUELTIG_S = 3600;
const fehler = (msg: string, status: number) => NextResponse.json({ success: false, error: msg }, { status });

export async function GET(req: NextRequest) {
  const param = req.nextUrl.searchParams.get("lieferant_id");
  let admin: SupabaseClient;
  let lieferantId: string;
  if (param !== null) {
    if (!UUID_RE.test(param)) return fehler("Ungültige Anfrage", 400);
    const auth = await requirePermission("lieferanten:view");
    if (auth.error) return auth.error;
    admin = createAdminClient();
    lieferantId = param;
  } else {
    const gate = await requireLieferantPortal();
    if (gate.error) return gate.error;
    admin = gate.admin;
    lieferantId = gate.lieferantId;
  }

  const [firmaRes, artikelRes] = await Promise.all([
    admin.from("lieferanten").select("katalog_path").eq("id", lieferantId).maybeSingle(),
    admin
      .from("lieferant_katalog_artikel")
      .select("id, hauptkategorie, kategorie, name, beschreibung, inhalt, preis_chf, preis_text, bild_path")
      .eq("lieferant_id", lieferantId)
      .eq("is_active", true)
      .order("sort")
      .order("id"),
  ]);
  if (firmaRes.error || artikelRes.error) {
    logError("api.lieferant.katalog", firmaRes.error ?? artikelRes.error, { lieferantId });
    return fehler("Katalog konnte nicht geladen werden", 500);
  }
  if (!firmaRes.data) return fehler("Lieferant nicht gefunden", 404);

  const zeilen = (artikelRes.data ?? []) as {
    id: string; hauptkategorie: string; kategorie: string; name: string; beschreibung: string | null;
    inhalt: string | null; preis_chf: number | null; preis_text: string | null; bild_path: string | null;
  }[];

  // Produktbilder in EINEM Aufruf signieren. Fehler hier sind nicht fatal —
  // die Artikel-Liste funktioniert auch ohne Bilder (Platzhalter).
  const bilder: Record<string, string> = {};
  const pfade = Array.from(new Set(zeilen.map((a) => a.bild_path).filter((p): p is string => !!p)));
  if (pfade.length) {
    const { data: signiert, error } = await admin.storage.from("documents").createSignedUrls(pfade, URL_GUELTIG_S);
    if (error) logError("api.lieferant.katalog.bilder", error, { lieferantId });
    const urlZuPfad = new Map<string, string>();
    for (const s of signiert ?? []) if (s.path && s.signedUrl && !s.error) urlZuPfad.set(s.path, s.signedUrl);
    for (const a of zeilen) {
      const url = a.bild_path ? urlZuPfad.get(a.bild_path) : undefined;
      if (url) bilder[a.id] = url;
    }
  }

  let pdfUrl: string | null = null;
  if (firmaRes.data.katalog_path) {
    const { data: signiert, error } = await admin.storage.from("documents").createSignedUrl(firmaRes.data.katalog_path, URL_GUELTIG_S);
    if (error) logError("api.lieferant.katalog.pdf", error, { lieferantId });
    pdfUrl = signiert?.signedUrl ?? null;
  }

  return NextResponse.json(
    {
      success: true,
      pdf_url: pdfUrl,
      // Whitelist ohne Storage-Pfad (der Client bekommt nur signierte URLs).
      artikel: zeilen.map((a) => ({
        id: a.id, hauptkategorie: a.hauptkategorie, kategorie: a.kategorie, name: a.name,
        beschreibung: a.beschreibung, inhalt: a.inhalt, preis_chf: a.preis_chf, preis_text: a.preis_text,
      })),
      bilder,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
