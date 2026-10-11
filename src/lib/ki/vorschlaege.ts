// Entscheide und Rueckmeldung zu den Vorschlaegen der Nachtarbeit
// (docs/lokale-ki/MASTERPLAN.md §3.8 MP-7, Tabelle nas_vorschlaege,
// Migration 303):
//   - leseEntscheideBody(): Body von POST /api/ablage/nas-vorschlaege
//     pruefen (rein).
//   - pruefeZiel(): Zielordner eines Entscheids — gleiche Regeln wie die
//     Nachtarbeit (lib/ki/nachtarbeit): normalisierter Pfad (kein «..»,
//     nicht absolut), nie ZZ_*/99_System, nur aus der AKTIVEN Liste,
//     nicht der Ordner, in dem die Datei schon liegt; Vergleich in NFC,
//     Ergebnis in der Schreibweise von ablage_ordner (lib/ki/pfade) (rein).
//   - markiereVeralteteVorschlaege(): am Scan-Ende des Datei-Index
//     Vorschlaege, deren Datei nicht mehr im Index steht, auf «veraltet»
//     (offene; bestaetigte ohne offenen Verschiebe-Auftrag).
//   - meldeVerschobenErledigt(): der NAS-Sync hat eine Verschiebung
//     ausgefuehrt -> angenommener/korrigierter Vorschlag auf «erledigt».
// Logs nur mit Anzahlen — nie Pfade oder Ordner.

import type { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { leseNasPfad } from "./bereinigen";
import { ladeIndexZeilen, stuecke } from "./kontext";
import { KI_ENTSCHEIDE_MAX, KI_KONTEXT_MAX_BEKANNT } from "./konstanten";
import { zielGesperrt } from "./pfade";

type Admin = ReturnType<typeof createAdminClient>;

export type EntscheidAktion = "annehmen" | "korrigieren" | "ablehnen";

export interface Entscheid {
  id: string;
  aktion: EntscheidAktion;
  /** Nur bei «korrigieren»: der vom Admin gewaehlte Ordner (roh). */
  ordner?: string;
}

/** Ergebnis je Eintrag (Antwort der Route, gelesen von
 *  src/components/nas/vorschlaege-gruppe.tsx). */
export interface EntscheidErgebnis {
  id: string;
  ok: boolean;
  /** Status des Vorschlags nach dem Aufruf (falls bekannt). */
  status?: string;
  fehler?: string;
  /** HTTP-Code dieses Eintrags (200, 400, 404, 409, 500). */
  code: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AKTIONEN: readonly EntscheidAktion[] = ["annehmen", "korrigieren", "ablehnen"];

function istObjekt(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

/** Body `{ entscheide: [{ id, aktion, ordner? }] }`: 1–50 Eintraege, jede
 *  ID hoechstens einmal, «korrigieren» nur mit Ordner. Ein formal falscher
 *  Eintrag verwirft den ganzen Aufruf (400) — Pfad-Regeln prueft
 *  pruefeZiel() je Eintrag. */
export function leseEntscheideBody(body: unknown): { ok: true; entscheide: Entscheid[] } | { ok: false; fehler: string } {
  if (!istObjekt(body) || !Array.isArray(body.entscheide)) return { ok: false, fehler: "entscheide fehlt" };
  const roh = body.entscheide as unknown[];
  if (roh.length === 0) return { ok: false, fehler: "entscheide ist leer" };
  if (roh.length > KI_ENTSCHEIDE_MAX) return { ok: false, fehler: `Höchstens ${KI_ENTSCHEIDE_MAX} Entscheide pro Aufruf` };
  const entscheide: Entscheid[] = [];
  const ids = new Set<string>();
  for (const e of roh) {
    if (!istObjekt(e) || typeof e.id !== "string" || !UUID_RE.test(e.id)) return { ok: false, fehler: "Ungültige ID" };
    const id = e.id.toLowerCase();
    if (ids.has(id)) return { ok: false, fehler: "Doppelte ID" };
    ids.add(id);
    if (!AKTIONEN.includes(e.aktion as EntscheidAktion)) return { ok: false, fehler: "Ungültige Aktion" };
    const aktion = e.aktion as EntscheidAktion;
    if (aktion === "korrigieren") {
      if (typeof e.ordner !== "string" || !e.ordner.trim()) return { ok: false, fehler: "Ordner fehlt" };
      entscheide.push({ id, aktion, ordner: e.ordner });
    } else {
      entscheide.push({ id, aktion });
    }
  }
  return { ok: true, entscheide };
}

/** Prueft das Ziel eines Entscheids. `ziel` ist NFC (leseZiel), `aktiv`
 *  bildet NFC auf die Schreibweise in ablage_ordner ab (nfcZuRoh). Ok ->
 *  `{ ziel }` in DIESER Schreibweise — sie geht in ablage_moves und
 *  gewaehlt_ordner, damit auf dem NAS kein Zwillingsordner entsteht. */
export function pruefeZiel(
  ziel: string | null,
  aktiv: ReadonlyMap<string, string>,
  ordnerIst: string,
): { ziel: string } | { code: 400 | 409; fehler: string } {
  if (!ziel || zielGesperrt(ziel)) return { code: 400, fehler: "Zielordner ungültig" };
  if (ziel === ordnerIst.normalize("NFC")) return { code: 400, fehler: "Datei liegt schon in diesem Ordner" };
  const roh = aktiv.get(ziel);
  if (!roh) return { code: 409, fehler: "Zielordner ist nicht (mehr) aktiv — anderen wählen" };
  return { ziel: roh };
}

/** Zielordner aus der Eingabe normalisieren (NFC, kein «..», nicht absolut). */
export function leseZiel(roh: string): string | null {
  return leseNasPfad(roh.trim());
}

interface OffenerVorschlag {
  id: string;
  pfad: string;
  status: string;
  gewaehlt_ordner: string | null;
}

/** Am Scan-Ende des Datei-Index (MP-7, MASTERPLAN §3.8). Gibt die Anzahl
 *  der auf «veraltet» gesetzten Vorschlaege zurueck; wirft bei Lesefehlern.
 *   - offen, Datei nicht mehr im Index -> «veraltet».
 *   - angenommen/korrigiert, Datei nicht mehr im Index UND kein
 *     Verschiebe-Auftrag mehr offen (abgebrochen, oder die Datei wurde vor
 *     dem Sync von Hand bewegt und der Auftrag entfernt): liegt sie am
 *     gewaehlten Ziel -> «erledigt» (Rueckmeldung ging verloren), sonst
 *     «veraltet». Steht die Datei noch im Index, bleibt der Vorschlag
 *     unberuehrt (zwischen Status-Wechsel und Auftrag laeuft ggf. gerade
 *     ein Entscheid).
 *  Jeder Wechsel bedingt auf den gelesenen Status (ein gleichzeitiger
 *  Entscheid oder die Sync-Rueckmeldung gewinnt). */
export async function markiereVeralteteVorschlaege(admin: Admin): Promise<number> {
  const zeilen: OffenerVorschlag[] = [];
  const SEITE = 1000;
  while (zeilen.length < KI_KONTEXT_MAX_BEKANNT) {
    const von = zeilen.length;
    const { data, error } = await admin
      .from("nas_vorschlaege")
      .select("id, pfad, status, gewaehlt_ordner")
      .in("status", ["offen", "angenommen", "korrigiert"])
      .order("id")
      .range(von, von + SEITE - 1);
    if (error) throw new Error(`nas_vorschlaege: ${error.message}`);
    zeilen.push(...((data ?? []) as OffenerVorschlag[]));
    if ((data ?? []).length < SEITE) break;
  }
  if (zeilen.length === 0) return 0;

  const zielPfad = (v: OffenerVorschlag) => (v.gewaehlt_ordner ? `${v.gewaehlt_ordner}/${v.pfad.slice(v.pfad.lastIndexOf("/") + 1)}` : null);
  const index = await ladeIndexZeilen(admin, [
    ...zeilen.map((v) => v.pfad),
    ...zeilen.map(zielPfad).filter((p): p is string => p !== null),
  ]);
  const fehlt = zeilen.filter((v) => !index.has(v.pfad));
  const offenWeg = fehlt.filter((v) => v.status === "offen").map((v) => v.id);

  // Bestaetigte ohne Datei: haengt ihr Verschiebe-Auftrag noch?
  const bestaetigt = fehlt.filter((v) => v.status !== "offen");
  const auftragOffen = new Set<string>();
  for (const teil of stuecke([...new Set(bestaetigt.map((v) => v.pfad))], 20)) {
    const { data, error } = await admin.from("ablage_moves").select("pfad").in("pfad", teil);
    if (error) throw new Error(`ablage_moves: ${error.message}`);
    for (const m of data ?? []) auftragOffen.add(m.pfad as string);
  }
  const ohneAuftrag = bestaetigt.filter((v) => !auftragOffen.has(v.pfad));
  const amZiel = (v: OffenerVorschlag) => {
    const p = zielPfad(v);
    return p !== null && index.has(p);
  };

  const jetzt = new Date().toISOString();
  async function setze(ids: string[], von: string[], status: "veraltet" | "erledigt"): Promise<number> {
    let n = 0;
    for (const teil of stuecke(ids, 100)) {
      const { data, error } = await admin
        .from("nas_vorschlaege")
        .update({ status, updated_at: jetzt })
        .in("id", teil)
        .in("status", von)
        .select("id");
      if (error) throw new Error(`nas_vorschlaege (${status}): ${error.message}`);
      n += (data ?? []).length;
    }
    return n;
  }
  const bestaetigtStatus = ["angenommen", "korrigiert"];
  await setze(ohneAuftrag.filter(amZiel).map((v) => v.id), bestaetigtStatus, "erledigt");
  return (
    (await setze(offenWeg, ["offen"], "veraltet")) +
    (await setze(ohneAuftrag.filter((v) => !amZiel(v)).map((v) => v.id), bestaetigtStatus, "veraltet"))
  );
}

/** NAS-Sync meldet eine ausgefuehrte Verschiebung (POST /api/ablage/sync,
 *  `verschoben`): passender Vorschlag (pfad, Status angenommen/korrigiert)
 *  -> «erledigt». Fehler nur loggen — die Sync-Bestaetigung darf daran
 *  nicht scheitern (der Verschiebe-Auftrag ist schon geschlossen). */
export async function meldeVerschobenErledigt(admin: Admin, pfad: string): Promise<void> {
  const { error } = await admin
    .from("nas_vorschlaege")
    .update({ status: "erledigt", updated_at: new Date().toISOString() })
    .eq("pfad", pfad)
    .in("status", ["angenommen", "korrigiert"]);
  if (error) logError("ablage.sync.vorschlag_erledigt", error.message);
}
