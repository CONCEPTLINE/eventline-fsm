// /sicherheit — Wartungsmodus (src/lib/wartung.ts, Migration 363): nur der Kontext; den Tab
// «Vertraute Geräte» (Bereich «Geräte») sperrt WartungBereichSchranke im Dashboard.
import { WartungSeite } from "@/components/wartung/wartung-seite";
import Loading from "./loading";

export default function SicherheitLayout({ children }: { children: React.ReactNode }) {
  return (
    <WartungSeite fallback={<Loading />}>
      {children}
    </WartungSeite>
  );
}
