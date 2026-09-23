// Server-Cache fuer selten aendernde Stammdaten (§9).
//
// unstable_cache(fn, [key], { tags, revalidate: 3600 }) haelt das Ergebnis
// quer ueber Requests im Next-Data-Cache. Schreib-Routen invalidieren gezielt
// via revalidateTag(<TAG>, { expire: 0 }) — Next 16: das zweite Argument ist
// Pflicht; { expire: 0 } = sofortige Expiration (Doku revalidateTag.md,
// Route-Handler-Pattern), damit Aenderungen ohne Stale-Fenster sichtbar sind.
//
// WICHTIG: Die gecachten Funktionen nutzen den Admin-Client — im Cache-Scope
// duerfen keine Request-Cookies/Headers gelesen werden, und das Ergebnis wird
// user-uebergreifend geteilt. Hier liegen deshalb NUR Daten, die fuer alle
// eingeloggten User identisch sind (Firmen-Singleton, Rollen-Tabelle).

import { unstable_cache } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchCompanySettingsUncached, type CompanySettings } from "@/lib/company-settings";

export const COMPANY_SETTINGS_TAG = "company-settings";
export const ROLES_TAG = "roles";

/**
 * Firmen-Stammdaten (Singleton-Row) — gecacht 1h bzw. bis
 * revalidateTag(COMPANY_SETTINGS_TAG). Wird von loadCompanySettings()
 * konsumiert, damit alle bestehenden Aufrufer automatisch profitieren.
 */
export const cachedCompanySettings = unstable_cache(
  async (): Promise<CompanySettings> => fetchCompanySettingsUncached(createAdminClient()),
  ["company-settings"],
  { tags: [COMPANY_SETTINGS_TAG], revalidate: 3600 },
);

export interface CachedRole {
  slug: string;
  label: string;
  /** Normalisiert: nur String-Eintraege (jsonb kann theoretisch Muell enthalten). */
  permissions: string[];
  /** Zugriffs-Reichweite (Migration 208); null wenn Spalte leer/ungueltig → Aufrufer-Default 'self'. */
  scope: "self" | "team" | "all" | null;
  /** Portal-Rolle (partner/lieferant, Migration 254). */
  is_portal: boolean;
  /** jsonb {order, hidden} | null — Rollen-Dashboard-Override; roh durchgereicht,
   *  Parsing bleibt beim Konsumenten (Dashboard-Route). */
  dashboard_widgets: unknown;
}

/**
 * Komplette Rollen-Tabelle (eine Handvoll Zeilen) — gecacht 1h bzw. bis
 * revalidateTag(ROLES_TAG) aus den Rollen-Schreibrouten.
 *
 * Wirft bei DB-Fehler (damit nie ein leeres Ergebnis gecacht wird) —
 * Aufrufer, die bisher fehlertolerant waren, fangen selbst mit .catch().
 */
export const cachedRoles = unstable_cache(
  async (): Promise<CachedRole[]> => {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("roles")
      .select("slug, label, permissions, scope, is_portal, dashboard_widgets");
    if (error) throw new Error(`roles-Laden fehlgeschlagen: ${error.message}`);
    return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
      slug: String(r.slug ?? ""),
      label: String(r.label ?? ""),
      permissions: Array.isArray(r.permissions)
        ? (r.permissions as unknown[]).filter((p): p is string => typeof p === "string")
        : [],
      scope:
        r.scope === "self" || r.scope === "team" || r.scope === "all" ? r.scope : null,
      is_portal: r.is_portal === true,
      dashboard_widgets: r.dashboard_widgets ?? null,
    }));
  },
  ["roles"],
  { tags: [ROLES_TAG], revalidate: 3600 },
);
