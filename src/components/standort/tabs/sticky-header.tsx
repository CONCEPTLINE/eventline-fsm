"use client";

/**
 * Location-Detail (Verwaltung): Sticky-Header (Name/Adresse/Kunde-Chip/
 * Rentabilitaet/Tab-Nav).
 *
 * Sitzt oben in der Detail-Seite und bleibt beim Scrollen an der oberen
 * Kante des #app-scroll-Wrappers stehen. Design entspricht 1:1 dem
 * Auftrag-Detail-Sticky-Header (`components/auftrag/tabs/sticky-header.tsx`),
 * damit die App app-weit konsistent bleibt (Regel §17).
 *
 * Handy (< md, 2026-10-14): Name und Adresse brechen um statt zu kuerzen,
 * die Knoepfe stehen in einer eigenen, umbrechenden Zeile darunter (34 px),
 * die Tab-Leiste ist enger gesetzt (Icons aus, 12 px), damit alle Tabs in
 * 340 px passen; reicht es doch nicht, scrollt sie ohne sichtbare Leiste
 * und holt den aktiven Tab in den Blick. Desktop unveraendert.
 */

import { useEffect, useRef } from "react";
import Link from "next/link";
import { MapPin, Building2, BarChart3, Plus, Archive, ArchiveRestore } from "lucide-react";
import { BackButton } from "@/components/ui/back-button";
import { TabsNav } from "@/components/ui/tabs-nav";
import type { Location, Customer } from "@/types";

export type StandortTabKey = "uebersicht" | "notizen" | "verrechnung";

type Tab = { key: StandortTabKey; label: string; icon: React.ReactNode };

type Props = {
  location: Location;
  linkedCustomer: Customer | null;
  isAdmin: boolean;
  /** Permission locations:archive — steuert Archivieren + Reaktivieren. */
  canArchive: boolean;
  onArchive: () => void;
  onReactivate: () => void;
  tabs: Tab[];
  activeTab: StandortTabKey;
  onSelectTab: (t: StandortTabKey) => void;
  /** Wenn kein Kunde verknuepft ist UND der User Admin, zeigt einen
   *  "+ Kunde verknuepfen"-Button; Klick soll direkt in den Tab
   *  «Verrechnung & Kunde» wechseln (dort ist der SearchableSelect). */
  onOpenCustomerLink: () => void;
};

export function StandortStickyHeader({
  location,
  linkedCustomer,
  isAdmin,
  canArchive,
  onArchive,
  onReactivate,
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

  // Handy-Fallback: passt die Tab-Leiste nicht in die Breite (sehr schmale
  // Geraete, groessere Systemschrift), den aktiven Tab in den sichtbaren
  // Bereich schieben. Nur horizontal (scrollLeft) — scrollIntoView wuerde
  // auch die Seite vertikal bewegen. Ohne Ueberlauf (Desktop) passiert nichts.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const nav = rootRef.current?.querySelector<HTMLElement>("[role='tablist']");
    const aktiv = nav?.querySelector<HTMLElement>("[aria-selected='true']");
    if (!nav || !aktiv || nav.scrollWidth <= nav.clientWidth) return;
    const n = nav.getBoundingClientRect();
    const a = aktiv.getBoundingClientRect();
    if (a.left < n.left) nav.scrollLeft += a.left - n.left - 8;
    else if (a.right > n.right) nav.scrollLeft += a.right - n.right + 8;
  }, [activeTab, tabs.length]);

  // Handy: scrollt mit (max-md:static) — der umbrechende Kopf mit Name,
  // Knoepfen und Tabs ist dort ~170 px hoch und wuerde klebend fast ein
  // Viertel des Bildschirms ueber dem Inhalt belegen.
  return (
    <div
      ref={rootRef}
      className="sticky top-[var(--kopf-h,0px)] z-20 max-md:static bg-[#f5f5f7]/85 dark:bg-[#0a0a0a]/85 backdrop-blur-md pt-1 pb-4 mb-8 max-md:pb-[6px] max-md:mb-[10px]"
    >
      <div className="flex items-start gap-3 max-md:flex-wrap max-md:gap-y-[10px]">
        <BackButton fallbackHref="/locations" />
        <div className="flex-1 min-w-0 max-md:basis-full">
          <div className="flex items-center gap-2 min-w-0 max-md:flex-wrap max-md:gap-y-1">
            <h1 className="text-xl md:text-2xl font-bold tracking-tight truncate max-md:whitespace-normal max-md:break-words max-md:text-[20px] max-md:leading-[26px]">{location.name}</h1>
            {location.archived_at && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded-full bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300 shrink-0">
                <Archive className="h-3 w-3" /> Archiviert
              </span>
            )}
          </div>
          {(addressLine || location.capacity) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground mt-1 max-md:text-[13px]">
              {addressLine && (
                <span className="inline-flex items-center gap-1 min-w-0">
                  <MapPin className="h-3 w-3 shrink-0" />
                  <span className="truncate max-md:whitespace-normal max-md:break-words">{addressLine}</span>
                </span>
              )}
              {location.capacity ? (
                <span className="inline-flex items-center gap-1">
                  <span className="tabular-nums">{location.capacity} Personen</span>
                </span>
              ) : null}
            </div>
          )}
          {location.archived_at && (
            <p className="text-xs text-amber-700 dark:text-amber-300/90 mt-1">
              Archiviert am {new Date(location.archived_at).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric" })}
              {location.archived_reason ? ` — ${location.archived_reason}` : ""}
            </p>
          )}
        </div>

        {/* Rechts: Kunde-Chip + Rentabilitaet-Button (Handy: eigene,
            umbrechende Zeile unter Name/Adresse) */}
        <div className="flex items-center gap-2 shrink-0 max-md:w-full max-md:shrink max-md:flex-wrap max-md:gap-[8px] max-md:empty:hidden">
          {linkedCustomer ? (
            <Link
              href={`/kunden/${linkedCustomer.id}`}
              className="kasten kasten-muted max-md:min-h-[34px] max-md:max-w-full"
              data-tooltip="Zum Kunden"
            >
              <Building2 className="h-3.5 w-3.5 max-md:shrink-0" />
              <span className="truncate max-w-[10rem] max-md:max-w-none">{linkedCustomer.name}</span>
            </Link>
          ) : (
            isAdmin && (
              <button
                type="button"
                onClick={onOpenCustomerLink}
                className="kasten kasten-muted max-md:min-h-[34px]"
                data-tooltip="Kunde dieser Location zuweisen"
              >
                <Plus className="h-3.5 w-3.5" />
                Kunde verknüpfen
              </button>
            )
          )}

          {/* Rentabilitaet-Button — oeffnet Print-optimierte Rentabilitaets-Ansicht
              in neuem Tab. Nur fuer Admins sichtbar (Personalkosten-Detail). */}
          {isAdmin && (
            <Link
              href={`/standorte/${location.id}/report`}
              target="_blank"
              className="kasten kasten-muted max-md:min-h-[34px]"
              data-tooltip="Rentabilität öffnen (druckbar)"
            >
              <BarChart3 className="h-3.5 w-3.5" />
              Rentabilität
            </Link>
          )}

          {/* Archivieren / Reaktivieren — Prinzip wie Auftrag-Storno
              (Zwei-Phasen-Modal mit Pflicht-Grund, in page.tsx). */}
          {canArchive && (
            location.archived_at ? (
              <button type="button" onClick={onReactivate} className="kasten kasten-muted max-md:min-h-[34px]">
                <ArchiveRestore className="h-3.5 w-3.5" />
                Reaktivieren
              </button>
            ) : (
              <button
                type="button"
                onClick={onArchive}
                className="kasten kasten-archive max-md:min-h-[34px]"
                data-tooltip="Mit Begründung ins Archiv verschieben"
              >
                <Archive className="h-3.5 w-3.5" />
                Archivieren
              </button>
            )
          )}
        </div>
      </div>

      {/* Tab-Nav */}
      <TabsNav
        tabs={tabs}
        active={activeTab}
        onChange={(k) => onSelectTab(k as StandortTabKey)}
        className="mt-3 max-md:mt-[10px] max-md:gap-0.5 max-md:[scrollbar-width:none]! max-md:[&::-webkit-scrollbar]:hidden"
        tabClassName="max-md:px-[6px] max-md:text-[12px]"
        ariaLabel="Location-Bereiche"
      />
    </div>
  );
}
