"use client";

/**
 * Standort-Detail: Tab "Einstellungen" (Admin-only).
 *
 * Enthaelt zwei Sections:
 *   - Verrechnungssaetze pro Modus (RateTiersSection)
 *   - Kunden-Verknuepfung aendern (SearchableSelect + "Entfernen"-Button)
 *
 * Der Tab wird in der Page-Wrapper-Ebene fuer Non-Admins gar nicht erst
 * eingehaengt (Rollen-Gate im TabsNav), diese Komponente vertraut also
 * darauf, dass sie nur mit Admin-Rechten angezeigt wird.
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SearchableSelect } from "@/components/searchable-select";
import { RateTiersSection } from "@/components/standorte/rate-tiers-section";
import { Building2 } from "lucide-react";
import type { Customer } from "@/types";

type Props = {
  locationId: string;
  linkedCustomer: Customer | null;
  customers: Customer[];
  onLinkCustomer: (customerId: string | null) => Promise<void>;
};

export function SettingsTab({
  locationId,
  linkedCustomer,
  customers,
  onLinkCustomer,
}: Props) {
  return (
    <div className="space-y-4">
      {/* Verrechnungssaetze — pro Modus (Normal/Pikett/Admin/...) ein Satz.
          Beim Stempeln waehlt der MA den Modus, im Rapport pro Range. */}
      <RateTiersSection locationId={locationId} />

      {/* Kunden-Verknuepfung */}
      <Card className="bg-card">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Building2 className="h-4 w-4" />
            Zugewiesener Kunde
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {linkedCustomer ? (
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0">
                <div className="h-10 w-10 rounded-xl bg-red-50 text-red-600 dark:bg-red-500/15 dark:text-red-300 flex items-center justify-center font-bold text-sm shrink-0">
                  {linkedCustomer.name.charAt(0)}
                </div>
                <div className="min-w-0">
                  <p className="font-medium text-sm truncate">{linkedCustomer.name}</p>
                  {linkedCustomer.address_city && (
                    <p className="text-xs text-muted-foreground truncate">
                      {linkedCustomer.address_zip} {linkedCustomer.address_city}
                    </p>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onLinkCustomer(null)}
                className="kasten kasten-red shrink-0"
              >
                Verknüpfung entfernen
              </button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">
              Kein Kunde verknüpft.
            </p>
          )}

          {/* Kunden-Auswahl (auch bei bereits verknuepftem Kunden sichtbar,
              zum Umstellen auf einen anderen Kunden). */}
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
              {linkedCustomer ? "Kunden ändern" : "Kunde auswählen"}
            </p>
            <SearchableSelect
              value=""
              onChange={(v) => {
                if (v) onLinkCustomer(v);
              }}
              items={customers.map((c) => ({ id: c.id, label: c.name }))}
              placeholder="Kunde suchen…"
              clearable={false}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
