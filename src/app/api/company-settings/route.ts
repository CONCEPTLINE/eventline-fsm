// Firmen-Stammdaten (Singleton).
//
// GET   — alle eingeloggten User (u.a. UI-Firma-Tab zeigt sie readonly wenn nicht admin).
// PATCH — Admin-only (RLS erzwingt es zusaetzlich, aber wir gaten frueh).
//
// Bewusst kein POST/DELETE — die Row ist ein Singleton (id='default').

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, requireUser } from "@/lib/api-auth";
import { loadCompanySettings } from "@/lib/company-settings";

export async function GET() {
  const auth = await requireUser();
  if (auth.error) return auth.error;
  const admin = createAdminClient();
  const settings = await loadCompanySettings(admin);
  return NextResponse.json({ success: true, settings });
}

const FIELDS = ["name", "street", "zip", "city", "country", "phone", "email", "website", "uid_number", "iban"] as const;

export async function PATCH(request: Request) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ success: false, error: "Body fehlt" }, { status: 400 });
  }

  const patch: Record<string, string> = {};
  for (const f of FIELDS) {
    const v = (body as Record<string, unknown>)[f];
    if (typeof v !== "string") continue;
    if (v.length > 300) {
      return NextResponse.json({ success: false, error: `${f} zu lang (max 300 Zeichen)` }, { status: 400 });
    }
    patch[f] = v.trim();
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ success: false, error: "Keine Felder zum Speichern" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("company_settings")
    .update({ ...patch, updated_at: new Date().toISOString(), updated_by: auth.user.id })
    .eq("id", "default");
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });

  const settings = await loadCompanySettings(admin);
  return NextResponse.json({ success: true, settings });
}
