"use client";

/**
 * Eintrag-Modal des Standort-Kalenders (Partnerportal und interner
 * Location-Tab) fuer drei Arten:
 *  - termin        = Einzeltermin (Titel, Kunde, Datum, Bis-Datum, ganztaegig, Zeit, Notiz)
 *                    → …/kalender-termine
 *  - veranstaltung = wie Termin ohne Bis-Datum, dazu «Wiederholen» (nie /
 *                    jede Woche mit Wochentagen / jeden Monat) bis Datum
 *                    → …/kalender-serien. Bei einem Termin einer
 *                    wiederkehrenden Serie waehlt man oben «Nur diesen
 *                    Termin» oder «Alle Termine der Serie» — das Formular
 *                    zeigt dann die Instanz bzw. die Regel der Serie (bei
 *                    «Alle» ist das Datum der Beginn der Serie). Loeschen
 *                    fragt «Nur diesen / Alle».
 *  - programm      = aus dem Programmheft uebernommen, sonst wie Termin
 *                    (gleiche Tabelle wie termin → …/kalender-termine)
 *
 * Zeiten werden als Zuercher Wandzeit eingegeben und als ISO mit Zeitzone
 * gespeichert (zuerichZuIso). Ganztaegig: Start = 00:00 des ersten Tags,
 * Ende = 23:59 des letzten Tags. Mit Zeit: «Bis» kleiner/gleich «Von» am
 * selben Tag heisst «endet am Folgetag» — das steht sichtbar unter den
 * Feldern, nichts passiert still.
 *
 * Kein <form>: Enter springt wie app-weit zum naechsten Feld, gespeichert
 * wird nur ueber den Knopf. Das Modal wird pro Oeffnen neu gemountet (key
 * im Aufrufer) — der Formular-Zustand startet so immer frisch.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Trash2, CalendarPlus, CalendarClock, Music, Repeat } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { ZeitFeld } from "@/components/ui/zeit-feld";
import { useConfirm } from "@/components/ui/use-confirm";
import { SearchableSelect } from "@/components/searchable-select";
import { plusTage, weekdayForDateIso } from "@/lib/swiss-time";
import { isoZuZuerich, zeitEingabeFehler, zuerichZuIso } from "@/lib/stempel-meldungen";
import {
  KALENDER_KUNDE_MAX,
  KALENDER_NOTIZ_MAX,
  KALENDER_TITEL_MAX,
  type KalenderEintrag,
  type SerieEingabe,
  type TerminEingabeKalender,
  type Wiederholung,
} from "@/lib/standort-kalender";
import type { KalenderApi, KalenderErgebnis, SerienUmfang } from "./kalender-api";

export type ModalArt = "termin" | "veranstaltung" | "programm";

interface Formular {
  titel: string;
  kunde: string;
  datum: string;
  /** Letzter Tag bei mehrtaegigen Terminen, sonst "". */
  bisDatum: string;
  ganztaegig: boolean;
  von: string;
  bis: string;
  notiz: string;
  wiederholung: Wiederholung;
  /** Mo=0 … So=6 */
  wochentage: number[];
  /** Ende der Wiederholung (inklusiv) */
  wdhBis: string;
}

const WT = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
const WT_LANG = ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"];

/** Wochentag Mo=0 … So=6 eines Kalendertags. */
function wochentagMo0(tag: string): number {
  return (weekdayForDateIso(tag) + 6) % 7;
}

function formularAus(e: KalenderEintrag | null, datumVorgabe: string, umfang: SerienUmfang = "nur_diesen"): Formular {
  const leerWdh = { wiederholung: "nie" as Wiederholung, wochentage: [] as number[], wdhBis: "" };
  if (!e) {
    return { titel: "", kunde: "", datum: datumVorgabe, bisDatum: "", ganztaegig: false, von: "", bis: "", notiz: "", ...leerWdh };
  }
  // «Alle Termine der Serie»: Regel der Serie (nicht die evtl. einzeln
  // geaenderte Instanz); Datum = Beginn der Serie.
  if (umfang === "serie" && e.serie) {
    const r = e.serie;
    return {
      titel: r.titel,
      kunde: r.kunde ?? "",
      datum: r.datum,
      bisDatum: "",
      ganztaegig: r.ganztaegig,
      von: r.ganztaegig ? "" : r.von ?? "",
      bis: r.ganztaegig ? "" : r.bis ?? "",
      notiz: r.notiz ?? "",
      wiederholung: r.wiederholung,
      wochentage: r.wochentage,
      wdhBis: r.bisDatum ?? "",
    };
  }
  const s = isoZuZuerich(e.start);
  const en = e.ende ? isoZuZuerich(e.ende) : null;
  let bisDatum = "";
  if (en && en.datum !== s.datum) {
    // Abend bis nach Mitternacht ist ein Ein-Tages-Termin (Bis < Von).
    const ueberNacht = !e.ganztaegig && en.datum === plusTage(s.datum, 1) && en.zeit <= s.zeit;
    if (e.ganztaegig || !ueberNacht) bisDatum = en.datum;
  }
  const serie = e.serie;
  return {
    titel: e.titel,
    kunde: e.kunde ?? "",
    datum: s.datum,
    bisDatum,
    ganztaegig: e.ganztaegig,
    von: e.ganztaegig ? "" : s.zeit,
    bis: e.ganztaegig || !en ? "" : en.zeit,
    notiz: e.notiz ?? "",
    ...(serie
      ? { wiederholung: serie.wiederholung, wochentage: serie.wochentage, wdhBis: serie.bisDatum ?? "" }
      : leerWdh),
  };
}

function endetAmFolgetag(f: Formular): boolean {
  return !f.ganztaegig && !!f.von && !!f.bis && (!f.bisDatum || f.bisDatum === f.datum) && f.bis <= f.von;
}

/** Einzeltermin (termin/programm) als Eingabe fuer …/kalender-termine. */
function terminEingabe(f: Formular): { eingabe: TerminEingabeKalender } | { fehler: string } {
  const titel = f.titel.trim();
  const letzterTag = f.bisDatum && f.bisDatum !== f.datum ? f.bisDatum : f.datum;
  let start: string | null;
  let ende: string | null = null;
  if (f.ganztaegig) {
    start = zuerichZuIso(f.datum, "00:00");
    ende = zuerichZuIso(letzterTag, "23:59");
    if (!start || !ende) return { fehler: "Ungültiges Datum" };
  } else {
    start = zuerichZuIso(f.datum, f.von);
    if (!start) return { fehler: zeitEingabeFehler(f.datum, f.von) ?? "Ungültige Startzeit" };
    if (f.bis) {
      const endTag = endetAmFolgetag(f) ? plusTage(f.datum, 1) : letzterTag;
      ende = zuerichZuIso(endTag, f.bis);
      if (!ende) return { fehler: zeitEingabeFehler(endTag, f.bis) ?? "Ungültige Endzeit" };
    }
  }
  return {
    eingabe: { titel, kunde: f.kunde.trim() || null, start, ende, ganztaegig: f.ganztaegig, notiz: f.notiz.trim() || null },
  };
}

/** Veranstaltung als Eingabe fuer …/kalender-serien. */
function serieEingabe(f: Formular, datum: string): SerieEingabe {
  return {
    titel: f.titel.trim(),
    kunde: f.kunde.trim() || null,
    notiz: f.notiz.trim() || null,
    datum,
    ganztaegig: f.ganztaegig,
    von: f.ganztaegig ? null : f.von || null,
    bis: f.ganztaegig ? null : f.bis || null,
    wiederholung: f.wiederholung,
    wochentage: f.wiederholung === "woechentlich" ? f.wochentage : [],
    bisDatum: f.wiederholung === "nie" ? null : f.wdhBis || null,
  };
}

/** Pruefung vor dem Speichern. null = ok. `mitRegel` = Wiederholung pruefen
 *  (nicht bei «Nur diesen Termin»). */
function pruefen(f: Formular, art: ModalArt, mitRegel: boolean): string | null {
  if (!f.titel.trim()) return "Titel ist Pflicht";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.datum)) return "Datum ist Pflicht";
  const letzterTag = f.bisDatum && f.bisDatum !== f.datum ? f.bisDatum : f.datum;
  if (letzterTag < f.datum) return "Das Bis-Datum liegt vor dem Datum";
  if (!f.ganztaegig) {
    if (!f.von) return "Bitte die Startzeit (Von) angeben oder «ganztägig» wählen";
    const start = zuerichZuIso(f.datum, f.von);
    if (!start) return zeitEingabeFehler(f.datum, f.von) ?? "Ungültige Startzeit";
    if (f.bis) {
      const endTag = endetAmFolgetag(f) ? plusTage(f.datum, 1) : letzterTag;
      const ende = zuerichZuIso(endTag, f.bis);
      if (!ende) return zeitEingabeFehler(endTag, f.bis) ?? "Ungültige Endzeit";
      if (new Date(ende).getTime() <= new Date(start).getTime()) return "Das Ende liegt vor dem Beginn";
    } else if (letzterTag !== f.datum) {
      return "Bei mehrtägigen Terminen bitte die Endzeit (Bis) angeben oder «ganztägig» wählen";
    }
  }
  if (art === "veranstaltung" && mitRegel && f.wiederholung !== "nie") {
    if (f.wiederholung === "woechentlich" && f.wochentage.length === 0) return "Bitte mindestens einen Wochentag wählen";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(f.wdhBis)) return "Bitte angeben, bis wann sich die Veranstaltung wiederholt";
    if (f.wdhBis < f.datum) return "«Wiederholen bis» liegt vor dem ersten Datum";
  }
  return null;
}

/** «06.11.» (reiner Kalendertag, keine Zeitzone noetig). */
function tagKurz(tag: string): string {
  return `${tag.slice(8, 10)}.${tag.slice(5, 7)}.`;
}

// Felder am Handy: 16 px Schrift (sonst zoomt iOS) und 36 px hoch («Dicht»).
// Das Modal haengt am body, ausserhalb von [data-partner-portal] — die
// Portal-Regel aus globals.css greift hier nicht, darum explizit.
const FELD = "mt-1 max-md:h-[36px] max-md:text-[16px]";
const LABEL = "text-[11px] font-medium";

const TEXTE: Record<ModalArt, { neu: string; bearbeiten: string; platzhalter: string; ding: string }> = {
  termin:        { neu: "Termin eintragen",        bearbeiten: "Termin bearbeiten",        platzhalter: "z. B. Lieferung, Private Feier", ding: "Termin" },
  veranstaltung: { neu: "Veranstaltung eintragen", bearbeiten: "Veranstaltung bearbeiten", platzhalter: "z. B. Jam Session, Clubnacht",    ding: "Veranstaltung" },
  programm:      { neu: "Programm eintragen",      bearbeiten: "Programm bearbeiten",      platzhalter: "z. B. Konzert, Lesung",           ding: "Programm" },
};

const WDH_OPTIONEN = [
  { id: "nie", label: "Nie" },
  { id: "woechentlich", label: "Jede Woche" },
  { id: "monatlich", label: "Jeden Monat" },
];

interface Props {
  api: KalenderApi;
  art: ModalArt;
  /** null = neuer Eintrag */
  eintrag: KalenderEintrag | null;
  /** Vorbelegtes Datum (YYYY-MM-DD) fuer neue Eintraege. */
  datumVorgabe: string;
  onClose: () => void;
  /** Nach erfolgreichem Speichern/Loeschen: Modal schliessen + neu laden. */
  onFertig: () => void;
}

export function EintragModal({ api, art, eintrag, datumVorgabe, onClose, onFertig }: Props) {
  // Termin einer wiederkehrenden Serie: was wird bearbeitet? Vorgabe «Nur diesen».
  const [umfang, setUmfang] = useState<SerienUmfang>("nur_diesen");
  const [f, setF] = useState<Formular>(() => formularAus(eintrag, datumVorgabe));
  const [laeuft, setLaeuft] = useState<"speichern" | "loeschen" | null>(null);
  const [frage, setFrage] = useState<"loeschen" | null>(null);
  const [fragt, setFragt] = useState(false);
  const { confirm, ConfirmModalElement } = useConfirm();

  const t = TEXTE[art];
  const setze = <K extends keyof Formular>(k: K, v: Formular[K]) => setF((alt) => ({ ...alt, [k]: v }));
  const beschaeftigt = laeuft !== null;
  const folgetag = endetAmFolgetag(f);
  const serie = eintrag?.serie ?? null;
  // Bestehender Termin einer wiederkehrenden Serie → «Nur diesen / Alle».
  const serienTermin = !!eintrag && art === "veranstaltung" && (eintrag.wiederkehrend || (!!serie && serie.wiederholung !== "nie"));
  // Regel (Wiederholen) bearbeitbar: neue/einmalige Veranstaltung oder «Alle».
  const mitRegel = !serienTermin || umfang === "serie";

  /** Umfang wechseln: Formular neu aus Instanz bzw. Serie vorbelegen. */
  function umfangSetzen(u: SerienUmfang) {
    if (u === umfang) return;
    setUmfang(u);
    setF(formularAus(eintrag, datumVorgabe, u));
  }

  async function ausfuehren(aktion: "speichern" | "loeschen", umfang: SerienUmfang) {
    let r: KalenderErgebnis;
    setLaeuft(aktion);
    if (art === "veranstaltung") {
      const serienTag = umfang === "nur_diesen" ? eintrag?.serienTag ?? null : null;
      if (aktion === "loeschen") {
        r = eintrag?.serieId ? await api.serieLoeschen(eintrag.serieId, umfang, serienTag) : { ok: false, fehler: null };
      } else if (!eintrag?.serieId) {
        r = await api.serieAnlegen(serieEingabe(f, f.datum));
      } else {
        // Ganze Serie: Inhalt + Regel, f.datum = (neuer) Beginn der Serie
        // (Formular kommt bei «Alle» aus der Serie). Nur diesen:
        // Datum/Zeit/Inhalt dieser einen Instanz.
        r = await api.serieAendern(eintrag.serieId, umfang, serienTag, serieEingabe(f, f.datum));
      }
    } else if (aktion === "loeschen") {
      r = eintrag ? await api.termin("loeschen", eintrag.id) : { ok: false, fehler: null };
    } else {
      const e = terminEingabe(f);
      if ("fehler" in e) {
        setLaeuft(null);
        toast.error(e.fehler);
        return;
      }
      r = await api.termin(eintrag ? "aendern" : "anlegen", eintrag?.id, e.eingabe);
    }
    setLaeuft(null);
    if (!r.ok) {
      toast.error(
        r.fehler
          || (aktion === "speichern" ? `${t.ding} konnte nicht gespeichert werden` : `${t.ding} konnte nicht gelöscht werden`),
      );
      return;
    }
    if (aktion === "speichern") toast.success(eintrag ? `${t.ding} gespeichert` : `${t.ding} eingetragen`);
    else toast.success(`${t.ding} gelöscht`);
    onFertig();
  }

  function speichernKlick() {
    const fehler = pruefen(f, art, mitRegel);
    if (fehler) {
      toast.error(fehler);
      return;
    }
    void ausfuehren("speichern", serienTermin ? umfang : "serie");
  }

  async function loeschenKlick() {
    if (!eintrag) return;
    if (serienTermin) {
      setFrage("loeschen");
      return;
    }
    setFragt(true);
    const ok = await confirm({
      title: `${t.ding} löschen?`,
      message: `«${eintrag.titel}» wird aus dem Kalender entfernt.`,
      confirmLabel: "Löschen",
    });
    setFragt(false);
    if (!ok) return;
    void ausfuehren("loeschen", "serie");
  }

  function wiederholungSetzen(w: Wiederholung) {
    setF((alt) => ({
      ...alt,
      wiederholung: w,
      // Wochentag des Datums vorschlagen, «bis» zwoelf Wochen spaeter.
      wochentage: w === "woechentlich" && alt.wochentage.length === 0 && alt.datum ? [wochentagMo0(alt.datum)] : alt.wochentage,
      wdhBis: w !== "nie" && !alt.wdhBis && alt.datum ? plusTage(alt.datum, 7 * 12) : alt.wdhBis,
    }));
  }

  function wochentagUmschalten(i: number) {
    setF((alt) => ({
      ...alt,
      wochentage: alt.wochentage.includes(i) ? alt.wochentage.filter((x) => x !== i) : [...alt.wochentage, i].sort(),
    }));
  }

  const Icon = art === "programm" ? Music : eintrag ? CalendarClock : CalendarPlus;
  const serienTag = eintrag?.serienTag ? tagKurz(eintrag.serienTag) : "";

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={eintrag ? t.bearbeiten : t.neu}
        icon={<Icon className="h-5 w-5 text-blue-500" />}
        size="md"
        sheet
        closable={!beschaeftigt && !fragt && !frage}
      >
        <div className="space-y-3">
          {art === "programm" && eintrag?.quelleId && (
            <p className="text-[11px] text-muted-foreground -mt-1">
              Aus dem Programmheft übernommen — nach einer Änderung hier überschreibt der Abgleich ihn nicht mehr; gelöscht kommt er nicht wieder.
            </p>
          )}
          {serienTermin && (
            <div className="-mt-1">
              <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                <Repeat className="h-3 w-3 shrink-0" />
                Teil einer wiederkehrenden Veranstaltung — bearbeiten:
              </p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                <button
                  type="button"
                  onClick={() => umfangSetzen("nur_diesen")}
                  aria-pressed={umfang === "nur_diesen"}
                  disabled={beschaeftigt}
                  className={umfang === "nur_diesen" ? "kasten-active" : "kasten-toggle-off"}
                >
                  Nur diesen Termin ({serienTag})
                </button>
                <button
                  type="button"
                  onClick={() => umfangSetzen("serie")}
                  aria-pressed={umfang === "serie"}
                  disabled={beschaeftigt}
                  className={umfang === "serie" ? "kasten-active" : "kasten-toggle-off"}
                >
                  Alle Termine der Serie
                </button>
              </div>
            </div>
          )}
          <div>
            <label className={LABEL} htmlFor="eintrag-titel">Titel *</label>
            <Input
              id="eintrag-titel"
              value={f.titel}
              onChange={(e) => setze("titel", e.target.value)}
              placeholder={t.platzhalter}
              maxLength={KALENDER_TITEL_MAX}
              autoFocus={!eintrag}
              className={FELD}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="eintrag-kunde">Kunde</label>
            <Input
              id="eintrag-kunde"
              value={f.kunde}
              onChange={(e) => setze("kunde", e.target.value)}
              placeholder="optional"
              maxLength={KALENDER_KUNDE_MAX}
              className={FELD}
            />
          </div>
          <div className={art === "veranstaltung" ? "" : "grid grid-cols-2 gap-2"}>
            <div>
              <label className={LABEL} htmlFor="eintrag-datum">{art === "veranstaltung" && mitRegel && f.wiederholung !== "nie" ? "Erstes Datum *" : "Datum *"}</label>
              <Input
                id="eintrag-datum"
                type="date"
                value={f.datum}
                onChange={(e) => setze("datum", e.target.value)}
                className={FELD}
              />
            </div>
            {art !== "veranstaltung" && (
              <div>
                <label className={LABEL} htmlFor="eintrag-bis-datum">Bis Datum <span className="font-normal text-muted-foreground">(mehrtägig)</span></label>
                <Input
                  id="eintrag-bis-datum"
                  type="date"
                  value={f.bisDatum}
                  min={f.datum || undefined}
                  onChange={(e) => setze("bisDatum", e.target.value)}
                  className={FELD}
                />
              </div>
            )}
          </div>

          {/* Schalter ganztaegig — Optik wie die Benachrichtigungs-Schalter im Portal. */}
          <button
            type="button"
            role="switch"
            aria-checked={f.ganztaegig}
            onClick={() => setze("ganztaegig", !f.ganztaegig)}
            className="flex items-center gap-2.5 text-sm max-md:min-h-[34px]"
          >
            <span className={`inline-flex h-5 w-9 items-center rounded-full transition-colors ${f.ganztaegig ? "bg-red-500" : "bg-foreground/20 dark:bg-foreground/30"}`}>
              <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${f.ganztaegig ? "translate-x-4" : "translate-x-0.5"}`} />
            </span>
            Ganztägig
          </button>

          {!f.ganztaegig && (
            <div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={LABEL} htmlFor="eintrag-von">Von *</label>
                  <ZeitFeld id="eintrag-von" value={f.von} onChange={(v) => setze("von", v)} className={FELD} />
                </div>
                <div>
                  <label className={LABEL} htmlFor="eintrag-bis">Bis</label>
                  <ZeitFeld id="eintrag-bis" value={f.bis} onChange={(v) => setze("bis", v)} className={FELD} />
                </div>
              </div>
              {folgetag && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  Endet am Folgetag ({tagKurz(plusTage(f.datum, 1))}) um {f.bis}.
                </p>
              )}
            </div>
          )}

          {/* Wiederholen — nur Veranstaltung (bei «Nur diesen Termin» fest) */}
          {art === "veranstaltung" && mitRegel && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className={LABEL} htmlFor="eintrag-wdh">Wiederholen</label>
                  <div className="mt-1">
                    <SearchableSelect
                      id="eintrag-wdh"
                      value={f.wiederholung}
                      onChange={(v) => wiederholungSetzen((v || "nie") as Wiederholung)}
                      items={WDH_OPTIONEN}
                      searchable={false}
                      clearable={false}
                    />
                  </div>
                </div>
                {f.wiederholung !== "nie" && (
                  <div>
                    <label className={LABEL} htmlFor="eintrag-wdh-bis">Bis *</label>
                    <Input
                      id="eintrag-wdh-bis"
                      type="date"
                      value={f.wdhBis}
                      min={f.datum || undefined}
                      onChange={(e) => setze("wdhBis", e.target.value)}
                      className={FELD}
                    />
                  </div>
                )}
              </div>
              {f.wiederholung === "woechentlich" && (
                <div>
                  <p className={LABEL}>An diesen Tagen</p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {WT.map((w, i) => (
                      <button
                        key={w}
                        type="button"
                        onClick={() => wochentagUmschalten(i)}
                        aria-pressed={f.wochentage.includes(i)}
                        className={`${f.wochentage.includes(i) ? "kasten-active" : "kasten-toggle-off"} min-w-[2.75rem] justify-center`}
                      >
                        {w}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {f.wiederholung !== "nie" && f.datum && (
                <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                  <Repeat className="h-3 w-3 shrink-0" />
                  {f.wiederholung === "monatlich"
                    ? `Jeden Monat am ${Number(f.datum.slice(8, 10))}.`
                    : f.wochentage.length > 0
                      ? `Jeden ${f.wochentage.map((i) => WT_LANG[i]).join(", ")}`
                      : "Wochentag wählen"}
                  {f.wdhBis ? ` · ab ${tagKurz(f.datum)} bis ${tagKurz(f.wdhBis)}${f.wdhBis.slice(0, 4)}` : ""}
                  {f.wiederholung === "monatlich" && Number(f.datum.slice(8, 10)) >= 29 ? " · fällt in kürzeren Monaten aus" : ""}
                </p>
              )}
            </div>
          )}

          <div>
            <label className={LABEL} htmlFor="eintrag-notiz">Notiz</label>
            <textarea
              id="eintrag-notiz"
              value={f.notiz}
              onChange={(e) => setze("notiz", e.target.value)}
              rows={2}
              maxLength={KALENDER_NOTIZ_MAX}
              placeholder="optional"
              className="mt-1 w-full px-3 py-2 text-sm max-md:text-[16px] rounded-xl border border-input bg-transparent dark:bg-input/30 resize-none transition-all hover:border-foreground/30 focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring"
              style={{ fieldSizing: "content", minHeight: "3.5rem" } as React.CSSProperties}
            />
          </div>

          <div className="flex gap-2 pt-1 max-md:flex-wrap">
            {eintrag && (
              <button
                type="button"
                onClick={loeschenKlick}
                disabled={beschaeftigt}
                className="kasten kasten-red max-md:min-h-[36px]"
                data-tooltip={`${t.ding} löschen`}
              >
                {laeuft === "loeschen" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                {laeuft === "loeschen" ? "Wird gelöscht…" : "Löschen"}
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              disabled={beschaeftigt}
              className="kasten kasten-muted flex-1 max-md:min-h-[36px]"
            >
              Abbrechen
            </button>
            <button
              type="button"
              onClick={speichernKlick}
              disabled={beschaeftigt}
              className="kasten kasten-blue flex-1 max-md:min-h-[36px]"
            >
              {laeuft === "speichern" && <Loader2 className="h-4 w-4 animate-spin" />}
              {laeuft === "speichern" ? "Wird gespeichert…" : eintrag ? "Speichern" : "Eintragen"}
            </button>
          </div>
        </div>
      </Modal>

      {/* «Nur diesen / Alle» bei Terminen einer wiederkehrenden Veranstaltung */}
      {frage && eintrag && (
        <Modal
          open
          onClose={() => setFrage(null)}
          title="Löschen …"
          icon={<Repeat className="h-5 w-5 text-red-500" />}
          size="sm"
          sheet
        >
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              «{eintrag.titel}» wiederholt sich. Was soll gelöscht werden?
            </p>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => { setFrage(null); void ausfuehren(frage, "nur_diesen"); }}
                className="kasten kasten-red justify-center max-md:min-h-[36px]"
              >
                Nur diesen Termin ({serienTag})
              </button>
              <button
                type="button"
                onClick={() => { setFrage(null); void ausfuehren(frage, "serie"); }}
                className="kasten kasten-red justify-center max-md:min-h-[36px]"
              >
                Alle Termine der Serie
              </button>
              <button
                type="button"
                onClick={() => setFrage(null)}
                className="kasten kasten-muted justify-center max-md:min-h-[36px]"
              >
                Abbrechen
              </button>
            </div>
          </div>
        </Modal>
      )}
      {ConfirmModalElement}
    </>
  );
}
