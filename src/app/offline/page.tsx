import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Offline — EVENTLINE FSM",
};

/**
 * Offline-Fallback. Der Service Worker liefert diese Seite, wenn eine
 * Navigation ohne Netz fehlschlaegt. Bewusst statisch & ohne Daten/Auth —
 * sie muss auch komplett offline aus dem Cache rendern.
 */
export default function OfflinePage() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-6 text-center bg-background text-foreground">
      <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-foreground/5 border border-foreground/10">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M1 1l22 22" />
          <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
          <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
          <path d="M10.71 5.05A16 16 0 0 1 22.58 9" />
          <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
          <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
          <line x1="12" y1="20" x2="12.01" y2="20" />
        </svg>
      </div>
      <h1 className="text-lg font-semibold tracking-tight">EVENTLINE ist offline</h1>
      <p className="max-w-xs text-sm text-muted-foreground">
        Keine Internetverbindung. Sobald du wieder online bist, lädt die App
        normal weiter.
      </p>
      {/* Bewusst ein Link, kein Button mit onClick: die Offline-Seite muss
          ohne JS-Hydration funktionieren (offline ist evtl. kein Bundle
          geladen). Der Klick navigiert -> Service-Worker versucht network-
          first neu zu laden. */}
      <a href="/dashboard" className="kasten kasten-blue mt-2">
        Erneut versuchen
      </a>
    </div>
  );
}
