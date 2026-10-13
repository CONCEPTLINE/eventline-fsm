import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import Script from "next/script";
import { Comfortaa } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { ThemeColorSync } from "@/components/theme-color-sync";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
import { TooltipLayer } from "@/components/ui/tooltip-layer";
import "./globals.css";

// Comfortaa fuer Ueberschriften — gleicher Font wie auf der Eventline-Website
const comfortaa = Comfortaa({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-comfortaa",
  display: "swap",
});

export const metadata: Metadata = {
  title: "EVENTLINE FSM",
  description: "Field Service Management - EVENTLINE GmbH Basel",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    title: "EVENTLINE FSM",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: "/icon-192.png",
    apple: "/apple-touch-icon.png",
  },
  formatDetection: {
    telephone: false,
  },
};

// Keine Zoom-Sperre mehr (Mobile-Overhaul 2026-10): maximumScale/userScalable
// hatten nur die iOS-Fokus-Zoom-Falle verdeckt und Pinch-Zoom fuer alle
// gesperrt (Barrierefreiheit). Die Falle selbst loest die Handy-Schicht in
// globals.css (Eingabefelder 16 px in px).
// Kein themeColor hier und in den Unter-Layouts (seit 2026-10-13): die
// Statusleistenfarbe folgt dem App-Theme statt dem Handy-Theme und kommt
// aus ThemeColorSync (src/components/theme-color-sync.tsx).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de" className={`h-full antialiased ${comfortaa.variable}`} suppressHydrationWarning>
      {/* overflow-x-CLIP statt -hidden: hidden macht den body zum eigenen
          Scroll-Kontext (computed overflow-y wird 'auto') und bricht
          position:sticky ueberall in der App; clip schneidet horizontal
          genauso ab, ohne Scroll-Kontext. */}
      <body className="min-h-full flex flex-col overflow-x-clip" style={{ fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif" }}>
        {/* App-Installation (Android/Chrome): `beforeinstallprompt` feuert
            meist vor dem React-Mount — hier frueh abfangen und fuer den
            einmaligen Hinweis (src/components/mobile/app-install-hinweis.tsx)
            aufheben. Nach «Nicht jetzt» (localStorage-Schluessel gesetzt)
            nicht mehr unterdruecken, damit Chrome seine eigene Install-
            Leiste zeigen darf. Partner- und Lieferantenportal haben keinen
            eigenen Hinweis — dort nie unterdruecken. */}
        <Script id="eventline-install-prompt" strategy="beforeInteractive">{`
          window.addEventListener('beforeinstallprompt', function (e) {
            if (/^\\/(partner|lieferant)(\\/|$)/.test(location.pathname)) return;
            var schonEntschieden = false;
            try { schonEntschieden = !!localStorage.getItem('eventline-app-hinweis-v1'); } catch (err) {}
            if (schonEntschieden) return;
            e.preventDefault();
            window.__eventlineInstallPrompt = e;
            window.dispatchEvent(new Event('eventline:installprompt'));
          });
        `}</Script>
        <ThemeProvider>
          {/* Erstes Kind: sein Inline-Script muss direkt nach dem
              next-themes-Script laufen (liest dessen html-Klasse). */}
          <ThemeColorSync />
          <Suspense>{children}</Suspense>
        </ThemeProvider>
        <ServiceWorkerRegister />
        <TooltipLayer />
      </body>
    </html>
  );
}
