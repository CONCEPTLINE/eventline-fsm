"use client";

/**
 * Meine Anfragen (/anfragen) — eigene Meldungen (Belege, Stempel, IT,
 * Material, Abwesenheiten, Krankmeldungen) mit Stand. Laptop + Handy in
 * einer Komponente (components/anfragen/meine-anfragen.tsx).
 * Breite unbekannt (SSR/Hydration) → Skelett.
 */

import { MeineAnfragen } from "@/components/anfragen/meine-anfragen";
import { useIsMobile } from "@/lib/use-is-mobile";
import Loading from "./loading";

export default function AnfragenPage() {
  const isMobile = useIsMobile();
  if (isMobile === null) return <Loading />;
  return <MeineAnfragen />;
}
