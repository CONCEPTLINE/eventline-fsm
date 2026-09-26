// Portal-Registry — DIE eine Stelle, die pro Portal-Rolle definiert, wo
// deren Login liegt, wo sie nach dem Login landet und wie der Email-
// Pre-Flight-Check heisst.
//
// Hintergrund (2026-09-23): der Partner-/Lieferanten-Dispatch war an ~11
// Stellen hart kopiert (Login-Preflight, Passwort-/Passkey-Backstops,
// Passwort-Reset-Ziel, (app)-Layout-Guard, View-As-Redirects). Beim
// naechsten Portal (z.B. 'kunde') haette man alle Stellen wieder anfassen
// muessen — und der View-As-Lieferanten-Redirect wurde prompt vergessen.
// Jetzt: neue Portal-Rolle in roles.ts (PORTAL_ROLLEN) eintragen + hier
// einen Registry-Eintrag ergaenzen — alle Weichen ziehen automatisch mit.
//
// EINE Quelle: die Rollen-Liste selbst lebt in src/lib/roles.ts
// (PORTAL_ROLLEN); portals.ts baut nur darauf auf. Layout-/Login-Dateien
// der Portale bleiben bewusst getrennt (keine Layout-Fusion).

import { PORTAL_ROLLEN } from "@/lib/roles";

export type PortalSlug = (typeof PORTAL_ROLLEN)[number];

export interface PortalDef {
  slug: PortalSlug;
  /** UI-Label, z.B. im View-As-Chip ("als Hans · Partner"). */
  label: string;
  /** URL-Prefix des Portals — fuer pathname-Checks ("bin ich im Portal?"). */
  basePath: string;
  /** Login-Seite des Portals — Ziel der wrong_portal-Redirects. */
  loginPath: string;
  /** Start-Seite nach erfolgreichem Login / Passwort-Reset / Guard-Redirect. */
  homePath: string;
  /** SQL-RPC fuer den Login-Preflight: gehoert diese Email einem Portal-User?
   *  Bei neuer Portal-Rolle auch die SQL-Funktion anlegen (Muster:
   *  is_partner_email / is_lieferant_email). */
  emailCheckRpc: string;
}

export const PORTALS: Record<PortalSlug, PortalDef> = {
  partner: {
    slug: "partner",
    label: "Partner",
    basePath: "/partner",
    loginPath: "/partner/login",
    homePath: "/partner/anfragen",
    emailCheckRpc: "is_partner_email",
  },
  lieferant: {
    slug: "lieferant",
    label: "Lieferant",
    basePath: "/lieferant",
    loginPath: "/lieferant/login",
    // Seit der Technik-Planung ist "Anfragen" der Arbeitsort — dort landet
    // der Lieferant nach dem Login (vorher: /lieferant/konto).
    homePath: "/lieferant/anfragen",
    emailCheckRpc: "is_lieferant_email",
  },
};

/** Alle Portale in PORTAL_ROLLEN-Reihenfolge — bestimmt u.a. die
 *  Preflight-Reihenfolge im /login (partner vor lieferant, wie bisher). */
export const PORTAL_LIST: readonly PortalDef[] = PORTAL_ROLLEN.map((slug) => PORTALS[slug]);

/** Registry-Eintrag zur Rolle — null fuer interne Rollen/unbekannt. */
export function portalForRole(role: string | null | undefined): PortalDef | null {
  if (!role) return null;
  return (PORTALS as Record<string, PortalDef | undefined>)[role] ?? null;
}

/** true = Rolle ist eine Portal-Rolle (Gegenstueck zu istIntern in roles.ts). */
export function istPortalRolle(role: string | null | undefined): role is PortalSlug {
  return portalForRole(role) !== null;
}

/** In welchem Portal liegt dieser Pfad? null = Haupt-App / kein Portal. */
export function portalForPath(pathname: string): PortalDef | null {
  return (
    PORTAL_LIST.find(
      (p) => pathname === p.basePath || pathname.startsWith(p.basePath + "/"),
    ) ?? null
  );
}
