/**
 * Vertrieb › Kampagnen: Abgleich mit Leos Microsoft-365-Postfach — die
 * REINE Zuordnungslogik (ohne Netz, ohne DB), damit sie testbar ist
 * (mail-sync.test.ts). Den Lauf (Token, Graph, DB) macht mail-sync-lauf.ts.
 *
 * Regeln:
 *  - Gesendet: Mail im Ordner «Gesendet» an `mail_an` (Gross/klein egal)
 *    mit gleichem Betreff → `mail_gesendet_am`; Status → «gesendet», wenn
 *    bisher offen/geplant.
 *  - Antwort: Absender = `mail_an` oder `email` des Kontakts; sonst gleiche
 *    Domain, aber NUR wenn genau ein angeschriebener Kontakt diese Domain
 *    hat (nie bei Gratis-Mailern wie gmail/bluewin). Nur Mails NACH dem
 *    Versand zählen. Status → «geantwortet», wenn bisher offen/geplant/gesendet.
 *  - Nicht zustellbar: Absender postmaster@/mailer-daemon@ oder Betreff
 *    beginnt mit «Unzustellbar»/«Undeliverable», UND der Betreff enthält den
 *    Original-Betreff genau eines angeschriebenen Kontakts.
 *  - Abwesenheitsnotizen/Auto-Antworten zählen nicht als Antwort.
 *  - Interne Mails (eigene Domain) werden nie ausgewertet.
 *  - `status_manuell` = ein Mensch hat entschieden → Status bleibt.
 *  - Idempotent: eine Antwort zählt nur, wenn sie neuer ist als
 *    `letzte_antwort_am` — derselbe Lauf zweimal ändert nichts.
 *
 * Datenschutz: es werden nur Betreff, Adressen und Zeitpunkte verarbeitet
 * (Graph-Recht Mail.ReadBasic), nie Mailinhalte.
 */

import type { KampagneStatus } from "@/types/vertrieb";

export const EIGENE_DOMAIN = "eventline-basel.com";

/** Kontakt, wie ihn der Abgleich braucht. */
export interface SyncKontakt {
  id: string;
  status: KampagneStatus;
  status_manuell: boolean;
  email: string | null;
  mail_an: string | null;
  mail_betreff: string | null;
  mail_gesendet_am: string | null;
  letzte_antwort_am: string | null;
  letzte_antwort_betreff: string | null;
  antworten_anzahl: number;
}

export interface GesendeteMail {
  betreff: string;
  an: string[];
  gesendetAm: string;
}

export interface EingangsMail {
  betreff: string;
  von: string;
  empfangenAm: string;
}

export interface KontaktAenderung {
  id: string;
  /** Felder ausser Status (Zeitpunkte, Zähler). */
  felder: Partial<Pick<SyncKontakt, "mail_gesendet_am" | "letzte_antwort_am" | "letzte_antwort_betreff" | "antworten_anzahl">>;
  /** Statuswechsel, nur gesetzt wenn er sich ändert. `von` dient in der DB
   *  als Wächter: geschrieben wird nur, wenn der Status noch `von` ist. */
  status?: { von: KampagneStatus; nach: KampagneStatus };
}

/** Domains von Gratis-Mailern: nie über die Domain zuordnen. */
const GRATIS_MAILER = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "hotmail.ch", "live.com", "msn.com",
  "yahoo.com", "yahoo.de", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com",
  "gmx.ch", "gmx.de", "gmx.net", "gmx.at", "web.de", "t-online.de", "bluewin.ch", "sunrise.ch",
  "hispeed.ch", "swissonline.ch", "green.ch", "datacomm.ch", "vtxmail.ch", "bluemail.ch", "freesurf.ch",
]);

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

/** Unzustellbarkeits-Meldung (Bounce)? */
export function istBounce(m: EingangsMail): boolean {
  const lokal = adresse(m.von).split("@")[0] ?? "";
  if (lokal === "postmaster" || lokal === "mailer-daemon") return true;
  return /^\s*(unzustellbar|undeliverable)/i.test(m.betreff);
}

/** Abwesenheits-/Auto-Antwort? Zählt nicht als Antwort (sonst stünden bei
 *  jeder Massen-Aussendung Dutzende «Antwort erhalten» ohne echte Antwort). */
export function istAutoAntwort(betreff: string): boolean {
  return /^\s*(automatische antwort|automatic reply|autoreply|auto-reply|abwesenheitsnotiz|abwesend|out of (the )?office|réponse automatique|risposta automatica)\b/i.test(betreff);
}

const zeit = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

const VOR_DEM_VERSAND: readonly KampagneStatus[] = ["offen", "geplant"];
const WARTET_AUF_ANTWORT: readonly KampagneStatus[] = ["offen", "geplant", "gesendet"];

export function berechneAbgleich(
  kontakte: SyncKontakt[],
  gesendet: GesendeteMail[],
  eingang: EingangsMail[],
): KontaktAenderung[] {
  // Arbeitskopie: Änderungen eines Schritts gelten im nächsten (eine Mail,
  // die in diesem Lauf als gesendet erkannt wird, kann schon Antworten haben).
  const stand = new Map(kontakte.map((k) => [k.id, { ...k }]));
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
  const versand = new Map<string, string>();
  for (const m of gesendet) {
    const b = betreffNorm(m.betreff);
    if (!b || Number.isNaN(zeit(m.gesendetAm))) continue;
    for (const roh of m.an) {
      const an = adresse(roh);
      if (!an || istIntern(an)) continue;
      const key = `${an}|${b}`;
      const bisher = versand.get(key);
      if (!bisher || zeit(m.gesendetAm) < zeit(bisher)) versand.set(key, m.gesendetAm);
    }
  }
  for (const k of stand.values()) {
    if (k.mail_gesendet_am || !k.mail_an || !k.mail_betreff) continue;
    const am = versand.get(`${adresse(k.mail_an)}|${betreffNorm(k.mail_betreff)}`);
    if (!am) continue;
    k.mail_gesendet_am = am;
    aenderung(k.id).felder.mail_gesendet_am = am;
    setzeStatus(k, "gesendet", VOR_DEM_VERSAND);
  }

  // ── 2. Eingang: Antworten und Unzustellbares ─────────────────────────
  const angeschrieben = [...stand.values()].filter((k) => k.mail_gesendet_am);
  const nachAdresse = new Map<string, SyncKontakt[]>();
  const nachDomain = new Map<string, Set<SyncKontakt>>();
  for (const k of angeschrieben) {
    for (const a of new Set([adresse(k.mail_an), adresse(k.email)])) {
      if (!a) continue;
      nachAdresse.set(a, [...(nachAdresse.get(a) ?? []), k]);
      const d = domainVon(a);
      if (d && !GRATIS_MAILER.has(d) && d !== EIGENE_DOMAIN) {
        if (!nachDomain.has(d)) nachDomain.set(d, new Set());
        nachDomain.get(d)!.add(k);
      }
    }
  }
  const vorEingang = (k: SyncKontakt, m: EingangsMail) => zeit(k.mail_gesendet_am) <= zeit(m.empfangenAm);

  const sortiert = [...eingang]
    .filter((m) => !Number.isNaN(zeit(m.empfangenAm)))
    .sort((a, b) => zeit(a.empfangenAm) - zeit(b.empfangenAm));

  for (const m of sortiert) {
    const von = adresse(m.von);
    if (!von || istIntern(von)) continue;

    if (istBounce(m)) {
      const b = betreffNorm(m.betreff);
      const treffer = angeschrieben.filter((k) => {
        const orig = betreffNorm(k.mail_betreff);
        return orig !== "" && b.includes(orig) && vorEingang(k, m);
      });
      if (treffer.length === 1) setzeStatus(treffer[0], "unzustellbar", WARTET_AUF_ANTWORT);
      continue;
    }

    if (istAutoAntwort(m.betreff)) continue;

    let treffer = (nachAdresse.get(von) ?? []).filter((k) => vorEingang(k, m));
    if (treffer.length === 0) {
      const d = domainVon(von);
      const kandidaten = [...(nachDomain.get(d) ?? [])].filter((k) => vorEingang(k, m));
      if (kandidaten.length === 1) treffer = kandidaten;
    }
    for (const k of treffer) {
      if (k.letzte_antwort_am && zeit(m.empfangenAm) <= zeit(k.letzte_antwort_am)) continue;
      k.antworten_anzahl += 1;
      k.letzte_antwort_am = m.empfangenAm;
      k.letzte_antwort_betreff = m.betreff;
      Object.assign(aenderung(k.id).felder, {
        antworten_anzahl: k.antworten_anzahl,
        letzte_antwort_am: k.letzte_antwort_am,
        letzte_antwort_betreff: k.letzte_antwort_betreff,
      });
      setzeStatus(k, "geantwortet", WARTET_AUF_ANTWORT);
    }
  }

  return [...aenderungen.values()].filter((a) => a.status || Object.keys(a.felder).length > 0);
}

const TAG = 24 * 60 * 60 * 1000;

/**
 * Ab wann im Ordner «Gesendet» gesucht wird: ältester Plantermin der noch
 * nicht erkannten Mails minus 1 Tag (ohne Plantermin: 30 Tage zurück, die
 * Mail kann von Hand verschickt worden sein). null = nichts zu suchen.
 */
export function gesendetFenster(
  kontakte: (SyncKontakt & { mail_geplant_am: string | null })[],
  jetzt = Date.now(),
): string | null {
  const offen = kontakte.filter((k) => !k.mail_gesendet_am && k.mail_an && k.mail_betreff);
  if (offen.length === 0) return null;
  const t = Math.min(...offen.map((k) => {
    const g = zeit(k.mail_geplant_am);
    return Number.isNaN(g) ? jetzt - 30 * TAG : g;
  }));
  return new Date(Math.min(t, jetzt) - TAG).toISOString();
}

/**
 * Ab wann der Posteingang gelesen wird: ab dem frühesten Versand — bei
 * Folgeläufen nur ab dem letzten Abgleich minus 2 Tage (Antworten zählen
 * über letzte_antwort_am nie doppelt). Wurde in diesem Lauf etwas NEU als
 * gesendet erkannt, mindestens ab dessen Versand. null = nichts zu lesen.
 */
export function eingangFenster(
  kontakte: SyncKontakt[],
  letzterSync: string | null,
  neuGesendetAm: string[],
): string | null {
  const alt = kontakte.map((k) => zeit(k.mail_gesendet_am)).filter((t) => !Number.isNaN(t));
  let ab = Infinity;
  if (alt.length) {
    const seitSync = zeit(letzterSync);
    ab = Number.isNaN(seitSync) ? Math.min(...alt) : Math.max(Math.min(...alt), seitSync - 2 * TAG);
  }
  const neu = neuGesendetAm.map(zeit).filter((t) => !Number.isNaN(t));
  if (neu.length) ab = Math.min(ab, ...neu);
  return Number.isFinite(ab) ? new Date(ab).toISOString() : null;
}
