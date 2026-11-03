// «Fragen an dich» — die eigenen Pflicht-Fragen und Antworten (Migration 381,
// Katalog src/lib/fragen/katalog.ts).
//
// GET   → { fragen: Frage[] (die für mich gelten), antworten: { [schluessel]: Antwort }, offen: string[] }
//         In «Ansicht als» nie fremde Fragen: { ansicht_als: true, fragen: [], antworten: {}, offen: [] }.
// POST { frage, antwort, text_version }
//       → neuer Eintrag im Verlauf (auch zum Ändern einer früheren Antwort). Nur die
//         Person selbst (nie «Ansicht als»), nur geltende Fragen, nur Optionen des
//         Katalogs, nur zur aktuellen Fassung des Texts (sonst 409: neu laden).
//
// Lesen und Schreiben mit der Sitzung der Person (RLS: nur eigene Zeilen, Insert
// nur «selbst»); der Admin-Client prüft nur Profil/Anstellung (wer gefragt wird).

import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { geltendeFragen } from "@/lib/fragen/server";
import { frageNach, istGueltigeAntwort, neuesteAntworten, offeneFragen, type AntwortZeile, type Frage } from "@/lib/fragen/katalog";

export const dynamic = "force-dynamic";

const KOPF = { "Cache-Control": "no-store" };

interface EigeneZeile extends AntwortZeile {
  quelle: string;
}

async function stand(profileId: string) {
  const fragen = await geltendeFragen(createAdminClient(), profileId);
  if (fragen.length === 0) return { fragen: [] as Frage[], antworten: {}, offen: [] as string[] };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("mitarbeiter_antworten")
    .select("profile_id, frage_schluessel, antwort, text_version, beantwortet_at, quelle")
    .eq("profile_id", profileId)
    .in("frage_schluessel", fragen.map((f) => f.schluessel))
    .order("beantwortet_at", { ascending: false })
    .limit(500);
  if (error) throw new Error(`Antworten konnten nicht geladen werden: ${error.message}`);
  const zeilen = (data ?? []) as EigeneZeile[];
  const neueste = neuesteAntworten(zeilen, fragen);
  const antworten = Object.fromEntries(
    [...neueste.values()].map((z) => [
      z.frage_schluessel,
      { antwort: z.antwort, text_version: z.text_version, beantwortet_at: z.beantwortet_at, quelle: z.quelle },
    ]),
  );
  return { fragen, antworten, offen: offeneFragen(fragen, zeilen).map((f) => f.schluessel) };
}

export async function GET() {
  const auth = await requireUser({ wartung: "lohn" });
  if (auth.error) return auth.error;
  if (auth.isImpersonating) {
    return NextResponse.json({ success: true, ansicht_als: true, fragen: [], antworten: {}, offen: [] }, { headers: KOPF });
  }
  try {
    return NextResponse.json({ success: true, ...(await stand(auth.user.id)) }, { headers: KOPF });
  } catch (e) {
    logError("api.profile.fragen.get", e);
    return NextResponse.json({ success: false, error: "Fragen konnten nicht geladen werden." }, { status: 500, headers: KOPF });
  }
}

export async function POST(req: Request) {
  const auth = await requireUser({ wartung: "lohn" });
  if (auth.error) return auth.error;
  if (auth.isImpersonating) {
    return NextResponse.json({ success: false, error: "Antworten gibt nur die Person selbst — nicht in «Ansicht als»." }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as { frage?: unknown; antwort?: unknown; text_version?: unknown } | null;
  const frage = typeof body?.frage === "string" ? frageNach(body.frage) : null;
  if (!frage) return NextResponse.json({ success: false, error: "Unbekannte Frage." }, { status: 400 });
  if (!istGueltigeAntwort(frage, body?.antwort)) return NextResponse.json({ success: false, error: "Bitte eine Antwort wählen." }, { status: 400 });
  if (body?.text_version !== frage.version) {
    return NextResponse.json({ success: false, code: "neue_fassung", error: "Die Frage wurde inzwischen geändert — bitte neu laden." }, { status: 409 });
  }

  try {
    const admin = createAdminClient();
    const gelten = await geltendeFragen(admin, auth.user.id);
    if (!gelten.some((f) => f.schluessel === frage.schluessel)) {
      return NextResponse.json({ success: false, error: "Diese Frage gilt nicht für dich." }, { status: 403 });
    }
    const { data: me } = await admin.from("profiles").select("full_name").eq("id", auth.user.id).maybeSingle();
    const supabase = await createClient();
    const { error } = await supabase.from("mitarbeiter_antworten").insert({
      profile_id: auth.user.id,
      frage_schluessel: frage.schluessel,
      antwort: body.antwort,
      text_version: frage.version,
      quelle: "selbst",
      akteur_name: ((me?.full_name as string | null) ?? null)?.slice(0, 200) ?? null,
    });
    if (error) throw new Error(`Antwort konnte nicht gespeichert werden: ${error.message}`);
    return NextResponse.json({ success: true, ...(await stand(auth.user.id)) }, { headers: KOPF });
  } catch (e) {
    logError("api.profile.fragen.post", e);
    return NextResponse.json({ success: false, error: "Antwort konnte nicht gespeichert werden." }, { status: 500, headers: KOPF });
  }
}
