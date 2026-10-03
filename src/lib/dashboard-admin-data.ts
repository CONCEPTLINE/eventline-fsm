// Firmen-Cockpit-Daten — EINE Quelle fuer das App-Dashboard (/api/dashboard)
// und das Wand-Dashboard im Buero (/api/bildschirm/daten), damit beide
// dieselben Zahlen zeigen.
//
// Aufbau (2026-10-02, Dashboard fest statt Baukasten):
//   ladeKennzahlen / ladeAufmerksamkeit / ladeTeamStatus / ladeNaechsteAuftraege
//   — je ein Loader pro Dashboard-Bereich (src/lib/dashboard-bereiche.ts).
//   Das App-Dashboard ruft nur die Loader der Bereiche auf, die die Rolle sieht.
//   loadAdminData() — der Buero-Bildschirm: Kennzahlen, Aufmerksamkeit, Team,
//   firmenweit (seine Agenda laedt /api/bildschirm/daten selbst).

import { createAdminClient } from "@/lib/supabase/admin";
import { todayLocalIso, localDateIso, plusTage, ZRH_TZ } from "@/lib/swiss-time";
import { JOB_FIELDS } from "@/lib/constants";
import { PORTAL_ROLLEN_IN } from "@/lib/roles";

type AdminClient = ReturnType<typeof createAdminClient>;

/** Zurich-Offset ("+01:00"/"+02:00") fuer ein Zurich-Datum YYYY-MM-DD.
 *  Wir brauchen das, um exakt Zurich-Mitternacht als timestamptz-String
 *  gegen jobs.end_date (timestamptz) vergleichen zu koennen — der DB-Server
 *  laeuft in UTC, .lt("end_date", "YYYY-MM-DD") wuerde sonst gegen UTC-
 *  Mitternacht vergleichen und Auftraege 00:00-02:00 Zurich als "ueberfaellig"
 *  markieren, obwohl der neue Tag Zurich-lokal noch nicht angefangen hat. */
export function zurichOffsetForDate(dateIso: string): string {
  const [y, m, d] = dateIso.split("-").map(Number);
  const probeMs = Date.UTC(y, m - 1, d, 12); // Zurich-Mittag ist in beiden Sommer/Winter eindeutig
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ZRH_TZ,
    timeZoneName: "longOffset",
  }).formatToParts(new Date(probeMs));
  const raw = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  // Formen: "GMT+02:00", "GMT+2", "GMT+02"
  const m2 = raw.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m2) return "+01:00";
  const sign = m2[1];
  const hh = m2[2].padStart(2, "0");
  const mm = (m2[3] ?? "00").padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

/** Mitternacht (Anfang) des Zurich-Tages als timestamptz-ISO-String. */
export function zurichMidnightIso(dateIso: string): string {
  return `${dateIso}T00:00:00${zurichOffsetForDate(dateIso)}`;
}

/** Anzahl volle Tage zwischen zwei Zurich-Datums-Strings (b - a, integer, >= 0). */
export function daysBetween(a: string, b: string): number {
  const [ya, ma, da] = a.split("-").map(Number);
  const [yb, mb, db] = b.split("-").map(Number);
  const ms = Date.UTC(yb, mb - 1, db) - Date.UTC(ya, ma - 1, da);
  return Math.max(0, Math.round(ms / (24 * 3600 * 1000)));
}

export interface OverdueJobItem {
  id: string;
  job_number: number | null;
  title: string;
  end_date: string;
  days_overdue: number;
  customer_name: string | null;
  location_name: string | null;
}

export interface TeamMemberStatus {
  id: string;
  full_name: string;
  status: "eingestempelt" | "abwesend" | "offline";
  /** Nur bei status='eingestempelt': ISO clock_in fuer "seit HH:MM". */
  clock_in: string | null;
  /** Nur bei status='eingestempelt': worauf gestempelt ist —
   *  "INT-123 · Titel" | "PROJ-5 · Titel" | description | "Andere Arbeit". */
  context_label: string | null;
  /** Nur bei status='abwesend': time_off.type (ferien|krank|kompensation|frei|militaer). */
  abwesenheit_typ: string | null;
  /** Nur bei status='abwesend': letzter Abwesenheitstag (YYYY-MM-DD, Zurich). */
  abwesend_bis: string | null;
}

/** Bereich «Kennzahlen». null = fuer die Rolle nicht geladen (fehlendes Recht). */
export interface KennzahlenDaten {
  offene_auftraege: number | null;
  /** Termine der naechsten 7 Tage (rollend ab jetzt). */
  termine_7_tage: number | null;
}

/** Welche Zeilen von «Braucht Aufmerksamkeit» eine Rolle sehen darf — je
 *  Zeile das Recht der Zielseite (Mischa 2026-10-03: ein Team-Leiter darf
 *  keine Abwesenheits-Antraege sehen). Nicht erlaubte Zaehler werden gar
 *  nicht abgefragt; ihr Feld in AufmerksamkeitDaten ist null. */
export interface AufmerksamkeitRechte {
  /** auftraege:view — ueberfaellige Auftraege und Partner-Anfragen (/auftraege). */
  auftraege: boolean;
  /** ferien:approve — beantragte Abwesenheiten (HR-Tab «Anfragen», Genehmigen-API). */
  abwesenheit: boolean;
  /** abrechnung:view — nicht abgerechnete Auftraege und neue Belege (/abrechnung). */
  abrechnung: boolean;
  /** tickets:manage — offene Tickets (/tickets). */
  tickets: boolean;
}

/** Alle Zeilen (Admin, Buero-Bildschirm). */
export const ALLE_AUFMERKSAMKEIT_RECHTE: AufmerksamkeitRechte = {
  auftraege: true,
  abwesenheit: true,
  abrechnung: true,
  tickets: true,
};

/** Bereich «Braucht Aufmerksamkeit». null = Zeile fuer die Rolle nicht
 *  geladen (fehlendes Recht, siehe AufmerksamkeitRechte) — die Karte
 *  rendert nur gelieferte Zeilen. */
export interface AufmerksamkeitDaten {
  /** Ueberfaellige Auftraege: Gesamtzahl + die 5 aeltesten (aeltestes zuerst). */
  ueberfaellig: { anzahl: number; eintraege: OverdueJobItem[] } | null;
  partner_anfragen: number | null;
  /** Beantragte Abwesenheiten (time_off.status='beantragt'). */
  abwesenheits_antraege: number | null;
  /** Abgeschlossen, aber weder abgerechnet noch uebersprungen. */
  nicht_abgerechnet: number | null;
  neue_belege: number | null;
  offene_tickets: number | null;
}

/** Ein Eintrag im Bereich «Als Naechstes» (Auftrag, Partner-Anfrage oder
 *  datierter Entwurf der naechsten 7 Tage). */
export interface NaechsterAuftrag {
  id: string;
  typ: "auftrag" | "anfrage" | "entwurf";
  /** Auftrags- bzw. Entwurfsnummer (INT-… / ENT-…). */
  nummer: number | null;
  titel: string;
  /** Erster Tag YYYY-MM-DD (Zurich) — liegt er vor heute, laeuft der Auftrag. */
  start: string;
  /** Letzter Tag YYYY-MM-DD (Zurich). */
  ende: string;
  /** Beginn des ersten Termins am Starttag (ISO timestamptz); null ohne Termin. */
  erster_termin: string | null;
  /** Location-/Raumname, sonst externe Adresse. */
  ort: string | null;
  kunde: string | null;
}

/** Bereich «Als Naechstes». */
export interface NaechsteDaten {
  eintraege: NaechsterAuftrag[];
  /** Weitere Eintraege im 7-Tage-Fenster, die nicht mehr angezeigt werden. */
  weitere: number;
}

/** Payload des Buero-Bildschirms (/api/bildschirm/daten) — firmenweit. */
export interface AdminPayload {
  kpi: {
    geplante_termine_woche: number;
    nicht_abgerechnet: number;
  };
  zu_erledigen: {
    ferien_pending: number;
    neue_belege: number;
    offene_tickets: number;
    partner_anfragen: number;
  };
  team_status: {
    eingestempelt: number;
    /** Jede aktive interne Person mit Live-Status.
     *  Sortiert: eingestempelt (aelteste zuerst) → abwesend → offline. */
    members: TeamMemberStatus[];
  };
  overdue_jobs: {
    count: number;
  };
}

// Auftraege gelten als "ueberfaellig" wenn end_date vor Zurich-Mitternacht-heute
// liegt UND der Auftrag noch nicht abgeschlossen ist. Draft/Anfrage-Zustaende
// sind explizit ausgeklammert (existieren als Vor-Auftrag, kein Termindruck).
const NON_OVERDUE_STATUS = [
  "abgeschlossen",
  "storniert",
  "entwurf",
  "anfrage",
  "partner_anfrage",
  "partner_entwurf",
];

// ---------------------------------------------------------------------------
// Bereich «Kennzahlen»
// ---------------------------------------------------------------------------

export async function ladeKennzahlen(opts: { auftraege: boolean; termine: boolean }): Promise<KennzahlenDaten> {
  const admin = createAdminClient();
  // Rolling 7-Tage-Fenster ab JETZT (nicht Kalender-Woche Mo-So).
  // Kalender-Woche waere am Sonntag/spaeten Samstag leer/irrefuehrend
  // ("Termine diese Woche" zeigt am So 0). Rolling ist immer aussagend.
  const nowMs = Date.now();
  const [auftraegeRes, termineRes] = await Promise.all([
    opts.auftraege
      ? admin
          .from("jobs")
          .select("id", { count: "exact", head: true })
          .eq("status", "offen")
          // 3VL-Falle: .neq("is_deleted", true) filtert auch NULL-Zeilen weg
          // (Migration 039 Partial-Indexe / View 040/087 behandeln
          // is_deleted IS NOT TRUE als "nicht geloescht"). Deshalb explizit
          // .not(..., "is", true) — konsistent mit dem Rest der Codebasis.
          .not("is_deleted", "is", true)
      : null,
    // Parent-Job darf nicht soft-deleted sein, sonst zaehlt die Kennzahl
    // verwaiste Termine geloeschter Auftraege. Inner-Join + foreignTable-Filter.
    opts.termine
      ? admin
          .from("job_appointments")
          .select("id, job:jobs!inner(is_deleted)", { count: "exact", head: true })
          .gte("start_time", new Date(nowMs).toISOString())
          .lt("start_time", new Date(nowMs + 7 * 24 * 3600 * 1000).toISOString())
          .not("job.is_deleted", "is", true)
      : null,
  ]);
  // §7 (nie stiller Fehlschlag): Fehler hochwerfen statt Zaehler = 0.
  const err = auftraegeRes?.error ?? termineRes?.error;
  if (err) throw new Error(err.message);
  return {
    offene_auftraege: auftraegeRes ? auftraegeRes.count ?? 0 : null,
    termine_7_tage: termineRes ? termineRes.count ?? 0 : null,
  };
}

// ---------------------------------------------------------------------------
// Bereich «Braucht Aufmerksamkeit»
// ---------------------------------------------------------------------------

export async function ladeAufmerksamkeit(rechte: AufmerksamkeitRechte): Promise<AufmerksamkeitDaten> {
  const admin = createAdminClient();
  const todayZurichStartIso = zurichMidnightIso(todayLocalIso());

  // Nur die erlaubten Zaehler abfragen — null = Zeile fuer diese Rolle nicht
  // vorhanden (die Karte rendert sie dann gar nicht).
  const [
    abwesenheitsAntraegeRes,
    neueBelegeRes,
    offeneTicketsRes,
    partnerAnfragenRes,
    ueberfaelligCountRes,
    ueberfaelligListRes,
    nichtAbgerechnetRes,
  ] = await Promise.all([
    rechte.abwesenheit
      ? admin
          .from("time_off")
          .select("id", { count: "exact", head: true })
          .eq("status", "beantragt")
      : null,
    rechte.abrechnung
      ? admin
          .from("tickets")
          .select("id", { count: "exact", head: true })
          .eq("type", "beleg")
          .is("filed_at", null)
          .neq("status", "abgelehnt")
      : null,
    // Offene Tickets (non-Beleg): stempel_aenderung + material + IT — genau
    // das Set das /tickets zeigt (dort wird beleg per .neq('type','beleg')
    // ausgeblendet, weil Belege ihren eigenen Workflow auf /abrechnung haben
    // und schon via neue_belege gezaehlt sind — sonst Doppel-Zaehlung).
    // archived_at wird durch den Daily-Job (Migration 064) erst nach status !=
    // 'offen' gesetzt, ist hier defensiv gefiltert falls sich das mal aendert.
    rechte.tickets
      ? admin
          .from("tickets")
          .select("id", { count: "exact", head: true })
          .eq("status", "offen")
          .neq("type", "beleg")
          .is("archived_at", null)
      : null,
    // Eingegangene Partner-Anfragen (warten auf Annahme/Ablehnung).
    rechte.auftraege
      ? admin
          .from("jobs")
          .select("id", { count: "exact", head: true })
          .eq("status", "partner_anfrage")
          .not("is_deleted", "is", true)
      : null,
    // Ueberfaellig — alles was "aktiv" ist (nicht abgeschlossen/storniert/
    // entwurf/anfrage) und dessen end_date vor heute (Zurich) liegt.
    // CLAUDE.md §4: timestamptz vs YYYY-MM-DD — Zurich-Offset explizit.
    rechte.auftraege
      ? admin
          .from("jobs")
          .select("id", { count: "exact", head: true })
          .not("is_deleted", "is", true)
          .not("status", "in", `(${NON_OVERDUE_STATUS.join(",")})`)
          .lt("end_date", todayZurichStartIso)
      : null,
    // Ueberfaellig — die 5 aeltesten zur Anzeige, aeltestes end_date zuerst.
    rechte.auftraege
      ? admin
          .from("jobs")
          .select(`${JOB_FIELDS.core}, end_date, ${JOB_FIELDS.kunde}, ${JOB_FIELDS.location}`)
          .not("is_deleted", "is", true)
          .not("status", "in", `(${NON_OVERDUE_STATUS.join(",")})`)
          .lt("end_date", todayZurichStartIso)
          .order("end_date", { ascending: true })
          .limit(5)
      : null,
    rechte.abrechnung
      ? admin
          .from("jobs")
          .select("id", { count: "exact", head: true })
          .eq("status", "abgeschlossen")
          .is("invoiced_at", null)
          .is("invoice_skipped_at", null)
          .not("is_deleted", "is", true)
      : null,
  ]);

  // §7 (nie stiller Fehlschlag): fehlende Spalte, RLS-Denial oder Netz-Fehler
  // landen sonst als "alle Zaehler = 0" — das Dashboard wuerde faelschlich
  // «Alles erledigt» melden.
  const err =
    abwesenheitsAntraegeRes?.error ??
    neueBelegeRes?.error ??
    offeneTicketsRes?.error ??
    partnerAnfragenRes?.error ??
    ueberfaelligCountRes?.error ??
    ueberfaelligListRes?.error ??
    nichtAbgerechnetRes?.error;
  if (err) throw new Error(err.message);

  const today = todayLocalIso();
  type OverdueRow = {
    id: string;
    job_number: number | null;
    title: string;
    end_date: string;
    customer: { name: string } | null;
    location: { name: string } | null;
  };
  const eintraege: OverdueJobItem[] = ((ueberfaelligListRes?.data ?? []) as unknown as OverdueRow[]).map((r) => ({
    id: r.id,
    job_number: r.job_number,
    title: r.title,
    end_date: r.end_date,
    // Tage seit end_date im Zurich-Kalender — ein Auftrag der gestern faellig
    // war ist "seit 1 Tag" ueberfaellig, unabhaengig von der Uhrzeit.
    days_overdue: daysBetween(localDateIso(new Date(r.end_date)), today),
    customer_name: r.customer?.name ?? null,
    location_name: r.location?.name ?? null,
  }));

  return {
    ueberfaellig: ueberfaelligCountRes ? { anzahl: ueberfaelligCountRes.count ?? 0, eintraege } : null,
    partner_anfragen: partnerAnfragenRes ? partnerAnfragenRes.count ?? 0 : null,
    abwesenheits_antraege: abwesenheitsAntraegeRes ? abwesenheitsAntraegeRes.count ?? 0 : null,
    nicht_abgerechnet: nichtAbgerechnetRes ? nichtAbgerechnetRes.count ?? 0 : null,
    neue_belege: neueBelegeRes ? neueBelegeRes.count ?? 0 : null,
    offene_tickets: offeneTicketsRes ? offeneTicketsRes.count ?? 0 : null,
  };
}

// ---------------------------------------------------------------------------
// Bereich «Team»
// ---------------------------------------------------------------------------

/** IDs der Team-Mitglieder einer leitenden Person: aktive interne Profile
 *  (keine Portal-Rollen) mit profiles.team_lead_id = userId — die Person
 *  selbst nie (Selbst-Referenz). EINE Abgrenzung fuer «Mein Team» und die
 *  Team-Sicht von «Als Naechstes», damit beide dasselbe Team meinen. */
export async function teamMitgliederIds(admin: AdminClient, userId: string): Promise<string[]> {
  const { data, error } = await admin
    .from("profiles")
    .select("id")
    .eq("team_lead_id", userId)
    .eq("is_active", true)
    .not("role", "in", PORTAL_ROLLEN_IN);
  if (error) throw new Error(error.message);
  return Array.from(new Set((data ?? []).map((r) => r.id as string))).filter((id) => id !== userId);
}

/** Live-Status der Personen im Sichtbereich.
 *  `sicht: "alle"` — alle aktiven internen Mitarbeiter (Admin, Rollen mit
 *  stempelzeiten:see-all, Buero-Bildschirm).
 *  `sicht: "team"` — nur die Mitarbeiter mit profiles.team_lead_id = userId
 *  (Team-Leiter-Sicht «Mein Team»; die leitende Person selbst nicht). */
export async function ladeTeamStatus(
  opts: { sicht: "alle" } | { sicht: "team"; userId: string },
): Promise<TeamMemberStatus[]> {
  const admin = createAdminClient();
  const today = todayLocalIso();

  // null = firmenweit; Array = strikt auf diese IDs beschraenken.
  let ids: string[] | null = null;
  if (opts.sicht === "team") {
    ids = await teamMitgliederIds(admin, opts.userId);
    // Ohne Team-Mitglieder gibt es nichts zu laden — und .in([]) waere "IN ()".
    if (ids.length === 0) return [];
  }

  const [openEntriesRes, absencesRes, profilesRes] = await Promise.all([
    // Offene Stempel MIT Kontext (Job/Projekt) — die Zeile zeigt
    // "seit HH:MM · INT-123 · Titel".
    (() => {
      let q = admin
        .from("time_entries")
        .select("user_id, clock_in, description, job:jobs(job_number, title), project:projects(project_number, title)")
        .is("clock_out", null);
      if (ids) q = q.in("user_id", ids);
      return q;
    })(),
    // Heute abwesend, mit Typ und letztem Tag (spaetestes Ende zuerst — bei
    // ueberlappenden Eintraegen gewinnt das spaeteste «bis»).
    (() => {
      let q = admin
        .from("time_off")
        .select("user_id, type, end_date")
        .eq("status", "genehmigt")
        .lte("start_date", today)
        .gte("end_date", today)
        .order("end_date", { ascending: false });
      if (ids) q = q.in("user_id", ids);
      return q;
    })(),
    // Basis-Liste: aktive interne Mitarbeiter. Portal-Rollen raus (eigenes
    // Portal), Inaktive raus.
    (() => {
      let q = admin
        .from("profiles")
        .select("id, full_name")
        .eq("is_active", true)
        .not("role", "in", PORTAL_ROLLEN_IN)
        .order("full_name");
      if (ids) q = q.in("id", ids);
      return q;
    })(),
  ]);
  const err = openEntriesRes.error ?? absencesRes.error ?? profilesRes.error;
  if (err) throw new Error(err.message);

  type OpenEntryRow = {
    user_id: string;
    clock_in: string;
    description: string | null;
    job: { job_number: number | null; title: string } | { job_number: number | null; title: string }[] | null;
    project: { project_number: number | null; title: string } | { project_number: number | null; title: string }[] | null;
  };
  const one = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);
  const openByUser = new Map<string, OpenEntryRow>();
  for (const e of (openEntriesRes.data ?? []) as unknown as OpenEntryRow[]) {
    // Pro User max. ein offener Eintrag (Unique-Index) — Map deckt Alt-Daten ab.
    if (!openByUser.has(e.user_id)) openByUser.set(e.user_id, e);
  }
  const absenceByUser = new Map<string, { type: string; end_date: string }>();
  for (const a of (absencesRes.data ?? []) as { user_id: string; type: string; end_date: string }[]) {
    if (!absenceByUser.has(a.user_id)) absenceByUser.set(a.user_id, { type: a.type, end_date: a.end_date });
  }

  const members: TeamMemberStatus[] = ((profilesRes.data ?? []) as { id: string; full_name: string }[]).map((p) => {
    const open = openByUser.get(p.id);
    if (open) {
      const job = one(open.job);
      const project = one(open.project);
      const context_label = job
        ? `INT-${job.job_number ?? "…"} · ${job.title}`
        : project
        ? `PROJ-${project.project_number ?? "…"} · ${project.title}`
        : open.description || "Andere Arbeit";
      return {
        id: p.id, full_name: p.full_name, status: "eingestempelt" as const,
        clock_in: open.clock_in, context_label, abwesenheit_typ: null, abwesend_bis: null,
      };
    }
    const absence = absenceByUser.get(p.id);
    if (absence) {
      return {
        id: p.id, full_name: p.full_name, status: "abwesend" as const,
        clock_in: null, context_label: null, abwesenheit_typ: absence.type, abwesend_bis: absence.end_date,
      };
    }
    return {
      id: p.id, full_name: p.full_name, status: "offline" as const,
      clock_in: null, context_label: null, abwesenheit_typ: null, abwesend_bis: null,
    };
  });
  // Sortierung: eingestempelt (frueheste zuerst) → abwesend → offline; innerhalb alphabetisch.
  const statusRank = { eingestempelt: 0, abwesend: 1, offline: 2 } as const;
  members.sort((a, b) => {
    const r = statusRank[a.status] - statusRank[b.status];
    if (r !== 0) return r;
    if (a.status === "eingestempelt" && b.status === "eingestempelt") {
      return (a.clock_in ?? "").localeCompare(b.clock_in ?? "");
    }
    return a.full_name.localeCompare(b.full_name, "de-CH");
  });
  return members;
}

// ---------------------------------------------------------------------------
// Bereich «Als Naechstes»
// ---------------------------------------------------------------------------

/** Obergrenze der Kandidaten im 7-Tage-Fenster (wie AGENDA_LIMIT der Wand). */
const NAECHSTE_KANDIDATEN = 60;
/** Obergrenze der Termine je Termin-Abfrage (zweite Stufe und Team-Vorfilter):
 *  explizit statt PostgREST-Default. 60 Kandidaten x 10 Termine im Fenster —
 *  wird sie je erreicht, fehlt hoechstens bei den spaetesten Auftraegen die
 *  Uhrzeit (Termine sind nach start_time sortiert), nie ein Auftrag. */
const NAECHSTE_TERMINE = 600;

type NaechsteJobRow = {
  id: string;
  job_number: number | null;
  title: string;
  status: string;
  start_date: string | null;
  end_date: string | null;
  external_address: string | null;
  customer: { name: string } | null;
  location: { name: string; customer: { name: string } | null } | null;
  room: { name: string } | null;
};

type NaechsteDraftRow = {
  id: string;
  draft_number: number | null;
  title: string;
  customer_name: string | null;
  location_name: string | null;
  expected_start_date: string;
  expected_end_date: string | null;
};

/** Kommende Auftraege der naechsten 7 Tage — dieselbe Quelle wie die Agenda
 *  des Buero-Bildschirms (/api/bildschirm/daten): offene Auftraege und
 *  Partner-Anfragen, die noch laufen oder im Fenster beginnen, plus datierte
 *  Entwuerfe. Sortiert nach Starttag, dann Titel.
 *  `sicht: "team"` — nur Auftraege, in denen Team-Mitglieder
 *  (teamMitgliederIds, wie «Mein Team») oder die Person selbst im Fenster
 *  eingeteilt sind; serverseitig vorgefiltert: Termine der Personen im
 *  Fenster → job_ids → Auftraege. Entwuerfe haben keine Termine und fallen weg. */
export async function ladeNaechsteAuftraege(
  opts: { sicht: "alle" } | { sicht: "team"; userId: string },
  limit = 6,
): Promise<NaechsteDaten> {
  const admin = createAdminClient();
  const heute = todayLocalIso();
  const heuteStart = new Date(zurichMidnightIso(heute)).toISOString();
  // Fenster: heute + 6 Tage (exklusive Mitternacht des 8. Tages).
  const fensterEndeStart = new Date(zurichMidnightIso(plusTage(heute, 7))).toISOString();

  const jobsQuery = () =>
    admin
      .from("jobs")
      .select(
        "id, job_number, title, status, start_date, end_date, external_address, " +
          "customer:customers(name), location:locations(name, customer:customers(name)), room:rooms(name)",
      )
      .not("is_deleted", "is", true)
      .in("status", ["offen", "partner_anfrage"])
      .gte("end_date", heuteStart)
      .lt("start_date", fensterEndeStart)
      .order("start_date")
      .limit(NAECHSTE_KANDIDATEN);

  // Team-Sicht, erste Stufe: Termine des Teams (und der Person selbst), die
  // ins Fenster fallen — beginnen im Fenster oder haben vorher begonnen und
  // enden heute oder spaeter (gleiche Fenster-Logik wie die Wand fuer
  // «Heute»). Daraus die Auftrags-IDs, erst dann die Auftraege.
  let teamJobIds: string[] | null = null;
  if (opts.sicht === "team") {
    const personen = [opts.userId, ...(await teamMitgliederIds(admin, opts.userId))];
    const { data, error } = await admin
      .from("job_appointments")
      .select("job_id")
      .in("assigned_to", personen)
      .not("job_id", "is", null)
      .or(
        `and(start_time.gte.${heuteStart},start_time.lt.${fensterEndeStart}),and(start_time.lt.${heuteStart},end_time.gte.${heuteStart})`,
      )
      .order("start_time")
      .limit(NAECHSTE_TERMINE);
    if (error) throw new Error(error.message);
    teamJobIds = Array.from(new Set((data ?? []).map((r) => r.job_id as string))).slice(0, NAECHSTE_KANDIDATEN);
  }

  const [jobsRes, draftsRes] = await Promise.all([
    // Team ohne Termine im Fenster: nichts zu laden — .in([]) waere "IN ()".
    teamJobIds === null ? jobsQuery() : teamJobIds.length > 0 ? jobsQuery().in("id", teamJobIds) : null,
    opts.sicht === "alle"
      ? admin
          .from("job_drafts")
          .select("id, draft_number, title, customer_name, location_name, expected_start_date, expected_end_date")
          .not("is_deleted", "is", true)
          .is("converted_to_job_id", null)
          .gte("expected_start_date", heute)
          .lte("expected_start_date", plusTage(heute, 6))
          .order("expected_start_date")
          .limit(NAECHSTE_KANDIDATEN)
      : null,
  ]);
  const err = jobsRes?.error ?? draftsRes?.error;
  if (err) throw new Error(err.message);

  const jobs = ((jobsRes?.data ?? []) as unknown as NaechsteJobRow[]).filter((j) => j.start_date);

  // Zweite Stufe: Termine der Kandidaten im Fenster — fuer die Uhrzeit am
  // Starttag (nur Auftraege, die heute oder spaeter beginnen, zeigen sie;
  // deren Starttag liegt im Fenster). Explizites Limit, frueheste zuerst.
  const ersterTermin = new Map<string, string>();
  if (jobs.length > 0) {
    const { data: apRows, error: apErr } = await admin
      .from("job_appointments")
      .select("job_id, start_time")
      .in("job_id", jobs.map((j) => j.id))
      .gte("start_time", heuteStart)
      .lt("start_time", fensterEndeStart)
      .order("start_time")
      .limit(NAECHSTE_TERMINE);
    if (apErr) throw new Error(apErr.message);
    for (const a of (apRows ?? []) as { job_id: string; start_time: string }[]) {
      // Sortiert nach start_time: der erste Treffer je Auftrag ist der frueheste.
      if (!ersterTermin.has(a.job_id)) ersterTermin.set(a.job_id, a.start_time);
    }
  }

  const eintraege: NaechsterAuftrag[] = jobs.map((j) => {
    const start = localDateIso(new Date(j.start_date as string));
    const termin = ersterTermin.get(j.id) ?? null;
    return {
      id: j.id,
      typ: j.status === "partner_anfrage" ? "anfrage" : "auftrag",
      nummer: j.job_number,
      titel: j.title,
      start,
      ende: j.end_date ? localDateIso(new Date(j.end_date)) : start,
      // Nur ein Termin am Starttag gibt die Uhrzeit der Zeile vor.
      erster_termin: termin && localDateIso(new Date(termin)) === start ? termin : null,
      ort: j.location?.name ?? j.room?.name ?? j.external_address?.trim() ?? null,
      kunde: j.customer?.name ?? j.location?.customer?.name ?? null,
    };
  });
  for (const d of (draftsRes?.data ?? []) as unknown as NaechsteDraftRow[]) {
    eintraege.push({
      id: d.id,
      typ: "entwurf",
      nummer: d.draft_number,
      titel: d.title,
      start: d.expected_start_date,
      ende: d.expected_end_date ?? d.expected_start_date,
      erster_termin: null,
      ort: d.location_name,
      kunde: d.customer_name,
    });
  }
  eintraege.sort(
    (a, b) =>
      a.start.localeCompare(b.start) ||
      (a.erster_termin ?? "").localeCompare(b.erster_termin ?? "") ||
      a.titel.localeCompare(b.titel, "de-CH"),
  );

  return { eintraege: eintraege.slice(0, limit), weitere: Math.max(0, eintraege.length - limit) };
}

// ---------------------------------------------------------------------------
// Buero-Bildschirm: alles, firmenweit
// ---------------------------------------------------------------------------

export async function loadAdminData(): Promise<AdminPayload> {
  const [kennzahlen, aufmerksamkeit, members] = await Promise.all([
    ladeKennzahlen({ auftraege: false, termine: true }),
    ladeAufmerksamkeit(ALLE_AUFMERKSAMKEIT_RECHTE),
    ladeTeamStatus({ sicht: "alle" }),
  ]);
  // Alle Rechte gesetzt → kein Zaehler ist null; «?? 0» nur fuer den Typ.
  return {
    kpi: {
      geplante_termine_woche: kennzahlen.termine_7_tage ?? 0,
      nicht_abgerechnet: aufmerksamkeit.nicht_abgerechnet ?? 0,
    },
    zu_erledigen: {
      ferien_pending: aufmerksamkeit.abwesenheits_antraege ?? 0,
      neue_belege: aufmerksamkeit.neue_belege ?? 0,
      offene_tickets: aufmerksamkeit.offene_tickets ?? 0,
      partner_anfragen: aufmerksamkeit.partner_anfragen ?? 0,
    },
    team_status: {
      // Zaehler direkt aus der Personen-Liste — Liste und Zahl koennen nicht driften.
      eingestempelt: members.filter((m) => m.status === "eingestempelt").length,
      members,
    },
    overdue_jobs: {
      count: aufmerksamkeit.ueberfaellig?.anzahl ?? 0,
    },
  };
}
