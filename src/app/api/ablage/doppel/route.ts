import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { istSystemPfad } from "@/lib/ki/bereinigen";
import { ladeAktiveOrdner, ladeIndexZeilen, stuecke } from "@/lib/ki/kontext";
import { hatZzSegment, nfcZuRoh } from "@/lib/ki/pfade";
import { legeNeuenOrdnerAn, pruefeEntscheidName, schreibeLernbeispiel } from "@/lib/ki/vorschlaege";
import { dokartAus, type ZzBeschrieb } from "@/lib/ki/zz-entscheid";
import {
  DOPPEL_QUARANTAENE,
  behaltenPaar,
  historieFuer,
  imRueckstau,
  liegtInHistorie,
  nameVonPfad,
  ordnerVonPfad,
  quarantaeneOrdner,
  type DoppelGruppe,
  type DoppelMitglied,
} from "@/lib/ki/doppel";
import { KI_PFAD_MAX } from "@/lib/ki/konstanten";

// Doppel-Pruefung (Migration 330, lib/ki/doppel) — nur Admin (wie die NAS-Seite).
//
// GET  → { success, gruppen: DoppelGruppe[], behalten: [a, b][], stand: { aktualisiert, lauf_id } | null }
//        Gruppen der letzten Rig-Liste, nur Mitglieder, die noch im Datei-Index stehen und nicht gerade in den
//        Systembereich (Quarantaene/Papierkorb) verschoben werden; Gruppen mit weniger als zwei fallen weg.
// POST { aktion: "entfernen", pfad }
//        → Verschiebe-Auftrag nach 99_System/Duplikate/<Datum>/<Ordner> (NIE loeschen; ausgefuehrt vom NAS-Sync wie
//          jede Verschiebung). Nur fuer bekannte Doppel und nie die letzte Kopie einer Gruppe. Offener ZZ-Vorschlag
//          der Datei → Status «doppel» (kein Lernbeispiel — das ist kein Ablage-Entscheid). Idempotent.
// POST { aktion: "behalten", pfad, anderer } → Paar in nas_doppel_behalten (erscheint nicht mehr). Idempotent.
// POST { aktion: "fassung", vorschlag_id, pfad, anderer, name? }
//        → «Als neue Fassung ablegen» aus dem Rueckstau ZZ: die alte Fassung (anderer) in den Historie-Ordner ihres
//          Ordners (vorhandener «…Historie…» oder neu, Benennung wie im Haus), die neue (pfad, ZZ) an ihren Platz —
//          unter `name` (gleiche Pruefung wie «Übernehmen»). Der ZZ-Vorschlag wird angenommen/korrigiert wie bei
//          «Übernehmen» (Lernbeispiel bei Claude-Vorschlaegen). Liegt die alte schon in einer Historie, bleibt sie dort
//          und die neue kommt in den Ordner darueber.
// Antwort POST: { success, ziel?, historie? } · 400 Form · 404 unbekannt · 409 Konflikt (veraltet, letzte Kopie,
// schon entschieden, Verschiebung steht aus) · 500. Logs nur mit Anzahlen/Codes — nie Pfade.

type Admin = ReturnType<typeof createAdminClient>;

function lesePfad(roh: unknown): string | null {
  if (typeof roh !== "string") return null;
  const p = roh.trim();
  if (!p || p.length > KI_PFAD_MAX || p.startsWith("/") || p.includes("..") || p.includes("\\")) return null;
  return p;
}

function fehler(status: number, text: string) {
  return NextResponse.json({ success: false, error: text }, { status });
}

/** Verschiebe-Auftraege fuer diese Pfade (pfad -> ziel_ordner). */
async function ladeMoves(admin: Admin, pfade: readonly string[]): Promise<Map<string, string>> {
  const aus = new Map<string, string>();
  for (const teil of stuecke([...new Set(pfade)], 20)) {
    const { data, error } = await admin.from("ablage_moves").select("pfad, ziel_ordner").in("pfad", teil);
    if (error) throw new Error(`ablage_moves: ${error.message}`);
    for (const m of data ?? []) aus.set(m.pfad as string, m.ziel_ordner as string);
  }
  return aus;
}

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  try {
    const admin = createAdminClient();
    const { data: zeilen, error } = await admin
      .from("nas_doppel")
      .select("gruppe, art, pfad, groesse, geaendert, kopie, rolle, aehnlichkeit, lauf_id, aktualisiert")
      .order("gruppe")
      .order("pfad")
      .limit(5000);
    if (error) {
      // Migration 330 noch nicht eingespielt → leer statt Fehler.
      if (error.code === "42P01" || error.code === "PGRST205") return NextResponse.json({ success: true, gruppen: [], behalten: [], stand: null });
      throw new Error(error.message);
    }
    const rows = zeilen ?? [];
    const pfade = rows.map((r) => r.pfad as string);
    const index = await ladeIndexZeilen(admin, pfade);
    const moves = await ladeMoves(admin, pfade);
    const je = new Map<string, DoppelGruppe>();
    for (const r of rows) {
      const pfad = r.pfad as string;
      const z = index.get(pfad);
      if (!z) continue;
      const ziel = moves.get(pfad);
      if (ziel && istSystemPfad(ziel)) continue;
      const g = je.get(r.gruppe as string) ?? { gruppe: r.gruppe as string, art: r.art as DoppelGruppe["art"], mitglieder: [] };
      const m: DoppelMitglied = {
        pfad,
        name: z.name,
        ordner: z.ordner_pfad,
        groesse: (r.groesse as number | null) ?? null,
        geaendert: (r.geaendert as string | null) ?? z.geaendert ?? null,
        kopie: (r.kopie as number | null) ?? null,
        rolle: (r.rolle as DoppelMitglied["rolle"]) ?? null,
        aehnlichkeit: (r.aehnlichkeit as number | null) ?? null,
        zz: imRueckstau(pfad),
      };
      g.mitglieder.push(m);
      je.set(g.gruppe, g);
    }
    const gruppen = [...je.values()].filter((g) => (g.art === "fassung" ? g.mitglieder.length === 2 : g.mitglieder.length >= 2));
    const { data: beh } = await admin.from("nas_doppel_behalten").select("pfad, anderer").limit(5000);
    const stand = rows.length
      ? rows.reduce((a, r) => ((r.aktualisiert as string) > a.aktualisiert ? { aktualisiert: r.aktualisiert as string, lauf_id: r.lauf_id as string } : a),
        { aktualisiert: "", lauf_id: "" })
      : null;
    return NextResponse.json(
      { success: true, gruppen, behalten: (beh ?? []).map((b) => [b.pfad as string, b.anderer as string]), stand },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    logError("ablage.doppel.get", e);
    return fehler(500, "Doppel-Liste konnte nicht geladen werden");
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const aktion = body?.aktion;
  const pfad = lesePfad(body?.pfad);
  if (!pfad) return fehler(400, "pfad fehlt oder ist ungültig");
  try {
    const admin = createAdminClient();
    if (aktion === "entfernen") return await entfernen(admin, pfad, auth.user.id);
    if (aktion === "behalten") {
      const anderer = lesePfad(body?.anderer);
      if (!anderer || anderer === pfad) return fehler(400, "anderer fehlt oder ist ungültig");
      const [a, b] = behaltenPaar(pfad, anderer);
      const { error } = await admin
        .from("nas_doppel_behalten")
        .upsert({ pfad: a, anderer: b, entschieden_von: auth.user.id }, { onConflict: "pfad,anderer", ignoreDuplicates: true });
      if (error) throw new Error(`nas_doppel_behalten: ${error.message}`);
      return NextResponse.json({ success: true });
    }
    if (aktion === "fassung") {
      const anderer = lesePfad(body?.anderer);
      const vorschlagId = typeof body?.vorschlag_id === "string" ? body.vorschlag_id : "";
      if (!anderer || anderer === pfad) return fehler(400, "anderer fehlt oder ist ungültig");
      if (!/^[0-9a-f-]{36}$/i.test(vorschlagId)) return fehler(400, "vorschlag_id fehlt");
      return await alsFassung(admin, { pfad, anderer, vorschlagId, name: typeof body?.name === "string" ? body.name : undefined }, auth.user.id);
    }
    return fehler(400, "aktion muss entfernen, behalten oder fassung sein");
  } catch (e) {
    logError("ablage.doppel.post", e, { aktion: String(aktion ?? "") });
    return fehler(500, "Aktion konnte nicht ausgeführt werden");
  }
}

async function entfernen(admin: Admin, pfad: string, userId: string) {
  const { data: mitglied, error } = await admin.from("nas_doppel").select("gruppe").eq("pfad", pfad).eq("art", "gleich");
  if (error) throw new Error(`nas_doppel: ${error.message}`);
  const gruppen = [...new Set((mitglied ?? []).map((r) => r.gruppe as string))];
  if (gruppen.length === 0) return fehler(404, "Kein bekanntes Doppel — nichts verschoben");
  const { data: alle, error: aErr } = await admin.from("nas_doppel").select("pfad").in("gruppe", gruppen);
  if (aErr) throw new Error(`nas_doppel: ${aErr.message}`);
  const andere = [...new Set((alle ?? []).map((r) => r.pfad as string))].filter((p) => p !== pfad);
  const index = await ladeIndexZeilen(admin, [pfad, ...andere]);
  const zeile = index.get(pfad);
  if (!zeile) return fehler(409, "Datei liegt nicht mehr dort");
  const moves = await ladeMoves(admin, [pfad, ...andere]);
  // Bleibt nach dem Verschieben noch eine Kopie? (Andere, die gerade in den Systembereich wandern, zaehlen nicht.)
  const bleibt = andere.filter((p) => index.has(p) && !istSystemPfad(moves.get(p) ?? ""));
  const schon = moves.get(pfad);
  if (schon !== undefined) {
    if (schon.startsWith(DOPPEL_QUARANTAENE + "/")) return NextResponse.json({ success: true, ziel: schon });
    return fehler(409, "Für diese Datei steht schon eine Verschiebung aus");
  }
  if (bleibt.length === 0) return fehler(409, "Das ist die letzte Kopie — sie bleibt, wo sie ist");
  const ziel = quarantaeneOrdner(zeile.ordner_pfad, new Date());
  const { error: mErr } = await admin.from("ablage_moves").insert({ pfad, ziel_ordner: ziel });
  if (mErr) {
    if (mErr.code === "23505") {
      const nochmal = await ladeMoves(admin, [pfad]);
      const z = nochmal.get(pfad) ?? "";
      if (z.startsWith(DOPPEL_QUARANTAENE + "/")) return NextResponse.json({ success: true, ziel: z });
      return fehler(409, "Für diese Datei steht schon eine Verschiebung aus");
    }
    throw new Error(`ablage_moves: ${mErr.message}`);
  }
  const jetzt = new Date().toISOString();
  const { error: vErr } = await admin
    .from("nas_vorschlaege")
    .update({ status: "doppel", gewaehlt_ordner: ziel, gewaehlt_name: null, entschieden_von: userId, entschieden_am: jetzt, updated_at: jetzt })
    .eq("pfad", pfad)
    .eq("art", "zz")
    .eq("status", "offen");
  if (vErr) logError("ablage.doppel.vorschlag", vErr.message);
  return NextResponse.json({ success: true, ziel });
}

interface FassungEingabe {
  pfad: string;
  anderer: string;
  vorschlagId: string;
  name?: string;
}

async function alsFassung(admin: Admin, e: FassungEingabe, userId: string) {
  const { data: v, error: vErr } = await admin
    .from("nas_vorschlaege")
    .select("id, art, pfad, ziel_ordner, status, quelle, name_vorschlag")
    .eq("id", e.vorschlagId)
    .maybeSingle();
  if (vErr) throw new Error(`nas_vorschlaege: ${vErr.message}`);
  if (!v || v.art !== "zz") return fehler(404, "Vorschlag nicht gefunden");
  if (v.pfad !== e.pfad) return fehler(400, "Vorschlag gehört zu einer anderen Datei");
  if (v.status !== "offen") return fehler(409, "Schon entschieden");

  // Nur eine vom Rig erkannte Fassung (pfad = neu, anderer = alt).
  const { data: f, error: fErr } = await admin.from("nas_doppel").select("gruppe, pfad, rolle").eq("art", "fassung").in("pfad", [e.pfad, e.anderer]);
  if (fErr) throw new Error(`nas_doppel: ${fErr.message}`);
  const neuIn = new Set((f ?? []).filter((r) => r.pfad === e.pfad && r.rolle === "neu").map((r) => r.gruppe as string));
  const passt = (f ?? []).some((r) => r.pfad === e.anderer && r.rolle === "alt" && neuIn.has(r.gruppe as string));
  if (!passt) return fehler(409, "Keine bekannte neuere Fassung");

  const index = await ladeIndexZeilen(admin, [e.pfad, e.anderer]);
  const neu = index.get(e.pfad);
  const alt = index.get(e.anderer);
  if (!neu || !alt) return fehler(409, "Datei liegt nicht mehr dort");
  if (hatZzSegment(alt.ordner_pfad) || istSystemPfad(alt.ordner_pfad)) return fehler(409, "Die ältere Fassung liegt selbst im Rückstau");

  // Zielordner: Ordner der alten Fassung; liegt sie schon in einer Historie, der Ordner darueber (sie bleibt dort).
  let ziel = alt.ordner_pfad;
  let historie: { pfad: string; neu: boolean } | null = null;
  if (liegtInHistorie(e.anderer)) {
    const teile = alt.ordner_pfad.split("/");
    const i = teile.findIndex((s) => /histor/i.test(s));
    ziel = teile.slice(0, i).join("/");
  } else {
    // «_» ist in LIKE ein Platzhalter — mehr Treffer schaden nicht, historieFuer nimmt nur direkte Unterordner.
    const { data: unter, error: uErr } = await admin.from("ablage_ordner").select("pfad").like("pfad", `${alt.ordner_pfad}/%`).limit(1000);
    if (uErr) throw new Error(`ablage_ordner: ${uErr.message}`);
    historie = historieFuer(alt.ordner_pfad, (unter ?? []).map((u) => u.pfad as string));
  }
  const aktiv = nfcZuRoh(await ladeAktiveOrdner(admin));
  const zielRoh = aktiv.get(ziel.normalize("NFC"));
  if (!zielRoh || hatZzSegment(zielRoh) || istSystemPfad(zielRoh)) return fehler(409, "Der Ordner der älteren Fassung ist gesperrt");
  const benannt = pruefeEntscheidName(e.name, e.pfad);
  if (!("name" in benannt)) return fehler(400, benannt.fehler);
  const neuerName = benannt.name;

  const jetzt = new Date().toISOString();
  const status = zielRoh.normalize("NFC") === String(v.ziel_ordner).normalize("NFC") ? "angenommen" : "korrigiert";
  const { data: gesetzt, error: sErr } = await admin
    .from("nas_vorschlaege")
    .update({ status, gewaehlt_ordner: zielRoh, gewaehlt_name: neuerName, entschieden_von: userId, entschieden_am: jetzt, updated_at: jetzt })
    .eq("id", v.id)
    .eq("status", "offen")
    .select("id");
  if (sErr) throw new Error(`nas_vorschlaege: ${sErr.message}`);
  if ((gesetzt ?? []).length === 0) return fehler(409, "Schon entschieden");

  const zurueck = async () => {
    const { error } = await admin
      .from("nas_vorschlaege")
      .update({ status: "offen", gewaehlt_ordner: null, gewaehlt_name: null, entschieden_von: null, entschieden_am: null, updated_at: new Date().toISOString() })
      .eq("id", v.id)
      .eq("status", status);
    if (error) logError("ablage.doppel.zurueck", error.message);
  };

  // 1) Historie-Ordner anlegen (falls neu) und die alte Fassung dorthin — zuerst, damit die neue danach am Platz
  //    nie mit dem alten Namen kollidiert (der Sync arbeitet die Auftraege in Reihenfolge ab).
  let altEingetragen = false;
  if (historie) {
    if (historie.neu) {
      const oErr = await legeNeuenOrdnerAn(admin, historie.pfad);
      if (oErr) {
        await zurueck();
        logError("ablage.doppel.historie", oErr.message);
        return fehler(500, "Historie-Ordner konnte nicht angelegt werden");
      }
    }
    const { error: aErr } = await admin.from("ablage_moves").insert({ pfad: e.anderer, ziel_ordner: historie.pfad });
    if (aErr) {
      await zurueck();
      if (aErr.code === "23505") return fehler(409, "Für die ältere Fassung steht schon eine Verschiebung aus");
      throw new Error(`ablage_moves: ${aErr.message}`);
    }
    altEingetragen = true;
  }
  // 2) Die neue Fassung an den Platz der alten.
  const { error: nErr } = await admin.from("ablage_moves").insert({ pfad: e.pfad, ziel_ordner: zielRoh, neuer_name: neuerName });
  if (nErr) {
    if (altEingetragen) {
      const { error: dErr } = await admin.from("ablage_moves").delete().eq("pfad", e.anderer).eq("ziel_ordner", historie!.pfad);
      if (dErr) logError("ablage.doppel.zurueck_move", dErr.message);
    }
    await zurueck();
    if (nErr.code === "23505") return fehler(409, "Für diese Datei steht schon eine Verschiebung aus");
    throw new Error(`ablage_moves: ${nErr.message}`);
  }
  if (v.quelle === "claude") {
    await schreibeLernbeispiel(
      admin,
      {
        vorschlag: { id: v.id as string, pfad: v.pfad as string, ziel_ordner: v.ziel_ordner as string, name_vorschlag: (v.name_vorschlag as string | null) ?? null },
        aktion: status,
        finalOrdner: zielRoh,
        finalName: neuerName,
        userId,
      },
      (b) => dokartAus(b as ZzBeschrieb),
    );
  }
  return NextResponse.json({ success: true, ziel: zielRoh, historie: historie?.pfad ?? null, name: neuerName ?? nameVonPfad(e.pfad), ordner: ordnerVonPfad(e.pfad) });
}
