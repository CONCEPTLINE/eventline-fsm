"use client";

/**
 * Stempelzeiten am Handy (< md): eigene Eintraege EINES Monats.
 *
 *   Kopf 40 px    ‹ «Oktober 2026 · 41 h 20» ›   (?monat=YYYY-MM, Reload-sicher)
 *   Trenner 32 px «Sa 11.10. · 8 h 15» sticky unter dem mobilen Kopf
 *   Zeile 48 px   «08:02 – 17:12» mono · Kontext · Dauer rechts
 *                 laufend teal «08:02 – läuft»; Pille «nicht gesendet» (amber)
 *                 fuer Aktionen, die noch in der Offline-Warteschlange stehen;
 *                 Pille «gesperrt» (grau) nach Abrechnungssperre.
 *   Tipp → Sheet  Details + «Stempel-Änderung melden» (Stempel-Ticket mit
 *                 Vorbelegung wie das Desktop-«Korrigieren»); «Löschen» nur
 *                 stempelzeiten:edit-all.
 *
 * Kein Personen-Umschalter, keine Kennzahl-Kaesten, kein Export (Konzept §3).
 * Daten: time_entries user_id = meId (usePermissions, nie auth.getUser),
 * Monatsfenster in Zuercher Mitternachten, clock_in desc. Summen aus den
 * geladenen Eintraegen des Monats (laufende bis jetzt).
 * Realtime: window-Event realtime:time_entries → neu laden, coalesced 2.5 s.
 * Ladefehler ohne Daten → LadeFehler «Erneut versuchen» (kein Endlos-
 * Skeleton), Rueckkehr ins Netz (online-Event) laedt automatisch nach —
 * Muster kalender-monat.tsx.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, Clock, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { useStempel } from "@/lib/use-stempel";
import { heuteTag, zuerichMitternachtIso, zuerichTag } from "@/lib/einsaetze";
import { formatTime } from "@/lib/format";
import { ZRH_TZ } from "@/lib/swiss-time";
import { isTimeEntryLocked, TIME_ENTRY_LOCK_MESSAGE } from "@/lib/time-lock";
import { endeGesperrtMeldung, stempelFehlerText } from "@/lib/stempel-meldungen";
import { formatJobNumber } from "@/lib/nummern-format";
import { formatProjectNumber } from "@/lib/projekte-format";
import { TOAST } from "@/lib/messages";
import type { StempelOp } from "@/lib/offline/db";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/use-confirm";
import { NewTicketModal } from "@/components/tickets/new-ticket-modal";
import { LadeFehler } from "@/components/mobile/lade-fehler";

const MONAT_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const SELECT =
  "id, job_id, project_id, clock_in, clock_out, description, notes, " +
  "job:jobs(job_number, title), project:projects(project_number, title)";

interface Eintrag {
  id: string;
  job_id: string | null;
  project_id: string | null;
  clock_in: string;
  clock_out: string | null;
  description: string | null;
  notes: string | null;
  job: { job_number: number; title: string } | null;
  project: { project_number: number | null; title: string } | null;
}

/** Anzeige-Zeile — Server-Eintrag oder noch nicht gesendete Aktion. */
interface Zeile {
  id: string;
  clockIn: string;
  clockOut: string | null;
  kontext: string;
  href: string | null;
  notiz: string | null;
  jobId: string | null;
  /** false = steht (noch) nur in der Offline-Warteschlange. */
  gesendet: boolean;
  gesperrt: boolean;
}

// ---------------------------------------------------------------------------
// Monat (Europe/Zurich)
// ---------------------------------------------------------------------------

/** YYYY-MM des heutigen Zuercher Kalendertags. */
function aktuellerMonat(): string {
  return heuteTag().slice(0, 7);
}

function monatPlus(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** «Oktober 2026» */
function monatLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Intl.DateTimeFormat("de-CH", { timeZone: ZRH_TZ, month: "long", year: "numeric" })
    .format(new Date(Date.UTC(y, m - 1, 15, 12)));
}

/** [von, bis) als UTC-ISO der Zuercher Mitternachten. */
function monatGrenzen(ym: string): { von: string; bis: string } {
  return { von: zuerichMitternachtIso(`${ym}-01`), bis: zuerichMitternachtIso(`${monatPlus(ym, 1)}-01`) };
}

/** «Sa 11.10.» fuer einen Kalendertag YYYY-MM-DD (Mittag UTC = DST-sicher). */
function tagLabel(tag: string): string {
  const [y, m, d] = tag.split("-").map(Number);
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  const wochentag = new Intl.DateTimeFormat("de-CH", { timeZone: ZRH_TZ, weekday: "short" })
    .format(noon).replace(".", "");
  return `${wochentag} ${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}.`;
}

/** «Samstag, 11. Oktober 2026» */
function langesDatum(iso: string): string {
  return new Intl.DateTimeFormat("de-CH", { timeZone: ZRH_TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" })
    .format(new Date(iso));
}

/** «8 h 15», «0 h 05» */
function hm(minuten: number): string {
  const m = Math.max(0, Math.floor(minuten));
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
}

function minuten(z: Zeile, now: number): number {
  const ende = z.clockOut ? new Date(z.clockOut).getTime() : now;
  return Math.max(0, Math.floor((ende - new Date(z.clockIn).getTime()) / 60000));
}

// ---------------------------------------------------------------------------
// Zeilen bauen (Server + Warteschlange)
// ---------------------------------------------------------------------------

function kontextFuer(e: Eintrag): { kontext: string; href: string | null } {
  if (e.job_id && e.job) {
    return { kontext: `${formatJobNumber(e.job.job_number)} · ${e.job.title}`, href: `/auftraege/${e.job_id}` };
  }
  if (e.project_id && e.project) {
    return { kontext: `${formatProjectNumber(e.project.project_number)} · ${e.project.title}`, href: `/projekte/${e.project_id}` };
  }
  return { kontext: e.description ? `Andere Arbeit · ${e.description}` : "Andere Arbeit", href: null };
}

/** Server-Eintraege plus Warteschlange: nicht gesendete Einstempelungen als
 *  eigene Zeile, nicht gesendete Ausstempelungen als Ende ihres Eintrags.
 *  Ein wartender Tarifwechsel schliesst seinen Vorgaenger (prev_entry_id)
 *  zum selben Zeitpunkt — wie ueberlagern() in use-stempel.tsx, sonst
 *  stehen zwei «läuft»-Zeilen da und die Summe zaehlt doppelt. */
function baueZeilen(eintraege: Eintrag[], queue: StempelOp[], monat: string): Zeile[] {
  const serverIds = new Set(eintraege.map((e) => e.id));
  const ausstempeln = new Map<string, StempelOp>();
  for (const op of queue) {
    if (op.kind === "clock_out") ausstempeln.set(op.entry_id, op);
    else if (op.kind === "switch_tier" && op.payload.prev_entry_id) ausstempeln.set(op.payload.prev_entry_id, op);
  }

  const zeilen: Zeile[] = eintraege.map((e) => {
    const { kontext, href } = kontextFuer(e);
    const offenesEnde = !e.clock_out ? ausstempeln.get(e.id) : undefined;
    return {
      id: e.id,
      clockIn: e.clock_in,
      // Ausstempeln nach > 16 h traegt die gewaehlte Endzeit (Phase 4).
      clockOut: e.clock_out ?? offenesEnde?.payload.clock_out ?? offenesEnde?.client_ts ?? null,
      kontext,
      href,
      notiz: e.notes,
      jobId: e.job_id,
      gesendet: !offenesEnde,
      gesperrt: isTimeEntryLocked(e.clock_in),
    };
  });

  for (const op of queue) {
    if (op.kind !== "clock_in" && op.kind !== "switch_tier") continue;
    if (serverIds.has(op.entry_id)) continue;
    if (zuerichTag(op.client_ts).slice(0, 7) !== monat) continue;
    // Label ohne Netz: Auftrag/Projekt aus einem geladenen Eintrag desselben
    // Ziels uebernehmen, sonst nur die Art.
    const bekannt = op.payload.job_id
      ? eintraege.find((e) => e.job_id === op.payload.job_id)
      : op.payload.project_id
        ? eintraege.find((e) => e.project_id === op.payload.project_id)
        : undefined;
    const kontext = bekannt
      ? kontextFuer(bekannt).kontext
      : op.payload.job_id
        ? "Auftrag"
        : op.payload.project_id
          ? "Projekt"
          : op.payload.description
            ? `Andere Arbeit · ${op.payload.description}`
            : "Andere Arbeit";
    zeilen.push({
      id: op.entry_id,
      clockIn: op.client_ts,
      clockOut: ausstempeln.get(op.entry_id)?.client_ts ?? null,
      kontext,
      href: bekannt ? kontextFuer(bekannt).href : null,
      notiz: null,
      jobId: op.payload.job_id,
      gesendet: false,
      gesperrt: false,
    });
  }

  zeilen.sort((a, b) => Date.parse(b.clockIn) - Date.parse(a.clockIn));
  return zeilen;
}

interface Tag {
  tag: string;
  zeilen: Zeile[];
  minuten: number;
}

function gruppiere(zeilen: Zeile[], now: number): Tag[] {
  const map = new Map<string, Tag>();
  for (const z of zeilen) {
    const tag = zuerichTag(z.clockIn);
    let g = map.get(tag);
    if (!g) {
      g = { tag, zeilen: [], minuten: 0 };
      map.set(tag, g);
    }
    g.zeilen.push(z);
    g.minuten += minuten(z, now);
  }
  return Array.from(map.values()).sort((a, b) => (a.tag < b.tag ? 1 : a.tag > b.tag ? -1 : 0));
}

// ---------------------------------------------------------------------------
// Komponente
// ---------------------------------------------------------------------------

interface Geladen {
  schluessel: string;
  eintraege: Eintrag[];
}

interface FehlerStand {
  schluessel: string;
  text: string;
}

export function StempelzeitenMobil() {
  const supabase = createClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { meId, can, ready } = usePermissions();
  const { queue } = useStempel();
  const { confirm, ConfirmModalElement } = useConfirm();

  const heute = heuteTag();
  const aktuell = aktuellerMonat();
  const param = searchParams.get("monat");
  const monat = param && MONAT_RE.test(param) ? param : aktuell;

  // Geladener Stand ist an User + Monat gebunden: beim Wechsel zeigt die
  // Liste das Skeleton statt kurz den falschen Monat (kein setState im Effekt).
  // Der Ladefehler haengt am selben Schluessel — nach dem Monatswechsel gilt
  // der Fehler des alten Monats nicht mehr.
  const schluessel = `${meId ?? ""}:${monat}`;
  const [geladen, setGeladen] = useState<Geladen | null>(null);
  const [fehler, setFehler] = useState<FehlerStand | null>(null);
  const [neuLaedt, setNeuLaedt] = useState(false);
  const daten = geladen?.schluessel === schluessel ? geladen : null;
  // Fehlerzustand nur, solange keine Daten dieses Monats stehen — scheitert
  // ein spaeteres Neuladen, bleibt die Liste sichtbar und der Toast reicht.
  const fehlerAktiv = !daten && fehler?.schluessel === schluessel ? fehler : null;

  // Sequenz-Schutz: schreiben darf nur die Antwort zum aktuellen Schluessel
  // UND zum juengsten Aufruf. Sonst ueberschreibt eine verspaetete Antwort
  // des vorigen Monats (oder ein Realtime-Nachlauf) den neueren Stand, und
  // die Liste haengt im Skeleton. Ref im Effekt setzen, nicht beim Rendern.
  const aktuellRef = useRef(schluessel);
  const ladeNr = useRef(0);
  useEffect(() => {
    aktuellRef.current = schluessel;
  }, [schluessel]);

  const [offen, setOffen] = useState<Zeile | null>(null);
  const [ticketFuer, setTicketFuer] = useState<Zeile | null>(null);
  const [loescht, setLoescht] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (!meId) return;
    const key = `${meId}:${monat}`;
    const nr = ++ladeNr.current;
    const { von, bis } = monatGrenzen(monat);
    try {
      const { data, error } = await supabase
        .from("time_entries")
        .select(SELECT)
        .eq("user_id", meId)
        .gte("clock_in", von)
        .lt("clock_in", bis)
        .order("clock_in", { ascending: false });
      if (error) throw new Error(error.message);
      if (aktuellRef.current !== key || nr !== ladeNr.current) return;
      setGeladen({ schluessel: key, eintraege: (data as unknown as Eintrag[]) ?? [] });
      setFehler(null);
    } catch (e) {
      if (aktuellRef.current !== key || nr !== ladeNr.current) return;
      const text = e instanceof Error ? e.message : "Netzwerk-Fehler";
      toast.error(`Stempelzeiten konnten nicht geladen werden: ${text}`);
      setFehler({ schluessel: key, text });
    }
  }, [supabase, meId, monat]);

  async function erneutLaden() {
    setNeuLaedt(true);
    await load();
    setNeuLaedt(false);
  }

  useEffect(() => {
    // Realtime coalesced (leading + trailing, 2.5 s). Erstladen laeuft durch
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
    const first = setTimeout(coalescedLoad, 0);
    window.addEventListener("realtime:time_entries", coalescedLoad);
    // Zurueck im Netz → automatisch neu laden (nach Ladefehler offline).
    window.addEventListener("online", coalescedLoad);
    return () => {
      clearTimeout(first);
      if (timer) clearTimeout(timer);
      window.removeEventListener("realtime:time_entries", coalescedLoad);
      window.removeEventListener("online", coalescedLoad);
    };
  }, [load]);

  const zeilen = useMemo(
    () => (daten ? baueZeilen(daten.eintraege, queue, monat) : []),
    [daten, queue, monat],
  );
  const hatLaufend = zeilen.some((z) => !z.clockOut);

  // Laufende Dauer im Minutentakt nachziehen.
  useEffect(() => {
    if (!hatLaufend) return;
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, [hatLaufend]);

  const tage = useMemo(() => gruppiere(zeilen, now), [zeilen, now]);
  const summe = useMemo(() => tage.reduce((s, t) => s + t.minuten, 0), [tage]);

  function setzeMonat(neu: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (neu === aktuell) params.delete("monat");
    else params.set("monat", neu);
    const q = params.toString();
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  }

  const canTicket = can("tickets:create");
  const canEditAll = can("stempelzeiten:edit-all");

  function aenderungMelden(z: Zeile) {
    setOffen(null);
    setTicketFuer(z);
  }

  async function loeschen(z: Zeile) {
    if (isTimeEntryLocked(z.clockIn)) {
      toast.error(TIME_ENTRY_LOCK_MESSAGE);
      return;
    }
    const ok = await confirm({
      title: "Eintrag löschen?",
      message: "Der Stempel-Eintrag wird unwiderruflich entfernt.",
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    setLoescht(true);
    const { error, count } = await supabase.from("time_entries").delete({ count: "exact" }).eq("id", z.id);
    setLoescht(false);
    if (error) {
      toast.error(await stempelFehlerText(supabase, error, { zeitpunkt: z.clockIn, sonst: `Eintrag konnte nicht gelöscht werden: ${error.message}` }));
      return;
    }
    // RLS filtert still (Recht entzogen, inzwischen gesperrt, anderswo
    // geloescht) — 0 Zeilen sind kein Erfolg.
    if (!count) {
      TOAST.error("Eintrag konnte nicht gelöscht werden — kein Löschrecht oder bereits gesperrt");
      void load();
      return;
    }
    toast.success("Eintrag gelöscht");
    setOffen(null);
    void load();
  }

  const laedt = !ready || (!!meId && !daten && !fehlerAktiv);
  const vorwaerts = monat < aktuell;

  return (
    <div className="page-enter -mx-[10px]">
      {/* Monat */}
      <div className="flex h-[40px] items-center px-2">
        <button
          type="button"
          aria-label="Vormonat"
          onClick={() => setzeMonat(monatPlus(monat, -1))}
          className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-xl active:bg-foreground/10"
        >
          <ChevronLeft className="h-6 w-6" />
        </button>
        <div className="min-w-0 flex-1 truncate text-center text-[14px] font-semibold tabular-nums">
          {monatLabel(monat)}
          {daten && <span className="text-muted-foreground"> · {hm(summe)}</span>}
        </div>
        <button
          type="button"
          aria-label="Nächster Monat"
          onClick={() => setzeMonat(monatPlus(monat, 1))}
          disabled={!vorwaerts}
          className="inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-xl active:bg-foreground/10 disabled:opacity-30"
        >
          <ChevronRight className="h-6 w-6" />
        </button>
      </div>

      {laedt ? (
        <ListeSkeleton />
      ) : ready && !meId ? (
        <EmptyState icon={Clock} title="Profil konnte nicht geladen werden" />
      ) : fehlerAktiv ? (
        <LadeFehler
          titel="Stempelzeiten konnten nicht geladen werden"
          fehler={fehlerAktiv.text}
          laedt={neuLaedt}
          onRetry={() => { void erneutLaden(); }}
        />
      ) : tage.length === 0 ? (
        <EmptyState
          icon={Clock}
          title="Keine Stempelzeiten"
          description={`Im ${monatLabel(monat)} wurde nichts gestempelt.`}
        />
      ) : (
        tage.map((t) => {
          const istHeute = t.tag === heute;
          return (
            <section key={t.tag}>
              <div
                className={`sticky top-[var(--kopf-h,0px)] z-10 flex h-8 items-center justify-between border-y border-border bg-background/95 px-[10px] text-[13px] font-semibold tabular-nums backdrop-blur ${
                  istHeute ? "text-red-600 dark:text-red-400" : "text-muted-foreground"
                }`}
              >
                <span>{istHeute ? "Heute · " : ""}{tagLabel(t.tag)}</span>
                <span>{hm(t.minuten)}</span>
              </div>
              <ul className="divide-y divide-border">
                {t.zeilen.map((z) => (
                  <li key={z.id}>
                    <StempelZeile z={z} now={now} onTap={() => setOffen(z)} />
                  </li>
                ))}
              </ul>
            </section>
          );
        })
      )}

      {/* Detail-Sheet */}
      <Modal open={offen !== null} onClose={() => !loescht && setOffen(null)} title="Stempelzeit" sheet size="md" closable={!loescht} bodyClassName="p-[10px] space-y-4">
        {offen && (
          <>
            <dl className="overflow-hidden rounded-xl border border-border">
              <Detail label="Datum" wert={langesDatum(offen.clockIn)} />
              <Detail label="Von" wert={formatTime(offen.clockIn)} />
              <Detail label="Bis" wert={offen.clockOut ? formatTime(offen.clockOut) : "läuft"} />
              <Detail label="Dauer" wert={hm(minuten(offen, now))} />
              <Detail
                label="Kontext"
                wert={offen.href ? (
                  <Link href={offen.href} className="inline-flex min-h-[34px] items-center font-medium text-foreground underline underline-offset-4">{offen.kontext}</Link>
                ) : offen.kontext}
              />
              {offen.notiz && <Detail label="Notiz" wert={offen.notiz} />}
            </dl>

            {!offen.gesendet && (
              <p className="rounded-xl bg-amber-50 px-3 py-2 text-[12px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">
                Noch nicht gesendet — wird übertragen, sobald Netz da ist.
              </p>
            )}
            {offen.gesperrt && (
              <p className="rounded-xl bg-amber-50 px-3 py-2 text-[12px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-200">
                {!offen.clockOut
                  ? endeGesperrtMeldung(offen.clockIn)
                  : `${TIME_ENTRY_LOCK_MESSAGE} — Änderungen setzt die Lohnverwaltung per Antrag (Ticket «Stempel-Änderung»).`}
              </p>
            )}

            {offen.gesendet && canTicket && (
              <button
                type="button"
                onClick={() => aenderungMelden(offen)}
                className="kasten kasten-red h-[40px] w-full text-base"
              >
                Stempel-Änderung melden
              </button>
            )}
            {offen.gesendet && !offen.gesperrt && canEditAll && (
              <button
                type="button"
                onClick={() => void loeschen(offen)}
                disabled={loescht}
                className="kasten kasten-muted h-[36px] w-full text-[13px]"
              >
                {loescht ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                {loescht ? "Wird gelöscht …" : "Löschen"}
              </button>
            )}
          </>
        )}
      </Modal>

      {ConfirmModalElement}

      <NewTicketModal
        open={ticketFuer !== null}
        onClose={() => setTicketFuer(null)}
        onCreated={() => {
          setTicketFuer(null);
          toast.success("Ticket erstellt — Admin wurde benachrichtigt");
          void load();
        }}
        initialType="stempel_aenderung"
        initialData={ticketFuer ? {
          timeEntryId: ticketFuer.id,
          clockIn: ticketFuer.clockIn,
          clockOut: ticketFuer.clockOut,
          jobId: ticketFuer.jobId,
        } : undefined}
        sheet
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------------

function StempelZeile({ z, now, onTap }: { z: Zeile; now: number; onTap: () => void }) {
  const laeuft = !z.clockOut;
  const teal = laeuft ? "text-teal-700 dark:text-teal-300" : "";
  return (
    <button
      type="button"
      onClick={onTap}
      className="flex min-h-[48px] w-full items-center gap-3 px-[10px] py-2 text-left active:bg-foreground/10"
    >
      <div className="min-w-0 flex-1">
        <div className={`font-mono text-[14px] font-semibold leading-5 tabular-nums ${teal}`}>
          {formatTime(z.clockIn)} – {z.clockOut ? formatTime(z.clockOut) : "läuft"}
        </div>
        <div className="truncate text-[12px] leading-5 text-muted-foreground">{z.kontext}</div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className={`text-[13px] font-semibold leading-5 tabular-nums ${teal}`}>{hm(minuten(z, now))}</span>
        {!z.gesendet ? (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[12px] font-semibold text-amber-800 dark:bg-amber-500/25 dark:text-amber-200">
            nicht gesendet
          </span>
        ) : z.gesperrt ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[12px] font-semibold text-muted-foreground">
            gesperrt
          </span>
        ) : null}
      </div>
    </button>
  );
}

function Detail({ label, wert }: { label: string; wert: React.ReactNode }) {
  return (
    <div className="flex min-h-[36px] items-center gap-3 border-t border-border px-3 py-2 first:border-t-0">
      <dt className="w-20 shrink-0 text-[12px] font-bold uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 text-[14px] leading-5">{wert}</dd>
    </div>
  );
}

function ListeSkeleton() {
  return (
    <div aria-busy>
      {[3, 2, 2].map((n, gi) => (
        <div key={gi}>
          <div className="flex h-8 items-center justify-between border-y border-border px-[10px]">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3.5 w-12" />
          </div>
          <div className="divide-y divide-border">
            {Array.from({ length: n }).map((_, i) => (
              <div key={i} className="flex min-h-[48px] items-center gap-3 px-[10px] py-2">
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3.5 w-3/5" />
                </div>
                <Skeleton className="h-4 w-12" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
