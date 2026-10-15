import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { ladeIndexZeilenNfc, stuecke } from "@/lib/ki/kontext";
import { leseDoppelMeldung } from "@/lib/ki/doppel";
import { rigAuthFehler } from "@/lib/ki/rig-auth";

// POST /api/ki/doppel — Doppel-Liste vom Rig (rig/eventline-ki/dienst/app/duplikate.py, Migration 334).
// Body { lauf_id, rezept, teil, teile, letzter, gruppen: [{ gruppe, art: "gleich"|"fassung",
//        mitglieder: [{ pfad, groesse, mtime, kopie?, rolle?, aehnlichkeit }] }] } — hoechstens 300 Gruppen je Paket.
//   200 { success, gruppen, mitglieder, ohne_index, entfernt }
//   400 Form · 401/503 Auth · 500 → das Rig wiederholt (Backoff)
// Nur Pfade/Groessen/Zeiten/Werte — nie Text. Pfade vom Rig sind NFC; gespeichert wird die Schreibweise des
// Datei-Index (sonst fanden Verschiebe-Auftraege die Datei nicht). Mitglieder, die nicht (mehr) im Index stehen,
// fallen weg; Gruppen mit weniger als zwei auch. Jeder Lauf ersetzt die Liste: Zeilen bekommen die lauf_id, mit dem
// letzten Paket (letzter: true) werden alle Zeilen anderer Laeufe geloescht. Entscheide der Menschen («Beide
// behalten») stehen in nas_doppel_behalten und bleiben. Logs nur mit Anzahlen — nie Pfade.
// Auth: Bearer KI_SYNC_TOKEN.

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const authFehler = rigAuthFehler(request);
  if (authFehler) return authFehler;

  const gelesen = leseDoppelMeldung(await request.json().catch(() => null));
  if (!gelesen.ok) return NextResponse.json({ success: false, error: gelesen.fehler }, { status: 400 });
  const { lauf_id, letzter, gruppen } = gelesen.meldung;

  try {
    const admin = createAdminClient();
    const index = await ladeIndexZeilenNfc(admin, gruppen.flatMap((g) => g.mitglieder.map((m) => m.pfad)));
    const jetzt = new Date().toISOString();
    const zeilen: Record<string, unknown>[] = [];
    let ohneIndex = 0;
    let angenommen = 0;
    for (const g of gruppen) {
      const da = g.mitglieder.filter((m) => {
        const ok = index.has(m.pfad);
        if (!ok) ohneIndex++;
        return ok;
      });
      if (da.length < 2 || (g.art === "fassung" && da.length !== 2)) continue;
      angenommen++;
      for (const m of da) {
        zeilen.push({
          gruppe: g.gruppe,
          art: g.art,
          pfad: index.get(m.pfad)!.pfad,
          groesse: m.groesse,
          geaendert: m.geaendert,
          kopie: m.kopie,
          rolle: m.rolle,
          aehnlichkeit: m.aehnlichkeit,
          lauf_id,
          aktualisiert: jetzt,
        });
      }
    }
    for (const teil of stuecke(zeilen, 200)) {
      const { error } = await admin.from("nas_doppel").upsert(teil, { onConflict: "gruppe,pfad" });
      if (error) throw new Error(`nas_doppel: ${error.message}`);
    }
    let entfernt = 0;
    if (letzter) {
      const { error, count } = await admin.from("nas_doppel").delete({ count: "exact" }).neq("lauf_id", lauf_id);
      if (error) throw new Error(`nas_doppel (alte Läufe): ${error.message}`);
      entfernt = count ?? 0;
    }
    return NextResponse.json({ success: true, gruppen: angenommen, mitglieder: zeilen.length, ohne_index: ohneIndex, entfernt });
  } catch (e) {
    logError("ki.doppel", e, { gruppen: gruppen.length });
    return NextResponse.json({ success: false, error: "Doppel-Liste konnte nicht gespeichert werden" }, { status: 500 });
  }
}
