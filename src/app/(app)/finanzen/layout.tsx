// /finanzen — Wartungsmodus (src/lib/wartung.ts, Migration 363): Bereich «Finanzen» in Wartung →
// Hinweisseite statt der Seite (Ausnahmen: Balken).
import { WartungSeite } from "@/components/wartung/wartung-seite";
import Loading from "./loading";

export default function FinanzenLayout({ children }: { children: React.ReactNode }) {
  return (
    <WartungSeite bereich="finanzen" fallback={<Loading />}>
      {children}
    </WartungSeite>
  );
}
