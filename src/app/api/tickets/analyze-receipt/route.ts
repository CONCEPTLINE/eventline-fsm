// POST /api/tickets/analyze-receipt — analysiert ein Beleg-Bild und liefert
// ein strukturiertes Ergebnis fürs Beleg-Ticket:
//   - extracted: Betrag (CHF), Kaufdatum, Lieferant
//   - issues: Warnungen, wenn das Bild unscharf ist oder Angaben fehlen
//   - ok: Gesamt-Plausibilität
//
// Reihenfolge (docs/lokale-ki/SPEC.md 2.3): zuerst die lokale KI im Büro —
// das Bild liegt nur im Übergabe-Bucket (ki-tmp/<uuid>), Auftrag
// `beleg_analyse`, Warten bis KI_TIMEOUT_BELEG_MS, Tmp-Objekt und
// Auftragszeile danach in jedem Fall weg (Datenschutz: das Ergebnis bleibt
// nicht liegen). Ist die KI offline, läuft die Zeit ab oder meldet sie einen
// Fehler, übernimmt Claude Vision (structuredCall, Bild als base64,
// strict-Tool mit demselben Schema) — nie ein stiller Fehlschlag (SPEC 1.5).
//
// Wird vom Frontend aufgerufen, sobald der User im Beleg-Ticket-Form eine
// Datei wählt. Body: { image_base64: string, mime_type: string }. Antwort
// { success: true, result, quelle: "lokal" | "claude" } — `result` hat
// dieselbe Form wie bisher, das Frontend bleibt unverändert.
//
// Nur interne Mitarbeiter: Partner-/Lieferanten-Portal-Konten haben keine
// Beleg-Analyse (Rolle des echten angemeldeten Kontos, wie /api/ki/diktat).

import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { requireUser } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { istIntern } from "@/lib/roles";
import { logError } from "@/lib/log";
import { aiAvailable, AI_UNAVAILABLE_MSG, structuredCall } from "@/lib/ai/anthropic";
import { KI_TIMEOUT_BELEG_MS } from "@/lib/ki/konstanten";
import { erstelleKiAuftrag, kiOnline, loescheKiAuftrag, loescheKiTmp, speichereKiTmp, warteAufErgebnis } from "@/lib/ki/queue";
import type { BelegAnalyseErgebnis, BelegAnalysePayload, KiWarteErgebnis } from "@/lib/ki/typen";

// Wartezeit auf die lokale KI (90 s, Kaltstart des Bildmodells) plus der
// Claude-Rückfall müssen in eine Funktionslaufzeit passen.
export const maxDuration = 150;

const SYSTEM_PROMPT = `Du bist der Beleg-Assistent von EVENTLINE (Veranstaltungstechnik, Basel).
Du erhältst das Foto einer Quittung oder eines Belegs, den ein Mitarbeiter zur Rückerstattung einreicht.
Prüfe Lesbarkeit und Vollständigkeit und melde das Ergebnis über das Tool.

Prüfe, ob diese drei Angaben klar erkennbar sind:
1. Betrag (Total) — bevorzugt in CHF
2. Kaufdatum
3. Lieferant / Geschäftsname

Regeln:
- ok = true nur, wenn alle drei Angaben klar lesbar sind UND das Bild wirklich eine Quittung oder ein Beleg ist.
- issues (auf Deutsch): kurze, konkrete Punkte, was unklar oder unscharf ist. Leer, wenn alles ok.
  Beispiele: «Bild ist unscharf», «Datum nicht erkennbar», «Kein Beleg im Bild».
- betrag_chf: Total-Betrag als Zahl, nur wenn die Quittung in CHF ist. Bei anderer Währung null und ein issue dazu.
- kaufdatum: YYYY-MM-DD, null wenn nicht klar.
- lieferant: Geschäftsname (Migros, Coop, Conrad usw.), sonst null.`;

/** Dasselbe JSON wie bisher — als strict-Schema garantiert Claude genau
 *  diese Form, kein JSON.parse auf Freitext mehr. */
const BELEG_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "issues", "extracted"],
  properties: {
    ok: { type: "boolean", description: "true nur, wenn alle drei Angaben klar lesbar sind und es ein Beleg ist." },
    issues: {
      type: "array",
      items: { type: "string" },
      description: "Kurze, konkrete Punkte auf Deutsch, was unklar oder unscharf ist. Leer, wenn alles ok.",
    },
    extracted: {
      type: "object",
      additionalProperties: false,
      required: ["betrag_chf", "kaufdatum", "lieferant"],
      properties: {
        betrag_chf: { type: ["number", "null"], description: "Total in CHF als Zahl; null bei anderer Währung oder unleserlich." },
        kaufdatum: { type: ["string", "null"], description: "Kaufdatum als YYYY-MM-DD; null wenn nicht klar." },
        lieferant: { type: ["string", "null"], description: "Geschäftsname; null wenn nicht erkennbar." },
      },
    },
  },
};

/** Bildformate, die die Anthropic-API als base64 annimmt. */
const CLAUDE_BILDFORMATE = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type ClaudeBildformat = (typeof CLAUDE_BILDFORMATE)[number];

function claudeBildformat(mime: string): ClaudeBildformat | null {
  const m = mime === "image/jpg" ? "image/jpeg" : mime;
  return (CLAUDE_BILDFORMATE as readonly string[]).includes(m) ? (m as ClaudeBildformat) : null;
}

/** Das Frontend schickt keinen Dateinamen mit — fürs Rig reicht ein
 *  sprechender Name mit passender Endung. */
function dateiName(mime: string): string {
  const sub = (mime.split("/")[1] ?? "").replace(/[^a-z0-9]/g, "");
  return `beleg.${sub === "jpeg" ? "jpg" : sub || "bin"}`;
}

function istTicketErgebnis(x: unknown): x is BelegAnalyseErgebnis {
  if (!x || typeof x !== "object") return false;
  const ex = (x as { extracted?: unknown }).extracted;
  return !!ex && typeof ex === "object";
}

/** Klartext für den Toast — typisierte SDK-Fehler statt String-Vergleich. */
function claudeFehlerText(err: unknown): string {
  if (err instanceof Anthropic.BadRequestError) return "Claude konnte das Bild nicht verarbeiten (zu gross oder beschädigt)";
  if (err instanceof Anthropic.RateLimitError) return "Claude ist gerade ausgelastet — bitte in einer Minute nochmals versuchen";
  if (err instanceof Anthropic.APIConnectionError) return "Claude ist nicht erreichbar";
  if (err instanceof Anthropic.APIError) return `Claude-Fehler ${err.status ?? ""}`.trim();
  return "Analyse über Claude fehlgeschlagen";
}

/** Weg über die lokale KI: Bild in den Übergabe-Bucket, Auftrag anlegen,
 *  auf das Ergebnis warten. Tmp-Objekt und Auftragszeile werden in jedem
 *  Fall entfernt — nach dem Lesen braucht niemand das Ergebnis mehr, und
 *  bei Timeout bekommt der Nutzer die Claude-Antwort: ein noch offener
 *  Auftrag wird so nie abgeholt, das späte Ergebnis eines laufenden nimmt
 *  die Abhol-API nicht mehr an. */
async function analysiereLokal(bytes: Buffer, mime: string, userId: string): Promise<KiWarteErgebnis<BelegAnalyseErgebnis>> {
  let storagePath: string | null = null;
  let auftragId: string | null = null;
  try {
    const tmp = await speichereKiTmp(bytes, mime);
    storagePath = tmp.storage_path;
    const payload: BelegAnalysePayload = { storage_path: tmp.storage_path, file_name: dateiName(mime), mime, size: bytes.length };
    auftragId = await erstelleKiAuftrag("beleg_analyse", payload, userId);
    const warte = await warteAufErgebnis<BelegAnalyseErgebnis>(auftragId, KI_TIMEOUT_BELEG_MS);
    if (warte.status === "fertig" && !istTicketErgebnis(warte.ergebnis)) {
      return { status: "fehler", fehler: "Lokale KI lieferte ein unbrauchbares Ergebnis" };
    }
    return warte;
  } catch (err) {
    return { status: "fehler", fehler: err instanceof Error ? err.message : String(err) };
  } finally {
    if (storagePath) await loescheKiTmp(storagePath);
    if (auftragId) await loescheKiAuftrag(auftragId);
  }
}

export async function POST(request: Request) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const { data: profil } = await createAdminClient().from("profiles").select("role").eq("id", auth.user.id).maybeSingle();
  if (!istIntern(profil?.role as string | null | undefined)) {
    return NextResponse.json({ success: false, error: "Beleg-Analyse steht nur internen Mitarbeitern zur Verfügung" }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const imageBase64: unknown = body?.image_base64;
  const mimeType: unknown = body?.mime_type;
  if (typeof imageBase64 !== "string" || !imageBase64 || typeof mimeType !== "string" || !mimeType) {
    return NextResponse.json(
      { success: false, error: "image_base64 + mime_type sind Pflicht" },
      { status: 400 },
    );
  }

  // Sanity-Limit, damit kein 50-MB-Bild geschickt wird.
  if (imageBase64.length > 8_000_000) {
    return NextResponse.json(
      { success: false, error: "Bild zu gross (max. 6MB)" },
      { status: 413 },
    );
  }

  const bytes = Buffer.from(imageBase64, "base64");
  if (bytes.length === 0) {
    return NextResponse.json(
      { success: false, error: "Bilddaten sind leer oder kein gültiges Base64" },
      { status: 400 },
    );
  }
  const mime = mimeType.trim().toLowerCase();

  // (1) Lokale KI zuerst — das Bild verlässt das Haus nicht (SPEC 1.1).
  if (await kiOnline()) {
    const lokal = await analysiereLokal(bytes, mime, auth.user.id);
    if (lokal.status === "fertig") {
      return NextResponse.json({ success: true, result: lokal.ergebnis, quelle: "lokal" });
    }
    logError(
      "tickets.analyze-receipt.lokal",
      lokal.status === "fehler" ? lokal.fehler : "Zeit abgelaufen — Rückfall auf Claude",
      { status: lokal.status },
    );
  }

  // (2) Rückfall Claude Vision — nur Formate, die die API annimmt. Das
  // base64 wird aus den Bytes neu erzeugt (kanonisch, ohne Zeilenumbrüche).
  const bildformat = claudeBildformat(mime);
  if (!bildformat) {
    return NextResponse.json(
      { success: false, error: "Bildformat nicht unterstützt" },
      { status: 415 },
    );
  }
  if (!aiAvailable()) {
    return NextResponse.json({ success: false, error: AI_UNAVAILABLE_MSG }, { status: 503 });
  }

  try {
    const result = await structuredCall<BelegAnalyseErgebnis>({
      system: SYSTEM_PROMPT,
      content: [
        { type: "image", source: { type: "base64", media_type: bildformat, data: bytes.toString("base64") } },
        { type: "text", text: "Prüfe diesen Beleg und melde das Ergebnis über das Tool." },
      ],
      toolName: "beleg_ergebnis",
      toolDescription: "Meldet das Prüfergebnis des Belegs: Lesbarkeit, Warnungen und die erkannten Angaben.",
      schema: BELEG_SCHEMA,
      maxTokens: 1024,
    });
    return NextResponse.json({ success: true, result, quelle: "claude" });
  } catch (err) {
    logError("tickets.analyze-receipt.claude", err);
    return NextResponse.json({ success: false, error: claudeFehlerText(err) }, { status: 502 });
  }
}
