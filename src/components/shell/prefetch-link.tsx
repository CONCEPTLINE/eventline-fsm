"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, type ComponentProps } from "react";

/**
 * Link, der die Zielseite bei Klick-ABSICHT vorlädt (Hover / Tastatur-Fokus /
 * Touch-Start) — so ist die Detailseite meist schon geladen, wenn geklickt wird.
 * Nur einmal je Ziel, damit keine Mehrfach-Requests entstehen. (§9,
 * Referenz: bombay-staffing. Hier erweitert um Prop-Passthrough, damit
 * Nav-Links mit data-tooltip / aria-label 1:1 umgestellt werden können.)
 */
type PrefetchLinkProps = Omit<
  ComponentProps<typeof Link>,
  "href" | "prefetch" | "onMouseEnter" | "onFocus" | "onTouchStart"
> & { href: string };

export function PrefetchLink({ href, children, ...rest }: PrefetchLinkProps) {
  const router = useRouter();
  const done = useRef(false);
  const warm = () => {
    if (done.current) return;
    done.current = true;
    router.prefetch(href);
  };
  return (
    <Link
      href={href}
      prefetch={false}
      onMouseEnter={warm}
      onFocus={warm}
      onTouchStart={warm}
      {...rest}
    >
      {children}
    </Link>
  );
}
