// POST /api/ai/katalog-import — liest das hinterlegte Katalog-PDF einer
// Lieferanten-Firma CHUNK-WEISE (Seitenbereiche via pdf-lib) mit der KI
// ein und schreibt strukturierte Mietartikel nach lieferant_katalog_artikel.
//
// Chunk-Design statt Ein-Schuss: 80-Seiten-Kataloge sprengen sonst
// Serverless-Timeouts und Output-Limits. Der Client (Einstellungen →
// Kataloge) ruft die Route pro Seitenbereich auf und zeigt Fortschritt;
// der ERSTE Chunk (from_page=1) loescht vorher alle bisherigen KI-Artikel
// der Firma (Re-Import ersetzt, statt zu duplizieren — gleiches Prinzip
// wie beim Auftrag-Eingang). letzte_kategorie wird durchgereicht, damit
// Kategorien ueber Chunk-Grenzen hinweg stabil bleiben.
//
// Admin-only (Katalog-Verwaltung ist Admin-Sache, wie die Zugaenge).

import { NextRequest, NextResponse } from "next/server";
import { PDFDocument } from "pdf-lib";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/api-auth";
import { aiAvailable, AI_UNAVAILABLE_MSG, structuredCall } from "@/lib/ai/anthropic";

export const maxDuration = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ImportErgebnis = {
  artikel: {
    hauptkategorie: string;
    kategorie: string;
    name: string;
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
        required: ["hauptkategorie", "kategorie", "name", "beschreibung", "inhalt", "preis_chf", "preis_text"],
        properties: {
          hauptkategorie: { type: "string", description: "Grobe Hauptkategorie, eine aus: Audio, Licht, Video & Praesentation, Buehne & Traversen, Rigging & Montage, Strom & Kabel, Effekte, Mobiliar & Zelte, Absperrung & Infrastruktur, Transport & Logistik, Diverses." },
          kategorie: { type: "string", description: "Kategorie/Kapitel laut Katalog (z.B. AUDIOANLAGEN), normalisiert in Titel-Schreibweise (z.B. 'Audioanlagen')." },
          name: { type: "string", description: "Artikelname exakt wie im Katalog (z.B. 'DJ Set «Mittel»')." },
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

export async function POST(req: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  if (!aiAvailable()) {
    return NextResponse.json({ success: false, error: AI_UNAVAILABLE_MSG }, { status: 503 });
  }

  let body: { lieferant_id?: string; from_page?: number; to_page?: number; letzte_kategorie?: string | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Ungültige Anfrage" }, { status: 400 });
  }
  const { lieferant_id } = body;
  const fromPage = Math.max(1, Math.floor(body.from_page ?? 1));
  const toPage = Math.max(fromPage, Math.floor(body.to_page ?? fromPage));
  if (!lieferant_id || !UUID_RE.test(lieferant_id) || toPage - fromPage > 14) {
    return NextResponse.json({ success: false, error: "Ungültige Anfrage" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: firma } = await admin
    .from("lieferanten")
    .select("id, name, katalog_path")
    .eq("id", lieferant_id)
    .maybeSingle();
  if (!firma?.katalog_path) {
    return NextResponse.json({ success: false, error: "Kein Katalog-PDF hinterlegt" }, { status: 404 });
  }

  // PDF laden und den gewuenschten Seitenbereich als eigenes Mini-PDF bauen.
  const { data: blob, error: dlErr } = await admin.storage.from("documents").download(firma.katalog_path);
  if (dlErr || !blob) {
    return NextResponse.json({ success: false, error: "Katalog-PDF nicht lesbar" }, { status: 500 });
  }
  const srcBytes = new Uint8Array(await blob.arrayBuffer());
  const src = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
  const total = src.getPageCount();
  if (fromPage > total) {
    return NextResponse.json({ success: true, done: true, total_pages: total, inserted: 0 });
  }
  const end = Math.min(toPage, total);
  const chunk = await PDFDocument.create();
  const pages = await chunk.copyPages(src, Array.from({ length: end - fromPage + 1 }, (_, i) => fromPage - 1 + i));
  for (const p of pages) chunk.addPage(p);
  const chunkB64 = Buffer.from(await chunk.save()).toString("base64");

  try {
    const ergebnis = await structuredCall<ImportErgebnis>({
      system:
        `Du digitalisierst den Mietkatalog der Firma "${firma.name}" für ein internes System. ` +
        `Du erhältst die Seiten ${fromPage}–${end} von insgesamt ${total}. ` +
        "Extrahiere JEDEN Mietartikel dieses Abschnitts vollständig: Kategorie (Kapitel-Überschrift), Name, Kurzbeschreibung, " +
        "Set-Inhalt (Positionen als Zeilen 'Anzahl Bezeichnung'), Preis. " +
        "Preise: Zahl nach preis_chf NUR wenn eindeutig (z.B. 'Mietpreis: CHF 340.-' → 340); sonst preis_text. " +
        "Inhaltsverzeichnis-, Titel- und reine Infoseiten (Lieferbedingungen etc.) ergeben KEINE Artikel. " +
        (body.letzte_kategorie
          ? `Der vorherige Abschnitt endete in der Kategorie "${body.letzte_kategorie}" — Artikel am Seitenanfang ohne eigene Kapitel-Überschrift gehören dorthin. `
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

    // Erster Chunk: bisherige KI-Artikel der Firma ersetzen.
    if (fromPage === 1) {
      await admin.from("lieferant_katalog_artikel").delete().eq("lieferant_id", lieferant_id).eq("source", "ki");
    }
    if (ergebnis.artikel.length) {
      const { error: insErr } = await admin.from("lieferant_katalog_artikel").insert(
        ergebnis.artikel.map((a, i) => ({
          lieferant_id,
          hauptkategorie: (a.hauptkategorie || "Diverses").slice(0, 60),
          kategorie: (a.kategorie || "Sonstiges").slice(0, 120),
          name: a.name.slice(0, 300),
          beschreibung: a.beschreibung,
          inhalt: a.inhalt,
          preis_chf: a.preis_chf,
          preis_text: a.preis_text,
          sort: fromPage * 1000 + i,
          source: "ki",
        })),
      );
      if (insErr) throw new Error(insErr.message);
    }

    return NextResponse.json({
      success: true,
      done: end >= total,
      total_pages: total,
      next_page: end >= total ? null : end + 1,
      inserted: ergebnis.artikel.length,
      letzte_kategorie: ergebnis.letzte_kategorie,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "KI-Import fehlgeschlagen";
    return NextResponse.json({ success: false, error: msg }, { status: 502 });
  }
}
