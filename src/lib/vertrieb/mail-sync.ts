/**
 * Vertrieb › Kampagnen: Abgleich mit Leos Microsoft-365-Postfach — die
 * REINE Zuordnungslogik (ohne Netz, ohne DB), damit sie testbar ist
 * (mail-sync.test.ts). Den Lauf (Token, Graph, DB) macht mail-sync-lauf.ts.
 *
 * Regeln:
 *  - Gesendet: Mail im Ordner «Gesendet» an `mail_an` (Gross/klein egal)
 *    mit gleichem Betreff → `mail_gesendet_am`, dazu die Microsoft-
 *    Konversation (`mail_conversation_id`) und Graph-ID der gesendeten Mail;
 *    Status → «gesendet», wenn bisher offen/geplant.
 *  - Antwort: in erster Linie eine Mail in DERSELBEN Konversation wie die
 *    Erstmail. Rückfall nur: Absender = `mail_an`/`email` des Kontakts UND
 *    Betreff = Antwort-Präfix (AW:/RE:/…) + Original-Betreff. Keine Zuordnung
 *    über die Domain. Nur Mails NACH dem Versand. Status → «geantwortet»,
 *    wenn bisher offen/geplant/gesendet.
 *  - Nicht zustellbar: Meldung eines Mailsystems (postmaster@, mailer-daemon@,
 *    MicrosoftExchange…@ — auch der eigenen Domain) oder typischer Betreff
 *    («Unzustellbar», «Undeliverable», …; nicht «verzögert»). Zuordnung über
 *    die Konversation oder über die Empfängeradresse im Text der Meldung
 *    (vom Lauf nur im Speicher ausgelesen) — nur wenn eindeutig.
 *  - Abwesenheitsnotizen/Auto-Antworten zählen nicht als Antwort.
 *  - Interne Mails (eigene Domain) zählen nie als Antwort.
 *  - `status_manuell` = ein Mensch hat entschieden → Status bleibt.
 *  - Idempotent: eine Antwort zählt nur, wenn sie neuer ist als
 *    `letzte_antwort_am` und ihre ID noch nicht bekannt ist.
 *
 * Datenschutz: gespeichert werden nur Zeitpunkte, Betreff, Konversations- und
 * Graph-IDs — nie Mailinhalte. Inhalte (Antworten im Detail, Text einer
 * Unzustellbarkeits-Meldung) werden nur live gelesen und angezeigt bzw.
 * ausgewertet (Recht: M365_SCOPE in m365.ts).
 */

import type { KampagneStatus } from "@/types/vertrieb";

export const EIGENE_DOMAIN = "eventline-basel.com";
/** Höchstens so weit zurück wird im Postfach gesucht (Audit M5). */
export const MAX_FENSTER_TAGE = 45;
/** Höchstens so viele Antwort-IDs je Kontakt merken. */
const MAX_ANTWORT_IDS = 20;

/** Kontakt, wie ihn der Abgleich braucht. */
export interface SyncKontakt {
  id: string;
  status: KampagneStatus;
  status_manuell: boolean;
  email: string | null;
  mail_an: string | null;
  mail_betreff: string | null;
  mail_gesendet_am: string | null;
  mail_conversation_id: string | null;
  graph_message_id: string | null;
  letzte_antwort_am: string | null;
  letzte_antwort_betreff: string | null;
  antworten_anzahl: number;
  /** Graph-IDs der Antworten, die der Abgleich selbst zugeordnet hat. */
  antwort_graph_ids: string[];
}

export interface GesendeteMail {
  id?: string;
  conversationId?: string;
  betreff: string;
  an: string[];
  gesendetAm: string;
}

export interface EingangsMail {
  /** Graph-ID der Nachricht. */
  id?: string;
  conversationId?: string;
  betreff: string;
  von: string;
  empfangenAm: string;
  /** Nur bei Unzustellbarkeits-Meldungen: Adressen aus dem Meldungstext
   *  (vom Lauf live gelesen, nie gespeichert). */
  ndrEmpfaenger?: string[];
}

type AenderbareFelder =
  | "mail_gesendet_am" | "mail_conversation_id" | "graph_message_id"
  | "letzte_antwort_am" | "letzte_antwort_betreff" | "antworten_anzahl" | "antwort_graph_ids";

export interface KontaktAenderung {
  id: string;
  /** Felder ausser Status (Zeitpunkte, Zähler, IDs). */
  felder: Partial<Pick<SyncKontakt, AenderbareFelder>>;
  /** Statuswechsel, nur gesetzt wenn er sich ändert. `von` dient in der DB
   *  als Wächter: geschrieben wird nur, wenn der Status noch `von` ist. */
  status?: { von: KampagneStatus; nach: KampagneStatus };
}

/** Adresse vergleichbar machen: klein, ohne Leerraum, ohne <…>/mailto:. */
export function adresse(s: string | null | undefined): string {
  if (!s) return "";
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().replace(/^mailto:/i, "").trim().toLowerCase();
}

export function domainVon(addr: string): string {
  const i = addr.lastIndexOf("@");
  return i < 0 ? "" : addr.slice(i + 1);
}

/** Betreff vergleichbar machen: klein, Leerraum zusammengezogen. */
export function betreffNorm(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

export function istIntern(addr: string): boolean {
  return domainVon(addr) === EIGENE_DOMAIN;
}

/** Absender eines Mailsystems (nie eine echte Antwort). */
export function istSystemAbsender(von: string): boolean {
  const lokal = adresse(von).split("@")[0] ?? "";
  return lokal === "postmaster" || lokal === "mailer-daemon" || lokal.startsWith("microsoftexchange");
}

const BOUNCE_BETREFF = /^\s*(unzustellbar|nicht zustellbar|undeliverable|undelivered mail|delivery status notification|mail delivery (failed|system)|returned mail|delivery has failed|non remis|impossible de remettre|non recapitabile)/i;
const NUR_VERZOEGERT = /verzögert|verzoegert|delayed|delay\b|retard|ritardo/i;

/** Unzustellbarkeits-Meldung (NDR)? «Zustellung verzögert» zählt nicht. */
export function istBounce(m: Pick<EingangsMail, "von" | "betreff">): boolean {
  if (NUR_VERZOEGERT.test(m.betreff)) return false;
  return istSystemAbsender(m.von) || BOUNCE_BETREFF.test(m.betreff);
}

/** Abwesenheits-/Auto-Antwort? Zählt nicht als Antwort (sonst stünden bei
 *  jeder Massen-Aussendung Dutzende «Antwort erhalten» ohne echte Antwort).
 *  Auch hinter Präfixen wie «AW: Automatische Antwort: …». */
export function istAutoAntwort(betreff: string): boolean {
  const ohnePraefix = betreff.replace(ANTWORT_PRAEFIX, "");
  return /^\s*(automatische antwort|automatic reply|autoreply|auto-reply|abwesenheitsnotiz|abwesenheit|abwesend|nicht im büro|ich bin nicht im büro|out of (the )?office|réponse automatique|absence du bureau|risposta automatica|fuori ufficio)\b/i.test(ohnePraefix);
}

/** Antwort-Präfixe (DE/EN/FR/IT/Skandinavien), auch mehrfach: «AW: RE: …». */
const ANTWORT_PRAEFIX = /^\s*(((aw|re|antw|antwort|sv|vs|r|rif|ris|réf|ref)\s*(\[\d+\])?\s*:\s*)+)/i;

/** Ist `betreff` eine Antwort (Präfix) auf `original`? */
export function istAntwortBetreff(betreff: string, original: string | null): boolean {
  const orig = betreffNorm(original);
  if (!orig || !ANTWORT_PRAEFIX.test(betreff)) return false;
  return betreffNorm(betreff.replace(ANTWORT_PRAEFIX, "")) === orig;
}

/** Adressen aus dem Text einer Unzustellbarkeits-Meldung (ohne eigene
 *  Domain und ohne Mailsystem-Absender). */
export function ndrAdressen(text: string): string[] {
  const treffer = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
  return [...new Set(treffer.map((t) => t.toLowerCase()))]
    .filter((a) => !istIntern(a) && !istSystemAbsender(a));
}

const zeit = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

const VOR_DEM_VERSAND: readonly KampagneStatus[] = ["offen", "geplant"];
const WARTET_AUF_ANTWORT: readonly KampagneStatus[] = ["offen", "geplant", "gesendet"];

const vorEingang = (k: SyncKontakt, m: EingangsMail) => zeit(k.mail_gesendet_am) <= zeit(m.empfangenAm);
const adressenVon = (k: SyncKontakt) => new Set([adresse(k.mail_an), adresse(k.email)].filter(Boolean));

/**
 * Zuordnung einer eingehenden Mail zu angeschriebenen Kontakten (siehe
 * Regeln oben): Konversation der Erstmail; Rückfall exakte Adresse + Antwort-
 * Betreff. Nie interne Mails, Mailsysteme, Unzustellbares, Auto-Antworten.
 * `angeschrieben` = Kontakte mit mail_gesendet_am.
 */
export function antwortZuordnung(angeschrieben: SyncKontakt[]): (m: EingangsMail) => SyncKontakt[] {
  const nachKonversation = new Map<string, SyncKontakt[]>();
  const nachAdresse = new Map<string, SyncKontakt[]>();
  for (const k of angeschrieben) {
    if (!k.mail_gesendet_am) continue;
    if (k.mail_conversation_id) {
      nachKonversation.set(k.mail_conversation_id, [...(nachKonversation.get(k.mail_conversation_id) ?? []), k]);
    }
    for (const a of adressenVon(k)) nachAdresse.set(a, [...(nachAdresse.get(a) ?? []), k]);
  }
  return (m) => {
    const von = adresse(m.von);
    if (!von || istIntern(von) || istSystemAbsender(von) || istBounce(m) || istAutoAntwort(m.betreff)) return [];
    if (Number.isNaN(zeit(m.empfangenAm))) return [];
    if (m.conversationId) {
      const konv = (nachKonversation.get(m.conversationId) ?? []).filter((k) => vorEingang(k, m));
      // Eine Erstmail an mehrere Kontakte: nur der, der antwortet.
      if (konv.length === 1) return konv;
      if (konv.length > 1) return konv.filter((k) => adressenVon(k).has(von));
    }
    return (nachAdresse.get(von) ?? []).filter((k) => vorEingang(k, m) && istAntwortBetreff(m.betreff, k.mail_betreff));
  };
}

/** Kontakte, denen eine Unzustellbarkeits-Meldung eindeutig gehört. */
function bounceZuordnung(angeschrieben: SyncKontakt[], m: EingangsMail): SyncKontakt[] {
  const vorher = angeschrieben.filter((k) => vorEingang(k, m));
  if (m.conversationId) {
    const konv = vorher.filter((k) => k.mail_conversation_id === m.conversationId);
    if (konv.length === 1) return konv;
  }
  const adressen = new Set(m.ndrEmpfaenger ?? []);
  if (adressen.size === 0) return [];
  const treffer = vorher.filter((k) => adresse(k.mail_an) && adressen.has(adresse(k.mail_an)));
  // Eindeutig = genau EINE betroffene Adresse (dieselbe Adresse kann in zwei
  // Kampagnen stehen — dann sind beide unzustellbar).
  return new Set(treffer.map((k) => adresse(k.mail_an))).size === 1 ? treffer : [];
}

export function berechneAbgleich(
  kontakte: SyncKontakt[],
  gesendet: GesendeteMail[],
  eingang: EingangsMail[],
): KontaktAenderung[] {
  // Arbeitskopie: Änderungen eines Schritts gelten im nächsten (eine Mail,
  // die in diesem Lauf als gesendet erkannt wird, kann schon Antworten haben).
  const stand = new Map(kontakte.map((k) => [k.id, { ...k, antwort_graph_ids: [...(k.antwort_graph_ids ?? [])] }]));
  const urStatus = new Map(kontakte.map((k) => [k.id, k.status]));
  const aenderungen = new Map<string, KontaktAenderung>();
  const aenderung = (id: string) => {
    let a = aenderungen.get(id);
    if (!a) { a = { id, felder: {} }; aenderungen.set(id, a); }
    return a;
  };
  const setzeStatus = (k: SyncKontakt, nach: KampagneStatus, erlaubtAus: readonly KampagneStatus[]) => {
    if (k.status_manuell || !erlaubtAus.includes(k.status) || k.status === nach) return;
    const a = aenderung(k.id);
    a.status = { von: urStatus.get(k.id)!, nach };
    k.status = nach;
  };

  // ── 1. Gesendet ──────────────────────────────────────────────────────
  // Früheste gesendete Mail je (Empfänger, Betreff).
  const versand = new Map<string, GesendeteMail>();
  for (const m of gesendet) {
    const b = betreffNorm(m.betreff);
    if (!b || Number.isNaN(zeit(m.gesendetAm))) continue;
    for (const roh of m.an) {
      const an = adresse(roh);
      if (!an || istIntern(an)) continue;
      const key = `${an}|${b}`;
      const bisher = versand.get(key);
      if (!bisher || zeit(m.gesendetAm) < zeit(bisher.gesendetAm)) versand.set(key, m);
    }
  }
  for (const k of stand.values()) {
    if ((k.mail_gesendet_am && k.mail_conversation_id) || !k.mail_an || !k.mail_betreff) continue;
    const m = versand.get(`${adresse(k.mail_an)}|${betreffNorm(k.mail_betreff)}`);
    if (!m) continue;
    const a = aenderung(k.id);
    if (!k.mail_gesendet_am) {
      k.mail_gesendet_am = m.gesendetAm;
      a.felder.mail_gesendet_am = m.gesendetAm;
      setzeStatus(k, "gesendet", VOR_DEM_VERSAND);
    }
    if (!k.mail_conversation_id && m.conversationId) {
      k.mail_conversation_id = m.conversationId;
      a.felder.mail_conversation_id = m.conversationId;
      if (m.id) { k.graph_message_id = m.id; a.felder.graph_message_id = m.id; }
    }
  }

  // ── 2. Eingang: Antworten und Unzustellbares ─────────────────────────
  const angeschrieben = [...stand.values()].filter((k) => k.mail_gesendet_am);
  const antwortVon = antwortZuordnung(angeschrieben);

  const sortiert = [...eingang]
    .filter((m) => !Number.isNaN(zeit(m.empfangenAm)))
    .sort((a, b) => zeit(a.empfangenAm) - zeit(b.empfangenAm));

  for (const m of sortiert) {
    // Bounces VOR dem Intern-Filter: Exchange meldet von der eigenen Domain.
    if (istBounce(m)) {
      for (const k of bounceZuordnung(angeschrieben, m)) setzeStatus(k, "unzustellbar", WARTET_AUF_ANTWORT);
      continue;
    }

    for (const k of antwortVon(m)) {
      if (m.id && k.antwort_graph_ids.includes(m.id)) continue;
      if (k.letzte_antwort_am && zeit(m.empfangenAm) <= zeit(k.letzte_antwort_am)) continue;
      k.antworten_anzahl += 1;
      k.letzte_antwort_am = m.empfangenAm;
      k.letzte_antwort_betreff = m.betreff;
      const felder: KontaktAenderung["felder"] = {
        antworten_anzahl: k.antworten_anzahl,
        letzte_antwort_am: k.letzte_antwort_am,
        letzte_antwort_betreff: k.letzte_antwort_betreff,
      };
      if (m.id) {
        k.antwort_graph_ids = [...k.antwort_graph_ids, m.id].slice(-MAX_ANTWORT_IDS);
        felder.antwort_graph_ids = k.antwort_graph_ids;
      }
      Object.assign(aenderung(k.id).felder, felder);
      setzeStatus(k, "geantwortet", WARTET_AUF_ANTWORT);
    }
  }

  return [...aenderungen.values()].filter((a) => a.status || Object.keys(a.felder).length > 0);
}

const TAG = 24 * 60 * 60 * 1000;

/** Untergrenze aller Suchfenster: höchstens MAX_FENSTER_TAGE zurück. */
const untergrenze = (jetzt: number) => jetzt - MAX_FENSTER_TAGE * TAG;

/**
 * Ab wann im Ordner «Gesendet» gesucht wird: frühester noch offener Versand
 * (Plantermin, sonst 30 Tage zurück; bei schon erkannten Mails ohne
 * Konversation deren Versandzeit) minus 1 Tag — höchstens MAX_FENSTER_TAGE
 * zurück, damit eine nie verschickte Mail das Fenster nicht endlos wachsen
 * lässt. null = nichts zu suchen.
 */
export function gesendetFenster(
  kontakte: (SyncKontakt & { mail_geplant_am: string | null })[],
  jetzt = Date.now(),
): string | null {
  const offen = kontakte.filter((k) => k.mail_an && k.mail_betreff && (!k.mail_gesendet_am || !k.mail_conversation_id));
  if (offen.length === 0) return null;
  const t = Math.min(...offen.map((k) => {
    const g = zeit(k.mail_gesendet_am ?? k.mail_geplant_am);
    return Number.isNaN(g) ? jetzt - 30 * TAG : g;
  }));
  return new Date(Math.max(Math.min(t, jetzt) - TAG, untergrenze(jetzt))).toISOString();
}

/**
 * Ab wann der Posteingang gelesen wird: ab dem frühesten Versand — bei
 * Folgeläufen nur ab dem letzten Abgleich minus 2 Tage (Antworten zählen
 * nie doppelt). Wurde in diesem Lauf etwas NEU als gesendet erkannt,
 * mindestens ab dessen Versand. Höchstens MAX_FENSTER_TAGE zurück.
 * null = nichts zu lesen.
 */
export function eingangFenster(
  kontakte: SyncKontakt[],
  letzterSync: string | null,
  neuGesendetAm: string[],
  jetzt = Date.now(),
): string | null {
  const alt = kontakte.map((k) => zeit(k.mail_gesendet_am)).filter((t) => !Number.isNaN(t));
  let ab = Infinity;
  if (alt.length) {
    const seitSync = zeit(letzterSync);
    ab = Number.isNaN(seitSync) ? Math.min(...alt) : Math.max(Math.min(...alt), seitSync - 2 * TAG);
  }
  const neu = neuGesendetAm.map(zeit).filter((t) => !Number.isNaN(t));
  if (neu.length) ab = Math.min(ab, ...neu);
  return Number.isFinite(ab) ? new Date(Math.max(ab, untergrenze(jetzt))).toISOString() : null;
}
