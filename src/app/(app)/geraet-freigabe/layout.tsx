// /geraet-freigabe — Wartungsmodus (src/lib/wartung.ts, Migration 363): Bereich «Geräte» in
// Wartung → Hinweisseite statt der Seite (Ausnahmen: Balken).
import { WartungSeite } from "@/components/wartung/wartung-seite";
import Loading from "./loading";

export default function GeraetFreigabeLayout({ children }: { children: React.ReactNode }) {
  return (
    <WartungSeite bereich="geraete" fallback={<Loading />}>
      {children}
    </WartungSeite>
  );
}
