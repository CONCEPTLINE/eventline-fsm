// GET /api/trust/confirm?token=...
//
// Alter Bestaetigungs-Link aus Mails VOR dem Lohn-Umbau Phase 1. Er gibt
// NICHT mehr frei (frueher: Oeffnen = Freigabe, ohne Anmeldung). Ein noch
// offener Link fuehrt jetzt auf die Freigabe-Seite in der App
// (/geraet-freigabe?id=…), wo der andere Admin bzw. die Vertretung angemeldet
// per Knopf entscheidet (innerhalb von 24 h ab Anfrage).

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { hashToken } from "@/lib/api-auth";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  if (!token) return redirectToResult(request, "missing");

  const { data: row, error } = await createAdminClient()
    .from("trusted_devices")
    .select("id, device_name, status")
    .eq("confirm_token_hash", hashToken(token))
    .maybeSingle();
  if (error || !row) return redirectToResult(request, "invalid");
  if (row.status === "approved") return redirectToResult(request, "already", row.device_name);
  if (row.status === "revoked") return redirectToResult(request, "revoked", row.device_name);

  const url = new URL("/geraet-freigabe", request.url);
  url.searchParams.set("id", row.id as string);
  return NextResponse.redirect(url, { status: 302 });
}

function redirectToResult(request: NextRequest, status: string, deviceName?: string) {
  const url = new URL("/trust/result", request.url);
  url.searchParams.set("status", status);
  if (deviceName) url.searchParams.set("device", deviceName);
  return NextResponse.redirect(url, { status: 302 });
}
