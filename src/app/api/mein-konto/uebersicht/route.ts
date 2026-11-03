// GET /api/mein-konto/uebersicht — Zahlen fuer den Hub «Mein Konto».
//
// Antwort:
//   { anfragen: Anfrage[]        — die letzten drei (offene zuerst)
//     offen: number              — Anzahl offener Anfragen
//     minuten_monat: number      — gestempelte Minuten im laufenden Monat
//                                  (gleiche Regel wie Lohn: lib/lohn/stunden)
//     lohn_neu: number }         — bereitgestellte, noch nie geoeffnete
//                                  Lohndokumente (alle Jahre)
//
// Nur eigene Daten. «Ansicht als»: Anfragen und Stunden der angesehenen
// Person, Lohn nie (wie /api/hr/mein-lohn) → lohn_neu 0.

import { NextResponse } from "next/server";
import { requireInternal } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ladeAnfragen, zaehleOffeneAnfragen } from "@/lib/anfragen";
import { minutenJeMonat } from "@/lib/lohn/stunden";
import { lokalesDatum } from "@/lib/lohn/kern";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

async function lohnNeu(admin: ReturnType<typeof createAdminClient>, userId: string): Promise<number> {
  const { data: docs, error } = await admin
    .from("wage_documents")
    .select("id")
    .eq("profile_id", userId)
    .is("archived_at", null)
    .is("superseded_at", null);
  if (error) throw new Error(error.message);
  const ids = (docs ?? []).map((d) => d.id as string);
  if (ids.length === 0) return 0;
  const { count, error: zErr } = await admin
    .from("lohn_dokument_zustellung")
    .select("wage_document_id", { count: "exact", head: true })
    .in("wage_document_id", ids)
    .is("erstmals_geoeffnet_at", null);
  if (zErr) throw new Error(zErr.message);
  return count ?? 0;
}

export async function GET() {
  const auth = await requireInternal();
  if (auth.error) return auth.error;
  const ich = auth.effectiveUserId;
  const admin = createAdminClient();
  try {
    const jetzt = Date.now();
    const monat = lokalesDatum(jetzt).slice(0, 7);
    const [jahr, mon] = monat.split("-").map(Number);
    // Sicher alle Stempel des Monats (Ortszeit): ab 2 Tage vor dem 1. (UTC).
    const von = new Date(Date.UTC(jahr, mon - 1, -1)).toISOString();

    const [alle, offen, stempel, neu] = await Promise.all([
      ladeAnfragen(admin, ich, { stand: "alle", limit: 10 }),
      zaehleOffeneAnfragen(admin, ich),
      admin.from("time_entries").select("clock_in, clock_out").eq("user_id", ich).gte("clock_in", von).limit(2000),
      auth.isImpersonating ? Promise.resolve(0) : lohnNeu(admin, ich),
    ]);
    if (stempel.error) throw new Error(stempel.error.message);

    const minuten = minutenJeMonat(
      ((stempel.data ?? []) as { clock_in: string; clock_out: string | null }[]).map((s) => ({ start: s.clock_in, ende: s.clock_out })),
    ).get(monat) ?? 0;

    // Offene zuerst, dann die neuesten — drei Stueck.
    const anfragen = [...alle.filter((a) => a.offen), ...alle.filter((a) => !a.offen)].slice(0, 3);

    return NextResponse.json(
      { success: true, anfragen, offen, minuten_monat: minuten, lohn_neu: neu },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    logError("api.mein-konto.uebersicht", e, { userId: ich });
    return NextResponse.json({ success: false, error: "Übersicht konnte nicht geladen werden" }, { status: 500 });
  }
}
