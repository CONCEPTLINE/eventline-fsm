// GET  /api/bildschirm/session — ist dieser Browser als Bildschirm verbunden?
// DELETE /api/bildschirm/session — Bildschirm trennen (Session widerrufen,
// Cookie loeschen). Beides oeffentlich, wirkt nur auf das eigene Cookie.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { BILDSCHIRM_COOKIE, bildschirmSession } from "@/lib/bildschirm";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const s = await bildschirmSession(req);
  return NextResponse.json({ success: true, aktiv: !!s }, { headers: { "Cache-Control": "no-store" } });
}

export async function DELETE(req: NextRequest) {
  const s = await bildschirmSession(req);
  if (s) {
    await createAdminClient().from("bildschirm_sessions").update({ revoked_at: new Date().toISOString() }).eq("id", s.id);
  }
  const res = NextResponse.json({ success: true });
  res.cookies.set(BILDSCHIRM_COOKIE, "", { path: "/", maxAge: 0, expires: new Date(0) });
  return res;
}
