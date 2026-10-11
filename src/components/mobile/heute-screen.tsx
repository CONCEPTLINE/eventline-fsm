"use client";

/**
 * «Heute» — Handy-Dashboard fuer Feldrollen (< md; Admin sieht am Handy das
 * bestehende Raster). Gemountet von src/app/(app)/dashboard/page.tsx.
 *
 * Aufbau (Konzept §3 Dashboard, Leinwand): Datum · Einsatz-Karte (laufender,
 * sonst naechster eigener Einsatz, ganze Karte → Auftrag; darunter Ein-/
 * Ausstempeln + Route; abgeschlossener Auftrag: «Erledigt», kein
 * Einstempeln) · «Spaeter heute» · «Rapport offen» · «Meine Todos»
 * (bis 3, abhakbar). Keine Kennzahlen, kein Team, kein Monat (less is more).
 *
 * Daten: Einsaetze ueber ladeMeineEinsaetzeGecacht (src/lib/einsaetze.ts,
 * -14..+7 Tage, EINE Abfrage fuer Karte, Spaeter heute und Rapport offen);
 * ohne Netz kommt sofort der letzte Online-Stand aus dem IndexedDB-Cache, dann
 * steht ueber der Karte «Stand von HH:MM · offline»; antwortet das Netz
 * langsam, steht der Cache-Stand vorab da («· wird aktualisiert…»), bis die
 * frische Antwort kommt. Todos aus /api/dashboard — mit
 * demselben Session-Cache und derselben optimistischen Abhak-Logik wie die
 * Desktop-Karte (session-cache.ts, todo-stand.ts).
 * meId IMMER aus usePermissions() («Ansicht als»).
 * Ladefehler (ohne Cache) → LadeFehler-Block (kompakt, in der Karte bzw. im
 * Todo-Abschnitt) mit «Erneut versuchen»; die Stempel-Knoepfe bleiben stehen,
 * weil Stempeln auch offline geht. Zurueck im Netz (online-Event) laden
 * beide Teile automatisch nach. Nach erfolgreichem Online-Laden werden die
 * Auftrags- und Rapport-Seiten von heute im Service-Worker vorgeladen
 * (sw-vorladen.ts), damit der Techniker sie offline oeffnen kann.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ChevronRight, CloudOff, FileText, Loader2, Navigation, Play, Square } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { usePermissions } from "@/lib/use-permissions";
import { useStempel, stempelErfolgText } from "@/lib/use-stempel";
import type { TimeEntry } from "@/types";
import { formatTime } from "@/lib/format";
import { ZRH_TZ } from "@/lib/swiss-time";
import { daysDiff, relativeDueLabel } from "@/lib/relative-date";
import { formatJobNumber } from "@/lib/nummern-format";
import { formatProjectNumber } from "@/lib/projekte-format";
import { TOAST } from "@/lib/messages";
import {
  aktuellerEinsatz,
  heuteTag,
  istBestempelbar,
  istDeadline,
  istLaufend,
  istVorbei,
  ladeMeineEinsaetzeGecacht,
  plusTage,
  rapportOffen,
  routeUrl,
  standText,
  STATUS_ERLEDIGT,
  zuerichTag,
  type Einsatz,
  type EinsatzJob,
} from "@/lib/einsaetze";
import { seitenVorladen } from "@/lib/offline/sw-vorladen";
import { useLocationRateTiers } from "@/components/stempel/rate-tier-chooser";
import { oeffneStempelSheet } from "@/components/mobile/stempel-sheet";
import { LadeFehler } from "@/components/mobile/lade-fehler";
import { Skeleton } from "@/components/ui/skeleton";
import { TODO_CHECKBOX_BASIS, TODO_CHECKBOX_OFFEN } from "@/components/todos/todo-row";
import type { DashboardDaten, TodoEintrag } from "@/components/dashboard/typen";
import { enthaeltTodo, mitTodoStatus, type TodoStatus } from "@/components/dashboard/todo-stand";
import {
  cacheSchreiben,
  ensureCacheAuthWatcher,
  gecachteDaten,
  todoAenderungenAbonnieren,
  todoAenderungenAnwenden,
  todoGespeichert,
  todoStatusSetzen,
  todoVerworfen,
} from "@/components/dashboard/session-cache";

/** Wie die Desktop-Karte: Todo-Seite immer «Meine» ohne Erledigte. */
const TODOS_HREF = "/todos?scope=mine&completed=0";
/** Hoechstens so viele Todos auf dem Heute-Screen. */
const TODOS_MAX = 3;
/** Hoechstens so viele Seiten-Huellen je Ladevorgang im Service Worker vorladen. */
const VORLADEN_MAX = 10;

// ---------------------------------------------------------------------------
// Zeit-Helfer (Europe/Zurich)
// ---------------------------------------------------------------------------

/** «Samstag, 17. Oktober» */
function datumZeile(d: Date): string {
  return new Intl.DateTimeFormat("de-CH", { timeZone: ZRH_TZ, weekday: "long", day: "numeric", month: "long" }).format(d);
}

/** «Fr 16.10.» */
function kurzTag(d: Date): string {
  const parts = new Intl.DateTimeFormat("de-CH", { timeZone: ZRH_TZ, weekday: "short", day: "2-digit", month: "2-digit" })
    .formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("weekday").replace(".", "")} ${get("day")}.${get("month")}.`;
}

/** YYYY-MM-DD (Spalte DATE) → Date am Mittag, damit die Anzeige in Zuerich
 *  denselben Kalendertag zeigt. */
function datumAusIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12));
}

/** «Heute» / «Morgen» / «Fr 16.10.» fuer den Kalendertag eines Zeitpunkts. */
function tagLabel(iso: string, heute: string): string {
  const tag = zuerichTag(iso);
  if (tag === heute) return "Heute";
  if (tag === plusTage(heute, 1)) return "Morgen";
  return kurzTag(new Date(iso));
}

/** «08:00 – 12:00», «bis 17:00» (Deadline) oder «08:00». */
function zeitspanne(e: Einsatz): string {
  if (istDeadline(e)) return `bis ${formatTime(e.start)}`;
  if (e.ende) return `${formatTime(e.start)} – ${formatTime(e.ende)}`;
  return formatTime(e.start);
}

/** Kontext einer laufenden Stempelung, die nicht zur Einsatz-Karte gehoert:
 *  «INT-4123», «PROJ-12» oder die Beschreibung («Andere Arbeit»). Nummern aus
 *  der eigenen Einsatzliste — kein zusaetzlicher Fetch. */
function stempelKontext(active: TimeEntry, liste: Einsatz[]): string {
  if (active.job_id) {
    const job = liste.find((e) => e.job?.id === active.job_id)?.job;
    return job ? formatJobNumber(job.job_number) : "Auftrag";
  }
  if (active.project_id) {
    const projekt = liste.find((e) => e.projekt?.id === active.project_id)?.projekt;
    return projekt ? formatProjectNumber(projekt.project_number) : active.description || "Projekt";
  }
  return active.description || "Andere Arbeit";
}

/** «INT-4123 · Location» bzw. «PROJ-12». */
function nummerUndOrt(e: Einsatz): string | null {
  if (e.job) {
    const ort = e.job.ort ?? e.job.adresse;
    return ort ? `${formatJobNumber(e.job.job_number)} · ${ort}` : formatJobNumber(e.job.job_number);
  }
  if (e.projekt) return formatProjectNumber(e.projekt.project_number);
  return null;
}

function einsatzHref(e: Einsatz): string | null {
  if (e.job) return `/auftraege/${e.job.id}`;
  if (e.projekt) return `/projekte/${e.projekt.id}`;
  return null;
}

/** Auftrags- und Rapport-Seiten der heutigen Auftraege (zuerst) und der mit
 *  offenem Rapport in den Service-Worker-Cache legen — einmal je Ladevorgang.
 *  Heute vor Rapport, damit alte offene Rapporte die Kappung nicht fuellen. */
function heutigeSeitenVorladen(liste: Einsatz[], heute: string): void {
  const ids = new Set<string>();
  for (const e of liste) if (e.job && zuerichTag(e.start) === heute) ids.add(e.job.id);
  for (const e of liste) if (e.job && rapportOffen(e)) ids.add(e.job.id);
  seitenVorladen([...ids].flatMap((id) => [`/auftraege/${id}`, `/auftraege/${id}/rapport`]).slice(0, VORLADEN_MAX));
}

// ---------------------------------------------------------------------------
// Todos abhaken — dieselbe Logik wie die Desktop-Karte (todos-karte.tsx):
// optimistisch ueber den Session-Cache, dann speichern, Toast mit Rückgängig,
// Fehler → zuruecknehmen.
// ---------------------------------------------------------------------------

/** Todos mit laufendem Speichern — je Todo nur ein Schreibvorgang. */
const speichernd = new Set<string>();

async function speichern(id: string, status: TodoStatus): Promise<string | null> {
  try {
    const { error } = await createClient()
      .from("todos")
      .update({ status, completed_at: status === "erledigt" ? new Date().toISOString() : null })
      .eq("id", id);
    return error ? error.message : null;
  } catch (e) {
    return e instanceof Error ? e.message : "Netzwerk-Fehler";
  }
}

function navZaehlerAuffrischen(): void {
  window.dispatchEvent(new Event("realtime:todos"));
}

async function rueckgaengig(id: string): Promise<void> {
  if (speichernd.has(id)) return;
  speichernd.add(id);
  const fehler = await speichern(id, "offen");
  speichernd.delete(id);
  if (fehler !== null) {
    toast.error("Rückgängig fehlgeschlagen: " + fehler);
    return;
  }
  todoStatusSetzen(id, "offen", true);
  navZaehlerAuffrischen();
}

/** Abhaken; gibt zurueck, ob gespeichert wurde. */
async function abhaken(t: TodoEintrag): Promise<boolean> {
  if (speichernd.has(t.id)) return false;
  speichernd.add(t.id);
  todoStatusSetzen(t.id, "erledigt", false);
  const fehler = await speichern(t.id, "erledigt");
  speichernd.delete(t.id);
  if (fehler !== null) {
    toast.error("Konnte nicht aktualisiert werden: " + fehler);
    todoVerworfen(t.id, "offen");
    return false;
  }
  todoGespeichert(t.id);
  navZaehlerAuffrischen();
  toast.success("Erledigt", {
    action: { label: "Rückgängig", onClick: () => void rueckgaengig(t.id) },
    duration: 5000,
  });
  return true;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function HeuteScreen() {
  const { meId, ready } = usePermissions();
  const { active, clockIn, clockOut, online } = useStempel();
  const supabase = createClient();
  const heute = heuteTag();

  /** Geladene Einsaetze; `cache` nur, wenn sie aus dem Offline-Cache stammen
   *  (Stand + ob im Hintergrund frisch geladen wird). */
  const [einsaetze, setEinsaetze] = useState<{
    liste: Einsatz[];
    cache: { stand: string; aktualisiert: boolean } | null;
  } | null>(null);
  const [einsatzFehler, setEinsatzFehler] = useState<string | null>(null);
  const [einsatzNeuLaedt, setEinsatzNeuLaedt] = useState(false);
  const [daten, setDaten] = useState<DashboardDaten | null>(() => gecachteDaten());
  /** Fehlertext des letzten Todo-Ladens (null = ok). */
  const [todosFehler, setTodosFehler] = useState<string | null>(null);
  const [todosNeuLaedt, setTodosNeuLaedt] = useState(false);
  const [stempelBusy, setStempelBusy] = useState(false);
  const einsatzLadeNr = useRef(0);
  const ladeNr = useRef(0);
  const aktiv = useRef(false);
  // Spiegel von `daten` fuer den Todo-Hoerer (ohne daten in die Deps zu ziehen).
  const datenRef = useRef<DashboardDaten | null>(daten);
  useEffect(() => {
    datenRef.current = daten;
  }, [daten]);

  // Einsaetze: -14 Tage (Rapport offen) bis +7 Tage (naechster Einsatz).
  // Schreiben darf nur die juengste Antwort (einsatzLadeNr) im gemounteten
  // Screen (aktiv, gesetzt vom Todo-Effekt) — ein Retry oder das online-Event
  // darf einen laufenden Aufruf nicht ueberholen.
  const ladeEinsaetze = useCallback(async () => {
    // Nummer zuerst ziehen: auch ohne meId (Abmelden, «Ansicht als») verfallen
    // laufende Antworten des alten Users.
    const nr = ++einsatzLadeNr.current;
    if (!meId) return;
    const gilt = () => aktiv.current && nr === einsatzLadeNr.current;
    try {
      const { liste, standAt, ausCache } = await ladeMeineEinsaetzeGecacht(
        supabase,
        meId,
        plusTage(heute, -14),
        plusTage(heute, 8),
        // Netz langsam: Cache-Stand vorab zeigen (ein Offline-Stand wird zu
        // «wird aktualisiert…») — nie ueber einen frischen Stand.
        (vorab) => {
          if (!gilt() || !vorab.standAt) return;
          const cache = { stand: vorab.standAt, aktualisiert: true };
          setEinsaetze((alt) => (alt && !alt.cache ? alt : { liste: vorab.liste, cache }));
        },
      );
      if (!gilt()) return;
      setEinsaetze({ liste, cache: ausCache && standAt ? { stand: standAt, aktualisiert: false } : null });
      setEinsatzFehler(null);
      // Vorladen nur mit frischem Stand — ohne Netz kann der SW nichts holen.
      if (!ausCache) heutigeSeitenVorladen(liste, heute);
    } catch (e) {
      if (!gilt()) return;
      const msg = e instanceof Error ? e.message : "Netzwerk-Fehler";
      toast.error(`Einsätze konnten nicht geladen werden: ${msg}`);
      // Ein Server-Fehler verschwindet nie hinter dem Cache-Stand: der weicht
      // dem Fehler-Block. Ein frischer Stand bleibt stehen (Toast reicht).
      setEinsaetze((alt) => (alt?.cache ? null : alt));
      setEinsatzFehler(msg);
    }
  }, [meId, supabase, heute]);

  useEffect(() => {
    void ladeEinsaetze();
    // Zurueck im Netz → automatisch neu laden (nach Ladefehler offline).
    const handler = () => { void ladeEinsaetze(); };
    window.addEventListener("online", handler);
    return () => window.removeEventListener("online", handler);
  }, [ladeEinsaetze]);

  async function einsaetzeErneut() {
    setEinsatzNeuLaedt(true);
    await ladeEinsaetze();
    setEinsatzNeuLaedt(false);
  }

  // Todos aus /api/dashboard — gleicher Ablauf wie die Desktop-Seite
  // (Session-Cache, lokale Todo-Aenderungen abgleichen, nur juengste Anfrage).
  const laden = useCallback(async () => {
    const nr = ++ladeNr.current;
    try {
      for (let runde = 0; runde < 2; runde++) {
        const gestartet = Date.now();
        const res = await fetch("/api/dashboard", { credentials: "include", cache: "no-store" });
        const json = (await res.json().catch(() => null)) as (Partial<DashboardDaten> & { error?: string }) | null;
        if (!aktiv.current || nr !== ladeNr.current) return;
        if (!res.ok || !json || json.success !== true) {
          throw new Error(json?.error ?? (`${res.status} ${res.statusText}`.trim() || "Laden fehlgeschlagen"));
        }
        const { daten: fresh, fehlt } = todoAenderungenAnwenden(json as DashboardDaten, gestartet);
        setDaten(fresh);
        setTodosFehler(null);
        cacheSchreiben(fresh);
        if (!fehlt) return;
      }
    } catch (e) {
      if (!aktiv.current || nr !== ladeNr.current) return;
      const msg = e instanceof Error ? e.message : "Netzwerk-Fehler";
      toast.error(`Todos konnten nicht geladen werden: ${msg}`);
      setTodosFehler(msg);
    }
  }, []);

  useEffect(() => {
    aktiv.current = true;
    ensureCacheAuthWatcher();
    void laden();
    const abmelden = todoAenderungenAbonnieren((id, status) => {
      setDaten((d) => (d ? mitTodoStatus(d, id, status) : d));
      if (status === "offen" && datenRef.current?.todos && !enthaeltTodo(datenRef.current, id)) void laden();
    });
    // Zurueck im Netz → automatisch neu laden (nach Ladefehler offline).
    const onlineHandler = () => { void laden(); };
    window.addEventListener("online", onlineHandler);
    return () => {
      aktiv.current = false;
      abmelden();
      window.removeEventListener("online", onlineHandler);
    };
  }, [laden]);

  async function todosErneut() {
    setTodosNeuLaedt(true);
    await laden();
    setTodosNeuLaedt(false);
  }

  // --- Einsaetze auswerten --------------------------------------------------
  const liste = einsaetze?.liste ?? [];
  const heutige = liste.filter((e) => zuerichTag(e.start) === heute);
  // Laeuft eine Stempelung auf einen Auftrag mit laufendem (auch mehrtaegigem)
  // oder heutigem Einsatz, zeigt die Karte den. Sonst (Projekt, Andere Arbeit,
  // Auftrag ohne Einsatz heute) bleibt gestempelter null und die Stempelung
  // bekommt eine eigene Kontextzeile — nie «Eingestempelt» ueber einem
  // fremden Einsatz.
  const gestempelter = active?.job_id
    ? liste.find((e) => e.job?.id === active.job_id && istLaufend(e)) ??
      heutige.find((e) => e.job?.id === active.job_id) ??
      null
    : null;
  const aktuell = gestempelter ?? aktuellerEinsatz(liste);
  const fremdeStempelung = active && !gestempelter ? stempelKontext(active, liste) : null;
  const spaeterHeute = heutige.filter((e) => e.id !== aktuell?.id && !istVorbei(e));

  // Rapport offen: je Auftrag eine Zeile (letzter Einsatz zaehlt).
  const rapportJeAuftrag = new Map<string, { e: Einsatz; job: EinsatzJob }>();
  for (const e of liste) if (e.job && rapportOffen(e)) rapportJeAuftrag.set(e.job.id, { e, job: e.job });
  const rapporte = [...rapportJeAuftrag.values()];

  // Direkt-Stempeln nur, wenn es heute genau EINEN bestempelbaren, nicht
  // vorbeien Auftrag gibt, die Karte genau diesen zeigt und der Standort
  // hoechstens einen Tarif hat — sonst oeffnet das Stempel-Sheet.
  const heutigeAuftraege = new Map<string, Einsatz>();
  for (const e of heutige) {
    if (e.job && istBestempelbar(e.job) && !istVorbei(e)) heutigeAuftraege.set(e.job.id, e);
  }
  const einzigerJob = heutigeAuftraege.size === 1 ? [...heutigeAuftraege.values()][0].job : null;
  const direktJob =
    einzigerJob && aktuell?.job?.id === einzigerJob.id && zuerichTag(aktuell.start) === heute && !istVorbei(aktuell)
      ? einzigerJob
      : null;
  const { tiers, defaultId, loading: tiersLaden } = useLocationRateTiers(direktJob?.location_id ?? null);
  // Nicht bestempelbarer Auftrag auf der Karte (z. B. abgeschlossen): kein
  // «Einstempeln» darunter — Stempeln auf anderes bleibt ueber die Bottom-Nav.
  const einstempelnAnbieten = !aktuell?.job || istBestempelbar(aktuell.job);
  const route = aktuell ? routeUrl(aktuell) : null;

  async function einstempeln() {
    if (!direktJob || tiersLaden || tiers.length > 1) {
      oeffneStempelSheet();
      return;
    }
    setStempelBusy(true);
    const res = await clockIn({ jobId: direktJob.id, rateTierId: defaultId ?? null });
    setStempelBusy(false);
    if (!res.success) {
      TOAST.stempelError(res.error || "Einstempeln fehlgeschlagen");
      return;
    }
    toast.success(stempelErfolgText(res, `Eingestempelt auf ${formatJobNumber(direktJob.job_number)}`, online));
  }

  async function ausstempeln() {
    setStempelBusy(true);
    const res = await clockOut();
    setStempelBusy(false);
    if (!res.success) {
      TOAST.stempelError(res.error || "Ausstempeln fehlgeschlagen");
      return;
    }
    toast.success(stempelErfolgText(res, "Ausgestempelt", online));
  }

  // --- Todos ----------------------------------------------------------------
  const todos = daten?.todos ?? null;
  const offeneTodos = todos ? todos.eintraege.filter((t) => t.status === "offen") : [];
  const todoZeilen = offeneTodos.slice(0, TODOS_MAX);

  async function todoAbhaken(t: TodoEintrag) {
    const ok = await abhaken(t);
    // Nachruecken: gibt es mehr offene Todos, als geliefert wurden.
    if (ok && todos && todos.offen > todos.eintraege.length) void laden();
  }

  const einsatzLaedt = einsaetze === null && einsatzFehler === null && !(ready && !meId);
  const todosLaden = daten === null && todosFehler === null;
  const todosRechts = (
    <Link href={TODOS_HREF} className="flex h-[44px] items-center px-1 text-[14px] font-medium text-foreground/80">
      Alle Todos
      <ChevronRight className="h-4 w-4" />
    </Link>
  );

  return (
    <div className="page-enter flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <p className="text-[14px] font-medium text-muted-foreground">{datumZeile(new Date())}</p>
        {/* Einsaetze aus dem Offline-Cache: dezente Zeile mit dem Stand, nur
            dann — Spinner, solange der frische Stand noch laedt. */}
        {einsaetze?.cache && (
          <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
            {einsaetze.cache.aktualisiert ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : (
              <CloudOff className="h-3.5 w-3.5 shrink-0" />
            )}
            Stand {standText(einsaetze.cache.stand)} · {einsaetze.cache.aktualisiert ? "wird aktualisiert…" : "offline"}
          </p>
        )}
      </div>

      {/* Einsatz-Karte */}
      {einsatzLaedt ? (
        <EinsatzKarteSkeleton />
      ) : (
        <section className="rounded-2xl border border-border bg-card">
          {/* Stempelung, die nicht zur Karte gehoert: eigene Zeile ausserhalb
              der Tippbar, damit sie nie als «eingestempelt auf diesen Einsatz»
              gelesen wird. */}
          {active && fremdeStempelung && (
            <p className="px-4 pt-4 text-[12px] font-bold uppercase tracking-wider text-teal-700 dark:text-teal-300">
              Eingestempelt seit {formatTime(active.clock_in)} · {fremdeStempelung}
            </p>
          )}
          {aktuell ? (
            <Tippbar
              href={einsatzHref(aktuell)}
              className={cn("flex items-start gap-3 p-4 active:bg-foreground/10", !fremdeStempelung && "rounded-t-2xl")}
            >
              <div className="min-w-0 flex-1">
                {active && gestempelter ? (
                  <p className="text-[12px] font-bold uppercase tracking-wider text-teal-700 dark:text-teal-300">
                    Eingestempelt seit {formatTime(active.clock_in)}
                  </p>
                ) : (
                  <p className="text-[12px] font-bold uppercase tracking-wider text-muted-foreground">
                    {tagLabel(aktuell.start, heute)} · {zeitspanne(aktuell)}
                  </p>
                )}
                <h2 className="mt-1 line-clamp-2 text-[19px] font-semibold leading-snug">{aktuell.titel}</h2>
                {nummerUndOrt(aktuell) && (
                  <p className="mt-1 truncate text-[14px] text-muted-foreground">{nummerUndOrt(aktuell)}</p>
                )}
                {aktuell.job?.status === "abgeschlossen" && (
                  <p className={cn("mt-1 text-[13px] font-semibold", STATUS_ERLEDIGT.klasse)}>{STATUS_ERLEDIGT.text}</p>
                )}
              </div>
              {einsatzHref(aktuell) && <ChevronRight className="mt-1 h-5 w-5 shrink-0 text-muted-foreground/60" />}
            </Tippbar>
          ) : einsatzFehler !== null ? (
            // Fehler ersetzt die Karten-Zeile (nicht zusaetzlich darunter);
            // die Stempel-Knoepfe bleiben, Stempeln geht auch offline.
            <div className={cn("px-4", fremdeStempelung ? "pb-4 pt-2" : "py-4")}>
              <LadeFehler
                kompakt
                titel="Einsätze konnten nicht geladen werden"
                fehler={einsatzFehler}
                laedt={einsatzNeuLaedt}
                onRetry={() => { void einsaetzeErneut(); }}
              />
            </div>
          ) : (
            <p className={cn("px-4 text-[16px] text-muted-foreground", fremdeStempelung ? "pb-4 pt-1" : "py-4")}>
              {ready && !meId ? "Profil konnte nicht geladen werden" : "Kein Einsatz geplant"}
            </p>
          )}

          {(active || einstempelnAnbieten || route) && (
            <div className="flex gap-2 px-4 pb-4">
              {active ? (
                <StempelKnopf busy={stempelBusy} onClick={ausstempeln} icon={<Square className="h-4 w-4" fill="currentColor" />}>
                  {stempelBusy ? "Wird ausgestempelt…" : "Ausstempeln"}
                </StempelKnopf>
              ) : einstempelnAnbieten ? (
                <StempelKnopf busy={stempelBusy} onClick={einstempeln} icon={<Play className="h-4 w-4" fill="currentColor" />}>
                  {stempelBusy ? "Wird eingestempelt…" : "Einstempeln"}
                </StempelKnopf>
              ) : null}
              {route && (
                <a
                  href={route}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="kasten kasten-muted h-[52px] w-[112px] shrink-0 text-[15px] font-semibold"
                >
                  <Navigation className="h-4 w-4" />
                  Route
                </a>
              )}
            </div>
          )}
        </section>
      )}

      {/* Spaeter heute */}
      {spaeterHeute.length > 0 && (
        <Abschnitt titel="Später heute">
          {spaeterHeute.map((e) => (
            <Tippbar key={e.id} href={einsatzHref(e)} className="flex h-[68px] items-center gap-3 border-t border-border px-4 first:border-t-0 active:bg-foreground/10">
              {/* Deadline wie in der Kalender-Tagesliste: «bis» ueber der Zeit. */}
              <div className="w-12 shrink-0 tabular-nums">
                <p className="text-[15px] font-bold leading-tight">{istDeadline(e) ? "bis" : formatTime(e.start)}</p>
                {istDeadline(e) ? (
                  <p className="text-[13px] font-bold leading-tight">{formatTime(e.start)}</p>
                ) : (
                  e.ende && <p className="text-[13px] leading-tight text-muted-foreground">{formatTime(e.ende)}</p>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[16px] font-medium">{e.titel}</p>
                {nummerUndOrt(e) && <p className="truncate text-[13px] text-muted-foreground">{nummerUndOrt(e)}</p>}
              </div>
              {einsatzHref(e) && <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground/60" />}
            </Tippbar>
          ))}
        </Abschnitt>
      )}

      {/* Rapport offen */}
      {rapporte.length > 0 && (
        <Abschnitt titel="Rapport offen">
          {rapporte.map(({ e, job }) => (
            // Direkt auf die Handy-Rapportseite (auftrag-feld kennt kein ?tab);
            // dieselbe Seite, die heutigeSeitenVorladen in den SW-Cache legt.
            <Link
              key={job.id}
              href={`/auftraege/${job.id}/rapport`}
              className="flex min-h-[64px] items-center gap-3 border-t border-border px-4 py-2 first:border-t-0 active:bg-foreground/10"
            >
              <FileText className="h-5 w-5 shrink-0 text-amber-700 dark:text-amber-300" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[16px] font-medium">{job.title}</p>
                <p className="truncate text-[13px] text-muted-foreground">
                  {formatJobNumber(job.job_number)} · bis {kurzTag(new Date(e.ende ?? e.start))}
                </p>
              </div>
              <span className="shrink-0 rounded-full bg-amber-100 px-2.5 py-1 text-[12px] font-semibold text-amber-800 dark:bg-amber-500/25 dark:text-amber-200">
                {job.rapport === "entwurf" ? "Entwurf" : "Fehlt"}
              </span>
              <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground/60" />
            </Link>
          ))}
        </Abschnitt>
      )}

      {/* Meine Todos */}
      {todosLaden ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-14 rounded-xl" />
          <Skeleton className="h-14 rounded-xl" />
          <Skeleton className="h-14 rounded-xl" />
        </div>
      ) : todos ? (
        <Abschnitt titel="Meine Todos" rechts={todosRechts}>
          {todoZeilen.length === 0 ? (
            <p className="flex h-14 items-center px-4 text-[14px] text-muted-foreground">Keine offenen Todos</p>
          ) : (
            todoZeilen.map((t) => <TodoZeile key={t.id} todo={t} heute={heute} onAbhaken={todoAbhaken} />)
          )}
        </Abschnitt>
      ) : todosFehler !== null ? (
        // Ohne Daten (kein Session-Cache) steht der Fehler an der Stelle der
        // Todo-Liste; mit Cache bleibt die Liste stehen und der Toast reicht.
        <Abschnitt titel="Meine Todos" rechts={todosRechts}>
          <div className="p-4">
            <LadeFehler
              kompakt
              titel="Todos konnten nicht geladen werden"
              fehler={todosFehler}
              laedt={todosNeuLaedt}
              onRetry={() => { void todosErneut(); }}
            />
          </div>
        </Abschnitt>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------------

/** Ganze Zeile/Karte tippbar, wenn es ein Ziel gibt — sonst ein div. */
function Tippbar({ href, className, children }: { href: string | null; className: string; children: ReactNode }) {
  if (href) {
    return (
      <Link href={href} className={className}>
        {children}
      </Link>
    );
  }
  return <div className={className}>{children}</div>;
}

/** Lade-Platzhalter der Einsatz-Karte: Kartenrahmen mit Zeilen und Knoepfen
 *  — ein flacher Block hebt sich im Hellen kaum vom Hintergrund ab und wirkt
 *  wie eine leere Flaeche. */
function EinsatzKarteSkeleton() {
  return (
    <section aria-busy className="rounded-2xl border border-border bg-card">
      <div className="space-y-2 p-4">
        <Skeleton className="h-3.5 w-36" />
        <Skeleton className="h-5 w-4/5" />
        <Skeleton className="h-4 w-1/2" />
      </div>
      <div className="flex gap-2 px-4 pb-4">
        <Skeleton className="h-[52px] min-w-0 flex-1 rounded-xl" />
        <Skeleton className="h-[52px] w-[112px] shrink-0 rounded-xl" />
      </div>
    </section>
  );
}

/** Abschnitt mit Versalien-Titel und Zeilen-Kasten. */
function Abschnitt({ titel, rechts, children }: { titel: string; rechts?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <div className="flex min-h-[28px] items-center justify-between px-1">
        <h2 className="text-[12px] font-bold uppercase tracking-wider text-muted-foreground">{titel}</h2>
        {rechts}
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-card">{children}</div>
    </section>
  );
}

/** Primaerknopf Stempeln — teal wie im Stempel-Sheet, 52 px, Spinner solange laeuft. */
function StempelKnopf({
  busy,
  onClick,
  icon,
  children,
}: {
  busy: boolean;
  onClick: () => void;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="flex h-[52px] min-w-0 flex-1 items-center justify-center gap-2 rounded-xl text-[17px] font-bold text-teal-700 disabled:opacity-60 dark:text-teal-300"
      style={{
        border: "2px solid var(--stempel-color, #14b8a6)",
        backgroundColor: "rgba(20,184,166,0.16)",
      }}
    >
      {busy ? <Loader2 className="h-5 w-5 animate-spin" /> : icon}
      {children}
    </button>
  );
}

/** Todo-Zeile 56 px: Checkbox (44-px-Tastflaeche, 24-px-Box), Titel, Faellig.
 *  Abhaken nimmt die Zeile sofort aus der Liste (optimistisch ueber den
 *  Session-Cache); der Toast bietet «Rückgängig». */
function TodoZeile({
  todo,
  heute,
  onAbhaken,
}: {
  todo: TodoEintrag;
  heute: string;
  onAbhaken: (t: TodoEintrag) => void;
}) {
  const faellig = todo.due_date ? faelligLabel(todo.due_date, heute) : null;
  return (
    <div className="flex h-14 items-center gap-1 border-t border-border pl-1 pr-4 first:border-t-0">
      <button
        type="button"
        aria-label="Als erledigt markieren"
        onClick={() => onAbhaken(todo)}
        className="flex h-[44px] w-[44px] shrink-0 items-center justify-center"
      >
        <span className={cn(TODO_CHECKBOX_BASIS, TODO_CHECKBOX_OFFEN)} />
      </button>
      <Link href={TODOS_HREF} className="flex min-w-0 flex-1 items-center gap-3 self-stretch">
        <span className={cn("min-w-0 flex-1 truncate text-[16px]", todo.priority === "dringend" && "font-semibold")}>
          {todo.title}
        </span>
        {faellig && <span className={cn("shrink-0 text-[13px] tabular-nums", faellig.ton)}>{faellig.text}</span>}
      </Link>
    </div>
  );
}

/** Faelligkeit: «Heute» (amber), «Mo 19.10.», rot «Überfällig 4 Tage». */
function faelligLabel(dueIso: string, heute: string): { text: string; ton: string } {
  const diff = daysDiff(heute, dueIso);
  if (diff < 0) return { text: relativeDueLabel(dueIso, heute).label, ton: "font-medium text-red-600 dark:text-red-400" };
  if (diff === 0) return { text: "Heute", ton: "font-medium text-amber-700 dark:text-amber-300" };
  return { text: kurzTag(datumAusIso(dueIso)), ton: "text-muted-foreground" };
}
