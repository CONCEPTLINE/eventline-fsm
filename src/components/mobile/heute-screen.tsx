"use client";

/**
 * «Heute» — Handy-Dashboard fuer Feldrollen (< md; Admin sieht am Handy das
 * bestehende Raster). Gemountet von src/app/(app)/dashboard/page.tsx.
 *
 * Aufbau (Konzept §3 Dashboard, Leinwand): Datum · Einsatz-Karte (laufender,
 * sonst naechster eigener Einsatz, ganze Karte → Auftrag; darunter Ein-/
 * Ausstempeln + Route) · «Spaeter heute» · «Rapport offen» · «Meine Todos»
 * (bis 3, abhakbar). Keine Kennzahlen, kein Team, kein Monat (less is more).
 *
 * Daten: Einsaetze ueber ladeMeineEinsaetze (src/lib/einsaetze.ts, -14..+7
 * Tage, EINE Abfrage fuer Karte, Spaeter heute und Rapport offen); Todos aus
 * /api/dashboard — mit demselben Session-Cache und derselben optimistischen
 * Abhak-Logik wie die Desktop-Karte (session-cache.ts, todo-stand.ts).
 * meId IMMER aus usePermissions() («Ansicht als»).
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ChevronRight, FileText, Loader2, Navigation, Play, Square } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { usePermissions } from "@/lib/use-permissions";
import { useStempel } from "@/lib/use-stempel";
import { formatTime } from "@/lib/format";
import { ZRH_TZ } from "@/lib/swiss-time";
import { daysDiff, relativeDueLabel } from "@/lib/relative-date";
import { formatJobNumber } from "@/lib/nummern-format";
import { formatProjectNumber } from "@/lib/projekte-format";
import { TOAST } from "@/lib/messages";
import {
  aktuellerEinsatz,
  heuteTag,
  istVorbei,
  ladeMeineEinsaetze,
  plusTage,
  rapportOffen,
  routeUrl,
  zuerichTag,
  type Einsatz,
  type EinsatzJob,
} from "@/lib/einsaetze";
import { useLocationRateTiers } from "@/components/stempel/rate-tier-chooser";
import { oeffneStempelSheet } from "@/components/mobile/stempel-sheet";
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
  if (e.zeit_modus === "deadline" && !e.ende) return `bis ${formatTime(e.start)}`;
  if (e.ende) return `${formatTime(e.start)} – ${formatTime(e.ende)}`;
  return formatTime(e.start);
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
  const { active, clockIn, clockOut } = useStempel();
  const supabase = createClient();
  const heute = heuteTag();

  const [einsaetze, setEinsaetze] = useState<Einsatz[] | null>(null);
  const [einsatzFehler, setEinsatzFehler] = useState<string | null>(null);
  const [daten, setDaten] = useState<DashboardDaten | null>(() => gecachteDaten());
  const [todosFehler, setTodosFehler] = useState(false);
  const [stempelBusy, setStempelBusy] = useState(false);
  const ladeNr = useRef(0);
  const aktiv = useRef(false);
  // Spiegel von `daten` fuer den Todo-Hoerer (ohne daten in die Deps zu ziehen).
  const datenRef = useRef<DashboardDaten | null>(daten);
  useEffect(() => {
    datenRef.current = daten;
  }, [daten]);

  // Einsaetze: -14 Tage (Rapport offen) bis +7 Tage (naechster Einsatz).
  useEffect(() => {
    if (!meId) return;
    let cancelled = false;
    (async () => {
      try {
        const liste = await ladeMeineEinsaetze(supabase, meId, plusTage(heute, -14), plusTage(heute, 8));
        if (cancelled) return;
        setEinsaetze(liste);
        setEinsatzFehler(null);
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "Netzwerk-Fehler";
        toast.error(`Einsätze konnten nicht geladen werden: ${msg}`);
        setEinsatzFehler(msg);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [meId, supabase, heute]);

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
        setTodosFehler(false);
        cacheSchreiben(fresh);
        if (!fehlt) return;
      }
    } catch (e) {
      if (!aktiv.current || nr !== ladeNr.current) return;
      const msg = e instanceof Error ? e.message : "Netzwerk-Fehler";
      toast.error(`Todos konnten nicht geladen werden: ${msg}`);
      setTodosFehler(true);
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
    return () => {
      aktiv.current = false;
      abmelden();
    };
  }, [laden]);

  // --- Einsaetze auswerten --------------------------------------------------
  const liste = einsaetze ?? [];
  const heutige = liste.filter((e) => zuerichTag(e.start) === heute);
  // Laeuft eine Stempelung auf einen heutigen Auftrag, zeigt die Karte den.
  const gestempelter = active?.job_id ? heutige.find((e) => e.job?.id === active.job_id) ?? null : null;
  const aktuell = gestempelter ?? aktuellerEinsatz(liste);
  const spaeterHeute = heutige.filter((e) => e.id !== aktuell?.id && !istVorbei(e));

  // Rapport offen: je Auftrag eine Zeile (letzter Einsatz zaehlt).
  const rapportJeAuftrag = new Map<string, { e: Einsatz; job: EinsatzJob }>();
  for (const e of liste) if (e.job && rapportOffen(e)) rapportJeAuftrag.set(e.job.id, { e, job: e.job });
  const rapporte = [...rapportJeAuftrag.values()];

  // Direkt-Stempeln: genau EIN Auftrag heute und hoechstens ein Tarif.
  const heutigeAuftraege = new Map<string, Einsatz>();
  for (const e of heutige) if (e.art === "auftrag" && e.job) heutigeAuftraege.set(e.job.id, e);
  const einzigerJob = heutigeAuftraege.size === 1 ? [...heutigeAuftraege.values()][0].job : null;
  const { tiers, defaultId, loading: tiersLaden } = useLocationRateTiers(einzigerJob?.location_id ?? null);

  async function einstempeln() {
    if (!einzigerJob || tiersLaden || tiers.length > 1) {
      oeffneStempelSheet();
      return;
    }
    setStempelBusy(true);
    const res = await clockIn({ jobId: einzigerJob.id, rateTierId: defaultId ?? null });
    setStempelBusy(false);
    if (!res.success) {
      TOAST.stempelError(res.error || "Einstempeln fehlgeschlagen");
      return;
    }
    toast.success(`Eingestempelt auf ${formatJobNumber(einzigerJob.job_number)}`);
  }

  async function ausstempeln() {
    setStempelBusy(true);
    const res = await clockOut();
    setStempelBusy(false);
    if (!res.success) {
      TOAST.stempelError(res.error || "Ausstempeln fehlgeschlagen");
      return;
    }
    toast.success("Ausgestempelt");
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
  const todosLaden = daten === null && !todosFehler;

  return (
    <div className="page-enter flex flex-col gap-5">
      <p className="text-[14px] font-medium text-muted-foreground">{datumZeile(new Date())}</p>

      {/* Einsatz-Karte */}
      {einsatzLaedt ? (
        <Skeleton className="h-[196px] rounded-2xl" />
      ) : (
        <section className="rounded-2xl border border-border bg-card">
          {aktuell ? (
            <Tippbar href={einsatzHref(aktuell)} className="flex items-start gap-3 rounded-t-2xl p-4 active:bg-foreground/5">
              <div className="min-w-0 flex-1">
                {active ? (
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
              </div>
              {einsatzHref(aktuell) && <ChevronRight className="mt-1 h-5 w-5 shrink-0 text-muted-foreground/60" />}
            </Tippbar>
          ) : (
            <div className="p-4">
              {active ? (
                <p className="text-[12px] font-bold uppercase tracking-wider text-teal-700 dark:text-teal-300">
                  Eingestempelt seit {formatTime(active.clock_in)}
                </p>
              ) : null}
              <p className={cn("text-[16px] text-muted-foreground", active && "mt-1")}>
                {einsatzFehler
                  ? "Einsätze konnten nicht geladen werden"
                  : ready && !meId
                    ? "Profil konnte nicht geladen werden"
                    : "Kein Einsatz geplant"}
              </p>
            </div>
          )}

          <div className="flex gap-2 px-4 pb-4">
            {active ? (
              <StempelKnopf busy={stempelBusy} onClick={ausstempeln} icon={<Square className="h-4 w-4" fill="currentColor" />}>
                {stempelBusy ? "Wird ausgestempelt…" : "Ausstempeln"}
              </StempelKnopf>
            ) : (
              <StempelKnopf busy={stempelBusy} onClick={einstempeln} icon={<Play className="h-4 w-4" fill="currentColor" />}>
                {stempelBusy ? "Wird eingestempelt…" : "Einstempeln"}
              </StempelKnopf>
            )}
            {aktuell && routeUrl(aktuell) && (
              <a
                href={routeUrl(aktuell) ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="kasten kasten-muted h-[52px] w-[112px] shrink-0 text-[15px] font-semibold"
              >
                <Navigation className="h-4 w-4" />
                Route
              </a>
            )}
          </div>
        </section>
      )}

      {/* Spaeter heute */}
      {spaeterHeute.length > 0 && (
        <Abschnitt titel="Später heute">
          {spaeterHeute.map((e) => (
            <Tippbar key={e.id} href={einsatzHref(e)} className="flex h-[68px] items-center gap-3 border-t border-border px-4 first:border-t-0 active:bg-foreground/5">
              <div className="w-12 shrink-0 tabular-nums">
                <p className="text-[15px] font-bold leading-tight">{formatTime(e.start)}</p>
                {e.ende && <p className="text-[13px] leading-tight text-muted-foreground">{formatTime(e.ende)}</p>}
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
            <Link
              key={job.id}
              href={`/auftraege/${job.id}?tab=rapport`}
              className="flex min-h-[64px] items-center gap-3 border-t border-border px-4 py-2 first:border-t-0 active:bg-foreground/5"
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
        <Abschnitt
          titel="Meine Todos"
          rechts={
            <Link href={TODOS_HREF} className="flex h-11 items-center px-1 text-[14px] font-medium text-foreground/80">
              Alle Todos
              <ChevronRight className="h-4 w-4" />
            </Link>
          }
        >
          {todoZeilen.length === 0 ? (
            <p className="flex h-14 items-center px-4 text-[14px] text-muted-foreground">Keine offenen Todos</p>
          ) : (
            todoZeilen.map((t) => <TodoZeile key={t.id} todo={t} heute={heute} onAbhaken={todoAbhaken} />)
          )}
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
        className="flex h-11 w-11 shrink-0 items-center justify-center"
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
