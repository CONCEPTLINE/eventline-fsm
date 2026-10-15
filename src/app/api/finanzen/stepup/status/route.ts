// GET /api/finanzen/stepup/status
//
// Liefert dem StepUpGate, ob fuer diesen Admin auf diesem Geraet ein
// gueltiges Step-up-Ticket vorliegt (Muster /api/trust/status: immer
// success:true, die Entscheidung steckt in `bestaetigt`/`grund`).
//
//   • Guard requireAdminTrustedDevice("finanzen:view") — Fehler 1:1
//     (Nicht-Admin → 403 «Nur fuer Administratoren» OHNE Gate-Slug → der
//     Gate zeigt den Endzustand «Nur Administratoren»).
//   • «Ansicht als» → bestaetigt:false, grund:"impersonation" (kein Formular).
//   • passkeys = Anzahl registrierter Passkeys → Passkey-Knopf anzeigen?

import { cookies } from "next/headers";
import { requireAdminTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { finanzenJson } from "@/lib/finanzen/auth";
import { pruefeStepUpTicket } from "@/lib/finanzen/stepup";
import { geraetHashAusCookies } from "@/lib/finanzen/zugriffe";
import { FINANZEN_CACHE_CONTROL, FINANZEN_PERMISSION, STEPUP_COOKIE, type StepUpStatusAntwort } from "@/lib/finanzen/types";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireAdminTrustedDevice(FINANZEN_PERMISSION);
  if (auth.error) {
    auth.error.headers.set("Cache-Control", FINANZEN_CACHE_CONTROL);
    return auth.error;
  }

  if (auth.isImpersonating) {
    const antwort: StepUpStatusAntwort = { success: true, bestaetigt: false, bisUnix: null, passkeys: 0, grund: "impersonation" };
    return finanzenJson(antwort);
  }

  const { count } = await createAdminClient()
    .from("user_passkeys")
    .select("id", { count: "exact", head: true })
    .eq("user_id", auth.user.id);

  const geraetHash = await geraetHashAusCookies();
  const ticket = (await cookies()).get(STEPUP_COOKIE)?.value;
  const p = pruefeStepUpTicket(ticket, auth.user.id, geraetHash);

  const antwort: StepUpStatusAntwort = {
    success: true,
    bestaetigt: p.ok,
    bisUnix: p.ok ? p.claims.exp : null,
    passkeys: count ?? 0,
    grund: p.ok ? null : p.grund,
  };
  return finanzenJson(antwort);
}
