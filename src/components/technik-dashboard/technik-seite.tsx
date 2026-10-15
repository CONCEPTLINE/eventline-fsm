"use client";

// Technik-Seite /technik mit Tabs (kanonisches Muster TabsNav, CLAUDE.md B4; Mischa 2026-10-16):
//   «Übersicht» — das Technik-Dashboard (technik-dashboard.tsx, unverändert, füllt die Fensterhöhe ohne Seiten-Scroll;
//                  die Tab-Zeile steht unter seiner Kopfzeile und wird mitgemessen)
//   «Wissen»    — Firmenwissen der KI und offene Fragen der KI (wissen-teil.tsx)
// Tab in der URL (?tab=wissen; Übersicht ohne Parameter) — Reload behält ihn (§10). Badge am Tab Wissen = offene Fragen
// der KI (Zählung in der DB). Nur Admins (die Seite gated), nur Laptop.

import { useCallback, useEffect, useState } from "react";
import { BookOpen, Laptop, Server } from "lucide-react";
import { TabsNav } from "@/components/ui/tabs-nav";
import { EmptyState } from "@/components/ui/empty-state";
import { TechnikDashboard, useBreit } from "./technik-dashboard";
import { WissenTeil } from "./wissen-teil";

type Tab = "uebersicht" | "wissen";

function leseTab(): Tab {
  if (typeof window === "undefined") return "uebersicht";
  return new URLSearchParams(window.location.search).get("tab") === "wissen" ? "wissen" : "uebersicht";
}

export function TechnikSeite() {
  const breit = useBreit();
  const [tab, setTab] = useState<Tab>(leseTab);
  const [fragen, setFragen] = useState<number | null>(null);

  // Zahl der offenen Fragen für das Badge (der Tab Wissen meldet sie nach jeder Änderung selbst).
  useEffect(() => {
    const ac = new AbortController();
    fetch("/api/technik/wissen/fragen?nur_anzahl=1", { cache: "no-store", signal: ac.signal })
      .then((r) => r.json().catch(() => null))
      .then((j: { success?: boolean; anzahl?: number } | null) => {
        if (j?.success && typeof j.anzahl === "number") setFragen(j.anzahl);
      })
      .catch(() => {});
    return () => ac.abort();
  }, []);

  // Vor/Zurück im Browser: Tab aus der URL übernehmen.
  useEffect(() => {
    const onPop = () => setTab(leseTab());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const waehle = useCallback((t: Tab) => {
    setTab(t);
    const url = new URL(window.location.href);
    if (t === "wissen") url.searchParams.set("tab", "wissen");
    else url.searchParams.delete("tab");
    window.history.replaceState(window.history.state, "", url.toString());
  }, []);

  if (!breit) {
    return (
      <div className="page-enter">
        <EmptyState icon={Laptop} title="Technik ist für den Laptop gebaut" description="Die Technik-Seite braucht ein breites Fenster. Bitte am Laptop öffnen oder das Fenster breiter ziehen." />
      </div>
    );
  }

  const tabs = (
    <TabsNav
      tabs={[
        { key: "uebersicht", label: "Übersicht", icon: <Server className="h-4 w-4" /> },
        { key: "wissen", label: "Wissen", icon: <BookOpen className="h-4 w-4" />, badge: fragen ? fragen : undefined },
      ]}
      active={tab}
      onChange={(k) => waehle(k as Tab)}
      ariaLabel="Technik-Bereiche"
      // Etwas dichter als Standard (Padding-Override): die Übersicht füllt die Fensterhöhe ohne Seiten-Scroll, auch
      // bei 1366×768 — mit Standard-Höhe fehlten dort 7 px (Zeichnung schon an ihrer Mindestgrösse).
      className="-mt-1"
      tabClassName="py-1.5"
    />
  );

  return tab === "wissen" ? <WissenTeil tabs={tabs} onFragenAnzahl={setFragen} /> : <TechnikDashboard tabs={tabs} />;
}
