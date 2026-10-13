"use client";

/**
 * Fun-Fact-Widget in Einstellungen › Sicherheit, Abschnitt Entwickler-Modus
 * (vorher rechts oben in /einstellungen).
 * Zeigt Code-Stats die bei jedem Build via scripts/generate-build-info.mjs
 * frisch generiert werden:
 *   - Version (ablesbar an Commit-Count)
 *   - Anzahl Code-Dateien
 *   - Anzahl Zeilen Code
 *   - Anzahl Worte
 *
 * Rotiert automatisch alle 4 Sekunden durch die Facts. Click → manuell
 * weiterschalten.
 */

import { useEffect, useState } from "react";
import { BUILD_INFO } from "@/lib/build-info";
import { Sparkles } from "lucide-react";

interface Fact {
  label: string;
  value: string;
  hint?: string;
}

function formatNumber(n: number): string {
  // Schweizer Tausendertrennzeichen ' (Apostroph)
  return n.toLocaleString("de-CH").replace(/,/g, "'");
}

function formatBuildAt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("de-CH", {
    timeZone: "Europe/Zurich",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function BuildInfoBadge() {
  const facts: Fact[] = [
    {
      label: "Version",
      value: `v${BUILD_INFO.version}`,
      hint: BUILD_INFO.sha,
    },
    {
      label: "Code-Zeilen",
      value: formatNumber(BUILD_INFO.lines),
      hint: `aus ${BUILD_INFO.files} Dateien`,
    },
    {
      label: "Wörter",
      value: formatNumber(BUILD_INFO.words),
      hint: "im ganzen Code",
    },
    {
      label: "Letzter Build",
      value: formatBuildAt(BUILD_INFO.buildAt),
      hint: `Branch: ${BUILD_INFO.branch}`,
    },
  ];

  const [idx, setIdx] = useState(0);

  // Auto-Rotation alle 4s. setTimeout nicht setInterval damit der Reset
  // beim manuellen Click sauber funktioniert.
  useEffect(() => {
    const t = setTimeout(() => setIdx((i) => (i + 1) % facts.length), 4000);
    return () => clearTimeout(t);
  }, [idx, facts.length]);

  const current = facts[idx];

  return (
    <button
      type="button"
      onClick={() => setIdx((i) => (i + 1) % facts.length)}
      className="group flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-card hover:bg-muted/50 transition-colors text-left min-w-[180px]"
      data-tooltip="Click für nächsten Fakt"
    >
      <Sparkles className="h-4 w-4 text-amber-500 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground leading-none">
          {current.label}
        </p>
        <p className="font-mono text-sm font-semibold tabular-nums leading-tight mt-0.5 truncate">
          {current.value}
        </p>
        {current.hint && (
          <p className="text-[10px] text-muted-foreground/70 leading-none mt-0.5 truncate">
            {current.hint}
          </p>
        )}
      </div>
      {/* Mini Pagination-Dots */}
      <div className="flex gap-1 shrink-0">
        {facts.map((_, i) => (
          <span
            key={i}
            className={`h-1 w-1 rounded-full transition-colors ${i === idx ? "bg-amber-500" : "bg-muted-foreground/30"}`}
          />
        ))}
      </div>
    </button>
  );
}
