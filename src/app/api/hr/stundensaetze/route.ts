// GET /api/hr/stundensaetze?ids=<uuid,uuid,…>
// → { saetze: { [profile_id]: kosten_chf_h heute },
//     verlauf: { [profile_id]: [{ gueltig_ab, kosten_chf_h }] } }
//
// Für die Kosten auf der Projekt-Seite: Kosten-Stundensätze aus Trust flow
// (personal_saetze, Lohn neu Phase 1b; src/lib/personal-saetze.ts). `saetze`
// nennt nur Personen mit einem heute gültigen Satz (ohne Satz = fehlt);
// `verlauf` erlaubt der Seite, Stunden am Stempel-Tag zu bewerten. Nur
// Kosten-Sätze, nie Netto. Nur mit Lohnrecht UND vertrautem Gerät (wie die
// Finanzen) — sonst 403, die Seite zeigt dann keine Kosten.

import { NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { LOHN_RECHT } from "@/lib/lohn/zugriff";
import { ladeSatzVerlauf, satzAm } from "@/lib/personal-saetze";
import { isUuid } from "@/lib/search-escape";
import { todayLocalIso } from "@/lib/swiss-time";

export async function GET(request: Request) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  const ids = (new URL(request.url).searchParams.get("ids") ?? "").split(",").filter(isUuid).slice(0, 500);
  if (ids.length === 0) return NextResponse.json({ success: true, saetze: {}, verlauf: {} });

  try {
    const heute = todayLocalIso();
    const verlauf = await ladeSatzVerlauf(createAdminClient(), ids, "kosten", heute);
    const saetze: Record<string, number> = {};
    const verlaufJson: Record<string, { gueltig_ab: string; kosten_chf_h: number | null }[]> = {};
    for (const [pid, zeilen] of verlauf) {
      verlaufJson[pid] = zeilen.map((z) => ({ gueltig_ab: z.gueltig_ab, kosten_chf_h: z.satz }));
      const satz = satzAm(verlauf, pid, heute);
      if (satz !== null) saetze[pid] = satz;
    }
    return NextResponse.json({ success: true, saetze, verlauf: verlaufJson });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Stundensätze konnten nicht geladen werden";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
