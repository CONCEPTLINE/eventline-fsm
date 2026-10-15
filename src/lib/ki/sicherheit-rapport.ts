// Klartext-Rapport zum taeglichen Sicherheits-Check (security_runs.narrative,
// docs/lokale-ki/SPEC.md §2.3 «Sicherheits-Rapport»). Rein (kein I/O) — die
// Route /api/ki/sicherheit laedt den Lauf und reicht ihn hier hinein.
//
// Weg: Das Rig holt den neuesten fertigen Lauf ohne narrative (nur
// Metadaten: Zaehler, Schwere/Kategorie/Titel der Befunde, aus detail nur
// name/kind/missing), formuliert 1–3 Saetze und meldet sie zurueck. Die
// Zahlen schreibt das Rig deterministisch; das Modell erklaert nur die Titel.
// Diese Pruefung hier ist die zweite Verteidigungslinie: jede Zahl im Text
// muss zum Lauf passen, ein Lauf mit kritischen Befunden darf nie ohne
// «kritisch» und die Anzahl beschrieben werden.

/** Laenge des fertigen Rapports (Zeichen, nach dem Saeubern). */
export const RAPPORT_MAX = 600;
export const RAPPORT_MIN = 10;
/** Hoechstens so viele kritische/Warn-Befunde gehen ans Rig (Rest nur gezaehlt). */
export const RAPPORT_MAX_BEFUNDE = 20;
/** Titel ans Rig gekappt (Zeichen). */
export const RAPPORT_TITEL_MAX = 200;
/** Nur Laeufe dieses Alters bekommen noch einen Rapport (kein endloser Rueckstau). */
export const RAPPORT_MAX_ALTER_MS = 7 * 86_400_000;
/** Hoechstens so viele fehlende Rechte je Befund gehen ans Rig. */
const RAPPORT_MAX_FEHLEND = 10;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BefundRoh = { severity: string; category: string; title: string; detail: unknown };
export type LaufRoh = {
  id: string;
  started_at: string;
  finished_at: string | null;
  source: string;
  critical: number;
  warnings: number;
  checks: number;
};

/** Was das Rig sieht — Metadaten, keine Inhalte. */
export type RapportBefund = {
  severity: "critical" | "warn";
  category: string;
  title: string;
  detail: { name?: string; kind?: string; missing?: string[] };
};
export type RapportLauf = {
  id: string;
  started_at: string;
  finished_at: string;
  source: string;
  critical: number;
  warnings: number;
  checks: number;
  /** Info-Befunde (z. B. Rollen-Aenderungen) nur als Anzahl je Kategorie. */
  hinweise: Record<string, number>;
  befunde: RapportBefund[];
  /** Kritische/Warn-Befunde, die wegen RAPPORT_MAX_BEFUNDE nicht mitkamen. */
  weitere: number;
};

/** Steuerzeichen und unsichtbare Richtungs-/Breitenzeichen → Leerzeichen. */
function ohneSteuerzeichen(s: string): string {
  let aus = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const unsichtbar =
      c < 0x20 || c === 0x7f || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069);
    aus += unsichtbar ? " " : ch;
  }
  return aus;
}

function kurz(s: unknown, max: number): string {
  return typeof s === "string" ? ohneSteuerzeichen(s).trim().slice(0, max) : "";
}

function detailFuersRig(roh: unknown): RapportBefund["detail"] {
  if (!roh || typeof roh !== "object" || Array.isArray(roh)) return {};
  const d = roh as Record<string, unknown>;
  const aus: RapportBefund["detail"] = {};
  const name = kurz(d.name, 120);
  if (name) aus.name = name;
  const kind = kurz(d.kind, 40);
  if (kind) aus.kind = kind;
  if (Array.isArray(d.missing)) {
    const missing = d.missing.map((m) => kurz(m, 60)).filter(Boolean).slice(0, RAPPORT_MAX_FEHLEND);
    if (missing.length) aus.missing = missing;
  }
  return aus;
}

/** Lauf + Befunde → minimierte Sicht fuers Rig. Kritisch zuerst, dann Warnungen. */
export function laufFuersRig(lauf: LaufRoh, befunde: readonly BefundRoh[]): RapportLauf {
  const hinweise: Record<string, number> = {};
  const wichtig: RapportBefund[] = [];
  for (const b of befunde) {
    if (b.severity === "critical" || b.severity === "warn") {
      wichtig.push({
        severity: b.severity,
        category: kurz(b.category, 40),
        title: kurz(b.title, RAPPORT_TITEL_MAX),
        detail: detailFuersRig(b.detail),
      });
    } else {
      const k = kurz(b.category, 40) || "sonstiges";
      hinweise[k] = (hinweise[k] ?? 0) + 1;
    }
  }
  wichtig.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "critical" ? -1 : 1));
  return {
    id: lauf.id,
    started_at: lauf.started_at,
    finished_at: lauf.finished_at ?? lauf.started_at,
    source: lauf.source,
    critical: lauf.critical,
    warnings: lauf.warnings,
    checks: lauf.checks,
    hinweise,
    befunde: wichtig.slice(0, RAPPORT_MAX_BEFUNDE),
    weitere: Math.max(0, wichtig.length - RAPPORT_MAX_BEFUNDE),
  };
}

/** Text saeubern: Steuerzeichen/Markdown weg, Leerraum zusammen, ß → ss
 *  (Schweizer Schreibung), auf RAPPORT_MAX gekappt (an einer Satzgrenze). */
export function saeubereRapport(roh: string): string {
  let t = ohneSteuerzeichen(roh.normalize("NFC"))
    .replace(/[*#`]+/g, "")
    .replace(/ß/g, "ss")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > RAPPORT_MAX) {
    const schnitt = t.slice(0, RAPPORT_MAX);
    const ende = Math.max(schnitt.lastIndexOf(". "), schnitt.lastIndexOf("! "), schnitt.lastIndexOf("? "));
    t = ende >= RAPPORT_MIN ? schnitt.slice(0, ende + 1) : schnitt.trimEnd();
  }
  return t;
}

/** Alle Zahlen, die im Rapport vorkommen duerfen: die Zaehler des Laufs und
 *  Ziffernfolgen aus den Titeln (Namen wie «v2_xyz»). */
export function erlaubteZahlen(lauf: Pick<LaufRoh, "critical" | "warnings" | "checks">, befunde: readonly BefundRoh[]): Set<string> {
  const erlaubt = new Set<string>([lauf.critical, lauf.warnings, lauf.checks].map((n) => String(n)));
  let info = 0;
  for (const b of befunde) {
    if (b.severity !== "critical" && b.severity !== "warn") info += 1;
    for (const z of String(b.title ?? "").match(/\d+/g) ?? []) erlaubt.add(z);
  }
  erlaubt.add(String(info));
  return erlaubt;
}

/** Prueft den Rapport gegen den Lauf. null = in Ordnung, sonst Klartext-Grund. */
export function pruefeRapport(
  text: string,
  lauf: Pick<LaufRoh, "critical" | "warnings" | "checks">,
  befunde: readonly BefundRoh[],
): string | null {
  if (text.length < RAPPORT_MIN) return "zu kurz";
  if (text.length > RAPPORT_MAX) return "zu lang";
  const erlaubt = erlaubteZahlen(lauf, befunde);
  const zahlen: string[] = text.match(/\d+/g) ?? [];
  if (zahlen.some((z) => !erlaubt.has(z))) return "Zahl passt nicht zum Lauf";
  if (!zahlen.includes(String(lauf.checks))) return "Anzahl Prüfungen fehlt";
  if (lauf.critical > 0 && (!/kritisch/i.test(text) || !zahlen.includes(String(lauf.critical)))) {
    return "kritische Befunde nicht genannt";
  }
  return null;
}

export type RapportEingabe = { run_id: string; text: string };

/** Body von POST /api/ki/sicherheit lesen. */
export function leseRapportBody(roh: unknown): { ok: true; wert: RapportEingabe } | { ok: false; fehler: string } {
  if (!roh || typeof roh !== "object" || Array.isArray(roh)) return { ok: false, fehler: "Ungültiger Body" };
  const b = roh as Record<string, unknown>;
  if (typeof b.run_id !== "string" || !UUID_RE.test(b.run_id)) return { ok: false, fehler: "Ungültige run_id" };
  if (typeof b.text !== "string" || b.text.length > RAPPORT_MAX * 2) return { ok: false, fehler: "Ungültiger Text" };
  return { ok: true, wert: { run_id: b.run_id.toLowerCase(), text: saeubereRapport(b.text) } };
}
