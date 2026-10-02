"use client";

/**
 * KI-Zusammenfassung des Auftrags (jobs.ai_summary) als zwei Kacheln
 * Operativ | Administrativ — von der Eingang-KI gefuehrt, manuell
 * ueberschreibbar (Leos Vorgabe: Aenderungen immer moeglich).
 * Daten kommen aus dem Auftrag; nach jedem Erfassen sofort aktuell.
 * (Die frueheren "Zusagen an den Kunden" sind seit 2026-10-02 komplett
 * entfernt — sie doppelten die Offen-Punkte der Zusammenfassung.)
 */

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Briefcase, Check, ChevronRight, Loader2, Pencil, Wrench, X } from "lucide-react";

export function KiZusammenfassung({
  jobId,
  canEdit,
  summary,
  onSaved,
  className = "",
}: {
  jobId: string;
  canEdit: boolean;
  summary: string | null;
  onSaved?: () => void;
  className?: string;
}) {
  const supabase = useMemo(() => createClient(), []);
  const [text, setText] = useState<string | null>(summary);
  const [edit, setEdit] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { setText(summary); }, [summary]);

  async function speichern() {
    setSaving(true);
    const neu = draft.trim() || null;
    const { error } = await supabase.from("jobs").update({ ai_summary: neu }).eq("id", jobId);
    setSaving(false);
    if (error) { toast.error("Speichern fehlgeschlagen: " + error.message); return; }
    setText(neu);
    setEdit(false);
    onSaved?.();
  }

  if (edit) {
    return (
      <section className={`rounded-2xl border border-border bg-card p-4 space-y-1.5 ${className}`}>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Zusammenfassung bearbeiten
        </p>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={14}
          className="w-full text-sm rounded-xl border border-border bg-muted/20 px-3 py-2 focus:outline-none focus:border-foreground/40 resize-y font-mono"
        />
        <div className="flex gap-1.5 justify-end">
          <button type="button" className="kasten kasten-muted" onClick={() => setEdit(false)}><X className="h-3.5 w-3.5" /> Abbrechen</button>
          <button type="button" className="kasten kasten-red" onClick={speichern} disabled={saving}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />} Speichern
          </button>
        </div>
      </section>
    );
  }

  const tiles = text ? splitTiles(text) : null;
  const startEdit = canEdit ? () => { setDraft(text ?? LEER_VORLAGE); setEdit(true); } : undefined;

  if (!tiles) {
    return (
      <SummaryTile
        className={className}
        titel="Zusammenfassung"
        icon={<Wrench className="h-3.5 w-3.5" />}
        text={text ?? ""}
        onEdit={startEdit}
        hint="Noch keine Zusammenfassung — sie entsteht automatisch, sobald oben etwas erfasst wird."
      />
    );
  }

  return (
    <div className={`grid grid-cols-1 sm:grid-cols-2 gap-3 items-start ${className}`}>
      <SummaryTile titel="Operativ" icon={<Wrench className="h-3.5 w-3.5" />} text={tiles.operativ} onEdit={startEdit}
        hint="Noch nichts Operatives — entsteht aus dem Erfassen-Feld." />
      <SummaryTile titel="Administrativ" icon={<Briefcase className="h-3.5 w-3.5" />} text={tiles.administrativ} onEdit={startEdit}
        hint="Noch nichts Administratives — entsteht aus dem Erfassen-Feld." />
    </div>
  );
}

/** Vorlage fuer manuelles Erst-Erfassen im Kachel-Format. */
const LEER_VORLAGE = "=== OPERATIV ===\n\n=== ADMINISTRATIV ===\n";

/** Trennt die Zusammenfassung in die zwei Kacheln (Marker-Zeilen
 *  "=== OPERATIV ===" / "=== ADMINISTRATIV ==="). null = Alt-Format
 *  ohne Marker → eine Einzel-Kachel als Fallback. */
function splitTiles(text: string): { operativ: string; administrativ: string } | null {
  if (!/^===\s*OPERATIV/m.test(text)) return null;
  const op: string[] = [];
  const ad: string[] = [];
  let cur: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^===\s*(OPERATIV|ADMINISTRATIV)\s*===\s*$/i);
    if (m) { cur = m[1].toUpperCase() === "OPERATIV" ? op : ad; continue; }
    cur?.push(line);
  }
  return { operativ: op.join("\n").trim(), administrativ: ad.join("\n").trim() };
}

/** Eine Wissens-Kachel im Look der uebrigen Auftrag-Kacheln (WER/NOTIZEN). */
function SummaryTile({ titel, icon, text, onEdit, hint, className = "" }: {
  titel: string;
  icon: React.ReactNode;
  text: string;
  onEdit?: () => void;
  hint: string;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-border bg-card p-4 relative min-w-0 ${className}`}>
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2 flex items-center gap-1.5">
        {icon} {titel}
      </p>
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          className="absolute top-3 right-3 p-1 rounded text-muted-foreground/50 hover:text-foreground hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.14]"
          data-tooltip="Bearbeiten"
          data-tooltip-align="end"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
      )}
      {text ? (
        <div className="text-sm text-foreground/90"><SummaryView text={text} /></div>
      ) : (
        <p className="text-[12px] text-muted-foreground">{hint}</p>
      )}
    </section>
  );
}

/** Gliedert die KI-Zusammenfassung: GROSSBUCHSTABEN-Zeile = Abschnitts-Label,
 *  "- "-Zeilen = Stichpunkte, Rest = normaler Text. Faellt bei Alt-Daten
 *  (reiner Fliesstext) automatisch auf normale Absaetze zurueck. */
function SummaryView({ text }: { text: string }) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (
    <div className="space-y-1">
      {lines.map((line, i) => {
        const isHeader = line.length <= 48 && !line.startsWith("- ") && line === line.toUpperCase() && /[A-ZÄÖÜ]/.test(line);
        if (isHeader) {
          return <p key={i} className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground !mt-3.5 first:!mt-0">{line}</p>;
        }
        if (line.startsWith("- ")) {
          const body = line.slice(2);
          // "- OFFEN: …" = Handlungsbedarf, faellt farblich auf.
          if (/^OFFEN:/i.test(body)) {
            // Klartext statt Symbol/Chip (Leo): die Zeile beginnt woertlich
            // mit "Offen:" — sofort verstaendlich, farblich abgehoben.
            return (
              <p key={i} className="flex gap-2 leading-relaxed text-amber-700 dark:text-amber-400">
                <span className="text-muted-foreground/60 shrink-0">–</span>
                <span><span className="font-semibold">Offen:</span> {body.replace(/^OFFEN:\s*/i, "")}</span>
              </p>
            );
          }
          // "- Schlagwort: Kern" — zusammenklappbar: standardmaessig nur das
          // Schlagwort, Klick zeigt den Text (Leo: nur lesen was man gerade
          // wissen muss). Offen-Punkte bleiben immer voll sichtbar.
          // Schlagwort = alles bis zum ersten ": " (grosszuegige Laenge —
          // die KI baut teils Klammer-Zusaetze ins Schlagwort; Uhrzeiten
          // wie 13:30 matchen nicht, weil nach dem ":" kein Leerzeichen folgt).
          const m = body.match(/^([^:]{2,64}):\s+(.*)$/);
          if (m) return <KlappPunkt key={`${i}-${m[1]}`} titel={m[1]} text={m[2]} />;
          return (
            <p key={i} className="flex gap-2 leading-relaxed">
              <span className="text-muted-foreground/60 shrink-0">–</span>
              <span>{body}</span>
            </p>
          );
        }
        return <p key={i} className="leading-relaxed">{line}</p>;
      })}
    </div>
  );
}

/** Ein zusammenklappbarer Stichpunkt: Kopf = Schlagwort mit Chevron,
 *  Klick klappt die Kernaussage darunter auf/zu. */
function KlappPunkt({ titel, text }: { titel: string; text: string }) {
  const [offen, setOffen] = useState(false);
  const [hover, setHover] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOffen((o) => !o)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className="flex items-center gap-1.5 w-full text-left rounded-md px-1 py-0.5 -mx-1"
        style={{ background: hover ? "color-mix(in srgb, var(--foreground) 7%, transparent)" : "transparent" }}
        aria-expanded={offen}
      >
        <ChevronRight
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70 transition-transform"
          style={{ transform: offen ? "rotate(90deg)" : "none" }}
        />
        <span className="font-medium leading-snug">{titel}</span>
      </button>
      {offen && <p className="leading-relaxed text-foreground/90 pl-[26px] pr-1 pt-0.5 pb-1">{text}</p>}
    </div>
  );
}
