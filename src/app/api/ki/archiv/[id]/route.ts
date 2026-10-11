import { NextRequest, NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { bereinigeArchivFrageErgebnis, quellenFuerAnzeige } from "@/lib/ki/bereinigen";
import { ladeIndexZeilen } from "@/lib/ki/kontext";

// GET /api/ki/archiv/<id> — Antwort auf «Frag das Archiv» abholen
// (docs/lokale-ki/MASTERPLAN.md §3.4). Der Browser fragt alle 1,5 s nach.
//   offen/laeuft → { success, status }
//   fertig       → { success, status: "fertig", antwort, quellen: [{ pfad, name, ordner, seite }], modell, dauer_ms }
//   fehler       → { success, status: "fehler", fehler }
//   unbekannt    → 404 (auch: fremder Auftrag, schon gelesen, aufgeraeumt)
// Fertig/fehler wird beim Lesen GELOESCHT (bedingtes DELETE … RETURNING) —
// die Antwort ist genau einmal lesbar. Gleiches Recht wie POST, nur der
// eigene Auftrag (created_by = echter angemeldeter Nutzer). Quellen nur, wenn
// der Pfad im Datei-Index steht (nicht 99_System/). Logs nie mit Inhalt.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEIN_CACHE = { "Cache-Control": "no-store" };

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireTrustedDevice("nas:ablage");
  if (auth.error) return auth.error;
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ success: false, error: "Ungültige ID" }, { status: 400 });
  }
  const nichtGefunden = () => NextResponse.json({ success: false, error: "Frage nicht gefunden" }, { status: 404 });

  try {
    const admin = createAdminClient();
    const { data: zeile, error } = await admin
      .from("ki_auftraege")
      .select("status, ergebnis, fehler")
      .eq("id", id)
      .eq("art", "archiv_frage")
      .eq("created_by", auth.user.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!zeile) return nichtGefunden();
    if (zeile.status === "offen" || zeile.status === "laeuft") {
      return NextResponse.json({ success: true, status: zeile.status }, { headers: KEIN_CACHE });
    }

    // Abgeschlossen: Antwort zuerst fertig aufbereiten (Quellen gegen den
    // Index), DANN loeschen — scheitert die Aufbereitung, bleibt die Antwort
    // fuer den naechsten Abruf liegen. Das Loeschen ist bedingt (DELETE …
    // RETURNING): kommt nichts zurueck, hat ein paralleler Abruf die Antwort
    // schon geholt -> 404. So ist sie genau einmal lesbar.
    const ergebnis =
      zeile.status === "fertig" && zeile.ergebnis && typeof zeile.ergebnis === "object" && !Array.isArray(zeile.ergebnis)
        ? bereinigeArchivFrageErgebnis(zeile.ergebnis as Record<string, unknown>)
        : null;
    const antwort = ergebnis
      ? {
          success: true,
          status: "fertig",
          antwort: ergebnis.antwort,
          quellen: quellenFuerAnzeige(ergebnis.quellen, await ladeIndexZeilen(admin, ergebnis.quellen.map((q) => q.pfad))),
          modell: ergebnis.modell,
          dauer_ms: ergebnis.dauer_ms,
        }
      : {
          success: true,
          status: "fehler",
          fehler:
            zeile.status === "fehler"
              ? String(zeile.fehler ?? "").trim().slice(0, 300) || "Die lokale KI konnte die Frage nicht beantworten"
              : "Die lokale KI hat keine gültige Antwort geliefert",
        };

    const { data: geloescht, error: delErr } = await admin
      .from("ki_auftraege")
      .delete()
      .eq("id", id)
      .eq("art", "archiv_frage")
      .eq("created_by", auth.user.id)
      .in("status", ["fertig", "fehler"])
      .select("id");
    if (delErr) throw new Error(delErr.message);
    if (!geloescht || geloescht.length === 0) return nichtGefunden();
    return NextResponse.json(antwort, { headers: KEIN_CACHE });
  } catch (e) {
    logError("ki.archiv.abholen", e, { id });
    return NextResponse.json({ success: false, error: "Antwort konnte nicht gelesen werden" }, { status: 500 });
  }
}
