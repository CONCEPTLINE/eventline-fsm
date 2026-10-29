// GET /api/vertrieb/antworten?id=<kontakt-id>  (vertrieb:view)
//
// Die Antworten eines Kampagnen-Kontakts LIVE aus Leos Postfach (Microsoft
// Graph) — Datum, Absender, Betreff, Text. Nichts davon wird gespeichert.
// Zuordnung wie beim Abgleich (antwortZuordnung in mail-sync.ts): exakte
// Adresse oder eindeutige Nicht-Gratis-Domain, nur nach dem Versand, nie
// intern, keine Auto-Antworten/Unzustellbares.
//
// Laden: zuerst gezielt die zuletzt erkannte Antwort (letzte_antwort_graph_id),
// dann je bekannter Adresse gefiltert; findet das nichts (oder lehnt Graph
// den Filter ab), Rückfall auf den Posteingang seit dem Versand.

import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/search-escape";
import { logError } from "@/lib/log";
import { GRAPH, PostfachFehler, graphGet, graphSeiten, holeAccessToken, odataText, odataZeit } from "@/lib/vertrieb/m365";
import { ladeKontakte } from "@/lib/vertrieb/mail-sync-lauf";
import { adresse, antwortZuordnung, istIntern, type EingangsMail } from "@/lib/vertrieb/mail-sync";
import { antwortText } from "@/lib/vertrieb/antwort-text";
import type { KampagneAntwort } from "@/types/vertrieb";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_ANTWORTEN = 10;
const FELDER = "id,subject,from,receivedDateTime,uniqueBody,body";
/** Graph liefert Texte dann schon als reinen Text (HTML → Text serverseitig). */
const ALS_TEXT = { Prefer: 'outlook.body-content-type="text"' };

type GraphBody = { contentType?: string; content?: string };
type GraphMail = {
  id: string;
  subject?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  receivedDateTime?: string;
  uniqueBody?: GraphBody;
  body?: GraphBody;
};

const alsEingang = (m: GraphMail): EingangsMail => ({
  id: m.id,
  betreff: m.subject ?? "",
  von: m.from?.emailAddress?.address ?? "",
  empfangenAm: m.receivedDateTime ?? "",
});

export async function GET(request: Request) {
  const auth = await requirePermission("vertrieb:view");
  if (auth.error) return auth.error;

  const id = new URL(request.url).searchParams.get("id");
  if (!isUuid(id)) return NextResponse.json({ ok: false, fehler: "Ungültige Kontakt-ID" }, { status: 400 });

  const admin = createAdminClient();
  const { data: k, error } = await admin
    .from("vertrieb_kampagne_kontakte")
    .select("id, email, mail_an, mail_gesendet_am, letzte_antwort_graph_id, antworten_anzahl")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ ok: false, fehler: "Kontakt nicht lesbar" }, { status: 500 });
  if (!k) return NextResponse.json({ ok: false, fehler: "Kontakt nicht gefunden" }, { status: 404 });
  if (!k.mail_gesendet_am) return NextResponse.json({ ok: true, antworten: [] });

  try {
    // Alle angeschriebenen Kontakte — für die Regel «Domain nur wenn eindeutig».
    const kontakte = await ladeKontakte(admin);
    const zuordnen = antwortZuordnung(kontakte.filter((x) => x.mail_gesendet_am));
    const gehoertDazu = (m: GraphMail) => zuordnen(alsEingang(m)).some((x) => x.id === id);

    const token = await holeAccessToken(admin);
    const gefunden = new Map<string, GraphMail>();
    const adressen = new Set([adresse(k.mail_an), adresse(k.email)].filter((a) => a && !istIntern(a)));

    // 1. Gezielt: die zuletzt erkannte Antwort.
    if (k.letzte_antwort_graph_id) {
      const m = await graphGet<GraphMail>(
        token,
        `${GRAPH}/me/messages/${encodeURIComponent(k.letzte_antwort_graph_id)}?$select=${FELDER}`,
        ALS_TEXT,
      );
      if (m && gehoertDazu(m)) {
        gefunden.set(m.id, m);
        const von = adresse(m.from?.emailAddress?.address);
        if (von) adressen.add(von);
      }
    }

    // 2. Je Adresse gefiltert.
    let filterAbgelehnt = false;
    for (const a of adressen) {
      const filter = encodeURIComponent(
        `from/emailAddress/address eq ${odataText(a)} and receivedDateTime ge ${odataZeit(k.mail_gesendet_am)}`,
      );
      try {
        const rows = await graphSeiten<GraphMail>(
          token,
          `${GRAPH}/me/mailFolders/inbox/messages?$select=${FELDER}&$filter=${filter}&$top=25`,
          2,
          ALS_TEXT,
        );
        for (const m of rows) if (gehoertDazu(m)) gefunden.set(m.id, m);
      } catch (e) {
        if (!(e instanceof PostfachFehler) || e.code !== "graph") throw e;
        filterAbgelehnt = true;
        break;
      }
    }

    // 3. Rückfall: Posteingang seit dem Versand durchsehen (nur Kopfdaten),
    //    Treffer danach einzeln mit Text laden.
    if (gefunden.size === 0 && (k.antworten_anzahl > 0 || filterAbgelehnt)) {
      const filter = encodeURIComponent(`receivedDateTime ge ${odataZeit(k.mail_gesendet_am)}`);
      const kopf = await graphSeiten<GraphMail>(
        token,
        `${GRAPH}/me/mailFolders/inbox/messages?$select=id,subject,from,receivedDateTime&$filter=${filter}&$top=100`,
        20,
      );
      const treffer = kopf.filter(gehoertDazu)
        .sort((a, b) => Date.parse(b.receivedDateTime ?? "") - Date.parse(a.receivedDateTime ?? ""))
        .slice(0, MAX_ANTWORTEN);
      for (const t of treffer) {
        const m = await graphGet<GraphMail>(token, `${GRAPH}/me/messages/${encodeURIComponent(t.id)}?$select=${FELDER}`, ALS_TEXT);
        if (m) gefunden.set(m.id, m);
      }
    }

    const antworten: KampagneAntwort[] = [...gefunden.values()]
      .sort((a, b) => Date.parse(b.receivedDateTime ?? "") - Date.parse(a.receivedDateTime ?? ""))
      .slice(0, MAX_ANTWORTEN)
      .map((m) => ({
        id: m.id,
        betreff: m.subject ?? "",
        von: m.from?.emailAddress?.address ?? "",
        vonName: m.from?.emailAddress?.name ?? null,
        empfangenAm: m.receivedDateTime ?? "",
        text: antwortText(m.uniqueBody, m.body),
      }));
    return NextResponse.json({ ok: true, antworten }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof PostfachFehler) {
      const fehler = e.code === "nicht_verbunden"
        ? "Postfach nicht verbunden"
        : e.code === "anmeldung"
          ? "Postfach muss neu verbunden werden (Lesezugriff fehlt oder ist abgelaufen)"
          : e.message;
      return NextResponse.json({ ok: false, fehler }, { headers: { "Cache-Control": "no-store" } });
    }
    logError("vertrieb-antworten", e);
    return NextResponse.json({ ok: false, fehler: "Antworten konnten nicht geladen werden" }, { status: 500 });
  }
}
