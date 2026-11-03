"use client";

/**
 * Mein Konto — der Startpunkt jeder Person (alle Rollen):
 *
 * Oben der Hub (KontoHub): Melden (Beleg, Krank, Abwesenheit, Stempel
 * korrigieren, Anderes), Meine Anfragen (die letzten drei), Stempelzeiten
 * mit den Stunden des Monats und Lohn mit «n neu».
 *
 * Darunter die Konto-Einstellungen als Tabs:
 *  - Profil: Name/Email + Daten-Export (DSG/DSGVO)
 *  - Sicherheit: Passkeys / Face ID
 *  - Benachrichtigungen: Channel-Matrix + Push + Sound + Quiet Hours
 *  - Kalender: iCal-Feed-Token fuer externen Kalender-Import
 *
 * Vertraute-Geraete-Verwaltung liegt unter Einstellungen › Sicherheit
 * (/einstellungen?tab=sicherheit; Admin-Sicht, sieht alle User-Geraete).
 * Mitarbeiter brauchen das nicht pro-User -- Erst-Trust passiert
 * automatisch via TrustedDeviceGate auf sensiblen Seiten.
 *
 * Eigene Lohn-PDFs (Lohnabrechnungen + Lohnausweise) leben unter
 * HR › Lohn (/lohn). Legacy-Link ?tab=dokumente wird auf /lohn umgeleitet.
 * Am Handy rendert die Seite mein-konto-mobil (Hub + Konto-Liste).
 *
 * Verfuegbarkeit: ALLE authenticated User (kein Permission-Gate).
 */

import { useState, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { User, Bell, Calendar, Fingerprint, MessageCircleQuestion } from "lucide-react";
import { useMeinKontoOnboarding } from "@/lib/use-mein-konto-onboarding";
import { MeinKontoCard } from "@/components/einstellungen/mein-konto-card";
import { BenachrichtigungenTab } from "@/components/einstellungen/benachrichtigungen-tab";
import { IcalFeedBlock } from "@/components/kalender/ical-feed-block";
import { PasskeysCard } from "@/components/einstellungen/passkeys-card";
import { MeineAntworten } from "@/components/fragen/meine-antworten";
import { TabsNav } from "@/components/ui/tabs-nav";
import { MeinKontoMobil } from "@/components/mobile/mein-konto-mobil";
import { useIsMobile } from "@/lib/use-is-mobile";
import { KontoHub } from "@/components/mein-konto/konto-hub";
import Loading from "./loading";

type Tab = "profil" | "sicherheit" | "benachrichtigungen" | "kalender" | "antworten";
const ALL_TABS: Tab[] = ["profil", "sicherheit", "benachrichtigungen", "kalender", "antworten"];

export default function MeinKontoPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlTab = searchParams.get("tab");
  // Legacy-Deep-Link ?tab=dokumente → nach /lohn umleiten
  // (die MA-Lohn-Sicht lebt jetzt dort). Redirect + Suppress-Render
  // (unten) verhindern das kurze Aufblitzen des Profil-Tabs waehrend
  // die Navigation laeuft.
  const isLegacyRedirect = urlTab === "dokumente";
  useEffect(() => {
    if (isLegacyRedirect) {
      router.replace("/lohn");
    }
  }, [isLegacyRedirect, router]);
  const initialTab: Tab = (urlTab && ALL_TABS.includes(urlTab as Tab)) ? (urlTab as Tab) : "profil";
  const { firstVisitedAt, ready: onboardingReady, markVisited } = useMeinKontoOnboarding();
  const [tab, setTab] = useState<Tab>(initialTab);
  // Handy (< md): Listen-Variante bzw. Tab-Inhalt ohne Tab-Leiste
  // (mein-konto-mobil). null (nur SSR/Hydration) → Skelett ohne Effekte.
  const isMobile = useIsMobile();

  // Sidebar-Badge ausschalten sobald die Seite das erste Mal geoeffnet
  // wird. Idempotent — API no-op-t wenn schon gesetzt.
  useEffect(() => {
    if (onboardingReady && !firstVisitedAt) void markVisited();
  }, [onboardingReady, firstVisitedAt, markVisited]);

  function selectTab(t: Tab) {
    setTab(t);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("tab", t);
      window.history.replaceState({}, "", url.toString());
    }
  }

  // Falls die URL einen Tab nennt der noch nicht im state ist (z.B. via
  // direktem Link aus der Glocke), nachziehen.
  useEffect(() => {
    if (urlTab && ALL_TABS.includes(urlTab as Tab) && urlTab !== tab) setTab(urlTab as Tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlTab]);

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: "profil",             label: "Profil",             icon: <User className="h-4 w-4" /> },
    { key: "sicherheit",         label: "Sicherheit",         icon: <Fingerprint className="h-4 w-4" /> },
    { key: "benachrichtigungen", label: "Benachrichtigungen", icon: <Bell className="h-4 w-4" /> },
    { key: "kalender",           label: "Kalender",           icon: <Calendar className="h-4 w-4" /> },
    { key: "antworten",          label: "Meine Antworten",    icon: <MessageCircleQuestion className="h-4 w-4" /> },
  ];

  // Waehrend der Legacy-Redirect laeuft (?tab=dokumente → /lohn)
  // NICHTS rendern — sonst blitzt der Profil-Tab kurz auf.
  if (isLegacyRedirect) return null;
  // Breite unbekannt: keinen der beiden Baeume mounten (Tab-Cards laden
  // selbst), sondern das Navigations-Skelett der Route.
  if (isMobile === null) return <Loading />;
  if (isMobile) return <MeinKontoMobil />;

  return (
    <div className="page-enter">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Mein Konto</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Melden, deine Anfragen, Stunden und Lohn — und deine persönlichen Einstellungen.
        </p>
      </div>

      <div className="mb-8">
        <KontoHub breit />
      </div>

      {/* Persoenliche Einstellungen: Titel wie die Kartentitel oben
          (font-heading), darunter die Tabs wie auf /einstellungen. */}
      <h2 className="mb-1 font-heading text-lg font-bold">Einstellungen</h2>
      <TabsNav
        tabs={tabs}
        active={tab}
        onChange={(k) => selectTab(k as Tab)}
        ariaLabel="Konto-Bereiche"
        className="mb-8"
      />

      {tab === "profil" && (
        <div className="max-w-3xl">
          <MeinKontoCard />
        </div>
      )}

      {tab === "sicherheit" && (
        <div className="max-w-3xl">
          <PasskeysCard />
        </div>
      )}

      {tab === "benachrichtigungen" && (
        <div className="max-w-3xl">
          <BenachrichtigungenTab />
        </div>
      )}

      {tab === "antworten" && (
        <div className="max-w-3xl mx-auto">
          <MeineAntworten />
        </div>
      )}

      {tab === "kalender" && (
        <div className="max-w-3xl">
          <IcalFeedBlock
            title="Mein iCal-Feed"
            description="Abonniere deinen persönlichen Kalender mit Aufträgen, Terminen und Schichten in Google Calendar / Apple Calendar / Outlook."
            source="user"
          />
        </div>
      )}

    </div>
  );
}
