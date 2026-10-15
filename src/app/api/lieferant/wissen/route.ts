// /api/lieferant/wissen — «Mein Wissen» des Lieferanten: Regeln aus einem
// Stichwort plus Paket (Material, das immer dazugehoert) oder Hinweis (ein
// Satz zum Mitdenken). EVENTLINE sieht eine Regel automatisch, sobald eine
// geplante Technik-Position das Stichwort enthaelt (passendeRegeln in
// src/lib/technik.ts) — das Fachwissen arbeitet, bevor der Lieferant
// draufschaut.
//
//   GET  → eigene Regeln (neueste zuerst)
//   POST { aktion: "neu" | "toggle" | "loeschen", ... }
//
// Zugriff ueber requireLieferantPortal: immer die EIGENE Firma («Ansicht
// als» = Firma der angesehenen Person; Schreiben sperrt dort die
// Middleware, solange die Bearbeitung nicht freigegeben ist). Freitexte
// begrenzt WISSEN_GRENZEN — die Eingabefelder haben dieselben Grenzen.

import { NextRequest, NextResponse } from "next/server";
import { requireLieferantPortal } from "@/lib/technik-server";
import { WISSEN_GRENZEN as G } from "@/lib/lieferant-wissen";
import { logError } from "@/lib/log";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fehler = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status });

export async function GET() {
  const gate = await requireLieferantPortal();
  if (gate.error) return gate.error;
  const { admin, lieferantId } = gate;
  const { data, error } = await admin
    .from("lieferant_regeln")
    .select("id, art, trigger_text, hinweis, paket, is_active, created_at")
    .eq("lieferant_id", lieferantId)
    .order("created_at", { ascending: false });
  if (error) {
    logError("api.lieferant.wissen.laden", error, { lieferantId });
    return fehler("Dein Wissen konnte nicht geladen werden", 500);
  }
  return NextResponse.json({ success: true, regeln: data ?? [] });
}

/** Freitext pruefen: getrimmt, Mindest- und Hoechstlaenge. */
function textFeld(wert: unknown, feld: string, max: number, min = 1): { text: string } | { fehler: string } {
  const t = typeof wert === "string" ? wert.trim() : "";
  if (t.length === 0) return { fehler: `${feld} fehlt` };
  if (t.length < min) return { fehler: `${feld}: mindestens ${min} Zeichen` };
  if (t.length > max) return { fehler: `${feld} ist zu lang (höchstens ${max} Zeichen)` };
  return { text: t };
}

type PaketZeile = { bezeichnung: string; menge: number; kategorie?: string };

/** Paket-Zeilen pruefen: leere Zeilen fallen weg, Menge ganzzahlig 1–mengeMax. */
function paketPruefen(roh: unknown): { paket: PaketZeile[] } | { fehler: string } {
  if (!Array.isArray(roh)) return { fehler: "Mindestens eine Paket-Position angeben" };
  if (roh.length > G.positionenMax) return { fehler: `Höchstens ${G.positionenMax} Positionen pro Paket` };
  const paket: PaketZeile[] = [];
  for (const z of roh as { bezeichnung?: unknown; menge?: unknown; kategorie?: unknown }[]) {
    const bezeichnung = typeof z?.bezeichnung === "string" ? z.bezeichnung.trim() : "";
    if (!bezeichnung) continue;
    const kurz = bezeichnung.length > 30 ? `${bezeichnung.slice(0, 30)}…` : bezeichnung;
    if (bezeichnung.length > G.bezeichnungMax) {
      return { fehler: `«${kurz}» ist zu lang (höchstens ${G.bezeichnungMax} Zeichen)` };
    }
    const menge = Number(z.menge);
    if (!Number.isInteger(menge) || menge < 1 || menge > G.mengeMax) {
      return { fehler: `Menge bei «${kurz}»: ganze Zahl von 1 bis ${G.mengeMax}` };
    }
    const kategorie = typeof z.kategorie === "string" ? z.kategorie.trim() : "";
    if (kategorie.length > G.kategorieMax) {
      return { fehler: `Kategorie bei «${kurz}» ist zu lang (höchstens ${G.kategorieMax} Zeichen)` };
    }
    paket.push(kategorie ? { bezeichnung, menge, kategorie } : { bezeichnung, menge });
  }
  if (paket.length === 0) return { fehler: "Mindestens eine Paket-Position angeben" };
  return { paket };
}

export async function POST(req: NextRequest) {
  const gate = await requireLieferantPortal();
  if (gate.error) return gate.error;
  const { admin, lieferantId, userId } = gate;

  let b: { aktion?: unknown; id?: unknown; art?: unknown; trigger_text?: unknown; hinweis?: unknown; paket?: unknown; is_active?: unknown };
  try {
    b = await req.json();
  } catch {
    return fehler("Ungültige Anfrage");
  }
  if (!b || typeof b !== "object") return fehler("Ungültige Anfrage");

  try {
    switch (b.aktion) {
      case "neu": {
        const stichwort = textFeld(b.trigger_text, "Stichwort", G.stichwortMax, G.stichwortMin);
        if ("fehler" in stichwort) return fehler(stichwort.fehler);
        if (b.art === "hinweis") {
          const hinweis = textFeld(b.hinweis, "Hinweis", G.hinweisMax);
          if ("fehler" in hinweis) return fehler(hinweis.fehler);
          const { error } = await admin.from("lieferant_regeln").insert({
            lieferant_id: lieferantId, art: "hinweis", trigger_text: stichwort.text, hinweis: hinweis.text, created_by: userId,
          });
          if (error) throw error;
        } else if (b.art === "paket") {
          const geprueft = paketPruefen(b.paket);
          if ("fehler" in geprueft) return fehler(geprueft.fehler);
          const { error } = await admin.from("lieferant_regeln").insert({
            lieferant_id: lieferantId, art: "paket", trigger_text: stichwort.text, paket: geprueft.paket, created_by: userId,
          });
          if (error) throw error;
        } else {
          return fehler("Ungültige Art");
        }
        return NextResponse.json({ success: true });
      }
      case "toggle": {
        if (typeof b.id !== "string" || !UUID_RE.test(b.id)) return fehler("Ungültige Regel");
        if (typeof b.is_active !== "boolean") return fehler("Ungültiger Status");
        const { data, error } = await admin
          .from("lieferant_regeln")
          .update({ is_active: b.is_active })
          .eq("id", b.id)
          .eq("lieferant_id", lieferantId)
          .select("id");
        if (error) throw error;
        if (!data?.length) return fehler("Regel nicht gefunden", 404);
        return NextResponse.json({ success: true });
      }
      case "loeschen": {
        if (typeof b.id !== "string" || !UUID_RE.test(b.id)) return fehler("Ungültige Regel");
        const { data, error } = await admin
          .from("lieferant_regeln")
          .delete()
          .eq("id", b.id)
          .eq("lieferant_id", lieferantId)
          .select("id");
        if (error) throw error;
        if (!data?.length) return fehler("Regel nicht gefunden", 404);
        return NextResponse.json({ success: true });
      }
      default:
        return fehler("Unbekannte Aktion");
    }
  } catch (e) {
    logError("api.lieferant.wissen", e, { aktion: String(b.aktion ?? ""), lieferantId });
    return fehler("Speichern fehlgeschlagen", 500);
  }
}
