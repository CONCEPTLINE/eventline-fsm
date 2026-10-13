"use client";

/**
 * Kalender am Handy (< md) = Monatsansicht wie im iPhone-Kalender, darunter
 * die Eintraege des gewaehlten Tags — fuer Mitarbeiter am klarsten.
 *
 *   Monatszeile 46 px   «Oktober 2026» (22 px) · «Heute» · ‹ › · «+»
 *                        «Heute» nur, wenn nicht schon heute gewaehlt ist;
 *                        «+» nur mit kalender:create (Admins immer) →
 *                        NeuerTerminModal als Bottom-Sheet, Datum = gewaehlter Tag
 *   Segment «Ich | Team» nur bei usePermissions().scope !== "self"
 *   Wochentage          M D M D F S S (Montag zuerst)
 *   Raster              4–6 Wochen à 50 px, nur Tageszahlen; Tage anderer
 *                        Monate leer, Wochenende grau, heute = roter Kreis,
 *                        gewaehlter Tag = dunkler Kreis (blendet weich ein).
 *                        Darunter ein Punkt (1 Eintrag) bzw. eine Pille aus
 *                        max. 4 Farbsegmenten (KATEGORIE_FARBE = Bedeutung der
 *                        Desktop-Legende; jede Abwesenheit ein gelbes Segment).
 *   Tagesliste          «Heute · Mittwoch, 14. Oktober» (rot) bzw. «Mittwoch,
 *                        14. Oktober»; Abwesenheiten zuerst (mit Namen, eigene
 *                        als «Du», sonst nach Name), dann Einsaetze nach
 *                        Startzeit; Farbbalken links = Farbe des Punkts. Blendet
 *                        beim Tages-/Monatswechsel kurz ein.
 *
 * Wischen wie iOS: eine Spur mit drei Monaten (Vormonat | aktuell |
 * Folgemonat) folgt dem Finger (Richtung nach RICHTUNG_PX festgelegt, nur
 * waagrecht — senkrecht scrollt die Seite normal). Loslassen ab 25 % Breite
 * oder schnell (> 0.4 px/ms) gleitet in den Nachbarmonat, sonst federt die
 * Spur zurueck; ‹ › und «Heute» nutzen dieselbe Gleitbewegung («Heute» aus
 * einem fernen Monat legt das Ziel kurz in den Nachbar-Platz). Die Hoehe
 * gleitet mit der Wochenanzahl mit, damit die Liste darunter nicht springt.
 * Waehrend einer Gleitbewegung werden Wischen, Pfeile, «Heute» und Tipps auf
 * Tage ignoriert (kein Verketten halber Zustaende). Monatswechsel erst nach
 * transitionend (Notfall-Timer), das Zuruecksetzen der Spur auf die Mitte im
 * useLayoutEffect des neuen Monats — gleiches Bild vor und nach dem Wechsel,
 * kein Flackern. prefers-reduced-motion: kein Mitziehen, sofort wechseln.
 *
 * Zustand in der URL (Reload-sicher): ?tag=YYYY-MM-DD (ohne = heute, der
 * Monat folgt dem Tag; Monatswechsel → heute im aktuellen Monat, sonst der
 * 1.) und ?sicht=team — per history.replaceState: Next gleicht
 * useSearchParams ab, ohne Server-Rundgang, darum reagiert ein Tipp sofort
 * und Tag/Monat wechseln auch ohne Netz.
 *
 * Daten: das Rasterfenster je Monat (Montag der ersten bis Sonntag der
 * letzten Rasterwoche, Zuercher Kalendertage). «Ich» = ladeMeineEinsaetze-
 * Gecacht (src/lib/einsaetze.ts; bisTag EXKLUSIV → Tag nach dem letzten
 * Rastertag) plus eigene genehmigte Abwesenheiten (bisTag inklusiv) ueber
 * ladeGecacht — ohne Netz sofort der letzte Online-Stand aus dem IndexedDB-
 * Cache, dann steht ueber der Tagesliste «Stand von HH:MM · offline»;
 * antwortet das Netz langsam, steht der Cache-Stand vorab da («· wird
 * aktualisiert…»). «Team» = dieselbe Abfrage ohne assigned_to-Filter plus
 * alle sichtbaren genehmigten Abwesenheiten aktiver Mitarbeiter (RLS
 * time_off_select_team begrenzt), nur online. Einsaetze, die vor dem Fenster
 * beginnen und hineinreichen, kommen ueber den Fenster-Filter (end_time >=
 * von) mit und markieren jeden Tag bis zu ihrem Ende.
 * Speicher im Arbeitsspeicher je Fenster `${meId}:${sicht}:${von}`: nach dem
 * Laden des aktuellen Monats werden beide Nachbarn im Hintergrund vorgeladen
 * (Punkte stehen beim Wischen schon da). Pro Schluessel gewinnt die zuletzt
 * GESTARTETE Abfrage; Realtime/online/Rueckkehr in die App macht die
 * Nachbarn ungueltig (Generation), sie werden nach dem Neuladen neu geholt.
 * Ein Monat ohne Stand im Speicher zeigt Skeleton-Zeilen, nie die Daten
 * eines anderen Monats.
 * meId IMMER aus usePermissions() — nie auth.getUser() («Ansicht als»).
 * Realtime: window-Events realtime:jobs / jobs:invalidate → neu laden,
 * coalesced 2.5 s (Muster src/lib/use-nav-counts.tsx).
 * Ladefehler ohne Daten (und ohne Cache) → LadeFehler «Erneut versuchen»
 * unter dem Raster (kein Endlos-Skeleton), Rueckkehr ins Netz (online-Event)
 * laedt automatisch nach.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ChevronLeft, ChevronRight, CloudOff, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { useStempel } from "@/lib/use-stempel";
import {
  type Einsatz,
  type EinsaetzeGecacht,
  type Gecacht,
  heuteTag,
  istDeadline,
  istLaufend,
  istVorbei,
  ladeGecacht,
  ladeMeineEinsaetzeGecacht,
  plusTage,
  rapportOffen,
  standText,
  STATUS_ERLEDIGT,
  zuerichMitternachtIso,
  zuerichTag,
} from "@/lib/einsaetze";
import { formatTime } from "@/lib/format";
import { ZRH_TZ } from "@/lib/swiss-time";
import { formatJobNumber } from "@/lib/nummern-format";
import { formatProjectNumber } from "@/lib/projekte-format";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { LadeFehler } from "@/components/mobile/lade-fehler";

/** Sofortiges Lade-Feedback (§7), solange der Modal-Chunk nachlaedt —
 *  gleich wie in kalender/page.tsx: Backdrop der Modal-Komponente + Spinner. */
function ModalChunkLoading() {
  return (
    <div className="fixed inset-0 z-[1100] bg-black/60 backdrop-blur flex items-center justify-center">
      <Spinner size={24} />
    </div>
  );
}

// «+» oeffnet denselben NeuerTerminModal wie der Desktop-Kalender — lazy
// (ssr:false) und erst beim Oeffnen gemountet, damit der Formular-Code nicht
// im Erst-Render-Chunk der haeufig besuchten Kalender-Route liegt.
const NeuerTerminModal = dynamic(
  () => import("@/components/kalender/neuer-termin-modal").then((m) => m.NeuerTerminModal),
  { ssr: false, loading: () => <ModalChunkLoading /> },
);

type Sicht = "ich" | "team";

/** Einsatz mit Person (nur in der Team-Sicht gefuellt). */
type ListenEinsatz = Einsatz & { person: string | null };

interface Abwesenheit {
  id: string;
  typ: "ferien" | "krank" | "kompensation" | "frei" | "militaer";
  start: string; // YYYY-MM-DD
  ende: string;  // YYYY-MM-DD, inklusiv
  /** Wer abwesend ist (Team-Sicht). In der Ich-Sicht null — dort ist es
   *  immer die eigene («Du»). Fehlt in alten Cache-Eintraegen. */
  person: string | null;
  /** profiles.id der abwesenden Person (eigene → «Du»). */
  userId: string | null;
}

const ABWESENHEIT_LABEL: Record<Abwesenheit["typ"], string> = {
  ferien: "Ferien",
  krank: "Krank",
  kompensation: "Kompensation",
  frei: "Frei",
  militaer: "Militär",
};

// ---------------------------------------------------------------------------
// Kategorien (Punkt im Raster ↔ Farbbalken der Zeile)
// ---------------------------------------------------------------------------

type Kategorie = "abwesenheit" | "auftrag" | "vermietung" | "projekt" | "termin";

/** Reihenfolge der Segmente unter der Tageszahl. */
const KATEGORIE_RANG: Record<Kategorie, number> = {
  abwesenheit: 0,
  auftrag: 1,
  vermietung: 2,
  projekt: 3,
  termin: 4,
};

/** Gleiche Bedeutung = gleiche Farbe wie die Legende des Desktop-Kalenders
 *  (kalender/page.tsx): Auftrag rot, Vermietung sky, Projekt emerald; dazu
 *  Termine ohne Auftrag grau und Abwesenheiten amber. */
const KATEGORIE_FARBE: Record<Kategorie, string> = {
  abwesenheit: "bg-amber-400",
  auftrag: "bg-red-500",
  vermietung: "bg-sky-400",
  projekt: "bg-emerald-500",
  termin: "bg-slate-400",
};

const MAX_SEGMENTE = 4;

function kategorie(e: Einsatz): Kategorie {
  if (e.art === "projekt") return "projekt";
  if (e.job) return e.job.vermietung ? "vermietung" : "auftrag";
  return "termin";
}

// ---------------------------------------------------------------------------
// Laden
// ---------------------------------------------------------------------------

type Verknuepft<T> = T | T[] | null;
function eins<T>(v: Verknuepft<T> | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

type TeamJobRow = {
  id: string; job_number: number | null; title: string; status: string; end_date: string | null; is_deleted: boolean | null;
  location_id: string | null; external_address: string | null; was_anfrage: boolean | null;
  location: Verknuepft<{ name: string }>; room: Verknuepft<{ name: string }>;
  customer: Verknuepft<{ name: string }>; service_reports: { status: string }[] | null;
};
type TeamAuftragRow = {
  id: string; title: string; start_time: string; end_time: string | null;
  zeit_modus: "fix" | "verschiebbar" | "deadline" | null; meeting_link: string | null;
  job_id: string | null; job: Verknuepft<TeamJobRow>; assignee: Verknuepft<{ full_name: string }>;
};
type TeamProjektRow = {
  id: string; title: string; start_time: string; end_time: string | null;
  project: Verknuepft<{ id: string; project_number: number | null; title: string }>;
  assignee: Verknuepft<{ full_name: string }>;
};
type TeamAbwesenheitRow = {
  id: string; user_id: string; type: Abwesenheit["typ"]; start_date: string; end_date: string;
  user: Verknuepft<{ full_name: string; is_active: boolean | null }>;
};

/** Team-Sicht: wie ladeMeineEinsaetze (bisTag exklusiv), aber ohne
 *  assigned_to-Filter und mit Person. RLS entscheidet, wessen Termine
 *  sichtbar sind. */
async function ladeTeamEinsaetze(
  supabase: SupabaseClient,
  vonTag: string,
  bisTag: string,
): Promise<ListenEinsatz[]> {
  const vonIso = zuerichMitternachtIso(vonTag);
  const bisIso = zuerichMitternachtIso(bisTag);
  const fenster = `end_time.gte.${vonIso},and(end_time.is.null,start_time.gte.${vonIso})`;
  const [auftraegeRes, projekteRes] = await Promise.all([
    supabase
      .from("job_appointments")
      .select(
        "id, title, start_time, end_time, zeit_modus, meeting_link, job_id, " +
          "assignee:profiles!assigned_to(full_name), " +
          "job:jobs(id, job_number, title, status, end_date, is_deleted, location_id, external_address, was_anfrage, " +
          "location:locations(name), room:rooms(name), customer:customers(name), service_reports(status))",
      )
      .lt("start_time", bisIso)
      .or(fenster)
      .order("start_time", { ascending: true }),
    supabase
      .from("project_appointments")
      .select(
        "id, title, start_time, end_time, " +
          "assignee:profiles!project_appointments_assigned_to_fkey(full_name), " +
          "project:projects(id, project_number, title)",
      )
      .lt("start_time", bisIso)
      .or(fenster)
      .order("start_time", { ascending: true }),
  ]);
  if (auftraegeRes.error) throw new Error(auftraegeRes.error.message);
  if (projekteRes.error) throw new Error(projekteRes.error.message);

  const aus: ListenEinsatz[] = [];
  for (const row of (auftraegeRes.data ?? []) as unknown as TeamAuftragRow[]) {
    const job = eins(row.job);
    if (row.job_id && !job) continue;
    if (job && (job.is_deleted === true || job.status === "storniert")) continue;
    const ort = eins(job?.location)?.name ?? eins(job?.room)?.name ?? null;
    aus.push({
      id: row.id,
      art: job ? "auftrag" : "termin",
      start: row.start_time,
      ende: row.end_time,
      zeit_modus: row.zeit_modus ?? null,
      titel: (row.title ?? "").trim() || job?.title || "Einsatz",
      meeting_link: row.meeting_link ?? null,
      person: eins(row.assignee)?.full_name ?? null,
      job: job
        ? {
            id: job.id,
            job_number: job.job_number,
            title: job.title,
            status: job.status,
            end_date: job.end_date,
            location_id: job.location_id,
            ort,
            adresse: ort ? null : (job.external_address?.trim() || null),
            kunde: eins(job.customer)?.name ?? null,
            rapport: !job.service_reports?.length
              ? "keiner"
              : job.service_reports.some((r) => r.status === "abgeschlossen") ? "abgeschlossen" : "entwurf",
            vermietung: job.was_anfrage === true,
          }
        : null,
      projekt: null,
    });
  }
  for (const row of (projekteRes.data ?? []) as unknown as TeamProjektRow[]) {
    const projekt = eins(row.project);
    aus.push({
      id: row.id,
      art: "projekt",
      start: row.start_time,
      ende: row.end_time,
      zeit_modus: null,
      titel: (row.title ?? "").trim() || projekt?.title || "Projekt-Termin",
      meeting_link: null,
      person: eins(row.assignee)?.full_name ?? null,
      job: null,
      projekt: projekt ? { id: projekt.id, project_number: projekt.project_number, title: projekt.title } : null,
    });
  }
  aus.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return aus;
}

/** Eigene genehmigte Abwesenheiten, die das Fenster [vonTag, bisTag] beruehren
 *  (bisTag INKLUSIV). `signal` bricht die Abfrage ab (Zeitlimit in ladeGecacht). */
async function ladeAbwesenheiten(
  supabase: SupabaseClient,
  meId: string,
  vonTag: string,
  bisTag: string,
  signal?: AbortSignal,
): Promise<Abwesenheit[]> {
  let query = supabase
    .from("time_off")
    .select("id, type, start_date, end_date")
    .eq("user_id", meId)
    .eq("status", "genehmigt")
    .gte("end_date", vonTag)
    .lte("start_date", bisTag)
    .order("start_date", { ascending: true });
  if (signal) query = query.abortSignal(signal);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data ?? []) as { id: string; type: Abwesenheit["typ"]; start_date: string; end_date: string }[])
    .map((r) => ({ id: r.id, typ: r.type, start: r.start_date, ende: r.end_date, person: null, userId: meId }));
}

/** Team-Sicht: alle sichtbaren genehmigten Abwesenheiten im Fenster [vonTag,
 *  bisTag] (bisTag INKLUSIV), mit Namen. RLS time_off_select_team (Migration
 *  257) begrenzt auf eigene, eigenes Team, scope all bzw. ferien:approve.
 *  !inner + is_active wie der Desktop-Kalender: Abwesenheiten deaktivierter
 *  Mitarbeiter gehoeren nicht mehr in den Kalender. */
async function ladeTeamAbwesenheiten(
  supabase: SupabaseClient,
  vonTag: string,
  bisTag: string,
): Promise<Abwesenheit[]> {
  const { data, error } = await supabase
    .from("time_off")
    .select("id, user_id, type, start_date, end_date, user:profiles!user_id!inner(full_name, is_active)")
    .eq("status", "genehmigt")
    .eq("user.is_active", true)
    .gte("end_date", vonTag)
    .lte("start_date", bisTag)
    .order("start_date", { ascending: true });
  if (error) throw new Error(error.message);
  return ((data ?? []) as unknown as TeamAbwesenheitRow[]).map((r) => ({
    id: r.id,
    typ: r.type,
    start: r.start_date,
    ende: r.end_date,
    person: eins(r.user)?.full_name ?? null,
    userId: r.user_id,
  }));
}

interface Geladen {
  schluessel: string;
  einsaetze: ListenEinsatz[];
  abwesenheiten: Abwesenheit[];
  /** Stand des Offline-Caches, wenn die Daten daraus kommen (sonst null). */
  stand: string | null;
  /** true = Cache-Stand vorab, die frische Antwort laeuft noch. */
  aktualisiert: boolean;
}

/** «Ich»-Stand aus beiden Teilen. Kommt ein Teil aus dem Cache, zeigt die
 *  Hinweiszeile den aelteren Stand (UTC-ISO sortiert als Text chronologisch). */
function ichStand(key: string, e: EinsaetzeGecacht, a: Gecacht<Abwesenheit[]>, aktualisiert: boolean): Geladen {
  const staende = [e, a].flatMap((t) => (t.ausCache && t.standAt ? [t.standAt] : [])).sort();
  return {
    schluessel: key,
    einsaetze: e.liste.map((x) => ({ ...x, person: null })),
    abwesenheiten: a.daten,
    stand: staende[0] ?? null,
    aktualisiert,
  };
}

/** Stand EINES Monats (Rasterfenster von `ym`) laden — fuer den aktuellen
 *  Monat und das Vorladen der Nachbarn. «Ich»: beides mit Offline-Cache,
 *  Schluessel = dasselbe Rasterfenster; antwortet das Netz langsam, geht der
 *  Cache-Stand an `vorab`, sobald beide Teile etwas haben — nie nach dem
 *  Ende dieses Aufrufs. «Team» nur online (fremde Termine werden nicht
 *  gecacht). */
async function ladeStand(
  supabase: SupabaseClient,
  meId: string,
  sicht: Sicht,
  ym: string,
  vorab?: (g: Geladen) => void,
): Promise<Geladen> {
  const { von, bis } = monatsRaster(ym);
  const key = `${meId}:${sicht}:${von}`;
  // Einsaetze: bisTag EXKLUSIV (start_time < Mitternacht von bisTag) → der
  // Tag nach dem letzten Rastertag, damit dieser selbst drin ist.
  // Abwesenheiten: bisTag inklusiv (start_date <= bis).
  const bisExklusiv = plusTage(bis, 1);
  if (sicht === "team") {
    const [einsaetze, abwesenheiten] = await Promise.all([
      ladeTeamEinsaetze(supabase, von, bisExklusiv),
      ladeTeamAbwesenheiten(supabase, von, bis),
    ]);
    return { schluessel: key, einsaetze, abwesenheiten, stand: null, aktualisiert: false };
  }
  let teilE: { g: EinsaetzeGecacht; vorab: boolean } | null = null;
  let teilA: { g: Gecacht<Abwesenheit[]>; vorab: boolean } | null = null;
  let fertig = false;
  const vorabZeigen = () => {
    if (!vorab || fertig || !teilE || !teilA || !(teilE.vorab || teilA.vorab)) return;
    vorab(ichStand(key, teilE.g, teilA.g, true));
  };
  const [e, a] = await Promise.all([
    ladeMeineEinsaetzeGecacht(supabase, meId, von, bisExklusiv, (g) => {
      teilE = { g, vorab: true };
      vorabZeigen();
    }).then((g) => {
      teilE = { g, vorab: false };
      vorabZeigen();
      return g;
    }),
    ladeGecacht(
      meId,
      `abwesenheiten:${von}:${bis}`,
      (signal) => ladeAbwesenheiten(supabase, meId, von, bis, signal),
      (g) => {
        teilA = { g, vorab: true };
        vorabZeigen();
      },
    ).then((g) => {
      teilA = { g, vorab: false };
      vorabZeigen();
      return g;
    }),
  ]).finally(() => { fertig = true; });
  return ichStand(key, e, a, false);
}

// ---------------------------------------------------------------------------
// Kalender-Rechnung (reine Kalenderdaten YYYY-MM-DD, zeitzonen-/DST-frei)
// ---------------------------------------------------------------------------

const WOCHENTAGE = ["M", "D", "M", "D", "F", "S", "S"] as const;
/** Hoehe einer Rasterwoche: Zelle 50 px + 1 px Trennlinie. */
const ZEILE_PX = 51;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function zerlege(tag: string): [number, number, number] {
  const [y, m, d] = tag.split("-").map(Number);
  return [y, m, d];
}

/** "YYYY-MM" eines Kalendertags. */
function ymVon(tag: string): string {
  const [y, m] = zerlege(tag);
  return `${y}-${pad2(m)}`;
}

/** "YYYY-MM" + n Monate. */
function monatPlus(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/** Tag, der nach einem Monatswechsel gewaehlt ist: heute im aktuellen Monat,
 *  sonst der 1. — der Nachbar-Platz zeigt ihn schon vorher markiert. */
function landeTag(ym: string, heute: string): string {
  return ymVon(heute) === ym ? heute : `${ym}-01`;
}

/** Gueltiger Kalendertag YYYY-MM-DD aus der URL, sonst null. */
function gueltigerTag(s: string | null): string | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = zerlege(s);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? s : null;
}

interface Raster {
  /** Montag der ersten Rasterwoche. */
  von: string;
  /** Sonntag der letzten Rasterwoche (inklusiv). */
  bis: string;
  /** 4–6 Wochen à 7 Tage; Tage anderer Monate = null (leere Zelle). */
  wochen: (string | null)[][];
}

/** Raster des Monats `ym` = "YYYY-MM". */
function monatsRaster(ym: string): Raster {
  const [y, m] = ym.split("-").map(Number);
  const versatz = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // Mo = 0 … So = 6
  const tage = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const anzahl = Math.ceil((versatz + tage) / 7);
  const von = plusTage(`${y}-${pad2(m)}-01`, -versatz);
  const wochen = Array.from({ length: anzahl }, (_, w) =>
    Array.from({ length: 7 }, (_, i) => {
      const n = w * 7 + i - versatz + 1;
      return n >= 1 && n <= tage ? `${y}-${pad2(m)}-${pad2(n)}` : null;
    }),
  );
  return { von, bis: plusTage(von, anzahl * 7 - 1), wochen };
}

const MONAT_FMT = new Intl.DateTimeFormat("de-CH", { timeZone: ZRH_TZ, month: "long" });
const TAG_LANG_FMT = new Intl.DateTimeFormat("de-CH", { timeZone: ZRH_TZ, weekday: "long", day: "numeric", month: "long" });

/** «Oktober» (Monatsmitte 12:00 UTC = in Zuerich sicher derselbe Monat). */
function monatsName(y: number, m: number): string {
  return MONAT_FMT.format(new Date(Date.UTC(y, m - 1, 15, 12)));
}

/** «Mittwoch, 14. Oktober» (Mittag UTC = DST-sicher). */
function tagLang(tag: string): string {
  const [y, m, d] = zerlege(tag);
  return TAG_LANG_FMT.format(new Date(Date.UTC(y, m - 1, d, 12)));
}

/** «17.10.» */
function kurzDatum(tag: string): string {
  const [, m, d] = tag.split("-");
  return `${d}.${m}.`;
}

/** Anzahl Kalendertage eines inklusiven Bereichs. */
function tageAnzahl(start: string, ende: string): number {
  const [sy, sm, sd] = zerlege(start);
  const [ey, em, ed] = zerlege(ende);
  return Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86_400_000) + 1;
}

// ---------------------------------------------------------------------------
// Eintraege auf die Tage verteilen
// ---------------------------------------------------------------------------

interface TagEintraege {
  einsaetze: ListenEinsatz[];
  abwesenheiten: Abwesenheit[];
}

/** Letzter Zuercher Kalendertag eines Einsatzes: Deadline und Termine ohne
 *  Ende nur am Starttag; endet er genau um Mitternacht, zaehlt der Folgetag
 *  nicht mehr mit (18:00–00:00 ist ein Tag). */
function letzterTag(e: Einsatz, start: string): string {
  if (e.zeit_modus === "deadline" || !e.ende) return start;
  const ende = zuerichTag(new Date(Date.parse(e.ende) - 1).toISOString());
  return ende < start ? start : ende;
}

/** Jeder Tag im Fenster [von, bis], den ein Eintrag beruehrt — mehrtaegige
 *  Einsaetze und Abwesenheiten markieren jeden ihrer Tage. Reihenfolge bleibt
 *  die der Loader (Einsaetze nach Start, Abwesenheiten nach Beginn). */
function verteile(einsaetze: ListenEinsatz[], abwesenheiten: Abwesenheit[], von: string, bis: string): Map<string, TagEintraege> {
  const map = new Map<string, TagEintraege>();
  const markiere = (start: string, ende: string, f: (t: TagEintraege) => void) => {
    for (let tag = start < von ? von : start; tag <= ende && tag <= bis; tag = plusTage(tag, 1)) {
      let t = map.get(tag);
      if (!t) {
        t = { einsaetze: [], abwesenheiten: [] };
        map.set(tag, t);
      }
      f(t);
    }
  };
  for (const a of abwesenheiten) markiere(a.start, a.ende, (t) => t.abwesenheiten.push(a));
  for (const e of einsaetze) {
    const start = zuerichTag(e.start);
    markiere(start, letzterTag(e, start), (t) => t.einsaetze.push(e));
  }
  return map;
}

/** Segmente unter der Tageszahl: ein Eintrag = ein Segment (jede Abwesenheit
 *  ein gelbes), nach Kategorie sortiert, hoechstens MAX_SEGMENTE. */
function segmente(t: TagEintraege | undefined): Kategorie[] {
  if (!t) return [];
  const k: Kategorie[] = [
    ...t.abwesenheiten.map((): Kategorie => "abwesenheit"),
    ...t.einsaetze.map(kategorie),
  ];
  return k.sort((a, b) => KATEGORIE_RANG[a] - KATEGORIE_RANG[b]).slice(0, MAX_SEGMENTE);
}

// ---------------------------------------------------------------------------
// Komponente
// ---------------------------------------------------------------------------

interface FehlerStand {
  schluessel: string;
  text: string;
}

/** «Heute» aus einem fernen Monat: Zielmonat liegt waehrend der Gleit-
 *  bewegung im Nachbar-Platz der Richtung. Gilt nur, solange der Monat
 *  `ab` angezeigt wird. */
interface Sprung {
  ab: string;
  ym: string;
  richtung: 1 | -1;
}

/** So viele Monatsstaende haelt der Arbeitsspeicher (aelteste fallen raus). */
const MAX_SPEICHER = 12;
/** Bewegung (px), nach der die Wischrichtung feststeht. */
const RICHTUNG_PX = 8;
/** Loslassen ab diesem Anteil der Breite → Monatswechsel. */
const SCHWELLE_ANTEIL = 0.25;
/** … oder ab dieser Geschwindigkeit (px/ms) in Zugrichtung. */
const SCHWELLE_TEMPO = 0.4;
/** Geschwindigkeit aus den Bewegungen der letzten … ms. */
const TEMPO_FENSTER_MS = 100;
/** So lange nach einem Wischer wird ein Tipp auf eine Tageszelle ignoriert
 *  (Sicherung, falls der Browser trotz preventDefault einen click schickt). */
const WISCH_SPERRE_MS = 500;
const GLEIT_MS = 280;
const GLEIT_KURVE = "cubic-bezier(.2,.8,.2,1)";
const MITTE = "translate3d(-100%,0,0)";

/** prefers-reduced-motion: dann wird nicht gezogen/geglitten, sondern sofort gewechselt. */
function ruhig(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface Zug {
  x0: number;
  y0: number;
  /** offen = Richtung noch unklar, wisch = waagrecht (gehoert uns), aus = senkrecht (Seite scrollt). */
  modus: "offen" | "wisch" | "aus";
  breite: number;
  proben: { x: number; t: number }[];
}

export function KalenderMonat() {
  const supabase = createClient();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { meId, scope, ready, can } = usePermissions();
  const { active } = useStempel();

  const teamErlaubt = scope !== "self";
  const sicht: Sicht = teamErlaubt && searchParams.get("sicht") === "team" ? "team" : "ich";
  const darfErstellen = can("kalender:create");

  const heute = heuteTag();
  const gewaehlt = gueltigerTag(searchParams.get("tag")) ?? heute;
  const [jahr, monat] = zerlege(gewaehlt);
  // Monat als Template-String: fuer den React-Compiler erkennbar primitiv,
  // darum die stabile Abhaengigkeit von load/tagesEintraege (Tag-Wechsel im
  // selben Monat laedt nicht neu). Raster (42 Zellen) je Render.
  const monatsKey = `${jahr}-${pad2(monat)}`;
  const raster = monatsRaster(monatsKey);
  const { von } = raster;

  const [sprungZiel, setSprungZiel] = useState<Sprung | null>(null);
  const sprung = sprungZiel && sprungZiel.ab === monatsKey ? sprungZiel : null;
  const links = sprung?.richtung === -1 ? sprung.ym : monatPlus(monatsKey, -1);
  const rechts = sprung?.richtung === 1 ? sprung.ym : monatPlus(monatsKey, 1);
  const wochenLinks = monatsRaster(links).wochen.length;
  const wochenRechts = monatsRaster(rechts).wochen.length;

  // Monatsstaende je Fenster-Schluessel (User + Sicht + Rasterbeginn). Ein
  // Monat ohne Eintrag zeigt Skeleton-Zeilen statt kurz falscher Daten. Der
  // Ladefehler haengt am Schluessel des aktuellen Monats.
  const schluessel = `${meId ?? ""}:${sicht}:${von}`;
  const [speicher, setSpeicher] = useState<ReadonlyMap<string, Geladen>>(() => new Map());
  const [fehler, setFehler] = useState<FehlerStand | null>(null);
  const [neuLaedt, setNeuLaedt] = useState(false);
  /** Offenes «Neuer Termin»-Formular mit seinem Vorbelegungs-Datum (null = zu). */
  const [neuDatum, setNeuDatum] = useState<Date | null>(null);
  const daten = speicher.get(schluessel) ?? null;
  // Fehlerzustand nur, solange keine Daten dieses Monats stehen — scheitert
  // ein spaeteres Neuladen, bleibt die Liste sichtbar und der Toast reicht.
  const fehlerAktiv = !daten && fehler?.schluessel === schluessel ? fehler : null;

  // Sequenz-Schutz. aktuellRef/ladeNr: Fehler, Toast und Vorab-Stand nur fuer
  // den juengsten Aufruf zum aktuellen Schluessel. geschrieben: pro Schluessel
  // gewinnt die zuletzt GESTARTETE Abfrage (anfrageNr) — eine verspaetete
  // Antwort (anderer Monat, Vorladen, Realtime-Nachlauf) ueberschreibt nie
  // einen neueren Stand. generation: Realtime macht laufendes Vorladen
  // ungueltig. Refs im Effekt bzw. in Callbacks setzen, nie beim Rendern.
  const aktuellRef = useRef(schluessel);
  const ladeNr = useRef(0);
  const anfrageNr = useRef(0);
  const geschrieben = useRef(new Map<string, number>());
  const generation = useRef(0);
  const unterwegs = useRef(new Set<string>());
  const speicherRef = useRef(speicher);
  useEffect(() => {
    aktuellRef.current = schluessel;
  }, [schluessel]);
  useEffect(() => {
    speicherRef.current = speicher;
  }, [speicher]);

  /** Stand ablegen. Vorab-Staende (Cache) nie ueber einem frischen Stand und
   *  nie nach dem Endstand derselben oder einer neueren Abfrage. */
  const merke = useCallback((g: Geladen, nr: number, vorab: boolean) => {
    const letzte = geschrieben.current.get(g.schluessel) ?? 0;
    if (vorab ? letzte >= nr : letzte > nr) return;
    if (!vorab) geschrieben.current.set(g.schluessel, nr);
    setSpeicher((m) => {
      const alt = m.get(g.schluessel);
      if (vorab && alt && alt.stand === null) return m;
      const neu = new Map(m);
      neu.delete(g.schluessel);
      neu.set(g.schluessel, g);
      for (const k of neu.keys()) {
        if (neu.size <= MAX_SPEICHER) break;
        neu.delete(k);
      }
      return neu;
    });
  }, []);

  /** Beide Nachbarmonate von `ym` im Hintergrund holen, falls kein frischer,
   *  gueltiger Stand im Speicher liegt. Fehler still — die zeigt erst der
   *  Monat selbst, wenn man hinwechselt. */
  const vorladen = useCallback((ym: string) => {
    if (!meId) return;
    const gen = generation.current;
    for (const n of [monatPlus(ym, -1), monatPlus(ym, 1)]) {
      const key = `${meId}:${sicht}:${monatsRaster(n).von}`;
      const vorhanden = speicherRef.current.get(key);
      if (vorhanden && vorhanden.stand === null && geschrieben.current.has(key)) continue;
      const marke = `${gen}:${key}`;
      if (unterwegs.current.has(marke)) continue;
      unterwegs.current.add(marke);
      const nr = ++anfrageNr.current;
      ladeStand(supabase, meId, sicht, n)
        .then((g) => { if (gen === generation.current) merke(g, nr, false); })
        .catch(() => { /* Vorladen ist Beschleunigung, kein Muss */ })
        .finally(() => { unterwegs.current.delete(marke); });
    }
  }, [supabase, meId, sicht, merke]);

  const load = useCallback(async () => {
    if (!meId) return;
    const key = `${meId}:${sicht}:${monatsRaster(monatsKey).von}`;
    const nr = ++anfrageNr.current;
    ladeNr.current = nr;
    const istAktuell = () => aktuellRef.current === key && ladeNr.current === nr;
    try {
      const neu = await ladeStand(supabase, meId, sicht, monatsKey, (g) => {
        if (istAktuell()) merke(g, nr, true);
      });
      // Auch wenn inzwischen ein anderer Monat gewaehlt ist: der Stand bleibt
      // im Speicher (Zurueckwischen zeigt ihn sofort).
      merke(neu, nr, false);
      if (!istAktuell()) return;
      setFehler(null);
      vorladen(monatsKey);
    } catch (e) {
      if (!istAktuell()) return;
      const text = e instanceof Error ? e.message : "Netzwerk-Fehler";
      toast.error(`Einsätze konnten nicht geladen werden: ${text}`);
      // Ein Server-Fehler verschwindet nie hinter dem Cache-Stand: der weicht
      // dem Fehler-Block. Ein frischer Stand bleibt stehen (Toast reicht).
      setSpeicher((m) => {
        const alt = m.get(key);
        if (!alt || alt.stand === null) return m;
        const neu = new Map(m);
        neu.delete(key);
        return neu;
      });
      setFehler({ schluessel: key, text });
    }
  }, [supabase, meId, sicht, monatsKey, merke, vorladen]);

  async function erneutLaden() {
    setNeuLaedt(true);
    await load();
    setNeuLaedt(false);
  }

  useEffect(() => {
    // Realtime coalesced (leading + trailing, 2.5 s): jobs:invalidate feuert
    // bei jeder jobs-Aenderung irgendeines Users. Erstladen (auch nach jedem
    // Monats-/Sichtwechsel, `load` haengt daran) laeuft durch dieselbe
    // Schleuse, als Callback (nicht synchron im Effekt).
    const WINDOW_MS = 2500;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let trailingPending = false;
    const openWindow = () => {
      timer = setTimeout(() => {
        timer = null;
        if (trailingPending) {
          trailingPending = false;
          void load();
          openWindow();
        }
      }, WINDOW_MS);
    };
    const coalescedLoad = () => {
      if (timer) {
        trailingPending = true;
        return;
      }
      void load();
      openWindow();
    };
    // Aenderung von aussen: die Nachbarstaende gelten als veraltet (laufendes
    // Vorladen verfaellt, nach dem Neuladen des aktuellen Monats werden sie
    // neu geholt). Angezeigt bleiben sie bis dahin.
    const invalidieren = () => {
      generation.current += 1;
      for (const k of Array.from(geschrieben.current.keys())) {
        if (k !== aktuellRef.current) geschrieben.current.delete(k);
      }
    };
    const handler = () => {
      invalidieren();
      coalescedLoad();
    };
    const visibilityHandler = () => {
      if (document.visibilityState !== "visible") return;
      invalidieren();
      coalescedLoad();
    };
    const first = setTimeout(coalescedLoad, 0);
    window.addEventListener("realtime:jobs", handler);
    window.addEventListener("jobs:invalidate", handler);
    // Zurueck im Netz → automatisch neu laden (nach Ladefehler offline).
    window.addEventListener("online", handler);
    document.addEventListener("visibilitychange", visibilityHandler);
    return () => {
      clearTimeout(first);
      if (timer) clearTimeout(timer);
      window.removeEventListener("realtime:jobs", handler);
      window.removeEventListener("jobs:invalidate", handler);
      window.removeEventListener("online", handler);
      document.removeEventListener("visibilitychange", visibilityHandler);
    };
  }, [load]);

  /** URL-Zustand schreiben. history.replaceState mit `null` als state: Next
   *  kopiert seinen internen Zustand dazu und gleicht useSearchParams ab
   *  (Next-Doku «Native History API») — ohne Server-Rundgang, also sofort
   *  und auch ohne Netz. Gelesen wird window.location, nicht der evtl. noch
   *  alte searchParams-Stand. */
  function schreibeUrl(aendern: (p: URLSearchParams) => void) {
    const params = new URLSearchParams(window.location.search);
    aendern(params);
    const q = params.toString();
    window.history.replaceState(null, "", q ? `${pathname}?${q}` : pathname);
  }

  function setzeSicht(neu: Sicht) {
    schreibeUrl((p) => {
      if (neu === "team") p.set("sicht", "team");
      else p.delete("sicht");
    });
  }

  /** Tag waehlen — heute ohne Parameter (Standard der Seite). Ein alter
   *  Sprung verfaellt (ausser beim Abschluss des Sprungs selbst: dann zeigt
   *  der Nachbar-Platz bis zum Monatswechsel noch das Ziel). */
  function setzeTag(neu: string, sprungBehalten = false) {
    if (!sprungBehalten) setSprungZiel(null);
    schreibeUrl((p) => {
      if (neu === heuteTag()) p.delete("tag");
      else p.set("tag", neu);
    });
  }

  // -------------------------------------------------------------------------
  // Gleitbewegung (Wischen, Pfeile, «Heute»)
  // -------------------------------------------------------------------------

  const boxRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  /** true, solange eine Gleitbewegung laeuft — Eingaben werden ignoriert. */
  const animRef = useRef(false);
  const animNr = useRef(0);
  /** Abschluss der laufenden Gleitbewegung (transitionend oder Notfall-Timer). */
  const abschlussRef = useRef<(() => void) | null>(null);
  const zugRef = useRef<Zug | null>(null);
  /** event.timeStamp des letzten Wischers (gleiche Uhr wie der click danach). */
  const wischZeit = useRef(Number.NEGATIVE_INFINITY);

  // Neuer Monat committed: Spur ohne Uebergang zurueck auf die Mitte — vor dem
  // Malen, darum zeigt der Bildschirm vorher (Spur am Rand = Zielmonat) und
  // nachher (Mitte = derselbe Monat) dasselbe Bild. Laufende Bewegung endet.
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (track) {
      track.style.transition = "none";
      track.style.transform = MITTE;
    }
    abschlussRef.current = null;
    animRef.current = false;
  }, [monatsKey]);

  // Seite verlassen mitten im Gleiten: kein spaeter Abschluss/Notfall-Timer
  // darf danach noch die URL (?tag=) der neuen Seite umschreiben.
  const lebtRef = useRef(false);
  useEffect(() => {
    lebtRef.current = true;
    return () => {
      lebtRef.current = false;
      abschlussRef.current = null;
      animNr.current += 1;
    };
  }, []);

  /**
   * Spur gleiten lassen: richtung 1 = Folgemonat, -1 = Vormonat, 0 = zurueck
   * zur Mitte. Mit zielTag wird nach dem Gleiten dieser Tag gewaehlt (der
   * Nachbar-Platz der Richtung zeigt dessen Monat bereits). Ohne Bewegung
   * (reduced motion, kein DOM) sofort.
   */
  function gleite(richtung: -1 | 0 | 1, zielTag: string | null, zielWochen: number, sprungBehalten = false) {
    if (!lebtRef.current) return;
    const track = trackRef.current;
    const box = boxRef.current;
    if (!track || !box || ruhig()) {
      if (track) {
        track.style.transition = "none";
        track.style.transform = MITTE;
      }
      if (box && !zielTag) box.style.height = `${zielWochen * ZEILE_PX}px`;
      animRef.current = false;
      if (zielTag) setzeTag(zielTag, sprungBehalten);
      return;
    }
    const nr = ++animNr.current;
    animRef.current = true;
    // Startlage festschreiben (z. B. direkt nach dem Fuellen des Nachbar-
    // Platzes), sonst springt der Browser ohne Uebergang ans Ziel.
    void track.offsetWidth;
    track.style.transition = `transform ${GLEIT_MS}ms ${GLEIT_KURVE}`;
    track.style.transform = `translate3d(${-100 - richtung * 100}%,0,0)`;
    box.style.height = `${zielWochen * ZEILE_PX}px`;
    const fertig = () => {
      if (abschlussRef.current !== fertig || !lebtRef.current) return;
      abschlussRef.current = null;
      clearTimeout(notfall);
      if (!zielTag) {
        animRef.current = false;
        return;
      }
      setzeTag(zielTag, sprungBehalten);
      // Notbremse: kommt der Monatswechsel nicht an, nach 1 s entsperren.
      setTimeout(() => {
        if (animNr.current !== nr || !animRef.current) return;
        track.style.transition = "none";
        track.style.transform = MITTE;
        animRef.current = false;
        setSprungZiel(null);
      }, 1000);
    };
    abschlussRef.current = fertig;
    const notfall = setTimeout(fertig, GLEIT_MS + 100);
  }

  function blaettern(richtung: 1 | -1) {
    if (animRef.current) return;
    const ziel = monatPlus(monatsKey, richtung);
    gleite(richtung, landeTag(ziel, heuteTag()), monatsRaster(ziel).wochen.length);
  }

  function zuHeute() {
    if (animRef.current) return;
    const jetzt = heuteTag();
    const ziel = ymVon(jetzt);
    if (ziel === monatsKey) {
      setzeTag(jetzt);
      return;
    }
    const richtung: 1 | -1 = ziel > monatsKey ? 1 : -1;
    const zielWochen = monatsRaster(ziel).wochen.length;
    if (ziel === monatPlus(monatsKey, richtung) || ruhig()) {
      gleite(richtung, jetzt, zielWochen);
      return;
    }
    // Ferner Monat: Ziel erst in den Nachbar-Platz legen (Render), dann gleiten.
    animRef.current = true;
    setSprungZiel({ ab: monatsKey, ym: ziel, richtung });
    requestAnimationFrame(() => requestAnimationFrame(() => gleite(richtung, jetzt, zielWochen, true)));
  }

  function zurueckfedern() {
    gleite(0, null, raster.wochen.length);
  }

  function beiTouchStart(e: React.TouchEvent) {
    const t = e.touches[0];
    if (animRef.current || e.touches.length !== 1 || !t) {
      // Zweiter Finger waehrend des Wischens: zurueckfedern.
      if (zugRef.current?.modus === "wisch") zurueckfedern();
      zugRef.current = null;
      return;
    }
    zugRef.current = {
      x0: t.clientX,
      y0: t.clientY,
      modus: "offen",
      breite: boxRef.current?.clientWidth || 1,
      proben: [{ x: t.clientX, t: e.timeStamp }],
    };
  }

  function beiTouchMove(e: React.TouchEvent) {
    const z = zugRef.current;
    const t = e.touches[0];
    // Laeuft schon eine Gleitbewegung (z. B. «Heute» mit zweitem Finger),
    // gehoert die Spur ihr — der Zug zieht nicht mehr.
    if (!z || z.modus === "aus" || !t || animRef.current) return;
    const dx = t.clientX - z.x0;
    const dy = t.clientY - z.y0;
    if (z.modus === "offen") {
      if (Math.abs(dx) < RICHTUNG_PX && Math.abs(dy) < RICHTUNG_PX) return;
      z.modus = Math.abs(dx) > Math.abs(dy) ? "wisch" : "aus";
      if (z.modus === "aus") return;
    }
    z.proben.push({ x: t.clientX, t: e.timeStamp });
    if (z.proben.length > 8) z.proben.shift();
    if (ruhig()) return;
    const track = trackRef.current;
    const box = boxRef.current;
    if (track) {
      track.style.transition = "none";
      track.style.transform = `translate3d(calc(-100% + ${dx}px),0,0)`;
    }
    // Hoehe = groesserer der beiden sichtbaren Monate, sonst schneidet der
    // Rahmen die 6. Woche des Nachbarn ab.
    if (box) box.style.height = `${Math.max(raster.wochen.length, dx < 0 ? wochenRechts : wochenLinks) * ZEILE_PX}px`;
  }

  function beiTouchEnd(e: React.TouchEvent) {
    const z = zugRef.current;
    zugRef.current = null;
    if (!z || z.modus !== "wisch") return;
    // Kein click auf die Tageszelle unter dem Finger hinterher.
    if (e.cancelable) e.preventDefault();
    wischZeit.current = e.timeStamp;
    if (animRef.current) return;
    const letzte = z.proben[z.proben.length - 1];
    const x = e.changedTouches[0]?.clientX ?? letzte.x;
    const dx = x - z.x0;
    const basis = z.proben.find((p) => e.timeStamp - p.t <= TEMPO_FENSTER_MS) ?? letzte;
    const tempo = (x - basis.x) / Math.max(1, e.timeStamp - basis.t);
    const weit = Math.abs(dx) > z.breite * SCHWELLE_ANTEIL;
    const schnell = Math.abs(tempo) > SCHWELLE_TEMPO;
    // Schneller Rueckschwung gegen die Zugrichtung = Abbruch (wie iOS).
    const mitZug = Math.sign(tempo) === Math.sign(dx);
    if (dx !== 0 && (schnell ? mitZug : weit)) {
      const richtung: 1 | -1 = dx < 0 ? 1 : -1;
      const ziel = richtung === 1 ? rechts : links;
      gleite(richtung, landeTag(ziel, heuteTag()), richtung === 1 ? wochenRechts : wochenLinks);
    } else {
      zurueckfedern();
    }
  }

  function beiTouchCancel() {
    const z = zugRef.current;
    zugRef.current = null;
    if (z?.modus === "wisch") zurueckfedern();
  }

  function beiTransitionEnd(e: React.TransitionEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget && e.propertyName === "transform") abschlussRef.current?.();
  }

  function beiTag(tag: string, e: React.MouseEvent) {
    if (animRef.current || e.timeStamp - wischZeit.current < WISCH_SPERRE_MS) return;
    setzeTag(tag);
  }

  // -------------------------------------------------------------------------

  const tagesEintraege = useMemo(() => {
    if (!daten) return null;
    const r = monatsRaster(monatsKey);
    return verteile(daten.einsaetze, daten.abwesenheiten, r.von, r.bis);
  }, [daten, monatsKey]);
  const amTag = tagesEintraege?.get(gewaehlt);
  const istDu = (a: Abwesenheit) => sicht === "ich" || (!!meId && a.userId === meId);
  // Abwesenheiten: eigene zuerst, dann nach Name.
  const abwesenheitenSortiert = amTag
    ? [...amTag.abwesenheiten].sort((a, b) =>
        Number(istDu(b)) - Number(istDu(a)) || (a.person ?? "").localeCompare(b.person ?? "", "de-CH"))
    : [];

  /** «+»: Formular mit dem gewaehlten Tag oeffnen. Lokales Date aus
   *  YYYY-MM-DD (nicht new Date("YYYY-MM-DD") = UTC-Mitternacht) — der Modal
   *  liest es lokal zurueck (toLocalDateString), also genau dieser Tag in
   *  jeder Geraete-Zeitzone. Im State statt je Render neu gebaut: eine neue
   *  Date-Instanz setzte das Datum im offenen Formular bei jedem Neuladen
   *  zurueck (Effekt an initialDate). */
  function neuerTermin() {
    const [y, m, d] = zerlege(gewaehlt);
    setNeuDatum(new Date(y, m - 1, d));
  }

  const laedt = !ready || (!daten && !fehlerAktiv);
  const gewaehltIstHeute = gewaehlt === heute;
  const knopf = "inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center text-red-600 active:opacity-60 dark:text-red-400";

  return (
    <div className="page-enter -mx-[10px]">
      {/* Monatszeile */}
      <div className="flex h-[46px] items-center gap-0.5 pl-[10px] pr-[4px]">
        <h2 className="min-w-0 flex-1 truncate text-[22px] font-bold leading-[28px] tracking-tight">
          {monatsName(jahr, monat)} <span className="font-normal text-muted-foreground">{jahr}</span>
        </h2>
        {!gewaehltIstHeute && (
          <button
            type="button"
            onClick={zuHeute}
            className="inline-flex h-[34px] shrink-0 items-center px-2 text-[15px] font-medium text-red-600 active:opacity-60 dark:text-red-400"
          >
            Heute
          </button>
        )}
        <button type="button" aria-label="Vormonat" onClick={() => blaettern(-1)} className={knopf}>
          <ChevronLeft className="h-[20px] w-[20px]" />
        </button>
        <button type="button" aria-label="Nächster Monat" onClick={() => blaettern(1)} className={knopf}>
          <ChevronRight className="h-[20px] w-[20px]" />
        </button>
        {darfErstellen && (
          <button
            type="button"
            aria-label="Neuer Termin"
            data-tooltip="Neuer Termin"
            data-tooltip-align="end"
            onClick={neuerTermin}
            className={knopf}
          >
            <Plus className="h-[22px] w-[22px]" />
          </button>
        )}
      </div>

      {teamErlaubt && (
        <div className="mb-2 grid h-[30px] grid-cols-2 gap-2 px-[10px]">
          {(["ich", "team"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setzeSicht(s)}
              aria-pressed={sicht === s}
              className={`${sicht === s ? "kasten-active" : "kasten-toggle-off"} h-[30px] justify-center text-[13px]`}
            >
              {s === "ich" ? "Ich" : "Team"}
            </button>
          ))}
        </div>
      )}

      {/* Wochentage + Raster. touch-action pan-y (+ pinch-zoom): senkrecht
          scrollt die Seite, waagrecht gehoert die Geste dem Raster. */}
      <div
        className="touch-pan-y touch-pinch-zoom"
        onTouchStart={beiTouchStart}
        onTouchMove={beiTouchMove}
        onTouchEnd={beiTouchEnd}
        onTouchCancel={beiTouchCancel}
      >
        <div className="grid grid-cols-7 border-b border-border" aria-hidden>
          {WOCHENTAGE.map((w, i) => (
            <span key={i} className="flex h-[20px] items-center justify-center text-[11px] font-semibold text-muted-foreground">
              {w}
            </span>
          ))}
        </div>
        {/* Rahmen mit der Hoehe des aktuellen Monats (gleitet mit), darin die
            Spur Vormonat | aktuell | Folgemonat. transform der Spur setzen
            nur Gesten/Gleiten (Startwert konstant), React fasst ihn nie an. */}
        <div
          ref={boxRef}
          className="overflow-hidden transition-[height] duration-[280ms] ease-[cubic-bezier(.2,.8,.2,1)]"
          style={{ height: raster.wochen.length * ZEILE_PX }}
        >
          <div
            ref={trackRef}
            className="flex items-start will-change-transform"
            style={{ transform: MITTE }}
            onTransitionEnd={beiTransitionEnd}
          >
            {[links, monatsKey, rechts].map((ym) => (
              <RasterMonat
                key={ym}
                ym={ym}
                aktiv={ym === monatsKey}
                daten={speicher.get(`${meId ?? ""}:${sicht}:${monatsRaster(ym).von}`) ?? null}
                heute={heute}
                gewaehlt={ym === monatsKey ? gewaehlt : landeTag(ym, heute)}
                onTag={beiTag}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Daten aus dem Offline-Cache: dezente Zeile mit dem Stand, nur dann —
          Spinner, solange der frische Stand noch laedt. */}
      {daten?.stand && (
        <p className="flex items-center gap-1.5 px-[10px] py-2 text-[13px] text-muted-foreground">
          {daten.aktualisiert ? (
            <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
          ) : (
            <CloudOff className="h-3.5 w-3.5 shrink-0" />
          )}
          Stand {standText(daten.stand)} · {daten.aktualisiert ? "wird aktualisiert…" : "offline"}
        </p>
      )}

      {/* Tagesliste des gewaehlten Tags — blendet beim Tages-/Monats-/
          Sichtwechsel kurz ein (Schluessel = Remount; page-in = opacity +
          4 px, reduced motion global aus). */}
      <div key={`${schluessel}:${gewaehlt}`} className="animate-[page-in_180ms_cubic-bezier(0.22,0.61,0.36,1)]">
        <div
          className={`flex h-[32px] items-center border-b border-border px-[10px] text-[13px] font-semibold ${
            gewaehltIstHeute ? "text-red-600 dark:text-red-400" : "text-muted-foreground"
          }`}
        >
          {gewaehltIstHeute ? "Heute · " : ""}{tagLang(gewaehlt)}
        </div>
        {laedt ? (
          <ListeSkeleton />
        ) : fehlerAktiv ? (
          <LadeFehler
            titel="Einsätze konnten nicht geladen werden"
            fehler={fehlerAktiv.text}
            laedt={neuLaedt}
            onRetry={() => { void erneutLaden(); }}
          />
        ) : !amTag ? (
          <p className="py-6 text-center text-[13px] text-muted-foreground">Keine Einträge</p>
        ) : (
          <ul className="divide-y divide-border">
            {abwesenheitenSortiert.map((a) => (
              <li key={`ab-${a.id}`}>
                <AbwesenheitZeile a={a} du={istDu(a)} />
              </li>
            ))}
            {amTag.einsaetze.map((e) => (
              <li key={e.id}>
                <EinsatzZeile
                  e={e}
                  zeigePerson={sicht === "team"}
                  eingestempelt={sicht === "ich" && !!e.job && active?.job_id === e.job.id}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Lazy-Chunk: erst beim Oeffnen gemountet; am Handy als Bottom-Sheet. */}
      {neuDatum && (
        <NeuerTerminModal
          open
          sheet
          onClose={() => setNeuDatum(null)}
          onCreated={() => { void load(); }}
          initialDate={neuDatum}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Raster eines Monats, Indikatoren und Zeilen
// ---------------------------------------------------------------------------

/** Wochen eines Monats als ein Platz der Spur. Nachbar-Plaetze sind inert
 *  (nicht fokussier-/antippbar) und fuer Screenreader verborgen. */
function RasterMonat({
  ym,
  aktiv,
  daten,
  heute,
  gewaehlt,
  onTag,
}: {
  ym: string;
  aktiv: boolean;
  daten: Geladen | null;
  heute: string;
  /** Markierter Tag (im Nachbar-Platz der Tag, auf dem man landen wird). */
  gewaehlt: string;
  onTag: (tag: string, e: React.MouseEvent) => void;
}) {
  const proTag = useMemo(() => {
    if (!daten) return null;
    const r = monatsRaster(ym);
    return verteile(daten.einsaetze, daten.abwesenheiten, r.von, r.bis);
  }, [daten, ym]);
  const { wochen } = monatsRaster(ym);

  return (
    <div className="w-full shrink-0" inert={!aktiv} aria-hidden={aktiv ? undefined : true}>
      {wochen.map((woche, wi) => (
        <div key={wi} className="grid grid-cols-7 border-b border-border">
          {woche.map((tag, i) => {
            if (!tag) return <div key={`leer-${i}`} className="h-[50px]" />;
            const eintraege = proTag?.get(tag);
            const anzahl = eintraege ? eintraege.einsaetze.length + eintraege.abwesenheiten.length : 0;
            const istHeute = tag === heute;
            const istGewaehlt = tag === gewaehlt;
            const kreis = istHeute
              ? "bg-red-500 font-bold text-white"
              : istGewaehlt
                ? "bg-foreground font-semibold text-background"
                : i >= 5 ? "text-muted-foreground" : "";
            const label =
              `${istHeute ? "Heute, " : ""}${tagLang(tag)}` +
              (anzahl > 0 ? `, ${anzahl} ${anzahl === 1 ? "Eintrag" : "Einträge"}` : "");
            return (
              <button
                key={tag}
                type="button"
                aria-pressed={istGewaehlt}
                aria-label={label}
                onClick={(e) => onTag(tag, e)}
                className="flex h-[50px] flex-col items-center pt-[4px]"
              >
                <span
                  className={`flex h-[30px] w-[30px] items-center justify-center rounded-full text-[16px] leading-none tabular-nums transition-colors duration-150 ${kreis}`}
                >
                  {zerlege(tag)[2]}
                </span>
                <Indikatoren kats={segmente(eintraege)} />
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Punkt (1 Eintrag) bzw. Pille aus 5-px-Segmenten (≥ 2); die 5 px Hoehe
 *  sind immer reserviert, damit beim Laden nichts springt. */
function Indikatoren({ kats }: { kats: Kategorie[] }) {
  return (
    <span className="mt-[4px] flex h-[5px] items-center" aria-hidden>
      {kats.length === 1 ? (
        <span className={`h-[5px] w-[5px] rounded-full ${KATEGORIE_FARBE[kats[0]]}`} />
      ) : kats.length > 1 ? (
        <span className="flex h-[5px] overflow-hidden rounded-full">
          {kats.map((k, i) => (
            <span key={i} className={`h-full w-[5px] ${KATEGORIE_FARBE[k]}`} />
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** 3-px-Balken in der Kategorie-Farbe links in der Zeile (wie iOS) — passt
 *  zum Punkt im Raster. */
function Farbbalken({ kat }: { kat: Kategorie }) {
  return <span aria-hidden className={`w-[3px] shrink-0 self-stretch rounded-full ${KATEGORIE_FARBE[kat]}`} />;
}

function statusWort(e: Einsatz, eingestempelt: boolean): { text: string; klasse: string } | null {
  if (e.job?.status === "abgeschlossen") return STATUS_ERLEDIGT;
  if (istLaufend(e)) {
    return {
      text: eingestempelt ? "Läuft · eingestempelt" : "Läuft",
      klasse: "text-teal-700 dark:text-teal-300",
    };
  }
  // Deadline verstrichen, Auftrag noch offen: «Überfällig» schlaegt «Rapport
  // offen» (rot wie «Überfällig» bei den Todos). Der Heute-Screen fuehrt
  // denselben Fall bewusst unter «Rapport offen».
  if (istDeadline(e) && istVorbei(e) && e.job?.status === "offen") {
    return { text: "Überfällig", klasse: "text-red-600 dark:text-red-400" };
  }
  if (rapportOffen(e)) {
    return { text: "Rapport offen", klasse: "text-amber-700 dark:text-amber-300" };
  }
  return null;
}

function EinsatzZeile({ e, zeigePerson, eingestempelt }: { e: ListenEinsatz; zeigePerson: boolean; eingestempelt: boolean }) {
  const status = statusWort(e, eingestempelt);
  const deadline = e.zeit_modus === "deadline";

  const neben: string[] = [];
  if (zeigePerson) neben.push(e.person ?? "Kollege");
  if (e.job) {
    neben.push(formatJobNumber(e.job.job_number));
    const ort = e.job.ort ?? e.job.adresse ?? e.job.kunde;
    if (ort) neben.push(ort);
  } else if (e.projekt) {
    neben.push(formatProjectNumber(e.projekt.project_number));
    if (e.projekt.title !== e.titel) neben.push(e.projekt.title);
  } else {
    neben.push("Termin");
  }

  const href = e.job ? `/auftraege/${e.job.id}` : e.projekt ? `/projekte/${e.projekt.id}` : null;

  const inhalt = (
    <>
      <Farbbalken kat={kategorie(e)} />
      <div className="w-12 shrink-0 pt-0.5 tabular-nums">
        <div className="text-[14px] font-bold leading-5">
          {deadline ? "bis" : formatTime(e.start)}
        </div>
        <div className={`text-[13px] leading-5 ${deadline ? "font-bold" : "text-muted-foreground"}`}>
          {deadline ? formatTime(e.start) : e.ende ? formatTime(e.ende) : ""}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-[14px] font-bold leading-5">{e.titel}</div>
        <div className="truncate text-[12px] leading-5 text-muted-foreground">{neben.join(" · ")}</div>
        {status && (
          <div className={`text-[13px] font-semibold leading-5 ${status.klasse}`}>{status.text}</div>
        )}
      </div>
    </>
  );

  const klasse = "flex min-h-[58px] items-start gap-3 px-[10px] py-2.5";
  if (!href) return <div className={klasse}>{inhalt}</div>;
  return (
    <Link href={href} className={`${klasse} active:bg-foreground/10`}>
      {inhalt}
    </Link>
  );
}

/** «Iuri Rigo · Ferien» / «02.10. – 18.10. · 17 Tage» — wer abwesend ist,
 *  steht immer da (eigene: «Du»). Kein Status-Wort: geladen werden nur
 *  genehmigte, der Platz gehoert dem Namen. */
function AbwesenheitZeile({ a, du }: { a: Abwesenheit; du: boolean }) {
  const tage = tageAnzahl(a.start, a.ende);
  const bereich = a.start === a.ende ? kurzDatum(a.start) : `${kurzDatum(a.start)} – ${kurzDatum(a.ende)}`;
  const wer = du ? "Du" : (a.person ?? "Unbekannt");
  return (
    <div className="flex min-h-[42px] items-center gap-3 px-[10px] py-2">
      <Farbbalken kat="abwesenheit" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-semibold leading-5">
          {wer} · {ABWESENHEIT_LABEL[a.typ] ?? a.typ}
        </div>
        <div className="text-[13px] leading-5 text-muted-foreground">
          {bereich} · {tage} {tage === 1 ? "Tag" : "Tage"}
        </div>
      </div>
    </div>
  );
}

/** Platzhalter der Tagesliste, solange der Monat zum ersten Mal laedt (das
 *  Raster steht schon). Balken-Spalte mit, damit der Text nicht springt. */
function ListeSkeleton() {
  return (
    <div aria-busy className="divide-y divide-border">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex min-h-[58px] items-start gap-3 px-[10px] py-2.5">
          <Skeleton className="w-[3px] self-stretch" />
          <div className="w-12 shrink-0 space-y-1.5 pt-0.5">
            <Skeleton className="h-4 w-11" />
            <Skeleton className="h-3.5 w-9" />
          </div>
          <div className="min-w-0 flex-1 space-y-1.5 pt-0.5">
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-3.5 w-3/5" />
          </div>
        </div>
      ))}
    </div>
  );
}
