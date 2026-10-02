"use client";

/**
 * KI-Vorschlaege auf der Auftrags-Uebersicht — rechts neben dem Erfassen-
 * Feld (2026-10-02, kompakt): neues Event-Datum und Termine anlegen/aendern.
 * Nichts wird automatisch uebernommen: das Team entscheidet pro Vorschlag.
 * Die Daten kommen aus dem Auftrag (jobs.ai_datum_vorschlag /
 * ai_termin_vorschlaege) — nach jedem Erfassen sind neue Vorschlaege damit
 * sofort hier; Entscheidungen schreiben unter USER-RLS und laden neu.
 */

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { CalendarClock, CalendarPlus, Check, Loader2, Sparkles, X } from "lucide-react";
import type { KiDatumVorschlag, KiTerminVorschlag } from "@/types";

const ZRH = "Europe/Zurich";

function fmtDatum(ymd: string): string {
  return new Date(`${ymd}T12:00:00Z`).toLocaleDateString("de-CH", {
    timeZone: ZRH, day: "2-digit", month: "2-digit", year: "numeric",
  });
}

/** "26.11.2026, 17:30 – 18:00" (gleicher Tag) bzw. voll ausgeschrieben. */
function fmtZeitBereich(start: string, ende: string | null): string {
  const voll = (iso: string) => new Date(iso).toLocaleString("de-CH", {
    timeZone: ZRH, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
  if (!ende) return voll(start);
  const tag = (iso: string) => new Date(iso).toLocaleDateString("de-CH", { timeZone: ZRH });
  const e = tag(start) === tag(ende)
    ? new Date(ende).toLocaleTimeString("de-CH", { timeZone: ZRH, hour: "2-digit", minute: "2-digit" })
    : voll(ende);
  return `${voll(start)} – ${e}`;
}

export function KiVorschlaege({
  jobId,
  canEdit,
  datumVorschlag,
  terminVorschlaege,
  onChanged,
  className = "",
}: {
  jobId: string;
  canEdit: boolean;
  datumVorschlag: KiDatumVorschlag | null;
  terminVorschlaege: KiTerminVorschlag[];
  onChanged?: () => void;
  className?: string;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [datum, setDatum] = useState<KiDatumVorschlag | null>(datumVorschlag);
  const [termine, setTermine] = useState<KiTerminVorschlag[]>(terminVorschlaege);
  const [busy, setBusy] = useState<string | null>(null);

  // Mit dem Auftrag synchron halten (neue Vorschlaege nach dem Erfassen).
  const datumKey = JSON.stringify(datumVorschlag);
  const termineKey = JSON.stringify(terminVorschlaege);
  useEffect(() => { setDatum(datumVorschlag); }, [datumKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setTermine(terminVorschlaege); }, [termineKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const anzahl = (datum ? 1 : 0) + termine.length;
  if (anzahl === 0) return null;

  async function datumEntscheiden(uebernehmen: boolean) {
    if (!datum || busy) return;
    setBusy("datum");
    const { error } = await supabase
      .from("jobs")
      .update(uebernehmen
        ? {
            start_date: `${datum.start_datum}T00:00:00+00:00`,
            end_date: `${datum.end_datum}T00:00:00+00:00`,
            ai_datum_vorschlag: null,
          }
        : { ai_datum_vorschlag: null })
      .eq("id", jobId);
    setBusy(null);
    if (error) {
      toast.error((uebernehmen ? "Umdatieren" : "Verwerfen") + " fehlgeschlagen: " + error.message);
      return;
    }
    setDatum(null);
    if (uebernehmen) toast.success("Event-Datum angepasst");
    onChanged?.();
  }

  /** Termin-Vorschlag uebernehmen oder verwerfen — Termine werden NIE
   *  automatisch angelegt, nur hier auf Klick (unter USER-RLS). */
  async function terminEntscheiden(idx: number, uebernehmen: boolean) {
    const t = termine[idx];
    if (!t || busy) return;
    setBusy(`t${idx}`);
    try {
      if (uebernehmen) {
        if (t.aktion === "aendern" && t.termin_id) {
          const upd: { title: string; start_time: string; end_time?: string } = { title: t.titel, start_time: t.start };
          if (t.ende) upd.end_time = t.ende;
          const { error } = await supabase.from("job_appointments").update(upd).eq("id", t.termin_id);
          if (error) throw new Error(error.message);
          // Verschiebbarer Partner-Termin → Partner ueber die neue Zeit
          // informieren (Route prueft Modus + Partner-Location selbst und
          // tut sonst nichts). Best-effort, blockiert die Uebernahme nicht.
          fetch(`/api/appointments/${t.termin_id}/verschoben-melden`, { method: "POST" }).catch(() => {});
        } else {
          const { error } = await supabase.from("job_appointments").insert({
            job_id: jobId, title: t.titel, description: t.grund, start_time: t.start, end_time: t.ende,
          });
          if (error) throw new Error(error.message);
        }
        window.dispatchEvent(new CustomEvent("appointments:invalidate", { detail: { jobId } }));
        toast.success(t.aktion === "aendern" ? "Termin angepasst" : "Termin erstellt");
      }
      const rest = termine.filter((_, i) => i !== idx);
      const { error: perErr } = await supabase
        .from("jobs")
        .update({ ai_termin_vorschlaege: rest.length ? { vorschlaege: rest } : null })
        .eq("id", jobId);
      if (perErr) throw new Error(perErr.message);
      setTermine(rest);
      onChanged?.();
    } catch (e) {
      toast.error("Aktion fehlgeschlagen: " + (e instanceof Error ? e.message : "unbekannter Fehler"));
    } finally {
      setBusy(null);
    }
  }

  return (
    // Gleicher Kartenstil wie die uebrigen Uebersichts-Kacheln; Hinweisfarbe
    // nur am Symbol und an der Zaehl-Pille (wie frueher "2 offen").
    <section className={`rounded-2xl border border-border bg-card p-4 ${className}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5 mb-1">
        <Sparkles className="h-3.5 w-3.5 text-amber-500" />
        KI-Vorschläge
        <span className="text-[10px] font-semibold normal-case tracking-normal text-amber-700 dark:text-amber-400 bg-amber-500/15 rounded-full px-1.5 py-0.5">
          {anzahl} offen
        </span>
      </p>
      <div className="divide-y divide-border/60">

      {datum && (
        <VorschlagZeile
          icon={<CalendarClock className="h-4 w-4" />}
          titel={`Event-Datum auf ${datum.start_datum === datum.end_datum
            ? fmtDatum(datum.start_datum)
            : `${fmtDatum(datum.start_datum)} – ${fmtDatum(datum.end_datum)}`}`}
          meta="Datum verschieben"
          grund={datum.grund}
          jaLabel="Umdatieren"
          canEdit={canEdit}
          busy={busy === "datum"}
          gesperrt={busy !== null}
          onJa={() => datumEntscheiden(true)}
          onNein={() => datumEntscheiden(false)}
        />
      )}

      {termine.map((t, idx) => (
        <VorschlagZeile
          key={`${t.titel}-${t.start}`}
          icon={<CalendarPlus className="h-4 w-4" />}
          titel={t.titel}
          meta={`${t.aktion === "aendern" ? "Termin ändern" : "Neuer Termin"} · ${fmtZeitBereich(t.start, t.ende)}`}
          grund={t.grund}
          jaLabel={t.aktion === "aendern" ? "Anpassen" : "Erstellen"}
          canEdit={canEdit}
          busy={busy === `t${idx}`}
          gesperrt={busy !== null}
          onJa={() => terminEntscheiden(idx, true)}
          onNein={() => terminEntscheiden(idx, false)}
        />
      ))}
      </div>
    </section>
  );
}

function VorschlagZeile({ icon, titel, meta, grund, jaLabel, canEdit, busy, gesperrt, onJa, onNein }: {
  icon: React.ReactNode;
  titel: string;
  meta: string;
  grund: string;
  jaLabel: string;
  canEdit: boolean;
  busy: boolean;
  gesperrt: boolean;
  onJa: () => void;
  onNein: () => void;
}) {
  return (
    <div className="flex items-start gap-2.5 py-2.5">
      <span className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium truncate">{titel}</p>
        <p className="text-[12px] text-muted-foreground tabular-nums">{meta}</p>
        <p className="text-[11px] text-muted-foreground/80 line-clamp-2 mt-0.5" data-tooltip={grund}>{grund}</p>
      </div>
      {canEdit && (
        <div className="flex items-center gap-1 shrink-0">
          <button type="button" className="kasten kasten-red" disabled={gesperrt} onClick={onJa}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            {jaLabel}
          </button>
          <button
            type="button"
            className="kasten kasten-muted !px-2"
            disabled={gesperrt}
            onClick={onNein}
            data-tooltip="Verwerfen"
            aria-label="Verwerfen"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
