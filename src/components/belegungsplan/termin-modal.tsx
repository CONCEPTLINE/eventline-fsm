"use client";

/**
 * Termin-Modal des Belegungsplans: eigenen Termin des Standorts anlegen,
 * aendern oder loeschen (Partnerportal und interner Location-Tab).
 *
 * Zeiten werden als Zuercher Wandzeit eingegeben und als ISO mit Zeitzone
 * gespeichert (zuerichZuIso). Ganztaegig: Start = 00:00 des ersten Tags,
 * Ende = 23:59 des letzten Tags. Mit Zeit: «Bis» kleiner/gleich «Von» am
 * selben Tag heisst «endet am Folgetag» (Abend-Anlass bis nach Mitternacht)
 * — das steht sichtbar unter den Feldern, nichts passiert still.
 *
 * Kein <form>: Enter springt wie app-weit zum naechsten Feld (useEnterAsTab
 * im Layout), gespeichert wird nur ueber den Knopf.
 * Das Modal wird pro Oeffnen neu gemountet (key im Aufrufer) — der Formular-
 * Zustand startet so immer frisch aus dem Eintrag bzw. dem gewaehlten Tag.
 */

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Trash2, CalendarPlus, CalendarClock } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { ZeitFeld } from "@/components/ui/zeit-feld";
import { useConfirm } from "@/components/ui/use-confirm";
import { plusTage } from "@/lib/swiss-time";
import { isoZuZuerich, zeitEingabeFehler, zuerichZuIso } from "@/lib/stempel-meldungen";
import type { KalenderEintrag, TerminEingabeKalender } from "@/lib/standort-kalender";
import type { KalenderAktion, KalenderSpeicherErgebnis } from "./belegungsplan-kalender";

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
}

function formularAus(e: KalenderEintrag | null, datumVorgabe: string): Formular {
  if (!e) {
    return { titel: "", kunde: "", datum: datumVorgabe, bisDatum: "", ganztaegig: false, von: "", bis: "", notiz: "" };
  }
  const s = isoZuZuerich(e.start);
  const en = e.ende ? isoZuZuerich(e.ende) : null;
  let bisDatum = "";
  if (en && en.datum !== s.datum) {
    // Abend bis nach Mitternacht ist ein Ein-Tages-Termin (Bis < Von).
    const ueberNacht = !e.ganztaegig && en.datum === plusTage(s.datum, 1) && en.zeit <= s.zeit;
    if (!ueberNacht) bisDatum = en.datum;
  }
  return {
    titel: e.titel,
    kunde: e.kunde ?? "",
    datum: s.datum,
    bisDatum,
    ganztaegig: e.ganztaegig,
    von: e.ganztaegig ? "" : s.zeit,
    bis: e.ganztaegig || !en ? "" : en.zeit,
    notiz: e.notiz ?? "",
  };
}

/** Folgetag-Regel: nur bei Ein-Tages-Terminen mit Bis <= Von. */
function endetAmFolgetag(f: Formular): boolean {
  return !f.ganztaegig && !!f.von && !!f.bis && (!f.bisDatum || f.bisDatum === f.datum) && f.bis <= f.von;
}

function eingabeBauen(f: Formular): { eingabe: TerminEingabeKalender } | { fehler: string } {
  const titel = f.titel.trim();
  if (!titel) return { fehler: "Titel ist Pflicht" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.datum)) return { fehler: "Datum ist Pflicht" };
  const letzterTag = f.bisDatum && f.bisDatum !== f.datum ? f.bisDatum : f.datum;
  if (letzterTag < f.datum) return { fehler: "Das Bis-Datum liegt vor dem Datum" };

  let start: string | null;
  let ende: string | null = null;
  if (f.ganztaegig) {
    start = zuerichZuIso(f.datum, "00:00");
    ende = zuerichZuIso(letzterTag, "23:59");
    if (!start || !ende) return { fehler: "Ungültiges Datum" };
  } else {
    if (!f.von) return { fehler: "Bitte die Startzeit (Von) angeben oder «ganztägig» wählen" };
    start = zuerichZuIso(f.datum, f.von);
    if (!start) return { fehler: zeitEingabeFehler(f.datum, f.von) ?? "Ungültige Startzeit" };
    if (f.bis) {
      const endTag = endetAmFolgetag(f) ? plusTage(f.datum, 1) : letzterTag;
      ende = zuerichZuIso(endTag, f.bis);
      if (!ende) return { fehler: zeitEingabeFehler(endTag, f.bis) ?? "Ungültige Endzeit" };
      if (new Date(ende).getTime() <= new Date(start).getTime()) return { fehler: "Das Ende liegt vor dem Beginn" };
    } else if (letzterTag !== f.datum) {
      return { fehler: "Bei mehrtägigen Terminen bitte die Endzeit (Bis) angeben oder «ganztägig» wählen" };
    }
  }
  return {
    eingabe: {
      titel,
      kunde: f.kunde.trim() || null,
      start,
      ende,
      ganztaegig: f.ganztaegig,
      notiz: f.notiz.trim() || null,
    },
  };
}

/** «06.11.» fuer den Folgetag-Hinweis (reiner Kalendertag, keine Zeitzone noetig). */
function tagKurz(tag: string): string {
  return `${tag.slice(8, 10)}.${tag.slice(5, 7)}.`;
}

// Felder am Handy: 16 px Schrift (sonst zoomt iOS) und 36 px hoch («Dicht»).
// Das Modal haengt am body, ausserhalb von [data-partner-portal] — die
// Portal-Regel aus globals.css greift hier nicht, darum explizit.
const FELD = "mt-1 max-md:h-[36px] max-md:text-[16px]";
const LABEL = "text-[11px] font-medium";

interface Props {
  open: boolean;
  /** null = neuer Termin */
  eintrag: KalenderEintrag | null;
  /** Vorbelegtes Datum (YYYY-MM-DD) fuer neue Termine. */
  datumVorgabe: string;
  onClose: () => void;
  /** Nach erfolgreichem Speichern/Loeschen: Modal schliessen + neu laden. */
  onFertig: () => void;
  speichern: (aktion: KalenderAktion, id?: string, eingabe?: TerminEingabeKalender) => Promise<KalenderSpeicherErgebnis>;
}

export function TerminModal({ open, eintrag, datumVorgabe, onClose, onFertig, speichern }: Props) {
  const [f, setF] = useState<Formular>(() => formularAus(eintrag, datumVorgabe));
  const [laeuft, setLaeuft] = useState<"speichern" | "loeschen" | null>(null);
  const [fragt, setFragt] = useState(false);
  const { confirm, ConfirmModalElement } = useConfirm();

  const setze = <K extends keyof Formular>(k: K, v: Formular[K]) => setF((alt) => ({ ...alt, [k]: v }));
  const beschaeftigt = laeuft !== null;
  const folgetag = endetAmFolgetag(f);

  async function speichernKlick() {
    const r = eingabeBauen(f);
    if ("fehler" in r) {
      toast.error(r.fehler);
      return;
    }
    setLaeuft("speichern");
    const res = await speichern(eintrag ? "aendern" : "anlegen", eintrag?.id, r.eingabe);
    setLaeuft(null);
    if (!res.ok) {
      toast.error(res.fehler || "Termin konnte nicht gespeichert werden");
      return;
    }
    toast.success(eintrag ? "Termin gespeichert" : "Termin eingetragen");
    onFertig();
  }

  async function loeschenKlick() {
    if (!eintrag) return;
    setFragt(true);
    const ok = await confirm({
      title: "Termin löschen?",
      message: `«${eintrag.titel}» wird aus dem Belegungsplan entfernt.`,
      confirmLabel: "Löschen",
    });
    setFragt(false);
    if (!ok) return;
    setLaeuft("loeschen");
    const res = await speichern("loeschen", eintrag.id);
    setLaeuft(null);
    if (!res.ok) {
      toast.error(res.fehler || "Termin konnte nicht gelöscht werden");
      return;
    }
    toast.success("Termin gelöscht");
    onFertig();
  }

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={eintrag ? "Termin bearbeiten" : "Termin eintragen"}
        icon={eintrag ? <CalendarClock className="h-5 w-5 text-blue-500" /> : <CalendarPlus className="h-5 w-5 text-blue-500" />}
        size="md"
        sheet
        closable={!beschaeftigt && !fragt}
      >
        <div className="space-y-3">
          <div>
            <label className={LABEL} htmlFor="termin-titel">Titel *</label>
            <Input
              id="termin-titel"
              value={f.titel}
              onChange={(e) => setze("titel", e.target.value)}
              placeholder="z. B. Clubnacht, Private Feier"
              maxLength={200}
              autoFocus={!eintrag}
              className={FELD}
            />
          </div>
          <div>
            <label className={LABEL} htmlFor="termin-kunde">Kunde</label>
            <Input
              id="termin-kunde"
              value={f.kunde}
              onChange={(e) => setze("kunde", e.target.value)}
              placeholder="optional"
              maxLength={200}
              className={FELD}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={LABEL} htmlFor="termin-datum">Datum *</label>
              <Input
                id="termin-datum"
                type="date"
                value={f.datum}
                onChange={(e) => setze("datum", e.target.value)}
                className={FELD}
              />
            </div>
            <div>
              <label className={LABEL} htmlFor="termin-bis-datum">Bis Datum <span className="font-normal text-muted-foreground">(mehrtägig)</span></label>
              <Input
                id="termin-bis-datum"
                type="date"
                value={f.bisDatum}
                min={f.datum || undefined}
                onChange={(e) => setze("bisDatum", e.target.value)}
                className={FELD}
              />
            </div>
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
                  <label className={LABEL} htmlFor="termin-von">Von *</label>
                  <ZeitFeld id="termin-von" value={f.von} onChange={(v) => setze("von", v)} className={FELD} />
                </div>
                <div>
                  <label className={LABEL} htmlFor="termin-bis">Bis</label>
                  <ZeitFeld id="termin-bis" value={f.bis} onChange={(v) => setze("bis", v)} className={FELD} />
                </div>
              </div>
              {folgetag && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  Endet am Folgetag ({tagKurz(plusTage(f.datum, 1))}) um {f.bis}.
                </p>
              )}
            </div>
          )}

          <div>
            <label className={LABEL} htmlFor="termin-notiz">Notiz</label>
            <textarea
              id="termin-notiz"
              value={f.notiz}
              onChange={(e) => setze("notiz", e.target.value)}
              rows={2}
              maxLength={2000}
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
                data-tooltip="Termin löschen"
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
      {ConfirmModalElement}
    </>
  );
}
