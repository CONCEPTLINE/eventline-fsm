"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Menu } from "lucide-react";
import { NAV_GROUPS, ADMIN_NAV_GROUP, type NavItem } from "@/lib/constants";
import { NAV_ICON_MAP } from "@/lib/nav-icons";
import { hasPermission, isPathAllowed } from "@/lib/permissions";
import { useNavCounts, getBadgeForHref } from "@/lib/use-nav-counts";

interface MobileNavProps {
  onMenuOpen: () => void;
  permissions: string[];
  role: string;
}

function getMobileItems(permissions: string[], role: string): NavItem[] {
  const all = [...NAV_GROUPS, ADMIN_NAV_GROUP].flatMap((g) => g.items);
  return all
    .filter((item) => item.mobile && isPathAllowed(item.href, permissions, role))
    .slice(0, 4);
}

export function MobileNav({ onMenuOpen, permissions, role }: MobileNavProps) {
  const pathname = usePathname();
  const items = getMobileItems(permissions, role);
  const navCounts = useNavCounts();
  // Ticket-Badge-Quelle: tickets:manage-Queue statt role==='admin' (W5) —
  // konsistent mit Sidebar + NavCountsProvider.
  const canManageTickets = hasPermission(permissions, role, "tickets:manage");

  function isActive(href: string) {
    if (href === "/dashboard") return pathname === "/dashboard";
    if (href === "/kalender") return pathname === "/kalender";
    return pathname.startsWith(href);
  }

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-sidebar/95 text-sidebar-foreground backdrop-blur-lg border-t border-sidebar-border z-50 pb-[env(safe-area-inset-bottom)] font-heading">
      {/* Empty-State analog Sidebar: User mit leerer Permissions-Liste sieht
          sonst nur einen "Mehr"-Button und glaubt die App ist kaputt. */}
      {items.length === 0 ? (
        <div className="px-4 py-3 text-center text-[11px] text-sidebar-foreground/70 leading-snug">
          Deine Rolle hat keine Module freigeschaltet. Bitte sprich mit deinem Admin.
        </div>
      ) : (
        <div className="flex items-center justify-around px-1 pt-2 pb-1">
          {items.map((item) => {
            const Icon = NAV_ICON_MAP[item.icon];
            const active = isActive(item.href);
            const badge = getBadgeForHref(item.href, navCounts, canManageTickets);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "relative flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-xl text-[10px] font-medium transition-all min-w-[60px]",
                  active ? "text-red-500" : "text-sidebar-foreground/60 active:text-sidebar-foreground"
                )}
              >
                {/* Badge oben rechts vom Icon — transparenter Filler +
                    roter Border + roter Text, bg pulsiert dunkel-tinted
                    zu rot (siehe @keyframes badge-pulse in globals.css). */}
                {badge > 0 && (
                  <span className="badge-pulse-anim absolute top-0.5 right-2 inline-flex items-center justify-center min-w-[14px] h-[14px] px-1 text-[9px] font-bold rounded-full border border-red-500/60 text-red-600 dark:text-red-300 tabular-nums leading-none">
                    {badge > 99 ? "99+" : badge}
                  </span>
                )}
                {Icon && <Icon className={cn("h-5 w-5", active && "scale-110")} />}
                <span className="truncate max-w-[64px]">{item.label}</span>
              </Link>
            );
          })}
          <button
            onClick={onMenuOpen}
            className="flex flex-col items-center gap-0.5 px-3 py-1.5 text-sidebar-foreground/60 text-[10px] font-medium active:text-sidebar-foreground min-w-[60px]"
          >
            <Menu className="h-5 w-5" />
            <span>Mehr</span>
          </button>
        </div>
      )}
    </nav>
  );
}
