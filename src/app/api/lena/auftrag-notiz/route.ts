// POST /api/lena/auftrag-notiz — legt eine Text-Notiz im Eingang eines Auftrags ab.
//   Body { auftrag_nr: "INT-26292" | 26292, text }
//   → { ok, text: "Notiz bei INT-<n> «<Auftragstitel>» abgelegt." }
// Eine Zeile in job_inbox_items wie die Eingang-Erfassung im Auftrag
// (src/components/auftrag/eingang/eingang-erfassung.tsx): kind "text",
// content = Text, created_by = Profil, ai_status "neu".
//
// absender bleibt bewusst LEER: die Eingang-Verarbeitung
// (src/lib/ai/eingang-verarbeitung.ts, eingangBloecke) liest ein gesetztes
// absender als «per Mail von …» (= fremder Absender, moegliche
// Kundenaussage). Ohne absender sieht die KI «intern vom EVENTLINE-Team
// erfasst» — genau das ist ein Diktat von Leo. Die App zeigt beim Element
// ohnehin den Namen aus created_by an; die Herkunft «Telefon» steht in
// lena_protokoll.
//
// Die KI-Verarbeitung wird hier NICHT angestossen: die Notiz bleibt auf
// «neu» und wird wie jedes haengengebliebene Element verarbeitet, sobald der
// Auftrag geoeffnet wird (Selbstheilung im Eingang-Tab, aelteste zuerst,
// seriell). So wartet Lena nicht minutenlang am Telefon, und es laufen keine
// zwei Verarbeitungen desselben Auftrags parallel.
// Archivierte Auftraege werden abgelehnt. Nur Anlegen — nie aendern/loeschen.

import type { NextRequest } from "next/server";
import { LENA_DOPPEL_FENSTER_MS, lenaAbgelehnt, lenaAndereMethoden, lenaAuftragZumSchreiben, lenaPost } from "@/lib/lena/server";
import { NOTIZ_MAX, parseAuftragNr, textFeld } from "@/lib/lena/eingabe";
import { TEXT, notizAbgelegtText } from "@/lib/lena/texte";
import { formatJobNumber } from "@/lib/nummern-format";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const ENDPUNKT = "auftrag-notiz";

export async function POST(request: NextRequest) {
  return lenaPost(request, ENDPUNKT, async ({ admin, userId, body, jetztMs }) => {
    const nr = parseAuftragNr(body.auftrag_nr);
    if (nr.art === "fehlt") return lenaAbgelehnt(TEXT.auftragNrFehlt, "Auftragsnummer fehlt");
    const notiz = textFeld(body.text, NOTIZ_MAX, true);
    if (notiz.art === "leer") return lenaAbgelehnt(TEXT.notizFehlt, "Notiz leer");
    if (notiz.art === "zu_lang") return lenaAbgelehnt(TEXT.notizZuLang, "Notiz zu lang");

    const a = await lenaAuftragZumSchreiben(admin, nr);
    if (!a.ok) return a.ergebnis;
    const { auftrag } = a;
    const label = formatJobNumber(auftrag.nummer);

    // Doppel-Schutz (Wiederholung desselben Aufrufs durch Bland).
    const { data: schon, error: schonFehler } = await admin
      .from("job_inbox_items")
      .select("id")
      .eq("job_id", auftrag.id)
      .eq("kind", "text")
      .eq("created_by", userId)
      .eq("content", notiz.wert)
      .gte("created_at", new Date(jetztMs - LENA_DOPPEL_FENSTER_MS).toISOString())
      .limit(1);
    if (schonFehler) throw new Error(`job_inbox_items: ${schonFehler.code ?? schonFehler.message}`);
    if (schon && schon.length > 0) {
      return {
        antwort: { ok: true, text: notizAbgelegtText({ nummer: auftrag.nummer, jobTitel: auftrag.titel, schonVorhanden: true }) },
        ergebnis: `Notiz schon vorhanden ${schon[0].id} bei ${label}`,
      };
    }

    const { data: neu, error } = await admin
      .from("job_inbox_items")
      .insert({
        job_id: auftrag.id,
        kind: "text",
        content: notiz.wert,
        created_by: userId,
        absender: null,
        ai_status: "neu",
      })
      .select("id")
      .single();
    if (error) throw new Error(`job_inbox_items insert: ${error.code ?? error.message}`);
    return {
      antwort: { ok: true, text: notizAbgelegtText({ nummer: auftrag.nummer, jobTitel: auftrag.titel }) },
      ergebnis: `Notiz abgelegt ${neu.id} bei ${label}`,
    };
  });
}

const andere = lenaAndereMethoden(ENDPUNKT);
export const GET = andere.GET;
export const PUT = andere.PUT;
export const PATCH = andere.PATCH;
export const DELETE = andere.DELETE;
export const HEAD = andere.HEAD;
export const OPTIONS = andere.OPTIONS;
