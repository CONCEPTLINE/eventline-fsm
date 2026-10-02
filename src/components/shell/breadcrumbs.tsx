"use client";

// Globale Breadcrumbs.
//
// Rendert einen Pfad wie "Aufträge › INT-4231 · Kunde XY" oberhalb des
// Content-Bereichs. Detail-Pages setzen ihre Crumbs via useBreadcrumbs()
// — der Provider haelt den State, der Renderer liest ihn.
//
// Bei kein-Crumb-gesetzt: nichts rendern.
//
// Verwendung in einer Detail-Page:
//
//   useBreadcrumbs([
//     { label: "Aufträge", href: "/auftraege" },
//     { label: `INT-${job.job_number} · ${job.customer?.name ?? ""}` },
//   ]);

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { ChevronRight } from "lucide-react";

export interface Crumb {
  label: string;
  /** Wenn gesetzt: Link. Fehlt href → aktiver Segment ohne Klickziel. */
  href?: string;
}

interface Ctx {
  crumbs: Crumb[];
  setCrumbs: (crumbs: Crumb[]) => void;
  clear: () => void;
}

const BreadcrumbsContext = createContext<Ctx | null>(null);

export function BreadcrumbsProvider({ children }: { children: React.ReactNode }) {
  const [crumbs, setCrumbsState] = useState<Crumb[]>([]);
  const setCrumbs = useCallback((c: Crumb[]) => setCrumbsState(c), []);
  const clear = useCallback(() => setCrumbsState([]), []);
  const value = useMemo(() => ({ crumbs, setCrumbs, clear }), [crumbs, setCrumbs, clear]);
  return (
    <BreadcrumbsContext.Provider value={value}>{children}</BreadcrumbsContext.Provider>
  );
}

/**
 * Hook fuer Detail-Pages: setzt die Crumbs beim Mount und cleart sie
 * beim Unmount, damit beim Verlassen der Seite nicht die alten Crumbs
 * kurz stehen bleiben.
 *
 * Wichtig: das crumbs-Array MUSS memoisiert / stabil sein (kein Neu-
 * Erzeugen bei jedem Render) — sonst laeuft der Effect endlos.
 * Daher intern per JSON-Stringify als Effect-Dep genutzt.
 */
export function useBreadcrumbs(crumbs: Crumb[]) {
  const ctx = useContext(BreadcrumbsContext);
  // Ref halten damit setCrumbs immer die neuesten Werte kriegt ohne im
  // Effect-Dep-Array zu haengen (=> keine Endlosschleife).
  const crumbsRef = useRef(crumbs);
  crumbsRef.current = crumbs;

  // Serialize als Dep — Wechsel der Labels/Href triggert Update, aber
  // eine neue-Array-mit-gleichen-Werten-Referenz nicht.
  const serialized = JSON.stringify(crumbs);

  useEffect(() => {
    if (!ctx) return;
    ctx.setCrumbs(crumbsRef.current);
    return () => ctx.clear();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serialized]);
}

/**
 * Renderer — mounted im App-Layout unter dem Header, oberhalb des
 * Contents. Bei leerer Crumb-Liste rendert nichts (kein Layout-Shift).
 */
export function Breadcrumbs() {
  const ctx = useContext(BreadcrumbsContext);
  const crumbs = ctx?.crumbs ?? [];
  if (crumbs.length === 0) return null;

  return (
    <nav
      aria-label="Breadcrumb"
      className="text-xs text-muted-foreground px-4 md:px-10 pt-3 md:pt-4 max-w-[1280px] w-full mx-auto"
    >
      <ol className="flex items-center gap-1 flex-wrap">
        {crumbs.map((c, i) => {
          const isLast = i === crumbs.length - 1;
          const isLink = !isLast && !!c.href;
          return (
            <li key={i} className="flex items-center gap-1 min-w-0">
              {isLink ? (
                <Link
                  href={c.href!}
                  className="hover:text-foreground transition-colors truncate"
                >
                  {c.label}
                </Link>
              ) : (
                <span
                  className={
                    isLast
                      ? "text-foreground/80 font-medium truncate"
                      : "truncate"
                  }
                  aria-current={isLast ? "page" : undefined}
                >
                  {c.label}
                </span>
              )}
              {!isLast && (
                <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/50" />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
