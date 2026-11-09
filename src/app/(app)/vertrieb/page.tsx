"use client";

/**
 * /vertrieb — Vertrieb neu (Leo 09.11.2026, Entwurf «A» im FSM-Design):
 *   Heute       — was heute zu tun ist (Wochenpaket freigeben, fällige
 *                 Schritte der Häuser, offene Antworten/Anrufe der Kampagnen)
 *   Pipeline    — alle Häuser nach Stufe (Liste/Tafel); über «Liste» oben
 *                 auch die Kampagnen (Schulen, Messe, Firmen & GV) mit der
 *                 bestehenden Kampagnen-Ansicht
 *   Haus-Profil — ein Haus: Stufe, Anruf erfassen, Bedarf, Kontakt,
 *                 Unterlagen, Verlauf
 *   Auswertung  — Kennzahlen, Prüftermine, Takt pro Woche, Gebiete, Rücklauf
 * Ersetzt die frühere «Übersicht» und den Reiter «Räume» (die Räume sind
 * jetzt die Häuser, Tabelle vertrieb_raeume, Migration 387).
 * Wer: vertrieb:view (lesen) / vertrieb:edit (ändern, freigeben). Laptop-Seite.
 *
 * Zustand in der URL (§10): ?tab=heute|pipeline|haus|auswertung, ?id=<haus>
 * (Haus-Profil, auch Kalender-/Suche-Link), ?paket=KW46 (Freigabe), dazu die
 * Filter der Pipeline. Alte Links (?tab=raeume, ?tab=<kampagne-id>,
 * ?tab=uebersicht) werden umgeleitet.
 */

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { BarChart3, Building2, ListChecks, Target } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { todayLocalIso } from "@/lib/swiss-time";
import { TabsNav } from "@/components/ui/tabs-nav";
import { useBreadcrumbs } from "@/components/shell/breadcrumbs";
import { useVertriebDaten } from "@/components/vertrieb/use-vertrieb-daten";
import { HeuteAnsicht } from "@/components/vertrieb/heute-ansicht";
import { FreigabeAnsicht } from "@/components/vertrieb/freigabe-ansicht";
import { PipelineAnsicht } from "@/components/vertrieb/pipeline-ansicht";
import { HausProfil } from "@/components/vertrieb/haus-profil";
import { AuswertungAnsicht } from "@/components/vertrieb/auswertung-ansicht";
import type { VertriebKampagne } from "@/types/vertrieb";

type Tab = "heute" | "pipeline" | "haus" | "auswertung";
const TABS: Tab[] = ["heute", "pipeline", "haus", "auswertung"];
const TAB_SPEICHER = "vertrieb-tab";
/** Parameter, die nur innerhalb eines Reiters gelten — beim Wechsel weg. */
const REITER_PARAMETER = ["paket", "k", "status", "gruppe", "q"];

function startTab(sp: URLSearchParams): { tab: Tab; liste: string | null } {
  const t = sp.get("tab");
  if (t && (TABS as string[]).includes(t)) return { tab: t as Tab, liste: null };
  if (t === "raeume") return { tab: "pipeline", liste: null };
  if (t === "uebersicht") return { tab: "heute", liste: null };
  // Alte Kampagnen-Links: ?tab=<kampagne-id> → Pipeline mit dieser Liste.
  if (t) return { tab: "pipeline", liste: t };
  if (sp.get("id")) return { tab: "haus", liste: null };
  if (typeof window === "undefined") return { tab: "heute", liste: null };
  try {
    const s = localStorage.getItem(TAB_SPEICHER);
    return { tab: s && (TABS as string[]).includes(s) ? (s as Tab) : "heute", liste: null };
  } catch {
    return { tab: "heute", liste: null };
  }
}

export default function VertriebPage() {
  useBreadcrumbs([{ label: "Vertrieb" }]);
  const searchParams = useSearchParams();
  const [start] = useState(() => startTab(new URLSearchParams(searchParams.toString())));
  const [tab, setTab] = useState<Tab>(start.tab);
  const [liste, setListe] = useState<string>(() => start.liste ?? searchParams.get("liste") ?? "haeuser");
  const [hausId, setHausId] = useState<string | null>(() => searchParams.get("id"));
  const [paket, setPaket] = useState<string | null>(() => searchParams.get("paket"));
  const [kampagnen, setKampagnen] = useState<VertriebKampagne[]>([]);
  const daten = useVertriebDaten();

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
        if (error && error.code !== "PGRST205") toast.error(`Kampagnen laden fehlgeschlagen: ${error.message}`);
        setKampagnen((data ?? []) as VertriebKampagne[]);
      });
    return () => { aktiv = false; };
  }, []);

  // URL nachführen (§10).
  useEffect(() => {
    const url = new URL(window.location.href);
    const setze = (k: string, v: string | null) => (v ? url.searchParams.set(k, v) : url.searchParams.delete(k));
    setze("tab", tab);
    setze("id", tab === "haus" ? hausId : null);
    setze("paket", tab === "heute" ? paket : null);
    setze("liste", tab === "pipeline" && liste !== "haeuser" ? liste : null);
    window.history.replaceState({}, "", url.toString());
    try { localStorage.setItem(TAB_SPEICHER, tab); } catch { /* privat-Modus */ }
  }, [tab, hausId, paket, liste]);

  function wechsle(neu: Tab) {
    if (neu === tab) {
      if (neu === "heute" && paket) setPaket(null);
      return;
    }
    const url = new URL(window.location.href);
    for (const p of REITER_PARAMETER) url.searchParams.delete(p);
    window.history.replaceState({}, "", url.toString());
    setPaket(null);
    setTab(neu);
  }

  function oeffneHaus(id: string) {
    setHausId(id);
    setTab("haus");
  }

  function oeffneKampagne(id: string, status?: string) {
    const url = new URL(window.location.href);
    for (const p of REITER_PARAMETER) url.searchParams.delete(p);
    if (status) url.searchParams.set("status", status);
    window.history.replaceState({}, "", url.toString());
    setListe(id);
    setTab("pipeline");
  }

  const offenePakete = new Set(daten.pakete.filter((p) => p.status === "offen").map((p) => p.kw));
  const faelligHaeuser = (daten.haeuser ?? []).filter((h) => h.datum && h.datum <= todayLocalIso() && h.stufe !== "absage" && h.stufe !== "pause").length;
  const heuteBadge = offenePakete.size + faelligHaeuser + (daten.uebersicht?.achtung.antworten_offen ? 1 : 0) + (daten.uebersicht?.achtung.anrufen ? 1 : 0);

  const tabs = [
    { key: "heute", label: "Heute", icon: <ListChecks className="h-4 w-4" />, badge: heuteBadge || undefined },
    { key: "pipeline", label: "Pipeline", icon: <Building2 className="h-4 w-4" /> },
    { key: "haus", label: "Haus-Profil", icon: <Target className="h-4 w-4" /> },
    { key: "auswertung", label: "Auswertung", icon: <BarChart3 className="h-4 w-4" /> },
  ];

  return (
    <div className="page-enter flex flex-col gap-3">
      <h1 className="shrink-0 text-2xl font-bold tracking-tight">Vertrieb</h1>
      <TabsNav tabs={tabs} active={tab} onChange={(k) => wechsle(k as Tab)} className="shrink-0" ariaLabel="Vertrieb" />
      {daten.migrationFehlt && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300">
          Die Häuser-Tabellen sind noch nicht eingerichtet (Migration 387). Bis dahin bleiben Häuser, Verlauf und Wochenpaket leer.
        </p>
      )}
      {daten.zuViele && (
        <p className="text-xs text-muted-foreground">Mehr als 1000 Häuser — es werden nur die ersten 1000 gezeigt.</p>
      )}
      {tab === "heute" && (paket ? (
        <FreigabeAnsicht
          kw={paket}
          haeuser={daten.haeuser ?? []}
          onZurueck={() => setPaket(null)}
          onGeaendert={() => void daten.neuLaden()}
        />
      ) : (
        <HeuteAnsicht
          haeuser={daten.haeuser}
          pakete={daten.pakete}
          antworten={daten.antworten}
          uebersicht={daten.uebersicht}
          onHaus={oeffneHaus}
          onPaket={setPaket}
          onKampagne={oeffneKampagne}
        />
      ))}
      {tab === "pipeline" && (
        <PipelineAnsicht
          haeuser={daten.haeuser}
          kampagnen={kampagnen}
          liste={liste}
          onListe={setListe}
          onHaus={oeffneHaus}
          onAngelegt={(h) => { daten.setHaeuser((prev) => [...(prev ?? []), h]); oeffneHaus(h.id); }}
        />
      )}
      {tab === "haus" && (
        <HausProfil
          key={hausId ?? "leer"}
          haus={(daten.haeuser ?? []).find((h) => h.id === hausId) ?? null}
          laedt={daten.haeuser === null}
          onZurPipeline={() => wechsle("pipeline")}
          onLokal={daten.aendereLokal}
          onNeuLaden={() => void daten.neuLaden()}
          onGeloescht={(id) => { daten.setHaeuser((prev) => prev?.filter((h) => h.id !== id) ?? prev); setHausId(null); wechsle("pipeline"); }}
        />
      )}
      {tab === "auswertung" && (
        <AuswertungAnsicht
          haeuser={daten.haeuser}
          mails={daten.mails}
          pakete={daten.pakete}
          uebersicht={daten.uebersicht}
        />
      )}
    </div>
  );
}
