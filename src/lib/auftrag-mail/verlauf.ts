// Verlauf erkennen fuer Mails an auftrag@in.eventline-basel.com — reine
// Funktionen (getestet in verlauf.test.ts), die DB-Abfragen stehen in
// server.ts.
//
// Warum: Leo leitet einen Mailverlauf oft mehrfach weiter. Nur die Mails
// mit Auftragsnummer im Betreff landeten im Auftrag, die Folgemails
// DESSELBEN Verlaufs (ohne Nummer) blieben haengen (Vorfall 18.–22.10.2026,
// «Semi-Circle in Bau3»). Ein Verlauf wird jetzt an drei Merkmalen erkannt:
//  1. Mail-Header In-Reply-To / References (Message-IDs der Vorgaenger)
//  2. Outlook Thread-Index (die ersten 22 Byte = Konversation)
//  3. normalisierter Betreff (ohne AW:/WG:/RE:/FW:-Ketten) — nur wenn er
//     aussagekraeftig ist («AW: Angebot» allein reicht NICHT) und nur
//     innerhalb eines Zeitfensters.
// Header (1+2) sind sicher und schlagen den Betreff. Zeigen die Treffer auf
// verschiedene Auftraege, wird NICHT geraten.

/** Zeitfenster fuer die Betreff-Erkennung (Header-Treffer gelten immer). */
export const BETREFF_FENSTER_TAGE = 90;

// Antwort-/Weiterleitungs-Praefixe (de/en/fr/it/nl/skandinavisch) und
// Markierungen wie «[EXTERN]», auch mit Zaehler «AW[2]:» oder «RE(3):».
const PRAEFIX_RE =
  /^\s*(?:(?:aw|wg|re|r|fw|fwd|antw|antwort|wtr|tr|réf|ref|rif|enc|sv|vs|vb|odp|res)\s*(?:\[\d+\]|\(\d+\))?\s*[:：]|\[[^\]]{1,30}\]|\*{1,3}\s*(?:extern|external|spam)\s*\*{1,3})\s*/i;

/** Betreff ohne AW:/WG:/RE:/FW:/Fwd:-Ketten und Tags, klein, Leerzeichen
 *  zusammengefasst. Leer bei leerem Betreff. */
export function normalisiereBetreff(betreff: string | null | undefined): string {
  let s = (betreff ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();
  for (let i = 0; i < 30; i++) {
    const neu = s.replace(PRAEFIX_RE, "");
    if (neu === s) break;
    s = neu;
  }
  return s.toLowerCase().replace(/[\s\-–—_.:;,!?]+$/g, "").replace(/\s+/g, " ").trim();
}

// Woerter, die allein keinen Verlauf kennzeichnen (Betreff besteht NUR
// aus solchen → zu generisch fuer eine Zuordnung).
const GENERISCH = new Set([
  "angebot", "angebote", "offerte", "offerten", "anfrage", "anfragen", "rechnung", "rechnungen",
  "info", "infos", "information", "informationen", "frage", "fragen", "termin", "termine",
  "event", "events", "anlass", "anlässe", "veranstaltung", "auftrag", "aufträge", "bestätigung",
  "auftragsbestätigung", "unterlagen", "dokumente", "plan", "pläne", "update", "nachtrag",
  "technik", "material", "bestellung", "kontakt", "vertrag", "budget", "kosten", "preise",
  "rückfrage", "rückmeldung", "feedback", "danke", "hallo", "test", "neu", "ihre", "deine",
  "unsere", "für", "fuer", "und", "der", "die", "das", "an", "zu", "von", "mit", "am", "im",
  "in", "ihr", "dein", "unser", "eine", "ein", "kurze", "kurz", "wichtig", "dringend",
  "offer", "quote", "request", "invoice", "the", "your", "our", "re", "fw",
]);

/** true = Betreff ist spezifisch genug, um allein einen Verlauf zu tragen
 *  (mind. 12 Zeichen, 2 Woerter, davon mindestens eines nicht generisch). */
export function betreffAussagekraeftig(norm: string): boolean {
  if (norm.length < 12) return false;
  const woerter = norm.split(/[\s\-–—/,.:;()]+/).filter((w) => w.length > 0);
  if (woerter.length < 2) return false;
  return woerter.some((w) => !GENERISCH.has(w) && !/^\d+$/.test(w) && w.length >= 3);
}

/** Alle <message-id> aus einem Header-Wert (References / In-Reply-To). */
export function mailIdsAusHeader(wert: unknown): string[] {
  const s = Array.isArray(wert) ? wert.join(" ") : typeof wert === "string" ? wert : "";
  const ids = s.match(/<[^<>\s]+>/g) ?? [];
  return [...new Set(ids.map((x) => x.toLowerCase()))];
}

/** Message-ID normiert («<…>», klein) — null wenn leer. */
export function normalisiereMessageId(wert: unknown): string | null {
  const ids = mailIdsAusHeader(wert);
  if (ids.length > 0) return ids[0];
  const s = typeof wert === "string" ? wert.trim() : "";
  return s ? `<${s.replace(/^<|>$/g, "").toLowerCase()}>` : null;
}

/** Outlook Thread-Index → Konversations-Schluessel (erste 22 Byte, hex).
 *  null wenn der Header fehlt oder kaputt ist. */
export function konversationAusThreadIndex(wert: unknown): string | null {
  if (typeof wert !== "string" || !wert.trim()) return null;
  try {
    const bin = Buffer.from(wert.trim(), "base64");
    if (bin.length < 22) return null;
    const hex = bin.subarray(0, 22).toString("hex");
    return /^0+$/.test(hex) ? null : hex;
  } catch {
    return null;
  }
}

/** Header-Objekt von Resend (Name → Wert) case-insensitiv lesen. */
export function headerWert(headers: unknown, name: string): unknown {
  if (!headers || typeof headers !== "object") return undefined;
  const ziel = name.toLowerCase();
  if (Array.isArray(headers)) {
    const h = (headers as { name?: string; value?: unknown }[]).find((x) => String(x?.name ?? "").toLowerCase() === ziel);
    return h?.value;
  }
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() === ziel) return v;
  }
  return undefined;
}

export type MailMerkmale = {
  messageId: string | null;
  referenzen: string[];
  konversation: string | null;
  betreffNorm: string;
};

/** Verlaufs-Merkmale einer Mail aus den Resend-Daten. */
export function mailMerkmale(mail: { subject?: string | null; message_id?: unknown; headers?: unknown }): MailMerkmale {
  const messageId = normalisiereMessageId(mail.message_id ?? headerWert(mail.headers, "message-id"));
  // In-Reply-To zuerst, dann References von neu nach alt (die Liste waechst
  // mit jeder Antwort) — gekappt, damit die Abfrage-URL kurz bleibt.
  const referenzen = [
    ...mailIdsAusHeader(headerWert(mail.headers, "in-reply-to")),
    ...mailIdsAusHeader(headerWert(mail.headers, "references")).reverse(),
  ].filter((id) => id !== messageId);
  return {
    messageId,
    referenzen: [...new Set(referenzen)].slice(0, 40),
    konversation: konversationAusThreadIndex(headerWert(mail.headers, "thread-index")),
    betreffNorm: normalisiereBetreff(mail.subject),
  };
}

/** Bereits bekannte Mail (aus auftrag_mails) fuer den Verlaufs-Abgleich. */
export type BekannteMail = {
  id: string;
  job_id: string | null;
  message_id: string | null;
  referenzen: string[] | null;
  konversation: string | null;
  betreff_norm: string | null;
  empfangen_am: string;
};

export type VerlaufErgebnis =
  | { art: "treffer"; jobId: string; grund: "header" | "betreff" }
  | { art: "konflikt"; jobIds: string[] }
  | { art: "keiner" };

/** Entscheidet, ob die neue Mail zu einem schon zugeordneten Verlauf
 *  gehoert. Nur Mails MIT job_id zaehlen. Header-Treffer (References /
 *  In-Reply-To / Thread-Index, in beide Richtungen) schlagen den Betreff;
 *  mehrere Auftraege auf derselben Stufe = Konflikt (nicht raten). */
export function entscheideVerlauf(neu: MailMerkmale, bekannte: BekannteMail[], jetzt: Date = new Date()): VerlaufErgebnis {
  const zugeordnet = bekannte.filter((b) => !!b.job_id);
  const refs = new Set(neu.referenzen);

  const headerJobs = new Set<string>();
  for (const b of zugeordnet) {
    const bRefs = new Set((b.referenzen ?? []).map((r) => r.toLowerCase()));
    const ueberRef =
      (!!b.message_id && refs.has(b.message_id.toLowerCase())) ||
      (!!neu.messageId && bRefs.has(neu.messageId));
    const ueberKonversation = !!neu.konversation && b.konversation === neu.konversation;
    if (ueberRef || ueberKonversation) headerJobs.add(b.job_id as string);
  }
  if (headerJobs.size === 1) return { art: "treffer", jobId: [...headerJobs][0], grund: "header" };
  if (headerJobs.size > 1) return { art: "konflikt", jobIds: [...headerJobs] };

  if (!betreffAussagekraeftig(neu.betreffNorm)) return { art: "keiner" };
  const grenze = jetzt.getTime() - BETREFF_FENSTER_TAGE * 86_400_000;
  const betreffJobs = new Set(
    zugeordnet
      .filter((b) => b.betreff_norm === neu.betreffNorm && new Date(b.empfangen_am).getTime() >= grenze)
      .map((b) => b.job_id as string),
  );
  if (betreffJobs.size === 1) return { art: "treffer", jobId: [...betreffJobs][0], grund: "betreff" };
  if (betreffJobs.size > 1) return { art: "konflikt", jobIds: [...betreffJobs] };
  return { art: "keiner" };
}

/** Auftragsnummern (26xxx / INT-26xxx) in Reihenfolge des Auftretens.
 *  Nur echte EVENTLINE-Nummern — das breitere 2\d{4} griff in einem
 *  Verlauf die Fremdzahl «25013». */
export function auftragsNummernAus(text: string): number[] {
  return [...new Set([...text.matchAll(/\b(?:INT[-\s]?)?(26\d{3})\b/gi)].map((m) => Number(m[1])))];
}
