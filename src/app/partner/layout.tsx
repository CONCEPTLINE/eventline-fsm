import type { Viewport } from "next";

// Partnerportal: Viewport mit Zoom-Sperre wie vor dem Mobile-Overhaul. Das
// Root-Layout hat die Zoom-Sperre fuer die Firmen-App aufgehoben; das Portal
// behaelt sie bewusst. Seit 2026-10 ist das Portal am Handy angepasst
// (mobiler Kopf + untere Leiste, Felder in 16 px und Tastflaechen ab 44 px
// ueber data-partner-portal in globals.css). viewportFit "cover" braucht es
// fuer die Safe-Area von Kopf und Leiste. Reiner Durchreich-Layout, kein
// Markup.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  // Kein themeColor: kommt app-weit aus ThemeColorSync (Root-Layout) und
  // folgt dem App-Theme statt dem Handy-Theme (seit 2026-10-13).
};

export default function PartnerLayout({ children }: { children: React.ReactNode }) {
  return children;
}
