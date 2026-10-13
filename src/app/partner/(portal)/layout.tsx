"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Logo } from "@/components/logo";
import { Spinner } from "@/components/ui/spinner";
import { Toaster } from "@/components/ui/sonner";
import { TabsNav } from "@/components/ui/tabs-nav";
import { useTheme } from "next-themes";
import { useEnterAsTab } from "@/lib/use-enter-as-tab";
import { useScrollRestoration } from "@/lib/use-scroll-restoration";
import { Sun, Moon, LogOut } from "lucide-react";
import { DatenschutzAcceptModal } from "@/components/datenschutz-accept-modal";
import { NotificationsBell, NotificationsProvider } from "@/components/layout/notifications-bell";
import { PARTNER_BEREICHE, PartnerMobilKopf, PartnerMobilLeiste, aktiverPartnerBereich } from "@/components/partner/partner-mobil-nav";
import { portalNotificationTypes } from "@/lib/notification-meta";
import { PortalRealtime } from "@/components/portal/portal-realtime";
import { DATENSCHUTZ_VERSION } from "@/lib/datenschutz";
import { ViewAsOverlay } from "@/components/dev/view-as-overlay";
import { LiveBroadcastReceiver } from "@/components/dev/live-broadcast-receiver";
import { PresenceProvider } from "@/lib/use-online-presence";
import { readImpersonationCookie } from "@/lib/impersonation";

// Partner-Portal-Layout: minimal Topbar, KEINE Sidebar, KEINE Eve.
// Auth-Guard: nur eingeloggte 'partner'-Profile mit partner_location_id
// duerfen rein. Andere werden auf /partner/login oder /dashboard
// (Eventline-User) umgeleitet.

interface PartnerProfile {
  id: string;
  full_name: string;
  role: string;
  partner_location_id: string | null;
  is_active: boolean;
  location_name: string | null;
  datenschutz_akzeptiert_at: string | null;
  datenschutz_akzeptiert_version: string | null;
}

export default function PartnerPortalLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const supabase = createClient();
  const { theme, setTheme } = useTheme();
  const [profile, setProfile] = useState<PartnerProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEnterAsTab();
  useScrollRestoration();

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        router.replace("/partner/login");
        return;
      }
      // Developer-Mode / View-As: wenn der eingeloggte User ein Admin ist
      // der gerade einen Partner impersoniert, liefert das Cookie die
      // target-user-id. Der Layout laedt dann das PARTNER-Profile statt
      // das echte Admin-Profile — sonst wuerde die role-Pruefung unten
      // den Admin rauswerfen (→ (app)-Layout sieht effective='partner' via
      // usePermissions → wieder hierher → LOOP).
      const impersonateId = readImpersonationCookie();
      const profileId = impersonateId || user.id;
      const { data } = await supabase
        .from("profiles")
        .select("id, full_name, role, partner_location_id, is_active, datenschutz_akzeptiert_at, datenschutz_akzeptiert_version, location:locations!profiles_partner_location_id_fkey(name)")
        .eq("id", profileId)
        .maybeSingle();
      if (!data) {
        // Bei aktiver Impersonation KEIN signOut() — sonst kickt sich der
        // Admin unabsichtlich raus. Stattdessen zurueck zum Firmen-Dashboard,
        // dort kann er die Impersonation via Overlay beenden.
        if (impersonateId) {
          router.replace("/dashboard");
          return;
        }
        // Konto-Sperren (kein Profil, deaktiviert, keine Location) melden
        // bewusst global ab — auf allen Geraeten gleich unbrauchbar. Nur der
        // Abmelde-Knopf (handleSignOut) meldet bloss dieses Geraet ab.
        await supabase.auth.signOut({ scope: "global" });
        router.replace("/partner/login");
        return;
      }
      if (data.role !== "partner") {
        // Ohne Impersonation: Eventline-User falsch abgebogen → Haupt-App.
        // Mit Impersonation (Admin sieht als jemand): der impersonierte User
        // ist kein Partner → Impersonation aufloesen und ins Firmen-Portal.
        router.replace("/dashboard");
        return;
      }
      if (!data.is_active) {
        await supabase.auth.signOut({ scope: "global" });
        router.replace("/partner/login?reason=deactivated");
        return;
      }
      if (!data.partner_location_id) {
        // Partner ohne zugewiesene Location — kann nichts tun, Hinweis
        await supabase.auth.signOut({ scope: "global" });
        router.replace("/partner/login?reason=nolocation");
        return;
      }
      const loc = Array.isArray(data.location) ? data.location[0] : data.location;
      setProfile({
        id: data.id,
        full_name: data.full_name,
        role: data.role,
        partner_location_id: data.partner_location_id,
        is_active: data.is_active,
        location_name: loc?.name ?? null,
        datenschutz_akzeptiert_at: data.datenschutz_akzeptiert_at ?? null,
        datenschutz_akzeptiert_version: data.datenschutz_akzeptiert_version ?? null,
      });
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSignOut() {
    // Nur dieses Geraet abmelden: ohne scope beendet supabase-js ALLE
    // Sitzungen des Nutzers (Handy + Laptop).
    await supabase.auth.signOut({ scope: "local" });
    router.push("/partner/login");
    router.refresh();
  }

  if (loading || !profile) {
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

  // Desktop-Tabs und Handy-Leiste teilen sich Bereiche und Aktiv-Logik
  // (src/components/partner/partner-mobil-nav.tsx).
  const tabs = PARTNER_BEREICHE.map(({ href, label, icon: Icon }) => ({
    key: href, href, label, icon: <Icon className="h-4 w-4" />,
  }));
  const activeTab = aktiverPartnerBereich(pathname);

  // Akzeptanz noch ausstehend → Modal zwingend. User kann das Portal
  // erst nutzen wenn er aktuelle Version bestaetigt hat. Re-Akzeptanz
  // greift bei neuen Versionen der Erklaerung.
  const needsAccept = !profile.datenschutz_akzeptiert_at
    || profile.datenschutz_akzeptiert_version !== DATENSCHUTZ_VERSION;

  return (
    // h-screen + overflow-hidden am Wrapper, main scrollt intern.
    // Damit bleibt der Header garantiert fix oben — sticky greift in
    // manchen Layout-Kombinationen unzuverlaessig, fixed-Height +
    // internal-scroll ist robuster.
    // Handy (< md, seit 2026-10): h-dvh statt h-screen — 100vh zaehlt auf
    // iOS die Adressleiste mit, die untere Leiste laege sonst dahinter.
    // Geruest: mobiler Kopf | main | untere Leiste (alle im Fluss, nichts
    // fixed); Desktop-Kopf mit Tabs ist am Handy ausgeblendet.
    // data-partner-portal: Handy-Regeln fuer Felder/Kasten in globals.css.
    <PresenceProvider>
    {/* Benachrichtigungs-Kern GENAU EINMAL (Daten, Realtime, Poll, Drawer,
        Popups). Die Glocken im Desktop-Kopf und im mobilen Kopf sind nur
        Trigger — sonst liefe alles doppelt. */}
    <NotificationsProvider einstellungenHref="/partner/konto" typen={portalNotificationTypes("partner")} handy>
    <div data-partner-portal="" className="h-screen max-md:h-dvh overflow-hidden flex flex-col bg-[#f5f5f7] dark:bg-[#0a0a0a]">
      <PartnerMobilKopf pathname={pathname} />
      <header className="border-b bg-card shrink-0 z-30 max-md:hidden">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-4 min-w-0">
            <Logo size="md" />
            <div className="hidden sm:block min-w-0">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Partner</p>
              <p className="text-sm font-semibold truncate">{profile.location_name ?? "Unbekannt"}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <NotificationsBell />
            <button
              type="button"
              onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              className="p-2 rounded-lg hover:bg-foreground/5 dark:hover:bg-foreground/10 transition-colors"
              aria-label="Theme wechseln"
              data-tooltip="Theme wechseln"
              data-tooltip-side="bottom"
            >
              {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={handleSignOut}
              className="p-2 rounded-lg hover:bg-foreground/5 dark:hover:bg-foreground/10 transition-colors"
              aria-label="Abmelden"
              data-tooltip="Abmelden"
              data-tooltip-side="bottom"
            >
              <LogOut className="h-4 w-4" />
            </button>
          </div>
        </div>
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <TabsNav
            tabs={tabs}
            active={activeTab}
            ariaLabel="Partner-Portal-Navigation"
          />
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        {/* py-6 oben bleibt: StickyFilterBar offset="portal" rechnet mit
            -mt-6. Unten am Handy nur pb-6 — die Leiste liegt ausserhalb. */}
        <div className="max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 pb-24 max-md:pb-6">
          {children}
        </div>
      </main>

      <PartnerMobilLeiste pathname={pathname} />

      {needsAccept && (
        <DatenschutzAcceptModal
          onAccepted={async () => {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) return;
            const { data: refreshed } = await supabase
              .from("profiles")
              .select("datenschutz_akzeptiert_at, datenschutz_akzeptiert_version")
              .eq("id", user.id)
              .maybeSingle();
            setProfile((p) => p ? {
              ...p,
              datenschutz_akzeptiert_at: refreshed?.datenschutz_akzeptiert_at ?? p.datenschutz_akzeptiert_at,
              datenschutz_akzeptiert_version: refreshed?.datenschutz_akzeptiert_version ?? p.datenschutz_akzeptiert_version,
            } : p);
          }}
          onCancel={handleSignOut}
        />
      )}

      {/* Eigene notifications live in die Bell (Event-kompatibel zur
          Haupt-App); Ausfall -> Polling-Fallback der Bell. */}
      <PortalRealtime />
      {/* Toast unter den mobilen Kopf (40 px + 8 px Luft + Safe-Area): sonner nutzt unter
          600 px nur mobileOffset (wie in der (app)-Shell), von 600 bis 767 px
          offset.top. Ab md steht der Toast unten rechts — top greift dort
          nicht, die uebrigen Seiten behalten den sonner-Standard. */}
      <Toaster
        offset={{ top: "calc(env(safe-area-inset-top) + 48px)" }}
        mobileOffset={{ top: "calc(env(safe-area-inset-top) + 48px)", left: "12px", right: "12px" }}
      />
      {/* Developer-Mode View-As Overlay — auch im Partner-Portal, damit ein
          impersonierender Admin hier wieder rauskommt oder zwischen Partnern
          wechseln kann. Self-renders null wenn kein Admin / kein DevMode. */}
      <ViewAsOverlay />
      {/* Live-Broadcast Receiver — Partner sieht Admins Cursor + Overlay
          wenn Admin gerade eine Live-Session zu diesem Partner faehrt. */}
      <LiveBroadcastReceiver userId={profile?.id ?? null} />
    </div>
    </NotificationsProvider>
    </PresenceProvider>
  );
}
