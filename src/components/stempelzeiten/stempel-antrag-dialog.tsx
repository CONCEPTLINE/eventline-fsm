"use client";

/**
 * Stempel nachtragen / ändern / löschen über die Lohnverwaltung
 * (Lohn-Umbau Phase 4, Laptop-Funktion).
 *
 * Für Personen mit Lohnrecht (lohn:manage) auf einem vertrauten Gerät:
 * POST /api/hr/stempel-antrag. Offene Monate ändert der Server direkt;
 * abgerechnete Monate nur per ANTRAG mit Begründung, den eine zweite Person
 * (anderer Admin oder Vertretung) innert 24 h bestätigt — gleiche Wortwahl
 * wie ANTRAG_HINWEIS_LOHN (src/lib/lohn/aenderungen.ts).
 */

import { useState } from "react";
import { FileClock, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import { ZeitFeld } from "@/components/ui/zeit-feld";
import { isTimeEntryLocked } from "@/lib/time-lock";
import { isoZuZuerich, istLang, LANG_STUNDEN, stempelSpanne, zuerichZuIso } from "@/lib/stempel-meldungen";

export interface AntragStempel {
  id: string;
  userId: string | null;
  clockIn: string;
  clockOut: string | null;
  description: string | null;
  langBegruendung: string | null;
}

export type AntragZiel =
  | { op: "insert"; userId: string; personName: string | null }
  | { op: "update" | "delete"; stempel: AntragStempel; personName: string | null };

const HINWEIS =
  "Betrifft die Änderung abgerechnete Monate, wird sie beantragt: wirksam, wenn eine zweite Person (anderer Admin oder Vertretung) innert 24 h auf einem vertrauten Gerät bestätigt. Danach schlägt das System Korrekturfassungen vor.";

interface Props {
  ziel: AntragZiel;
  onClose: () => void;
  /** Nach Erfolg (direkt geändert oder Antrag gestellt) — Liste neu laden. */
  onErledigt: () => void;
}

export function StempelAntragDialog({ ziel, onClose, onErledigt }: Props) {
  const alt = ziel.op === "insert" ? null : ziel.stempel;
  const start = alt ? isoZuZuerich(alt.clockIn) : null;
  const ende = alt?.clockOut ? isoZuZuerich(alt.clockOut) : null;
  const [vonDatum, setVonDatum] = useState(start?.datum ?? "");
  const [vonZeit, setVonZeit] = useState(start?.zeit ?? "");
  const [bisDatum, setBisDatum] = useState(ende?.datum ?? start?.datum ?? "");
  const [bisZeit, setBisZeit] = useState(ende?.zeit ?? "");
  const [beschreibung, setBeschreibung] = useState("");
  const [langBegruendung, setLangBegruendung] = useState(alt?.langBegruendung ?? "");
  const [begruendung, setBegruendung] = useState("");
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);
  const [antragNoetig, setAntragNoetig] = useState(false);

  const loeschen = ziel.op === "delete";
  const von = vonDatum && vonZeit ? zuerichZuIso(vonDatum, vonZeit) : null;
  const bis = bisDatum && bisZeit ? zuerichZuIso(bisDatum, bisZeit) : null;
  const lang = !loeschen && !!von && !!bis && istLang(von, bis);
  const gesperrt = antragNoetig || (alt ? isTimeEntryLocked(alt.clockIn) : false) || (!loeschen && !!von && isTimeEntryLocked(von));
  const wer = ziel.personName ?? "diese Person";

  function pruefen(): string | null {
    if (loeschen) return gesperrt && begruendung.trim().length < 10 ? "Begründung fehlt (mindestens 10 Zeichen)." : null;
    if (!von) return "Beginn fehlt (Datum und Uhrzeit).";
    const ohneEnde = alt !== null && alt.clockOut === null && !bisZeit;
    if (!bis && !ohneEnde) return "Ende fehlt (Datum und Uhrzeit).";
    if (bis && Date.parse(bis) < Date.parse(von)) return "Das Ende liegt vor dem Beginn.";
    if (bis && Date.parse(bis) > Date.now()) return "Das Ende liegt in der Zukunft.";
    if (ziel.op === "insert" && !beschreibung.trim()) return "Beschreibung fehlt (was wurde gearbeitet?).";
    if (lang && !langBegruendung.trim()) return `Über ${LANG_STUNDEN} Stunden: Begründung zum langen Stempel fehlt.`;
    if (gesperrt && begruendung.trim().length < 10) return "Begründung für den Antrag fehlt (mindestens 10 Zeichen).";
    return null;
  }

  async function senden() {
    const f = pruefen();
    if (f) {
      setFehler(f);
      return;
    }
    setBusy(true);
    setFehler(null);
    const body: Record<string, unknown> = { op: ziel.op, begruendung: begruendung.trim() || null };
    if (ziel.op === "insert") {
      Object.assign(body, { user_id: ziel.userId, clock_in: von, clock_out: bis, description: beschreibung.trim() });
      if (lang) body.lang_begruendung = langBegruendung.trim();
    } else {
      body.id = ziel.stempel.id;
      if (ziel.op === "update") {
        if (von !== new Date(ziel.stempel.clockIn).toISOString()) body.clock_in = von;
        const altBis = ziel.stempel.clockOut ? new Date(ziel.stempel.clockOut).toISOString() : null;
        if (bis !== altBis && bis) body.clock_out = bis;
        if (lang && langBegruendung.trim() !== (ziel.stempel.langBegruendung ?? "")) body.lang_begruendung = langBegruendung.trim();
        if (!("clock_in" in body) && !("clock_out" in body) && !("lang_begruendung" in body)) {
          setBusy(false);
          setFehler("Keine Änderung.");
          return;
        }
      }
    }
    try {
      const res = await fetch("/api/hr/stempel-antrag", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => null)) as { success?: boolean; mode?: string; meldung?: string; error?: string; message?: string } | null;
      if (json?.success && json.mode === "antrag") {
        toast.success("Antrag gestellt", { description: json.meldung, duration: 10000 });
        onErledigt();
        return;
      }
      if (json?.success) {
        toast.success(loeschen ? "Stempel gelöscht" : ziel.op === "insert" ? "Stempel nachgetragen" : "Stempel geändert");
        onErledigt();
        return;
      }
      if (json?.mode === "begruendung_noetig") setAntragNoetig(true);
      const text = json?.message ?? json?.error ?? "Speichern fehlgeschlagen";
      setFehler(text);
      toast.error(text, { duration: 8000 });
    } catch {
      toast.error("Keine Verbindung — bitte nochmals versuchen");
    } finally {
      setBusy(false);
    }
  }

  const titel = loeschen ? "Stempel löschen" : ziel.op === "insert" ? "Stempel nachtragen" : "Stempel ändern";

  return (
    <Modal
      open
      onClose={() => !busy && onClose()}
      size="md"
      title={titel}
      icon={<FileClock className="h-5 w-5 text-amber-600 dark:text-amber-400" />}
      closable={!busy}
    >
      <p className="text-sm">
        {wer}
        {alt && <span className="text-muted-foreground"> · {stempelSpanne({ clock_in: alt.clockIn, clock_out: alt.clockOut })}</span>}
      </p>

      {!loeschen && (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <p className="ml-1 text-[11px] font-medium text-muted-foreground">Beginn *</p>
            <div className="flex gap-2">
              <Input type="date" value={vonDatum} onChange={(e) => { setVonDatum(e.target.value); setFehler(null); }} className="flex-1" aria-label="Datum Beginn" />
              <ZeitFeld value={vonZeit} onChange={(v) => { setVonZeit(v); setFehler(null); }} className="w-20" aria-label="Zeit Beginn" />
            </div>
          </div>
          <div className="space-y-1">
            <p className="ml-1 text-[11px] font-medium text-muted-foreground">Ende *</p>
            <div className="flex gap-2">
              <Input type="date" value={bisDatum} onChange={(e) => { setBisDatum(e.target.value); setFehler(null); }} className="flex-1" aria-label="Datum Ende" />
              <ZeitFeld value={bisZeit} onChange={(v) => { setBisZeit(v); setFehler(null); }} className="w-20" aria-label="Zeit Ende" />
            </div>
          </div>
        </div>
      )}

      {ziel.op === "insert" && (
        <div className="space-y-1">
          <p className="ml-1 text-[11px] font-medium text-muted-foreground">Beschreibung *</p>
          <Input value={beschreibung} onChange={(e) => setBeschreibung(e.target.value)} placeholder="kurz: was wurde gearbeitet" maxLength={500} />
        </div>
      )}

      {lang && (
        <div className="space-y-1">
          <p className="ml-1 text-[11px] font-medium text-muted-foreground">Über {LANG_STUNDEN} Stunden — warum so lang? *</p>
          <Input value={langBegruendung} onChange={(e) => setLangBegruendung(e.target.value)} placeholder="z. B. Aufbau und Anlass am Stück" maxLength={500} />
        </div>
      )}

      <div className="space-y-1">
        <p className="ml-1 text-[11px] font-medium text-muted-foreground">
          Begründung{gesperrt ? " für den Antrag *" : " (nur nötig, wenn der Monat abgerechnet ist)"}
        </p>
        <textarea
          value={begruendung}
          onChange={(e) => { setBegruendung(e.target.value); setFehler(null); }}
          rows={2}
          maxLength={1000}
          disabled={busy}
          className="w-full resize-none rounded-xl border border-border bg-card px-3 py-2 text-sm"
          placeholder="z. B. Mitarbeiter hat Ausstempeln vergessen, Ende laut Rapport 17:30"
        />
      </div>

      <p className={`rounded-xl px-3 py-2 text-xs leading-relaxed ${gesperrt
        ? "bg-amber-50 text-amber-900 dark:bg-amber-500/15 dark:text-amber-100"
        : "bg-muted/40 text-muted-foreground"}`}
      >
        {gesperrt ? "Monat abgerechnet. " : ""}{HINWEIS}
      </p>

      {fehler && <p className="text-sm font-medium text-red-600 dark:text-red-400" role="alert">{fehler}</p>}

      <div className="flex gap-2">
        <button type="button" onClick={onClose} disabled={busy} className="kasten flex-1">Abbrechen</button>
        <button type="button" onClick={senden} disabled={busy} className={`kasten flex-1 ${loeschen ? "kasten-red" : "kasten-green"}`}>
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {busy ? "Wird gesendet…" : gesperrt ? "Antrag stellen" : loeschen ? "Löschen" : "Speichern"}
        </button>
      </div>
    </Modal>
  );
}
