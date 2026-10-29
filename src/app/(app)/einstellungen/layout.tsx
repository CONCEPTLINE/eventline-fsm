// /einstellungen — Wartungsmodus (src/lib/wartung.ts, Migration 363): nur der Kontext; die Tabs
// Mitarbeiter, Rollen, Partner-/Lieferanten-Zugänge (Bereich «Rechte») sperrt
// WartungBereichSchranke in page.tsx.
import { WartungSeite } from "@/components/wartung/wartung-seite";
import Loading from "./loading";

export default function EinstellungenLayout({ children }: { children: React.ReactNode }) {
  return (
    <WartungSeite fallback={<Loading />}>
      {children}
    </WartungSeite>
  );
}
