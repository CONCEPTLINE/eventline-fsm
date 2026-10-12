// Welche Fristen der NAS-Ablage heute eine Erinnerungs-Mail ausloesen
// (Cron /api/cron/ablage-fristen, Stufen 30/7/0 Tage vorher). Rein — der
// Cron liest ablage_fristen (Status «aktiv») und schreibt `erinnert` zurueck.
// Alle Daten Kalendertage YYYY-MM-DD (Europe/Zurich), keine Zeitzonen-
// Arithmetik.

export const ERINNERUNG_STUFEN: readonly number[] = [30, 7, 0];

/** Spalten aus ablage_fristen, die der Cron liest. */
export interface FristFuerErinnerung {
  id: string;
  pfad: string | null;
  bezeichnung: string;
  datum: string;
  erinnert: unknown;
}

export interface FaelligeErinnerung {
  id: string;
  /** Anzeige-Name: die Bezeichnung (Dateiname bzw. «<Art> · <Partei>»). */
  name: string;
  /** Ort: Ordner, wenn die Bezeichnung der Dateiname ist, sonst der ganze Pfad. */
  ordner: string;
  datum: string;
  tageBis: number;
  /** Stufe, die diese Mail meldet (die kleinste erreichte). */
  stufe: number;
  /** Neuer Stand fuer `erinnert` (alle erreichten Stufen, sortiert absteigend). */
  erinnert: number[];
}

const DATUM_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function tagNr(iso: string): number | null {
  const m = DATUM_RE.exec(iso);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000 : null;
}

function ortVon(pfad: string | null, bezeichnung: string): string {
  if (!pfad) return "";
  const i = pfad.lastIndexOf("/");
  const name = i >= 0 ? pfad.substring(i + 1) : pfad;
  if (name === bezeichnung) return i > 0 ? pfad.substring(0, i) : "(Hauptebene)";
  return pfad;
}

/** Je Frist hoechstens EINE Mail pro Tag: gemeldet wird die kleinste
 *  erreichte Stufe (5 Tage vorher -> «7», nicht erst «30» und morgen «7»);
 *  danach gelten alle erreichten Stufen als erinnert. Schon erinnerte
 *  Stufen feuern nie doppelt, vergangene Fristen gar nicht. */
export function faelligeErinnerungen(fristen: readonly FristFuerErinnerung[], heute: string): FaelligeErinnerung[] {
  const h = tagNr(heute);
  if (h === null) return [];
  const aus: FaelligeErinnerung[] = [];
  for (const f of fristen) {
    const d = tagNr(f.datum);
    if (d === null) continue;
    const tageBis = Math.round(d - h);
    if (tageBis < 0) continue;
    const schon = Array.isArray(f.erinnert) ? f.erinnert.filter((x): x is number => typeof x === "number") : [];
    const erreicht = ERINNERUNG_STUFEN.filter((s) => tageBis <= s);
    if (erreicht.length === 0) continue;
    const stufe = Math.min(...erreicht);
    if (schon.includes(stufe)) continue;
    aus.push({
      id: f.id,
      name: f.bezeichnung,
      ordner: ortVon(f.pfad, f.bezeichnung),
      datum: f.datum,
      tageBis,
      stufe,
      erinnert: [...new Set([...schon, ...erreicht])].sort((a, b) => b - a),
    });
  }
  return aus;
}
