"use client";

/**
 * Text-Knopf / Text-Link ohne Rahmen («Anderes melden ›», «Alle Anfragen ›»,
 * Umschalter im Formular). Hover state-driven (useHover, CLAUDE.md §3):
 * Unterstrich bzw. Vordergrundfarbe — kein Tailwind-hover:.
 */

import { PrefetchLink } from "@/components/shell/prefetch-link";
import { unterstrichen, useHover } from "@/lib/use-hover";

export function TextKnopf({ onClick, className, children }: { onClick: () => void; className?: string; children: React.ReactNode }) {
  const h = useHover();
  return (
    <button type="button" onClick={onClick} {...h.bind} className={className} style={unterstrichen(h.hover)}>
      {children}
    </button>
  );
}

export function TextLink({ href, className, children }: { href: string; className?: string; children: React.ReactNode }) {
  const h = useHover();
  // PrefetchLink belegt onMouseEnter selbst (Vorladen) — Hover darum am Rahmen.
  return (
    <span {...h.bind}>
      <PrefetchLink href={href} className={className} style={unterstrichen(h.hover)}>
        {children}
      </PrefetchLink>
    </span>
  );
}
