"use client";

/**
 * Kalender eines Standorts — EINE Komponente fuer das Partnerportal
 * (/partner/kalender) und den internen Location-Tab «Kalender»
 * (/standorte/[id]?tab=belegungsplan). Vorlage: freigegebene Skizze
 * (Mischa 05.11.2026, docs/barakuba/VERTRAG-KALENDER.md).
 *
 * Klassischer Monats-Kalender (7×5/6), darunter die Liste im sichtbaren
 * Zeitraum. Nur drei Farben (Mischa: «einfacher halten»):
 *  - blau    = eigene Eintraege des Standorts: termin, veranstaltung (↻ bei
 *              Serien), programm (Ticket-Icon) — bearbeitbar wenn die API
 *              `bearbeitbar` liefert
 *  - amber   = Partner-Anfragen, Status als Wort (Entwurf gestrichelt,
 *              abgelehnt grau + durchgestrichen); Link auf die Anfrage
 *  - violett = EVENTLINE-Auftrag am Standort
 *  - grau    = «belegt» ohne Details (Partner an Standorten ohne Kalender)
 * Dazu der Uebernahme-Zeitraum («EVENTLINE uebernimmt alle Privat-
 * vermietungen») als gruen getoentes Band mit Kanten, Wochen-Label und
 * Chip neben dem Monat, und die Verfuegbarkeit EVENTLINE je Tag:
 * «nicht verfügbar» = neutrale Schraffur, «knapp» = leiser Text. Intern
 * zusaetzlich die Liste der Engpaesse mit Namen und Gruenden.
 *
 * Daten und Schreiben kommen ueber `api` vom Aufrufer (Partner:
 * /api/partner/**, intern: /api/standorte/[id]/**, siehe kalender-api.ts).
 * «Eintrag erstellen» und Klick auf einen leeren Tag nur bei `darfEintragen`.
 * Am Handy (< md) zeigt das Raster nur Farbbalken je Eintrag; geoeffnet
 * wird dort ueber die Liste darunter.
 * Der angezeigte Monat steht in der URL (?monat=YYYY-MM, §10) — per
 * history.replaceState, ohne Server-Request.
 */

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ChevronLeft, ChevronRight, Calendar, CalendarX, Plus, Repeat, Ticket, Users } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/ui/empty-state";
import { PrefetchLink } from "@/components/shell/prefetch-link";
import { JOB_STATUS } from "@/lib/constants";
import { localDateIso, localTimeHM, plusTage, todayLocalIso, weekdayForDateIso, laeuftAmTag } from "@/lib/swiss-time";
import { zuerichZuIso } from "@/lib/stempel-meldungen";
import type { KalenderEintrag, TagVerfuegbarkeit, Uebernahme } from "@/lib/standort-kalender";
import type { KalenderApi } from "./kalender-api";
import { EintragModal, type ModalArt } from "./eintrag-modal";
import { ErstellenModal, type ErstellenWahl } from "./erstellen-modal";
import { UebernahmeModal } from "./uebernahme-modal";
import { ProgrammheftModal } from "./programmheft-modal";

interface Props {
  /** Kalender-Aufrufe (kalenderApi(basis), ggf. vom Aufrufer angepasst). Muss stabil sein (useMemo). */
  api: KalenderApi;
  /** Steuert Texte (Legende «Deine …» vs. «… Partner») und die interne Engpass-Liste. */
  modus: "partner" | "intern";
  /** Name der Location (Hinweistext im Uebernahme-Modal). */
  ortName?: string | null;
  /** Nur intern: Zeile ueber der Engpass-Liste (wer eingeteilt ist, Link zur Einteilung). */
  einteilungHinweis?: React.ReactNode;
}

/** Darstellung: Art, bei Anfragen zusaetzlich nach Workflow-Status. */
type Stil =
  | "termin"
  | "veranstaltung"
  | "programm"
  | "entwurf"
  | "partner_anfrage"
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
    case "veranstaltung":
    case "programm":
    case "auftrag":
    case "belegt":
      return e.art;
    case "anfrage":
      if (e.status === "partner_entwurf") return "entwurf";
      if (e.status === "partner_anfrage") return "partner_anfrage";
      if (e.status === "storniert") return "storniert";
      // status offen/abgeschlossen → angenommen.
      return "bestaetigt";
  }
}

const EIGENE_ARTEN = new Set<KalenderEintrag["art"]>(["termin", "veranstaltung", "programm"]);

// Nur drei Farben (Mischa 2026-11-05: «einfacher halten»):
//  blau    = eigene Eintraege (Termin, Veranstaltung, Programm — Unterschied nur per Mini-Icon)
//  amber   = Anfragen (Status als Wort; Entwurf gestrichelt, abgelehnt grau + durchgestrichen)
//  violett = EVENTLINE-Auftrag
// Hell dezent, dunkel kraeftiger (Regel §3).
const BLAU = { dot: "bg-blue-500", bg: "bg-blue-50 dark:bg-blue-500/20", text: "text-blue-800 dark:text-blue-200", border: "border-blue-200 dark:border-blue-400/40" };
const AMBER = { dot: "bg-amber-500", bg: "bg-amber-50 dark:bg-amber-500/15", text: "text-amber-800 dark:text-amber-300", border: "border-amber-200 dark:border-amber-500/30" };
const GRAU = { dot: "bg-foreground/30", bg: "bg-foreground/[0.04] dark:bg-foreground/[0.08]", text: "text-muted-foreground", border: "border-foreground/15 dark:border-foreground/20" };
const STIL: Record<Stil, { dot: string; bg: string; text: string; border: string; label: string }> = {
  termin:          { ...BLAU, label: "Termin" },
  veranstaltung:   { ...BLAU, label: "Veranstaltung" },
  programm:        { ...BLAU, label: "Programm" },
  entwurf:         { ...AMBER, border: "border-dashed border-amber-400 dark:border-amber-500/50", label: "Entwurf" },
  partner_anfrage: { ...AMBER, label: "wartet" },
  bestaetigt:      { ...AMBER, label: "bestätigt" },
  storniert:       { ...GRAU, label: "abgelehnt" },
  auftrag:         { dot: "bg-violet-500", bg: "bg-violet-50 dark:bg-violet-500/20", text: "text-violet-800 dark:text-violet-200", border: "border-violet-200 dark:border-violet-400/40", label: "Auftrag" },
  // Fremder Eintrag ohne Details — neutral grau, keine Klick-Aktion.
  belegt:          { dot: "bg-foreground/40", bg: "bg-foreground/[0.06] dark:bg-foreground/10", text: "text-foreground/70", border: "border-foreground/15 dark:border-foreground/20", label: "Belegt" },
};

const ANFRAGE_STILE_SET = new Set<Stil>(["entwurf", "partner_anfrage", "bestaetigt", "storniert"]);

// Uebernahme-Band (gedaempftes Gruen) und neutrale «nicht verfügbar»-Schraffur.
const BAND = {
  tint: "bg-emerald-500/[0.04] dark:bg-emerald-400/[0.08]",
  kante: "bg-emerald-600/60 dark:bg-emerald-400/55",
  text: "text-emerald-700 dark:text-emerald-300",
  chip: "border-emerald-600/30 dark:border-emerald-400/30 bg-emerald-500/[0.06] dark:bg-emerald-400/[0.10] text-emerald-800 dark:text-emerald-300",
  linie: "bg-emerald-600/45 dark:bg-emerald-400/40",
  zeile: "bg-card text-foreground border-foreground/15 dark:border-foreground/20",
};
const SCHRAFFUR =
  "bg-[image:repeating-linear-gradient(135deg,rgba(0,0,0,0.08)_0_5px,transparent_5px_10px)] dark:bg-[image:repeating-linear-gradient(135deg,rgba(255,255,255,0.16)_0_5px,transparent_5px_10px)]";
const UEB_TOOLTIP = "EVENTLINE übernimmt in dieser Zeit alle Privatvermietungen";
const NV_TOOLTIP_PARTNER = "EVENTLINE nicht verfügbar — an diesem Tag ist niemand aus deinem EVENTLINE-Team frei (abwesend oder anderer Einsatz).";
const KNAPP_TOOLTIP_PARTNER = "EVENTLINE knapp — an diesem Tag ist nur eine Person aus deinem EVENTLINE-Team frei.";

/** Statustext rechts in der Liste. */
function statusText(e: Eintrag): string {
  if (e.stil === "auftrag") {
    const s = e.status ? JOB_STATUS[e.status as keyof typeof JOB_STATUS]?.label : null;
    return s ? `Auftrag · ${s}` : "Auftrag";
  }
  if (ANFRAGE_STILE_SET.has(e.stil)) return `Anfrage · ${STIL[e.stil].label}`;
  if (e.stil === "veranstaltung" && e.wiederkehrend) return "Veranstaltung · Serie";
  return STIL[e.stil].label;
}

/** Kleines Icon vor dem Titel: Serie ↻, Programm Ticket, sonst nichts. */
function ArtIcon({ e, className }: { e: Eintrag; className: string }) {
  if (e.wiederkehrend) return <Repeat className={className} aria-hidden="true" />;
  if (e.stil === "programm") return <Ticket className={className} aria-hidden="true" />;
  return null;
}

// «Fr., 06.11.2026» bzw. ohne Jahr — immer im Zuercher Kalender.
const TAG_MIT_JAHR = new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
const TAG_OHNE_JAHR = new Intl.DateTimeFormat("de-CH", { timeZone: "Europe/Zurich", weekday: "short", day: "2-digit", month: "2-digit" });

function datumKurz(d: Date, mitJahr: boolean): string {
  return (mitJahr ? TAG_MIT_JAHR : TAG_OHNE_JAHR).format(d);
}
/** Kalendertag YYYY-MM-DD als Date (Mittag — im Zuercher Kalender sicher derselbe Tag). */
function tagDatum(tag: string): Date {
  return new Date(`${tag}T12:00:00Z`);
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

/** Nur intern: Auftrag im Vermietungs-Ablauf, den der Partner noch nicht sieht. */
function ablaufText(e: Eintrag): string | null {
  return e.ablauf?.verborgen ? `Schritt ${e.ablauf.schritt} · für den Partner noch verborgen` : null;
}

function tooltipText(e: Eintrag): string {
  if (e.stil === "belegt") return `Belegt (EVENTLINE-intern) · ${zeitraumText(e)}`;
  const anfrage = ANFRAGE_STILE_SET.has(e.stil);
  return [
    e.stil === "auftrag" ? `EVENTLINE-Auftrag: ${e.titel}` : anfrage ? `Anfrage: ${e.titel}` : e.titel,
    anfrage ? STIL[e.stil].label : e.stil === "programm" ? "Programm" : null,
    e.kunde,
    zeitraumText(e),
    e.wiederkehrend ? "wiederkehrend" : null,
    e.zugewiesen.length > 0 ? `Zugewiesen: ${e.zugewiesen.join(", ")}` : null,
    ablaufText(e),
  ].filter(Boolean).join(" · ");
}

function uebernahmeZeitraum(u: Uebernahme): string {
  return u.von === u.bis
    ? datumKurz(tagDatum(u.von), true)
    : `${datumKurz(tagDatum(u.von), false)} – ${datumKurz(tagDatum(u.bis), true)}`;
}

/** «01.–31.12.2026», «28.11.–06.12.2026» oder «21.11.2026». */
function uebernahmeKurz(u: Uebernahme): string {
  const [vy, vm, vd] = u.von.split("-");
  const [by, bm, bd] = u.bis.split("-");
  if (u.von === u.bis) return `${vd}.${vm}.${vy}`;
  if (vy === by && vm === bm) return `${vd}.–${bd}.${bm}.${by}`;
  if (vy === by) return `${vd}.${vm}.–${bd}.${bm}.${by}`;
  return `${vd}.${vm}.${vy}–${bd}.${bm}.${by}`;
}

/** Monat aus ?monat=YYYY-MM, sonst der aktuelle. */
function monatAusUrl(wert: string | null): string {
  return wert && /^\d{4}-(0[1-9]|1[0-2])$/.test(wert) ? `${wert}-01` : monatsErster(todayLocalIso());
}

function sortWert(tag: string): number {
  return new Date(zuerichZuIso(tag, "00:00") ?? `${tag}T00:00:00Z`).getTime();
}

type Offen =
  | { typ: "wahl"; datum: string; vomTag: boolean }
  | { typ: "eintrag"; key: number; art: ModalArt; eintrag: KalenderEintrag | null; datum: string }
  | { typ: "uebernahme"; key: number; eintrag: Uebernahme | null; datum: string }
  | { typ: "programmheft"; key: number };

type ListenZeile =
  | { typ: "eintrag"; key: string; sort: number; e: Eintrag }
  | { typ: "uebernahme"; key: string; sort: number; u: Uebernahme }
  | { typ: "nv"; key: string; sort: number; v: TagVerfuegbarkeit };

/** Frischer key je Oeffnen eines Modals (Formular startet neu). */
let modalKey = 0;
function naechsterKey(): number {
  modalKey += 1;
  return modalKey;
}

export function BelegungsplanKalender({ api, modus, ortName = null, einteilungHinweis }: Props) {
  const searchParams = useSearchParams();
  // Angezeigter Monat als Zurich-Kalendertag YYYY-MM-01 — Quelle ist die URL.
  const anchor = monatAusUrl(searchParams.get("monat"));
  const [eintraege, setEintraege] = useState<Eintrag[]>([]);
  const [uebernahmen, setUebernahmen] = useState<Uebernahme[]>([]);
  const [verfuegbarkeit, setVerfuegbarkeit] = useState<TagVerfuegbarkeit[]>([]);
  const [darfEintragen, setDarfEintragen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [ladeFehler, setLadeFehler] = useState(false);
  const [neuLaden, setNeuLaden] = useState(0);
  const [hoverTag, setHoverTag] = useState<string | null>(null);
  // Modals: key erzwingt pro Oeffnen einen frischen Formular-Zustand.
  const [offen, setOffen] = useState<Offen | null>(null);

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
      const r = await api.laden(`${plusTage(gridStart, -1)}T00:00:00Z`, `${plusTage(gridEnd, 2)}T00:00:00Z`);
      if (!aktuell) return;
      // Ein Fehler ist nie «alles frei»: Hinweis statt leerer Monat.
      setLadeFehler(!r.ok);
      if (!r.ok) {
        toast.error(r.fehler ?? "Kalender konnte nicht geladen werden");
        setEintraege([]);
        setUebernahmen([]);
        setVerfuegbarkeit([]);
        setDarfEintragen(false);
        setLoading(false);
        return;
      }
      const alle: Eintrag[] = [];
      for (const e of r.antwort.eintraege) {
        if (!e.start) continue;
        const startDatum = new Date(e.start);
        const endeDatum = new Date(e.ende ?? e.start);
        if (Number.isNaN(startDatum.getTime()) || Number.isNaN(endeDatum.getTime())) continue;
        const startTag = localDateIso(startDatum);
        let endTag = localDateIso(endeDatum);
        const eigen = EIGENE_ARTEN.has(e.art);
        // Endet ein eigener Eintrag mit Zeit genau um Mitternacht, belegt er
        // den Folgetag nicht. Nur fuer eigene: Auftraege/Anfragen fuehren
        // ihr Enddatum als Mitternacht des letzten Tags (inklusiv).
        if (eigen && !e.ganztaegig && endTag > startTag && localTimeHM(endeDatum) === "00:00") endTag = plusTage(endTag, -1);
        // Eigener Eintrag ueber Nacht bis in den fruehen Morgen (vor 06:00)
        // gehoert nur zum Starttag — sonst stuende am Folgetag ein leerer «↪»-Block.
        if (eigen && !e.ganztaegig && endTag === plusTage(startTag, 1) && localTimeHM(endeDatum) < "06:00") endTag = startTag;
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
      setUebernahmen(r.antwort.uebernahmen);
      setVerfuegbarkeit(r.antwort.verfuegbarkeit.filter((v) => v.stufe !== "frei"));
      setDarfEintragen(r.darfEintragen);
      setLoading(false);
    })();
    return () => {
      aktuell = false;
    };
  }, [gridStart, gridEnd, api, neuLaden]);

  const verfuegbarAm = useMemo(() => new Map(verfuegbarkeit.map((v) => [v.tag, v])), [verfuegbarkeit]);
  const uebernahmenImRaster = uebernahmen.filter((u) => u.von <= gridEnd && u.bis >= gridStart);
  const monatsEnde = plusTage(monatsErster(anchor, 1), -1);
  const uebernahmenImMonat = uebernahmen.filter((u) => u.von <= monatsEnde && u.bis >= anchor);
  const nvImRaster = verfuegbarkeit.filter((v) => v.stufe === "nicht" && v.tag >= gridStart && v.tag <= gridEnd);
  // Intern: Engpaesse (knapp + nicht) des angezeigten Monats mit Namen.
  const engpaesse = verfuegbarkeit.filter((v) => v.tag >= anchor && v.tag <= monatsEnde);

  const liste: ListenZeile[] = [
    ...eintraege.map((e) => ({ typ: "eintrag" as const, key: `e-${e.id}`, sort: e.startDatum.getTime(), e })),
    ...uebernahmenImRaster.map((u) => ({ typ: "uebernahme" as const, key: `u-${u.id}`, sort: sortWert(u.von) - 1, u })),
    // Partner: «nicht verfügbar» als Zeile in der Liste; intern stehen die
    // Engpaesse mit Namen in einer eigenen Liste darueber.
    ...(modus === "partner"
      ? nvImRaster.map((v) => ({ typ: "nv" as const, key: `nv-${v.tag}`, sort: sortWert(v.tag) - 2, v }))
      : []),
  ].sort((a, b) => a.sort - b.sort);

  function eintraegeAm(tag: string): Eintrag[] {
    return eintraege.filter((e) => laeuftAmTag(e.startTag, e.endTag, tag));
  }
  function uebernahmeAm(tag: string): Uebernahme | undefined {
    return uebernahmen.find((u) => u.von <= tag && u.bis >= tag);
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

  // ---------------------------------------------------------------
  // Oeffnen
  // ---------------------------------------------------------------
  const standardDatum = today.startsWith(anchor.slice(0, 7)) ? today : anchor;

  function wahlOeffnen(datum: string, vomTag: boolean) {
    setOffen({ typ: "wahl", datum, vomTag });
  }
  function gewaehlt(w: ErstellenWahl, datum: string) {
    const key = naechsterKey();
    if (w === "termin" || w === "veranstaltung") setOffen({ typ: "eintrag", key, art: w, eintrag: null, datum });
    else if (w === "uebernahme") setOffen({ typ: "uebernahme", key, eintrag: null, datum });
    else setOffen({ typ: "programmheft", key });
  }
  function bearbeiten(e: Eintrag) {
    if (e.art !== "termin" && e.art !== "veranstaltung" && e.art !== "programm") return;
    setOffen({ typ: "eintrag", key: naechsterKey(), art: e.art, eintrag: e, datum: e.startTag });
  }
  function uebernahmeBearbeiten(u: Uebernahme) {
    setOffen({ typ: "uebernahme", key: naechsterKey(), eintrag: u, datum: u.von });
  }
  function fertig() {
    setOffen(null);
    setNeuLaden((n) => n + 1);
  }

  // Legende: an freigeschalteten Standorten (oder sobald eigene Eintraege/
  // Auftraege geliefert werden) alle Arten, sonst wie bisher nur Anfragen
  // + «Belegt» (Partner an Standorten ohne Kalender).
  const hatStil = (s: Stil) => eintraege.some((e) => e.stil === s);
  const erweitert = darfEintragen || modus === "intern" || eintraege.some((e) => EIGENE_ARTEN.has(e.art) || e.art === "auftrag")
    || uebernahmen.length > 0 || verfuegbarkeit.length > 0;
  const wer = modus === "partner"
    ? { eintraege: "Deine Einträge", anfragen: "Deine Anfragen" }
    : { eintraege: "Einträge Partner", anfragen: "Anfragen Partner" };

  return (
    <div className="space-y-4">
      {/* Kopf — Monat-Nav, Heute, Uebernahme-Chip; rechts «Eintrag erstellen» (nur mit Recht). */}
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
        {uebernahmenImMonat.map((u) => (
          <UebernahmeChip key={u.id} uebernahme={u} onKlick={darfEintragen ? () => uebernahmeBearbeiten(u) : undefined} />
        ))}
        {darfEintragen && (
          <button
            type="button"
            onClick={() => wahlOeffnen(standardDatum, false)}
            className="kasten kasten-red ml-auto max-md:ml-0 max-md:w-full max-md:justify-center"
          >
            <Plus className="h-3.5 w-3.5" />
            Eintrag erstellen
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
            const ueb = uebernahmeAm(day);
            const verf = verfuegbarAm.get(day);
            const nv = verf?.stufe === "nicht";
            const knapp = verf?.stufe === "knapp";
            const verfTooltip = verf
              ? modus === "partner" ? (nv ? NV_TOOLTIP_PARTNER : KNAPP_TOOLTIP_PARTNER) : verf.text
              : undefined;
            // Leerer Tag antippen = Eintrag an diesem Tag erstellen.
            const leerKlickbar = darfEintragen && !loading && !ladeFehler && dayEintraege.length === 0;
            const bandLabel = !!ueb && (day === ueb.von || wochentagMo0(day) === 0);
            return (
              <div
                key={day}
                onClick={leerKlickbar ? () => wahlOeffnen(day, true) : undefined}
                onMouseEnter={leerKlickbar ? () => setHoverTag(day) : undefined}
                onMouseLeave={leerKlickbar ? () => setHoverTag(null) : undefined}
                role={leerKlickbar ? "button" : undefined}
                aria-label={leerKlickbar ? `Eintrag am ${tagNr}. erstellen` : undefined}
                data-tooltip={ueb ? UEB_TOOLTIP : undefined}
                className={`relative min-h-[72px] p-1.5 max-md:min-h-[40px] max-md:p-1 border-b border-r border-foreground/10 dark:border-foreground/15 last:border-r-0 ${
                  isCurrentMonth ? "" : "bg-foreground/[0.02] dark:bg-foreground/[0.04]"
                } ${ueb ? `${BAND.tint} md:pb-[18px] max-md:pb-[5px]` : ""} ${leerKlickbar ? "row-hover [--row-hover-x:0px] [--row-hover-radius:0] cursor-pointer" : ""}`}
              >
                {nv && <div className={`absolute inset-0 pointer-events-none ${SCHRAFFUR}`} aria-hidden="true" />}
                {/* Anfang/Ende des Uebernahme-Zeitraums: etwas kraeftigere Kante. */}
                {ueb && day === ueb.von && <span className={`absolute left-0 inset-y-0 w-[2px] pointer-events-none ${BAND.kante}`} aria-hidden="true" />}
                {ueb && day === ueb.bis && <span className={`absolute right-0 inset-y-0 w-[2px] pointer-events-none ${BAND.kante}`} aria-hidden="true" />}
                <div className="relative flex items-center gap-1 mb-1 min-w-0" data-tooltip={verfTooltip}>
                  {/* Heute-Kreis am Handy als Block (flex): inline-flex sitzt auf
                      der Textzeile der Zelle und rutscht 4 px unter die anderen Zahlen. */}
                  <span className={`text-[11px] font-semibold ${
                    isToday
                      ? "inline-flex max-md:flex items-center justify-center w-5 h-5 rounded-full bg-red-500 text-white shrink-0"
                      : isCurrentMonth ? "text-foreground" : "text-muted-foreground/60"
                  }`}>
                    {tagNr}
                  </span>
                  {nv && (
                    <span className="hidden md:block truncate text-[9px] text-muted-foreground">
                      EVENTLINE nicht verfügbar
                    </span>
                  )}
                  {knapp && (
                    <span className="hidden md:block truncate text-[9px] text-muted-foreground">
                      knapp
                    </span>
                  )}
                </div>
                {leerKlickbar && hoverTag === day && (
                  <Plus className="hidden md:block absolute top-1.5 right-1.5 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                )}
                <div className="relative hidden md:block space-y-0.5">
                  {dayEintraege.slice(0, 3).map((e) => {
                    const s = STIL[e.stil];
                    // Fortsetzung vom Vortag: nur Block, Titel nicht wiederholen.
                    const fortsetzung = laeuftAmTag(e.startTag, e.endTag, plusTage(day, -1));
                    const unter = e.stil === "belegt" || fortsetzung
                      ? null
                      : ablaufText(e) ?? [ANFRAGE_STILE_SET.has(e.stil) ? s.label : null, zeitKurz(e), e.kunde].filter(Boolean).join(" · ");
                    return (
                      <EintragKlick
                        key={e.id}
                        eintrag={e}
                        onBearbeiten={bearbeiten}
                        tooltip={tooltipText(e)}
                        className={`block w-full text-left text-[10px] leading-tight px-1.5 py-0.5 rounded border ${s.bg} ${s.text} ${s.border}`}
                      >
                        <span className="flex items-center gap-1 min-w-0 font-medium">
                          {!fortsetzung && <ArtIcon e={e} className="h-3 w-3 shrink-0 opacity-70" />}
                          <span className={`truncate ${e.stil === "storniert" ? "line-through" : ""}`}>
                            {fortsetzung ? "↪" : e.stil === "belegt" ? "Belegt" : e.titel}
                          </span>
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
                  <div className="relative md:hidden space-y-0.5" aria-hidden="true">
                    {dayEintraege.slice(0, 3).map((e) => (
                      <span key={e.id} className={`block h-1.5 rounded-full ${STIL[e.stil].dot}`} />
                    ))}
                    {dayEintraege.length > 3 && (
                      <div className="text-[9px] text-muted-foreground">+{dayEintraege.length - 3}</div>
                    )}
                  </div>
                )}
                {ueb && (
                  <BandStreifen
                    uebernahme={ueb}
                    mitLabel={bandLabel}
                    onKlick={darfEintragen ? () => uebernahmeBearbeiten(ueb) : undefined}
                  />
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

        {/* Legende — eine Zeile, drei Farben + Linie + Schraffur. */}
        <div className="border-t bg-foreground/[0.02] dark:bg-foreground/[0.04] px-3 py-2 text-[11px]">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-foreground/70">
            {erweitert && <LegendePunkt dot={BLAU.dot} label={wer.eintraege} />}
            <LegendePunkt dot={AMBER.dot} label={wer.anfragen} />
            {erweitert && <LegendePunkt dot={STIL.auftrag.dot} label="EVENTLINE" />}
            {(!erweitert || hatStil("belegt")) && <LegendePunkt dot={STIL.belegt.dot} label="Belegt" />}
            {erweitert && (
              <>
                <span className="flex items-center gap-1.5" data-tooltip="EVENTLINE übernimmt in diesem Zeitraum alle Privatvermietungen">
                  <span className={`w-4 h-[2px] rounded-full ${BAND.linie}`} />
                  Übernahme
                </span>
                <span className="flex items-center gap-1.5" data-tooltip={modus === "partner" ? NV_TOOLTIP_PARTNER : "Niemand aus dem eingeteilten EVENTLINE-Team ist an diesem Tag frei."}>
                  <span className={`w-3 h-3 rounded-sm border border-foreground/15 ${SCHRAFFUR}`} />
                  nicht verfügbar
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Intern: Verfuegbarkeit EVENTLINE im angezeigten Monat — nur Engpaesse, mit Namen. */}
      {modus === "intern" && (
        <div>
          <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            Verfügbarkeit EVENTLINE
            <span className="text-xs font-normal text-muted-foreground">({engpaesse.length})</span>
          </h3>
          {einteilungHinweis && <div className="text-[11px] text-muted-foreground mb-2">{einteilungHinweis}</div>}
          {ladeFehler ? null : engpaesse.length === 0 ? (
            loading ? null : (
              <div className="rounded-xl border border-dashed bg-card px-3 py-3 text-center text-xs text-muted-foreground">
                Im {monthLabel} keine Engpässe.
              </div>
            )
          ) : (
            <div className="space-y-1.5">
              {engpaesse.map((v) => (
                <div key={v.tag} className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border bg-card">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className={`w-3 h-3 rounded-sm shrink-0 border border-foreground/15 ${v.stufe === "nicht" ? SCHRAFFUR : ""}`} />
                    <div className="min-w-0">
                      <p className="font-medium text-sm">{TAG_MIT_JAHR.format(tagDatum(v.tag))}</p>
                      <p className="text-[11px] text-muted-foreground truncate max-md:whitespace-normal">{v.text}</p>
                    </div>
                  </div>
                  <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground shrink-0">
                    {v.stufe === "nicht" ? "Nicht verfügbar" : "Knapp"}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Liste der Eintraege im sichtbaren Zeitraum */}
      <div>
        <h3 className="text-sm font-semibold mb-2 flex items-center gap-2">
          <Calendar className="h-4 w-4 text-muted-foreground" />
          Einträge im sichtbaren Zeitraum
          <span className="text-xs font-normal text-muted-foreground">({liste.length})</span>
        </h3>
        {ladeFehler ? (
          <div className="rounded-xl border border-dashed bg-card p-6 text-center text-sm text-muted-foreground">
            Kalender konnte nicht geladen werden — bitte die Seite neu laden.
          </div>
        ) : liste.length === 0 ? (
          loading ? null : (
            <div className="rounded-xl border border-dashed bg-card">
              <EmptyState
                icon={CalendarX}
                title="Keine Einträge in diesem Monat"
                description={darfEintragen ? "Tippe auf einen Tag oder auf «Eintrag erstellen»." : undefined}
              />
            </div>
          )
        ) : (
          <div className="space-y-1.5">
            {liste.map((z) => {
              if (z.typ === "uebernahme") {
                const inhalt = (
                  <>
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className={`w-3 h-[2px] rounded-full shrink-0 ${BAND.linie}`} />
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate max-md:whitespace-normal max-md:line-clamp-2">
                          EVENTLINE übernimmt alle Privatvermietungen
                        </p>
                        {z.u.notiz && <p className="text-[11px] opacity-90 truncate">{z.u.notiz}</p>}
                        <p className="text-[11px] opacity-80">{uebernahmeZeitraum(z.u)}</p>
                      </div>
                    </div>
                    <span className="text-[10px] font-medium uppercase tracking-wider opacity-70 shrink-0 max-md:max-w-[8.5rem] max-md:text-right">
                      Übernahme
                    </span>
                  </>
                );
                const cls = `flex items-center justify-between gap-3 px-3 py-2.5 max-md:py-[7px] max-md:min-h-[46px] rounded-lg border ${BAND.zeile} text-left w-full`;
                return darfEintragen ? (
                  <ZeilenKlick key={z.key} onKlick={() => uebernahmeBearbeiten(z.u)} className={cls}>{inhalt}</ZeilenKlick>
                ) : (
                  <div key={z.key} className={cls} data-tooltip={UEB_TOOLTIP}>{inhalt}</div>
                );
              }
              if (z.typ === "nv") {
                return (
                  <div
                    key={z.key}
                    data-tooltip={NV_TOOLTIP_PARTNER}
                    className="relative overflow-hidden flex items-center justify-between gap-3 px-3 py-2.5 max-md:py-[7px] max-md:min-h-[46px] rounded-lg border bg-card text-muted-foreground border-foreground/15 dark:border-foreground/20"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className={`w-3 h-3 rounded-sm shrink-0 border border-foreground/15 ${SCHRAFFUR}`} />
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate max-md:whitespace-normal max-md:line-clamp-2">EVENTLINE nicht verfügbar</p>
                        <p className="text-[11px] opacity-90 max-md:line-clamp-2">Niemand aus deinem EVENTLINE-Team ist an diesem Tag frei.</p>
                        <p className="text-[11px] opacity-80">{datumKurz(tagDatum(z.v.tag), true)} · ganztägig</p>
                      </div>
                    </div>
                    <span className="text-[10px] font-medium uppercase tracking-wider opacity-70 shrink-0 max-md:max-w-[8.5rem] max-md:text-right">
                      Nicht verfügbar
                    </span>
                  </div>
                );
              }
              const e = z.e;
              const s = STIL[e.stil];
              return (
                <EintragKlick
                  key={z.key}
                  eintrag={e}
                  onBearbeiten={bearbeiten}
                  tooltip={e.stil === "auftrag" && modus === "partner" ? "EVENTLINE-Auftrag in deiner Location" : undefined}
                  className={`flex items-center justify-between gap-3 px-3 py-2.5 max-md:py-[7px] max-md:min-h-[46px] rounded-lg border ${s.bg} ${s.text} ${s.border} text-left w-full`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${s.dot}`} />
                    <div className="min-w-0">
                      {/* Am Handy bis zwei Zeilen statt abgeschnitten. */}
                      <p className={`font-medium text-sm truncate max-md:whitespace-normal max-md:line-clamp-2 ${e.stil === "storniert" ? "line-through" : ""}`}>
                        {e.stil === "belegt" ? "Belegt (EVENTLINE-intern)" : e.titel}
                      </p>
                      {e.kunde && <p className="text-[11px] opacity-90 truncate">{e.kunde}</p>}
                      <p className="text-[11px] opacity-80 flex items-center gap-1 flex-wrap">
                        <ArtIcon e={e} className="h-3 w-3 shrink-0" />
                        {zeitraumText(e)}
                        {e.zugewiesen.length > 0 && (
                          <>
                            <span className="opacity-50">·</span>
                            <span>Zugewiesen: {e.zugewiesen.join(", ")}</span>
                          </>
                        )}
                      </p>
                      {ablaufText(e) && <p className="text-[11px] opacity-80">{ablaufText(e)}</p>}
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

      {offen?.typ === "wahl" && (
        <ErstellenModal
          datumText={offen.vomTag ? datumKurz(tagDatum(offen.datum), true) : null}
          onClose={() => setOffen(null)}
          onWahl={(w) => gewaehlt(w, offen.datum)}
        />
      )}
      {offen?.typ === "eintrag" && (
        <EintragModal
          key={offen.key}
          api={api}
          art={offen.art}
          eintrag={offen.eintrag}
          datumVorgabe={offen.datum}
          onClose={() => setOffen(null)}
          onFertig={fertig}
        />
      )}
      {offen?.typ === "uebernahme" && (
        <UebernahmeModal
          key={offen.key}
          api={api}
          eintrag={offen.eintrag}
          datumVorgabe={offen.datum}
          ortName={ortName}
          onClose={() => setOffen(null)}
          onFertig={fertig}
        />
      )}
      {offen?.typ === "programmheft" && (
        <ProgrammheftModal key={offen.key} api={api} onClose={() => setOffen(null)} onFertig={fertig} />
      )}
    </div>
  );
}

// =====================================================================
// EintragKlick — rendert einen Eintrag je nach Ziel als Link (anfrage/
// auftrag mit link), als Knopf (eigener Eintrag, bearbeitbar) oder als
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
  onBearbeiten: (e: Eintrag) => void;
  className: string;
  tooltip?: string;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const link = (eintrag.art === "anfrage" || eintrag.art === "auftrag") && eintrag.link ? eintrag.link : null;
  const editierbar = EIGENE_ARTEN.has(eintrag.art) && eintrag.bearbeitbar;
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
        onClick={(ev) => { ev.stopPropagation(); onBearbeiten(eintrag); }}
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

/** Klickbare Listenzeile (Uebernahme) mit gleichem Hover wie EintragKlick. */
function ZeilenKlick({ onKlick, className, children }: { onKlick: () => void; className: string; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onKlick}
      className={className}
      style={{ opacity: hover ? 0.8 : 1, transition: "opacity 150ms", cursor: "pointer" }}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      {children}
    </button>
  );
}

/** Uebernahme-Band unten in der Tageszelle — durchgehend ueber alle Tage.
 *  Ohne Schreibrecht nur Anzeige (kein Knopf). */
function BandStreifen({ uebernahme, mitLabel, onKlick }: { uebernahme: Uebernahme; mitLabel: boolean; onKlick?: () => void }) {
  const [hover, setHover] = useState(false);
  const tooltip = `${UEB_TOOLTIP} · ${uebernahmeZeitraum(uebernahme)}${uebernahme.notiz ? ` · ${uebernahme.notiz}` : ""}`;
  const inhalt = (
    <>
      {mitLabel && (
        <span className={`max-md:hidden block truncate px-1.5 text-[10px] leading-[14px] font-medium ${BAND.text}`}>
          EVENTLINE übernimmt
        </span>
      )}
      <span className={`absolute inset-x-0 bottom-0 h-[2px] ${BAND.linie}`} />
    </>
  );
  const cls = "absolute left-0 -right-px bottom-0 h-[16px] max-md:h-[5px] text-left overflow-hidden";
  if (!onKlick) {
    return <span className={cls} data-tooltip={tooltip}>{inhalt}</span>;
  }
  return (
    <button
      type="button"
      onClick={(ev) => { ev.stopPropagation(); onKlick(); }}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      data-tooltip={tooltip}
      aria-label="Übernahme-Zeitraum bearbeiten"
      className={cls}
      style={{ opacity: hover ? 0.7 : 1, transition: "opacity 150ms" }}
    >
      {inhalt}
    </button>
  );
}

/** Chip neben dem Monatstitel — oeffnet (mit Schreibrecht) den Uebernahme-Zeitraum. */
function UebernahmeChip({ uebernahme, onKlick }: { uebernahme: Uebernahme; onKlick?: () => void }) {
  const [hover, setHover] = useState(false);
  const tooltip = uebernahme.notiz ? `${UEB_TOOLTIP} · ${uebernahme.notiz}` : UEB_TOOLTIP;
  const cls = `inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium whitespace-nowrap ${BAND.chip}`;
  const inhalt = (
    <>
      <span className={`w-2.5 h-[2px] rounded-full ${BAND.linie}`} aria-hidden="true" />
      EVENTLINE übernimmt {uebernahmeKurz(uebernahme)}
    </>
  );
  if (!onKlick) return <span className={cls} data-tooltip={tooltip}>{inhalt}</span>;
  return (
    <button
      type="button"
      onClick={onKlick}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      data-tooltip={tooltip}
      className={cls}
      style={{ opacity: hover ? 0.75 : 1, transition: "opacity 150ms" }}
    >
      {inhalt}
    </button>
  );
}

function LegendePunkt({ dot, label }: { dot: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
}
