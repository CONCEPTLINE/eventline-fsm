// /rechte-antraege — Wartungsmodus (src/lib/wartung.ts, Migration 363): Bereich «Rechte» in
// Wartung → Hinweisseite statt der Seite (Ausnahmen: Balken).
import { WartungSeite } from "@/components/wartung/wartung-seite";
import Loading from "./loading";

export default function RechteAntraegeLayout({ children }: { children: React.ReactNode }) {
  return (
    <WartungSeite bereich="rechte" fallback={<Loading />}>
      {children}
    </WartungSeite>
  );
}
