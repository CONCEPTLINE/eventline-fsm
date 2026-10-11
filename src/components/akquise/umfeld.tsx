"use client";

/**
 * Umfeld-Block: was über das Haus im Netz steht, aber nicht auf seiner
 * eigenen Website — Presse, Finanzierung, Personalwechsel, laufende
 * Veränderungen, Partner, Auslastung.
 *
 * Das ist der Teil, der ein Gespräch trägt: dass ein Betreiberwechsel
 * ansteht oder die Subvention gekürzt wurde, erfährt man nicht aus einer
 * Mietseite. Jeder Befund trägt seine Quelle — ohne Beleg erscheint er
 * gar nicht.
 */

import { Newspaper, Coins, UserCog, Construction, Handshake, CalendarClock, ExternalLink, Loader2 } from "lucide-react";
import type { AkquiseLocation } from "@/types/akquise";

const KATEGORIE = {
  presse:       { label: "Presse",        icon: Newspaper },
  finanzierung: { label: "Finanzierung",  icon: Coins },
  personal:     { label: "Personal",      icon: UserCog },
  veraenderung: { label: "Veränderung",   icon: Construction },
  partner:      { label: "Arbeitet mit",  icon: Handshake },
  auslastung:   { label: "Auslastung",    icon: CalendarClock },
} as const;

export function Umfeld({ location, laeuft = false, onHolen }: {
  location: AkquiseLocation;
  /** Recherche läuft gerade — sie dauert gut zwei Minuten, das muss
   *  sichtbar sein statt als leere Fläche zu wirken. */
  laeuft?: boolean;
  /** Recherche anstossen. Bei Priorität A läuft sie von selbst; sonst
   *  erst auf Wunsch, weil sie je Haus rund 11 Rappen kostet. */
  onHolen?: () => void;
}) {
  const u = location.recherche?.umfeld;

  if (laeuft && !u) {
    return (
      <section className="rounded-lg border border-border bg-card">
        <header className="border-b border-border px-3 py-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-foreground/65">
            Was über das Haus bekannt ist
          </h3>
        </header>
        <div className="flex items-center gap-2.5 p-3 text-sm text-foreground">
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-600 dark:text-blue-400" />
          <span>Sucht Presse, Finanzierung, Personal und laufende Veränderungen…</span>
        </div>
      </section>
    );
  }

  // Noch nichts da und nicht automatisch unterwegs: anbieten statt
  // einfach nichts zeigen.
  if (!u && !laeuft && onHolen && location.website) {
    return (
      <section>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-foreground/65">
            Was über das Haus bekannt ist
          </h3>
          <button type="button" onClick={onHolen} className="kasten kasten-muted text-xs">
            <Newspaper className="h-3.5 w-3.5" />Recherchieren
          </button>
        </div>
        <p className="mt-1.5 text-sm text-foreground/65">
          Sucht Presse, Finanzierung, Personalwechsel, laufende Veränderungen und
          Partner. Dauert gut zwei Minuten und kostet rund 11 Rappen — bei
          Priorität A läuft sie automatisch.
        </p>
      </section>
    );
  }

  if (!u || (u.befunde.length === 0 && !u.gespraechseinstieg)) return null;

  // Nach Relevanz ordnen: was die Ansprache beeinflusst, steht oben.
  const rang = { hoch: 0, mittel: 1, gering: 2 } as const;
  const befunde = [...u.befunde].sort((a, b) => rang[a.relevanz] - rang[b.relevanz]);

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-foreground/65">
          Was über das Haus bekannt ist
        </h3>
        <span className="text-[11px] text-foreground/65">{u.befunde.length} Befunde</span>
      </header>

      <div className="space-y-2.5 p-3">
        {u.gespraechseinstieg && (
          <p className="rounded border-l-2 border-l-red-500 bg-muted/60 px-2.5 py-2 text-sm leading-relaxed text-foreground">
            <span className="font-semibold">Einstieg: </span>{u.gespraechseinstieg}
          </p>
        )}

        {befunde.map((b, i) => {
          const k = KATEGORIE[b.kategorie];
          const Icon = k.icon;
          return (
            <div key={i} className="grid grid-cols-[1.1rem_minmax(0,1fr)] gap-2">
              <Icon className={`mt-0.5 h-4 w-4 ${
                b.relevanz === "hoch" ? "text-red-600 dark:text-red-400" : "text-foreground/60"
              }`} />
              <div className="min-w-0">
                <p className="text-sm leading-relaxed text-foreground">{b.aussage}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-foreground/65">
                  <span className="font-medium">{k.label}</span>
                  {b.datum && <span>· {b.datum}</span>}
                  <a href={b.quelle} target="_blank" rel="noopener noreferrer"
                     className="inline-flex items-center gap-1 text-blue-700 hover:underline dark:text-blue-400">
                    <ExternalLink className="h-2.5 w-2.5" />Quelle
                  </a>
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
