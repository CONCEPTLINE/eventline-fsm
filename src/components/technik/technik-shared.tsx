"use client";

// Geteilte UI-Bausteine der Technik-Planung — im Firmen-Tab UND im
// Lieferantenportal verwendet, damit beide Seiten dasselbe sehen
// (Konsistenz-Grundregel).

import { useState } from "react";
import { Loader2, Send, CheckCircle2, AlertTriangle, HelpCircle, Lightbulb, ChevronDown } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { Ampel, ReviewArt, ReviewStatus, TechnikAktivitaet, TechnikKommentar, TechnikQuelle } from "@/lib/technik";
import { AMPEL_DOT, QUELLE_LABEL, REVIEW_ART_LABEL } from "@/lib/technik";

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

export function techDatum(iso: string): string {
  return new Date(iso).toLocaleString("de-CH", {
    timeZone: "Europe/Zurich",
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function techTag(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric" });
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

export function QuelleBadge({ quelle }: { quelle: TechnikQuelle }) {
  if (quelle === "eventfirma") return null; // Default — kein Badge-Rauschen
  const cls = quelle === "kunde"
    ? "bg-purple-50 dark:bg-purple-500/15 text-purple-600 dark:text-purple-300"
    : "bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-300";
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide ${cls}`}>
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
  frage: {
    box: "border-blue-200/70 dark:border-blue-500/30 bg-blue-50/70 dark:bg-blue-500/10",
    icon: <HelpCircle className="h-3.5 w-3.5 text-blue-600 dark:text-blue-300 shrink-0" />,
    text: "text-blue-900 dark:text-blue-100",
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

/** Kommentar-Thread mit Eingabefeld. Enter sendet NICHT (Enter=Tab-Regel) —
 *  Senden nur ueber den Button. */
export function KommentarThread({
  kommentare,
  onSend,
  placeholder = "Antwort schreiben…",
}: {
  kommentare: TechnikKommentar[];
  onSend: (body: string) => Promise<void>;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  async function senden() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      await onSend(body);
      setText("");
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
            <span className="text-[10px] text-muted-foreground shrink-0">{techDatum(k.created_at)}</span>
          </span>
          <span className="block whitespace-pre-wrap">{k.body}</span>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void senden();
            }
          }}
          placeholder={placeholder}
          className="flex-1 min-w-0 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-foreground/30"
        />
        <button
          type="button"
          onClick={() => void senden()}
          disabled={sending || !text.trim()}
          className="kasten kasten-muted shrink-0"
          data-tooltip="Senden"
        >
          {sending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}

/** Kompakte Aktivitaets-Timeline (neueste zuerst). */
export function AktivitaetListe({ items }: { items: TechnikAktivitaet[] }) {
  const [alle, setAlle] = useState(false);
  const sichtbar = alle ? items : items.slice(0, 8);
  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground italic">Noch keine Aktivität.</p>;
  }
  return (
    <div className="space-y-1">
      {sichtbar.map((a) => (
        <div key={a.id} className="flex items-baseline gap-2 text-xs">
          <span className="text-[10px] text-muted-foreground tabular-nums shrink-0 w-24">{techDatum(a.created_at)}</span>
          <span className="flex-1 min-w-0">
            {a.actor_name && <span className="font-medium">{a.actor_name}: </span>}
            {a.beschreibung}
          </span>
        </div>
      ))}
      {items.length > 8 && (
        <button type="button" onClick={() => setAlle(!alle)} className="text-xs text-muted-foreground hover:text-foreground underline">
          {alle ? "Weniger anzeigen" : `Alle ${items.length} anzeigen`}
        </button>
      )}
    </div>
  );
}

/** Gruen-Haken fuer bestaetigte Positionen (einheitliches Symbol). */
export function BestaetigtHaken() {
  return <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />;
}
