// GET /api/trust/status
//
// Liefert dem Client ob das aktuelle Geraet vertraut ist. UI rendert
// damit den Trust-Gate (Prompt statt sensiblen Daten).
//
// Antwort: { trusted: boolean, pending: boolean, deviceName?: string }
//   • trusted=true  → Cookie matched eine approved-Zeile → freier Zugang
//   • pending=true  → Cookie matched eine pending-Zeile → "wartet auf Freigabe"
//                     (abgelaufen=true: aelter als 24 h → neu anfragen)
//   • beides false  → kein/ungueltiges Cookie → Trust-Prompt anzeigen

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser, hashToken, TRUSTED_DEVICE_COOKIE } from "@/lib/api-auth";
import { anfrageAbgelaufen, anfrageGueltigBis } from "@/lib/geraete-freigabe";

export async function GET() {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const cookieStore = await cookies();
  const cookie = cookieStore.get(TRUSTED_DEVICE_COOKIE);

  if (!cookie?.value) {
    return NextResponse.json({ success: true, trusted: false, pending: false });
  }

  const admin = createAdminClient();
  const tokenHash = hashToken(cookie.value);
  const { data: row } = await admin
    .from("trusted_devices")
    .select("id, status, device_name, expires_at, revoked_at, requested_at, anfrage_gueltig_bis")
    .eq("cookie_token_hash", tokenHash)
    .eq("user_id", auth.user.id)
    .maybeSingle();

  if (!row || row.revoked_at) {
    return NextResponse.json({ success: true, trusted: false, pending: false });
  }
  if (row.status === "approved") {
    const expired = row.expires_at && new Date(row.expires_at) < new Date();
    return NextResponse.json({ success: true, trusted: !expired, pending: false, deviceName: row.device_name });
  }
  if (row.status === "pending") {
    const abgelaufen = anfrageAbgelaufen(row);
    return NextResponse.json({
      success: true,
      trusted: false,
      pending: !abgelaufen,
      abgelaufen,
      deviceName: row.device_name,
      deviceId: row.id,
      gueltigBis: anfrageGueltigBis(row)?.toISOString() ?? null,
    });
  }
  return NextResponse.json({ success: true, trusted: false, pending: false });
}
