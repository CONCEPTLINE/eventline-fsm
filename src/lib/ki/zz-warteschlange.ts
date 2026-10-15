// Warteschlange «Rueckstau ZZ mit Claude» (Migration 329, Kurswechsel
// 2026-10-15): Das Rig liefert fuer ZZ-Dateien (rezept zz/v3) kein Ziel
// mehr, sondern einen gefilterten Beschrieb + Fakten-Hinweise
// (nas_zz_beschriebe, angelegt in POST /api/ki/nachtarbeit). Hier fragt die
// App Claude nach Zielordner / neuem Ordner / Dateiname und legt daraus einen
// offenen Vorschlag an (nas_vorschlaege, quelle 'claude') — ein Admin gibt
// frei (/api/ablage/nas-vorschlaege).
//
// Ablauf je Lauf (verarbeiteZzWarteschlange):
//   (a) haengende Zeilen (in_arbeit laenger als 15 min) -> wartet.
//   (b) aelteste wartende Zeilen (versuche < 3) holen; jede einzeln bedingt
//       claimen (wartet -> in_arbeit) — zwei Laeufe gleichzeitig machen so
//       nichts doppelt.
//   (c) einmal je Lauf: aktive Ordner, die letzten 300 Lernbeispiele;
//       Dateinamen (nur Namen, je Ordner max 8) fuer Kandidaten, in den
//       Fakten genannte Ordner und Unterordner von Personalakten-Kandidaten.
//   (d) baueZzEingabe -> Claude (Timeout ~60 s, nie ueber das Budget) ->
//       validiereZzEntscheid (lib/ki/zz-entscheid).
//   (e) ungueltig -> versuche+1 (ab 3: fehler); Datei weg, Ziel = Ist,
//       abgelehnt-Sperre (180 Tage, gleiches Ziel), Verschiebung steht aus
//       -> verworfen; offener Vorschlag mit anderem/keinem Rezept -> bedingt
//       GELOESCHT (noch offen, nie entschieden), direkt bevor der neue
//       eingefuegt wird; 0 Zeilen = inzwischen entschieden -> verworfen.
//       Scheitert danach das Einfuegen, bleibt die Datei bis zum naechsten
//       Lauf ohne Vorschlag (Zeile wieder wartet). Claude gesperrt/ueberlastet -> Zeile zurueck
//       auf wartet (ohne Versuch) und Lauf beenden.
// Der Beschrieb bleibt stehen (Lernbeispiele). `fehler` ist nur ein
// Kurzgrund, Logs nur Anzahlen — nie Pfade, Namen oder Inhalte.

import type { createAdminClient } from "@/lib/supabase/admin";
import { AI_MODEL, ClaudeNichtVerfuegbarError } from "@/lib/ai/anthropic";
import { logError } from "@/lib/log";
import { pruefeNeuenDateinamen } from "./dateiname";
import { ladeAktiveOrdner, ladeIndexZeilen, stuecke } from "./kontext";
import { KI_VORSCHLAG_SPERRE_TAGE } from "./konstanten";
import { nfcZuRoh, zielGesperrt } from "./pfade";
import { pruefeNeuenOrdner } from "./vorschlaege";
import {
  baueZzEingabe,
  frageClaudeZz,
  herkunftAusPfad,
  validiereZzEntscheid,
  waehleBeispiele,
  type Lernbeispiel,
  type ZzBeschrieb,
} from "./zz-entscheid";
import type { OrdnerSicherheit } from "./typen";

type Admin = ReturnType<typeof createAdminClient>;

export const ZZ_MAX_VERSUCHE = 3;
/** in_arbeit laenger als das -> haengt (Lauf abgebrochen), zurueck auf wartet. */
const HAENGT_MS = 15 * 60_000;
const CLAUDE_TIMEOUT_MS = 60_000;
/** Unter diesem Rest-Budget wird keine neue Zeile mehr angefangen. */
const MIN_REST_MS = 15_000;
const BEGRUENDUNG_MAX = 120;
const LERN_ANZAHL = 300;
const BEISPIELE_MAX = 10;
const NAMEN_JE_ORDNER = 8;
const ORDNER_FUER_NAMEN_MAX = 16;

export interface ZzWarteschlangeDeps {
  frageClaude: (eingabe: string) => Promise<unknown>;
}

export interface ZzLaufErgebnis {
  haengendZurueck: number;
  geholt: number;
  fertig: number;
  /** Alte offene Vorschlaege (anderes/kein Rezept), die fuer den neuen geloescht wurden. */
  ersetzt_geloescht: number;
  verworfen: number;
  fehler: number;
  /** Zurueck auf wartet (Budget, Claude gesperrt, Fehler mit Versuchen uebrig). */
  zurueck: number;
  /** Claude gesperrt/ueberlastet/Zugang — Lauf vorzeitig beendet. */
  claudeGesperrt: boolean;
  /** Exakte Doppel (Migration 330) — Vorschlag ohne Claude-Aufruf auf den Ordner der einsortierten Kopie. */
  doppelOhneClaude: number;
}

/** Exakte Kopien ausserhalb des Rueckstaus (nas_doppel, Migration 330): ZZ-Pfad (Index-Schreibweise) → Ordner der
 *  einsortierten Kopie in der Schreibweise der Ordnerliste (aktiv, nie ZZ_… oder 99_System, Kopie noch im Index). Jeder
 *  Fehler (Tabelle fehlt, DB) → leere Liste: der Lauf fragt dann wie bisher Claude. Nie Pfade in Logs. */
async function ladeExakteKopien(
  admin: Admin,
  pfade: readonly string[],
  aktivNfc: ReadonlySet<string>,
  aktivMap: ReadonlyMap<string, string>,
): Promise<Map<string, string>> {
  const aus = new Map<string, string>();
  try {
    type Zeile = { gruppe: string; pfad: string; kopie: number | null };
    const eigene: Zeile[] = [];
    for (const teil of stuecke([...new Set(pfade)], 50)) {
      const { data, error } = await admin.from("nas_doppel").select("gruppe, pfad, kopie").eq("art", "gleich").in("pfad", teil);
      if (error) throw new Error(error.message);
      eigene.push(...((data ?? []) as Zeile[]));
    }
    if (eigene.length === 0) return aus;
    const alle: Zeile[] = [];
    for (const teil of stuecke([...new Set(eigene.map((r) => r.gruppe))], 50)) {
      const { data, error } = await admin.from("nas_doppel").select("gruppe, pfad, kopie").in("gruppe", teil);
      if (error) throw new Error(error.message);
      alle.push(...((data ?? []) as Zeile[]));
    }
    const ausserhalb = alle.filter((r) => !zielGesperrt(r.pfad.slice(0, Math.max(0, r.pfad.lastIndexOf("/")))));
    const idx = await ladeIndexZeilen(admin, ausserhalb.map((r) => r.pfad));
    for (const r of eigene) {
      if (r.kopie === null) continue;
      for (const k of ausserhalb) {
        if (k.gruppe !== r.gruppe || k.pfad === r.pfad || k.kopie !== r.kopie) continue;
        const ordner = idx.get(k.pfad)?.ordner_pfad.normalize("NFC");
        if (ordner && aktivNfc.has(ordner)) {
          aus.set(r.pfad, aktivMap.get(ordner)!);
          break;
        }
      }
    }
  } catch (e) {
    logError("ki.zz.doppel", e instanceof Error ? e.message.slice(0, 120) : "fehler");
    return new Map();
  }
  return aus;
}

interface BeschriebZeile {
  id: string;
  pfad: string;
  sha256: string | null;
  ordner_ist: string;
  rezept: string;
  beschrieb: unknown;
  fakten: unknown;
  kandidaten: string[] | null;
  versuche: number;
  lauf_id: string | null;
}

class Zeitueberschreitung extends Error {}

function mitTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const zeit = new Promise<never>((_, nein) => {
    t = setTimeout(() => nein(new Zeitueberschreitung("zeitueberschreitung")), ms);
  });
  return Promise.race([p, zeit]).finally(() => clearTimeout(t));
}

const alsStrings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);

/** Ordner, fuer die Claude Beispiel-Dateinamen sieht: Kandidaten, in den
 *  Fakten genannte aktive Ordner, Unterordner von Personalakten-Kandidaten
 *  (06_PERSONAL/…). Schreibweise ablage_ordner, hoechstens 16. Rein. */
export function ordnerFuerNamen(kandidaten: readonly string[], fakten: readonly string[], aktivRoh: readonly string[]): string[] {
  const aus: string[] = [];
  const dazu = (o: string) => {
    if (aus.length < ORDNER_FUER_NAMEN_MAX && !aus.includes(o)) aus.push(o);
  };
  for (const k of kandidaten) dazu(k);
  const faktenNfc = fakten.map((f) => f.normalize("NFC"));
  for (const o of aktivRoh) {
    const n = o.normalize("NFC");
    if (n.includes("/") && faktenNfc.some((f) => f.includes(n))) dazu(o);
  }
  for (const k of kandidaten) {
    if (!/^06_PERSONAL\//i.test(k)) continue;
    const praefix = `${k.normalize("NFC")}/`;
    for (const o of aktivRoh) {
      const n = o.normalize("NFC");
      if (n.startsWith(praefix) && !n.slice(praefix.length).includes("/")) dazu(o);
    }
  }
  return aus;
}

export async function verarbeiteZzWarteschlange(
  admin: Admin,
  opts: { budgetMs: number; max: number },
  deps: ZzWarteschlangeDeps = { frageClaude: frageClaudeZz },
): Promise<ZzLaufErgebnis> {
  const start = Date.now();
  const rest = () => opts.budgetMs - (Date.now() - start);
  const erg: ZzLaufErgebnis = {
    haengendZurueck: 0, geholt: 0, fertig: 0, ersetzt_geloescht: 0, verworfen: 0, fehler: 0, zurueck: 0, claudeGesperrt: false,
    doppelOhneClaude: 0,
  };

  // (a) Haengende Zeilen eines abgebrochenen Laufs freigeben.
  const haengtSeit = new Date(start - HAENGT_MS).toISOString();
  const { data: haengend, error: hErr } = await admin
    .from("nas_zz_beschriebe")
    .update({ status: "wartet", updated_at: new Date().toISOString() })
    .eq("status", "in_arbeit")
    .lt("updated_at", haengtSeit)
    .select("id");
  if (hErr) throw new Error(`nas_zz_beschriebe (haengend): ${hErr.message}`);
  erg.haengendZurueck = (haengend ?? []).length;

  // (b) Wartende Zeilen, aelteste zuerst.
  const { data: wartend, error: wErr } = await admin
    .from("nas_zz_beschriebe")
    .select("id, pfad, sha256, ordner_ist, rezept, beschrieb, fakten, kandidaten, versuche, lauf_id")
    .eq("status", "wartet")
    .lt("versuche", ZZ_MAX_VERSUCHE)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(Math.max(1, Math.min(opts.max, 200)));
  if (wErr) throw new Error(`nas_zz_beschriebe: ${wErr.message}`);
  const zeilen = (wartend ?? []) as BeschriebZeile[];
  if (zeilen.length === 0) return erg;

  // (c) Einmal je Lauf: aktive Ordner, Lernbeispiele, Datei-Index.
  const aktivMap = nfcZuRoh(await ladeAktiveOrdner(admin));
  const aktivNfc = new Set([...aktivMap.keys()].filter((o) => !zielGesperrt(o)));
  const aktivRoh = [...aktivNfc].map((o) => aktivMap.get(o)!).sort((a, b) => a.localeCompare(b, "de"));

  let lern: Lernbeispiel[] = [];
  {
    const { data, error } = await admin
      .from("nas_ablage_lernbeispiele")
      .select("aktion, beschrieb, dokart, original_name, vorgeschlagen_ordner, final_ordner, vorgeschlagen_name, final_name, ordner_geaendert, name_geaendert")
      .order("created_at", { ascending: false })
      .limit(LERN_ANZAHL);
    // Ohne Beispiele geht es auch — nur loggen.
    if (error) logError("ki.zz.lernbeispiele", error.message);
    else lern = (data ?? []) as Lernbeispiel[];
  }

  // Schon vorgeschlagene, noch nicht angelegte NEUE Ordner (offen, ziel_neu)
  // — damit Dokumente derselben Person dieselbe neue Akte bekommen; waechst
  // im Lauf mit jedem neuen Vorschlag mit ziel_neu.
  const neueOrdnerOffen: string[] = [];
  {
    const { data, error } = await admin.from("nas_vorschlaege").select("ziel_ordner").eq("status", "offen").eq("ziel_neu", true).limit(1000);
    if (error) throw new Error(`nas_vorschlaege (neue Ordner): ${error.message}`);
    for (const r of data ?? []) {
      const o = r.ziel_ordner as string;
      if (!neueOrdnerOffen.includes(o) && !aktivNfc.has(o.normalize("NFC"))) neueOrdnerOffen.push(o);
    }
  }

  const index = await ladeIndexZeilen(admin, zeilen.map((z) => z.pfad));
  const exakteKopien = await ladeExakteKopien(admin, zeilen.map((z) => z.pfad), aktivNfc, aktivMap);
  const namenCache = new Map<string, readonly string[]>();
  async function namenVon(ordner: readonly string[]): Promise<Map<string, readonly string[]>> {
    const fehlt = ordner.filter((o) => !namenCache.has(o));
    for (const teil of stuecke(fehlt, 4)) {
      await Promise.all(
        teil.map(async (o) => {
          const { data, error } = await admin
            .from("ablage_datei_index")
            .select("name")
            .eq("ordner_pfad", o)
            .order("geaendert", { ascending: false, nullsFirst: false })
            .limit(NAMEN_JE_ORDNER);
          if (error) throw new Error(`Datei-Index (Namen): ${error.message}`);
          namenCache.set(o, (data ?? []).map((r) => r.name as string));
        }),
      );
    }
    return new Map(ordner.map((o) => [o, namenCache.get(o) ?? []]));
  }

  const sperreSeit = new Date(start - KI_VORSCHLAG_SPERRE_TAGE * 86_400_000).toISOString();

  /** Zeile aus in_arbeit weiterschalten (nur aus in_arbeit). */
  async function setze(id: string, felder: Record<string, unknown>): Promise<void> {
    const { error } = await admin
      .from("nas_zz_beschriebe")
      .update({ ...felder, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "in_arbeit");
    if (error) throw new Error(`nas_zz_beschriebe (Status): ${error.message}`);
  }
  async function verwerfen(id: string, grund: string): Promise<void> {
    await setze(id, { status: "verworfen", fehler: grund });
    erg.verworfen++;
  }
  async function fehlschlag(z: BeschriebZeile, grund: string): Promise<void> {
    const versuche = z.versuche + 1;
    const endgueltig = versuche >= ZZ_MAX_VERSUCHE;
    await setze(z.id, { status: endgueltig ? "fehler" : "wartet", versuche, fehler: grund });
    if (endgueltig) erg.fehler++;
    else erg.zurueck++;
  }

  for (const z of zeilen) {
    if (rest() < MIN_REST_MS) break;
    // Claim: nur wer die Zeile von wartet auf in_arbeit setzt, macht weiter.
    const { data: claim, error: cErr } = await admin
      .from("nas_zz_beschriebe")
      .update({ status: "in_arbeit", updated_at: new Date().toISOString() })
      .eq("id", z.id)
      .eq("status", "wartet")
      .select("id");
    if (cErr) throw new Error(`nas_zz_beschriebe (claim): ${cErr.message}`);
    if (!claim || claim.length === 0) continue;
    erg.geholt++;

    try {
      const datei = index.get(z.pfad);
      if (!datei || datei.ordner_pfad.normalize("NFC") !== z.ordner_ist.normalize("NFC")) {
        await verwerfen(z.id, "pfad_bewegt");
        continue;
      }
      // Exaktes Doppel (Migration 330): dieselbe Datei liegt schon einsortiert → kein Claude-Aufruf; der Vorschlag
      // zeigt auf den Ordner der Kopie («nach fester Regel»), die Zeile bietet «Doppel entfernen» (Quarantaene).
      const kopieOrdner = exakteKopien.get(datei.pfad);
      let ziel: string;
      let zielNeu = false;
      const alternativen: string[] = [];
      let sicherheit: OrdnerSicherheit;
      let begruendung: string | null;
      let nameVorschlag: string | null;
      let quelle: "claude" | "regel" = "claude";
      let modell: string = AI_MODEL;
      if (kopieOrdner) {
        ziel = kopieOrdner;
        sicherheit = "hoch";
        begruendung = "Gleiche Datei liegt dort schon — nicht nochmals ablegen";
        nameVorschlag = null;
        quelle = "regel";
        modell = "doppel";
        erg.doppelOhneClaude++;
      } else {
        const fakten = alsStrings(z.fakten);
        const kandidaten = alsStrings(z.kandidaten).filter((k) => aktivNfc.has(k.normalize("NFC")));
        const beschrieb = z.beschrieb as ZzBeschrieb;
        const namenJeOrdner = await namenVon(ordnerFuerNamen(kandidaten, fakten, aktivRoh));
        const eingabe = baueZzEingabe({
          ordner: aktivRoh,
          beschrieb,
          dateiname: datei.name,
          herkunft: herkunftAusPfad(datei.pfad),
          fakten,
          kandidaten,
          namenJeOrdner,
          beispiele: waehleBeispiele(beschrieb, lern, BEISPIELE_MAX),
          neueOrdnerOffen,
        });

        // Claude — nie ueber das Budget hinaus.
        const timeout = Math.min(CLAUDE_TIMEOUT_MS, rest() - 5_000);
        let antwort: unknown;
        try {
          antwort = await mitTimeout(deps.frageClaude(eingabe), timeout);
        } catch (e) {
          if (e instanceof ClaudeNichtVerfuegbarError) {
            await setze(z.id, { status: "wartet" });
            erg.zurueck++;
            erg.claudeGesperrt = true;
            break;
          }
          if (e instanceof Zeitueberschreitung && timeout < CLAUDE_TIMEOUT_MS) {
            // Budget zu knapp, nicht Claude zu langsam: kein Versuch verbraucht.
            await setze(z.id, { status: "wartet" });
            erg.zurueck++;
            break;
          }
          await fehlschlag(z, e instanceof Zeitueberschreitung ? "zeitueberschreitung" : "claude_fehler");
          continue;
        }

        const ent = validiereZzEntscheid(antwort, { aktiv: aktivNfc, originalName: datei.name });
        if (!ent) {
          await fehlschlag(z, "antwort_ungueltig");
          continue;
        }

        // Ziel in der Schreibweise von ablage_ordner; neuer Ordner nur eine
        // Ebene unter einem aktiven (gleiche Pruefung wie beim Uebernehmen).
        const entNfc = ent.ziel_ordner.normalize("NFC");
        if (aktivNfc.has(entNfc)) ziel = aktivMap.get(entNfc)!;
        else if (ent.ziel_neu) {
          const n = pruefeNeuenOrdner(entNfc, aktivMap, datei.ordner_pfad);
          if (!("pfad" in n)) {
            await fehlschlag(z, "antwort_ungueltig");
            continue;
          }
          ziel = n.pfad;
          zielNeu = true;
        } else {
          await fehlschlag(z, "antwort_ungueltig");
          continue;
        }
        for (const a of ent.alternativen) {
          const n = typeof a === "string" ? a.normalize("NFC") : "";
          const roh = aktivNfc.has(n) ? aktivMap.get(n)! : null;
          if (roh && n !== entNfc && n !== datei.ordner_pfad.normalize("NFC") && !alternativen.includes(roh)) alternativen.push(roh);
          if (alternativen.length >= 2) break;
        }
        sicherheit = (["hoch", "mittel", "niedrig"] as const).includes(ent.sicherheit) ? ent.sicherheit : "niedrig";
        begruendung = (typeof ent.begruendung === "string" ? ent.begruendung.trim().slice(0, BEGRUENDUNG_MAX) : "") || null;
        nameVorschlag = pruefeNeuenDateinamen(ent.name_vorschlag, datei.name);
      }
      const zielNfc = ziel.normalize("NFC");
      if (zielNfc === datei.ordner_pfad.normalize("NFC")) {
        await verwerfen(z.id, "ziel_gleich");
        continue;
      }

      // Bekannte Vorschlaege derselben Datei.
      const { data: bekannt, error: bErr } = await admin
        .from("nas_vorschlaege")
        .select("id, ziel_ordner, status, rezept")
        .eq("art", "zz")
        .eq("pfad", datei.pfad)
        .or(`status.in.(offen,angenommen,korrigiert),and(status.eq.abgelehnt,entschieden_am.gte.${sperreSeit})`);
      if (bErr) throw new Error(`nas_vorschlaege: ${bErr.message}`);
      const liste = (bekannt ?? []) as { id: string; ziel_ordner: string; status: string; rezept: string | null }[];
      if (liste.some((v) => v.status === "abgelehnt" && v.ziel_ordner.normalize("NFC") === zielNfc)) {
        await verwerfen(z.id, "abgelehnt_bekannt");
        continue;
      }
      if (liste.some((v) => v.status === "angenommen" || v.status === "korrigiert")) {
        await verwerfen(z.id, "ausstehend");
        continue;
      }
      const alt = liste.find((v) => v.status === "offen");
      if (alt && alt.rezept === z.rezept) {
        await verwerfen(z.id, "doppelt");
        continue;
      }
      if (alt) {
        // Alter offener Vorschlag wird GELOESCHT (Mischa 2026-10-15) — erst
        // jetzt, direkt vor dem neuen (Unique-Index offen je art+pfad), damit
        // die Liste nie leer ist. Bedingt: noch offen, nie entschieden.
        const { data: weg, error: vErr } = await admin
          .from("nas_vorschlaege")
          .delete()
          .eq("id", alt.id)
          .eq("status", "offen")
          .is("entschieden_von", null)
          .select("id");
        if (vErr) throw new Error(`nas_vorschlaege (ersetzen): ${vErr.message}`);
        if (!weg || weg.length === 0) {
          await verwerfen(z.id, "entschieden");
          continue;
        }
      }

      const { data: neu, error: iErr } = await admin
        .from("nas_vorschlaege")
        .insert({
          art: "zz",
          pfad: datei.pfad,
          sha256: z.sha256,
          ordner_ist: datei.ordner_pfad,
          ziel_ordner: ziel,
          ziel_neu: zielNeu,
          alternativen,
          sicherheit,
          quelle,
          begruendung,
          modell,
          lauf_id: z.lauf_id,
          rezept: z.rezept,
          name_vorschlag: nameVorschlag,
        })
        .select("id")
        .single();
      if (iErr) {
        if (iErr.code === "23505") {
          await verwerfen(z.id, "doppelt");
          continue;
        }
        throw new Error(`nas_vorschlaege: ${iErr.message}`);
      }
      await setze(z.id, { status: "fertig", vorschlag_id: neu.id, modell, fehler: null });
      erg.fertig++;
      if (alt) erg.ersetzt_geloescht++;
      if (zielNeu && !neueOrdnerOffen.includes(ziel)) neueOrdnerOffen.push(ziel);
    } catch (e) {
      logError("ki.zz.zeile", e instanceof Error ? e.message.slice(0, 200) : "fehler");
      try {
        await fehlschlag(z, "fehler");
      } catch (e2) {
        // Bleibt in_arbeit — (a) gibt sie nach 15 min wieder frei.
        logError("ki.zz.zeile.status", e2);
      }
    }
  }

  return erg;
}
