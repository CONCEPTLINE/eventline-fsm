// POST /api/vertrieb/wochenpaket/<id>  { aktion: "freigeben" | "streichen" }  (vertrieb:edit)
//
// Freigabe einer Mail aus dem Wochenpaket (Leos Entscheid «Weg 1»,
// 09.11.2026): Das FSM SENDET NICHTS. Es setzt nur den Status. Der Mac holt
// freigegebene Mails ab (~/EVENTLINE_Steuerung/fsm_freigabe_abholen.py),
// prüft sie nochmals (Prüfer, Sperrliste, Opt-out, schon angeschrieben,
// höchstens 10) und plant sie bei Microsoft ein — Absender leo@.
//
// Wer darf: vertrieb:edit. Weil die Mail in Leos Namen rausgeht, ist die
// Freigabe beim Ansehen-als (Impersonation) gesperrt — es zählt nur, wer
// selbst angemeldet ist. Übergang nur aus «offen» (atomar über den Filter
// status = offen), danach ändert nur noch der Mac den Status.

import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/search-escape";
import { todayLocalIso } from "@/lib/swiss-time";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission("vertrieb:edit");
  if (auth.error) return auth.error;
  if (auth.isImpersonating) {
    return NextResponse.json({ ok: false, error: "Freigabe nur im eigenen Konto, nicht beim Ansehen-als" }, { status: 403 });
  }
  const { id } = await ctx.params;
  if (!isUuid(id)) return NextResponse.json({ ok: false, error: "Ungültige ID" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as { aktion?: unknown } | null;
  const aktion = body?.aktion;
  if (aktion !== "freigeben" && aktion !== "streichen") {
    return NextResponse.json({ ok: false, error: "Unbekannte Aktion" }, { status: 400 });
  }

  const admin = createAdminClient();
  const patch = aktion === "freigeben"
    ? { status: "freigegeben", freigegeben_von: auth.effectiveUserId, freigegeben_am: new Date().toISOString() }
    : { status: "gestrichen" };
  const { data, error } = await admin
    .from("vertrieb_wochenpaket_mails")
    .update(patch)
    .eq("id", id)
    .eq("status", "offen")
    .select("id, kw, haus_id, an")
    .maybeSingle();
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ ok: false, error: "Mail ist nicht mehr offen (schon freigegeben, gestrichen oder eingeplant)" }, { status: 409 });

  if (data.haus_id) {
    const { error: vErr } = await admin.from("vertrieb_haus_verlauf").insert({
      haus_id: data.haus_id,
      datum: todayLocalIso(),
      art: "notiz",
      titel: aktion === "freigeben" ? `Wochenpaket ${data.kw}: Mail freigegeben` : `Wochenpaket ${data.kw}: Mail gestrichen`,
      text: aktion === "freigeben" ? `An ${data.an}. Der Mac plant sie bei Microsoft ein.` : `An ${data.an}. Wird nicht gesendet.`,
      ton: aktion === "freigeben" ? "gruen" : "neutral",
      erstellt_von: auth.effectiveUserId,
    });
    if (vErr) return NextResponse.json({ ok: true, warnung: `Verlauf nicht geschrieben: ${vErr.message}` });
  }
  return NextResponse.json({ ok: true });
}
