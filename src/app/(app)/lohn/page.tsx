"use client";

/**
 * Lohn (/lohn) — eigene Seite im Sidebar-Bereich HR (vorher Tab im Hub /hr).
 *
 * Alle sehen «Meine» (eigene Lohnabrechnungen + Lohnausweise, inkl.
 * Digital-Einwilligung). Mit lohn:manage zusaetzlich «Team» (fuer diese
 * Rolle der Start) mit den Bereichen Monatsstunden | Lohndokumente |
 * Mitarbeiter-Lohn | Standardwerte — nur auf einem vertrauten Geraet
 * (TrustedDeviceGate wrapt die ganze Team-Ansicht).
 *
 * Zustand in der URL (ueberlebt Reload, CLAUDE.md §10):
 *   ?ansicht=meine|team&tab=monatsstunden|dokumente|mitarbeiter|standardwerte
 * Schluessel + alte Aliase: src/components/hr/lohn-bereiche.ts. Alte Links
 * /hr?tab=loehne&lohn=…&subtab=… leitet /hr hierher um.
 *
 * Nav-Muster wie Einstellungen: Meine|Team und die Bereiche als
 * kasten-Toggle (Ansichten derselben Sache, keine Seitenwechsel).
 */

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Table, FileText, Users, Settings as SettingsIcon } from "lucide-react";
import { usePermissions } from "@/lib/use-permissions";
import { BackButton } from "@/components/ui/back-button";
import { TrustedDeviceGate } from "@/components/trust/trusted-device-gate";
import { LohnausweiseList } from "@/components/hr/lohnausweise-list";
import { MonatsstundenTable } from "@/components/hr/monatsstunden-table";
import { LohndokumenteAdmin } from "@/components/hr/lohndokumente-admin";
import { MitarbeiterLohnTab } from "@/components/hr/loehne/mitarbeiter-lohn-tab";
import { LohnStandardwerteCard } from "@/components/hr/loehne/lohn-standardwerte-card";
import {
  LOHN_PARAM_ANSICHT,
  LOHN_PARAM_BEREICH,
  resolveLohnAnsicht,
  resolveLohnBereich,
  type LohnAnsicht,
  type LohnBereich,
} from "@/components/hr/lohn-bereiche";
import Loading from "./loading";

// Bereichs-Name = Ueberschrift im jeweiligen Inhalt (Monatsstunden, Lohndokumente, …).
const BEREICHE: { key: LohnBereich; label: string; icon: React.ReactNode }[] = [
  { key: "monatsstunden", label: "Monatsstunden",    icon: <Table className="h-4 w-4" /> },
  { key: "dokumente",     label: "Lohndokumente",    icon: <FileText className="h-4 w-4" /> },
  { key: "mitarbeiter",   label: "Mitarbeiter-Lohn", icon: <Users className="h-4 w-4" /> },
  { key: "standardwerte", label: "Standardwerte",    icon: <SettingsIcon className="h-4 w-4" /> },
];

/**
 * Auswahl, die in einem URL-Param steht: ein Klick wirkt sofort (lokaler
 * State), eine von aussen geaenderte URL (Link/Befehlspalette auf dieselbe
 * Seite mit anderem Param) gewinnt wieder. Abgleich waehrend des Renderns
 * statt per useEffect (react.dev „Storing information from previous renders").
 */
function useUrlChoice<T>(fromUrl: T | null): [T | null, (v: T) => void] {
  const [picked, setPicked] = useState<T | null>(null);
  const [seenUrl, setSeenUrl] = useState<T | null>(fromUrl);
  if (fromUrl !== seenUrl) {
    setSeenUrl(fromUrl);
    setPicked(null);
  }
  return [picked ?? fromUrl, setPicked];
}

/** URL rein visuell anpassen (History-API, kein Route-Wechsel) — wie
 *  Einstellungen; router.replace war in Next 16 fuer reine Query-
 *  Aenderungen unzuverlaessig. */
function writeUrl(mutate: (url: URL) => void) {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  mutate(url);
  window.history.replaceState({}, "", url.toString());
}

export default function LohnPage() {
  const searchParams = useSearchParams();
  const [ansichtWahl, setAnsicht] = useUrlChoice(resolveLohnAnsicht(searchParams.get(LOHN_PARAM_ANSICHT)));
  const [bereichWahl, setBereich] = useUrlChoice(resolveLohnBereich(searchParams.get(LOHN_PARAM_BEREICH)));
  const { can, ready } = usePermissions();

  if (!ready) return <Loading />;

  const canManageLohn = can("lohn:manage");
  // Lohn-Verwaltung startet in «Team», alle anderen sehen immer nur «Meine»
  // (kein Umschalter).
  const ansicht: LohnAnsicht = canManageLohn ? (ansichtWahl ?? "team") : "meine";
  const bereich: LohnBereich = bereichWahl ?? "monatsstunden";

  // Zurueck-Pfeil nur, wenn der Weg ueber einen Dashboard-Link kam
  // (?from=dashboard) — bei normaler Navigation keiner.
  const fromDashboard = searchParams.get("from") === "dashboard";

  function selectAnsicht(a: LohnAnsicht) {
    setAnsicht(a);
    writeUrl((url) => {
      url.searchParams.set(LOHN_PARAM_ANSICHT, a);
      if (a === "meine") url.searchParams.delete(LOHN_PARAM_BEREICH);
    });
  }

  function selectBereich(b: LohnBereich) {
    setBereich(b);
    writeUrl((url) => url.searchParams.set(LOHN_PARAM_BEREICH, b));
  }

  return (
    <div className="space-y-6 page-enter">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {fromDashboard && <BackButton fallbackHref="/dashboard" />}
          <div className="min-w-0">
            <h1 className="text-2xl font-bold tracking-tight">Lohn</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {ansicht === "meine"
                ? "Deine Lohnabrechnungen und Lohnausweise."
                : "Team: Monatsstunden, Lohndokumente, Mitarbeiter-Lohn und Standardwerte."}
            </p>
          </div>
        </div>
        {canManageLohn && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => selectAnsicht("meine")}
              className={ansicht === "meine" ? "kasten-active" : "kasten-toggle-off"}
            >
              Meine
            </button>
            <button
              type="button"
              onClick={() => selectAnsicht("team")}
              className={ansicht === "team" ? "kasten-active" : "kasten-toggle-off"}
            >
              Team
            </button>
          </div>
        )}
      </div>

      {ansicht === "meine" && (
        <div className="max-w-5xl">
          <LohnausweiseList />
        </div>
      )}

      {ansicht === "team" && canManageLohn && (
        <TrustedDeviceGate>
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2">
              {BEREICHE.map((b) => (
                <button
                  key={b.key}
                  type="button"
                  onClick={() => selectBereich(b.key)}
                  className={bereich === b.key ? "kasten-active" : "kasten-toggle-off"}
                >
                  {b.icon}
                  {b.label}
                </button>
              ))}
            </div>

            <div className="pt-2">
              {bereich === "monatsstunden" && <MonatsstundenTable />}
              {bereich === "dokumente" && <LohndokumenteAdmin />}
              {bereich === "mitarbeiter" && <MitarbeiterLohnTab />}
              {bereich === "standardwerte" && <LohnStandardwerteCard />}
            </div>
          </div>
        </TrustedDeviceGate>
      )}
    </div>
  );
}
