// POST /api/lena/termin-erstellen — legt EINEN Termin fuer das Lena-Profil an.
//   Body { titel, start: ISO, ende?: ISO, auftrag_nr?: "INT-26292" | 26292 }
//   (ohne Zeitzone = Schweizer Zeit; ende fehlt → 1 Stunde)
//   → { ok, text: "Termin gespeichert: …" }
// Eine Zeile in job_appointments wie die Kalender-/Auftrags-UI sie anlegt
// (src/components/kalender/neuer-termin-modal.tsx): title = Titel wie
// gesprochen, job_id = Auftrag (oder null), assigned_to = Profil,
// zeit_modus "fix". Die INT-Nummer steht NICHT im Titel — der Kalender zeigt
// sie aus job_id selbst an (sonst stuende sie doppelt da).
// Archivierte Auftraege werden abgelehnt. Nur Anlegen — nie aendern/loeschen.

import type { NextRequest } from "next/server";
import { LENA_DOPPEL_FENSTER_MS, lenaAbgelehnt, lenaAndereMethoden, lenaAuftragZumSchreiben, lenaPost, type LenaAuftrag } from "@/lib/lena/server";
import { parseAuftragNr, terminZeitenPruefen, titelPruefen } from "@/lib/lena/eingabe";
import { terminGespeichertText, vorlesbar } from "@/lib/lena/texte";
import { formatZeitraum } from "@/lib/lena/zeit";
import { formatJobNumber } from "@/lib/nummern-format";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const ENDPUNKT = "termin-erstellen";

export async function POST(request: NextRequest) {
  return lenaPost(request, ENDPUNKT, async ({ admin, userId, body, jetztMs }) => {
    const titel = titelPruefen(body.titel);
    if (!titel.ok) return lenaAbgelehnt(titel.text, "Titel ungueltig");
    const zeiten = terminZeitenPruefen(body.start, body.ende, jetztMs);
    if (!zeiten.ok) return lenaAbgelehnt(zeiten.text, "Zeit ungueltig");
    const { startMs, endeMs } = zeiten.wert;

    // auftrag_nr ohne Ziffern (fehlt, leer, «keine») = Termin ohne Auftrag.
    let auftrag: LenaAuftrag | null = null;
    const nr = parseAuftragNr(body.auftrag_nr);
    if (nr.art !== "fehlt") {
      const a = await lenaAuftragZumSchreiben(admin, nr);
      if (!a.ok) return a.ergebnis;
      auftrag = a.auftrag;
    }

    const startIso = new Date(startMs).toISOString();
    const endeIso = new Date(endeMs).toISOString();
    const text = (schonVorhanden: boolean) =>
      terminGespeichertText({
        titel: vorlesbar(titel.wert, 100),
        zeit: formatZeitraum(startMs, endeMs, jetztMs),
        auftrag: auftrag ? { nummer: auftrag.nummer, titel: auftrag.titel } : null,
        schonVorhanden,
      });
    const bei = auftrag ? ` bei ${formatJobNumber(auftrag.nummer)}` : "";

    // Doppel-Schutz (Wiederholung desselben Aufrufs durch Bland).
    let doppelt = admin
      .from("job_appointments")
      .select("id")
      .eq("assigned_to", userId)
      .eq("title", titel.wert)
      .eq("start_time", startIso)
      .eq("end_time", endeIso)
      .gte("created_at", new Date(jetztMs - LENA_DOPPEL_FENSTER_MS).toISOString())
      .limit(1);
    doppelt = auftrag ? doppelt.eq("job_id", auftrag.id) : doppelt.is("job_id", null);
    const { data: schon, error: schonFehler } = await doppelt;
    if (schonFehler) throw new Error(`job_appointments: ${schonFehler.code ?? schonFehler.message}`);
    if (schon && schon.length > 0) {
      return { antwort: { ok: true, text: text(true) }, ergebnis: `Termin schon vorhanden ${schon[0].id}${bei}` };
    }

    const { data: neu, error } = await admin
      .from("job_appointments")
      .insert({
        job_id: auftrag?.id ?? null,
        title: titel.wert,
        start_time: startIso,
        end_time: endeIso,
        assigned_to: userId,
        zeit_modus: "fix",
      })
      .select("id")
      .single();
    if (error) throw new Error(`job_appointments insert: ${error.code ?? error.message}`);
    return { antwort: { ok: true, text: text(false) }, ergebnis: `Termin angelegt ${neu.id}${bei}` };
  });
}

const andere = lenaAndereMethoden(ENDPUNKT);
export const GET = andere.GET;
export const PUT = andere.PUT;
export const PATCH = andere.PATCH;
export const DELETE = andere.DELETE;
export const HEAD = andere.HEAD;
export const OPTIONS = andere.OPTIONS;
