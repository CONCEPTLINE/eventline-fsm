import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { Comfortaa } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { ServiceWorkerRegister } from "@/components/service-worker-register";
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de" className={`h-full antialiased ${comfortaa.variable}`} suppressHydrationWarning>
      <body className="min-h-full flex flex-col overflow-x-hidden" style={{ fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif" }}>
        <ThemeProvider>
          <Suspense>{children}</Suspense>
        </ThemeProvider>
        <ServiceWorkerRegister />
      </body>
    </html>
  );
}
