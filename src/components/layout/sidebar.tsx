"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { NAV_GROUPS, ADMIN_NAV_GROUP } from "@/lib/constants";
import type { NavGroup } from "@/lib/constants";
import { NAV_ICON_MAP } from "@/lib/nav-icons";
import { isPathAllowed } from "@/lib/permissions";
import { Logo } from "@/components/logo";
import { SidebarStempel } from "@/components/stempel/sidebar-stempel";
import { NotificationsBell } from "@/components/layout/notifications-bell";
import {
  LogOut,
  ChevronRight,
  Sun,
  Moon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useNavCounts, getBadgeForHref } from "@/lib/use-nav-counts";
import type { Profile } from "@/types";

interface SidebarProps {
  profile: Profile;
  /** Erlaubte Modul-Slugs aus der Rollen-Konfiguration. */
  permissions: string[];
  onSignOut: () => void;
}

export function Sidebar({ profile, permissions, onSignOut }: SidebarProps) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { theme, setTheme } = useTheme();
  const navCounts = useNavCounts();
  const isAdmin = profile.role === "admin";
  const fullUrl = pathname + (searchParams.toString() ? `?${searchParams.toString()}` : "");

  // Fade-Mask nur dort wo's noch was zu scrollen gibt — Top-Fade nur wenn
  // hochgescrollt, Bottom-Fade nur wenn noch was unten ist. Sonst war auch
  // an Raendern transparent obwohl kein Overflow existierte.
  const navRef = useRef<HTMLElement | null>(null);
  const [fadeTop, setFadeTop] = useState(false);
  const [fadeBottom, setFadeBottom] = useState(false);
  useEffect(() => {
    const el = navRef.current;
    if (!el) return;
    const update = () => {
      setFadeTop(el.scrollTop > 1);
      setFadeBottom(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    // ResizeObserver fuer Sidebar-Resize (window) und Content-Aenderungen
    // (Nav-Items kommen/gehen je nach Rolle/Permission).
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child as Element);
    return () => { el.removeEventListener("scroll", update); ro.disconnect(); };
  }, []);
  const maskGradient = (() => {
    const top = fadeTop ? "transparent 0, black 64px" : "black 0";
    const bottom = fadeBottom ? "black calc(100% - 64px), transparent 100%" : "black 100%";
    return `linear-gradient(to bottom, ${top}, ${bottom})`;
  })();


  // Wir filtern alle Nav-Items nach den Permissions der Rolle des Users.
  // Admin-Group + Standard-Group werden zusammengelegt und dann gefiltert;
  // leere Gruppen verschwinden automatisch (kein hardcoded role==="admin"
  // mehr — die Rollen-Tabelle entscheidet was sichtbar ist).
  const groups: NavGroup[] = [...NAV_GROUPS, ADMIN_NAV_GROUP]
    .map((g) => ({ ...g, items: g.items.filter((i) => isPathAllowed(i.href, permissions, profile.role)) }))
    .filter((g) => g.items.length > 0);

  function isActive(href: string, matchPrefixes?: string[]) {
    // Exact match for items with query params (e.g. /einstellungen?tab=zeiten)
    if (href.includes("?")) {
      return fullUrl === href;
    }
    // Top-level singletons: exact match only, so deeper paths don't bleed into the highlight.
    if (href === "/dashboard" || href === "/kalender") return pathname === href;
    if (pathname.startsWith(href)) return true;
    // Zusatz-Prefixe (z.B. /standorte und /raeume gehoeren zu /locations)
    if (matchPrefixes?.some((p) => pathname.startsWith(p))) return true;
    return false;
  }

  return (
    <aside className="hidden md:flex md:flex-col fixed left-0 top-0 w-[260px] h-screen bg-sidebar text-sidebar-foreground shadow-lg border-r border-sidebar-border font-heading z-30">
      {/* Logo — Top auf 38px */}
      <div className="px-6 pt-[38px] pb-4 flex items-start justify-center">
        <Link href="/dashboard" className="block">
          <Logo size="md" />
        </Link>
      </div>

      {/* Navigation — mask-image fade nur an Raendern wo tatsaechlich noch
          Content zu scrollen ist (siehe useEffect oben). Top-Items
          erscheinen voll opak wenn nicht hochgescrollt; gleiche Logik unten. */}
      <nav
        ref={navRef}
        className="flex-1 px-3 py-4 overflow-y-auto space-y-4"
        style={{
          maskImage: maskGradient,
          WebkitMaskImage: maskGradient,
        }}
      >
        {/* Empty-State: User mit leerer Permissions-Liste sieht sonst gar
            nichts und glaubt die App ist kaputt. Der Hinweis macht klar
            dass es ein Permission-Problem ist und an wen er sich wenden
            soll. */}
        {groups.length === 0 && (
          <div className="px-3 py-4 rounded-lg bg-sidebar-accent/50 text-sidebar-foreground/70 text-[12px] leading-relaxed">
            <p className="font-medium mb-1 text-sidebar-foreground">Noch keine Berechtigungen</p>
            <p>Deine Rolle hat keine Module freigeschaltet. Bitte sprich mit deinem Admin.</p>
          </div>
        )}
        {groups.map((group) => {
          const items = group.items;
          if (items.length === 0) return null;

          return (
            <div key={group.label || group.items[0]?.href}>
              {group.label && (
                <p className="px-3 mb-1.5 text-[10px] font-semibold tracking-wider text-sidebar-foreground/50 uppercase">
                  {group.label}
                </p>
              )}
              <div className="space-y-0.5">
                {items.map((item) => {
                  const Icon = NAV_ICON_MAP[item.icon];
                  const active = isActive(item.href, item.matchPrefixes);
                  const badge = getBadgeForHref(item.href, navCounts, isAdmin);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cn(
                        "group flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-all duration-200",
                        active
                          ? "bg-sidebar-accent text-sidebar-accent-foreground shadow-sm"
                          : "text-sidebar-foreground hover:bg-sidebar-accent/60"
                      )}
                    >
                      {Icon && (
                        <div className={cn(
                          "flex items-center justify-center w-7 h-7 rounded-md transition-all duration-200",
                          active
                            ? "bg-red-500/20 text-red-500 dark:text-red-400"
                            : "bg-sidebar-foreground/[0.08] text-sidebar-foreground"
                        )}>
                          <Icon className="h-4 w-4" />
                        </div>
                      )}
                      <span className="flex-1">{item.label}</span>
                      {badge > 0 && (
                        // Dezent: tinted bg statt solides Rot, muted Text.
                        // Nur als Counter, kein Alarm-Style.
                        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 text-[10px] font-medium rounded-full bg-foreground/10 text-foreground/60 tabular-nums">
                          {badge > 99 ? "99+" : badge}
                        </span>
                      )}
                      {active && badge === 0 && (
                        <ChevronRight className="h-3 w-3 text-sidebar-foreground/30" />
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      {/* Stempel — eingestempelt zeigt Live-Timer + Ausstempeln,
          ausgestempelt zeigt "Einstempeln"-Button. Steht ueber dem
          Theme-Toggle damit es als prominenter Action-Bereich endet. */}
      <SidebarStempel />

      {/* Theme-Toggle (Light/Dark) + Notifications-Glocke. Glocke rechts
          ausgerichtet damit sie immer sichtbar ist neben dem Theme-Text. */}
      <div className="px-3 mb-2 flex items-center gap-1">
        <button
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          className="flex-1 flex items-center gap-2.5 px-3 py-2 rounded-lg text-[12px] font-medium text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/60 transition-all"
        >
          {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          {theme === "dark" ? "Light Mode" : "Dark Mode"}
        </button>
        <NotificationsBell />
      </div>

      {/* User */}
      <div className="p-4 mx-3 mb-3 rounded-xl bg-sidebar-foreground/[0.04] border border-sidebar-border">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-red-500 to-red-700 flex items-center justify-center text-white text-sm font-bold shadow-lg shadow-red-500/20">
            {profile.full_name.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-sidebar-foreground truncate">
              {profile.full_name}
            </p>
            <p className="text-[11px] text-sidebar-foreground/50 capitalize">{profile.role}</p>
          </div>
          <button
            onClick={onSignOut}
            className="p-2 rounded-lg text-sidebar-foreground/40 hover:text-sidebar-foreground hover:bg-sidebar-accent/60 transition-all duration-200"
            data-tooltip="Abmelden"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </aside>
  );
}
