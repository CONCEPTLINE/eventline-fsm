// POST /api/bildschirm/verify { code } — Code pruefen, Bildschirm-Session
// anlegen und als langlebiges HttpOnly-Cookie setzen. Fehlversuche werden
// auf dem neuesten offenen Code gezaehlt; ab CODE_MAX_VERSUCHE ist er
// entwertet (6 Stellen + 10 Minuten + 6 Versuche = kein Durchprobieren).

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  BILDSCHIRM_COOKIE,
  CODE_MAX_VERSUCHE,
  cookieOptionen,
  hashGleich,
  hashWert,
  neuesToken,
} from "@/lib/bildschirm";
import { logError } from "@/lib/log";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const code = String(body?.code ?? "").replace(/\D/g, "");
  if (code.length !== 6) {
    return NextResponse.json({ success: false, error: "Bitte den 6-stelligen Code eingeben." }, { status: 400 });
  }
  const admin = createAdminClient();
  const nowIso = new Date().toISOString();
  const { data: offen, error } = await admin
    .from("bildschirm_codes")
    .select("id, code_hash, versuche")
    .is("used_at", null)
    .gt("expires_at", nowIso)
    .order("created_at", { ascending: false })
    .limit(3);
  if (error) {
    logError("bildschirm.verify.select", error);
    return NextResponse.json({ success: false, error: "Prüfung fehlgeschlagen." }, { status: 500 });
  }

  const h = hashWert(code);
  const treffer = (offen ?? []).find((c) => hashGleich(c.code_hash as string, h));
  if (!treffer) {
    const neuester = offen?.[0];
    if (neuester) {
      const versuche = (neuester.versuche as number) + 1;
      await admin
        .from("bildschirm_codes")
        .update({ versuche, ...(versuche >= CODE_MAX_VERSUCHE ? { used_at: nowIso } : {}) })
        .eq("id", neuester.id);
      const rest = CODE_MAX_VERSUCHE - versuche;
      return NextResponse.json(
        { success: false, error: rest > 0 ? `Code falsch — noch ${rest} Versuch${rest === 1 ? "" : "e"}.` : "Zu viele Fehlversuche — bitte einen neuen Code anfordern." },
        { status: 401 },
      );
    }
    return NextResponse.json({ success: false, error: "Kein gültiger Code — bitte neu anfordern." }, { status: 401 });
  }

  await admin.from("bildschirm_codes").update({ used_at: nowIso }).eq("id", treffer.id);
  const token = neuesToken();
  const { error: sessErr } = await admin.from("bildschirm_sessions").insert({
    token_hash: hashWert(token),
    user_agent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
    last_seen_at: nowIso,
  });
  if (sessErr) {
    logError("bildschirm.verify.session", sessErr);
    return NextResponse.json({ success: false, error: "Session konnte nicht angelegt werden." }, { status: 500 });
  }
  const res = NextResponse.json({ success: true });
  res.cookies.set(BILDSCHIRM_COOKIE, token, cookieOptionen());
  return res;
}
