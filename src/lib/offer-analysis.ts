// Offerten-Analyse pro Auftrag — Server-only (Admin-Client).
//
// Feature (Leo 2026-09-08): Aus dem im Auftrag hinterlegten Offerten-PDF
// werden per Claude API NUR die Arbeits-/Stundenpositionen extrahiert
// (kein Material, keine Miete). Der Gewinn (Offerten-Arbeitserloes minus
// Personal-Kosten-Prognose aus job-costs.ts) wird als Pill im Termine-
// Header angezeigt (/api/admin/job-offer-profit → PlannedCostBadge).
//
// Offerten-Erkennung: neuestes Dokument des Auftrags, dessen Dateiname
// "offerte" enthaelt (case-insensitive) UND das ein PDF ist. Keins → null.
//
// Cache (job_offer_analysis, Migration 226): 1 Row pro Auftrag. Der LLM
// laeuft NUR wenn keine Row existiert oder document_path nicht mehr zum
// aktuell neuesten Offerten-PDF passt — nie pro Seitenaufruf.
//
// Kein SDK: @anthropic-ai/sdk ist nicht installiert → direkter fetch auf
// https://api.anthropic.com/v1/messages (PDF als base64-document-Block).

import type { SupabaseClient } from "@supabase/supabase-js";

const MODEL = "claude-sonnet-5";
const MAX_PDF_BYTES = 15 * 1024 * 1024; // API-Request-Limit 32 MB; base64 ~×1.33.

export interface OfferPosition {
  beschreibung: string;
  stunden: number | null;
  betrag_chf: number;
}

export interface OfferAnalysis {
  total_arbeit_chf: number;
  positions: OfferPosition[];
  document_name: string;
  analyzed_at: string;
}

export interface OfferAnalysisResult {
  offer: OfferAnalysis | null;
  /** Gesetzt wenn eine Offerte existiert, aber nicht analysiert werden
   *  konnte (fehlender API-Key, Download-/API-Fehler). Die UI zeigt dann
   *  einfach keine Gewinn-Pill (Ambient-Info, kein Toast). */
  error?: string;
}

interface OfferDoc {
  name: string;
  storage_path: string;
  created_at: string;
}

/** Neuestes Offerten-PDF des Auftrags. Erkennung ueber den Dateinamen:
 *  "offerte", "angebot" ODER Bexio-Angebots-Nummern ("AN-25011.pdf" —
 *  Bexio exportiert Offerten als AN-<nr>; Leo-Fund 2026-09-08: die
 *  Offerte hiess an-25011.pdf und wurde nicht erkannt). */
async function findNewestOfferPdf(
  admin: SupabaseClient,
  jobId: string,
): Promise<OfferDoc | null> {
  const { data, error } = await admin
    .from("documents")
    .select("name, storage_path, mime_type, created_at")
    .eq("job_id", jobId)
    .or("name.ilike.%offerte%,name.ilike.%angebot%,name.ilike.an-%")
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as (OfferDoc & { mime_type: string | null })[];
  // Nur PDFs — der Claude-document-Block akzeptiert application/pdf.
  const pdf = rows.find(
    (d) => d.mime_type === "application/pdf" || d.name.toLowerCase().endsWith(".pdf"),
  );
  return pdf ?? null;
}

/**
 * Liefert die Arbeitsstunden-Analyse der Auftrags-Offerte — aus dem Cache
 * wenn moeglich, sonst via Claude API (und schreibt den Cache).
 * Kein Offerten-PDF vorhanden → { offer: null } (bewusst kein Fehler).
 */
export async function getOfferAnalysis(
  admin: SupabaseClient,
  jobId: string,
): Promise<OfferAnalysisResult> {
  const doc = await findNewestOfferPdf(admin, jobId);
  if (!doc) return { offer: null };

  // Cache-Hit: gleiche Offerten-Datei wie beim letzten Mal → kein LLM-Call.
  const { data: cached } = await admin
    .from("job_offer_analysis")
    .select("document_path, total_arbeit_chf, positions, analyzed_at")
    .eq("job_id", jobId)
    .maybeSingle();
  if (cached && cached.document_path === doc.storage_path) {
    return {
      offer: {
        total_arbeit_chf: Number(cached.total_arbeit_chf ?? 0),
        positions: (cached.positions ?? []) as OfferPosition[],
        document_name: doc.name,
        analyzed_at: cached.analyzed_at,
      },
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { offer: null, error: "ANTHROPIC_API_KEY fehlt" };

  // PDF aus dem Storage laden (Bucket "documents", wie build-rapport-pdf.ts).
  const { data: blob, error: dlError } = await admin.storage
    .from("documents")
    .download(doc.storage_path);
  if (dlError || !blob) {
    return { offer: null, error: "Offerten-PDF nicht lesbar" };
  }
  const buf = Buffer.from(await blob.arrayBuffer());
  if (buf.byteLength > MAX_PDF_BYTES) {
    return { offer: null, error: "Offerten-PDF zu gross fuer die Analyse" };
  }

  const analysis = await analyzePdfWithClaude(apiKey, buf);
  if ("error" in analysis) return { offer: null, error: analysis.error };

  const analyzedAt = new Date().toISOString();
  const { error: upsertErr } = await admin.from("job_offer_analysis").upsert({
    job_id: jobId,
    document_path: doc.storage_path,
    total_arbeit_chf: analysis.total_arbeit_chf,
    positions: analysis.positions,
    analyzed_at: analyzedAt,
    model: MODEL,
  });
  if (upsertErr) {
    // Analyse ist trotzdem brauchbar — nur der Cache fehlt (naechster
    // Aufruf rechnet dann leider nochmal). Nicht verschlucken im Log.
    console.error("job_offer_analysis upsert failed:", upsertErr.message);
  }

  return {
    offer: {
      total_arbeit_chf: analysis.total_arbeit_chf,
      positions: analysis.positions,
      document_name: doc.name,
      analyzed_at: analyzedAt,
    },
  };
}

const EXTRACTION_PROMPT = `Extrahiere aus dieser Offerte NUR Arbeits-/Personal-/Stundenpositionen (Arbeitszeit, Technikerstunden, Auf-/Abbau-Stunden, Regie, Personalaufwand) — KEIN Material, KEINE Miete, KEINE Pauschalen für Geräte.
Beträge in CHF, exkl. MwSt, so wie sie in der Offerte stehen (Positionstotal, nicht Einzelpreis).
Antworte AUSSCHLIESSLICH mit einem JSON-Objekt, ohne Markdown und ohne weiteren Text:
{"positions":[{"beschreibung":"...","stunden":12.5,"betrag_chf":1250}],"total_arbeit_chf":1250}
"stunden" ist null wenn die Position keine Stundenzahl nennt. Wenn keine Arbeitspositionen vorhanden sind: {"positions":[],"total_arbeit_chf":0}`;

async function analyzePdfWithClaude(
  apiKey: string,
  pdf: Buffer,
): Promise<{ total_arbeit_chf: number; positions: OfferPosition[] } | { error: string }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "document",
              source: {
                type: "base64",
                media_type: "application/pdf",
                data: pdf.toString("base64"),
              },
            },
            { type: "text", text: EXTRACTION_PROMPT },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("Anthropic API error:", res.status, body.slice(0, 500));
    return { error: `Claude API-Fehler (${res.status})` };
  }

  const json = (await res.json()) as {
    stop_reason?: string;
    content?: { type: string; text?: string }[];
  };
  if (json.stop_reason === "refusal") {
    return { error: "Analyse vom Modell abgelehnt" };
  }
  const text = (json.content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");

  const parsed = parseAnalysisJson(text);
  if (!parsed) return { error: "Antwort nicht als JSON lesbar" };
  return parsed;
}

/** Robust: Markdown-Fences tolerieren (erstes {...} nehmen), Shape pruefen. */
function parseAnalysisJson(
  text: string,
): { total_arbeit_chf: number; positions: OfferPosition[] } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as { positions?: unknown; total_arbeit_chf?: unknown };

  const positions: OfferPosition[] = [];
  if (Array.isArray(obj.positions)) {
    for (const p of obj.positions) {
      if (typeof p !== "object" || p === null) continue;
      const pos = p as { beschreibung?: unknown; stunden?: unknown; betrag_chf?: unknown };
      const betrag = Number(pos.betrag_chf);
      if (!Number.isFinite(betrag)) continue;
      positions.push({
        beschreibung: typeof pos.beschreibung === "string" ? pos.beschreibung : "",
        stunden: Number.isFinite(Number(pos.stunden)) && pos.stunden !== null && pos.stunden !== undefined
          ? Number(pos.stunden)
          : null,
        betrag_chf: Math.round(betrag * 100) / 100,
      });
    }
  }

  let total = Number(obj.total_arbeit_chf);
  if (!Number.isFinite(total)) {
    total = positions.reduce((s, p) => s + p.betrag_chf, 0);
  }
  return { total_arbeit_chf: Math.round(total * 100) / 100, positions };
}
