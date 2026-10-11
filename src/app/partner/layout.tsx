import type { Viewport } from "next";

// Partnerportal: Viewport wie vor dem Mobile-Overhaul (2026-10). Das
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
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f7" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default function PartnerLayout({ children }: { children: React.ReactNode }) {
  return children;
}
