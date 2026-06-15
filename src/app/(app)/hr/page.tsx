"use client";

/**
 * HR-Hub — zwei Top-Tabs:
 *   • Operativ — Karten fuer Stempelzeiten, Tickets, Ferien
 *   • Löhne    — Lohn-Hub mit Sub-Tabs (admin-only, Trust-gated):
 *                  - Abrechnung: Monats-Stundenuebersicht inkl. BVG-Vorausschau
 *                  - Lohnabrechnungen: PDF generieren + manuelle Uploads
 *                  - Mitarbeiter-Lohn: Brutto-Stundenlohn + Overrides pro MA
 *                  - Standardwerte: firmenweite Default-Abzuege
 *
 * Eigene Lohndokumente (fuer alle Rollen) leben unter /mein-konto → Dokumente.
 * Stammdaten der MA (Name, Email, Rolle, Geburtsdatum) leben unter
 * /einstellungen → Team.
 */

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { TypePickerCard, type TypePickerTone } from "@/components/ui/type-picker-card";
import { Clock, Ticket, Plane, Briefcase, Wallet, Table, FileText, Users, Settings as SettingsIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { usePermissions } from "@/lib/use-permissions";
import { cn } from "@/lib/utils";
import { LohndokumenteAdmin } from "@/components/hr/lohndokumente-admin";
import { MonatsstundenTable } from "@/components/hr/monatsstunden-table";
import { LohnStandardwerteCard } from "@/components/hr/loehne/lohn-standardwerte-card";
import { MitarbeiterLohnTab } from "@/components/hr/loehne/mitarbeiter-lohn-tab";
import { TrustedDeviceGate } from "@/components/trust/trusted-device-gate";

const TAB_BTN_CLASS = "flex items-center gap-2 px-3 py-2.5 -mb-px text-sm font-medium border-b-2 transition-colors";

type Tab = "operativ" | "loehne";
type LoehneSubTab = "abrechnung" | "lohnabrechnungen" | "mitarbeiter" | "standardwerte";

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
  const urlSub = searchParams.get("subtab") as LoehneSubTab | null;
  const [tab, setTab] = useState<Tab>(urlTab === "loehne" ? "loehne" : "operativ");
  const [subTab, setSubTab] = useState<LoehneSubTab>(urlSub ?? "abrechnung");
  const { role } = usePermissions();
  const isAdmin = role === "admin";

  function selectTab(t: Tab) {
    setTab(t);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (t === "operativ") {
        url.searchParams.delete("tab");
        url.searchParams.delete("subtab");
      } else {
        url.searchParams.set("tab", t);
      }
      window.history.replaceState({}, "", url.toString());
    }
  }

  function selectSubTab(s: LoehneSubTab) {
    setSubTab(s);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("subtab", s);
      window.history.replaceState({}, "", url.toString());
    }
  }

  useEffect(() => {
    // Non-Admins die per URL auf 'loehne' landen werden auf 'operativ'
    // zurueckgeleitet — den Tab gibts fuer sie nicht.
    const wantsLoehne = urlTab === "loehne" && isAdmin;
    setTab(wantsLoehne ? "loehne" : "operativ");
  }, [urlTab, isAdmin]);

  useEffect(() => {
    if (urlSub) setSubTab(urlSub);
  }, [urlSub]);

  // Loehne-Tab nur fuer Admins — Non-Admins sehen ihre eigenen Lohn-
  // Dokumente unter Mein Konto. Ein leerer Hinweis-Tab waere fuer sie
  // sinnlos.
  const allTabs: { key: Tab; label: string; icon: React.ReactNode; adminOnly?: boolean }[] = [
    { key: "operativ", label: "Operativ", icon: <Briefcase className="h-4 w-4" /> },
    { key: "loehne",   label: "Löhne",    icon: <Wallet className="h-4 w-4" />, adminOnly: true },
  ];
  const tabs = allTabs.filter((t) => !t.adminOnly || isAdmin);

  const loehneSubTabs: { key: LoehneSubTab; label: string; icon: React.ReactNode }[] = [
    { key: "abrechnung",       label: "Abrechnung",       icon: <Table className="h-4 w-4" /> },
    { key: "lohnabrechnungen", label: "Lohnabrechnungen", icon: <FileText className="h-4 w-4" /> },
    { key: "mitarbeiter",      label: "Mitarbeiter-Lohn", icon: <Users className="h-4 w-4" /> },
    { key: "standardwerte",    label: "Standardwerte",    icon: <SettingsIcon className="h-4 w-4" /> },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">
          {isAdmin ? "HR" : "Mein Arbeitsalltag"}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          {isAdmin
            ? <>&nbsp;</>
            : "Stempelzeiten, Ferien, Tickets — alles was du im Arbeitstag brauchst. Deine Lohndokumente findest du in Mein Konto."}
        </p>
      </div>

      {/* Tab-Nav nur rendern wenn mehr als ein Tab — fuer Non-Admins mit
          nur 'Operativ' ist die einzelne Tab-Leiste visuelles Rauschen. */}
      {tabs.length > 1 && (
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
      )}

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

      {tab === "loehne" && isAdmin && (
        <div className="space-y-4">
          <TrustedDeviceGate>
              {/* Sub-Nav fuer den Lohn-Hub */}
              <nav className="flex gap-1 flex-wrap text-xs">
                {loehneSubTabs.map((s) => {
                  const active = subTab === s.key;
                  return (
                    <button
                      key={s.key}
                      type="button"
                      onClick={() => selectSubTab(s.key)}
                      className={cn(
                        "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition-colors",
                        active
                          ? "border-red-500 bg-red-500/10 text-red-700 dark:text-red-300"
                          : "border-border bg-card hover:bg-foreground/[0.04] dark:hover:bg-foreground/[0.06]",
                      )}
                    >
                      {s.icon}
                      {s.label}
                    </button>
                  );
                })}
              </nav>

              <div className="pt-2">
                {subTab === "abrechnung" && <MonatsstundenTable />}
                {subTab === "lohnabrechnungen" && <LohndokumenteAdmin />}
                {subTab === "mitarbeiter" && <MitarbeiterLohnTab />}
                {subTab === "standardwerte" && <LohnStandardwerteCard />}
              </div>
          </TrustedDeviceGate>
        </div>
      )}
    </div>
  );
}
