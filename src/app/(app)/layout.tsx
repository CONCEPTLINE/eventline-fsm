"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Sidebar } from "@/components/layout/sidebar";
import { MobileNav } from "@/components/layout/mobile-nav";
import { StempelWidget } from "@/components/stempel/stempel-widget";
import { Toaster } from "@/components/ui/sonner";
import { NAV_GROUPS, ADMIN_NAV_GROUP } from "@/lib/constants";
import { isPathAllowed } from "@/lib/permissions";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Sun, Moon, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/logo";
import { Spinner } from "@/components/ui/spinner";
import { useTheme } from "next-themes";
import { NAV_ICON_MAP } from "@/lib/nav-icons";
import { useEnterAsTab } from "@/lib/use-enter-as-tab";
import { useScrollRestoration } from "@/lib/use-scroll-restoration";
import { PermissionsProvider, usePermissions } from "@/lib/use-permissions";
import { StempelProvider } from "@/lib/use-stempel";
import { NavCountsProvider, useNavCounts, getBadgeForHref } from "@/lib/use-nav-counts";

// Outer-Wrapper — nur Provider. Der Inner-Layout kann den Provider
// dann via Hook konsumieren statt eigenem Self-Load.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <PermissionsProvider>
      <StempelProvider>
        <AppLayoutInner>{children}</AppLayoutInner>
      </StempelProvider>
    </PermissionsProvider>
  );
}

function AppLayoutInner({ children }: { children: React.ReactNode }) {
  const { profile, permissions, ready, loadError } = usePermissions();
  const loading = !ready;
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { theme, setTheme } = useTheme();
  const supabase = createClient();

  // Wenn kein User → Login. Re-direct erst wenn ready damit kein Flicker.
  useEffect(() => {
    if (ready && !profile && !loadError) router.push("/login");
  }, [ready, profile, loadError, router]);

  // Globale Regel: Enter im Input/Select springt zum nächsten Feld, statt zu submitten.
  useEnterAsTab();

  // App-weit: Scroll-Position wiederherstellen wenn man zur vorherigen
  // Seite zurueck navigiert (Back-Pfeil, Browser-Back). Forward-Nav
  // bleibt scroll-to-top wie gewohnt.
  useScrollRestoration();

  // Realtime — EIN globaler Channel fuer alle Tables; vorher hatte jeder
  // Listener (use-stempel, notifications-bell, vertrieb-page, etc.) seine
  // eigene WebSocket-Verbindung. Bei 100 Mitarbeitern × 3 Tabs × 4 Channels
  // waren das 1200 concurrent Realtime-Connections gegen das Supabase-
  // Plan-Limit.
  //
  // Jetzt: ein Channel mit Subscriptions fuer alle relevanten Tables. Auf
  // Change wird ein window-Event mit Stable-Name `realtime:<table>` gefeuert.
  // Konsumenten lauschen via window.addEventListener — keine eigenen
  // Channels mehr noetig. Plus zwei Legacy-Events ("jobs:invalidate",
  // "customers:invalidate") die schon im Code referenziert sind.
  useEffect(() => {
    // CustomEvent damit Konsumenten den Payload (eventType + new + old)
    // bekommen, statt nur "irgendwas hat sich geaendert". Brauchen wir
    // z.B. fuer den Toast-on-Receive in der NotificationsBell, der den
    // Title des NEU eingefuegten Eintrags sofort anzeigen soll ohne
    // erstmal load() zu triggern.
    const dispatch = (table: string) => (payload: unknown) => {
      window.dispatchEvent(new CustomEvent(`realtime:${table}`, { detail: payload }));
    };
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;

    (async () => {
      // notifications + time_entries pro User filtern — Bandwidth-Schnitt:
      // vorher kriegte jeder Tab den Fan-out fuer ALLE Inserts in diesen
      // Tables und filterte clientseitig (RLS sorgte zwar fuer Row-Sicht-
      // barkeit, aber das Event-Volumen war voll). Filter macht Realtime
      // server-seitig: nur User-relevante Events kommen rueber.
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || cancelled) return;

      channel = supabase
        .channel("global-invalidate")
        .on("postgres_changes", { event: "*", schema: "public", table: "jobs" }, () => {
          window.dispatchEvent(new Event("jobs:invalidate"));
          window.dispatchEvent(new Event("realtime:jobs"));
        })
        .on("postgres_changes", { event: "*", schema: "public", table: "customers" }, () => {
          window.dispatchEvent(new Event("customers:invalidate"));
          window.dispatchEvent(new Event("realtime:customers"));
        })
        .on("postgres_changes", {
          event: "*", schema: "public", table: "notifications",
          filter: `user_id=eq.${user.id}`,
        }, dispatch("notifications"))
        .on("postgres_changes", {
          event: "*", schema: "public", table: "time_entries",
          filter: `user_id=eq.${user.id}`,
        }, dispatch("time_entries"))
        .on("postgres_changes", { event: "*", schema: "public", table: "vertrieb_contacts" }, dispatch("vertrieb_contacts"))
        .on("postgres_changes", { event: "*", schema: "public", table: "tickets" }, dispatch("tickets"))
        .on("postgres_changes", { event: "*", schema: "public", table: "service_reports" }, dispatch("service_reports"))
        .on("postgres_changes", { event: "*", schema: "public", table: "admin_personal_space" }, dispatch("admin_personal_space"))
        .subscribe((status, err) => {
          // Realtime-Subscription-Status sichtbar machen — vorher 'silent fail'
          // wenn z.B. WSS vom Netzwerk geblockt wurde oder Auth-Token abgelaufen.
          // Bei Fehler wird ein Window-Event gefeuert das die Bell zum Polling-
          // Fallback umschaltet.
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            // eslint-disable-next-line no-console
            console.warn("[realtime] subscription degraded:", status, err);
            window.dispatchEvent(new CustomEvent("realtime:status", { detail: { ok: false, status } }));
          } else if (status === "SUBSCRIBED") {
            window.dispatchEvent(new CustomEvent("realtime:status", { detail: { ok: true, status } }));
          }
        });
    })();

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Path-Guard: wenn der aktuelle Pfad fuer diese Rolle nicht erlaubt ist,
  // zurueck aufs Dashboard. Greift wenn jemand eine URL direkt aufruft die
  // nicht in seiner Sidebar steht.
  // Partner-Rolle gehoert ueberhaupt nicht in (app) — direkt ins Partner-
  // Portal umleiten.
  useEffect(() => {
    if (!profile) return;
    if (profile.role === "partner") {
      router.replace("/partner/anfragen");
      return;
    }
    if (!isPathAllowed(pathname, permissions, profile.role)) {
      router.replace("/dashboard");
    }
  }, [pathname, profile, permissions, router]);

  async function handleSignOut() {
    // Server-Side Session-Tracking schliessen bevor Auth-Token weg ist
    // — sonst wuerde die Session als "stale" eingestuft beim naechsten
    // Heartbeat eines anderen Users (technisch unwahrscheinlich, aber
    // sauber).
    try {
      await fetch("/api/sessions/end", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "logout" }),
      });
    } catch { /* best-effort */ }
    await supabase.auth.signOut();
    router.push("/login");
    router.refresh();
  }

  // Heartbeat — alle 5 min ein POST an /api/sessions/heartbeat damit
  // die Session als "aktiv" markiert bleibt + last_seen_at aktualisiert
  // wird. Erster Heartbeat beim Mount sobald wir wissen dass der User
  // eingeloggt ist (profile geladen).
  // Bonus: das Endpoint returnt 403 wenn der User waehrend der Session
  // deaktiviert wurde — dann werfen wir ihn sofort raus.
  useEffect(() => {
    if (!profile) return;
    const ping = async () => {
      try {
        const res = await fetch("/api/sessions/heartbeat", { method: "POST" });
        if (res.status === 403) {
          await supabase.auth.signOut();
          router.push("/login?reason=deactivated");
          router.refresh();
        }
      } catch { /* best-effort */ }
    };
    ping();
    const interval = setInterval(ping, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [profile, supabase, router]);

  // Inaktivitaets-Logout — nur fuer Non-Admins. 30 min ohne Maus-/
  // Tastatur-/Scroll-/Touch-Interaktion -> auto-Logout mit Hinweis auf
  // der Login-Seite. Admins sind ausgenommen damit Backoffice-Tabs
  // nicht alle 30 min ausloggen.
  useEffect(() => {
    if (!profile || profile.role === "admin") return;
    const TIMEOUT_MS = 30 * 60 * 1000;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const expire = async () => {
      try {
        await fetch("/api/sessions/end", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "inactive" }),
        });
      } catch { /* best-effort */ }
      await supabase.auth.signOut();
      router.push("/login?reason=inactive");
      router.refresh();
    };

    const reset = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(expire, TIMEOUT_MS);
    };
    reset();

    const events: Array<keyof DocumentEventMap> = ["mousedown", "keydown", "scroll", "touchstart"];
    for (const e of events) document.addEventListener(e, reset, { passive: true });
    return () => {
      if (timer) clearTimeout(timer);
      for (const e of events) document.removeEventListener(e, reset);
    };
  }, [profile, supabase, router]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center flex flex-col items-center">
          <Logo size="lg" />
          <div className="mt-4 flex items-center justify-center">
            <Spinner size={24} />
          </div>
        </div>
      </div>
    );
  }

  if (loadError || !profile) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="max-w-md w-full bg-card border rounded-2xl p-6 space-y-3">
          <h2 className="text-lg font-semibold">Konnte nicht geladen werden</h2>
          <p className="text-sm text-muted-foreground">{loadError ?? "Profil ist null."}</p>
          <div className="flex gap-2 pt-2">
            <button onClick={() => location.reload()} className="kasten kasten-muted flex-1">Neu laden</button>
            <button onClick={handleSignOut} className="kasten kasten-red flex-1">Abmelden</button>
          </div>
        </div>
      </div>
    );
  }

  // Sidebar + Mobile-Sheet zeigen dieselben gefilterten Gruppen.
  // Filter laeuft pro Item via isPathAllowed (admin sieht alles).
  const groups = [...NAV_GROUPS, ADMIN_NAV_GROUP]
    .map((g) => ({ ...g, items: g.items.filter((i) => isPathAllowed(i.href, permissions, profile.role)) }))
    .filter((g) => g.items.length > 0);

  return (
    <NavCountsProvider isAdmin={profile.role === "admin"}>
    <div className="flex min-h-screen bg-[#f5f5f7] dark:bg-[#0a0a0a]">
      <Sidebar
        profile={profile}
        permissions={permissions}
        onSignOut={handleSignOut}
      />

      {/* Margin-left = Sidebar-Breite (260px) ab md-Breakpoint, damit der
          Content-Bereich nicht unter der fixed-positionierten Sidebar liegt.
          Bottom-Padding auf Mobile: MobileNav (80px) + Stempel-Bar (52px) +
          Safe-Area + Puffer = Content scrollt frei oberhalb der UI-Layer. */}
      {/* id="app-scroll" — durch overflow-x-hidden wird overflow-y
          implizit auto (CSS-Quirk), dieser Div ist daher der echte
          Scroll-Container der App und nicht window. useScrollRestoration
          targetiert das Element ueber diese id. */}
      <div id="app-scroll" className="flex-1 flex flex-col pb-[calc(env(safe-area-inset-bottom)+200px)] md:pb-0 min-w-0 overflow-x-hidden md:ml-[260px]">
        <main className="flex-1 p-3 sm:p-4 pt-[calc(env(safe-area-inset-top)+12px)] sm:pt-[calc(env(safe-area-inset-top)+16px)] md:p-8 md:pt-8 max-w-[1400px] w-full mx-auto min-w-0">{children}</main>
      </div>

      <MobileNav onMenuOpen={() => setMobileMenuOpen(true)} permissions={permissions} role={profile.role} />
      {/* Stempel-Widget verschwindet wenn Sheet offen ist — sonst klebt
          die volle-Breite-Bar mit Backdrop-Blur halb sichtbar neben dem
          Sheet und verwirrt. */}
      {!mobileMenuOpen && <StempelWidget />}

      {/* Mobile Menu Sheet — flex-col layout:
          Header (shrink-0) -> Nav (flex-1, scrollable) -> Footer (shrink-0).
          Vorher waren Dark-Mode-Button und User-Card absolute positioniert
          und konnten die letzten Nav-Items (z.B. Einstellungen) verdecken
          wenn die Liste lang wurde + safe-area-bottom dazu kam. */}
      <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <SheetContent side="left" className="bg-sidebar text-sidebar-foreground border-sidebar-border w-[280px] p-0 font-heading flex flex-col h-full">
          <SheetHeader className="px-5 py-3 border-b border-sidebar-border shrink-0">
            <SheetTitle className="text-left">
              <Logo size="sm" />
            </SheetTitle>
          </SheetHeader>
          <nav className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-2">
            {groups.map((group) => {
              const items = group.items;
              if (items.length === 0) return null;

              return (
                <div key={group.label || group.items[0]?.href}>
                  {group.label && (
                    <p className="px-3 mt-1 mb-0.5 text-[10px] font-semibold tracking-wider text-sidebar-foreground/40 uppercase">
                      {group.label}
                    </p>
                  )}
                  {items.map((item) => (
                    <SheetNavLink
                      key={item.href}
                      item={item}
                      pathname={pathname}
                      searchString={searchParams.toString()}
                      role={profile.role}
                      onClick={() => setMobileMenuOpen(false)}
                    />
                  ))}
                </div>
              );
            })}
          </nav>

          {/* Footer-Section: kompakt mit Theme-Toggle + User-Identitaet +
              Abmelden in einer Reihe. Vorher: Theme-Toggle als eigene
              Reihe + 4-Zeilen-Card mit Logout-Link unten — zu viel
              vertikaler Platz fuer wenig Info. */}
          <div className="shrink-0 border-t border-sidebar-border px-3 py-2" style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 8px)" }}>
            <div className="flex items-center gap-2">
              {/* User-Card klickbar -> /mein-konto. Schliesst das Sheet
                  automatisch beim Navigieren. Theme + Logout bleiben
                  rechts daneben separat. */}
              <Link
                href="/mein-konto"
                onClick={() => setMobileMenuOpen(false)}
                className="flex-1 min-w-0 flex items-center gap-2 rounded-lg hover:bg-sidebar-accent/60 transition-all -mx-1 px-1 py-1"
              >
                <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-red-500 to-red-700 flex items-center justify-center text-white text-xs font-bold shrink-0">
                  {profile.full_name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-sidebar-foreground truncate leading-tight">{profile.full_name}</p>
                  <p className="text-[10px] text-sidebar-foreground/50 leading-tight">Mein Konto</p>
                </div>
              </Link>
              <button
                type="button"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
                className="p-1.5 rounded-lg text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/60 transition-all shrink-0"
                aria-label={theme === "dark" ? "Light Mode" : "Dark Mode"}
                data-tooltip={theme === "dark" ? "Light Mode" : "Dark Mode"}
              >
                {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={handleSignOut}
                className="p-1.5 rounded-lg text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/60 transition-all shrink-0"
                aria-label="Abmelden"
                data-tooltip="Abmelden"
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <Toaster />
    </div>
    </NavCountsProvider>
  );
}

// SheetNavLink — gekapselt damit useNavCounts() innerhalb des Providers
// konsumiert werden kann (AppLayoutInner stellt den Provider, kann ihn
// aber nicht selbst lesen weil der Hook das Component-Boundary braucht).
interface SheetNavLinkProps {
  item: { href: string; label: string; icon: string };
  pathname: string;
  searchString: string;
  role: string;
  onClick: () => void;
}
function SheetNavLink({ item, pathname, searchString, role, onClick }: SheetNavLinkProps) {
  const counts = useNavCounts();
  const Icon = NAV_ICON_MAP[item.icon];
  const fullUrl = pathname + (searchString ? `?${searchString}` : "");
  const isActive = item.href.includes("?")
    ? fullUrl === item.href
    : item.href === "/dashboard" || item.href === "/kalender"
      ? pathname === item.href
      : pathname.startsWith(item.href);
  const badge = getBadgeForHref(item.href, counts, role === "admin");
  return (
    <Link
      href={item.href}
      onClick={onClick}
      className={cn(
        "group flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[13px] font-medium transition-all",
        isActive
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/60"
      )}
    >
      {Icon && (
        <div className={cn(
          "flex items-center justify-center w-6 h-6 rounded-md shrink-0",
          isActive
            ? "bg-red-500/20 text-red-500 dark:text-red-400"
            : "bg-sidebar-foreground/[0.06] text-sidebar-foreground/60"
        )}>
          <Icon className="h-3.5 w-3.5" />
        </div>
      )}
      <span className="flex-1">{item.label}</span>
      {badge > 0 && (
        <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 text-[10px] font-medium rounded-full bg-foreground/10 text-foreground/60 tabular-nums">
          {badge > 99 ? "99+" : badge}
        </span>
      )}
    </Link>
  );
}
