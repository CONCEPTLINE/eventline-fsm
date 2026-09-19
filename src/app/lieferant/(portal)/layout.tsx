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
import { Sun, Moon, LogOut, User, BookOpen } from "lucide-react";
import { ViewAsOverlay } from "@/components/dev/view-as-overlay";
import { LiveBroadcastReceiver } from "@/components/dev/live-broadcast-receiver";
import { PresenceProvider } from "@/lib/use-online-presence";

// Lieferanten-Portal-Layout: Spiegel des Partner-Portal-Layouts.
// Minimal Topbar, KEINE Sidebar, KEINE Eve.
// Auth-Guard: nur eingeloggte 'lieferant'-Profile mit lieferant_id
// duerfen rein. Andere werden auf /lieferant/login oder /dashboard
// (Eventline-User) umgeleitet.
// Kein Datenschutz-Zwangsmodal — die DatenschutzAcceptModal-Komponente
// ist textlich partner-spezifisch ("Partnerportal", "Location"); folgt
// wenn eine rollen-neutrale Variante existiert.

interface LieferantProfile {
  id: string;
  full_name: string;
  role: string;
  lieferant_id: string | null;
  is_active: boolean;
  firma_name: string | null;
}

/** Liest einen non-httpOnly Cookie im Client. Wird fuer das View-As-Cookie
 *  gebraucht — der Lieferanten-Layout muss wissen ob eine Impersonation
 *  aktiv ist, um das richtige Profile zu laden. */
function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const parts = document.cookie.split(";").map((s) => s.trim());
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq === -1) continue;
    const k = p.slice(0, eq);
    if (k === name) return decodeURIComponent(p.slice(eq + 1));
  }
  return null;
}

export default function LieferantPortalLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const supabase = createClient();
  const { theme, setTheme } = useTheme();
  const [profile, setProfile] = useState<LieferantProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEnterAsTab();
  useScrollRestoration();

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        router.replace("/lieferant/login");
        return;
      }
      // Developer-Mode / View-As: wenn der eingeloggte User ein Admin ist
      // der gerade einen Lieferanten impersoniert, liefert das Cookie die
      // target-user-id. Der Layout laedt dann das LIEFERANTEN-Profile statt
      // das echte Admin-Profile — sonst wuerde die role-Pruefung unten
      // den Admin rauswerfen.
      const impersonateId = readCookie("eventline_impersonate_user_id");
      const profileId = impersonateId || user.id;
      const { data } = await supabase
        .from("profiles")
        .select("id, full_name, role, lieferant_id, is_active, firma:lieferanten!profiles_lieferant_id_fkey(name)")
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
        await supabase.auth.signOut();
        router.replace("/lieferant/login");
        return;
      }
      if (data.role !== "lieferant") {
        // Ohne Impersonation: Eventline-User falsch abgebogen → Haupt-App.
        // Mit Impersonation (Admin sieht als jemand): der impersonierte User
        // ist kein Lieferant → Impersonation aufloesen und ins Firmen-Portal.
        router.replace("/dashboard");
        return;
      }
      if (!data.is_active) {
        await supabase.auth.signOut();
        router.replace("/lieferant/login?reason=deactivated");
        return;
      }
      if (!data.lieferant_id) {
        // Lieferant ohne zugewiesene Firma — kann nichts tun, Hinweis
        await supabase.auth.signOut();
        router.replace("/lieferant/login?reason=nofirma");
        return;
      }
      const firma = Array.isArray(data.firma) ? data.firma[0] : data.firma;
      setProfile({
        id: data.id,
        full_name: data.full_name,
        role: data.role,
        lieferant_id: data.lieferant_id,
        is_active: data.is_active,
        firma_name: firma?.name ?? null,
      });
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/lieferant/login");
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

  const tabs = [
    { key: "/lieferant/katalog", href: "/lieferant/katalog", label: "Katalog", icon: <BookOpen className="h-4 w-4" /> },
    { key: "/lieferant/konto", href: "/lieferant/konto", label: "Mein Konto", icon: <User className="h-4 w-4" /> },
  ];

  // Aktiver Tab = laengster href-Prefix des pathname. Verhindert Fehl-Matches
  // bei kuenftigen Unterrouten.
  const activeTab =
    tabs.find((t) => pathname === t.href || pathname.startsWith(t.href + "/"))?.key
    ?? tabs[0].key;

  return (
    // h-screen + overflow-hidden am Wrapper, main scrollt intern.
    // Damit bleibt der Header garantiert fix oben — sticky greift in
    // manchen Layout-Kombinationen unzuverlaessig, fixed-Height +
    // internal-scroll ist robuster.
    <PresenceProvider>
    <div className="h-screen overflow-hidden flex flex-col bg-[#f5f5f7] dark:bg-[#0a0a0a]">
      <header className="border-b bg-card shrink-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-4 min-w-0">
            <Logo size="md" />
            <div className="hidden sm:block min-w-0">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Lieferant</p>
              <p className="text-sm font-semibold truncate">{profile.firma_name ?? "Unbekannt"}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
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
            ariaLabel="Lieferanten-Portal-Navigation"
          />
        </div>
      </header>

      <main className="flex-1 overflow-y-auto">
        <div className="max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 pb-24">
          {children}
        </div>
      </main>

      <Toaster />
      {/* Developer-Mode View-As Overlay — auch im Lieferanten-Portal, damit
          ein impersonierender Admin hier wieder rauskommt oder zwischen Usern
          wechseln kann. Self-renders null wenn kein Admin / kein DevMode. */}
      <ViewAsOverlay />
      {/* Live-Broadcast Receiver — Lieferant sieht Admins Cursor + Overlay
          wenn Admin gerade eine Live-Session zu diesem User faehrt. */}
      <LiveBroadcastReceiver userId={profile?.id ?? null} />
    </div>
    </PresenceProvider>
  );
}
