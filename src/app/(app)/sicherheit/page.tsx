"use client";

/**
 * Sicherheit — Admin-Seite fuer Zugriffs-Protokolle und Zugriffs-Werkzeuge,
 * die vorher in den Einstellungen lagen (Struktur-Umbau 2026-10).
 * Einstellungen enthaelt seither nur noch Konfiguration; der technische
 * Zustand (Rig, KI, NAS, Backup) lebt unter Technik bzw. Ablage.
 *
 * Tabs (?tab=…, ueberlebt Reload):
 *   Anmeldungen → AktivitaetTab je Portal (?bereich=firma|partner|lieferant),
 *                 vorher Einstellungen › Aktivität
 *   Geräte      → vertraute Geraete aller User, vorher Einstellungen › Integrationen
 *   Entwickler  → Developer-Modus (vorher Ende der Team-Liste) + Build-Info
 *
 * Laptop-Seite (Regel «Wer und wo»), keine eigene Handy-Ansicht.
 * Admin-only: Sidebar/isPathAllowed via ADMIN_ONLY_PREFIXES, hier
 * zusaetzlich die Rollen-Pruefung wie in den Einstellungen.
 *
 * Nav-Muster wie Einstellungen: Top-Tabs = TabsNav (Underline), Bereichs-
 * Umschalter in Anmeldungen = kasten-Toggle.
 */

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { LogIn, MonitorSmartphone, CodeXml, Building2, Handshake, Truck, ShieldOff } from "lucide-react";
import { usePermissions } from "@/lib/use-permissions";
import { TabsNav } from "@/components/ui/tabs-nav";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { DeveloperModeCard } from "@/components/einstellungen/developer-mode-card";
import { BuildInfoBadge } from "@/components/einstellungen/build-info-badge";
import Loading from "./loading";

// Grosse Tab-Inhalte via next/dynamic (Bundle-Split) — wie in den Einstellungen.
// Options MUESSEN als Objekt-Literal im dynamic()-Aufruf stehen.
const tabLoading = () => (
  <div className="space-y-4">
    <Skeleton className="h-8 w-48" />
    <Skeleton className="h-64" />
  </div>
);
const AktivitaetTab = dynamic(() => import("@/components/einstellungen/aktivitaet-tab").then((m) => m.AktivitaetTab), { ssr: false, loading: tabLoading });
const AlleVertrauteGeraeteCard = dynamic(
  () => import("@/components/einstellungen/alle-vertraute-geraete-card").then((m) => m.AlleVertrauteGeraeteCard),
  { ssr: false, loading: tabLoading },
);

type Tab = "anmeldungen" | "geraete" | "entwickler";
type Bereich = "firma" | "partner" | "lieferant";

const DEFAULT_TAB: Tab = "anmeldungen";
const DEFAULT_BEREICH: Bereich = "firma";
const ALL_TABS: Tab[] = ["anmeldungen", "geraete", "entwickler"];
const ALL_BEREICHE: Bereich[] = ["firma", "partner", "lieferant"];

function resolveTab(raw: string | null): Tab | null {
  return raw && (ALL_TABS as string[]).includes(raw) ? (raw as Tab) : null;
}
function resolveBereich(raw: string | null): Bereich | null {
  return raw && (ALL_BEREICHE as string[]).includes(raw) ? (raw as Bereich) : null;
}

const TABS = [
  { key: "anmeldungen", label: "Anmeldungen", icon: <LogIn className="h-4 w-4" /> },
  { key: "geraete", label: "Geräte", icon: <MonitorSmartphone className="h-4 w-4" /> },
  { key: "entwickler", label: "Entwickler", icon: <CodeXml className="h-4 w-4" /> },
];

const BEREICHE: { key: Bereich; label: string; icon: React.ReactNode }[] = [
  { key: "firma", label: "Firmenportal", icon: <Building2 className="h-4 w-4" /> },
  { key: "partner", label: "Partnerportal", icon: <Handshake className="h-4 w-4" /> },
  { key: "lieferant", label: "Lieferantenportal", icon: <Truck className="h-4 w-4" /> },
];

export default function SicherheitPage() {
  const searchParams = useSearchParams();
  const urlTab = resolveTab(searchParams.get("tab"));
  const urlBereich = resolveBereich(searchParams.get("bereich"));
  const [tab, setTab] = useState<Tab>(urlTab ?? DEFAULT_TAB);
  const [bereich, setBereich] = useState<Bereich>(urlBereich ?? DEFAULT_BEREICH);
  // Wechsel von aussen (Befehlspalette, Weiterleitung aus den Einstellungen,
  // Link auf dieselbe Seite) in den State uebernehmen — Anpassung waehrend
  // des Renders statt per Effect.
  const [letzteUrl, setLetzteUrl] = useState({ tab: urlTab, bereich: urlBereich });
  if (letzteUrl.tab !== urlTab || letzteUrl.bereich !== urlBereich) {
    setLetzteUrl({ tab: urlTab, bereich: urlBereich });
    setTab(urlTab ?? DEFAULT_TAB);
    if (urlBereich) setBereich(urlBereich);
  }
  const { role, ready } = usePermissions();
  const isAdmin = role === "admin";

  // State = sofortige UI-Quelle, URL parallel via History-API (wie
  // Einstellungen; router.replace war in Next 16 fuer reine Query-
  // Aenderungen unzuverlaessig). ?bereich steht nur bei Anmeldungen.
  function schreibeUrl(t: Tab, b: Bereich) {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("tab", t);
    if (t === "anmeldungen") url.searchParams.set("bereich", b);
    else url.searchParams.delete("bereich");
    window.history.replaceState({}, "", url.toString());
  }
  function selectTab(t: Tab) {
    setTab(t);
    schreibeUrl(t, bereich);
  }
  function selectBereich(b: Bereich) {
    setBereich(b);
    schreibeUrl("anmeldungen", b);
  }

  // Solange Rolle nicht ready ist rendern wir NICHTS (wie Einstellungen) —
  // sonst blitzt kurz der Kein-Zugriff-Zustand auf.
  if (!ready) return <Loading />;

  if (!isAdmin) {
    return (
      <div className="max-w-md mx-auto py-16">
        <EmptyState icon={ShieldOff} title="Kein Zugriff auf Sicherheit" description="Diese Seite ist Admins vorbehalten." />
      </div>
    );
  }

  return (
    <div className="space-y-8 page-enter">
      {/* Header — konsistent mit /einstellungen (h1 + Untertitel). */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Sicherheit</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Wer sich wann angemeldet hat, vertraute Geräte und Entwickler-Werkzeuge.
        </p>
      </div>

      {/* Top-Tabs (Underline via TabsNav) + in Anmeldungen der Portal-
          Umschalter als kasten-Toggle (gleiche Daten, anders gefiltert). */}
      <div>
        <TabsNav tabs={TABS} active={tab} onChange={(k) => selectTab(k as Tab)} ariaLabel="Sicherheit-Bereiche" />

        {tab === "anmeldungen" && (
          <div className="flex flex-wrap gap-2 mt-10">
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
        )}
      </div>

      {/* key: eigene Instanz je Bereich — keine veraltete Antwort/Auswahl
          aus dem vorherigen Portal. */}
      {tab === "anmeldungen" && <AktivitaetTab key={bereich} scope={bereich} />}

      {tab === "geraete" && <AlleVertrauteGeraeteCard />}

      {tab === "entwickler" && (
        <div className="space-y-6">
          <DeveloperModeCard />
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground ml-1">Aktueller Build</p>
            <div className="flex">
              <BuildInfoBadge />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
