"use client";

/**
 * Partner-Kontakte — View-Component.
 *
 * Wird gerendert von /partner (Deep-Link-Alias) und /kontakte?tab=partner.
 * Inhaltlich: Locationspartner (role='partner'-User mit zugewiesener Location).
 * Rollen-Definitionen, Anfrage-Form und Aktivitaets-Log leben weiter unter
 * /einstellungen → Partnerportal (Meta-Konfiguration, nicht Kontaktliste).
 *
 * "embedded"-Prop: unterdrueckt Header (h1+Subtitle) wenn die View innerhalb
 * eines Tab-Kontexts eingebettet ist — dort bringt der Kontakte-Tab-Header
 * bereits die Sektion mit; ein zweiter H1 waere doppelt.
 */

import { HeartHandshake } from "lucide-react";
import { PartnerTab } from "@/components/einstellungen/partner-tab";
import { usePermissions } from "@/lib/use-permissions";

interface Props {
  /** Wenn true, wird der Header (h1 + Subtitle) weggelassen. */
  embedded?: boolean;
}

export function PartnerView({ embedded = false }: Props) {
  const { can, ready } = usePermissions();
  if (!ready) return null;
  // can() nutzt hasPermission() — Admin passt automatisch durch, andere
  // Rollen brauchen den Slug in ihrer Permissions-Liste. Interner
  // Verwaltungs-Screen (Inhalt = Einstellungen → Partnerportal) → gegated
  // ueber das registrierte einstellungen:view. Vorher stand hier das nie
  // registrierte "partner:manage" — fuer Nicht-Admins unerreichbar.
  const mayManage = can("einstellungen:view");

  if (!mayManage) {
    return (
      <div className="p-8 text-center">
        <p className="text-sm text-muted-foreground">Keine Berechtigung für diesen Bereich.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {!embedded && (
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
              <HeartHandshake className="h-5 w-5" />
              Partner
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Locationspartner mit Portal-Zugang &mdash; verwalten ihre eigenen Anfragen und Belegungspläne.
            </p>
          </div>
        </div>
      )}

      <PartnerTab />
    </div>
  );
}
