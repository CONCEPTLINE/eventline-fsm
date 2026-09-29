"use client";

// Mehrfach-Kontakte am Kunden (Leo 2026-09-29): mehrere E-Mails/
// Telefonnummern, jede mit kleinem Label davor (Primär, Sekundär,
// Notfall, …). Der ERSTE Eintrag ist der Primaerkontakt und wird in die
// bestehenden Einzel-Spalten customers.email/phone gespiegelt — alle
// uebrigen App-Teile (Bexio, Mails, Listen) laufen unveraendert damit.

import { Input } from "@/components/ui/input";
import { Plus, Trash2 } from "lucide-react";

export interface KontaktEintrag {
  label: string;
  wert: string;
}

/** Erster nicht-leerer Wert = Primaerkontakt (Spiegel fuer email/phone). */
export function primaerWert(eintraege: KontaktEintrag[]): string {
  return eintraege.find((e) => e.wert.trim())?.wert.trim() ?? "";
}

/** Trim + leere Zeilen raus — vor jedem Speichern anwenden. */
export function bereinigeKontakte(eintraege: KontaktEintrag[]): KontaktEintrag[] {
  return eintraege
    .map((e) => ({ label: e.label.trim(), wert: e.wert.trim() }))
    .filter((e) => e.wert !== "");
}

export function KontaktListeEditor({ art, eintraege, onChange }: {
  art: "email" | "phone";
  eintraege: KontaktEintrag[];
  onChange: (next: KontaktEintrag[]) => void;
}) {
  const zeilen = eintraege.length > 0 ? eintraege : [{ label: "Primär", wert: "" }];

  function update(i: number, patch: Partial<KontaktEintrag>) {
    onChange(zeilen.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  }

  return (
    <div className="space-y-1.5">
      {zeilen.map((e, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <Input
            value={e.label}
            onChange={(ev) => update(i, { label: ev.target.value })}
            placeholder={i === 0 ? "Primär" : "z.B. Sekundär, Notfall"}
            className="w-28 shrink-0 bg-muted/40 text-xs"
            aria-label="Kontakt-Label"
          />
          <Input
            type={art === "email" ? "email" : "text"}
            value={e.wert}
            onChange={(ev) => update(i, { wert: ev.target.value })}
            placeholder={art === "email" ? "mail@beispiel.ch" : "+41 …"}
            className="flex-1 bg-muted/40"
          />
          <button
            type="button"
            onClick={() => onChange(zeilen.filter((_, idx) => idx !== i))}
            disabled={zeilen.length === 1 && !zeilen[0].wert && !zeilen[0].label}
            className="icon-btn icon-btn-red shrink-0"
            aria-label="Eintrag entfernen"
            data-tooltip="Entfernen"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...zeilen, { label: "", wert: "" }])}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <Plus className="h-3.5 w-3.5" />
        {art === "email" ? "Weitere E-Mail" : "Weitere Nummer"}
      </button>
    </div>
  );
}

export function KontaktAnzeige({ art, eintraege, einzelwert }: {
  art: "email" | "phone";
  eintraege: KontaktEintrag[];
  /** Fallback fuer Altbestand ohne Listen-Eintraege. */
  einzelwert?: string | null;
}) {
  const liste = eintraege.length > 0
    ? eintraege
    : einzelwert
      ? [{ label: "", wert: einzelwert }]
      : [];
  if (liste.length === 0) return <span className="text-muted-foreground/60">—</span>;
  return (
    <div className="space-y-0.5">
      {liste.map((e, i) => (
        <div key={i} className="flex items-baseline gap-1.5 min-w-0">
          {e.label && <span className="text-[11px] text-muted-foreground shrink-0">{e.label}:</span>}
          <a
            href={`${art === "email" ? "mailto" : "tel"}:${e.wert}`}
            className="hover:text-blue-600 dark:hover:text-blue-400 transition-colors truncate"
          >
            {e.wert}
          </a>
        </div>
      ))}
    </div>
  );
}
