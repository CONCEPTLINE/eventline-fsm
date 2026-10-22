// Vorschlaege «wahrscheinlich Auftrag X» fuer Mails, die nicht sicher
// zugeordnet werden konnten — reine Funktionen (getestet).
//
// Laeuft OHNE KI (deterministisch), damit es auch Vorschlaege gibt, wenn
// Claude nicht verfuegbar ist (Vorfall 18.–20.10.2026: Nutzungslimit, die
// KI-Zuordnung fiel still aus). Ein Vorschlag ordnet NIE automatisch zu —
// er ist nur ein Ein-Klick-Knopf in /auftraege/mails.

export type VorschlagKandidat = {
  id: string;
  job_number: number;
  title: string | null;
  start_date: string | null;
  end_date: string | null;
  kunde: string | null;
  kunde_email: string | null;
  location: string | null;
  raum: string | null;
};

export type Vorschlag = { job_id: string; grund: string; quelle: "verlauf" | "ki" | "abgleich" };

const MONATE: Record<string, number> = {
  januar: 1, jan: 1, februar: 2, feb: 2, märz: 3, maerz: 3, mär: 3, mrz: 3, april: 4, apr: 4, mai: 5,
  juni: 6, jun: 6, juli: 7, jul: 7, august: 8, aug: 8, september: 9, sept: 9, sep: 9,
  oktober: 10, okt: 10, november: 11, nov: 11, dezember: 12, dez: 12,
};

function iso(j: number, m: number, t: number): string | null {
  if (m < 1 || m > 12 || t < 1 || t > 31) return null;
  return `${j}-${String(m).padStart(2, "0")}-${String(t).padStart(2, "0")}`;
}

/** Kalenderdaten aus Freitext: «18.12.2026», «18.12.26», «18. Dezember 2026»,
 *  «Samstag 31. Oktober» (ohne Jahr → naechstes Vorkommen ab `heute`). */
export function datenAusText(text: string, heute: string): string[] {
  const out = new Set<string>();
  const [hj, hm, ht] = heute.split("-").map(Number);
  const jahrOhne = (m: number, t: number) => (m < hm || (m === hm && t < ht) ? hj + 1 : hj);
  for (const m of text.matchAll(/\b(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})?(?!\d)/g)) {
    const t = Number(m[1]), mo = Number(m[2]);
    const j = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : jahrOhne(mo, t);
    const d = iso(j, mo, t);
    if (d) out.add(d);
  }
  for (const m of text.matchAll(/\b(\d{1,2})\.?\s*([a-zäöü]{3,9})\.?(?:\s+(\d{4}))?/gi)) {
    const mo = MONATE[m[2].toLowerCase()];
    if (!mo) continue;
    const t = Number(m[1]);
    const j = m[3] ? Number(m[3]) : jahrOhne(mo, t);
    const d = iso(j, mo, t);
    if (d) out.add(d);
  }
  return [...out];
}

function enthaelt(hay: string, nadel: string | null | undefined, min = 4): boolean {
  const n = (nadel ?? "").toLowerCase().trim();
  return n.length >= min && hay.includes(n);
}

const TITEL_STOP = new Set(["event", "anlass", "abend", "party", "fest", "basel", "zürich", "zuerich", "technik", "miete", "vermietung", "jahr", "2026", "2027"]);

/** Bewertet offene Auftraege gegen Betreff + Text. Datum im Zeitraum des
 *  Auftrags, Location/Raum, Kunde (Name oder Mail-Domain) und Titelwoerter
 *  geben Punkte; zurueck kommen hoechstens `max` Vorschlaege mit klarer
 *  Begruendung, nur ab 3 Punkten und nur wenn mindestens zwei Merkmale
 *  passen ODER das Datum passt. */
export function abgleichVorschlaege(
  mail: { betreff: string; text: string },
  kandidaten: VorschlagKandidat[],
  heute: string,
  max = 3,
): Vorschlag[] {
  const hay = `${mail.betreff}\n${mail.text}`.toLowerCase();
  const daten = datenAusText(`${mail.betreff}\n${mail.text.slice(0, 20000)}`, heute);
  const bewertet: { k: VorschlagKandidat; punkte: number; gruende: string[] }[] = [];
  for (const k of kandidaten) {
    let punkte = 0;
    const gruende: string[] = [];
    let datumOk = false;
    if (k.start_date) {
      const von = k.start_date.slice(0, 10); // tz-ok: date-Spalte YYYY-MM-DD
      const bis = (k.end_date ?? k.start_date).slice(0, 10); // tz-ok: date-Spalte YYYY-MM-DD
      const d = daten.find((x) => x >= von && x <= bis);
      if (d) {
        punkte += 3;
        datumOk = true;
        const [j, m, t] = d.split("-");
        gruende.push(`Datum ${t}.${m}.${j}`);
      }
    }
    if (enthaelt(hay, k.location)) { punkte += 2; gruende.push(`Location ${k.location}`); }
    else if (enthaelt(hay, k.raum, 5)) { punkte += 1; gruende.push(`Raum ${k.raum}`); }
    if (enthaelt(hay, k.kunde)) { punkte += 2; gruende.push(`Kunde ${k.kunde}`); }
    else {
      const domain = (k.kunde_email ?? "").toLowerCase().split("@")[1];
      if (domain && !/eventline|gmail|gmx|bluewin|hotmail|outlook|icloud|yahoo/.test(domain) && hay.includes(`@${domain}`)) {
        punkte += 2;
        gruende.push("Absender-Domain des Kunden");
      }
    }
    const titelWoerter = (k.title ?? "")
      .toLowerCase()
      .split(/[^a-z0-9äöüéèà]+/)
      .filter((w) => w.length >= 5 && !TITEL_STOP.has(w));
    const titelTreffer = [...new Set(titelWoerter)].filter((w) => hay.includes(w)).length;
    if (titelTreffer > 0) { punkte += Math.min(titelTreffer, 2); gruende.push("Titel"); }
    if (punkte >= 3 && (datumOk || gruende.length >= 2)) bewertet.push({ k, punkte, gruende });
  }
  bewertet.sort((a, b) => b.punkte - a.punkte);
  return bewertet.slice(0, max).map((b) => ({ job_id: b.k.id, grund: b.gruende.join(" · "), quelle: "abgleich" as const }));
}

/** Vorschlaege zusammenfuehren: Reihenfolge der Listen = Prioritaet,
 *  pro Auftrag nur der erste Eintrag, hoechstens `max`. */
export function vorschlaegeZusammen(listen: Vorschlag[][], max = 3): Vorschlag[] {
  const gesehen = new Set<string>();
  const out: Vorschlag[] = [];
  for (const liste of listen) {
    for (const v of liste) {
      if (gesehen.has(v.job_id)) continue;
      gesehen.add(v.job_id);
      out.push(v);
      if (out.length >= max) return out;
    }
  }
  return out;
}
