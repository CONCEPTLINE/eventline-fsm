import type { Viewport } from "next";

// Lieferantenportal: Viewport wie vor dem Mobile-Overhaul (2026-10). Das
// Root-Layout hat die Zoom-Sperre fuer die Firmen-App aufgehoben; das
// Portal wird in dieser Welle bewusst nicht angefasst und behaelt daher
// sein bisheriges Verhalten (Felder unter 16 px wuerden sonst auf iOS beim
// Fokus zoomen). Reiner Durchreich-Layout, kein Markup.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  // Kein themeColor: kommt app-weit aus ThemeColorSync (Root-Layout) und
  // folgt dem App-Theme statt dem Handy-Theme (seit 2026-10-13).
};

export default function LieferantLayout({ children }: { children: React.ReactNode }) {
  return children;
}
