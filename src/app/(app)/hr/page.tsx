"use client";

/**
 * /hr — nur noch Weiterleitung. Den Hub mit Tabs gibt es nicht mehr: jede
 * HR-Seite hat ihre eigene Adresse, die Sidebar (Bereich «HR») ist die
 * Navigation. Alte Lesezeichen und Links (/hr, /hr?tab=…) landen auf der
 * passenden Seite:
 *
 *   ?tab=antraege | anfragen | uebersicht → /antraege
 *   ?tab=stempelzeiten                    → /stempelzeiten
 *   ?tab=tickets                          → /tickets
 *   ?tab=ferien | abwesenheit             → /ferien
 *   ?tab=loehne | lohn                    → /lohn  (lohn=… → ansicht=…,
 *                                                   subtab=… → tab=…)
 *   ?tab=mitarbeiter                      → /mitarbeiter
 *   ohne/unbekannt oder Ziel nicht erlaubt → erste erlaubte Seite in der
 *                                            Reihenfolge Anträge,
 *                                            Stempelzeiten, Abwesenheit
 *
 * Die uebrigen Parameter (z.B. from=dashboard, user=…, mode=…) reisen mit.
 * Client-Seite, weil die Rechte (usePermissions) mitentscheiden.
 * router.replace: /hr bleibt nicht in der Browser-History haengen.
 */

import { useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { usePermissions } from "@/lib/use-permissions";
import {
  LOHN_PARAM_ANSICHT,
  LOHN_PARAM_BEREICH,
  resolveLohnAnsicht,
  resolveLohnBereich,
} from "@/components/hr/lohn-bereiche";
import Loading from "./loading";

type Ziel = "/antraege" | "/stempelzeiten" | "/tickets" | "/ferien" | "/lohn" | "/mitarbeiter";

/** Alter Tab-Schluessel → neue Seite. */
const TAB_ZIEL: Record<string, Ziel> = {
  antraege: "/antraege",
  anfragen: "/antraege",
  uebersicht: "/antraege",
  stempelzeiten: "/stempelzeiten",
  tickets: "/tickets",
  ferien: "/ferien",
  abwesenheit: "/ferien",
  loehne: "/lohn",
  lohn: "/lohn",
  mitarbeiter: "/mitarbeiter",
};

/** Reihenfolge fuer «ohne/unbekannter Tab» (frueher: erster sichtbarer Tab). */
const START_REIHENFOLGE: Ziel[] = ["/antraege", "/stempelzeiten", "/ferien"];

/** Hub-eigene Parameter — werden umgeschrieben bzw. fallen weg. */
const HUB_PARAMS = ["tab", "subtab", "lohn"];

export default function HrWeiterleitung() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can, role, ready } = usePermissions();
  // can() ist pro Render neu — der Effekt laeuft darum oefter; weitergeleitet
  // wird genau einmal.
  const weitergeleitet = useRef(false);

  useEffect(() => {
    if (!ready || weitergeleitet.current) return;
    weitergeleitet.current = true;

    // Gleiche Sichtbarkeit wie die Seiten selbst (Admin immer via can()).
    const erlaubt: Record<Ziel, boolean> = {
      "/antraege": can("ferien:approve") || can("tickets:manage") || can("stempelzeiten:see-all"),
      "/stempelzeiten": can("stempelzeiten:view"),
      "/tickets": can("tickets:view"),
      "/ferien": true,
      "/lohn": true,
      "/mitarbeiter": role === "admin",
    };

    const gewuenscht = TAB_ZIEL[searchParams.get("tab") ?? ""];
    const ziel: Ziel =
      gewuenscht && erlaubt[gewuenscht]
        ? gewuenscht
        : (START_REIHENFOLGE.find((z) => erlaubt[z]) ?? "/ferien");

    const params = new URLSearchParams(searchParams.toString());
    for (const p of HUB_PARAMS) params.delete(p);
    if (ziel === "/lohn") {
      const ansicht = resolveLohnAnsicht(searchParams.get("lohn"));
      const bereich = resolveLohnBereich(searchParams.get("subtab"));
      if (ansicht) params.set(LOHN_PARAM_ANSICHT, ansicht);
      if (bereich) params.set(LOHN_PARAM_BEREICH, bereich);
    }
    const qs = params.toString();
    router.replace(qs ? `${ziel}?${qs}` : ziel);
  }, [ready, can, role, searchParams, router]);

  return <Loading />;
}
