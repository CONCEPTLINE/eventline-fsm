"use client";

/**
 * Kalender am Handy = Tagesliste «Meine Einsätze» (heute bis +42 Tage).
 * Kein Raster, kein «+», keine Personenzeilen — nur: wann, was, wo, Zustand.
 *
 *   Segment «Ich | Team»  nur bei usePermissions().scope !== "self"
 *                          (Zustand in der URL: ?sicht=team, Reload-sicher)
 *   Tagestrenner sticky    «Heute · Sa 17.10.» (rot), «Morgen · So 18.10.», «Mo 19.10.»
 *   Einsatz-Zeile 76 px    Zeit | Titel (2 Zeilen) + Nebentext | Status als Wort
 *   Abwesenheit 56 px      eigene genehmigte time_off, am Tag des Beginns
 *
 * Daten: ladeMeineEinsaetze (src/lib/einsaetze.ts) fuer «Ich»; «Team» =
 * dieselbe Abfrage ohne assigned_to-Filter (RLS begrenzt auf Sichtbares).
 * meId IMMER aus usePermissions() — nie auth.getUser() («Ansicht als»).
 * Realtime: window-Events realtime:jobs / jobs:invalidate → neu laden,
 * coalesced 2.5 s (Muster src/lib/use-nav-counts.tsx).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { CalendarDays } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { useStempel } from "@/lib/use-stempel";
import {
  type Einsatz,
  heuteTag,
  istLaufend,
  ladeMeineEinsaetze,
  plusTage,
  rapportOffen,
  zuerichMitternachtIso,
  zuerichTag,
} from "@/lib/einsaetze";
import { formatTime } from "@/lib/format";
import { ZRH_TZ } from "@/lib/swiss-time";
import { formatJobNumber } from "@/lib/nummern-format";
import { formatProjectNumber } from "@/lib/projekte-format";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

const FENSTER_TAGE = 42;
/** Hoehe des globalen mobilen Kopfs (mobile-kopf.tsx) — Tagestrenner kleben darunter. */
const KOPF_H = "calc(52px + env(safe-area-inset-top))";

type Sicht = "ich" | "team";

/** Einsatz mit Person (nur in der Team-Sicht gefuellt). */
type ListenEinsatz = Einsatz & { person: string | null };

interface Abwesenheit {
  id: string;
  typ: "ferien" | "krank" | "kompensation" | "frei" | "militaer";
  start: string; // YYYY-MM-DD
  ende: string;  // YYYY-MM-DD, inklusiv
}

const ABWESENHEIT_LABEL: Record<Abwesenheit["typ"], string> = {
  ferien: "Ferien",
  krank: "Krank",
  kompensation: "Kompensation",
  frei: "Frei",
  militaer: "Militär",
};

// ---------------------------------------------------------------------------
// Laden
// ---------------------------------------------------------------------------

type Verknuepft<T> = T | T[] | null;
function eins<T>(v: Verknuepft<T> | undefined): T | null {
  if (!v) return null;
  return Array.isArray(v) ? (v[0] ?? null) : v;
}

type TeamJobRow = {
  id: string; job_number: number | null; title: string; status: string; is_deleted: boolean | null;
  location_id: string | null; external_address: string | null;
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

/** Team-Sicht: wie ladeMeineEinsaetze, aber ohne assigned_to-Filter und mit
 *  Person. RLS entscheidet, wessen Termine sichtbar sind. */
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
          "job:jobs(id, job_number, title, status, is_deleted, location_id, external_address, " +
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
            location_id: job.location_id,
            ort,
            adresse: ort ? null : (job.external_address?.trim() || null),
            kunde: eins(job.customer)?.name ?? null,
            rapport: !job.service_reports?.length
              ? "keiner"
              : job.service_reports.some((r) => r.status === "abgeschlossen") ? "abgeschlossen" : "entwurf",
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

/** Eigene genehmigte Abwesenheiten, die das Fenster [vonTag, bisTag] beruehren. */
async function ladeAbwesenheiten(
  supabase: SupabaseClient,
  meId: string,
  vonTag: string,
  bisTag: string,
): Promise<Abwesenheit[]> {
  const { data, error } = await supabase
    .from("time_off")
    .select("id, type, start_date, end_date")
    .eq("user_id", meId)
    .eq("status", "genehmigt")
    .gte("end_date", vonTag)
    .lte("start_date", bisTag)
    .order("start_date", { ascending: true });
  if (error) throw new Error(error.message);
  return ((data ?? []) as { id: string; type: Abwesenheit["typ"]; start_date: string; end_date: string }[])
    .map((r) => ({ id: r.id, typ: r.type, start: r.start_date, ende: r.end_date }));
}

// ---------------------------------------------------------------------------
// Darstellung (Zeit immer Europe/Zurich)
// ---------------------------------------------------------------------------

/** «Sa 17.10.» fuer einen Kalendertag YYYY-MM-DD (Mittag UTC = DST-sicher). */
function tagLabel(tag: string): string {
  const [y, m, d] = tag.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  const wochentag = new Intl.DateTimeFormat("de-CH", { timeZone: ZRH_TZ, weekday: "short" })
    .format(noon).replace(".", "");
  return `${wochentag} ${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.`;
}

/** «17.10.» */
function kurzDatum(tag: string): string {
  const [, m, d] = tag.split("-");
  return `${d}.${m}.`;
}

/** Anzahl Kalendertage eines inklusiven Bereichs. */
function tageAnzahl(start: string, ende: string): number {
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = ende.split("-").map(Number);
  return Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86_400_000) + 1;
}

interface Gruppe {
  tag: string;
  einsaetze: ListenEinsatz[];
  abwesenheiten: Abwesenheit[];
}

function gruppiere(einsaetze: ListenEinsatz[], abwesenheiten: Abwesenheit[], heute: string): Gruppe[] {
  const map = new Map<string, Gruppe>();
  const hol = (tag: string) => {
    let g = map.get(tag);
    if (!g) {
      g = { tag, einsaetze: [], abwesenheiten: [] };
      map.set(tag, g);
    }
    return g;
  };
  for (const a of abwesenheiten) {
    // Bereits laufende Abwesenheit steht unter «Heute».
    hol(a.start < heute ? heute : a.start).abwesenheiten.push(a);
  }
  for (const e of einsaetze) {
    // Laufender Mehrtages-Einsatz (Start vor heute) steht unter «Heute».
    const tag = zuerichTag(e.start);
    hol(tag < heute ? heute : tag).einsaetze.push(e);
  }
  return Array.from(map.values()).sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
}

// ---------------------------------------------------------------------------
// Komponente
// ---------------------------------------------------------------------------

interface Geladen {
  schluessel: string;
  einsaetze: ListenEinsatz[];
  abwesenheiten: Abwesenheit[];
}

export function EinsaetzeListe() {
  const supabase = createClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { meId, scope, ready } = usePermissions();
  const { active } = useStempel();

  const teamErlaubt = scope !== "self";
  const sicht: Sicht = teamErlaubt && searchParams.get("sicht") === "team" ? "team" : "ich";

  // Geladener Stand ist an seinen Schluessel (User + Sicht) gebunden: beim
  // Umschalten zeigt die Liste das Skeleton statt kurz die falschen Daten,
  // ohne dass ein Effekt synchron setState rufen muss.
  const schluessel = `${meId ?? ""}:${sicht}`;
  const [geladen, setGeladen] = useState<Geladen | null>(null);
  const daten = geladen?.schluessel === schluessel ? geladen : null;

  const load = useCallback(async () => {
    if (!meId) return;
    const heute = heuteTag();
    const bis = plusTage(heute, FENSTER_TAGE);
    try {
      const [einsaetze, abwesenheiten] = await Promise.all([
        sicht === "team"
          ? ladeTeamEinsaetze(supabase, heute, bis)
          : ladeMeineEinsaetze(supabase, meId, heute, bis).then((l) => l.map((e) => ({ ...e, person: null }))),
        ladeAbwesenheiten(supabase, meId, heute, bis),
      ]);
      setGeladen({ schluessel: `${meId}:${sicht}`, einsaetze, abwesenheiten });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Einsätze konnten nicht geladen werden");
    }
  }, [supabase, meId, sicht]);

  useEffect(() => {
    // Realtime coalesced (leading + trailing, 2.5 s): jobs:invalidate feuert
    // bei jeder jobs-Aenderung irgendeines Users. Erstladen laeuft durch
    // dieselbe Schleuse, als Callback (nicht synchron im Effekt).
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
    const handler = () => { coalescedLoad(); };
    const visibilityHandler = () => { if (document.visibilityState === "visible") coalescedLoad(); };
    const first = setTimeout(coalescedLoad, 0);
    window.addEventListener("realtime:jobs", handler);
    window.addEventListener("jobs:invalidate", handler);
    document.addEventListener("visibilitychange", visibilityHandler);
    return () => {
      clearTimeout(first);
      if (timer) clearTimeout(timer);
      window.removeEventListener("realtime:jobs", handler);
      window.removeEventListener("jobs:invalidate", handler);
      document.removeEventListener("visibilitychange", visibilityHandler);
    };
  }, [load]);

  function setzeSicht(neu: Sicht) {
    const params = new URLSearchParams(searchParams.toString());
    if (neu === "team") params.set("sicht", "team");
    else params.delete("sicht");
    const q = params.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  }

  const heute = heuteTag();
  const morgen = plusTage(heute, 1);
  const gruppen = useMemo(
    () => (daten ? gruppiere(daten.einsaetze, daten.abwesenheiten, heute) : []),
    [daten, heute],
  );

  const laedt = !ready || !daten;

  return (
    <div className="page-enter -mx-4">
      {teamErlaubt && (
        <div className="grid h-11 grid-cols-2 gap-2 px-4 mb-3">
          {(["ich", "team"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setzeSicht(s)}
              aria-pressed={sicht === s}
              className={`${sicht === s ? "kasten-active" : "kasten-toggle-off"} h-11 justify-center text-[15px]`}
            >
              {s === "ich" ? "Ich" : "Team"}
            </button>
          ))}
        </div>
      )}

      {laedt ? (
        <ListeSkeleton />
      ) : gruppen.length === 0 ? (
        <EmptyState
          icon={CalendarDays}
          title="Keine Einsätze geplant"
          description={`In den nächsten ${FENSTER_TAGE / 7} Wochen ist ${sicht === "team" ? "im Team" : "für dich"} nichts eingeplant.`}
        />
      ) : (
        gruppen.map((g) => {
          const istHeute = g.tag === heute;
          const praefix = istHeute ? "Heute · " : g.tag === morgen ? "Morgen · " : "";
          return (
            <section key={g.tag}>
              <div
                className={`sticky z-10 flex h-8 items-center border-y border-border bg-background/95 px-4 text-[13px] font-semibold backdrop-blur ${
                  istHeute ? "text-red-600 dark:text-red-400" : "text-muted-foreground"
                }`}
                style={{ top: KOPF_H }}
              >
                {praefix}{tagLabel(g.tag)}
              </div>
              <ul className="divide-y divide-border">
                {g.abwesenheiten.map((a) => (
                  <li key={`ab-${a.id}`}>
                    <AbwesenheitZeile a={a} />
                  </li>
                ))}
                {g.einsaetze.map((e) => (
                  <li key={e.id}>
                    <EinsatzZeile
                      e={e}
                      zeigePerson={sicht === "team"}
                      eingestempelt={sicht === "ich" && !!e.job && active?.job_id === e.job.id}
                    />
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Zeilen
// ---------------------------------------------------------------------------

function statusWort(e: Einsatz, eingestempelt: boolean): { text: string; klasse: string } | null {
  if (e.job?.status === "abgeschlossen") {
    return { text: "Erledigt", klasse: "text-green-700 dark:text-green-300" };
  }
  if (istLaufend(e)) {
    return {
      text: eingestempelt ? "Läuft · eingestempelt" : "Läuft",
      klasse: "text-teal-700 dark:text-teal-300",
    };
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
      <div className="w-12 shrink-0 pt-0.5 tabular-nums">
        <div className="text-[16px] font-bold leading-5">
          {deadline ? "bis" : formatTime(e.start)}
        </div>
        <div className={`text-[13px] leading-5 ${deadline ? "font-bold" : "text-muted-foreground"}`}>
          {deadline ? formatTime(e.start) : e.ende ? formatTime(e.ende) : ""}
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-[16px] font-bold leading-5">{e.titel}</div>
        <div className="truncate text-[14px] leading-5 text-muted-foreground">{neben.join(" · ")}</div>
        {status && (
          <div className={`text-[13px] font-semibold leading-5 ${status.klasse}`}>{status.text}</div>
        )}
      </div>
    </>
  );

  const klasse = "flex min-h-[76px] items-start gap-3 px-4 py-2.5";
  if (!href) return <div className={klasse}>{inhalt}</div>;
  return (
    <Link href={href} className={`${klasse} active:bg-foreground/10`}>
      {inhalt}
    </Link>
  );
}

function AbwesenheitZeile({ a }: { a: Abwesenheit }) {
  const tage = tageAnzahl(a.start, a.ende);
  const bereich = a.start === a.ende ? kurzDatum(a.start) : `${kurzDatum(a.start)} – ${kurzDatum(a.ende)}`;
  return (
    <div className="flex min-h-[56px] items-center gap-3 px-4 py-2 text-muted-foreground">
      <div className="min-w-0 flex-1">
        <div className="truncate text-[16px] font-semibold leading-5">
          {ABWESENHEIT_LABEL[a.typ] ?? a.typ} · {tage} {tage === 1 ? "Tag" : "Tage"}
        </div>
        <div className="text-[13px] leading-5">{bereich}</div>
      </div>
      <div className="shrink-0 text-[13px] font-semibold text-green-700 dark:text-green-300">Genehmigt</div>
    </div>
  );
}

function ListeSkeleton() {
  return (
    <div aria-busy>
      {[3, 2, 2].map((n, gi) => (
        <div key={gi}>
          <div className="flex h-8 items-center border-y border-border px-4">
            <Skeleton className="h-3.5 w-28" />
          </div>
          <div className="divide-y divide-border">
            {Array.from({ length: n }).map((_, i) => (
              <div key={i} className="flex min-h-[76px] items-start gap-3 px-4 py-2.5">
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
        </div>
      ))}
    </div>
  );
}
