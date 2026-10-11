"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Sidebar } from "@/components/layout/sidebar";
import { MobileNav } from "@/components/layout/mobile-nav";
import { MobileKopf } from "@/components/mobile/mobile-kopf";
import { MehrSheet } from "@/components/mobile/mehr-sheet";
import { StempelNavSheet, STEMPEL_OPEN_EVENT } from "@/components/mobile/stempel-sheet";
import { OfflineStreifen } from "@/components/mobile/offline-streifen";
import { useWartendeRapporte } from "@/components/mobile/uebertragungen-sheet";
import { AppInstallHinweis } from "@/components/mobile/app-install-hinweis";
import { ABMELDEN_EVENT } from "@/lib/mobile-seiten";
import { NotificationsProvider } from "@/components/layout/notifications-bell";
import { Toaster } from "@/components/ui/sonner";
import { VersionWatcher } from "@/components/version-watcher";
import { ViewAsOverlay } from "@/components/dev/view-as-overlay";
import { UpdatesPopup } from "@/components/onboarding/updates-popup";
import { LiveBroadcastReceiver } from "@/components/dev/live-broadcast-receiver";
import { hasPermission, isPathAllowed } from "@/lib/permissions";
import { usePathname } from "next/navigation";
import { Logo } from "@/components/logo";
import { Spinner } from "@/components/ui/spinner";
import { useEnterAsTab } from "@/lib/use-enter-as-tab";
import { useScrollRestoration } from "@/lib/use-scroll-restoration";
import { PermissionsProvider, usePermissions } from "@/lib/use-permissions";
import { StempelProvider, useStempel } from "@/lib/use-stempel";
import { registriereSyncTrigger } from "@/lib/offline/sync-trigger";
import { sendeAlleRapporte } from "@/lib/offline/rapport-outbox";
import { PresenceProvider } from "@/lib/use-online-presence";
import { NavCountsProvider } from "@/lib/use-nav-counts";
import { MeinKontoOnboardingProvider } from "@/lib/use-mein-konto-onboarding";
import { MeinKontoIntroModal } from "@/components/onboarding/mein-konto-intro-modal";
import { CommandPalette, CMDK_OPEN_EVENT } from "@/components/shell/command-palette";
import { BreadcrumbsProvider, Breadcrumbs } from "@/components/shell/breadcrumbs";
import { readImpersonationCookie } from "@/lib/impersonation";
import { portalForRole } from "@/lib/portals";
import { readMeCache, clearMeCache, type MeCache } from "@/lib/me-cache";

// /api/me Boot-Cache: liegt in src/lib/me-cache.ts (localStorage). Der
// PermissionsProvider schreibt ihn nach jeder Server-Antwort und nutzt ihn
// offline als Fallback; das Layout bootet daraus nur die Shell (Sidebar +
// Skeleton), bis ready=true. Geraeumt bei Logout/401 (handleSignOut,
// Heartbeat-403, Inaktivitaets-Logout, Redirect-zu-Login).

// Outer-Wrapper — nur Provider. Der Inner-Layout kann den Provider
// dann via Hook konsumieren statt eigenem Self-Load.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <PermissionsProvider>
      <StempelProvider>
        <PresenceProvider>
          <AppLayoutInner>{children}</AppLayoutInner>
        </PresenceProvider>
      </StempelProvider>
    </PermissionsProvider>
  );
}

function AppLayoutInner({ children }: { children: React.ReactNode }) {
  const { profile, permissions, ready, loadError, meId } = usePermissions();
  // Handy-Sheets der Bottom-Nav: «Mehr» (Navigation) und «Stempeln».
  const [mehrOpen, setMehrOpen] = useState(false);
  const [stempelOpen, setStempelOpen] = useState(false);
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const supabase = createClient();
  // Wartende Offline-Aktionen (Stempeln): `ausstehend` (alle Stati) warnt im
  // Mehr-Sheet vor dem Abmelden; `nachsendbar` (wartet/sendet/fehler) pausiert
  // den Inaktivitaets-Logout — Konflikt/abgelehnt gehen nie von selbst raus.
  const { ausstehend, nachsendbar } = useStempel();
  // Rapport-Entwuerfe, die noch raus muessen (rapport-outbox), pausieren den
  // Inaktivitaets-Logout genauso — Konflikt/Fehler brauchen den Nutzer.
  const rapporte = useWartendeRapporte(meId, true);
  const rapporteNachsendbar = rapporte.filter((r) => r.status === "wartet" || r.status === "sendet").length;
  const wartend = nachsendbar + rapporteNachsendbar;

  // Boot-Cache einmalig beim Mount lesen. Bewusst NICHT als Lazy-Init im
  // useState: das SSR-HTML ist der Spinner (ready=false), ein Cache-Read
  // im ersten Client-Render wuerde am Layout-Root einen Hydration-Mismatch
  // erzeugen. Stattdessen useLayoutEffect — laeuft nach der Hydration aber
  // VOR dem ersten Browser-Paint, der User sieht also direkt die Cache-
  // Shell statt eines Spinner-Flashs. Danach stabil bis ready=true.
  const [bootCache, setBootCache] = useState<MeCache | null>(null);
  useLayoutEffect(() => {
    setBootCache(readMeCache());
  }, []);

  // Wenn kein User → Login. Re-direct erst wenn ready damit kein Flicker.
  useEffect(() => {
    if (ready && !profile && !loadError) {
      clearMeCache();
      router.push("/login");
    }
  }, [ready, profile, loadError, router]);

  // Globale Regel: Enter im Input/Select springt zum nächsten Feld, statt zu submitten.
  useEnterAsTab();

  // Cmd-K / Ctrl-K globaler Shortcut fuer die Command-Palette. Trigger-
  // Button in der Sidebar feuert dasselbe CMDK_OPEN_EVENT.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isCmdK = (e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K");
      if (isCmdK) {
        e.preventDefault();
        setCmdkOpen(true);
      }
    };
    const onOpen = () => setCmdkOpen(true);
    // Stempel-Sheet von Seiten aus oeffnen (Handy: Einsatz-Karte auf dem
    // Dashboard, Auftrag-Detail).
    const onStempel = () => setStempelOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(CMDK_OPEN_EVENT, onOpen);
    window.addEventListener(STEMPEL_OPEN_EVENT, onStempel);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(CMDK_OPEN_EVENT, onOpen);
      window.removeEventListener(STEMPEL_OPEN_EVENT, onStempel);
    };
  }, []);

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
        .on("postgres_changes", { event: "*", schema: "public", table: "todos" }, dispatch("todos"))
        .on("postgres_changes", { event: "*", schema: "public", table: "service_reports" }, dispatch("service_reports"))
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
  // Portal-Rollen (Partner/Lieferant/…) gehoeren ueberhaupt nicht in (app)
  // — direkt auf die Startseite ihres Portals umleiten (Registry).
  useEffect(() => {
    if (!profile) return;
    const portal = portalForRole(profile.role);
    if (portal) {
      router.replace(portal.homePath);
      return;
    }
    if (!isPathAllowed(pathname, permissions, profile.role)) {
      router.replace("/dashboard");
    }
  }, [pathname, profile, permissions, router]);

  // Passkey-Enrollment-Gate wurde entfernt (Leo 2026-09-08): kein Zwangs-
  // Redirect mehr fuer User ohne Passkey. Biometrisches Einloggen wird
  // freiwillig unter Mein Konto → Sicherheit aktiviert (PasskeysCard);
  // die Mitarbeiter erfahren es ueber das Info-Sheet.

  async function handleSignOut() {
    // Boot-Cache raus bevor die Session endet — sonst wuerde der naechste
    // Login im selben Tab kurz mit der alten Identitaet booten.
    clearMeCache();
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

  // Abmelden vom Handy-Konto (mein-konto-mobil feuert ABMELDEN_EVENT): der
  // Listener haengt einmal, ruft aber immer die aktuelle handleSignOut-
  // Closure (Ref wird nach jedem Render nachgefuehrt — kein stale closure).
  const signOutRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    signOutRef.current = handleSignOut;
  });
  useEffect(() => {
    const onAbmelden = () => { void signOutRef.current(); };
    window.addEventListener(ABMELDEN_EVENT, onAbmelden);
    return () => window.removeEventListener(ABMELDEN_EVENT, onAbmelden);
  }, []);

  // Rapport-Entwuerfe nachsenden (write-ahead in IndexedDB, rapport-outbox):
  // dasselbe Trigger-Muster wie das Stempeln im StempelProvider — App-Start,
  // online, Tab sichtbar, Realtime wieder da. Nicht unter «Ansicht als», sonst
  // wuerde der Admin mit seiner Sitzung fremde Entwuerfe senden. Doppel-Laeufe
  // faengt sendeAlleRapporte selbst ab.
  const meName = profile?.full_name ?? "Ich";
  useEffect(() => {
    if (!meId) return;
    return registriereSyncTrigger(() => {
      if (readImpersonationCookie()) return;
      void sendeAlleRapporte(supabase, meId, meName);
    });
  }, [supabase, meId, meName]);

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
          clearMeCache();
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
  // nicht alle 30 min ausloggen. Pausiert, solange Stempel-Aktionen oder
  // Rapport-Entwuerfe noch nachsendbar sind (ein Logout wuerde das Nachsenden
  // bis zum naechsten Login verzoegern) — aber hoechstens 2 h ab Pausenbeginn: danach laeuft
  // der 30-min-Timer trotzdem, damit am geteilten Buero-PC keine Sitzung
  // dauerhaft offen bleibt. Die Aktionen liegen je Nutzer in IndexedDB und
  // gehen nach dem naechsten Login raus.
  const pauseSeit = useRef<number | null>(null);
  useEffect(() => {
    if (!profile || profile.role === "admin") return;
    const TIMEOUT_MS = 30 * 60 * 1000;
    const PAUSE_MAX_MS = 2 * 60 * 60 * 1000;
    if (wartend > 0) pauseSeit.current ??= Date.now();
    else pauseSeit.current = null;
    const pauseEnde = pauseSeit.current === null ? null : pauseSeit.current + PAUSE_MAX_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const expire = async () => {
      try {
        await fetch("/api/sessions/end", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: "inactive" }),
        });
      } catch { /* best-effort */ }
      clearMeCache();
      await supabase.auth.signOut();
      router.push("/login?reason=inactive");
      router.refresh();
    };

    const reset = () => {
      if (timer) clearTimeout(timer);
      // Waehrend der Pause: Rest der Pause + 30 min. Nach Pausenende zaehlt
      // nur noch die Inaktivitaet.
      const rest = pauseEnde === null ? 0 : Math.max(0, pauseEnde - Date.now());
      timer = setTimeout(expire, rest + TIMEOUT_MS);
    };
    reset();

    const events: Array<keyof DocumentEventMap> = ["mousedown", "keydown", "scroll", "touchstart"];
    for (const e of events) document.addEventListener(e, reset, { passive: true });
    return () => {
      if (timer) clearTimeout(timer);
      for (const e of events) document.removeEventListener(e, reset);
    };
  }, [profile, supabase, router, wartend]);

  // Shell-Werte: Live sobald ready, sonst Boot-Cache (falls vorhanden).
  // Waehrend des Cache-Boots kriegen Sub-Komponenten die via Props versorgt
  // werden (Sidebar, MobileNav, NavCounts) sofort sinnvolle Werte; alles
  // was usePermissions() direkt konsumiert wartet weiterhin auf ready.
  const shellProfile = ready ? profile : bootCache?.profile ?? null;
  const shellPermissions = ready ? permissions : bootCache?.permissions ?? [];

  if (loadError || (ready && !profile)) {
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

  // Kein Live-Profil UND kein Boot-Cache → wie bisher der Vollbild-Spinner
  // (erster Login dieses Tabs, oder Cache bewusst uebersprungen).
  if (!shellProfile) {
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

  // Ticket-Badge-Quelle permission-basiert (W5): tickets:manage statt
  // role==='admin' — Admin passt via hasPermission immer durch, Custom-
  // Rollen mit Ticket-Verantwortung sehen dieselbe Queue.
  const canManageTickets = hasPermission(shellPermissions, shellProfile.role, "tickets:manage");

  return (
    <NavCountsProvider isAdmin={shellProfile.role === "admin"} canManageTickets={canManageTickets}>
    <MeinKontoOnboardingProvider profileReady={!!shellProfile}>
    <BreadcrumbsProvider>
    {/* Benachrichtigungs-Kern GENAU EINMAL (Daten, Realtime, Poll, Drawer,
        Popups). Die Glocken in Sidebar (Desktop) und mobilem Kopf (Handy)
        sind nur Trigger — sonst liefe am Handy alles doppelt. */}
    <NotificationsProvider variante="app">
    <div className="flex min-h-screen bg-[#f5f5f7] dark:bg-[#0a0a0a]">
      <Sidebar
        profile={shellProfile}
        permissions={shellPermissions}
        onSignOut={handleSignOut}
      />

      {/* Margin-left = Sidebar-Breite (240px) ab md-Breakpoint.
          Handy: Polster unten = Bottom-Nav (--nav-h) + Safe-Area + Luft. */}
      <div
        id="app-scroll"
        // overflow-x-CLIP statt -hidden: hidden macht dieses Div zum
        // Scroll-Container und bricht damit position:sticky aller
        // Kind-Elemente (StickyFilterBar); clip schneidet horizontal
        // genauso ab, erzeugt aber keinen Scroll-Kontext.
        className="flex-1 flex flex-col pb-[calc(var(--nav-h,64px)+env(safe-area-inset-bottom)+16px)] md:pb-0 min-w-0 overflow-x-clip md:ml-[240px]"
      >
        {/* Mobiler Kopf (nur < md): Zurueck/Titel + Glocke + Buero-Hinweis.
            Traegt die Safe-Area oben, darum braucht main sie nicht mehr. */}
        <MobileKopf pathname={pathname} />
        {/* Offline-/Uebertragungs-Streifen (nur Handy): «Ohne Netz · n Aktionen
            warten» → Uebertragungen-Sheet. Null, wenn online und nichts wartet. */}
        <OfflineStreifen />
        <Breadcrumbs />
        <main
          className="flex-1 p-4 md:px-10 md:py-8 md:pt-10 max-w-[1280px] w-full mx-auto min-w-0"
          style={{ ["--shell-py" as string]: "2.5rem" }}
        >{children}</main>
      </div>

      <MobileNav
        permissions={shellPermissions}
        role={shellProfile.role}
        mehrOpen={mehrOpen}
        stempelOpen={stempelOpen}
        onMehrOpen={() => setMehrOpen(true)}
        onStempelOpen={() => setStempelOpen(true)}
      />
      {/* Developer-Mode / View-As Overlay — nur sichtbar wenn der aktive
          User Admin ist und developer_mode_enabled=true in profiles. */}
      <ViewAsOverlay />
      {/* "Neue Funktionen"-Popup beim Login (Nicht-Admins) — zeigt neue
          Eintraege aus src/lib/app-updates.ts + Link zu /anleitung. */}
      <UpdatesPopup />
      {/* Live-Broadcast Receiver — lauscht global auf live:<own_user_id>
          und blendet Overlay + Admin-Cursor ein sobald ein Admin eine
          Live-Session zu diesem User startet. */}
      <LiveBroadcastReceiver userId={shellProfile.id} />

      {/* Handy-Sheets der Bottom-Nav (Bottom-Sheets, nur < md relevant). */}
      <MehrSheet
        open={mehrOpen}
        onClose={() => setMehrOpen(false)}
        permissions={shellPermissions}
        role={shellProfile.role}
        canManageTickets={canManageTickets}
        onSignOut={handleSignOut}
        ausstehend={ausstehend + rapporte.length}
      />
      <StempelNavSheet open={stempelOpen} onClose={() => setStempelOpen(false)} />
      {/* Einmaliger «EVENTLINE als App»-Hinweis (nur Handy im Browser). */}
      <AppInstallHinweis />

      <MeinKontoIntroModal />
      <CommandPalette open={cmdkOpen} onClose={() => setCmdkOpen(false)} />
      {/* sonner nutzt unter 600 px nur mobileOffset (offset greift dort
          nicht): Toast unter den mobilen Kopf (52 px + Safe-Area). Nur hier,
          damit die Portale ihren sonner-Standard behalten. */}
      <Toaster mobileOffset={{ top: "calc(env(safe-area-inset-top) + 60px)", left: "12px", right: "12px" }} />
      <VersionWatcher />
    </div>
    </NotificationsProvider>
    </BreadcrumbsProvider>
    </MeinKontoOnboardingProvider>
    </NavCountsProvider>
  );
}
