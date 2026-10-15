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
import { Sun, Moon, LogOut, User, BookOpen, ClipboardCheck, Lightbulb } from "lucide-react";
import { NotificationsBell } from "@/components/layout/notifications-bell";
import { portalNotificationTypes } from "@/lib/notification-meta";
import { PortalRealtime } from "@/components/portal/portal-realtime";
import { DatenschutzAcceptModal } from "@/components/datenschutz-accept-modal";
import { DATENSCHUTZ_VERSION } from "@/lib/datenschutz";
import { ViewAsOverlay } from "@/components/dev/view-as-overlay";
import { LiveBroadcastReceiver } from "@/components/dev/live-broadcast-receiver";
import { PresenceProvider } from "@/lib/use-online-presence";
import { readImpersonationCookie, IMPERSONATE_COOKIE } from "@/lib/impersonation";
import { useIsMobile } from "@/lib/use-is-mobile";
import { NurComputerHinweis } from "@/components/lieferant/nur-computer-hinweis";

// Lieferanten-Portal-Layout: Spiegel des Partner-Portal-Layouts.
// Minimal Topbar, KEINE Sidebar, KEINE Eve.
// Am Handy (< 768 px) zeigt das Portal nur den Hinweis «Bitte am Computer
// öffnen» + Abmelden — reine CSS-Weiche (md:hidden / hidden md:flex), damit
// die Desktop-Ansicht unveraendert bleibt und beim Verkleinern des Fensters
// nichts neu geladen wird (Eingaben bleiben erhalten). Glocke und
// Datenschutz-Modal rendern per Portal am body und sind darum zusaetzlich
// per useIsMobile am Handy weggeschaltet.
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
  datenschutz_akzeptiert_at: string | null;
  datenschutz_akzeptiert_version: string | null;
}

export default function LieferantPortalLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const supabase = createClient();
  const { theme, setTheme } = useTheme();
  const [profile, setProfile] = useState<LieferantProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const isMobile = useIsMobile();

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
      let impersonateId = readImpersonationCookie();
      const ladeProfil = (profilId: string) =>
        supabase
          .from("profiles")
          .select("id, full_name, role, lieferant_id, is_active, datenschutz_akzeptiert_at, datenschutz_akzeptiert_version")
          .eq("id", profilId)
          .maybeSingle();
      let { data } = await ladeProfil(impersonateId || user.id);
      if (!data && impersonateId && impersonateId !== user.id) {
        // Veraltetes View-As-Cookie aus einer frueheren Admin-Sitzung im
        // selben Browser: fremde Profile sind fuer Portal-Konten gesperrt
        // (Migration 329b) -> eigenes Profil, Cookie verwerfen (sonst
        // Schleife /dashboard <-> Portal).
        const eigen = await ladeProfil(user.id);
        if (eigen.data?.role === "lieferant") {
          document.cookie = `${IMPERSONATE_COOKIE}=; Max-Age=0; path=/`;
          impersonateId = null;
          data = eigen.data;
        }
      }
      if (!data) {
        // Bei aktiver Impersonation KEIN signOut() — sonst kickt sich der
        // Admin unabsichtlich raus. Stattdessen zurueck zum Firmen-Dashboard,
        // dort kann er die Impersonation via Overlay beenden.
        if (impersonateId) {
          router.replace("/dashboard");
          return;
        }
        // Konto-Sperren (kein Profil, deaktiviert, keine Firma) melden bewusst
        // global ab — auf allen Geraeten gleich unbrauchbar. Nur die Abmelde-
        // Knoepfe (handleSignOut*) melden bloss dieses Geraet ab.
        await supabase.auth.signOut({ scope: "global" });
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
        await supabase.auth.signOut({ scope: "global" });
        router.replace("/lieferant/login?reason=deactivated");
        return;
      }
      if (!data.lieferant_id) {
        // Lieferant ohne zugewiesene Firma — kann nichts tun, Hinweis
        await supabase.auth.signOut({ scope: "global" });
        router.replace("/lieferant/login?reason=nofirma");
        return;
      }
      // Firmenname per RPC: die Lieferanten-Zeile selbst (interne Notizen)
      // ist fuer Portal-Konten gesperrt (Migration 329b).
      const { data: firmaRows } = await supabase.rpc("lieferant_firma", { p_profil: data.id });
      const firma = ((firmaRows as { id: string; name: string }[] | null) ?? [])[0] ?? null;
      setProfile({
        id: data.id,
        full_name: data.full_name,
        role: data.role,
        lieferant_id: data.lieferant_id,
        is_active: data.is_active,
        firma_name: firma?.name ?? null,
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
    router.push("/lieferant/login");
    router.refresh();
  }

  // Abmelden aus dem Handy-Hinweis: wie handleSignOut, aber ein Fehler von
  // signOut() (z. B. ohne Netz — die Sitzung besteht dann weiter) wird
  // geworfen, damit der Hinweis ihn anzeigt (Muster: Partner-Konto-Seite).
  // Eigene Funktion, damit das Desktop-Abmelden unveraendert bleibt.
  async function handleSignOutHinweis() {
    const { error } = await supabase.auth.signOut({ scope: "local" });
    if (error) throw error;
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
    { key: "/lieferant/anfragen", href: "/lieferant/anfragen", label: "Anfragen", icon: <ClipboardCheck className="h-4 w-4" /> },
    { key: "/lieferant/katalog", href: "/lieferant/katalog", label: "Katalog", icon: <BookOpen className="h-4 w-4" /> },
    { key: "/lieferant/wissen", href: "/lieferant/wissen", label: "Mein Wissen", icon: <Lightbulb className="h-4 w-4" /> },
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
    {/* Handy: Hinweis statt Portal. Die Desktop-Ansicht bleibt gemountet
        (nur ausgeblendet) — ihr Toaster zeigt am Handy darum auch keine
        Meldungen der unsichtbaren Seiten. */}
    <div className="md:hidden">
      <NurComputerHinweis onAbmelden={handleSignOutHinweis} />
    </div>
    <div className="hidden md:flex h-screen overflow-hidden flex-col bg-[#f5f5f7] dark:bg-[#0a0a0a]">
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
            {/* Glocke nur bei sicher erkanntem Desktop (isMobile === false):
                sie startet ihren eigenen Provider und oeffnet Popups per
                Portal am body — am Handy laegen die ueber dem Hinweis.
                Bei null (Breite noch unbekannt) wartet sie einen Render ab,
                statt kurz zu mounten; am Desktop ist der Wert ohnehin
                bekannt, bevor das Profil geladen ist und der Kopf rendert. */}
            {isMobile === false && (
              <NotificationsBell einstellungenHref="/lieferant/konto" typen={portalNotificationTypes("lieferant")} />
            )}
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

      {/* Pflicht-Akzeptanz der Datenschutzerklaerung — wie im Partnerportal,
          mit lieferanten-spezifischen Texten. Nicht am Handy: das Modal
          rendert per Portal und laege sonst ueber dem Hinweis — gefragt
          wird beim naechsten Oeffnen am Computer. */}
      {isMobile !== true && profile && (!profile.datenschutz_akzeptiert_at || profile.datenschutz_akzeptiert_version !== DATENSCHUTZ_VERSION) && (
        <DatenschutzAcceptModal
          portalName="Lieferantenportal"
          speicherPunkte={[
            "Deinen Namen + E-Mail (Login)",
            "Deine Firma (Lieferant)",
            "Technik-Anfragen, Rückmeldungen, Kommentare, hochgeladene Angebote",
            "Anmelde-Logs (Sicherheit)",
          ]}
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

      <Toaster />
      {/* Live-Broadcast Receiver — Lieferant sieht Admins Cursor + Overlay
          wenn Admin gerade eine Live-Session zu diesem User faehrt. */}
      <LiveBroadcastReceiver userId={profile?.id ?? null} />
    </div>
    {/* Developer-Mode View-As Overlay — auch im Lieferanten-Portal, damit
        ein impersonierender Admin hier wieder rauskommt oder zwischen Usern
        wechseln kann. Self-renders null wenn kein Admin / kein DevMode.
        Ausserhalb der Desktop-Ansicht, damit es auch am Handy (Hinweis)
        sichtbar bleibt; es positioniert sich fixed, am Desktop also gleich. */}
    <ViewAsOverlay />
    </PresenceProvider>
  );
}
