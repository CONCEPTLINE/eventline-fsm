"use client";

// Geteilte UI-Bausteine der Technik-Planung — im Firmen-Tab UND im
// Lieferantenportal verwendet, damit beide Seiten dasselbe sehen
// (Konsistenz-Grundregel).

import { useState } from "react";
import {
  Loader2, Send, CheckCircle2, AlertTriangle, Lightbulb, ChevronDown, Clock, Check, RefreshCw, XCircle, Archive,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type {
  Ampel, AnfrageStatus, PositionMarker, ReviewArt, ReviewStatus, TechnikAktivitaet, TechnikKommentar,
  TechnikQuelle, TechnikStand,
} from "@/lib/technik";
import { AMPEL_DOT, ANFRAGE_STATUS_LABEL, QUELLE_LABEL, REVIEW_ART_LABEL } from "@/lib/technik";
import { formatDateFull, formatDateTimeFull, formatTime } from "@/lib/format";

/** Einklappbare Karten-Sektion — Nebensachen (Aktivitaet, Aufbauplan, …)
 *  starten standardmaessig ZU, damit die Seite kurz bleibt (Leo
 *  2026-09-24: "solche Sachen sollen immer eingeklappt sein").
 *  Bewusst KEIN localStorage: beim naechsten Besuch wieder eingeklappt. */
export function Sektion({
  icon, titel, zusatz, defaultOffen = false, children,
}: {
  icon: React.ReactNode;
  titel: string;
  /** Kurz-Info rechts vom Titel (z.B. Zaehler) — sichtbar auch wenn zu. */
  zusatz?: React.ReactNode;
  defaultOffen?: boolean;
  children: React.ReactNode;
}) {
  const [offen, setOffen] = useState(defaultOffen);
  return (
    <Card className="bg-card">
      <CardContent className="p-0">
        <button
          type="button"
          onClick={() => setOffen(!offen)}
          className="w-full flex items-center gap-2 px-4 py-2.5 text-left"
          aria-expanded={offen}
        >
          <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground shrink-0">
            {icon}
            {titel}
          </span>
          <span className="flex-1 min-w-0 text-xs text-muted-foreground truncate">{zusatz}</span>
          <ChevronDown className={`h-4 w-4 text-muted-foreground shrink-0 transition-transform ${offen ? "rotate-180" : ""}`} />
        </button>
        {offen && <div className="px-4 pb-4 space-y-2">{children}</div>}
      </CardContent>
    </Card>
  );
}

/** Datum + Uhrzeit eines Auftrags/Termins (Europe/Zurich):
 *  «20.11.2026, 08:00–23:00», über Mitternacht/mehrere Tage
 *  «20.11.2026 18:00 – 21.11.2026 02:00»; reine Tage (00:00) ohne Zeit. */
export function zeitraumText(start: string | null, ende: string | null): string | null {
  if (!start) return null;
  const tagS = formatDateFull(start);
  const zeitS = formatTime(start);
  if (!ende) return zeitS === "00:00" ? tagS : `${tagS}, ${zeitS}`;
  const tagE = formatDateFull(ende);
  const zeitE = formatTime(ende);
  const ohneZeit = zeitS === "00:00" && (zeitE === "00:00" || zeitE === "23:59");
  if (ohneZeit) return tagS === tagE ? tagS : `${tagS} – ${tagE}`;
  return tagS === tagE ? `${tagS}, ${zeitS}–${zeitE}` : `${tagS} ${zeitS} – ${tagE} ${zeitE}`;
}

const ANFRAGE_STATUS_STIL: Record<AnfrageStatus, { cls: string; icon: React.ComponentType<{ className?: string }> }> = {
  neu: { cls: "bg-blue-50 dark:bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-500/30", icon: Clock },
  beantwortet: { cls: "bg-green-50 dark:bg-green-500/15 text-green-800 dark:text-green-300 border-green-200 dark:border-green-500/30", icon: Check },
  geaendert: { cls: "bg-amber-50 dark:bg-amber-500/15 text-amber-800 dark:text-amber-300 border-amber-200 dark:border-amber-500/30", icon: RefreshCw },
  storniert: { cls: "bg-red-50 dark:bg-red-500/15 text-red-800 dark:text-red-300 border-red-200 dark:border-red-500/30", icon: XCircle },
  abgeschlossen: { cls: "bg-foreground/[0.05] dark:bg-foreground/10 text-muted-foreground border-foreground/15 dark:border-foreground/20", icon: Archive },
};

/** Stand einer Technik-Anfrage (Portal-Liste und -Detail, gleiche Optik
 *  wie die Status-Pillen im Partnerportal). */
export function AnfrageStatusBadge({ status, titel }: { status: AnfrageStatus; titel?: string }) {
  const s = ANFRAGE_STATUS_STIL[status];
  const Icon = s.icon;
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-md border w-fit shrink-0 ${s.cls}`} data-tooltip={titel}>
      <Icon className="h-3 w-3" />
      {ANFRAGE_STATUS_LABEL[status]}
    </span>
  );
}

/** Kleine Markierung an einer Position: seit der letzten Anfrage neu/geaendert. */
export function MarkerChip({ marker }: { marker: PositionMarker }) {
  return (
    <span
      className="px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide shrink-0 bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300"
      data-tooltip={marker === "neu" ? "Seit der letzten Anfrage neu" : "Seit der letzten Anfrage geändert"}
    >
      {marker === "neu" ? "Neu" : "Geändert"}
    </span>
  );
}

/** "3 Einträge" / "1 Eintrag" — Zahl + richtige Einzahl/Mehrzahl. */
export function anzahl(n: number, einzahl: string, mehrzahl: string): string {
  return `${n} ${n === 1 ? einzahl : mehrzahl}`;
}

/** Kopf-Chips «2/4 bestätigt · 1 Empfehlung · 1 Problem» — Firmen-Tab und
 *  Portal zeigen denselben Stand aus derselben Berechnung (technikStand). */
export function StandChips({ stand }: { stand: TechnikStand }) {
  const chip = (cls: string, text: string) => (
    <span key={text} className={`px-2 py-0.5 rounded-full text-[11px] font-medium whitespace-nowrap ${cls}`}>{text}</span>
  );
  return (
    <span className="flex items-center gap-1.5 flex-wrap">
      {stand.positionen > 0 && chip(
        stand.bestaetigt === stand.positionen
          ? "bg-green-50 dark:bg-green-500/15 text-green-600 dark:text-green-300"
          : "bg-muted text-muted-foreground",
        `${stand.bestaetigt}/${stand.positionen} bestätigt`,
      )}
      {stand.offeneEmpfehlungen > 0 && chip(
        "bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-300",
        anzahl(stand.offeneEmpfehlungen, "Empfehlung", "Empfehlungen"),
      )}
      {stand.offeneProbleme > 0 && chip(
        "bg-red-50 dark:bg-red-500/15 text-red-600 dark:text-red-300",
        anzahl(stand.offeneProbleme, "Problem", "Probleme"),
      )}
    </span>
  );
}

export function AmpelDot({ ampel, title }: { ampel: Ampel; title?: string }) {
  return (
    <span
      className={`inline-block h-2.5 w-2.5 rounded-full shrink-0 ${AMPEL_DOT[ampel]}`}
      data-tooltip={title}
      aria-hidden
    />
  );
}

export function QuelleBadge({ quelle, tooltip }: { quelle: TechnikQuelle; tooltip?: string }) {
  if (quelle === "eventfirma") return null; // Default — kein Badge-Rauschen
  const cls = quelle === "kunde"
    ? "bg-purple-50 dark:bg-purple-500/15 text-purple-600 dark:text-purple-300"
    : "bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-300";
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide shrink-0 ${cls}`} data-tooltip={tooltip}>
      {QUELLE_LABEL[quelle]}
    </span>
  );
}

export const REVIEW_STYLES: Record<ReviewArt, { box: string; icon: React.ReactNode; text: string }> = {
  empfehlung: {
    box: "border-amber-200/70 dark:border-amber-500/30 bg-amber-50/70 dark:bg-amber-500/10",
    icon: <Lightbulb className="h-3.5 w-3.5 text-amber-600 dark:text-amber-300 shrink-0" />,
    text: "text-amber-900 dark:text-amber-100",
  },
  problem: {
    box: "border-red-200/70 dark:border-red-500/30 bg-red-50/70 dark:bg-red-500/10",
    icon: <AlertTriangle className="h-3.5 w-3.5 text-red-600 dark:text-red-300 shrink-0" />,
    text: "text-red-900 dark:text-red-100",
  },
};

export function ReviewStatusChip({ status }: { status: ReviewStatus }) {
  if (status === "offen") return null;
  const map: Record<Exclude<ReviewStatus, "offen">, { label: string; cls: string }> = {
    uebernommen: { label: "Übernommen", cls: "bg-green-50 dark:bg-green-500/15 text-green-600 dark:text-green-300" },
    abgelehnt: { label: "Abgelehnt", cls: "bg-red-50 dark:bg-red-500/15 text-red-600 dark:text-red-300" },
    erledigt: { label: "Erledigt", cls: "bg-muted text-muted-foreground" },
  };
  const m = map[status as Exclude<ReviewStatus, "offen">];
  return <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${m.cls}`}>{m.label}</span>;
}

export function ReviewArtChip({ art }: { art: ReviewArt }) {
  const s = REVIEW_STYLES[art];
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide ${s.text}`}>
      {s.icon}
      {REVIEW_ART_LABEL[art]}
    </span>
  );
}

/** Kommentar-Thread mit Eingabefeld. Enter ist Tab, niemals Senden (Haus-
 *  regel, globaler useEnterAsTab springt zum Senden-Knopf) — gesendet wird
 *  nur per Knopf. Das Feld wird nur bei Erfolg geleert; bei einem Fehler
 *  bleibt der Text stehen (onSend liefert false + zeigt selbst den Toast). */
export function KommentarThread({
  kommentare,
  onSend,
  placeholder = "Antwort schreiben…",
  nurLesen = false,
}: {
  kommentare: TechnikKommentar[];
  onSend: (body: string) => Promise<boolean>;
  placeholder?: string;
  /** Gesperrter Auftrag: Verlauf zeigen, kein Eingabefeld. */
  nurLesen?: boolean;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  async function senden() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      if (await onSend(body)) setText("");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-1.5">
      {kommentare.map((k) => (
        <div key={k.id} className="text-xs">
          <span className="flex items-baseline justify-between gap-2">
            <span className={`font-semibold ${k.vom_lieferanten ? "text-blue-600 dark:text-blue-300" : "text-foreground"}`}>
              {k.author_name ?? (k.vom_lieferanten ? "Lieferant" : "EVENTLINE")}
            </span>
            <span className="text-[10px] text-muted-foreground shrink-0">{formatDateTimeFull(k.created_at)}</span>
          </span>
          <span className="block whitespace-pre-wrap break-words">{k.body}</span>
        </div>
      ))}
      {!nurLesen && (
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={4000}
            placeholder={placeholder}
            className="flex-1 min-w-0 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-foreground/30"
          />
          <button
            type="button"
            onClick={() => void senden()}
            disabled={sending || !text.trim()}
            className="kasten kasten-muted shrink-0"
            data-tooltip="Senden"
            aria-label="Senden"
          >
            {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          </button>
        </div>
      )}
    </div>
  );
}

/** Kompakte Aktivitaets-Timeline (neueste zuerst). */
export function AktivitaetListe({ items }: { items: TechnikAktivitaet[] }) {
  const [alle, setAlle] = useState(false);
  const [hover, setHover] = useState(false);
  const sichtbar = alle ? items : items.slice(0, 8);
  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground italic">Noch keine Aktivität.</p>;
  }
  return (
    <div className="space-y-1">
      {sichtbar.map((a) => (
        <div key={a.id} className="flex items-baseline gap-2 text-xs">
          <span className="text-[10px] text-muted-foreground tabular-nums shrink-0 w-28">{formatDateTimeFull(a.created_at)}</span>
          <span className="flex-1 min-w-0 break-words">
            {a.actor_name && <span className="font-medium">{a.actor_name}: </span>}
            {a.beschreibung}
          </span>
        </div>
      ))}
      {items.length > 8 && (
        <button
          type="button"
          onClick={() => setAlle(!alle)}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          className="text-xs underline"
          style={{ color: hover ? "var(--foreground)" : "var(--muted-foreground)" }}
        >
          {alle ? "Weniger anzeigen" : `Alle ${items.length} anzeigen`}
        </button>
      )}
    </div>
  );
}

/** Gruen-Haken fuer bestaetigte Positionen (einheitliches Symbol). Hat
 *  EVENTLINE statt des Lieferanten bestaetigt, steht das sichtbar daneben. */
export function BestaetigtHaken({ von, am, lieferantName }: {
  von?: { name: string | null; vonLieferant: boolean } | null;
  am?: string | null;
  lieferantName?: string | null;
}) {
  const wann = am ? ` am ${formatDateTimeFull(am)}` : "";
  const durchEventline = von ? !von.vonLieferant : false;
  const tooltip = von
    ? durchEventline
      ? `Von EVENTLINE als bestätigt markiert${von.name ? ` (${von.name})` : ""}${wann}`
      : `Bestätigt von ${von.name ?? lieferantName ?? "Lieferant"}${lieferantName && von.name ? ` (${lieferantName})` : ""}${wann}`
    : am ? `Bestätigt${wann}` : "Bestätigt";
  return (
    <span className="inline-flex items-center gap-1 shrink-0" data-tooltip={tooltip}>
      <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
      {durchEventline && <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">EVENTLINE</span>}
    </span>
  );
}
