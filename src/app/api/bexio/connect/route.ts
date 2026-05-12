import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getAuthorizeUrl } from "@/lib/bexio";
import { requireAdmin } from "@/lib/api-auth";

// Startet den OAuth-Flow: state generieren, in Cookie ablegen (httpOnly), dann
// per 302 zur Bexio-Authorize-URL weiterleiten. Der Callback prueft das
// state-Cookie und tauscht den Code gegen Tokens.
//
// requireAdmin: ohne Auth-Check koennte ein externer Angreifer den OAuth-Start
// triggern und durch Account-Linking-Attack das Bexio-Konto eines Beliebigen
// an die Eventline-Instanz binden. Bexio-Setup ist Admin-Vorbehalt.
export async function GET(_request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  // Env-Vars pruefen BEVOR wir die URL bauen — sonst landet der User auf
  // einer Bexio-Seite mit "client_id=undefined&redirect_uri=undefined" und
  // sieht eine kryptische "Client nicht gefunden"-Meldung. Klarer Fehler
  // hier zeigt sofort wo es haengt.
  if (!process.env.BEXIO_CLIENT_ID || !process.env.BEXIO_REDIRECT_URI) {
    return NextResponse.json(
      {
        success: false,
        error: "Bexio-Integration ist nicht konfiguriert. BEXIO_CLIENT_ID und BEXIO_REDIRECT_URI muessen in den Vercel-Environment-Variables gesetzt sein.",
      },
      { status: 500 },
    );
  }

  const state = randomBytes(32).toString("hex");
  const url = getAuthorizeUrl(state);

  const res = NextResponse.redirect(url, { status: 302 });
  res.cookies.set("bexio_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 600, // 10 Minuten — danach muss man's neu starten
  });
  return res;
}
