"use client";

/** Kleine Bausteine des Ablauf-Reiters — gleiche Optik wie die Karten im Auftrag (overview-tab). */

import { useState, type ReactNode } from "react";
import { Check, CircleHelp, Loader2, Mail, TriangleAlert, X } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { EmlArt } from "@/lib/ablauf/eml";

/** Karte mit Mini-Label als Titel — gleiche Optik wie «Wer» / «Wo & Wann» im overview-tab (ohne Icon). */
export function Karte({
  titel,
  rechts,
  children,
  className = "",
}: {
  titel: string;
  rechts?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card className={`bg-card ${className}`}>
      <CardHeader className="pb-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{titel}</p>
          {rechts}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

export function Chip({ ton, children, tooltip }: { ton: "warn" | "offen" | "ok" | "neutral"; children: ReactNode; tooltip?: string }) {
  const stil =
    ton === "warn"
      ? "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300"
      : ton === "offen"
        ? "bg-purple-100 text-purple-800 dark:bg-purple-500/20 dark:text-purple-300"
        : ton === "ok"
          ? "bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-300"
          : "bg-foreground/[0.06] dark:bg-foreground/[0.12] text-muted-foreground";
  const icon =
    ton === "warn" ? <TriangleAlert className="h-3 w-3" /> : ton === "offen" ? <CircleHelp className="h-3 w-3" /> : ton === "ok" ? <Check className="h-3 w-3" /> : null;
  return (
    <span data-tooltip={tooltip} className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium rounded-full ${stil}`}>
      {icon}
      {children}
    </span>
  );
}

/** Dateiname aus «Content-Disposition» (RFC 5987 filename* bevorzugt). */
function dateinameAus(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const stern = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (stern) {
    try {
      return decodeURIComponent(stern[1]);
    } catch {
      /* weiter unten */
    }
  }
  const einfach = /filename="?([^";]+)"?/i.exec(header);
  return einfach?.[1] ?? fallback;
}

async function fehlerText(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { error?: string };
    if (j?.error) return j.error;
  } catch {
    /* kein JSON */
  }
  return `Fehler ${res.status}`;
}

/**
 * «… in Outlook öffnen» → lädt die .eml (X-Unsent: 1) vom Server; Outlook
 * öffnet sie als bearbeitbaren ENTWURF. Aus der App wird nie gesendet.
 */
export function OutlookKnopf({
  jobId,
  art,
  label,
  emailFehlt,
  vorher,
  ton = "blue",
}: {
  jobId: string;
  art: EmlArt;
  label: string;
  /** Ohne Mieter-E-Mail gibt es keinen Empfänger → Hinweis statt Download. */
  emailFehlt: boolean;
  /** Vor dem Laden: offene Feld-Änderungen speichern (false = abbrechen). */
  vorher?: () => Promise<boolean>;
  ton?: "blue" | "muted";
}) {
  const [laedt, setLaedt] = useState(false);
  async function oeffnen() {
    if (emailFehlt) {
      toast.error("E-Mail-Adresse der Mieterin fehlt", { description: "Erst bei Basil nachfragen und oben eintragen." });
      return;
    }
    setLaedt(true);
    try {
      if (vorher && !(await vorher())) return;
      const res = await fetch(`/api/jobs/${jobId}/ablauf/eml?art=${art}`, { cache: "no-store" });
      if (!res.ok) {
        toast.error("Entwurf konnte nicht erstellt werden", { description: await fehlerText(res) });
        return;
      }
      const blob = await res.blob();
      const name = dateinameAus(res.headers.get("Content-Disposition"), `${art}.eml`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success("Entwurf erstellt", { description: "Öffnet als Entwurf in Outlook — gesendet wird erst dort." });
    } catch {
      toast.error("Entwurf konnte nicht erstellt werden", { description: "Keine Verbindung zum Server" });
    } finally {
      setLaedt(false);
    }
  }
  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button type="button" onClick={oeffnen} disabled={laedt} className={`kasten kasten-${ton}`}>
        {laedt ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />}
        {laedt ? "Wird vorbereitet…" : label}
      </button>
      <span className="text-[10px] text-muted-foreground pl-0.5">öffnet als Entwurf in Outlook · CC auftrag@</span>
    </div>
  );
}

/** Abhak-Zeile mit state-getriebenem Hover. */
export function HakenZeile({
  an,
  onToggle,
  children,
  nurLesen,
  speichert,
}: {
  an: boolean;
  onToggle: () => void;
  children: ReactNode;
  nurLesen?: boolean;
  /** wird gerade gespeichert → Spinner im Kästchen */
  speichert?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={nurLesen ? undefined : onToggle}
      disabled={nurLesen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="w-full flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors disabled:cursor-default"
      style={{ background: hover && !nurLesen ? "color-mix(in oklab, var(--foreground) 7%, transparent)" : "transparent" }}
    >
      <span
        className="h-4 w-4 shrink-0 rounded border flex items-center justify-center transition-colors"
        style={{
          borderColor: an ? "var(--status-green)" : "color-mix(in oklab, var(--foreground) 30%, transparent)",
          background: an ? "var(--status-green)" : "transparent",
        }}
      >
        {speichert ? (
          <Loader2 className={`h-3 w-3 animate-spin ${an ? "text-white" : "text-muted-foreground"}`} />
        ) : (
          an && <Check className="h-3 w-3 text-white" strokeWidth={3} />
        )}
      </span>
      <span className={an ? "text-muted-foreground line-through decoration-foreground/30" : ""}>{children}</span>
    </button>
  );
}

/** Label/Wert-Zeile für erkannte Felder. */
export function FeldZeile({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 min-w-0 py-0.5">
      <span className="w-28 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 text-sm break-words">{children}</span>
    </div>
  );
}

/** Ja/Nein-Werte als eine Zeile kleiner Chips: ✓ ja (Vordergrund), ✗ nein (gedämpft, durchgestrichen). */
export function JaNeinChips({ werte }: { werte: [string, boolean][] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {werte.map(([label, ja]) => (
        <span
          key={label}
          className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${
            ja ? "border-foreground/20 text-foreground" : "border-transparent bg-foreground/[0.05] dark:bg-foreground/[0.10] text-muted-foreground line-through decoration-foreground/30"
          }`}
        >
          {ja ? <Check className="h-3 w-3" strokeWidth={2.5} /> : <X className="h-3 w-3" />}
          {label}
        </span>
      ))}
    </div>
  );
}

/** Dezenter Text-Knopf (Ghost) mit state-getriebenem Hover. */
export function GhostKnopf({
  onClick,
  children,
  tooltip,
  disabled,
}: {
  onClick: () => void;
  children: ReactNode;
  tooltip?: string;
  disabled?: boolean;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors disabled:opacity-60"
      style={{
        color: hover ? "var(--foreground)" : "var(--muted-foreground)",
        background: hover ? "color-mix(in oklab, var(--foreground) 7%, transparent)" : "transparent",
      }}
      data-tooltip={tooltip}
      data-tooltip-align="end"
    >
      {children}
    </button>
  );
}
