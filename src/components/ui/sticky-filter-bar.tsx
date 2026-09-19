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
export function StickyFilterBar({ children, className = "", offset }: {
  children: React.ReactNode;
  className?: string;
  /** Zieht den oberen Seitenabstand IN die Bar (negatives Margin + gleiches
   *  Padding): die Bar-Oberkante liegt dann natuerlich bei 0 und der Kopf
   *  steht ab dem ersten Pixel fest, statt erst ~1cm mitzuscrollen.
   *  "app" = App-Shell (main pt-4/md:pt-10), "portal" = Portale (py-6).
   *  NUR setzen, wenn die Bar das oberste Element der Seite ist. */
  offset?: "app" | "portal";
}) {
  const pull =
    offset === "app" ? "-mt-4 pt-4 md:-mt-10 md:pt-10"
    : offset === "portal" ? "-mt-6 pt-6"
    : "pt-2";
  return (
    <div className={`sticky top-0 z-30 bg-[#f5f5f7] dark:bg-[#0a0a0a] ${pull} pb-3 ${className}`}>
      {children}
    </div>
  );
}
