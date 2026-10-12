import type { Viewport } from "next";

// Anmeldung: Viewport wie vor dem Mobile-Overhaul (2026-10). Das Root-Layout
// hat die Zoom-Sperre fuer die Firmen-App aufgehoben; deren Ersatz (Felder
// 16 px in globals.css) gilt nur unter #app-scroll und in Dialogen — die
// Login-Felder (15 px) wuerden auf iOS beim Fokus zoomen, und die App bliebe
// nach der Anmeldung vergroessert. Gleicher Viewport wie die Portale
// (src/app/partner/layout.tsx). Reiner Durchreich-Layout, kein Markup.
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

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children;
}
