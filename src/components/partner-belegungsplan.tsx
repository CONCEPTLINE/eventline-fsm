"use client";

/**
 * Partner-Belegungsplan: klassischer Monats-Kalender (7×5/6) mit farbig
 * markierten Buchungs-Tagen, darunter eine Liste der naechsten Buchungen.
 *
 * Daten kommen aus /api/belegungsplan (gefiltert auf die Partner-Location).
 * Eintraege sind klickbar: eigene Anfragen → /partner/anfragen/[id],
 * fremde Vermietungen → kleines Modal mit Read-Only-Details.
 * Am Handy (< md) zeigt das Raster nur Farbbalken je Buchung; geoeffnet
 * wird dort ueber die Liste darunter.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { ChevronLeft, ChevronRight, Calendar } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Spinner } from "@/components/ui/spinner";
import { useIsMobile } from "@/lib/use-is-mobile";
import { localDateIso, plusTage, todayLocalIso, weekdayForDateIso, laeuftAmTag } from "@/lib/swiss-time";

type BookingKind = "entwurf" | "partner_anfrage" | "bestaetigt" | "bestaetigt_unzugewiesen" | "storniert" | "vermietung" | "belegt";

interface Booking {
  id: string;
  kind: BookingKind;
  title: string;
  customerName: string | null;
  isOwn: boolean;
  status: string;
  /** Echte Zeitpunkte aus der DB (timestamptz) — nur fuer Anzeige/Sortierung. */
  start: Date;
  end: Date;
  /** Zurich-Kalendertage YYYY-MM-DD (Ende inklusiv) — fuer die Tages-Zuordnung. */
  startTag: string;
  endTag: string;
}

interface ApiBooking {
  id: string;
  job_number: number | null;
  title: string | null;
  status: string;
  was_anfrage: boolean | null;
  start_date: string;
  end_date: string | null;
  location_id: string;
  customer_name: string | null;
  visible: boolean;
  is_own: boolean;
}

const WEEKDAY_SHORT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const MONTH_LONG = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

// Das Raster rechnet AUSSCHLIESSLICH mit Zurich-Kalendertagen (YYYY-MM-DD)
// und reiner Kalender-Arithmetik (plusTage). Frueher lief es mit lokalen
// Date-Objekten + 86'400'000 ms pro Tag — am Sommerzeit-Ende (25.10.2026,
// 25-Stunden-Tag) landete "Mitternacht + 24 h" wieder auf dem 25., der Tag
// erschien doppelt und alles danach war um einen Wochentag verschoben.

/** YYYY-MM-DD → [Jahr, Monat 1-12, Tag]. */
function datumTeile(tag: string): [number, number, number] {
  const [y, m, d] = tag.split("-").map(Number);
  return [y, m, d];
}

/** Erster des Monats (YYYY-MM-01), um n Monate verschoben. */
function monatsErster(tag: string, n = 0): string {
  const [y, m] = datumTeile(tag);
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

/** Wochentag Mo=0 … So=6 eines Kalendertags. */
function wochentagMo0(tag: string): number {
  return (weekdayForDateIso(tag) + 6) % 7;
}

/** Monatsraster: Montag der ersten bis Sonntag der letzten Kalenderwoche
 *  des Monats — immer vollstaendige Wochen, jeder Tag genau einmal. */
export function monatsRaster(ersterDesMonats: string): string[] {
  const start = plusTage(ersterDesMonats, -wochentagMo0(ersterDesMonats));
  const letzter = plusTage(monatsErster(ersterDesMonats, 1), -1);
  const ende = plusTage(letzter, 6 - wochentagMo0(letzter));
  const tage: string[] = [];
  for (let t = start; t <= ende; t = plusTage(t, 1)) tage.push(t);
  return tage;
}

// 'bestaetigt' = angenommene Anfrage + Mitarbeiter zugewiesen → gruen.
// Wenn noch nicht zugewiesen → gelb (bestaetigt_unzugewiesen). Wird beim
// Render aufgeloest weil die Assignee-Info nachgeladen wird (separate
// Query nach dem initialen bookings-Fetch).
function effectiveKind(rawKind: BookingKind, assigneeCount: number): BookingKind {
  if (rawKind === "bestaetigt" && assigneeCount === 0) {
    return "bestaetigt_unzugewiesen";
  }
  return rawKind;
}

function kindFromBooking(b: ApiBooking): BookingKind | null {
  // Belegungsplan ist location-scoped: zeige ALLES was an der Location
  // los ist. Coloring nach Workflow (Partner-eigene Anfrage → bestaetigt;
  // Eventline-Vermietung → vermietung; Eventline-interner Auftrag ohne
  // Vermietungs-Tag → 'belegt' grau). Vorher wurden interne Eventline-
  // Jobs (kein was_anfrage, kein Partner-Status) komplett aus dem
  // Belegungsplan geschluckt — der Partner sah dann freie Tage die in
  // Wirklichkeit belegt waren.
  //
  // is_own = im selben Partner-Team (Location-shared seit Migration
  // belegungsplan-Fix); bestimmt nur die Faerbung partner-originierter
  // Eintraege, nie die Sichtbarkeit.
  if (b.is_own) {
    if (b.status === "partner_entwurf") return "entwurf";
    if (b.status === "partner_anfrage") return "partner_anfrage";
    if (b.status === "storniert") return "storniert";
    // status in (offen, abgeschlossen) → unsere Anfrage wurde angenommen
    return "bestaetigt";
  }
  // Eventline-Jobs am Standort:
  if (b.status === "storniert") return null; // effektiv frei → ausblenden
  if (b.was_anfrage === true || b.status === "anfrage" || b.status === "entwurf") {
    return "vermietung";
  }
  // Eventline-interner Job (Wartung/Setup/Übergabe) — Location ist belegt
  // aber keine Inhalte fuer Partner relevant.
  return "belegt";
}

const KIND_STYLE: Record<BookingKind, { dot: string; bg: string; text: string; border: string; label: string }> = {
  entwurf:         { dot: "bg-gray-400 dark:bg-gray-500", bg: "bg-foreground/[0.05] dark:bg-foreground/10", text: "text-muted-foreground", border: "border-foreground/15 dark:border-foreground/20", label: "Entwurf" },
  partner_anfrage: { dot: "bg-amber-500",  bg: "bg-amber-50 dark:bg-amber-500/15",   text: "text-amber-800 dark:text-amber-300",     border: "border-amber-200 dark:border-amber-500/30",     label: "Offene Anfrage" },
  // Gruen = von EVENTLINE angenommen UND mindestens ein Mitarbeiter
  // zugewiesen (Termin mit assigned_to vorhanden).
  bestaetigt:      { dot: "bg-green-500",  bg: "bg-green-50 dark:bg-green-500/15",   text: "text-green-800 dark:text-green-300",     border: "border-green-200 dark:border-green-500/30",     label: "Bestätigt" },
  // Gelb = angenommen aber noch keiner zugewiesen — der Partner sieht
  // dass die Anfrage durch ist, aber noch nicht eingeteilt wurde.
  bestaetigt_unzugewiesen: { dot: "bg-amber-500", bg: "bg-amber-50 dark:bg-amber-500/15", text: "text-amber-800 dark:text-amber-300", border: "border-amber-200 dark:border-amber-500/30", label: "Bestätigt, nicht zugewiesen" },
  storniert:       { dot: "bg-red-500",    bg: "bg-red-50 dark:bg-red-500/15",       text: "text-red-800 dark:text-red-300",         border: "border-red-200 dark:border-red-500/30",         label: "Abgelehnt" },
  vermietung:      { dot: "bg-blue-500",   bg: "bg-blue-50 dark:bg-blue-500/15",     text: "text-blue-800 dark:text-blue-300",       border: "border-blue-200 dark:border-blue-500/30",       label: "Vermietung" },
  // 'Belegt' = Eventline-interner Job (Wartung/Setup/Übergabe ohne
  // Vermietungs-Tag) an der Location. Fuer Partner-Sicht nur "blockiert,
  // keine Details" — neutraler Gray-Stil ohne Klick-Aktion.
  belegt:          { dot: "bg-foreground/40", bg: "bg-foreground/[0.06] dark:bg-foreground/10", text: "text-foreground/70", border: "border-foreground/15 dark:border-foreground/20", label: "Belegt" },
};

interface Props {
  locationId: string;
}

export function PartnerBelegungsplan({ locationId }: Props) {
  const supabase = createClient();
  // Vermietungs-Modal nur am Handy als Bottom-Sheet (schliesst dort beim
  // Tippen daneben); am Desktop wie bisher ein normales Modal.
  const isMobile = useIsMobile();
  // Angezeigter Monat als Zurich-Kalendertag YYYY-MM-01.
  const [anchor, setAnchor] = useState<string>(() => monatsErster(todayLocalIso()));
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  // job_id → Namen der zugewiesenen EVENTLINE-Techniker. Wird nach den
  // Bookings nachgeladen (eigene Anfragen + per RLS sichtbare Termine).
  const [assigneesByJobId, setAssigneesByJobId] = useState<Map<string, string[]>>(new Map());
  // Foreign-Vermietung-Detail-Modal — eigene Anfragen gehen ueber Link
  // auf die /partner/anfragen/[id]-Page, Vermietungen (kein Partner-Owner)
  // haben keine eigene Detail-Page → leichtes Modal mit Title/Datum/Kunde.
  const [vermietungDetail, setVermietungDetail] = useState<Booking | null>(null);

  // Visible Range: Start = erster Montag der Kalenderwoche des Monats-Ersten,
  // End = letzter Sonntag der Kalenderwoche des Monats-Letzten. So gibt's
  // immer ein vollstaendiges Wochen-Grid.
  const days = useMemo(() => monatsRaster(anchor), [anchor]);
  const gridStart = days[0];
  const gridEnd = days[days.length - 1];

  useEffect(() => {
    // Schnelles Blaettern: nur die Antwort des zuletzt gewaehlten Monats
    // darf den State setzen (sonst ueberschreibt eine langsame alte Antwort
    // die Liste mit Buchungen eines anderen Monats).
    let aktuell = true;
    (async () => {
      setLoading(true);
      // Abfrage-Fenster je einen Tag grosszuegiger (UTC-Mitternacht, ohne
      // Zeitzonen-Rechnerei) — die exakte Zuordnung auf Zurich-Tage passiert
      // unten ueber startTag/endTag, Buchungen ausserhalb des Rasters fallen
      // dort raus.
      const startIso = `${plusTage(gridStart, -1)}T00:00:00Z`;
      const endIso = `${plusTage(gridEnd, 2)}T00:00:00Z`;
      const r = await fetch(`/api/belegungsplan?start=${encodeURIComponent(startIso)}&end=${encodeURIComponent(endIso)}`);
      const j = r.ok ? await r.json() : { bookings: [] };
      if (!aktuell) return;
      const all: Booking[] = [];
      for (const b of (j.bookings ?? []) as ApiBooking[]) {
        if (!b.start_date || !b.location_id) continue;
        if (b.location_id !== locationId) continue;
        // Fremde stornierte Jobs raus (Location ist effektiv frei). Eigene
        // stornierte = abgelehnte Anfragen → behalten, damit der Partner
        // sieht "diesen Tag hatte ich angefragt, wurde abgelehnt".
        if (b.status === "storniert" && !b.is_own) continue;
        const kind = kindFromBooking(b);
        if (kind === null) continue; // fremde Nicht-Vermietungen ausblenden
        const start = new Date(b.start_date);
        const end = new Date(b.end_date ?? b.start_date);
        const startTag = localDateIso(start);
        const endTag = localDateIso(end);
        // Nur Buchungen, die mindestens einen Tag des Rasters beruehren.
        if (startTag > gridEnd || endTag < gridStart) continue;
        all.push({
          id: b.id,
          kind,
          title: b.title ?? (b.is_own ? "Anfrage" : "Vermietung"),
          customerName: b.customer_name,
          isOwn: b.is_own,
          status: b.status,
          start,
          end,
          startTag,
          endTag,
        });
      }
      setBookings(all);
      setLoading(false);

      // Termin-Assignees nachladen — fuer die Liste unten zeigen wir
      // pro Buchung wer von EVENTLINE zugewiesen ist. Nur eigene Anfragen
      // brauchen die Info (Vermietungen sind fremde Buchungen).
      const ownIds = all.filter((b) => b.isOwn).map((b) => b.id);
      if (ownIds.length === 0) {
        setAssigneesByJobId(new Map());
        return;
      }
      const [apptsRes, usersRes] = await Promise.all([
        supabase.from("job_appointments").select("job_id, assigned_to").in("job_id", ownIds),
        // SECURITY DEFINER: Partner darf profiles nicht direkt lesen (siehe
        // 053_profile_rls_tighten), aber get_assignable_users() bypasst RLS
        // mit den noetigen Public-Feldern (id, full_name).
        supabase.rpc("get_assignable_users"),
      ]);
      if (!aktuell) return;
      const nameById = new Map<string, string>();
      for (const u of (usersRes.data as { id: string; full_name: string }[] | null) ?? []) {
        nameById.set(u.id, u.full_name);
      }
      const m = new Map<string, string[]>();
      for (const a of (apptsRes.data as { job_id: string; assigned_to: string | null }[] | null) ?? []) {
        if (!a.assigned_to) continue;
        const name = nameById.get(a.assigned_to);
        if (!name) continue;
        const arr = m.get(a.job_id) ?? [];
        if (!arr.includes(name)) arr.push(name);
        m.set(a.job_id, arr);
      }
      setAssigneesByJobId(m);
    })();
    return () => {
      aktuell = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridStart, gridEnd, locationId]);

  // Buchungen pro Tag — fuer den Kalender-Cell-Look.
  function bookingsOn(tag: string): Booking[] {
    return bookings.filter((b) => laeuftAmTag(b.startTag, b.endTag, tag));
  }

  const today = todayLocalIso();
  const [anchorJahr, anchorMonat] = datumTeile(anchor);
  const monthLabel = `${MONTH_LONG[anchorMonat - 1]} ${anchorJahr}`;

  // Liste-Ansicht: alle Buchungen die VOLLSTAENDIG ODER PARTIELL im
  // sichtbaren Monatsraster liegen, sortiert nach Start aufsteigend.
  const visibleBookings = useMemo(() => {
    return [...bookings].sort((a, b) => a.start.getTime() - b.start.getTime());
  }, [bookings]);

  function prev() {
    setAnchor(monatsErster(anchor, -1));
  }
  function next() {
    setAnchor(monatsErster(anchor, 1));
  }
  function jumpToToday() {
    setAnchor(monatsErster(todayLocalIso()));
  }

  return (
    <div className="space-y-4">
      {/* Header — Monat-Nav, Heute-Button. Legende wurde nach unten ans
          Ende verschoben damit der Header fokussiert bleibt. */}
      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" onClick={prev} className="kasten kasten-muted" aria-label="Vorheriger Monat">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button type="button" onClick={jumpToToday} className="kasten kasten-muted">
          Heute
        </button>
        <button type="button" onClick={next} className="kasten kasten-muted" aria-label="Nächster Monat">
          <ChevronRight className="h-4 w-4" />
        </button>
        <h2 className="text-lg font-semibold ml-3">{monthLabel}</h2>
      </div>

      {/* Kalender-Grid */}
      <div className="rounded-xl border bg-card overflow-hidden">
        <div className="grid grid-cols-7 border-b bg-foreground/[0.02] dark:bg-foreground/[0.04]">
          {WEEKDAY_SHORT.map((wd) => (
            <div key={wd} className="px-2 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground text-center">
              {wd}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 auto-rows-fr">
          {days.map((day) => {
            const [, tagMonat, tagNr] = datumTeile(day);
            const isCurrentMonth = tagMonat === anchorMonat;
            const isToday = day === today;
            const dayBookings = bookingsOn(day);
            return (
              <div
                key={day}
                className={`min-h-[72px] p-1.5 max-md:min-h-[40px] max-md:p-1 border-b border-r border-foreground/10 dark:border-foreground/15 last:border-r-0 ${
                  isCurrentMonth ? "" : "bg-foreground/[0.02] dark:bg-foreground/[0.04]"
                }`}
              >
                {/* Heute-Kreis am Handy als Block (flex): inline-flex sitzt auf
                    der Textzeile der Zelle und rutscht 4 px unter die anderen Zahlen. */}
                <div className={`text-[11px] font-semibold mb-1 ${
                  isToday
                    ? "inline-flex max-md:flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white"
                    : isCurrentMonth ? "text-foreground" : "text-muted-foreground/60"
                }`}>
                  {tagNr}
                </div>
                <div className="hidden md:block space-y-0.5">
                  {dayBookings.slice(0, 3).map((b) => {
                    const kind = effectiveKind(b.kind, (assigneesByJobId.get(b.id) ?? []).length);
                    const s = KIND_STYLE[kind];
                    // "Continuation"-Erkennung: ist der Vortag schon Teil
                    // dieser Buchung? Dann nur Block, ohne Titel wiederholen.
                    const isContinuation = laeuftAmTag(b.startTag, b.endTag, plusTage(day, -1));
                    const clickable = kind !== "belegt";
                    const cls = `block w-full text-left text-[10px] font-medium px-1.5 py-0.5 rounded truncate ${s.bg} ${s.text} ${s.border} border ${clickable ? "hover:opacity-80 transition-opacity cursor-pointer" : "cursor-default"}`;
                    const label = isContinuation ? "↪" : (kind === "belegt" ? "Belegt" : b.title);
                    const titleAttr = `${kind === "belegt" ? "Belegt (EVENTLINE-intern)" : b.title} (${b.start.toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}${b.endTag !== b.startTag ? ` – ${b.end.toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}` : ""})`;
                    if (kind === "belegt") {
                      return (
                        <div key={b.id} className={cls} data-tooltip={titleAttr}>
                          {label}
                        </div>
                      );
                    }
                    return b.isOwn ? (
                      <Link key={b.id} href={`/partner/anfragen/${b.id}`} className={cls} data-tooltip={titleAttr}>
                        {label}
                      </Link>
                    ) : (
                      <button
                        key={b.id}
                        type="button"
                        onClick={() => setVermietungDetail(b)}
                        className={cls}
                        data-tooltip={titleAttr}
                      >
                        {label}
                      </button>
                    );
                  })}
                  {dayBookings.length > 3 && (
                    <div className="text-[9px] text-muted-foreground">+{dayBookings.length - 3}</div>
                  )}
                </div>
                {/* Handy: je Buchung nur ein Farbbalken, nicht klickbar — die
                    Zelle ist fuer Text und Tippen zu schmal. Bedient wird ueber
                    die Liste «Buchungen im sichtbaren Zeitraum» darunter. */}
                {dayBookings.length > 0 && (
                  <div className="md:hidden space-y-0.5" aria-hidden="true">
                    {dayBookings.slice(0, 3).map((b) => (
                      <span
                        key={b.id}
                        className={`block h-1.5 rounded-full ${KIND_STYLE[effectiveKind(b.kind, (assigneesByJobId.get(b.id) ?? []).length)].dot}`}
                      />
                    ))}
                    {dayBookings.length > 3 && (
                      <div className="text-[9px] text-muted-foreground">+{dayBookings.length - 3}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {loading && (
          <div className="p-3 flex items-center justify-center gap-2 text-xs text-muted-foreground border-t">
            <Spinner size={14} /> Lade…
          </div>
        )}

        {/* Legende — gruppiert nach Owner (Deine Anfragen / EVENTLINE)
            damit die doppelten Farb-Anwendungen (z.B. amber fuer
            Offene-Anfrage UND Bestaetigt-nicht-zugewiesen) durch den
            Kontext der Gruppe klar zugeordnet sind. */}
        <div className="border-t bg-foreground/[0.02] dark:bg-foreground/[0.04] px-3 py-2 text-[11px]">
          <div className="flex flex-col sm:flex-row sm:items-center gap-x-5 gap-y-1.5">
            <LegendGroup label="Deine Anfragen" kinds={["entwurf", "partner_anfrage", "bestaetigt_unzugewiesen", "bestaetigt", "storniert"]} />
            <span className="hidden sm:inline w-px h-3 bg-border" />
            <LegendGroup label="EVENTLINE" kinds={["vermietung", "belegt"]} />
          </div>
        </div>
      </div>

      {/* Modal: Read-Only-Details fuer fremde Vermietungen (EVENTLINE-
          Eintraege an der Location — Partner hat keine eigene Detail-Page
          dafuer, kleines Info-Modal reicht). */}
      <Modal
        open={!!vermietungDetail}
        onClose={() => setVermietungDetail(null)}
        title="Vermietung"
        size="md"
        sheet={isMobile === true}
      >
        {vermietungDetail && (() => {
          const b = vermietungDetail;
          const dateLabel = b.startTag === b.endTag
            ? b.start.toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", weekday: "long", day: "2-digit", month: "long", year: "numeric" })
            : `${b.start.toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" })} – ${b.end.toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" })}`;
          return (
            <div className="space-y-3 text-sm">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-0.5">Titel</p>
                <p className="font-medium">{b.title}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-0.5">Datum</p>
                <p>{dateLabel}</p>
              </div>
              {b.customerName && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-0.5">Kunde</p>
                  <p>{b.customerName}</p>
                </div>
              )}
              <p className="text-[11px] text-muted-foreground pt-1 border-t border-border">
                Diese Vermietung wurde von EVENTLINE eingetragen. Fragen oder Änderungen direkt bei EVENTLINE.
              </p>
            </div>
          );
        })()}
      </Modal>

      {/* Liste der Buchungen im sichtbaren Monat */}
      <div>
        <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
          <Calendar className="h-4 w-4 text-muted-foreground" />
          Buchungen im sichtbaren Zeitraum
          <span className="text-xs font-normal text-muted-foreground">({visibleBookings.length})</span>
        </h3>
        {visibleBookings.length === 0 ? (
          <div className="rounded-xl border border-dashed bg-card p-6 text-center text-sm text-muted-foreground">
            Keine Buchungen in diesem Monat.
          </div>
        ) : (
          <div className="space-y-1.5">
            {visibleBookings.map((b) => {
              const assignees = assigneesByJobId.get(b.id) ?? [];
              const kind = effectiveKind(b.kind, assignees.length);
              const s = KIND_STYLE[kind];
              const dateLabel = b.startTag === b.endTag
                ? b.start.toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" })
                : `${b.start.toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", weekday: "short", day: "2-digit", month: "2-digit" })} – ${b.end.toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" })}`;
              const clickable = kind !== "belegt";
              const cls = `flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border ${s.bg} ${s.text} ${s.border} ${clickable ? "hover:opacity-90 transition-opacity cursor-pointer" : "cursor-default"} text-left w-full`;
              const displayTitle = kind === "belegt" ? "Belegt (EVENTLINE-intern)" : b.title;
              const inner = (
                <>
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${s.dot}`} />
                    <div className="min-w-0">
                      {/* Am Handy bis zwei Zeilen statt abgeschnitten. */}
                      <p className="font-medium text-sm truncate max-md:whitespace-normal max-md:line-clamp-2">{displayTitle}</p>
                      <p className="text-[11px] opacity-80">
                        {dateLabel}
                        {assignees.length > 0 && (
                          <>
                            <span className="opacity-50"> · </span>
                            <span>Zugewiesen: {assignees.join(", ")}</span>
                          </>
                        )}
                      </p>
                    </div>
                  </div>
                  {/* Am Handy bricht ein langer Status («Bestätigt, nicht
                      zugewiesen») um, statt dem Titel den Platz zu nehmen. */}
                  <span className="text-[10px] font-medium uppercase tracking-wider opacity-70 shrink-0 max-md:max-w-[8.5rem] max-md:text-right">
                    {s.label}
                  </span>
                </>
              );
              if (kind === "belegt") {
                return (
                  <div key={b.id} className={cls}>
                    {inner}
                  </div>
                );
              }
              return b.isOwn ? (
                <Link key={b.id} href={`/partner/anfragen/${b.id}`} className={cls}>
                  {inner}
                </Link>
              ) : (
                <button key={b.id} type="button" onClick={() => setVermietungDetail(b)} className={cls}>
                  {inner}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// =====================================================================
// LegendGroup — kompakte Inline-Gruppe (Label + Dots)
// =====================================================================
interface LegendGroupProps {
  label: string;
  kinds: BookingKind[];
}
function LegendGroup({ label, kinds }: LegendGroupProps) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 shrink-0">
        {label}
      </span>
      {kinds.map((k) => {
        const s = KIND_STYLE[k];
        return (
          <span key={k} className="flex items-center gap-1.5 text-foreground/70">
            <span className={`w-2 h-2 rounded-full ${s.dot}`} />
            {s.label}
          </span>
        );
      })}
    </div>
  );
}
