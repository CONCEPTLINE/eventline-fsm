import { NextResponse } from "next/server";
import { getConnection } from "@/lib/bexio";
import { requireUser } from "@/lib/api-auth";

// Status fuer das Frontend: Ist Bexio verbunden? Wer hat es verbunden, wann?
// Token selbst NIE rausgeben — nur Metadaten.
//
// Auth-Check: nur fuer eingeloggte User.
export async function GET() {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const conn = await getConnection();
  if (!conn) {
    return NextResponse.json({ connected: false });
  }
  return NextResponse.json({
    connected: true,
    connectedAt: conn.connected_at,
    bexioEmail: conn.bexio_user_email,
    expiresAt: conn.expires_at,
    features: {
      contacts: conn.feature_contacts,
    },
  });
}
