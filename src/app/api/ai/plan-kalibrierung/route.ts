// POST /api/ai/plan-kalibrierung — bestimmt den Massstab (px_pro_meter)
// der Plan-Unterlage einer Location automatisch: die KI liest die
// Massstabsleiste bzw. eine eindeutige Bemassung aus dem gerenderten
// Plan-Bild und liefert zwei Pixelpunkte + die reale Distanz; der Server
// rechnet. Wenn moeglich liefert sie eine ZWEITE unabhaengige Referenz
// zur Kontrolle — weichen beide um mehr als 10% ab, wird abgelehnt und
// manuell kalibriert. Manuelles Uebersteuern bleibt immer moeglich.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api-auth";
import { aiAvailable, AI_UNAVAILABLE_MSG, structuredCall } from "@/lib/ai/anthropic";
import { ladePdfjs } from "@/lib/pdf-server";
import type { PlanUnterlage } from "@/lib/plan2d";

export const maxDuration = 120;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Text-Anker aus dem Quell-PDF extrahieren (serverseitig, legacy-Build —
 *  im Browser liefert getTextContent bei diesen Plaenen nichts) und auf
 *  die Pixel des gerenderten Unterlage-Bilds skalieren. */
async function pdfAnker(
  buf: Buffer,
  bildBreite: number,
  bildHoehe: number,
): Promise<{ t: string; x: number; y: number }[]> {
  try {
    const pdfjs = await ladePdfjs();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;
    const page = await doc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    // Gleiche Logik wie das Client-Rendering: lange Kante -> Bildgroesse
    const scale = Math.max(bildBreite, bildHoehe) / Math.max(vp.width, vp.height);
    const tc = await page.getTextContent();
    const anker: { t: string; x: number; y: number }[] = [];
    for (const it of tc.items) {
      const item = it as { str?: string; transform?: number[] };
      const t = (item.str ?? "").trim();
      if (!t || t.length > 24 || !item.transform) continue;
      anker.push({
        t,
        x: Math.round(item.transform[4] * scale),
        y: Math.round((vp.height - item.transform[5]) * scale),
      });
      if (anker.length >= 400) break;
    }
    return anker;
  } catch {
    return [];
  }
}

// Anker-Modus (Vektor-PDF): Die KI waehlt nur, WELCHE zwei Text-Anker
// eine Massstab-Referenz bilden — die exakten Pixel kommen aus dem PDF.
const ANKER_REFERENZ_PROPS = {
  anker_a: { type: "integer", description: "Index des ersten Text-Ankers (aus der ANKER-Liste)." },
  anker_b: { type: "integer", description: "Index des zweiten Text-Ankers." },
  meter: { type: "number", description: "Reale Distanz zwischen den ZENTREN der beiden Anker-Beschriftungen in Metern." },
  beschreibung: { type: "string", description: "Was genutzt wurde, z.B. 'Massstabsleiste: 0 bis 5 = 5 m'." },
};

const ANKER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["referenz", "kontrolle"],
  properties: {
    referenz: {
      type: "object",
      additionalProperties: false,
      required: ["anker_a", "anker_b", "meter", "beschreibung"],
      properties: ANKER_REFERENZ_PROPS,
      description:
        "Beste Referenz: bevorzugt ZWEI Zahlen-Beschriftungen der MASSSTABSLEISTE (z.B. '0' und '5' => 5 m; " +
        "die Beschriftungen sitzen zentriert ueber ihren Markierungen, ihre Zentren-Distanz entspricht also der Leisten-Distanz). " +
        "Nur Anker-Paare waehlen, deren realer Abstand SICHER bekannt ist.",
    },
    kontrolle: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["anker_a", "anker_b", "meter", "beschreibung"],
      properties: ANKER_REFERENZ_PROPS,
      description: "ZWEITE, unabhaengige Anker-Referenz (anderes Paar) zur Kontrolle — null wenn keine sichere zweite existiert.",
    },
  },
};

// Pixel-Modus (Bild-Unterlage ohne Text-Anker): KI schaetzt Pixelpunkte.
const PUNKT = {
  type: "object",
  additionalProperties: false,
  required: ["x", "y"],
  properties: { x: { type: "number" }, y: { type: "number" } },
};

const PIXEL_REFERENZ_PROPS = {
  punkt1: PUNKT,
  punkt2: PUNKT,
  meter: { type: "number", description: "Reale Distanz zwischen den zwei Punkten in Metern." },
  beschreibung: { type: "string", description: "Was genutzt wurde." },
};

const PIXEL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["referenz", "kontrolle"],
  properties: {
    referenz: {
      type: "object",
      additionalProperties: false,
      required: ["punkt1", "punkt2", "meter", "beschreibung"],
      properties: PIXEL_REFERENZ_PROPS,
      description:
        "Beste Massstab-Referenz im Bild (Massstabsleiste oder eindeutige Bemassung). " +
        "punkt1/punkt2 = PIXEL-Koordinaten (Ursprung oben links), PRAEZISE auf die Markierungen zielen.",
    },
    kontrolle: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["punkt1", "punkt2", "meter", "beschreibung"],
      properties: PIXEL_REFERENZ_PROPS,
      description: "ZWEITE, unabhaengige Referenz — null wenn keine existiert.",
    },
  },
};

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;
  if (!aiAvailable()) {
    return NextResponse.json({ success: false, error: AI_UNAVAILABLE_MSG }, { status: 503 });
  }

  let body: { location_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Ungültige Anfrage" }, { status: 400 });
  }
  const locationId = body.location_id;
  if (!locationId || !UUID_RE.test(locationId)) {
    return NextResponse.json({ success: false, error: "Ungültige Anfrage" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: loc } = await supabase
    .from("locations")
    .select("id, plan_unterlage")
    .eq("id", locationId)
    .maybeSingle();
  if (!loc) return NextResponse.json({ success: false, error: "Location nicht gefunden" }, { status: 404 });
  const unterlage = loc.plan_unterlage as PlanUnterlage | null;
  if (!unterlage?.path) {
    return NextResponse.json({ success: false, error: "Keine Plan-Unterlage gesetzt" }, { status: 422 });
  }

  const admin = createAdminClient();
  const { data: blob } = await admin.storage.from("documents").download(unterlage.path);
  if (!blob) return NextResponse.json({ success: false, error: "Unterlage nicht ladbar" }, { status: 500 });
  const buf = Buffer.from(await blob.arrayBuffer());

  try {
    let anker: { t: string; x: number; y: number }[] = [];
    if (unterlage.quelle_pdf_path) {
      const { data: pdfBlob } = await admin.storage.from("documents").download(unterlage.quelle_pdf_path);
      if (pdfBlob) {
        anker = await pdfAnker(Buffer.from(await pdfBlob.arrayBuffer()), unterlage.breite_px, unterlage.hoehe_px);
      }
    }
    type Ref = { meter: number; beschreibung: string; distPx: number | null };
    let ref1: Ref, ref2: Ref | null;

    if (anker.length >= 2) {
      // ── Anker-Modus: Pixel kommen exakt aus dem Vektor-PDF ──────
      const ankerListe = anker.map((a, i) => `${i}: "${a.t}" @ (${a.x}, ${a.y})`).join("\n");
      const erg = await structuredCall<{
        referenz: { anker_a: number; anker_b: number; meter: number; beschreibung: string };
        kontrolle: { anker_a: number; anker_b: number; meter: number; beschreibung: string } | null;
      }>({
        system:
          "Du kalibrierst den Massstab eines Saalplans fuer eine Veranstaltungstechnik-Firma. " +
          "Das Bild UND die Liste seiner Text-Anker (exakte Pixel-Koordinaten der Beschriftungs-Zentren) liegen vor. " +
          "Waehle Anker-PAARE, deren realer Abstand sicher bekannt ist — bevorzugt Zahlen der Massstabsleiste " +
          "(z.B. Anker '0' und Anker '5' der Leiste => 5 m). " +
          "Masszahlen auf Schweizer Bauplaenen sind oft Zentimeter (1165 = 11.65 m).",
        content: [
          { type: "text", text: "Kalibriere diesen Plan:" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: buf.toString("base64") } },
          { type: "text", text: `\nTEXT-ANKER (Index: "Text" @ (x, y) in Bild-Pixeln):\n${ankerListe}` },
        ],
        toolName: "massstab_speichern",
        toolDescription: "Speichert die gewaehlten Massstab-Anker.",
        schema: ANKER_SCHEMA,
      });
      const distAus = (r: { anker_a: number; anker_b: number }) => {
        const a = anker[r.anker_a];
        const b = anker[r.anker_b];
        return a && b ? Math.hypot(b.x - a.x, b.y - a.y) : null;
      };
      ref1 = { meter: erg.referenz.meter, beschreibung: erg.referenz.beschreibung, distPx: distAus(erg.referenz) };
      ref2 = erg.kontrolle ? { meter: erg.kontrolle.meter, beschreibung: erg.kontrolle.beschreibung, distPx: distAus(erg.kontrolle) } : null;
    } else {
      // ── Pixel-Modus (Bild-Unterlage): KI schaetzt Punkte ────────
      const erg = await structuredCall<{
        referenz: { punkt1: { x: number; y: number }; punkt2: { x: number; y: number }; meter: number; beschreibung: string };
        kontrolle: { punkt1: { x: number; y: number }; punkt2: { x: number; y: number }; meter: number; beschreibung: string } | null;
      }>({
        system:
          "Du kalibrierst den Massstab eines Saalplans fuer eine Veranstaltungstechnik-Firma. " +
          `Das Bild ist ${unterlage.breite_px} x ${unterlage.hoehe_px} Pixel gross. ` +
          "Finde die Massstabsleiste oder eindeutige Bemassungen und liefere PIXELGENAUE Punktpaare mit ihrer realen Distanz. " +
          "Masszahlen auf Schweizer Bauplaenen sind oft Zentimeter (1165 = 11.65 m).",
        content: [
          { type: "text", text: "Kalibriere diesen Plan:" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: buf.toString("base64") } },
        ],
        toolName: "massstab_speichern",
        toolDescription: "Speichert die gefundenen Massstab-Referenzen.",
        schema: PIXEL_SCHEMA,
      });
      const distAus = (r: { punkt1: { x: number; y: number }; punkt2: { x: number; y: number } }) =>
        Math.hypot(r.punkt2.x - r.punkt1.x, r.punkt2.y - r.punkt1.y);
      ref1 = { meter: erg.referenz.meter, beschreibung: erg.referenz.beschreibung, distPx: distAus(erg.referenz) };
      ref2 = erg.kontrolle ? { meter: erg.kontrolle.meter, beschreibung: erg.kontrolle.beschreibung, distPx: distAus(erg.kontrolle) } : null;
    }

    const ppmAus = (r: Ref) => (r.distPx !== null && r.distPx > 20 && r.meter > 0 ? r.distPx / r.meter : null);
    const p1 = ppmAus(ref1);
    if (!p1) {
      return NextResponse.json({ success: false, error: "Keine brauchbare Massstab-Referenz gefunden — bitte manuell kalibrieren." }, { status: 422 });
    }
    const p2 = ref2 ? ppmAus(ref2) : null;
    if (p2 && Math.abs(p1 - p2) / p1 > 0.1) {
      return NextResponse.json({
        success: false,
        error:
          `Zwei Referenzen widersprechen sich (${p1.toFixed(1)} vs ${p2.toFixed(1)} px/m — ` +
          `${ref1.beschreibung} vs ${ref2!.beschreibung}). Bitte manuell kalibrieren.`,
      }, { status: 422 });
    }
    // Bei zwei stimmigen Referenzen den Mittelwert nehmen.
    const ppm = p2 ? (p1 + p2) / 2 : p1;
    const erg = { referenz: ref1, kontrolle: ref2 };

    const neu: PlanUnterlage = { ...unterlage, px_pro_meter: ppm };
    const { error } = await admin.from("locations").update({ plan_unterlage: neu }).eq("id", locationId);
    if (error) throw new Error(error.message);

    return NextResponse.json({
      success: true,
      px_pro_meter: ppm,
      beschreibung: erg.referenz.beschreibung + (p2 ? ` (bestätigt durch: ${erg.kontrolle!.beschreibung})` : ""),
      kontrolliert: !!p2,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Kalibrierung fehlgeschlagen";
    return NextResponse.json({ success: false, error: msg }, { status: 502 });
  }
}
