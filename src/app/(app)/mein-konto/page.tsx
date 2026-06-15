"use client";

/**
 * Mein-Konto-Page — User-Self-Service fuer ALLE Rollen.
 *
 * Aufgeteilt nach Themen (Tabs):
 *  - Profil: Name/Email + Daten-Export (DSG/DSGVO)
 *  - Benachrichtigungen: Channel-Matrix + Push + Sound + Quiet Hours
 *  - Dokumente: eigene Lohnabrechnungen + Lohnausweise zum Download
 *  - Kalender: iCal-Feed-Token fuer externen Kalender-Import
 *
 * Vertraute-Geraete-Verwaltung liegt unter Einstellungen -> Integrationen
 * (Admin-Sicht, sieht alle User-Geraete). Mitarbeiter brauchen das nicht
 * pro-User -- Erst-Trust passiert automatisch via TrustedDeviceGate auf
 * sensiblen Seiten.
 *
 * Verfuegbarkeit: ALLE authenticated User (kein Permission-Gate).
 */

import { useState, useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { User, Bell, FileText, Calendar } from "lucide-react";
import { cn } from "@/lib/utils";
import { MeinKontoCard } from "@/components/einstellungen/mein-konto-card";
import { BenachrichtigungenTab } from "@/components/einstellungen/benachrichtigungen-tab";
import { LohnausweiseList } from "@/components/hr/lohnausweise-list";
import { IcalFeedBlock } from "@/components/kalender/ical-feed-block";

type Tab = "profil" | "benachrichtigungen" | "dokumente" | "kalender";
const ALL_TABS: Tab[] = ["profil", "benachrichtigungen", "dokumente", "kalender"];

export default function MeinKontoPage() {
  const searchParams = useSearchParams();
  const urlTab = searchParams.get("tab") as Tab | null;
  const [tab, setTab] = useState<Tab>(urlTab && ALL_TABS.includes(urlTab) ? urlTab : "profil");

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
    if (urlTab && ALL_TABS.includes(urlTab) && urlTab !== tab) setTab(urlTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlTab]);

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: "profil",             label: "Profil",            icon: <User className="h-4 w-4" /> },
    { key: "benachrichtigungen", label: "Benachrichtigungen", icon: <Bell className="h-4 w-4" /> },
    { key: "dokumente",          label: "Dokumente",         icon: <FileText className="h-4 w-4" /> },
    { key: "kalender",           label: "Kalender",          icon: <Calendar className="h-4 w-4" /> },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Mein Konto</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Persönliche Einstellungen — gilt nur für dich, nicht für die ganze Firma.
        </p>
      </div>

      <nav className="border-b flex gap-1 overflow-x-auto">
        {tabs.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => selectTab(t.key)}
              className={cn(
                "flex items-center gap-2 px-3 py-2.5 -mb-px text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
                active
                  ? "border-red-500 text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-foreground/20",
              )}
            >
              {t.icon}
              {t.label}
            </button>
          );
        })}
      </nav>

      {tab === "profil" && (
        <div className="max-w-3xl">
          <MeinKontoCard />
        </div>
      )}

      {tab === "benachrichtigungen" && <BenachrichtigungenTab />}

      {tab === "dokumente" && (
        <div className="max-w-3xl">
          <LohnausweiseList />
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
