// /api/lieferant/wissen — Pakete + Hinweise des Lieferanten ("Mein Wissen").
// GET → eigene Regeln; POST { aktion: "neu" | "toggle" | "loeschen", ... }.
// Diese Regeln prueft EVENTLINE automatisch bei jeder neuen Technik-Position
// — das Fachwissen des Lieferanten arbeitet, bevor er draufschaut.

import { NextRequest, NextResponse } from "next/server";
import { requireLieferantPortal } from "@/lib/technik-server";
import { logError } from "@/lib/log";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fehler = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status });

export async function GET() {
  const gate = await requireLieferantPortal();
  if (gate.error) return gate.error;
  const { admin, lieferantId } = gate;
  const { data } = await admin
    .from("lieferant_regeln")
    .select("id, art, trigger_text, hinweis, paket, is_active, created_at")
    .eq("lieferant_id", lieferantId)
    .order("created_at", { ascending: false });
  return NextResponse.json({ success: true, regeln: data ?? [] });
}

export async function POST(req: NextRequest) {
  const gate = await requireLieferantPortal();
  if (gate.error) return gate.error;
  const { admin, lieferantId, userId } = gate;

  const b = ((await req.json().catch(() => null)) ?? {}) as {
    aktion?: string;
    id?: string;
    art?: string;
    trigger_text?: string;
    hinweis?: string;
    paket?: { bezeichnung?: string; menge?: number; kategorie?: string }[];
    is_active?: boolean;
  };

  try {
    switch (b.aktion) {
      case "neu": {
        const trigger = (b.trigger_text ?? "").trim();
        if (!trigger) return fehler("Stichwort fehlt");
        if (b.art === "hinweis") {
          const hinweis = (b.hinweis ?? "").trim();
          if (!hinweis) return fehler("Hinweis-Text fehlt");
          const { error } = await admin.from("lieferant_regeln").insert({
            lieferant_id: lieferantId, art: "hinweis", trigger_text: trigger, hinweis, created_by: userId,
          });
          if (error) throw error;
        } else if (b.art === "paket") {
          const paket = (b.paket ?? [])
            .map((p) => ({
              bezeichnung: (p.bezeichnung ?? "").trim(),
              menge: Number(p.menge) > 0 ? Number(p.menge) : 1,
              kategorie: p.kategorie?.trim() || undefined,
            }))
            .filter((p) => p.bezeichnung);
          if (paket.length === 0) return fehler("Mindestens eine Paket-Position angeben");
          const { error } = await admin.from("lieferant_regeln").insert({
            lieferant_id: lieferantId, art: "paket", trigger_text: trigger, paket, created_by: userId,
          });
          if (error) throw error;
        } else {
          return fehler("Ungültige Art");
        }
        return NextResponse.json({ success: true });
      }
      case "toggle": {
        if (!b.id || !UUID_RE.test(b.id)) return fehler("id nötig");
        const { error } = await admin
          .from("lieferant_regeln")
          .update({ is_active: b.is_active !== false })
          .eq("id", b.id)
          .eq("lieferant_id", lieferantId);
        if (error) throw error;
        return NextResponse.json({ success: true });
      }
      case "loeschen": {
        if (!b.id || !UUID_RE.test(b.id)) return fehler("id nötig");
        const { error } = await admin.from("lieferant_regeln").delete().eq("id", b.id).eq("lieferant_id", lieferantId);
        if (error) throw error;
        return NextResponse.json({ success: true });
      }
      default:
        return fehler("Unbekannte Aktion");
    }
  } catch (e) {
    logError("api.lieferant.wissen", e, { aktion: b.aktion });
    return NextResponse.json({ success: false, error: "Speichern fehlgeschlagen" }, { status: 500 });
  }
}
