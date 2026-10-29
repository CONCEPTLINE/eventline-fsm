// POST /api/lena/todo-erstellen — legt EIN To-do fuer das Lena-Profil an.
//   Body { titel, faellig_am?: YYYY-MM-DD, prioritaet?: "normal" | "dringend", beschreibung? }
//   → { ok, text: "To-do gespeichert: …" }
// Eine Zeile in todos wie die To-do-Seite sie anlegt
// (src/app/(app)/todos/page.tsx, createTodo): status "offen",
// assigned_to = created_by = Profil. Die *_name-Spalten bleiben leer wie in
// der UI (sie werden erst beim Loeschen eines Profils befuellt, Migration 222).
// Nur Anlegen — nie aendern/loeschen.

import type { NextRequest } from "next/server";
import { LENA_DOPPEL_FENSTER_MS, lenaAbgelehnt, lenaAndereMethoden, lenaPost } from "@/lib/lena/server";
import { BESCHREIBUNG_MAX, faelligPruefen, prioritaetPruefen, textFeld, titelPruefen } from "@/lib/lena/eingabe";
import { TEXT, todoGespeichertText, vorlesbar } from "@/lib/lena/texte";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

const ENDPUNKT = "todo-erstellen";

export async function POST(request: NextRequest) {
  return lenaPost(request, ENDPUNKT, async ({ admin, userId, body, jetztMs }) => {
    const titel = titelPruefen(body.titel);
    if (!titel.ok) return lenaAbgelehnt(titel.text, "Titel ungueltig");
    const faellig = faelligPruefen(body.faellig_am, jetztMs);
    if (!faellig.ok) return lenaAbgelehnt(faellig.text, "Faelligkeit ungueltig");
    const prioritaet = prioritaetPruefen(body.prioritaet);
    if (!prioritaet.ok) return lenaAbgelehnt(prioritaet.text, "Prioritaet ungueltig");
    const beschreibung = textFeld(body.beschreibung, BESCHREIBUNG_MAX, true);
    if (beschreibung.art === "zu_lang") return lenaAbgelehnt(TEXT.beschreibungZuLang, "Beschreibung zu lang");

    const dueDate = faellig.wert?.datum ?? null;
    const text = (schonVorhanden: boolean) =>
      todoGespeichertText({
        titel: vorlesbar(titel.wert, 100),
        faelligMs: faellig.wert?.ms ?? null,
        dringend: prioritaet.wert === "dringend",
        schonVorhanden,
        jetztMs,
      });

    // Doppel-Schutz (Wiederholung desselben Aufrufs durch Bland).
    let doppelt = admin
      .from("todos")
      .select("id")
      .eq("assigned_to", userId)
      .eq("created_by", userId)
      .eq("title", titel.wert)
      .eq("status", "offen")
      .is("deleted_at", null)
      .gte("created_at", new Date(jetztMs - LENA_DOPPEL_FENSTER_MS).toISOString())
      .limit(1);
    doppelt = dueDate ? doppelt.eq("due_date", dueDate) : doppelt.is("due_date", null);
    const { data: schon, error: schonFehler } = await doppelt;
    if (schonFehler) throw new Error(`todos: ${schonFehler.code ?? schonFehler.message}`);
    if (schon && schon.length > 0) {
      return { antwort: { ok: true, text: text(true) }, ergebnis: `To-do schon vorhanden ${schon[0].id}` };
    }

    const { data: neu, error } = await admin
      .from("todos")
      .insert({
        title: titel.wert,
        description: beschreibung.art === "ok" ? beschreibung.wert : null,
        status: "offen",
        priority: prioritaet.wert,
        due_date: dueDate,
        assigned_to: userId,
        created_by: userId,
      })
      .select("id")
      .single();
    if (error) throw new Error(`todos insert: ${error.code ?? error.message}`);
    return { antwort: { ok: true, text: text(false) }, ergebnis: `To-do angelegt ${neu.id}` };
  });
}

const andere = lenaAndereMethoden(ENDPUNKT);
export const GET = andere.GET;
export const PUT = andere.PUT;
export const PATCH = andere.PATCH;
export const DELETE = andere.DELETE;
export const HEAD = andere.HEAD;
export const OPTIONS = andere.OPTIONS;
