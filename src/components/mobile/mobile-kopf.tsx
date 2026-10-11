"use client";

/**
 * Mobiler Kopf (nur < md): Titel oder Zurueck + Titel links, Glocke rechts.
 * Ueberall gleich — Segmente/Filter gehoeren auf die Seite, nicht in den
 * Kopf. Darunter bei Buero-Seiten der Hinweis «Am Computer besser
 * bedienbar» (keine Sperre: Deep-Links aus Mails funktionieren weiter).
 *
 * Zurueck + Titel kommen aus den Breadcrumbs der Seite (useBreadcrumbs),
 * sonst aus dem Pfad (src/lib/mobile-seiten.ts). Die Glocke ist nur der
 * Trigger — der Kern laeuft im NotificationsProvider des Layouts.
 *
 * Tastflaechen in px statt h-11: die Root-Schrift ist 15 px (globals.css),
 * h-11 waeren nur 41 px.
 */

import { useRouter } from "next/navigation";
import { ArrowLeft, Monitor } from "lucide-react";
import { useCrumbs } from "@/components/shell/breadcrumbs";
import { NotificationsBell } from "@/components/layout/notifications-bell";
import { bereichsWurzel, istBueroSeite, titelFuerPfad } from "@/lib/mobile-seiten";

export function MobileKopf({ pathname }: { pathname: string }) {
  const router = useRouter();
  const crumbs = useCrumbs();
  const wurzel = bereichsWurzel(pathname);
  const hatCrumbs = crumbs.length >= 2;
  const zurueckZiel = hatCrumbs ? (crumbs[crumbs.length - 2].href ?? wurzel) : wurzel;
  const titel = hatCrumbs ? crumbs[crumbs.length - 1].label : titelFuerPfad(pathname);
  const buero = istBueroSeite(pathname);

  function zurueck() {
    // window.history.length === 1: Seite direkt geoeffnet (Deep-Link) —
    // dann zur Bereichs-Wurzel statt router.back() (waere ein No-op).
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.push(zurueckZiel ?? "/dashboard");
  }

  return (
    <header
      className="md:hidden sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
      // --kopf-h in globals.css rechnet den Buero-Hinweis ueber dieses Attribut mit.
      data-buero={buero ? "" : undefined}
    >
      <div className="flex h-[52px] items-center gap-1 pl-4 pr-1">
        {zurueckZiel && (
          <button
            type="button"
            aria-label="Zurück"
            onClick={zurueck}
            className="-ml-3 inline-flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-xl text-foreground active:bg-foreground/10"
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
        )}
        <span className="min-w-0 flex-1 truncate font-heading text-[20px] font-bold tracking-tight">
          {titel}
        </span>
        <NotificationsBell variant="kopf" />
      </div>
      {buero && (
        <div
          className="flex h-9 items-center gap-2 px-4 text-[13px] font-medium text-blue-700 dark:text-blue-300"
          style={{ backgroundColor: "rgba(37,99,235,0.10)" }}
        >
          <Monitor className="h-4 w-4 shrink-0" />
          <span>Am Computer besser bedienbar</span>
        </div>
      )}
    </header>
  );
}
