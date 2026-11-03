// «Meine Anfragen» — alles, was eine Person gemeldet hat, in EINER Liste:
// Tickets (Beleg, Stempel korrigieren, IT, Material) und Abwesenheiten.
//
// Server-seitig (Admin-Client, immer mit user_id/created_by gefiltert).
// Genutzt von /api/anfragen (Seite Meine Anfragen) und
// /api/mein-konto/uebersicht (die letzten drei im Hub).
//
// Stand-Woerter fuer Mitarbeiter (kein «Ticket», kein «Antrag»):
//   Ticket offen → «wird geprüft», erledigt → «erledigt» (Stempel:
//   «korrigiert»), abgelehnt → «abgelehnt».
//   Abwesenheit beantragt → «wartet auf OK», genehmigt → «bewilligt»,
//   abgelehnt → «abgelehnt».

import type { SupabaseClient } from "@supabase/supabase-js";
import { arztzeugnisFehlt, arztzeugnisFaelligAb, krankLaeuft, KRANKMELDUNG } from "@/lib/krank";
import { todayLocalIso } from "@/lib/swiss-time";

export type AnfrageArt = "beleg" | "stempel" | "it" | "material" | "abwesenheit" | "krank";
export type AnfrageTon = "amber" | "green" | "red" | "muted";

export interface Anfrage {
  /** «ticket:<id>» bzw. «abwesenheit:<id>» — eindeutig ueber beide Quellen. */
  key: string;
  id: string;
  quelle: "ticket" | "abwesenheit";
  art: AnfrageArt;
  /** Kurzbeschrieb, z. B. «CHF 48.20 · Migros», «Ferien 22.–26.12.». */
  was: string;
  gemeldet_at: string;
  stand: string;
  ton: AnfrageTon;
  /** Gehoert in «Offen» (sonst «Erledigt»). */
  offen: boolean;
  /** Detailseite (Tickets) oder null. */
  link: string | null;
  /** Darf die Person das selbst zurueckziehen? (offene Abwesenheit) */
  zurueckziehbar: boolean;
  /** Nur Krankmeldungen (Migration 378). */
  krank?: {
    laeuft: boolean;
    endeOffen: boolean;
    hatZeugnis: boolean;
    zeugnisFehlt: boolean;
    /** Ab wann das Arztzeugnis faellig ist (YYYY-MM-DD). */
    zeugnisAb: string;
  };
}

export const ART_LABEL: Record<AnfrageArt, string> = {
  beleg: "Beleg",
  stempel: "Stempel",
  it: "IT",
  material: "Material",
  abwesenheit: "Abwesenheit",
  krank: "Krank",
};

const ABWESENHEIT_LABEL: Record<string, string> = {
  ferien: "Ferien",
  krank: "Krank",
  kompensation: "Kompensation",
  frei: "Frei",
  militaer: "Militär",
};

const TAG = new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit" });
const ZEIT = new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit", hour12: false });

/** «YYYY-MM-DD» (Kalendertag) → «22.12.» — ohne Zeitzonen-Verschiebung. */
export function tagKurz(iso: string): string {
  const [, m, d] = iso.split("-");
  return `${d}.${m}.`;
}

/** Zeitraum aus Kalendertagen: «22.–26.12.», «30.12.–02.01.», «03.11.». */
export function zeitraumKurz(start: string, ende: string): string {
  if (start === ende) return tagKurz(start);
  const [, sm, sd] = start.split("-");
  const [, em] = ende.split("-");
  if (sm === em) return `${sd}.–${tagKurz(ende)}`;
  return `${tagKurz(start)}–${tagKurz(ende)}`;
}

interface TicketZeile {
  id: string;
  type: "it" | "beleg" | "stempel_aenderung" | "material";
  status: "offen" | "erledigt" | "abgelehnt";
  title: string;
  data: Record<string, unknown> | null;
  created_at: string;
}

interface AbwesenheitZeile {
  id: string;
  type: string;
  status: "beantragt" | "genehmigt" | "abgelehnt";
  start_date: string;
  end_date: string;
  created_at: string;
  approved_by_name: string | null;
  ende_offen: boolean | null;
  arztzeugnis_pfad: string | null;
}

const ABWESENHEIT_SPALTEN = "id, type, status, start_date, end_date, created_at, approved_by_name, ende_offen, arztzeugnis_pfad";

function istKrankmeldung(a: AbwesenheitZeile): boolean {
  return a.type === "krank" && a.status === "genehmigt" && a.approved_by_name === KRANKMELDUNG;
}

function ticketAlsAnfrage(t: TicketZeile): Anfrage {
  const d = t.data ?? {};
  const art: AnfrageArt = t.type === "stempel_aenderung" ? "stempel" : t.type;
  let was = t.title;
  if (t.type === "beleg") {
    const betrag = typeof d.betrag_chf === "number" ? `CHF ${d.betrag_chf.toFixed(2)}` : "Beleg";
    was = typeof d.lieferant === "string" && d.lieferant ? `${betrag} · ${d.lieferant}` : betrag;
  } else if (t.type === "stempel_aenderung") {
    const start = typeof d.neu_start === "string" ? d.neu_start : null;
    const ende = typeof d.neu_end === "string" ? d.neu_end : null;
    if (start) {
      was = `${TAG.format(new Date(start))} ${ZEIT.format(new Date(start))}${ende ? `–${ZEIT.format(new Date(ende))}` : ""}`;
    }
  }
  const stand =
    t.status === "offen" ? "wird geprüft"
      : t.status === "abgelehnt" ? "abgelehnt"
        : t.type === "stempel_aenderung" ? "korrigiert" : "erledigt";
  return {
    key: `ticket:${t.id}`,
    id: t.id,
    quelle: "ticket",
    art,
    was,
    gemeldet_at: t.created_at,
    stand,
    ton: t.status === "offen" ? "amber" : t.status === "abgelehnt" ? "red" : "green",
    offen: t.status === "offen",
    link: `/tickets/${t.id}`,
    zurueckziehbar: false,
  };
}

function krankAlsAnfrage(a: AbwesenheitZeile, heute: string): Anfrage {
  const endeOffen = a.ende_offen === true;
  const hatZeugnis = !!a.arztzeugnis_pfad;
  const laeuft = krankLaeuft({ bis: a.end_date, endeOffen }, heute);
  const zeugnisFehlt = arztzeugnisFehlt({ ab: a.start_date, bis: a.end_date, endeOffen, hatZeugnis }, heute);
  const zeitraum = endeOffen ? `ab ${tagKurz(a.start_date)}, Ende offen` : zeitraumKurz(a.start_date, a.end_date);
  return {
    key: `abwesenheit:${a.id}`,
    id: a.id,
    quelle: "abwesenheit",
    art: "krank",
    was: zeitraum,
    gemeldet_at: a.created_at,
    stand: zeugnisFehlt ? "Arztzeugnis fehlt" : laeuft ? "gemeldet" : "abgeschlossen",
    ton: zeugnisFehlt ? "red" : laeuft ? "amber" : "green",
    offen: laeuft || zeugnisFehlt,
    link: null,
    zurueckziehbar: false,
    krank: { laeuft, endeOffen, hatZeugnis, zeugnisFehlt, zeugnisAb: arztzeugnisFaelligAb(a.start_date) },
  };
}

function abwesenheitAlsAnfrage(a: AbwesenheitZeile, heute: string): Anfrage {
  if (istKrankmeldung(a)) return krankAlsAnfrage(a, heute);
  return {
    key: `abwesenheit:${a.id}`,
    id: a.id,
    quelle: "abwesenheit",
    art: "abwesenheit",
    was: `${ABWESENHEIT_LABEL[a.type] ?? "Abwesenheit"} ${zeitraumKurz(a.start_date, a.end_date)}`,
    gemeldet_at: a.created_at,
    stand: a.status === "beantragt" ? "wartet auf OK" : a.status === "genehmigt" ? "bewilligt" : "abgelehnt",
    ton: a.status === "beantragt" ? "amber" : a.status === "genehmigt" ? "green" : "red",
    offen: a.status === "beantragt",
    link: null,
    zurueckziehbar: a.status === "beantragt",
  };
}

/** Anfragen einer Person. `stand`: nur offene, nur erledigte oder alle
 *  (neueste zuerst). `limit` je Quelle. Krankmeldungen sind «offen», solange
 *  sie laufen oder das Arztzeugnis fehlt (lib/krank.ts). */
export async function ladeAnfragen(
  admin: SupabaseClient,
  userId: string,
  opts: { stand: "offen" | "erledigt" | "alle"; limit?: number },
): Promise<Anfrage[]> {
  const limit = opts.limit ?? 100;
  const heute = todayLocalIso();
  let tq = admin
    .from("tickets")
    .select("id, type, status, title, data, created_at")
    .eq("created_by", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  let aq = admin
    .from("time_off")
    .select(ABWESENHEIT_SPALTEN)
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (opts.stand === "offen") {
    tq = tq.eq("status", "offen");
    // Offen: beantragte + alle Krankmeldungen (Feinfilter unten).
    aq = aq.or(`status.eq.beantragt,approved_by_name.eq.${KRANKMELDUNG}`);
  } else if (opts.stand === "erledigt") {
    tq = tq.neq("status", "offen");
    aq = aq.neq("status", "beantragt");
  }
  const [t, a] = await Promise.all([tq, aq]);
  if (t.error) throw new Error(`Meldungen konnten nicht geladen werden: ${t.error.message}`);
  if (a.error) throw new Error(`Abwesenheiten konnten nicht geladen werden: ${a.error.message}`);
  let liste = [
    ...((t.data ?? []) as TicketZeile[]).map(ticketAlsAnfrage),
    ...((a.data ?? []) as unknown as AbwesenheitZeile[]).map((z) => abwesenheitAlsAnfrage(z, heute)),
  ];
  if (opts.stand === "offen") liste = liste.filter((x) => x.offen);
  if (opts.stand === "erledigt") liste = liste.filter((x) => !x.offen);
  liste.sort((x, y) => y.gemeldet_at.localeCompare(x.gemeldet_at));
  return liste;
}

/** Anzahl offener Anfragen (fuer «Offen (n)»), aus der DB gezaehlt;
 *  Krankmeldungen nach lib/krank.ts eingeordnet. */
export async function zaehleOffeneAnfragen(admin: SupabaseClient, userId: string): Promise<number> {
  const heute = todayLocalIso();
  const [t, a, k] = await Promise.all([
    admin.from("tickets").select("id", { count: "exact", head: true }).eq("created_by", userId).eq("status", "offen"),
    admin.from("time_off").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("status", "beantragt"),
    admin.from("time_off").select(ABWESENHEIT_SPALTEN).eq("user_id", userId).eq("type", "krank")
      .eq("status", "genehmigt").eq("approved_by_name", KRANKMELDUNG).order("created_at", { ascending: false }).limit(200),
  ]);
  if (t.error) throw new Error(t.error.message);
  if (a.error) throw new Error(a.error.message);
  if (k.error) throw new Error(k.error.message);
  const krankOffen = ((k.data ?? []) as unknown as AbwesenheitZeile[]).filter((z) => krankAlsAnfrage(z, heute).offen).length;
  return (t.count ?? 0) + (a.count ?? 0) + krankOffen;
}
