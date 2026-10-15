// Kontext der lokalen KI aus der Datenbank — EINE Quelle fuer den Kontext
// eines `ablage_analyse`-Auftrags (GET /api/ki/sync) und den Kontext der
// Nachtarbeit (GET /api/ki/kontext, docs/lokale-ki/MASTERPLAN.md §3.5),
// dazu die Index-Abfrage fuer Suche, Archiv-Frage und Nachtarbeit.
// Alles ueber den Admin-Client (Service-Role); Aufrufer sind die Routen.

import type { createAdminClient } from "@/lib/supabase/admin";
import { DOK_TYPEN } from "@/lib/ablage-doktypen";
import { istIntern } from "@/lib/roles";
import { todayLocalIso } from "@/lib/swiss-time";
import { logError } from "@/lib/log";
import { ladeWissenAktiv, wissenFuerRig } from "./wissen";
import { KI_KONTEXT_MAX_BEKANNT, KI_PERSON_TYPEN, KI_VORSCHLAG_SPERRE_TAGE } from "./konstanten";
import type { IndexZeile } from "./bereinigen";
import { nfcZuRoh, pfadSchreibweisen } from "./pfade";
import type { AblageAnalyseKontext, FristArt, FristStatus, NachtKontext, NasVorschlagArt, NasVorschlagStatus, ZzBeschriebStatus } from "./typen";

type Admin = ReturnType<typeof createAdminClient>;

/** Kontext fuer ablage_analyse: aktive Ordner (inkl. vererbter Sperre, wie
 *  name-vorschlag), DOK_TYPEN, aktive interne Mitarbeiter (Personen-Auswahl)
 *  und V8 die Namen ALLER Profile (Minimierung, Personalakten), heute.
 *
 *  `streng` (Nachtarbeit): ein Lesefehler wirft, statt still eine leere
 *  Liste zu liefern — ohne Ordnerliste darf das Rig nichts vorschlagen. Der
 *  Abhol-Pfad bleibt beim bisherigen Verhalten (ein Fehler dort wuerde einen
 *  schon beanspruchten Auftrag haengen lassen). */
export async function ladeAblageKontext(admin: Admin, opts: { streng?: boolean } = {}): Promise<AblageAnalyseKontext> {
  const { data: alleOrdner, error: ordnerErr } = await admin.from("ablage_ordner").select("pfad, aktiv").order("pfad").limit(2000);
  if (ordnerErr && opts.streng) throw new Error(`Ordnerliste: ${ordnerErr.message}`);
  const ordner = aktiveOrdnerAus(alleOrdner ?? []).slice(0, 500);
  // Alle Profile in einer Abfrage: `mitarbeiter` = aktiv und intern (nur sie
  // darf das Modell als Person setzen); `namen_alle` = jeder Name, auch
  // inaktive und Portal-Rollen — ein Ex-Mitarbeiter im Text ist genauso
  // personenbezogen, und seine Personalakte liegt weiter auf dem NAS.
  const { data: profile, error: profilErr } = await admin.from("profiles").select("full_name, is_active, role").order("full_name");
  if (profilErr && opts.streng) throw new Error(`Profile: ${profilErr.message}`);
  const name = (p: { full_name: unknown }) => String(p.full_name ?? "").trim();
  const mitarbeiter = (profile ?? [])
    .filter((p) => p.is_active === true && istIntern(p.role as string | null))
    .map(name)
    .filter(Boolean);
  const namenAlle = [...new Set((profile ?? []).map(name).filter(Boolean))];
  return {
    ordner,
    // `person` = darf die KI eine betroffene Person SETZEN. Im Formular ist die
    // Person seit 2026-10-03 bei jedem Typ waehlbar (Portrait von Dario), die
    // KI soll sie aber nur bei personenbezogenen Typen vorschlagen — der
    // Probelauf zeigte: das 4B-Modell setzt sonst bei 118 von 127 Dokumenten
    // einen Namen (Location-Vertraege, Projektunterlagen …).
    dok_typen: DOK_TYPEN.map((t) => ({ key: t.key, label: t.label, person: KI_PERSON_TYPEN.has(t.key) })),
    mitarbeiter,
    namen_alle: namenAlle,
    heute: todayLocalIso(),
  };
}

/** Effektiv aktive Ordner: aktiv und nicht unter einem inaktiven Ordner
 *  (vererbte Sperre, wie name-vorschlag und die NAS-Seite). */
function aktiveOrdnerAus(alle: readonly { pfad: unknown; aktiv: unknown }[]): string[] {
  const inaktiv = alle.filter((o) => !o.aktiv).map((o) => o.pfad as string);
  return alle.map((o) => o.pfad as string).filter((p) => !inaktiv.some((i) => p === i || p.startsWith(i + "/")));
}

/** Alle effektiv aktiven Ordner OHNE Kappung (die 500 im Kontext begrenzen
 *  nur die Liste fuer das Modell) — fuer die Pruefung eines Ziels, das ein
 *  Admin im FSM bestaetigt (MP-7). Wirft bei Lesefehlern. */
export async function ladeAktiveOrdner(admin: Admin): Promise<Set<string>> {
  // seitenweise: PostgREST liefert je Abfrage hoechstens 1000 Zeilen.
  const alle = await seitenweise<{ pfad: string; aktiv: boolean }>(
    (von, bis) => admin.from("ablage_ordner").select("pfad, aktiv").order("pfad").range(von, bis),
    20_000,
  ).catch((e: unknown) => {
    throw new Error(`Ordnerliste: ${e instanceof Error ? e.message : String(e)}`);
  });
  return new Set(aktiveOrdnerAus(alle));
}

/** Supabase liefert hoechstens 1000 Zeilen je Abfrage — seitenweise bis
 *  `max` lesen. `seite(von, bis)` muss stabil sortiert sein. */
async function seitenweise<T>(
  seite: (von: number, bis: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  max: number,
): Promise<T[]> {
  const GROESSE = 1000;
  const alle: T[] = [];
  while (alle.length < max) {
    const von = alle.length;
    const bis = Math.min(max, von + GROESSE) - 1;
    const { data, error } = await seite(von, bis);
    if (error) throw new Error(error.message);
    const zeilen = data ?? [];
    alle.push(...zeilen);
    if (zeilen.length < bis - von + 1) break;
  }
  return alle;
}

/** Kontext der Nachtarbeit (MASTERPLAN §3.5): dieselben Listen wie bei
 *  ablage_analyse (streng geladen) plus die bekannten Vorschlaege (offen,
 *  angenommen/korrigiert — Verschiebung steht noch aus —, dazu abgelehnt
 *  der letzten 180 Tage) und alle KI-Fristen —
 *  damit das Rig nichts erneut meldet. Ohne Nebenwirkung. */
export async function ladeNachtKontext(admin: Admin, jetzt = new Date()): Promise<NachtKontext> {
  const basis = await ladeAblageKontext(admin, { streng: true });
  const sperreSeit = new Date(jetzt.getTime() - KI_VORSCHLAG_SPERRE_TAGE * 86_400_000).toISOString();

  const vorschlaege = await seitenweise<{ art: NasVorschlagArt; pfad: string; status: NasVorschlagStatus; rezept: string | null }>(
    (von, bis) =>
      admin
        .from("nas_vorschlaege")
        .select("art, pfad, status, rezept")
        .or(`status.in.(offen,angenommen,korrigiert),and(status.eq.abgelehnt,entschieden_am.gte.${sperreSeit})`)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(von, bis),
    KI_KONTEXT_MAX_BEKANNT,
  );

  // ZZ-Beschriebe (Migration 329), die auf Claude warten oder schon
  // verarbeitet sind — das Rig ueberspringt Pfade, fuer die es mit seinem
  // Rezept schon etwas gibt. Verworfene darf es neu liefern.
  const beschriebe = await seitenweise<{ pfad: string; status: Exclude<ZzBeschriebStatus, "verworfen">; rezept: string }>(
    (von, bis) =>
      admin
        .from("nas_zz_beschriebe")
        .select("pfad, status, rezept")
        .neq("status", "verworfen")
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(von, bis),
    KI_KONTEXT_MAX_BEKANNT,
  );

  // Firmenwissen (Migration 344): fehlt die Tabelle noch oder scheitert die Abfrage, laeuft die Nacht ohne —
  // das Wissen ist eine Hilfe, kein Pflichtteil des Kontexts.
  let wissen: NachtKontext["wissen"] = [];
  try {
    wissen = wissenFuerRig(await ladeWissenAktiv(admin));
  } catch (e) {
    logError("ki.kontext.wissen", e instanceof Error ? e.message.slice(0, 120) : "fehler");
  }

  const fristen = await seitenweise<{ pfad: string | null; weitere_pfade: string[] | null; art: FristArt; datum: string; status: FristStatus }>(
    (von, bis) =>
      admin
        .from("ablage_fristen")
        .select("pfad, weitere_pfade, art, datum, status")
        .eq("quelle", "ki")
        .order("created_at", { ascending: false })
        .order("id", { ascending: true })
        .range(von, bis),
    KI_KONTEXT_MAX_BEKANNT,
  );

  return {
    erzeugt_am: jetzt.toISOString(),
    heute: basis.heute,
    ordner: basis.ordner,
    dok_typen: basis.dok_typen,
    mitarbeiter: basis.mitarbeiter,
    namen_alle: basis.namen_alle,
    // Gespeichert ist die Schreibweise der Platte, ans Rig gehen Pfade in
    // NFC (MASTERPLAN §3.0).
    // rezept (Migration 329): offene Vorschlaege mit aelterem Rezept rechnet
    // das Rig neu und ersetzt sie (POST /api/ki/nachtarbeit).
    vorschlaege_bekannt: [
      ...vorschlaege.map((v) => ({ art: v.art, pfad: v.pfad.normalize("NFC"), status: v.status, rezept: v.rezept ?? null })),
      ...beschriebe.map((b) => ({ art: "zz" as const, pfad: b.pfad.normalize("NFC"), status: `beschrieb_${b.status}` as const, rezept: b.rezept })),
    ],
    // Weitere Quell-Dokumente einer Frist (Migration 321) zaehlen genauso —
    // sonst meldete das Rig dieselbe Frist aus der .pdf-Kopie jede Nacht neu.
    fristen_bekannt: fristen.flatMap((f) =>
      [f.pfad, ...(f.weitere_pfade ?? [])]
        .filter((p): p is string => typeof p === "string")
        .map((p) => ({ pfad: p.normalize("NFC"), art: f.art, datum: f.datum, status: f.status })),
    ),
    wissen,
  };
}

/** In-Abfragen stueckeln: lange Pfade sprengen sonst die URL-Laenge der
 *  REST-Abfrage. */
export function stuecke<T>(liste: readonly T[], groesse: number): T[][] {
  const aus: T[][] = [];
  for (let i = 0; i < liste.length; i += groesse) aus.push(liste.slice(i, i + groesse));
  return aus;
}

/** Zeilen des NAS-Datei-Index fuer die gegebenen Pfade (Map pfad -> Zeile).
 *  Wirft bei Lesefehlern. */
export async function ladeIndexZeilen(admin: Admin, pfade: readonly string[]): Promise<Map<string, IndexZeile>> {
  const index = new Map<string, IndexZeile>();
  const eindeutig = [...new Set(pfade)];
  for (const teil of stuecke(eindeutig, 20)) {
    const { data, error } = await admin.from("ablage_datei_index").select("pfad, name, ordner_pfad, geaendert").in("pfad", teil);
    if (error) throw new Error(`Datei-Index: ${error.message}`);
    for (const z of data ?? []) {
      index.set(z.pfad as string, {
        pfad: z.pfad as string,
        name: z.name as string,
        ordner_pfad: (z.ordner_pfad as string | null) ?? "",
        geaendert: (z.geaendert as string | null) ?? null,
      });
    }
  }
  return index;
}

/** Wie ladeIndexZeilen, aber fuer NFC-Pfade vom Rig (MASTERPLAN §3.0):
 *  fragt alle moeglichen Schreibweisen ab (lib/ki/pfade) und liefert
 *  NFC-Pfad -> Zeile mit der GESPEICHERTEN Schreibweise (`pfad`,
 *  `ordner_pfad` byte-genau wie auf dem NAS). Zwillinge (gleicher Name in
 *  NFC und NFD) wie nfcZuRoh: die NFC-Form gewinnt, sonst mehrdeutig = fehlt.
 *  Die Eingabe wird selbst noch einmal nach NFC gebracht (beide Seiten
 *  normalisiert) — ein NFD-Pfad findet seine Zeile also auch. */
export async function ladeIndexZeilenNfc(admin: Admin, nfcPfade: readonly string[]): Promise<Map<string, IndexZeile>> {
  const gesucht = new Set(nfcPfade.map((p) => p.normalize("NFC")));
  const roh = await ladeIndexZeilen(admin, [...gesucht].flatMap(pfadSchreibweisen));
  const zuRoh = nfcZuRoh([...roh.keys()].filter((p) => gesucht.has(p.normalize("NFC"))));
  const aus = new Map<string, IndexZeile>();
  for (const [nfc, pfad] of zuRoh) aus.set(nfc, roh.get(pfad)!);
  return aus;
}
