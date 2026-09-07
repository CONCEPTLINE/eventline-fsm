"use client";

/**
 * Standort-Detail: Sticky-Header (Name/Adresse/Kunde-Chip/Rapport/Tab-Nav).
 *
 * Sitzt oben in der Detail-Seite und bleibt beim Scrollen an der oberen
 * Kante des #app-scroll-Wrappers stehen. Design entspricht 1:1 dem
 * Auftrag-Detail-Sticky-Header (`components/auftrag/tabs/sticky-header.tsx`),
 * damit die App app-weit konsistent bleibt (Regel §17).
 */

import Link from "next/link";
import { MapPin, Building2, BarChart3, Plus } from "lucide-react";
import { BackButton } from "@/components/ui/back-button";
import { TabsNav } from "@/components/ui/tabs-nav";
import type { Location, Customer } from "@/types";

export type StandortTabKey = "uebersicht" | "notizen" | "einstellungen";

type Tab = { key: StandortTabKey; label: string; icon: React.ReactNode };

type Props = {
  location: Location;
  linkedCustomer: Customer | null;
  isAdmin: boolean;
  tabs: Tab[];
  activeTab: StandortTabKey;
  onSelectTab: (t: StandortTabKey) => void;
  /** Wenn kein Kunde verknuepft ist UND der User Admin, zeigt einen
   *  "+ Kunde verknuepfen"-Button; Klick soll direkt in den Einstellungen-
   *  Tab wechseln (dort ist der SearchableSelect). */
  onOpenCustomerLink: () => void;
};

export function StandortStickyHeader({
  location,
  linkedCustomer,
  isAdmin,
  tabs,
  activeTab,
  onSelectTab,
  onOpenCustomerLink,
}: Props) {
  const addressLine = [
    location.address_street,
    `${location.address_zip || ""} ${location.address_city || ""}`.trim(),
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="sticky top-0 z-20 bg-[#f5f5f7]/85 dark:bg-[#0a0a0a]/85 backdrop-blur-md pt-1 pb-4 mb-8">
      <div className="flex items-start gap-3">
        <BackButton fallbackHref="/standorte" />
        <div className="flex-1 min-w-0">
          <h1 className="text-xl md:text-2xl font-bold tracking-tight truncate">{location.name}</h1>
          {(addressLine || location.capacity) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground mt-1">
              {addressLine && (
                <span className="inline-flex items-center gap-1 min-w-0">
                  <MapPin className="h-3 w-3 shrink-0" />
                  <span className="truncate">{addressLine}</span>
                </span>
              )}
              {location.capacity ? (
                <span className="inline-flex items-center gap-1">
                  <span className="tabular-nums">{location.capacity} Personen</span>
                </span>
              ) : null}
            </div>
          )}
        </div>

        {/* Rechts: Kunde-Chip + Rapport-Button */}
        <div className="flex items-center gap-2 shrink-0">
          {linkedCustomer ? (
            <Link
              href={`/kunden/${linkedCustomer.id}`}
              className="kasten kasten-muted"
              data-tooltip="Zum Kunden"
            >
              <Building2 className="h-3.5 w-3.5" />
              <span className="truncate max-w-[10rem]">{linkedCustomer.name}</span>
            </Link>
          ) : (
            isAdmin && (
              <button
                type="button"
                onClick={onOpenCustomerLink}
                className="kasten kasten-muted"
                data-tooltip="Kunde diesem Standort zuweisen"
              >
                <Plus className="h-3.5 w-3.5" />
                Kunde verknüpfen
              </button>
            )
          )}

          {/* Rapport-Button — oeffnet Print-optimierte Rentabilitaets-Ansicht
              in neuem Tab. Nur fuer Admins sichtbar (Personalkosten-Detail). */}
          {isAdmin && (
            <Link
              href={`/standorte/${location.id}/report`}
              target="_blank"
              className="kasten kasten-muted"
              data-tooltip="Rentabilitäts-Rapport öffnen (druckbar)"
            >
              <BarChart3 className="h-3.5 w-3.5" />
              Rapport
            </Link>
          )}
        </div>
      </div>

      {/* Tab-Nav */}
      <TabsNav
        tabs={tabs}
        active={activeTab}
        onChange={(k) => onSelectTab(k as StandortTabKey)}
        className="mt-3"
        ariaLabel="Standort-Bereiche"
      />
    </div>
  );
}
