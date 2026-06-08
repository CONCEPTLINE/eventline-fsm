// POST /api/hr/wage-documents/generate/bulk
// Body: { profile_ids: string[], year, month, overwrite_manual?: boolean }
//
// Generiert sequentiell PDF-Lohnabrechnungen fuer mehrere Mitarbeiter.
// Returnt eine summary pro profile_id: ok / skipped / error.
// Admin-only.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";

interface BulkResult {
  profile_id: string;
  ok: boolean;
  mode?: string;
  error?: string;
}

export async function POST(req: Request) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ success: false, error: "Body fehlt" }, { status: 400 });
  const profileIds = Array.isArray(body.profile_ids) ? body.profile_ids.filter((x: unknown) => typeof x === "string") : [];
  const year = Number(body.year);
  const month = Number(body.month);
  const overwriteManual = body.overwrite_manual === true;
  if (profileIds.length === 0) return NextResponse.json({ success: false, error: "profile_ids leer" }, { status: 400 });
  if (profileIds.length > 100) return NextResponse.json({ success: false, error: "Max 100 Mitarbeiter pro Bulk-Request" }, { status: 400 });
  if (!Number.isInteger(year) || year < 2020 || year > 2100) return NextResponse.json({ success: false, error: "year ungueltig" }, { status: 400 });
  if (!Number.isInteger(month) || month < 1 || month > 12) return NextResponse.json({ success: false, error: "month ungueltig" }, { status: 400 });

  // Sequentiell rufen — jspdf-Generation ist schon CPU-intensiv,
  // parallel waere fuer den Node-Worker zu viel.
  const origin = new URL(req.url).origin;
  const cookieHeader = req.headers.get("cookie") ?? "";
  const results: BulkResult[] = [];
  for (const profileId of profileIds) {
    try {
      const res = await fetch(`${origin}/api/hr/wage-documents/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieHeader },
        body: JSON.stringify({ profile_id: profileId, year, month, overwrite_manual: overwriteManual }),
      });
      const j = await res.json();
      if (j.success) results.push({ profile_id: profileId, ok: true, mode: j.mode });
      else results.push({ profile_id: profileId, ok: false, error: j.error });
    } catch (e) {
      results.push({ profile_id: profileId, ok: false, error: e instanceof Error ? e.message : "Netzwerkfehler" });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  return NextResponse.json({
    success: true,
    total: results.length,
    ok: okCount,
    failed: results.length - okCount,
    results,
  });
}
