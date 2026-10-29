// GET /api/vertrieb/antworten?id=<kontakt-id>  (vertrieb:edit)
//
// Die Antworten eines Kampagnen-Kontakts LIVE aus Leos Postfach (Microsoft
// Graph) — Datum, Absender, Betreff, Text. Nichts davon wird gespeichert.
//
// Sicherheit (Audit K1): Geladen werden AUSSCHLIESSLICH die Mails, die der
// Abgleich selbst diesem Kontakt zugeordnet hat (antwort_graph_ids, nur vom
// Server beschreibbar). Keine freie Suche nach Absender oder Domain — so
// lässt sich über veränderte Kontaktdaten keine fremde Mail aus dem
// Postfach lesen. Recht vertrieb:edit (nicht schon vertrieb:view).

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/search-escape";
import { logError } from "@/lib/log";
import { GRAPH, PostfachFehler, graphGet, holeAccessToken } from "@/lib/vertrieb/m365";
import { antwortText } from "@/lib/vertrieb/antwort-text";
import type { KampagneAntwort } from "@/types/vertrieb";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_ANTWORTEN = 10;
const FELDER = "id,subject,from,receivedDateTime,uniqueBody,body";
/** Graph liefert Texte dann schon als reinen Text (HTML → Text serverseitig). */
const ALS_TEXT = { Prefer: 'outlook.body-content-type="text"' };
const KEIN_CACHE = { "Cache-Control": "no-store" };

type GraphBody = { contentType?: string; content?: string };
type GraphMail = {
  id: string;
  subject?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  receivedDateTime?: string;
  uniqueBody?: GraphBody;
  body?: GraphBody;
};

export async function GET(request: Request) {
  const auth = await requirePermission("vertrieb:edit");
  if (auth.error) return auth.error;

  const id = new URL(request.url).searchParams.get("id");
  if (!isUuid(id)) return NextResponse.json({ ok: false, fehler: "Ungültige Kontakt-ID" }, { status: 400 });

  const admin = createAdminClient();
  const { data: k, error } = await admin
    .from("vertrieb_kampagne_kontakte")
    .select("id, antwort_graph_ids")
    .eq("id", id)
    .maybeSingle();
  if (error) {
    logError("vertrieb-antworten", error);
    return NextResponse.json({ ok: false, fehler: "Kontakt nicht lesbar" }, { status: 500 });
  }
  if (!k) return NextResponse.json({ ok: false, fehler: "Kontakt nicht gefunden" }, { status: 404 });

  // Neueste zuerst (der Abgleich hängt hinten an).
  const ids = [...((k.antwort_graph_ids as string[] | null) ?? [])].reverse().slice(0, MAX_ANTWORTEN);
  if (ids.length === 0) return NextResponse.json({ ok: true, antworten: [] }, { headers: KEIN_CACHE });

  try {
    const token = await holeAccessToken(admin);
    const mails = await Promise.all(ids.map((mid) =>
      graphGet<GraphMail>(token, `${GRAPH}/me/messages/${encodeURIComponent(mid)}?$select=${FELDER}`, ALS_TEXT),
    ));
    const antworten: KampagneAntwort[] = mails
      .filter((m): m is GraphMail => !!m) // 404 = gelöscht/verschoben
      .sort((a, b) => Date.parse(b.receivedDateTime ?? "") - Date.parse(a.receivedDateTime ?? ""))
      .map((m) => ({
        id: m.id,
        betreff: m.subject ?? "",
        von: m.from?.emailAddress?.address ?? "",
        vonName: m.from?.emailAddress?.name ?? null,
        empfangenAm: m.receivedDateTime ?? "",
        text: antwortText(m.uniqueBody, m.body),
      }));
    return NextResponse.json({ ok: true, antworten }, { headers: KEIN_CACHE });
  } catch (e) {
    if (e instanceof PostfachFehler) {
      const fehler = e.code === "nicht_verbunden"
        ? "Postfach nicht verbunden"
        : e.code === "anmeldung"
          ? "Postfach muss neu verbunden werden"
          : e.message;
      return NextResponse.json({ ok: false, fehler }, { headers: KEIN_CACHE });
    }
    logError("vertrieb-antworten", e);
    return NextResponse.json({ ok: false, fehler: "Antworten konnten nicht geladen werden" }, { status: 500 });
  }
}
