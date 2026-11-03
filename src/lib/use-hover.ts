"use client";

// Hover state-driven (CLAUDE.md §3: Tailwind hover: greift hier unzuverlaessig).
//   const h = useHover();
//   <button {...h.bind} style={{ textDecoration: h.hover ? "underline" : "none" }}>

import { useState } from "react";

export function useHover() {
  const [hover, setHover] = useState(false);
  return {
    hover,
    bind: {
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
    },
  };
}

/** Unterstrich bei Hover (Text-Links/-Knoepfe). */
export function unterstrichen(hover: boolean): React.CSSProperties {
  return { textDecoration: hover ? "underline" : "none", textUnderlineOffset: 2 };
}
