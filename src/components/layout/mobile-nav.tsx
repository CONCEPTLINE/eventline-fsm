"use client";

/**
 * Bottom-Nav (nur Handy, < md). Fuenf feste Plaetze:
 *   Dashboard · Todos · [Stempeln] · Kalender · Mehr
 *
 * Stempeln ist eine Aktion (Sheet), kein Link — und zeigt eingestempelt
 * die laufende Zeit in der Kachel. Die frueher separate Stempel-Bar ueber
 * der Nav ist weg (belegte zusammen mit der Nav ~130 px). «Mehr» oeffnet
 * das Mehr-Sheet (Aufträge, Stempelzeiten, Tickets, Ferien, Mein Konto …).
 *
 * Plaetze kommen aus NAV_GROUPS (mobile: true) und werden per
 * isPathAllowed gefiltert — Admin sieht alles.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Clock, Menu } from "lucide-react";
import { cn } from "@/lib/utils";
import { NAV_GROUPS, ADMIN_NAV_GROUP, type NavItem } from "@/lib/constants";
import { NAV_ICON_MAP } from "@/lib/nav-icons";
import { hasPermission, isPathAllowed } from "@/lib/permissions";
import { useNavCounts, getBadgeForHref } from "@/lib/use-nav-counts";
import { useStempel } from "@/lib/use-stempel";
import { istMehrBereich } from "@/lib/mobile-seiten";

interface MobileNavProps {
  permissions: string[];
  role: string;
  mehrOpen: boolean;
  stempelOpen: boolean;
  onMehrOpen: () => void;
  onStempelOpen: () => void;
}

function getMobileItems(permissions: string[], role: string): NavItem[] {
  const all = [...NAV_GROUPS, ADMIN_NAV_GROUP].flatMap((g) => g.items);
  return all.filter((item) => item.mobile && isPathAllowed(item.href, permissions, role));
}

/** Laufende Dauer kurz: «2:14» (Stunden:Minuten) — Sekunden gehoeren ins Sheet. */
function kurzDauer(clockIn: string, now: number): string {
  const sec = Math.max(0, Math.floor((now - new Date(clockIn).getTime()) / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}:${m.toString().padStart(2, "0")}`;
}

export function MobileNav({ permissions, role, mehrOpen, stempelOpen, onMehrOpen, onStempelOpen }: MobileNavProps) {
  const pathname = usePathname();
  const items = getMobileItems(permissions, role);
  const navCounts = useNavCounts();
  // Ticket-Badge-Quelle: tickets:manage-Queue statt role==='admin' (W5) —
  // konsistent mit Sidebar + NavCountsProvider.
  const canManageTickets = hasPermission(permissions, role, "tickets:manage");
  const { active } = useStempel();
  const [now, setNow] = useState(() => Date.now());

  // Minuten-Anzeige: Tick alle 30 s reicht, spart Renders. Erster Tick
  // sofort (als Callback, nicht synchron im Effekt), damit nach dem
  // Einstempeln nicht 30 s lang ein alter Wert steht.
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [active]);

  const links = items.filter((i) => i.href !== "/kalender");
  const kalender = items.find((i) => i.href === "/kalender") ?? null;
  const spalten = links.length + 1 + (kalender ? 1 : 0) + 1;
  const sheetOffen = mehrOpen || stempelOpen;

  function isActive(href: string) {
    if (sheetOffen) return false;
    if (href === "/dashboard" || href === "/kalender") return pathname === href;
    return pathname.startsWith(href);
  }
  const mehrAktiv = mehrOpen || (!stempelOpen && istMehrBereich(pathname));

  return (
    <nav
      aria-label="Hauptnavigation"
      className="md:hidden fixed inset-x-0 bottom-0 z-50 border-t border-sidebar-border bg-sidebar/95 text-sidebar-foreground backdrop-blur-lg font-heading"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {/* Empty-State analog Sidebar: User mit leerer Permissions-Liste sieht
          sonst nur «Mehr» und glaubt die App ist kaputt. */}
      {items.length === 0 ? (
        <div className="px-4 py-3 text-center text-[12px] leading-snug text-sidebar-foreground/70">
          Deine Rolle hat keine Module freigeschaltet. Bitte sprich mit deinem Admin.
        </div>
      ) : (
        <div className="grid h-16 px-1" style={{ gridTemplateColumns: `repeat(${spalten}, minmax(0, 1fr))` }}>
          {links.map((item) => (
            <NavPlatz
              key={item.href}
              item={item}
              active={isActive(item.href)}
              badge={getBadgeForHref(item.href, navCounts, canManageTickets)}
            />
          ))}

          <button
            type="button"
            onClick={onStempelOpen}
            aria-label={active ? `Eingestempelt seit ${kurzDauer(active.clock_in, now)} — Stempel-Details` : "Einstempeln"}
            className={cn(
              "flex flex-col items-center justify-center gap-[3px] text-[11px] font-bold transition-colors",
              active || stempelOpen ? "text-teal-700 dark:text-teal-300" : "text-sidebar-foreground/60",
            )}
          >
            <span
              className="inline-flex h-7 w-[52px] items-center justify-center rounded-[10px] text-teal-700 dark:text-teal-300"
              style={{
                border: "2px solid var(--stempel-color, #14b8a6)",
                backgroundColor: active ? "rgba(20,184,166,0.18)" : "transparent",
              }}
            >
              {active ? (
                <span className="font-mono text-[14px] font-bold tabular-nums">{kurzDauer(active.clock_in, now)}</span>
              ) : (
                <Clock className="h-[18px] w-[18px]" strokeWidth={2.2} />
              )}
            </span>
            Stempeln
          </button>

          {kalender && (
            <NavPlatz item={kalender} active={isActive(kalender.href)} badge={0} />
          )}

          <button
            type="button"
            onClick={onMehrOpen}
            className={cn(
              "flex flex-col items-center justify-center gap-[3px] text-[11px] font-bold transition-colors",
              mehrAktiv ? "text-red-500" : "text-sidebar-foreground/60",
            )}
          >
            <Menu className="h-[22px] w-[22px]" />
            Mehr
          </button>
        </div>
      )}
    </nav>
  );
}

function NavPlatz({ item, active, badge }: { item: NavItem; active: boolean; badge: number }) {
  const Icon = NAV_ICON_MAP[item.icon];
  return (
    <Link
      href={item.href}
      className={cn(
        "flex flex-col items-center justify-center gap-[3px] text-[11px] font-bold transition-colors",
        active ? "text-red-500" : "text-sidebar-foreground/60",
      )}
    >
      <span className="relative inline-flex">
        {Icon && <Icon className="h-[22px] w-[22px]" />}
        {badge > 0 && (
          <span className="absolute -top-1.5 -right-2.5 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-sidebar bg-red-600 px-1 font-sans text-[11px] font-bold leading-none text-white tabular-nums">
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </span>
      <span className="truncate">{item.label}</span>
    </Link>
  );
}
