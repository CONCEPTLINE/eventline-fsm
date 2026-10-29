// /lohn — Wartungsmodus (src/lib/wartung.ts, Migration 363): Bereich «Lohn» in Wartung →
// Hinweisseite statt der Seite (Ausnahmen: Balken).
import { WartungSeite } from "@/components/wartung/wartung-seite";
import Loading from "./loading";

export default function LohnLayout({ children }: { children: React.ReactNode }) {
  return (
    <WartungSeite bereich="lohn" fallback={<Loading />}>
      {children}
    </WartungSeite>
  );
}
