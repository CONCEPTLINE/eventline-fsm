"use client";

/**
 * Anträge (/antraege) — eigene Seite im Sidebar-Bereich HR (vorher Tab im
 * Hub /hr). Zwei Reiter (TabsNav, ?tab= überlebt den Reload):
 *
 *   Abwesenheiten (Standard, ohne ?tab)  offene Abwesenheits-Anträge (direkt
 *       genehmigen/ablehnen), Stempel-Änderungen und andere Tickets, dazu die
 *       Mitarbeiter-Ampel. Inhalt: src/components/hr/antraege-view.tsx.
 *   Rechte & Lohndaten (?tab=rechte[&id=…], nur Admins)  Vier-Augen-Anträge
 *       für Rechte und Lohndaten (früher /rechte-antraege, leitet hierher um).
 *       Inhalt: src/components/hr/rechte-antraege-view.tsx. Wartung «Rechte»
 *       → Hinweisseite statt Inhalt (layout.tsx liefert den Kontext). Zähler am
 *       Reiter = offene Anträge, die der Admin jetzt bestätigen kann
 *       (/api/admin/rechte-antraege/zaehler).
 *
 * Wer kein Admin ist, sieht die Seite ohne Reiterleiste (nur Abwesenheiten).
 *
 * Sichtbar nur fuer wer etwas genehmigen darf: ferien:approve,
 * tickets:manage oder stempelzeiten:see-all (Admin immer, via
 * hasPermission). Der Pfad haengt an keinem Rechte-Modul — der Layout-Guard
 * laesst alle durch, darum prueft die Seite selbst (Kein-Zugriff-Zustand
 * wie die Admin-Seiten). /api/hr/anfragen prueft dieselben Rechte
 * serverseitig.
 */

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Palmtree, ShieldCheck, ShieldOff } from "lucide-react";
import { toast } from "sonner";
import { usePermissions } from "@/lib/use-permissions";
import { ANTRAEGE_TAB_RECHTE } from "@/lib/antraege-links";
import { BackButton } from "@/components/ui/back-button";
import { EmptyState } from "@/components/ui/empty-state";
import { TabsNav, type TabItem } from "@/components/ui/tabs-nav";
import { AntraegeView } from "@/components/hr/antraege-view";
import { RechteAntraegeView } from "@/components/hr/rechte-antraege-view";
import { WartungBereichSchranke, useWartung } from "@/components/wartung/wartung-kontext";
import Loading from "./loading";

type Tab = "abwesenheiten" | typeof ANTRAEGE_TAB_RECHTE;

function resolveTab(raw: string | null): Tab {
  return raw === ANTRAEGE_TAB_RECHTE ? ANTRAEGE_TAB_RECHTE : "abwesenheiten";
}

const UNTERTITEL: Record<Tab, string> = {
  abwesenheiten: "Abwesenheiten, Stempel-Änderungen und Tickets prüfen — und wer gerade arbeitet.",
  rechte: "Admin-Rolle, Lohnrecht und Vertretung ändern sich erst, wenn der andere Admin bestätigt.",
};

/** Zähler am Reiter «Rechte & Lohndaten» (serverseitig gezählt). null =
 *  (noch) keine Zahl — dann kein Zähler. neuLaden nach jedem Entscheid. */
function useRechteZaehler(aktiv: boolean): { anzahl: number | null; neuLaden: () => void } {
  const [anzahl, setAnzahl] = useState<number | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!aktiv) return;
    let lebt = true;
    fetch("/api/admin/rechte-antraege/zaehler", { cache: "no-store" })
      .then((r) => r.json().catch(() => null).then((j) => ({ status: r.status, ok: r.ok, j })))
      .then(({ status, ok, j }) => {
        if (!lebt) return;
        if (ok && j?.success) {
          setAnzahl(Number(j.anzahl) || 0);
          return;
        }
        setAnzahl(null);
        // Wartung «Rechte»: der Reiter zeigt ohnehin den Hinweis — kein Toast.
        if (status === 503 && j?.code === "wartung") return;
        toast.error((j?.error as string | undefined) ?? "Zähler der Rechte-Anträge konnte nicht geladen werden.");
      })
      .catch((e) => {
        if (!lebt) return;
        toast.error(`Zähler der Rechte-Anträge konnte nicht geladen werden: ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => {
      lebt = false;
    };
  }, [aktiv, version]);

  const neuLaden = useCallback(() => setVersion((v) => v + 1), []);
  return { anzahl: aktiv ? anzahl : null, neuLaden };
}

export default function AntraegePage() {
  const searchParams = useSearchParams();
  const { can, role, ready } = usePermissions();
  const isAdmin = ready && role === "admin";

  const urlTab = resolveTab(searchParams.get("tab"));
  const [tab, setTab] = useState<Tab>(urlTab);
  // Tab-Wechsel von aussen (Glocke, Link auf dieselbe Seite) in den State
  // uebernehmen — Anpassung waehrend des Renders statt per Effect
  // (gleiches Muster wie /einstellungen).
  const [letzterUrlTab, setLetzterUrlTab] = useState<Tab>(urlTab);
  if (urlTab !== letzterUrlTab) {
    setLetzterUrlTab(urlTab);
    setTab(urlTab);
  }

  const rechteGesperrt = useWartung("rechte").zugang === "gesperrt";
  const zaehler = useRechteZaehler(isAdmin && !rechteGesperrt);

  // Skeleton statt Kein-Zugriff, solange die Rechte laden — sonst blitzt
  // der Sperr-Zustand kurz auf.
  if (!ready) return <Loading />;

  const darfAntraege = can("ferien:approve") || can("tickets:manage") || can("stempelzeiten:see-all");
  if (!darfAntraege) {
    return (
      <div className="max-w-md mx-auto py-16">
        <EmptyState
          icon={ShieldOff}
          title="Kein Zugriff auf Anträge"
          description="Diese Seite ist für alle, die Abwesenheiten, Tickets oder Stempelzeiten genehmigen."
        />
      </div>
    );
  }

  // Nicht-Admins: nur Abwesenheiten — abgeleitet statt umgeleitet, damit nie
  // ein Admin-Reiter aufblitzt.
  const aktiv: Tab = isAdmin ? tab : "abwesenheiten";

  // Reiter-Wechsel: State = sofortige UI-Quelle, URL parallel per History-API
  // (wie /einstellungen). Standard-Reiter ohne ?tab; die Markierung ?id=
  // gehoert zum Deep-Link in die Rechte-Anträge und faellt beim Wechsel weg.
  function waehleTab(t: Tab) {
    setTab(t);
    const url = new URL(window.location.href);
    if (t === ANTRAEGE_TAB_RECHTE) url.searchParams.set("tab", t);
    else url.searchParams.delete("tab");
    url.searchParams.delete("id");
    window.history.replaceState(null, "", url.toString());
  }

  const tabs: TabItem[] = [
    { key: "abwesenheiten", label: "Abwesenheiten", icon: <Palmtree className="h-4 w-4" /> },
    {
      key: ANTRAEGE_TAB_RECHTE,
      label: "Rechte & Lohndaten",
      icon: <ShieldCheck className="h-4 w-4" />,
      badge: zaehler.anzahl ? zaehler.anzahl : undefined,
    },
  ];

  // Zurueck-Pfeil nur, wenn der Weg ueber einen Dashboard-Link kam
  // (?from=dashboard, z.B. Kachel «Abwesenheits-Anträge»).
  const fromDashboard = searchParams.get("from") === "dashboard";

  return (
    <div className="space-y-6 page-enter">
      <div className="flex items-center gap-3 min-w-0">
        {fromDashboard && <BackButton fallbackHref="/dashboard" />}
        <div className="min-w-0">
          <h1 className="text-2xl font-bold tracking-tight">Anträge</h1>
          <p className="text-sm text-muted-foreground mt-1">{UNTERTITEL[aktiv]}</p>
        </div>
      </div>

      {/* Hülle wie /einstellungen: TabsNav bringt -mb-px mit, das sonst den
          Abstand von space-y-6 zum Inhalt aufheben würde. */}
      {isAdmin && (
        <div>
          <TabsNav tabs={tabs} active={aktiv} onChange={(k) => waehleTab(k as Tab)} ariaLabel="Anträge-Bereiche" />
        </div>
      )}

      {aktiv === ANTRAEGE_TAB_RECHTE ? (
        <WartungBereichSchranke bereich="rechte">
          <RechteAntraegeView onGeaendert={zaehler.neuLaden} />
        </WartungBereichSchranke>
      ) : (
        <AntraegeView />
      )}
    </div>
  );
}
