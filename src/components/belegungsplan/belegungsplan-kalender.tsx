"use client";

/**
 * Belegungsplan-Kalender eines Standorts — EINE Komponente fuer das
 * Partnerportal (/partner/belegungsplan) und den internen Location-Tab
 * «Belegungsplan» (/standorte/[id]?tab=belegungsplan).
 *
 * Klassischer Monats-Kalender (7×5/6) mit farbigen Eintraegen je Art,
 * darunter die Liste aller Eintraege im sichtbaren Zeitraum:
 *  - termin  = eigener Termin des Standorts (blau), bearbeitbar wenn die
 *              API `bearbeitbar` liefert → Termin-Modal
 *  - anfrage = Partner-Anfrage, gefaerbt nach Workflow-Status wie bisher
 *  - auftrag = EVENTLINE-Auftrag am Standort (violett) mit Titel/Kunde/Status
 *  - belegt  = fremder Eintrag ohne Details (grau, nicht klickbar) —
 *              Partnersicht an Standorten ohne partner_kalender
 * anfrage/auftrag mit `link` fuehren auf die Detailseite.
 *
 * Daten und Schreiben kommen ueber `laden`/`speichern` vom Aufrufer
 * (Partner: /api/partner/**, intern: /api/standorte/[id]/**).
 * «Termin eintragen» und Klick auf einen leeren Tag nur bei `darfEintragen`.
 * Am Handy (< md) zeigt das Raster nur Farbbalken je Eintrag; geoeffnet
 * wird dort ueber die Liste darunter.
 * Der angezeigte Monat steht in der URL (?monat=YYYY-MM, §10) — per
 * history.replaceState, ohne Server-Request.
 */

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Calendar, CalendarX, Plus } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { PrefetchLink } from "@/components/shell/prefetch-link";
import { JOB_STATUS } from "@/lib/constants";
import { localDateIso, localTimeHM, plusTage, todayLocalIso, weekdayForDateIso, laeuftAmTag } from "@/lib/swiss-time";
import type { KalenderEintrag, TerminEingabeKalender } from "@/lib/standort-kalender";
import { TerminModal } from "./termin-modal";

export type KalenderLadeErgebnis =
  | { ok: true; eintraege: KalenderEintrag[]; darfEintragen: boolean }
  | { ok: false; fehler: string | null };
export type KalenderAktion = "anlegen" | "aendern" | "loeschen";
export type KalenderSpeicherErgebnis = { ok: boolean; fehler?: string | null; id?: string };

interface Props {
  /** Eintraege im Zeitraum [startIso, endIso) laden. Muss stabil sein (useCallback). */
  laden: (startIso: string, endIso: string) => Promise<KalenderLadeErgebnis>;
  speichern: (aktion: KalenderAktion, id?: string, eingabe?: TerminEingabeKalender) => Promise<KalenderSpeicherErgebnis>;
  /** Steuert nur Texte (Legende «Deine …» vs. «… Partner»). */
  modus: "partner" | "intern";
}

/** Darstellung: Art, bei Anfragen zusaetzlich nach Workflow-Status. */
type Stil =
  | "termin"
  | "entwurf"
  | "partner_anfrage"
  | "bestaetigt_unzugewiesen"
  | "bestaetigt"
  | "storniert"
  | "auftrag"
  | "belegt";

interface Eintrag extends KalenderEintrag {
  stil: Stil;
  /** Echte Zeitpunkte — nur fuer Anzeige/Sortierung. */
  startDatum: Date;
  endeDatum: Date;
  /** Zurich-Kalendertage YYYY-MM-DD (Ende inklusiv) — fuer die Tages-Zuordnung. */
  startTag: string;
  endTag: string;
  /** Nur Tage, keine echte Uhrzeit (Auftraege/Anfragen ohne Termin liegen
   *  auf Zuercher Mitternacht) — dann keine «00:00–00:00» anzeigen. */
  ohneZeit: boolean;
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
function monatsRaster(ersterDesMonats: string): string[] {
  const start = plusTage(ersterDesMonats, -wochentagMo0(ersterDesMonats));
  const letzter = plusTage(monatsErster(ersterDesMonats, 1), -1);
  const ende = plusTage(letzter, 6 - wochentagMo0(letzter));
  const tage: string[] = [];
  for (let t = start; t <= ende; t = plusTage(t, 1)) tage.push(t);
  return tage;
}

function stilVon(e: KalenderEintrag): Stil {
  switch (e.art) {
    case "termin":
      return "termin";
    case "auftrag":
      return "auftrag";
    case "belegt":
      return "belegt";
    case "anfrage":
      if (e.status === "partner_entwurf") return "entwurf";
      if (e.status === "partner_anfrage") return "partner_anfrage";
      if (e.status === "storniert") return "storniert";
      // status offen/abgeschlossen → angenommen; gruen erst mit Zuteilung.
      return e.zugewiesen.length > 0 ? "bestaetigt" : "bestaetigt_unzugewiesen";
  }
}

// Farben je Art — hell dezent, dunkel kraeftiger (Regel §3).
const STIL: Record<Stil, { dot: string; bg: string; text: string; border: string; label: string }> = {
  // Eigener Termin des Standorts: blau.
  termin:          { dot: "bg-blue-500", bg: "bg-blue-50 dark:bg-blue-500/20", text: "text-blue-800 dark:text-blue-200", border: "border-blue-200 dark:border-blue-400/40", label: "Termin" },
  entwurf:         { dot: "bg-gray-400 dark:bg-gray-500", bg: "bg-foreground/[0.05] dark:bg-foreground/10", text: "text-muted-foreground", border: "border-foreground/15 dark:border-foreground/20", label: "Entwurf" },
  partner_anfrage: { dot: "bg-amber-500",  bg: "bg-amber-50 dark:bg-amber-500/15",   text: "text-amber-800 dark:text-amber-300",     border: "border-amber-200 dark:border-amber-500/30",     label: "Offene Anfrage" },
  // Gelb = angenommen aber noch keiner zugewiesen.
  bestaetigt_unzugewiesen: { dot: "bg-amber-500", bg: "bg-amber-50 dark:bg-amber-500/15", text: "text-amber-800 dark:text-amber-300", border: "border-amber-200 dark:border-amber-500/30", label: "Bestätigt, nicht zugewiesen" },
  // Gruen = angenommen UND mindestens ein Mitarbeiter zugewiesen.
  bestaetigt:      { dot: "bg-green-500",  bg: "bg-green-50 dark:bg-green-500/15",   text: "text-green-800 dark:text-green-300",     border: "border-green-200 dark:border-green-500/30",     label: "Bestätigt" },
  storniert:       { dot: "bg-red-500",    bg: "bg-red-50 dark:bg-red-500/15",       text: "text-red-800 dark:text-red-300",         border: "border-red-200 dark:border-red-500/30",         label: "Abgelehnt" },
  // EVENTLINE-Auftrag am Standort (mit Details): violett.
  auftrag:         { dot: "bg-violet-500", bg: "bg-violet-50 dark:bg-violet-500/20", text: "text-violet-800 dark:text-violet-200", border: "border-violet-200 dark:border-violet-400/40", label: "Auftrag" },
  // Fremder Eintrag ohne Details — neutral grau, keine Klick-Aktion.
  belegt:          { dot: "bg-foreground/40", bg: "bg-foreground/[0.06] dark:bg-foreground/10", text: "text-foreground/70", border: "border-foreground/15 dark:border-foreground/20", label: "Belegt" },
};

const ANFRAGE_STILE: Stil[] = ["entwurf", "partner_anfrage", "bestaetigt_unzugewiesen", "bestaetigt", "storniert"];

/** Statustext rechts in der Liste. */
function statusText(e: Eintrag): string {
  if (e.stil === "auftrag") {
    const s = e.status ? JOB_STATUS[e.status as keyof typeof JOB_STATUS]?.label : null;
    return s ? `Auftrag · ${s}` : "Auftrag";
  }
  return STIL[e.stil].label;
}

// «Fr., 06.11.2026» bzw. ohne Jahr — immer im Zuercher Kalender.
const TAG_MIT_JAHR = new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
const TAG_OHNE_JAHR = new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", weekday: "short", day: "2-digit", month: "2-digit" });

function datumKurz(d: Date, mitJahr: boolean): string {
  return (mitJahr ? TAG_MIT_JAHR : TAG_OHNE_JAHR).format(d);
}

/** Zeit fuer die Kalenderzelle: «18:00–23:00», «ab 18:00» oder «ganztägig». */
function zeitKurz(e: Eintrag): string | null {
  if (e.ganztaegig) return "ganztägig";
  if (e.ohneZeit) return null;
  const von = localTimeHM(e.startDatum);
  if (!e.ende) return von;
  return e.startTag === localDateIso(e.endeDatum) || e.endTag === e.startTag
    ? `${von}–${localTimeHM(e.endeDatum)}`
    : `ab ${von}`;
}

/** Datum + Zeit fuer Liste und Tooltip. */
function zeitraumText(e: Eintrag): string {
  // Fremde Belegungen wie bisher nur mit Tagen.
  if (e.stil === "belegt" || e.ganztaegig || e.ohneZeit) {
    const tage = e.startTag === e.endTag
      ? datumKurz(e.startDatum, true)
      : `${datumKurz(e.startDatum, false)} – ${datumKurz(e.endeDatum, true)}`;
    return e.ganztaegig && e.stil !== "belegt" ? `${tage} · ganztägig` : tage;
  }
  const von = localTimeHM(e.startDatum);
  if (!e.ende) return `${datumKurz(e.startDatum, true)} · ${von}`;
  const bis = localTimeHM(e.endeDatum);
  if (e.startTag === e.endTag) return `${datumKurz(e.startDatum, true)} · ${von}–${bis}`;
  return `${datumKurz(e.startDatum, false)} ${von} – ${datumKurz(e.endeDatum, true)} ${bis}`;
}

function tooltipText(e: Eintrag): string {
  if (e.stil === "belegt") return `Belegt (EVENTLINE-intern) · ${zeitraumText(e)}`;
  return [
    e.titel,
    e.kunde,
    zeitraumText(e),
    e.zugewiesen.length > 0 ? `Zugewiesen: ${e.zugewiesen.join(", ")}` : null,
  ].filter(Boolean).join(" · ");
}

/** Monat aus ?monat=YYYY-MM, sonst der aktuelle. */
function monatAusUrl(wert: string | null): string {
  return wert && /^\d{4}-(0[1-9]|1[0-2])$/.test(wert) ? `${wert}-01` : monatsErster(todayLocalIso());
}

export function BelegungsplanKalender({ laden, speichern, modus }: Props) {
  const searchParams = useSearchParams();
  // Angezeigter Monat als Zurich-Kalendertag YYYY-MM-01 — Quelle ist die URL.
  const anchor = monatAusUrl(searchParams.get("monat"));
  const [eintraege, setEintraege] = useState<Eintrag[]>([]);
  const [darfEintragen, setDarfEintragen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [ladeFehler, setLadeFehler] = useState(false);
  const [neuLaden, setNeuLaden] = useState(0);
  const [hoverTag, setHoverTag] = useState<string | null>(null);
  // Termin-Modal: key erzwingt pro Oeffnen einen frischen Formular-Zustand.
  const [modal, setModal] = useState<{ key: number; eintrag: KalenderEintrag | null; datum: string } | null>(null);

  // Vollstaendige Wochen von Montag bis Sonntag.
  const days = useMemo(() => monatsRaster(anchor), [anchor]);
  const gridStart = days[0];
  const gridEnd = days[days.length - 1];

  useEffect(() => {
    // Schnelles Blaettern: nur die Antwort des zuletzt gewaehlten Monats
    // darf den State setzen.
    let aktuell = true;
    (async () => {
      setLoading(true);
      // Abfrage-Fenster je einen Tag grosszuegiger (UTC-Mitternacht) — die
      // exakte Zuordnung auf Zurich-Tage passiert unten ueber startTag/endTag.
      const r = await laden(`${plusTage(gridStart, -1)}T00:00:00Z`, `${plusTage(gridEnd, 2)}T00:00:00Z`);
      if (!aktuell) return;
      // Ein Fehler ist nie «alles frei»: Hinweis statt leerer Monat.
      setLadeFehler(!r.ok);
      if (!r.ok) {
        toast.error(r.fehler ?? "Belegungsplan konnte nicht geladen werden");
        setEintraege([]);
        setDarfEintragen(false);
        setLoading(false);
        return;
      }
      const alle: Eintrag[] = [];
      for (const e of r.eintraege) {
        if (!e.start) continue;
        const startDatum = new Date(e.start);
        const endeDatum = new Date(e.ende ?? e.start);
        if (Number.isNaN(startDatum.getTime()) || Number.isNaN(endeDatum.getTime())) continue;
        const startTag = localDateIso(startDatum);
        let endTag = localDateIso(endeDatum);
        // Endet ein eigener Termin mit Zeit genau um Mitternacht, belegt er
        // den Folgetag nicht. Nur fuer Termine: Auftraege/Anfragen fuehren
        // ihr Enddatum als Mitternacht des letzten Tags (inklusiv).
        if (e.art === "termin" && !e.ganztaegig && endTag > startTag && localTimeHM(endeDatum) === "00:00") endTag = plusTage(endTag, -1);
        if (endTag < startTag) endTag = startTag;
        // Nur Eintraege, die mindestens einen Tag des Rasters beruehren.
        if (startTag > gridEnd || endTag < gridStart) continue;
        const ohneZeit = !e.ganztaegig
          && localTimeHM(startDatum) === "00:00"
          && (!e.ende || ["00:00", "23:59"].includes(localTimeHM(endeDatum)));
        alle.push({ ...e, stil: stilVon(e), startDatum, endeDatum, startTag, endTag, ohneZeit });
      }
      alle.sort((a, b) => a.startDatum.getTime() - b.startDatum.getTime());
      setEintraege(alle);
      setDarfEintragen(r.darfEintragen);
      setLoading(false);
    })();
    return () => {
      aktuell = false;
    };
  }, [gridStart, gridEnd, laden, neuLaden]);

  function eintraegeAm(tag: string): Eintrag[] {
    return eintraege.filter((e) => laeuftAmTag(e.startTag, e.endTag, tag));
  }

  const today = todayLocalIso();
  const [anchorJahr, anchorMonat] = datumTeile(anchor);
  const monthLabel = `${MONTH_LONG[anchorMonat - 1]} ${anchorJahr}`;

  /** Monat in die URL schreiben (ohne Server-Request); null = aktueller Monat. */
  function zeigeMonat(ersterTag: string | null) {
    const params = new URLSearchParams(window.location.search);
    if (ersterTag && ersterTag !== monatsErster(todayLocalIso())) params.set("monat", ersterTag.slice(0, 7));
    else params.delete("monat");
    const qs = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }

  function neuerTermin(datum: string) {
    setModal({ key: Date.now(), eintrag: null, datum });
  }
  function bearbeiten(e: KalenderEintrag) {
    setModal({ key: Date.now(), eintrag: e, datum: localDateIso(new Date(e.start)) });
  }

  // Legende: an freigeschalteten Standorten (oder sobald Termine/Auftraege
  // geliefert werden) alle Arten, sonst wie bisher nur Anfragen + «Belegt».
  const hatStil = (s: Stil) => eintraege.some((e) => e.stil === s);
  const erweitert = darfEintragen || modus === "intern" || hatStil("termin") || hatStil("auftrag");
  const eventlineStile: Stil[] = erweitert ? (hatStil("belegt") ? ["auftrag", "belegt"] : ["auftrag"]) : ["belegt"];
  const wer = modus === "partner" ? { termine: "Deine Termine", anfragen: "Deine Anfragen" } : { termine: "Termine Partner", anfragen: "Anfragen Partner" };

  return (
    <div className="space-y-4">
      {/* Kopf — Monat-Nav, Heute; rechts «Termin eintragen» (nur mit Recht). */}
      <div className="flex items-center gap-2 flex-wrap">
        <button type="button" onClick={() => zeigeMonat(monatsErster(anchor, -1))} className="kasten kasten-muted" aria-label="Vorheriger Monat">
          <ChevronLeft className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => zeigeMonat(null)} className="kasten kasten-muted">
          Heute
        </button>
        <button type="button" onClick={() => zeigeMonat(monatsErster(anchor, 1))} className="kasten kasten-muted" aria-label="Nächster Monat">
          <ChevronRight className="h-4 w-4" />
        </button>
        <h2 className="text-lg font-semibold ml-3 max-md:ml-1">{monthLabel}</h2>
        {darfEintragen && (
          <button
            type="button"
            onClick={() => neuerTermin(today.startsWith(anchor.slice(0, 7)) ? today : anchor)}
            className="kasten kasten-red ml-auto max-md:ml-0 max-md:w-full max-md:justify-center"
          >
            <Plus className="h-3.5 w-3.5" />
            Termin eintragen
          </button>
        )}
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
            const dayEintraege = eintraegeAm(day);
            // Leerer Tag antippen = Termin an diesem Tag eintragen.
            const leerKlickbar = darfEintragen && !loading && !ladeFehler && dayEintraege.length === 0;
            return (
              <div
                key={day}
                onClick={leerKlickbar ? () => neuerTermin(day) : undefined}
                onMouseEnter={leerKlickbar ? () => setHoverTag(day) : undefined}
                onMouseLeave={leerKlickbar ? () => setHoverTag(null) : undefined}
                role={leerKlickbar ? "button" : undefined}
                aria-label={leerKlickbar ? `Termin am ${tagNr}. eintragen` : undefined}
                className={`relative min-h-[72px] p-1.5 max-md:min-h-[40px] max-md:p-1 border-b border-r border-foreground/10 dark:border-foreground/15 last:border-r-0 ${
                  isCurrentMonth ? "" : "bg-foreground/[0.02] dark:bg-foreground/[0.04]"
                } ${leerKlickbar ? "row-hover [--row-hover-x:0px] [--row-hover-radius:0] cursor-pointer" : ""}`}
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
                {leerKlickbar && hoverTag === day && (
                  <Plus className="hidden md:block absolute top-1.5 right-1.5 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                )}
                <div className="hidden md:block space-y-0.5">
                  {dayEintraege.slice(0, 3).map((e) => {
                    const s = STIL[e.stil];
                    // Fortsetzung vom Vortag: nur Block, Titel nicht wiederholen.
                    const fortsetzung = laeuftAmTag(e.startTag, e.endTag, plusTage(day, -1));
                    const unter = e.stil === "belegt" || fortsetzung
                      ? null
                      : [zeitKurz(e), e.kunde].filter(Boolean).join(" · ");
                    return (
                      <EintragKlick
                        key={e.id}
                        eintrag={e}
                        onBearbeiten={bearbeiten}
                        tooltip={tooltipText(e)}
                        className={`block w-full text-left text-[10px] leading-tight px-1.5 py-0.5 rounded border ${s.bg} ${s.text} ${s.border}`}
                      >
                        <span className="block truncate font-medium">
                          {fortsetzung ? "↪" : e.stil === "belegt" ? "Belegt" : e.titel}
                        </span>
                        {unter && <span className="block truncate opacity-75">{unter}</span>}
                      </EintragKlick>
                    );
                  })}
                  {dayEintraege.length > 3 && (
                    <div className="text-[9px] text-muted-foreground">+{dayEintraege.length - 3}</div>
                  )}
                </div>
                {/* Handy: je Eintrag nur ein Farbbalken, nicht klickbar — die
                    Zelle ist fuer Text und Tippen zu schmal. Bedient wird ueber
                    die Liste darunter. */}
                {dayEintraege.length > 0 && (
                  <div className="md:hidden space-y-0.5" aria-hidden="true">
                    {dayEintraege.slice(0, 3).map((e) => (
                      <span key={e.id} className={`block h-1.5 rounded-full ${STIL[e.stil].dot}`} />
                    ))}
                    {dayEintraege.length > 3 && (
                      <div className="text-[9px] text-muted-foreground">+{dayEintraege.length - 3}</div>
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

        {/* Legende — gruppiert nach Herkunft, damit doppelte Farben (amber
            fuer Offene Anfrage UND Bestaetigt-nicht-zugewiesen) durch den
            Kontext der Gruppe klar zugeordnet sind. */}
        <div className="border-t bg-foreground/[0.02] dark:bg-foreground/[0.04] px-3 py-2 text-[11px]">
          <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-x-5 gap-y-1.5">
            {erweitert && (
              <>
                <LegendGroup label={wer.termine} stile={["termin"]} />
                <span className="hidden sm:inline w-px h-3 bg-border" />
              </>
            )}
            <LegendGroup label={wer.anfragen} stile={ANFRAGE_STILE} />
            <span className="hidden sm:inline w-px h-3 bg-border" />
            <LegendGroup label="EVENTLINE" stile={eventlineStile} />
          </div>
        </div>
      </div>

      {/* Liste der Eintraege im sichtbaren Zeitraum */}
      <div>
        <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
          <Calendar className="h-4 w-4 text-muted-foreground" />
          Einträge im sichtbaren Zeitraum
          <span className="text-xs font-normal text-muted-foreground">({eintraege.length})</span>
        </h3>
        {ladeFehler ? (
          <div className="rounded-xl border border-dashed bg-card p-6 text-center text-sm text-muted-foreground">
            Belegungsplan konnte nicht geladen werden — bitte die Seite neu laden.
          </div>
        ) : eintraege.length === 0 ? (
          loading ? null : (
            <div className="rounded-xl border border-dashed bg-card">
              <EmptyState
                icon={CalendarX}
                title="Keine Einträge in diesem Monat"
                description={darfEintragen ? "Tippe auf einen Tag oder auf «Termin eintragen»." : undefined}
              />
            </div>
          )
        ) : (
          <div className="space-y-1.5">
            {eintraege.map((e) => {
              const s = STIL[e.stil];
              return (
                <EintragKlick
                  key={e.id}
                  eintrag={e}
                  onBearbeiten={bearbeiten}
                  className={`flex items-center justify-between gap-3 px-3 py-2.5 max-md:py-[7px] max-md:min-h-[46px] rounded-lg border ${s.bg} ${s.text} ${s.border} text-left w-full`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${s.dot}`} />
                    <div className="min-w-0">
                      {/* Am Handy bis zwei Zeilen statt abgeschnitten. */}
                      <p className="font-medium text-sm truncate max-md:whitespace-normal max-md:line-clamp-2">
                        {e.stil === "belegt" ? "Belegt (EVENTLINE-intern)" : e.titel}
                      </p>
                      {e.kunde && <p className="text-[11px] opacity-90 truncate">{e.kunde}</p>}
                      <p className="text-[11px] opacity-80">
                        {zeitraumText(e)}
                        {e.zugewiesen.length > 0 && (
                          <>
                            <span className="opacity-50"> · </span>
                            <span>Zugewiesen: {e.zugewiesen.join(", ")}</span>
                          </>
                        )}
                      </p>
                    </div>
                  </div>
                  {/* Am Handy bricht ein langer Status um, statt dem Titel den Platz zu nehmen. */}
                  <span className="text-[10px] font-medium uppercase tracking-wider opacity-70 shrink-0 max-md:max-w-[8.5rem] max-md:text-right">
                    {statusText(e)}
                  </span>
                </EintragKlick>
              );
            })}
          </div>
        )}
      </div>

      {modal && (
        <TerminModal
          key={modal.key}
          open
          eintrag={modal.eintrag}
          datumVorgabe={modal.datum}
          onClose={() => setModal(null)}
          onFertig={() => {
            setModal(null);
            setNeuLaden((n) => n + 1);
          }}
          speichern={speichern}
        />
      )}
    </div>
  );
}

// =====================================================================
// EintragKlick — rendert einen Eintrag je nach Ziel als Link (anfrage/
// auftrag mit link), als Knopf (eigener Termin, bearbeitbar) oder als
// nicht klickbaren Block. Hover state-driven per inline-style (§3).
// =====================================================================
function EintragKlick({
  eintrag,
  onBearbeiten,
  className,
  tooltip,
  children,
}: {
  eintrag: Eintrag;
  onBearbeiten: (e: KalenderEintrag) => void;
  className: string;
  tooltip?: string;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const link = (eintrag.art === "anfrage" || eintrag.art === "auftrag") && eintrag.link ? eintrag.link : null;
  const editierbar = eintrag.art === "termin" && eintrag.bearbeitbar;
  const klickbar = !!link || editierbar;
  const style: React.CSSProperties = klickbar
    ? { opacity: hover ? 0.8 : 1, transition: "opacity 150ms", cursor: "pointer" }
    : { cursor: "default" };
  const hoverProps = klickbar
    ? { onPointerEnter: () => setHover(true), onPointerLeave: () => setHover(false) }
    : {};

  if (link) {
    return (
      <PrefetchLink href={link} className={className} style={style} data-tooltip={tooltip} {...hoverProps}>
        {children}
      </PrefetchLink>
    );
  }
  if (editierbar) {
    return (
      <button
        type="button"
        onClick={() => onBearbeiten(eintrag)}
        className={className}
        style={style}
        data-tooltip={tooltip}
        {...hoverProps}
      >
        {children}
      </button>
    );
  }
  return (
    <div className={className} style={style} data-tooltip={tooltip}>
      {children}
    </div>
  );
}

// =====================================================================
// LegendGroup — kompakte Inline-Gruppe (Label + Dots)
// =====================================================================
function LegendGroup({ label, stile }: { label: string; stile: Stil[] }) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 shrink-0">
        {label}
      </span>
      {stile.map((k) => {
        const s = STIL[k];
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
