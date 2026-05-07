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
import { Sun, Moon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/logo";
import { useTheme } from "next-themes";
import { NAV_ICON_MAP } from "@/lib/nav-icons";
import { useEnterAsTab } from "@/lib/use-enter-as-tab";
import { PermissionsProvider, usePermissions } from "@/lib/use-permissions";
import { StempelProvider } from "@/lib/use-stempel";
import { EveChat } from "@/components/eve-chat";

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
    const dispatch = (table: string) => () => {
      window.dispatchEvent(new Event(`realtime:${table}`));
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
        .subscribe();
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
  useEffect(() => {
    if (!profile) return;
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
  useEffect(() => {
    if (!profile) return;
    const ping = () => fetch("/api/sessions/heartbeat", { method: "POST" }).catch(() => {});
    ping();
    const interval = setInterval(ping, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [profile]);

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
          <div className="mt-4 flex items-center justify-center gap-1.5">
            <div className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
            <div className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse [animation-delay:200ms]" />
            <div className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse [animation-delay:400ms]" />
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
    <div className="flex min-h-screen bg-[#f5f5f7] dark:bg-[#0a0a0a]">
      <Sidebar
        profile={profile}
        permissions={permissions}
        onSignOut={handleSignOut}
      />

      {/* Margin-left = Sidebar-Breite (260px) ab md-Breakpoint, damit der
          Content-Bereich nicht unter der fixed-positionierten Sidebar liegt. */}
      <div className="flex-1 flex flex-col pb-[calc(env(safe-area-inset-bottom)+80px)] md:pb-0 min-w-0 overflow-x-hidden md:ml-[260px]">
        <main className="flex-1 p-3 sm:p-4 pt-[calc(env(safe-area-inset-top)+12px)] sm:pt-[calc(env(safe-area-inset-top)+16px)] md:p-8 md:pt-8 max-w-[1400px] w-full mx-auto min-w-0">{children}</main>
      </div>

      <MobileNav onMenuOpen={() => setMobileMenuOpen(true)} permissions={permissions} role={profile.role} />
      <StempelWidget />

      {/* Mobile Menu Sheet */}
      <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
        <SheetContent side="left" className="bg-sidebar text-sidebar-foreground border-sidebar-border w-[280px] p-0 font-heading">
          <SheetHeader className="px-6 py-6 border-b border-sidebar-border">
            <SheetTitle className="text-left">
              <Logo size="md" />
            </SheetTitle>
          </SheetHeader>
          <nav
            className="px-3 py-4 space-y-4 overflow-y-auto max-h-[calc(100vh-200px)]"
            style={{
              maskImage: "linear-gradient(to bottom, transparent 0, black 64px, black calc(100% - 64px), transparent 100%)",
              WebkitMaskImage: "linear-gradient(to bottom, transparent 0, black 64px, black calc(100% - 64px), transparent 100%)",
            }}
          >
            {groups.map((group) => {
              const items = group.items;
              if (items.length === 0) return null;

              return (
                <div key={group.label || group.items[0]?.href}>
                  {group.label && (
                    <p className="px-3 mb-1.5 text-[10px] font-semibold tracking-wider text-sidebar-foreground/40 uppercase">
                      {group.label}
                    </p>
                  )}
                  {items.map((item) => {
                    const Icon = NAV_ICON_MAP[item.icon];
                    const fullUrl = pathname + (searchParams.toString() ? `?${searchParams.toString()}` : "");
                    const isActive = item.href.includes("?")
                      ? fullUrl === item.href
                      : item.href === "/dashboard" || item.href === "/kalender"
                        ? pathname === item.href
                        : pathname.startsWith(item.href);
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={() => setMobileMenuOpen(false)}
                        className={cn(
                          "group flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-all",
                          isActive
                            ? "bg-sidebar-accent text-sidebar-accent-foreground"
                            : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/60"
                        )}
                      >
                        {Icon && (
                          <div className={cn(
                            "flex items-center justify-center w-7 h-7 rounded-md",
                            isActive
                              ? "bg-red-500/20 text-red-500 dark:text-red-400"
                              : "bg-sidebar-foreground/[0.06] text-sidebar-foreground/60"
                          )}>
                            <Icon className="h-4 w-4" />
                          </div>
                        )}
                        {item.label}
                      </Link>
                    );
                  })}
                </div>
              );
            })}
          </nav>

          {/* Toggles */}
          <div className="absolute bottom-[90px] left-3 right-3 space-y-0.5">
            <button
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[12px] font-medium text-sidebar-foreground/60 hover:text-sidebar-foreground hover:bg-sidebar-accent/60 transition-all"
            >
              {theme === "dark" ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
              {theme === "dark" ? "Light Mode" : "Dark Mode"}
            </button>
          </div>

          <div className="absolute bottom-3 left-3 right-3">
            <div className="p-4 rounded-xl bg-sidebar-foreground/[0.04] border border-sidebar-border">
              <div className="flex items-center gap-3">
                <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-red-500 to-red-700 flex items-center justify-center text-white text-sm font-bold">
                  {profile.full_name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <p className="text-sm font-semibold text-sidebar-foreground">{profile.full_name}</p>
                  <p className="text-[11px] text-sidebar-foreground/50 capitalize">{profile.role}</p>
                </div>
              </div>
              <button
                onClick={handleSignOut}
                className="mt-3 w-full text-left text-[13px] text-sidebar-foreground/50 hover:text-sidebar-foreground transition-colors"
              >
                Abmelden
              </button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      <Toaster />
      {/* Eve — der app-interne Chatbot, fuer alle eingeloggten Mitarbeiter
          sichtbar. RLS auf den DB-Tools sorgt dafuer dass jeder nur eigene
          Daten sieht. */}
      {profile && <EveChat />}
    </div>
  );
}
