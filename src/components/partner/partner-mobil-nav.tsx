"use client";

/**
 * Partnerportal am Handy (nur < md, seit 2026-10): Kopf oben, Leiste unten.
 * Gleiche Sprache wie die Firmen-App (src/components/mobile/mobile-kopf.tsx,
 * src/components/layout/mobile-nav.tsx), aber nur die drei Portal-Bereiche.
 *
 * Kopf und Leiste stehen als shrink-0-Elemente im Flex-Geruest des Portal-
 * Layouts (Kopf | main mit eigenem Scroll | Leiste) — kein position:fixed.
 * Klebende Leisten in main halten so automatisch unter dem Kopf.
 *
 * Die Glocke ist nur der Trigger — der Kern laeuft im NotificationsProvider
 * des Layouts (genau einer fuer Desktop-Kopf und Handy-Kopf).
 *
 * Masse in px statt h-11: die Root-Schrift ist 15 px (globals.css), h-11
 * waeren nur 41 px. Variante «Dicht» (seit 2026-10-13, wie die Firmen-App):
 * Kopf 46 px (Tastflaeche 34 px + je 6 px Luft), Seitenrand 16 px an den
 * Icon-Kanten, Titel 18 px — Herleitung in mobile-kopf.tsx; untere
 * Leiste 48 px. Bei Aenderung den Toast-Abstand im Portal-Layout mitziehen.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Calendar, FileText, User, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { NotificationsBell } from "@/components/layout/notifications-bell";

/** Die drei Bereiche des Partnerportals — Desktop-Tabs und Handy-Leiste. */
export const PARTNER_BEREICHE: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/partner/anfragen",      label: "Meine Anfragen", icon: FileText },
  { href: "/partner/belegungsplan", label: "Belegungsplan",  icon: Calendar },
  { href: "/partner/konto",         label: "Mein Konto",     icon: User },
];

/** Aktiver Bereich = href, der dem pathname entspricht oder dessen Prefix
 *  ist. Verhindert Fehl-Matches zwischen /partner/anfragen und
 *  /partner/anfragen/[id]. Ohne Treffer: «Meine Anfragen». */
export function aktiverPartnerBereich(pathname: string): string {
  return (
    PARTNER_BEREICHE.find((b) => pathname === b.href || pathname.startsWith(b.href + "/"))?.href
    ?? PARTNER_BEREICHE[0].href
  );
}

/** Unterseiten von «Meine Anfragen» (Neue Anfrage, Anfrage-Detail). */
function istAnfrageUnterseite(pathname: string): boolean {
  return pathname.startsWith("/partner/anfragen/");
}

function titelFuerPfad(pathname: string): string {
  if (pathname === "/partner/anfragen/neu") return "Neue Anfrage";
  if (istAnfrageUnterseite(pathname)) return "Anfrage";
  const aktiv = aktiverPartnerBereich(pathname);
  return PARTNER_BEREICHE.find((b) => b.href === aktiv)!.label;
}

export function PartnerMobilKopf({ pathname }: { pathname: string }) {
  const router = useRouter();
  const zurueckSichtbar = istAnfrageUnterseite(pathname);

  function zurueck() {
    // Anfrage-Detail: IMMER zur Liste, wie der Desktop-Zurueck-Knopf der
    // Detailseite. Nach dem Absenden einer neuen Anfrage fuehrte router.back()
    // sonst zurueck ins leere Formular (Gefahr doppelter Anfragen).
    if (pathname !== "/partner/anfragen/neu") {
      router.push("/partner/anfragen");
      return;
    }
    // Neue Anfrage: zurueck, woher man kam. window.history.length === 1:
    // Seite direkt geoeffnet — dann zur Liste statt router.back() (No-op).
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.push("/partner/anfragen");
  }

  return (
    <header
      className="md:hidden shrink-0 border-b border-border bg-background/95 backdrop-blur"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      <div className="flex h-[46px] items-center gap-[6px] pl-[16px] pr-[10px]">
        {zurueckSichtbar && (
          <button
            type="button"
            aria-label="Zurück"
            onClick={zurueck}
            className="-ml-[6px] inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-xl text-foreground active:bg-foreground/10"
          >
            <ArrowLeft className="h-[22px] w-[22px]" />
          </button>
        )}
        <span className="min-w-0 flex-1 truncate font-heading text-[18px] font-bold leading-[24px] tracking-tight">
          {titelFuerPfad(pathname)}
        </span>
        <NotificationsBell variant="kopf" />
      </div>
    </header>
  );
}

export function PartnerMobilLeiste({ pathname }: { pathname: string }) {
  const aktiv = aktiverPartnerBereich(pathname);
  return (
    <nav
      aria-label="Partner-Navigation"
      className="md:hidden shrink-0 border-t border-sidebar-border bg-sidebar/95 text-sidebar-foreground backdrop-blur-lg font-heading"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="grid h-[48px] grid-cols-3 px-1">
        {PARTNER_BEREICHE.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            aria-current={aktiv === href ? "page" : undefined}
            className={cn(
              "flex min-w-0 flex-col items-center justify-center gap-[3px] text-[11px] font-bold transition-colors",
              aktiv === href ? "text-red-500" : "text-sidebar-foreground/60",
            )}
          >
            <Icon className="h-[22px] w-[22px]" />
            <span className="max-w-full truncate">{label}</span>
          </Link>
        ))}
      </div>
    </nav>
  );
}
