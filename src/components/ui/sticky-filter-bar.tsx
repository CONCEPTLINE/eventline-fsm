"use client";

/**
 * Angeheftete Such-/Filterzeile fuer scrollbare Listen-Seiten: bleibt beim
 * Scrollen oben kleben, damit man zum Suchen/Filtern nie hochscrollen muss.
 *
 * Hintergrund = exakt der Seitengrund der Layouts (App-Shell UND Portale
 * nutzen beide bg-[#f5f5f7] dark:bg-[#0a0a0a]), damit der Listeninhalt
 * beim Durchscrollen sauber dahinter verschwindet. Funktioniert in beiden
 * Scroll-Kontexten: window-Scroll (App) und internem main-Scroll (Portale).
 * z-30: ueber Karten/Listen, unter Modals und Tooltips.
 */
export function StickyFilterBar({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  // Kein negatives Margin: das ueberdeckte sonst die Oberkante der ersten
  // Karte darunter. pt deckt beim Kleben den Spalt zum Viewport-Rand ab,
  // pb gibt der durchscrollenden Liste eine saubere Kante.
  return (
    <div className={`sticky top-0 z-30 bg-[#f5f5f7] dark:bg-[#0a0a0a] pt-2 pb-3 ${className}`}>
      {children}
    </div>
  );
}
