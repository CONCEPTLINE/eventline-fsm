// /antraege — Wartungsmodus (src/lib/wartung.ts, Migration 363): nur der Kontext;
// den Reiter «Rechte & Lohndaten» (Bereich «Rechte») sperrt WartungBereichSchranke
// in page.tsx. Der Reiter «Abwesenheiten» hängt an keinem Wartungsbereich.
import { WartungSeite } from "@/components/wartung/wartung-seite";
import Loading from "./loading";

export default function AntraegeLayout({ children }: { children: React.ReactNode }) {
  return <WartungSeite fallback={<Loading />}>{children}</WartungSeite>;
}
