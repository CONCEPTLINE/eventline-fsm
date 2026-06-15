"use client";

/**
 * HR-Hub — zwei Tabs:
 *   • Operativ — Karten fuer Stempelzeiten, Tickets, Ferien
 *   • Löhne    — Lohnausweise (eigene) + Monats-Stundenuebersicht
 *                fuer die Lohnabrechnung (admin-only, Trust-gated).
 *
 * Lohn-WERTE pro Mitarbeiter (Brutto-Stundenlohn, Arbeitgeber-Anteil)
 * werden NICHT mehr hier verwaltet — das laeuft seit dem Lohntabelle-
 * Removal direkt im User-Edit-Modal unter Einstellungen → Team. Dieser
 * Tab zeigt nur die aggregierte Auswertung pro Monat.
 */

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { TypePickerCard, type TypePickerTone } from "@/components/ui/type-picker-card";
import { Clock, Ticket, Plane, Briefcase, Wallet } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { usePermissions } from "@/lib/use-permissions";
import { cn } from "@/lib/utils";
import { LohndokumenteAdmin } from "@/components/hr/lohndokumente-admin";
import { MonatsstundenTable } from "@/components/hr/monatsstunden-table";
import { TrustedDeviceGate } from "@/components/trust/trusted-device-gate";

const TAB_BTN_CLASS = "flex items-center gap-2 px-3 py-2.5 -mb-px text-sm font-medium border-b-2 transition-colors";

type Tab = "operativ" | "loehne";

interface HRSection {
  href: string;
  label: string;
  description: string;
  icon: LucideIcon;
  tone: TypePickerTone;
}

const sections: HRSection[] = [
  { href: "/stempelzeiten", label: "Stempelzeiten", description: "Arbeitszeit-Erfassung pro Auftrag",        icon: Clock,  tone: "green" },
  { href: "/tickets",       label: "Tickets",       description: "IT, Stempel-Änderungen, Material",         icon: Ticket, tone: "red" },
  { href: "/ferien",        label: "Ferien",        description: "Ferien, Krankheit & Frei-Tage eintragen",  icon: Plane,  tone: "blue" },
];

export default function HRPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlTab = searchParams.get("tab") as Tab | null;
  const [tab, setTab] = useState<Tab>(urlTab === "loehne" ? "loehne" : "operativ");
  const { role } = usePermissions();
  // Lohnabrechnung ist strikt admin-only — auch User mit lohn:manage
  // Permission sollen die Querschnitts-Tabelle nicht sehen.
  const isAdmin = role === "admin";

  function selectTab(t: Tab) {
    setTab(t);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (t === "operativ") url.searchParams.delete("tab");
      else url.searchParams.set("tab", t);
      window.history.replaceState({}, "", url.toString());
    }
  }

  useEffect(() => {
    const next: Tab = urlTab === "loehne" ? "loehne" : "operativ";
    setTab(next);
  }, [urlTab]);

  const tabs: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: "operativ", label: "Operativ", icon: <Briefcase className="h-4 w-4" /> },
    { key: "loehne",   label: "Löhne",    icon: <Wallet className="h-4 w-4" /> },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">HR</h1>
        <p className="text-sm text-muted-foreground mt-1" aria-hidden="true">&nbsp;</p>
      </div>

      <nav className="border-b flex gap-1">
        {tabs.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => selectTab(t.key)}
              className={cn(
                TAB_BTN_CLASS,
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

      {tab === "operativ" && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {sections.map((s) => (
            <TypePickerCard
              key={s.href}
              icon={s.icon}
              tone={s.tone}
              label={s.label}
              description={s.description}
              onClick={() => router.push(s.href)}
            />
          ))}
        </div>
      )}

      {tab === "loehne" && (
        <div className="space-y-6">
          {/* Admin-only: Monats-Stunden-Tabelle + Lohndokumente-Verwaltung.
              Trust-gated. Strikt role='admin', auch User mit lohn:manage-
              Permission sehen sie nicht.
              Eigene Lohndokumente (fuer alle Rollen) leben jetzt unter
              /mein-konto -> Dokumente, nicht mehr hier. */}
          {isAdmin ? (
            <TrustedDeviceGate>
              <div className="space-y-6">
                <MonatsstundenTable />
                <LohndokumenteAdmin />
              </div>
            </TrustedDeviceGate>
          ) : (
            <div className="rounded-xl border border-dashed border-border bg-card/30 p-8 text-center text-sm text-muted-foreground">
              Deine eigenen Lohnabrechnungen findest du unter{" "}
              <a href="/mein-konto?tab=dokumente" className="underline hover:text-foreground">
                Mein Konto → Dokumente
              </a>.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
