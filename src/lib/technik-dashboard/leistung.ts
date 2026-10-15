// Leistung der lokalen KI (docs/technik-dashboard/VERTRAG.md §2.6, §6.5) fuer GET /api/technik/leistung.
// Zwei Quellen, beide nur Zahlen und Zeitpunkte:
// - Rig: der Sammler rechnet alle 10 min aus der Rig-DB (Protokoll, Tiefen-Index, Selbsttest, Fristen-Pruefung)
//   je Zeitraum und schickt das Ergebnis im Messpaket (rig.leistung, geprueft in paket.ts). Hier wird nur der
//   gespeicherte Stand gelesen (technik_stand) — keine Rohdaten, nichts wird im FSM nachgerechnet.
// - FSM: was Menschen mit den Ergebnissen gemacht haben (Ablage-Entscheide, Fristen, Sicherheits-Rapporte),
//   gezaehlt in der DB-Funktion technik_leistung() (Migration 335).
// Nur serverseitig mit dem Admin-Client; die Route prueft vorher Admin.

import type { SupabaseClient } from "@supabase/supabase-js";
import { LEISTUNG_ZEITRAEUME, LEISTUNG_ZEITRAUM_MS } from "./konstanten";
import type { LeistungAblage, LeistungRig, LeistungZeitraum, TechnikLeistung } from "./typen";

export const istLeistungZeitraum = (x: unknown): x is LeistungZeitraum =>
  typeof x === "string" && (LEISTUNG_ZEITRAEUME as readonly string[]).includes(x);

export type FsmLeistung = Pick<TechnikLeistung, "ablage" | "fristen" | "sicherheit">;

type Roh = Record<string, unknown>;
const istObjekt = (x: unknown): x is Roh => !!x && typeof x === "object" && !Array.isArray(x);

/** Ganze Zahl ≥ 0 (Postgres liefert count als Zahl, bigint u. U. als Text). */
function anzahl(x: unknown): number {
  const n = typeof x === "string" ? Number(x) : x;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

function zeit(x: unknown): string | null {
  if (typeof x !== "string") return null;
  const t = Date.parse(x);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Antwort von technik_leistung() lesen — eigene DB, trotzdem nur bekannte Felder und Zahlen. */
export function leseFsmLeistung(roh: unknown): FsmLeistung {
  const r = istObjekt(roh) ? roh : {};
  const ablage: LeistungAblage[] = [];
  for (const a of Array.isArray(r.ablage) ? r.ablage : []) {
    if (!istObjekt(a) || (a.logik !== "lokal" && a.logik !== "claude")) continue;
    ablage.push({
      logik: a.logik,
      seit: zeit(a.seit),
      vorschlaege: anzahl(a.vorschlaege),
      offen: anzahl(a.offen),
      unveraendert: anzahl(a.unveraendert),
      geaendert: anzahl(a.geaendert),
      ordner_geaendert: anzahl(a.ordner_geaendert),
      name_geaendert: anzahl(a.name_geaendert),
      abgelehnt: anzahl(a.abgelehnt),
      entscheid_von: zeit(a.entscheid_von),
      entscheid_bis: zeit(a.entscheid_bis),
    });
  }
  // Neueste Logik zuerst (Claude vor lokal)
  ablage.sort((x, y) => (Date.parse(y.seit ?? "") || 0) - (Date.parse(x.seit ?? "") || 0));
  const f = istObjekt(r.fristen) ? r.fristen : {};
  const s = istObjekt(r.sicherheit) ? r.sicherheit : {};
  return {
    ablage,
    fristen: { seit: zeit(f.seit), gefunden: anzahl(f.gefunden), bestaetigt: anzahl(f.bestaetigt), verworfen: anzahl(f.verworfen), offen: anzahl(f.offen) },
    sicherheit: { seit: zeit(s.seit), rapporte: anzahl(s.rapporte) },
  };
}

/** Beginn eines Zeitraums (null = gesamt). */
export function zeitraumVon(zeitraum: LeistungZeitraum, jetzt: Date): string | null {
  const ms = LEISTUNG_ZEITRAUM_MS[zeitraum];
  return ms === null ? null : new Date(jetzt.getTime() - ms).toISOString();
}

/** Antwort zusammensetzen (rein, getestet): Block des gewaehlten Zeitraums, Selbsttest-Laeufe im Zeitraum. */
export function baueLeistung(a: { rig: LeistungRig | null; fsm: FsmLeistung; zeitraum: LeistungZeitraum; jetzt: Date }): TechnikLeistung {
  const von = zeitraumVon(a.zeitraum, a.jetzt);
  const vonMs = von ? Date.parse(von) : Number.NEGATIVE_INFINITY;
  return {
    success: true,
    jetzt: a.jetzt.toISOString(),
    zeitraum: a.zeitraum,
    von,
    rig: a.rig
      ? {
          stand: a.rig.stand,
          seit: a.rig.seit ?? null,
          block: a.rig.zeitraeume[a.zeitraum] ?? null,
          selbsttest: (a.rig.selbsttest ?? []).filter((l) => Date.parse(l.am) >= vonMs),
        }
      : null,
    ...a.fsm,
  };
}

/** Rig-Teil aus dem gespeicherten Stand (technik_stand, Zeile «rig»); fehlt er, null. */
export async function ladeRigLeistung(admin: SupabaseClient): Promise<LeistungRig | null> {
  const { data, error } = await admin.from("technik_stand").select("leistung:werte->leistung").eq("quelle", "rig").maybeSingle();
  if (error) throw new Error(`technik_stand: ${error.message}`);
  const l = (data as { leistung?: unknown } | null)?.leistung;
  return istObjekt(l) && typeof l.stand === "string" && istObjekt(l.zeitraeume) ? (l as unknown as LeistungRig) : null;
}

/** FSM-Teil ueber technik_leistung() (Migration 335). */
export async function ladeFsmLeistung(admin: SupabaseClient, von: string | null): Promise<FsmLeistung> {
  const { data, error } = await admin.rpc("technik_leistung", { p_von: von });
  if (error) throw new Error(`technik_leistung: ${error.message}`);
  return leseFsmLeistung(data);
}
