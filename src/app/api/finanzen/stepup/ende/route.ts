// POST /api/finanzen/stepup/ende
//
// Loescht das Step-up-Ticket (Cookie eventline_stepup, Pfad /api/finanzen).
// Der StepUpGate ruft das nach STEPUP_INAKTIV_MS ohne Eingabe auf /finanzen.
// requireUser genuegt: wer eingeloggt ist, darf sein eigenes Ticket
// jederzeit entwerten. (Logout/Inaktivitaet loeschen es zusaetzlich in
// /api/sessions/end.)

import { requireUser } from "@/lib/api-auth";
import { finanzenJson } from "@/lib/finanzen/auth";
import { stepUpCookieLoeschen } from "@/lib/finanzen/stepup";

export const dynamic = "force-dynamic";

export async function POST() {
  const auth = await requireUser();
  if (auth.error) return auth.error;
  const res = finanzenJson({ success: true });
  stepUpCookieLoeschen(res);
  return res;
}
