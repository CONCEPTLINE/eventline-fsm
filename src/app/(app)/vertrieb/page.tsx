"use client";

/**
 * /vertrieb — Tabs: «Räume» (die einfache Raum-Liste) und je aktive
 * Kampagne ein Tab (vertrieb_kampagnen, z. B. «Messe 2027», «Schulen 2027»).
 * Wer: vertrieb:view (lesen) / vertrieb:edit (Status, Notizen). Laptop-Seite.
 *
 * Aktiver Tab in der URL (?tab=raeume | ?tab=<kampagne-id>), sonst der
 * zuletzt benutzte (localStorage), sonst «Räume» (§10). Ein Kalender-Link
 * auf einen Raum (?id=… ohne tab) landet immer bei den Räumen.
 */

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Building2, GraduationCap, Megaphone } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { TabsNav } from "@/components/ui/tabs-nav";
import { useBreadcrumbs } from "@/components/shell/breadcrumbs";
import { RaeumeAnsicht } from "@/components/vertrieb/raeume-ansicht";
import { KampagneAnsicht } from "@/components/vertrieb/kampagne-ansicht";
import type { VertriebKampagne } from "@/types/vertrieb";

const TAB_SPEICHER = "vertrieb-tab";
/** URL-Parameter, die nur innerhalb eines Tabs gelten — beim Wechsel weg. */
const TAB_PARAMETER = ["id", "k", "status", "gruppe", "q"];

function kampagnenIcon(name: string) {
  return /schul/i.test(name) ? <GraduationCap className="h-4 w-4" /> : <Megaphone className="h-4 w-4" />;
}

export default function VertriebPage() {
  useBreadcrumbs([{ label: "Vertrieb" }]);
  const searchParams = useSearchParams();
  const [kampagnen, setKampagnen] = useState<VertriebKampagne[] | null>(null);
  const [tab, setTab] = useState<string>(() => {
    const ausUrl = searchParams.get("tab");
    if (ausUrl) return ausUrl;
    if (searchParams.get("id")) return "raeume";
    if (typeof window === "undefined") return "raeume";
    try { return localStorage.getItem(TAB_SPEICHER) ?? "raeume"; } catch { return "raeume"; }
  });

  useEffect(() => {
    let aktiv = true;
    void createClient()
      .from("vertrieb_kampagnen")
      .select("id, name, beschreibung, gruppe_label, sortierung, aktiv")
      .eq("aktiv", true)
      .order("sortierung")
      .order("name")
      .then(({ data, error }) => {
        if (!aktiv) return;
        // PGRST205 = Tabelle fehlt (Migration 364 noch nicht eingespielt) —
        // dann gibt es eben nur die Räume, ohne Fehlermeldung.
        if (error && error.code !== "PGRST205") toast.error(`Kampagnen laden fehlgeschlagen: ${error.message}`);
        setKampagnen((data ?? []) as VertriebKampagne[]);
      });
    return () => { aktiv = false; };
  }, []);

  // Unbekannter/inaktiver Tab (z. B. alte URL) → Räume.
  const kampagne = kampagnen?.find((k) => k.id === tab) ?? null;
  const gueltigerTab = tab === "raeume" || kampagnen === null || kampagne ? tab : "raeume";

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("tab") !== gueltigerTab) {
      url.searchParams.set("tab", gueltigerTab);
      window.history.replaceState({}, "", url.toString());
    }
    try { localStorage.setItem(TAB_SPEICHER, gueltigerTab); } catch { /* privat-Modus */ }
  }, [gueltigerTab]);

  function wechsle(neu: string) {
    if (neu === gueltigerTab) return;
    const url = new URL(window.location.href);
    for (const p of TAB_PARAMETER) url.searchParams.delete(p);
    url.searchParams.set("tab", neu);
    window.history.replaceState({}, "", url.toString());
    setTab(neu);
  }

  const tabs = [
    { key: "raeume", label: "Räume", icon: <Building2 className="h-4 w-4" /> },
    ...(kampagnen ?? []).map((k) => ({ key: k.id, label: k.name, icon: kampagnenIcon(k.name) })),
  ];

  return (
    <div className={`page-enter flex flex-col gap-3 ${gueltigerTab === "raeume" ? "h-[calc(100vh-64px)]" : ""}`}>
      <h1 className="shrink-0 text-2xl font-bold tracking-tight">Vertrieb</h1>
      <TabsNav tabs={tabs} active={gueltigerTab} onChange={wechsle} className="shrink-0" ariaLabel="Vertrieb" />
      {gueltigerTab === "raeume" ? (
        <RaeumeAnsicht />
      ) : kampagne ? (
        <KampagneAnsicht key={kampagne.id} kampagne={kampagne} />
      ) : null}
    </div>
  );
}
