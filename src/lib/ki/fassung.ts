// «Als neue Fassung ablegen» — gemeinsamer Teil von «Einsortieren» (POST /api/ablage/doppel, aktion «fassung»: die neue
// Fassung liegt schon im Rueckstau ZZ) und der Ablage-Karte (POST /api/ablage/upload mit `fassung_alt`: die neue kommt
// gerade aus Upload oder Mail-Eingang). Immer gleich: die ALTE Fassung wandert in den Historie-Ordner ihres Ordners
// (vorhandener «…Historie…» oder neu, Benennung wie im Haus — lib/ki/doppel historieFuer), die NEUE kommt an ihren
// Platz. Liegt die alte schon in einer Historie, bleibt sie dort und die neue kommt in den Ordner darueber. Nichts wird
// geloescht; verschoben wird nur auf Klick, beim naechsten NAS-Sync (ablage_moves — der Sync arbeitet neue Ordner,
// dann Verschiebungen, dann neue Dateien ab: die neue Fassung kollidiert nie mit dem Namen der alten).

import type { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { istSystemPfad, type IndexZeile } from "./bereinigen";
import { historieFuer, liegtInHistorie } from "./doppel";
import { ladeAktiveOrdner } from "./kontext";
import { hatZzSegment, nfcZuRoh } from "./pfade";
import { legeNeuenOrdnerAn } from "./vorschlaege";

type Admin = ReturnType<typeof createAdminClient>;

export interface FassungPlan {
  /** Ordner, in den die neue Fassung kommt (Schreibweise aus ablage_ordner). */
  zielRoh: string;
  /** Historie-Ordner fuer die alte Fassung; null = sie liegt schon in einer Historie und bleibt. */
  historie: { pfad: string; neu: boolean } | null;
}

export type FassungFehler = { ok: false; status: 409 | 500; fehler: string };

/** Wohin die neue Fassung kommt und wohin die alte (`alt` = Zeile des Datei-Index, gespeicherte Schreibweise). */
export async function planeFassung(admin: Admin, alt: IndexZeile): Promise<({ ok: true } & FassungPlan) | FassungFehler> {
  if (hatZzSegment(alt.ordner_pfad) || istSystemPfad(alt.ordner_pfad)) {
    return { ok: false, status: 409, fehler: "Die ältere Fassung liegt selbst im Rückstau" };
  }
  let ziel = alt.ordner_pfad;
  let historie: FassungPlan["historie"] = null;
  if (liegtInHistorie(alt.pfad)) {
    const teile = alt.ordner_pfad.split("/");
    ziel = teile.slice(0, teile.findIndex((s) => /histor/i.test(s))).join("/");
  } else {
    // «_» ist in LIKE ein Platzhalter — mehr Treffer schaden nicht, historieFuer nimmt nur direkte Unterordner.
    const { data: unter, error } = await admin.from("ablage_ordner").select("pfad").like("pfad", `${alt.ordner_pfad}/%`).limit(1000);
    if (error) throw new Error(`ablage_ordner: ${error.message}`);
    historie = historieFuer(alt.ordner_pfad, (unter ?? []).map((u) => u.pfad as string));
  }
  const zielRoh = nfcZuRoh(await ladeAktiveOrdner(admin)).get(ziel.normalize("NFC"));
  if (!zielRoh || hatZzSegment(zielRoh) || istSystemPfad(zielRoh)) {
    return { ok: false, status: 409, fehler: "Der Ordner der älteren Fassung ist gesperrt" };
  }
  return { ok: true, zielRoh, historie };
}

/** Historie-Ordner anlegen (falls neu) und die alte Fassung dorthin eintragen — VOR der neuen Fassung (siehe oben). */
export async function legeAlteFassungAb(
  admin: Admin,
  altPfad: string,
  historie: FassungPlan["historie"],
): Promise<{ ok: true; eingetragen: boolean } | FassungFehler> {
  if (!historie) return { ok: true, eingetragen: false };
  if (historie.neu) {
    const oErr = await legeNeuenOrdnerAn(admin, historie.pfad);
    if (oErr) {
      logError("ablage.fassung.historie", oErr.message);
      return { ok: false, status: 500, fehler: "Historie-Ordner konnte nicht angelegt werden" };
    }
  }
  const { error } = await admin.from("ablage_moves").insert({ pfad: altPfad, ziel_ordner: historie.pfad });
  if (error) {
    if (error.code === "23505") return { ok: false, status: 409, fehler: "Für die ältere Fassung steht schon eine Verschiebung aus" };
    throw new Error(`ablage_moves: ${error.message}`);
  }
  return { ok: true, eingetragen: true };
}

/** Eintrag der alten Fassung zuruecknehmen, wenn die neue nicht abgelegt werden konnte (Fehler nur protokolliert). */
export async function nimmAlteFassungZurueck(admin: Admin, altPfad: string, historie: FassungPlan["historie"]): Promise<void> {
  if (!historie) return;
  const { error } = await admin.from("ablage_moves").delete().eq("pfad", altPfad).eq("ziel_ordner", historie.pfad);
  if (error) logError("ablage.fassung.zurueck", error.message);
}
