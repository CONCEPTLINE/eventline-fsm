// POST /api/auftrag-mails/[id] — eine wartende Auftrags-Mail erledigen.
//   { aktion: "zuordnen", job_id }  → Text + Anhaenge in den Eingang des
//                                     Auftrags, danach KI-Verarbeitung wie
//                                     beim automatischen Ablegen
//   { aktion: "verwerfen" }         → Mail gehoert zu keinem Auftrag;
//                                     Inhalt + Anhaenge werden geloescht
// Recht auftraege:see-all (Admin immer). Doppelklick/zwei Admins
// gleichzeitig: der Statuswechsel 'wartet' → … ist atomar, der zweite
// bekommt 409.

import { after, NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import {
  ladeWarteAnhaenge,
  legeImAuftragAb,
  loescheWarteAnhaenge,
  verarbeiteElemente,
  type WarteAnhang,
} from "@/lib/auftrag-mail/server";

export const maxDuration = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Erledigt = {
  id: string;
  resend_email_id: string;
  absender: string | null;
  betreff: string | null;
  inhalt: string | null;
  anhaenge: WarteAnhang[] | null;
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission("auftraege:see-all");
  if (auth.error) return auth.error;
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ success: false, error: "Ungültige Anfrage" }, { status: 400 });

  let body: { aktion?: string; job_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Ungültige Anfrage" }, { status: 400 });
  }
  const admin = createAdminClient();
  const jetzt = new Date().toISOString();
  const spalten = "id, resend_email_id, absender, betreff, inhalt, anhaenge";
  const schonErledigt = NextResponse.json({ success: false, error: "Diese Mail wurde inzwischen schon erledigt." }, { status: 409 });

  if (body.aktion === "verwerfen") {
    const { data, error } = await admin
      .from("auftrag_mails")
      .update({ status: "verworfen", erledigt_von: auth.effectiveUserId, erledigt_am: jetzt, updated_at: jetzt })
      .eq("id", id)
      .eq("status", "wartet")
      .select(spalten);
    if (error) return NextResponse.json({ success: false, error: "Verwerfen fehlgeschlagen: " + error.message }, { status: 500 });
    const row = (data?.[0] ?? null) as Erledigt | null;
    if (!row) return schonErledigt;
    await loescheWarteAnhaenge(admin, row.anhaenge ?? []);
    await admin.from("auftrag_mails").update({ inhalt: null, anhaenge: [] }).eq("id", id);
    return NextResponse.json({ success: true });
  }

  if (body.aktion !== "zuordnen" || !body.job_id || !UUID_RE.test(body.job_id)) {
    return NextResponse.json({ success: false, error: "Ungültige Anfrage" }, { status: 400 });
  }
  const jobId = body.job_id;
  const { data: job } = await admin.from("jobs").select("id, job_number").eq("id", jobId).not("is_deleted", "is", true).maybeSingle();
  if (!job) return NextResponse.json({ success: false, error: "Auftrag nicht gefunden" }, { status: 404 });

  const { data, error } = await admin
    .from("auftrag_mails")
    .update({ status: "zugeordnet", job_id: jobId, zuordnung: "manuell", erledigt_von: auth.effectiveUserId, erledigt_am: jetzt, updated_at: jetzt })
    .eq("id", id)
    .eq("status", "wartet")
    .select(spalten);
  if (error) return NextResponse.json({ success: false, error: "Zuordnen fehlgeschlagen: " + error.message }, { status: 500 });
  const row = (data?.[0] ?? null) as Erledigt | null;
  if (!row) return schonErledigt;

  const startZeit = Date.now();
  let itemIds: string[];
  try {
    const anhaenge = await ladeWarteAnhaenge(admin, row.anhaenge ?? []);
    itemIds = await legeImAuftragAb({
      admin,
      jobId,
      resendEmailId: row.resend_email_id,
      von: row.absender ?? "",
      betreff: row.betreff ?? "",
      text: row.inhalt ?? "",
      anhaenge,
      startZeit,
    });
  } catch (e) {
    // Zurueck auf «wartet» — nichts geht verloren, der Admin kann es nochmals versuchen.
    logError("auftrag-mail.zuordnen", e);
    await admin
      .from("auftrag_mails")
      .update({ status: "wartet", job_id: null, zuordnung: null, erledigt_von: null, erledigt_am: null, updated_at: new Date().toISOString() })
      .eq("id", id);
    return NextResponse.json({ success: false, error: "Ablegen fehlgeschlagen — die Mail wartet weiter. Bitte nochmals versuchen." }, { status: 500 });
  }

  await loescheWarteAnhaenge(admin, row.anhaenge ?? []);
  await admin.from("auftrag_mails").update({ inhalt: null, anhaenge: [] }).eq("id", id);
  // KI-Verarbeitung nach der Antwort (kann Minuten dauern); was nicht mehr
  // reinpasst, verarbeitet der Eingang-Tab beim naechsten Oeffnen.
  after(() => verarbeiteElemente(admin, jobId, itemIds, Date.now()).then(() => undefined));
  return NextResponse.json({ success: true, job_number: (job as { job_number: number }).job_number });
}
