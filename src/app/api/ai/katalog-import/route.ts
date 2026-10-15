// POST /api/ai/katalog-import — liest das hinterlegte Katalog-PDF einer
// Lieferanten-Firma CHUNK-WEISE (Seitenbereiche via pdf-lib) mit der KI ein
// und AKTUALISIERT lieferant_katalog_artikel (Migration 332).
//
// Chunk-Design statt Ein-Schuss: 80-Seiten-Kataloge sprengen sonst
// Serverless-Timeouts und Output-Limits. Der Client (Katalog-Fenster auf
// /lieferanten) ruft die Route pro Seitenbereich auf und zeigt Fortschritt:
//   1. erster Abschnitt (from_page=1, ohne lauf) → der Server vergibt eine
//      Lauf-ID und gibt sie zurueck; alle Folge-Abschnitte schicken sie mit.
//   2. jeder Abschnitt → katalog_import_abschnitt(): Zuordnung ueber die
//      Artikelnummer, sonst den normalisierten Namen (Katalog-Reihenfolge).
//      Bestehende Artikel behalten id, bild_path und Verweise (Technik-
//      Positionen); neue kommen dazu.
//   3. letzter Abschnitt → katalog_import_abschluss(): Artikel, die der Lauf
//      nicht mehr gesehen hat, werden DEAKTIVIERT (nicht geloescht) — nur
//      wenn der Lauf mindestens einen Artikel erkannt hat.
// letzte_kategorie wird durchgereicht, damit Kategorien ueber Chunk-Grenzen
// hinweg stabil bleiben.
//
// Recht: lieferanten:edit (Admins via has_permission) — wie die Katalog-
// Verwaltung auf /lieferanten.

import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/api-auth";
import { aiAvailable, AI_UNAVAILABLE_MSG, structuredCall } from "@/lib/ai/anthropic";
import { logError } from "@/lib/log";

export const maxDuration = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ImportErgebnis = {
  artikel: {
    hauptkategorie: string;
    kategorie: string;
    name: string;
    artikelnummer: string | null;
    beschreibung: string | null;
    inhalt: string | null;
    preis_chf: number | null;
    preis_text: string | null;
  }[];
  letzte_kategorie: string | null;
};

const IMPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["artikel", "letzte_kategorie"],
  properties: {
    artikel: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["hauptkategorie", "kategorie", "name", "artikelnummer", "beschreibung", "inhalt", "preis_chf", "preis_text"],
        properties: {
          hauptkategorie: { type: "string", description: "Grobe Hauptkategorie, eine aus: Audio, Licht, Video & Praesentation, Buehne & Traversen, Rigging & Montage, Strom & Kabel, Effekte, Mobiliar & Zelte, Absperrung & Infrastruktur, Transport & Logistik, Diverses." },
          kategorie: { type: "string", description: "Kategorie/Kapitel laut Katalog (z.B. AUDIOANLAGEN), normalisiert in Titel-Schreibweise (z.B. 'Audioanlagen')." },
          name: { type: "string", description: "Artikelname exakt wie im Katalog (z.B. 'DJ Set «Mittel»')." },
          artikelnummer: { type: ["string", "null"], description: "Artikel-/Bestellnummer NUR wenn sie im Katalog ausdruecklich beim Artikel steht (z.B. 'Art.-Nr. 4711' → '4711'); sonst null. Nie erfinden." },
          beschreibung: { type: ["string", "null"], description: "Kurzbeschreibung/Einsatzzweck, falls vorhanden." },
          inhalt: { type: ["string", "null"], description: "Set-Inhalt/Lieferumfang als Zeilen (je 'Anzahl Bezeichnung'), falls vorhanden." },
          preis_chf: { type: ["number", "null"], description: "Mietpreis in CHF als Zahl, NUR wenn eindeutig beziffert." },
          preis_text: { type: ["string", "null"], description: "Preisangabe als Text, wenn nicht bezifferbar (z.B. 'auf Anfrage', 'ab CHF 50.-')." },
        },
      },
    },
    letzte_kategorie: { type: ["string", "null"], description: "Kategorie, in der der Seitenbereich ENDET (fuer den naechsten Abschnitt)." },
  },
};

/** Freitext kuerzen; leer → null. */
function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

export async function POST(req: NextRequest) {
  const auth = await requirePermission("lieferanten:edit");
  if (auth.error) return auth.error;
  if (!aiAvailable()) {
    return NextResponse.json({ success: false, error: AI_UNAVAILABLE_MSG }, { status: 503 });
  }

  let body: { lieferant_id?: unknown; from_page?: unknown; to_page?: unknown; letzte_kategorie?: unknown; lauf?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Ungültige Anfrage" }, { status: 400 });
  }
  const lieferantId = typeof body.lieferant_id === "string" ? body.lieferant_id : "";
  const fromPage = Math.max(1, Math.floor(Number(body.from_page) || 1));
  const toPage = Math.max(fromPage, Math.floor(Number(body.to_page) || fromPage));
  if (!UUID_RE.test(lieferantId) || toPage - fromPage > 14) {
    return NextResponse.json({ success: false, error: "Ungültige Anfrage" }, { status: 400 });
  }
  // Lauf-ID: der erste Abschnitt startet einen neuen Lauf, alle weiteren
  // muessen ihn mitschicken (sonst wuerde der Abschluss falsch abraeumen).
  let lauf = typeof body.lauf === "string" ? body.lauf : "";
  if (!lauf && fromPage === 1) lauf = randomUUID();
  if (!UUID_RE.test(lauf)) {
    return NextResponse.json({ success: false, error: "Import-Lauf fehlt — bitte neu starten" }, { status: 400 });
  }
  const letzteKategorie = text(body.letzte_kategorie, 120);

  const admin = createAdminClient();
  const { data: firma, error: firmaErr } = await admin
    .from("lieferanten")
    .select("id, name, katalog_path")
    .eq("id", lieferantId)
    .maybeSingle();
  if (firmaErr) {
    logError("api.ai.katalog-import.firma", firmaErr, { lieferantId });
    return NextResponse.json({ success: false, error: "Lieferant konnte nicht geladen werden" }, { status: 500 });
  }
  if (!firma?.katalog_path) {
    return NextResponse.json({ success: false, error: "Kein Katalog-PDF hinterlegt" }, { status: 404 });
  }

  /** Letzter Abschnitt: nicht mehr gesehene Artikel deaktivieren.
   *  parallel = ein zweiter Import derselben Firma lief gleichzeitig →
   *  nichts deaktiviert (siehe Migration 332). */
  async function abschliessen(): Promise<{ gesehen: number; deaktiviert: number; parallel: boolean }> {
    const { data, error } = await admin.rpc("katalog_import_abschluss", { p_lieferant_id: lieferantId, p_lauf: lauf });
    if (error) throw new Error(`Abschluss fehlgeschlagen: ${error.message}`);
    const r = (data ?? {}) as { gesehen?: number; deaktiviert?: number; parallel?: boolean };
    return { gesehen: r.gesehen ?? 0, deaktiviert: r.deaktiviert ?? 0, parallel: r.parallel === true };
  }

  try {
    // PDF laden und den gewuenschten Seitenbereich als eigenes Mini-PDF bauen.
    const { data: blob, error: dlErr } = await admin.storage.from("documents").download(firma.katalog_path);
    if (dlErr || !blob) {
      return NextResponse.json({ success: false, error: "Katalog-PDF nicht lesbar" }, { status: 500 });
    }
    const srcBytes = new Uint8Array(await blob.arrayBuffer());
    const src = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
    const total = src.getPageCount();
    if (fromPage > total) {
      const ab = await abschliessen();
      return NextResponse.json({ success: true, done: true, total_pages: total, lauf, neu: 0, aktualisiert: 0, ...ab });
    }
    const end = Math.min(toPage, total);
    const chunk = await PDFDocument.create();
    const pages = await chunk.copyPages(src, Array.from({ length: end - fromPage + 1 }, (_, i) => fromPage - 1 + i));
    for (const p of pages) chunk.addPage(p);
    const chunkB64 = Buffer.from(await chunk.save()).toString("base64");

    const ergebnis = await structuredCall<ImportErgebnis>({
      system:
        `Du digitalisierst den Mietkatalog der Firma "${firma.name}" für ein internes System. ` +
        `Du erhältst die Seiten ${fromPage}–${end} von insgesamt ${total}. ` +
        "Extrahiere JEDEN Mietartikel dieses Abschnitts vollständig: Kategorie (Kapitel-Überschrift), Name, Artikelnummer (nur wenn angegeben), Kurzbeschreibung, " +
        "Set-Inhalt (Positionen als Zeilen 'Anzahl Bezeichnung'), Preis. " +
        "Preise: Zahl nach preis_chf NUR wenn eindeutig (z.B. 'Mietpreis: CHF 340.-' → 340); sonst preis_text. " +
        "Inhaltsverzeichnis-, Titel- und reine Infoseiten (Lieferbedingungen etc.) ergeben KEINE Artikel. " +
        (letzteKategorie
          ? `Der vorherige Abschnitt endete in der Kategorie "${letzteKategorie}" — Artikel am Seitenanfang ohne eigene Kapitel-Überschrift gehören dorthin. `
          : "") +
        "Nichts erfinden, nichts zusammenfassen — jeder Artikel einzeln.",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: chunkB64 } },
      ],
      toolName: "artikel_speichern",
      toolDescription: "Speichert die extrahierten Katalog-Artikel.",
      schema: IMPORT_SCHEMA,
      maxTokens: 16000,
    });

    // Werte begrenzen/saeubern, Katalog-Reihenfolge als sort (Seite*1000+i).
    const artikel = ergebnis.artikel
      .map((a, i) => ({
        name: text(a.name, 300),
        artikelnummer: text(a.artikelnummer, 60),
        hauptkategorie: text(a.hauptkategorie, 60) ?? "Diverses",
        kategorie: text(a.kategorie, 120) ?? "Sonstiges",
        beschreibung: text(a.beschreibung, 4000),
        inhalt: text(a.inhalt, 8000),
        preis_chf: typeof a.preis_chf === "number" && Number.isFinite(a.preis_chf) && a.preis_chf >= 0 && a.preis_chf < 10_000_000
          ? Math.round(a.preis_chf * 100) / 100
          : null,
        preis_text: text(a.preis_text, 4000),
        sort: fromPage * 1000 + i,
      }))
      .filter((a) => a.name);

    let neu = 0;
    let aktualisiert = 0;
    if (artikel.length) {
      const { data, error } = await admin.rpc("katalog_import_abschnitt", {
        p_lieferant_id: lieferantId,
        p_lauf: lauf,
        p_artikel: artikel,
      });
      if (error) throw new Error(`Speichern fehlgeschlagen: ${error.message}`);
      const r = (data ?? {}) as { neu?: number; aktualisiert?: number };
      neu = r.neu ?? 0;
      aktualisiert = r.aktualisiert ?? 0;
    }

    const done = end >= total;
    const ab = done ? await abschliessen() : null;
    return NextResponse.json({
      success: true,
      done,
      total_pages: total,
      next_page: done ? null : end + 1,
      lauf,
      neu,
      aktualisiert,
      ...(ab ?? {}),
      letzte_kategorie: ergebnis.letzte_kategorie,
    });
  } catch (e) {
    logError("api.ai.katalog-import", e, { lieferantId, fromPage });
    const msg = e instanceof Error ? e.message : "KI-Import fehlgeschlagen";
    return NextResponse.json({ success: false, error: msg }, { status: 502 });
  }
}
