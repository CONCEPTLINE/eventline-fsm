"use client";

/**
 * «Mein Konto» als Startpunkt der Person (Laptop + Handy):
 *   Melden          4 Kacheln + «Anderes melden» (MeldenKacheln)
 *   Meine Anfragen  die letzten drei (offene zuerst) + «Alle Anfragen ›»
 *   Links           Stempelzeiten (Stunden diesen Monat), Abwesenheit,
 *                   Lohn («n neu» = noch nie geoeffnete Lohndokumente)
 *
 * Daten: /api/mein-konto/uebersicht. Neu geladen nach eigener Meldung
 * (ANFRAGEN_GEAENDERT_EVENT), bei Ticket-Aenderungen (realtime:tickets) und
 * wenn der Tab zurueckkommt — kein fester Ticker.
 */

import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Clock, Inbox, Palmtree, Plus, Wallet, type LucideIcon } from "lucide-react";
import { PrefetchLink } from "@/components/shell/prefetch-link";
import { AnderesMeldenKnopf, MeldenKacheln } from "@/components/melden/melden-kacheln";
import { FLAECHE, Karte } from "@/components/dashboard/karte";
import { ANFRAGEN_GEAENDERT_EVENT } from "@/lib/melden";
import { ART_LABEL, type Anfrage, type AnfrageTon } from "@/lib/anfragen";
import { Skeleton } from "@/components/ui/skeleton";
import { TextLink } from "@/components/ui/text-knopf";

/** Ziel von «Alle Anfragen». */
export const ALLE_ANFRAGEN_HREF = "/anfragen";

interface Uebersicht {
  anfragen: Anfrage[];
  offen: number;
  minuten_monat: number;
  lohn_neu: number;
}

export function useKontoUebersicht() {
  const [daten, setDaten] = useState<Uebersicht | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);

  const laden = useCallback(async () => {
    try {
      const res = await fetch("/api/mein-konto/uebersicht", { cache: "no-store" });
      const json = await res.json().catch(() => ({}));
      if (!json.success) throw new Error(json.error ?? "Übersicht konnte nicht geladen werden");
      setDaten(json as Uebersicht);
      setFehler(null);
    } catch (e) {
      setFehler(e instanceof Error ? e.message : "Übersicht konnte nicht geladen werden");
    }
  }, []);

  useEffect(() => {
    // Erster Abruf als Callback (nicht synchron im Effekt).
    const erst = setTimeout(() => { void laden(); }, 0);
    const neu = () => { void laden(); };
    const sichtbar = () => { if (document.visibilityState === "visible") void laden(); };
    window.addEventListener(ANFRAGEN_GEAENDERT_EVENT, neu);
    window.addEventListener("realtime:tickets", neu);
    window.addEventListener("time_off:invalidate", neu);
    document.addEventListener("visibilitychange", sichtbar);
    return () => {
      clearTimeout(erst);
      window.removeEventListener(ANFRAGEN_GEAENDERT_EVENT, neu);
      window.removeEventListener("realtime:tickets", neu);
      window.removeEventListener("time_off:invalidate", neu);
      document.removeEventListener("visibilitychange", sichtbar);
    };
  }, [laden]);

  return { daten, fehler, laden };
}

const TON: Record<AnfrageTon, string> = {
  amber: "bg-amber-50 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200",
  green: "bg-green-50 text-green-800 dark:bg-green-500/20 dark:text-green-200",
  red: "bg-red-50 text-red-700 dark:bg-red-500/20 dark:text-red-200",
  muted: "bg-muted text-muted-foreground",
};

export function StandPille({ ton, children }: { ton: AnfrageTon; children: React.ReactNode }) {
  return (
    <span className={`inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[12px] font-medium ${TON[ton]}`}>
      {children}
    </span>
  );
}

function stunden(minuten: number): string {
  const h = Math.floor(minuten / 60);
  const m = minuten % 60;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")}`;
}

function Abschnitt({ titel, rechts, children }: { titel: string; rechts?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 px-1">
        <h2 className="text-[12px] font-bold uppercase tracking-wider text-muted-foreground">{titel}</h2>
        {rechts}
      </div>
      {children}
    </section>
  );
}

/** Zeilen-Rahmen: am Handy die gruppierte Liste (Rand, Hintergrund — wie
 *  ferien-mobil), am Laptop liegen die Zeilen direkt in der Karte. */
function ZeilenRahmen({ breit, children }: { breit: boolean; children: React.ReactNode }) {
  if (breit) return <div className="flex flex-col">{children}</div>;
  return <div className="overflow-hidden rounded-xl border border-border bg-card">{children}</div>;
}

/** Zeilen-Klassen: Handy randbuendig (Flaeche nach innen), Laptop wie die
 *  Dashboard-Zeilen (Flaeche ragt seitlich 0.5rem hinaus). */
function zeileKlasse(breit: boolean): string {
  return breit
    ? "row-hover flex min-h-[42px] items-center gap-3 border-t border-border text-sm first:border-t-0"
    : "row-hover [--row-hover-x:0.5rem] flex min-h-[42px] items-center gap-3 border-t border-border px-4 first:border-t-0";
}

function AnfragenKurz({ daten, fehler, breit }: { daten: Uebersicht | null; fehler: string | null; breit: boolean }) {
  if (fehler && !daten) {
    return breit
      ? <p className="text-sm text-red-600 dark:text-red-400">{fehler}</p>
      : <p className="rounded-xl border border-border bg-card px-4 py-3 text-[13px] text-red-600 dark:text-red-400">{fehler}</p>;
  }
  if (!daten) {
    return breit ? (
      <div className="space-y-2">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[34px]" />)}
      </div>
    ) : (
      <div className="space-y-px overflow-hidden rounded-xl border border-border bg-card">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[42px] rounded-none" />)}
      </div>
    );
  }
  if (daten.anfragen.length === 0) {
    return (
      <div className={breit
        ? `flex items-center gap-3 rounded-xl px-4 py-3 text-sm text-muted-foreground ${FLAECHE}`
        : "flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-[13px] text-muted-foreground"}
      >
        <Inbox className="h-4 w-4 shrink-0" />
        Noch nichts gemeldet.
      </div>
    );
  }
  return (
    <ZeilenRahmen breit={breit}>
      {daten.anfragen.map((a) => (
        // Tickets oeffnen ihre Detailseite, Abwesenheiten/Krank die Liste
        // (dort: Wieder gesund, Arztzeugnis, Zurückziehen).
        <PrefetchLink key={a.key} href={a.link ?? ALLE_ANFRAGEN_HREF} className={`${zeileKlasse(breit)} ${breit ? "" : "text-[14px]"}`}>
          <span className="min-w-0 flex-1 truncate">
            <span className="font-medium">{ART_LABEL[a.art]}</span>
            <span className="text-muted-foreground"> · {a.was}</span>
          </span>
          <StandPille ton={a.ton}>{a.stand}</StandPille>
        </PrefetchLink>
      ))}
    </ZeilenRahmen>
  );
}

function LinkZeile({ href, icon: Icon, label, wert, wertRot, breit }: {
  href: string; icon: LucideIcon; label: string; wert?: string | null; wertRot?: boolean; breit: boolean;
}) {
  return (
    <PrefetchLink href={href} className={`${zeileKlasse(breit)} ${breit ? "" : "text-[15px]"}`}>
      <Icon className={`${breit ? "h-4 w-4" : "h-5 w-5"} shrink-0 text-muted-foreground`} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {wert && (
        <span className={`shrink-0 ${breit ? "text-xs" : "text-[13px]"} ${wertRot ? "font-semibold text-red-600 dark:text-red-400" : "text-muted-foreground"}`}>
          {wert}
        </span>
      )}
      <ChevronRight className={`${breit ? "h-4 w-4" : "h-5 w-5"} shrink-0 text-muted-foreground/60`} />
    </PrefetchLink>
  );
}

function ZeitUndLohn({ daten, breit }: { daten: Uebersicht | null; breit: boolean }) {
  return (
    <ZeilenRahmen breit={breit}>
      <LinkZeile breit={breit} href="/stempelzeiten" icon={Clock} label="Stempelzeiten" wert={daten ? `${stunden(daten.minuten_monat)} diesen Monat` : null} />
      <LinkZeile breit={breit} href="/ferien" icon={Palmtree} label="Abwesenheit" />
      <LinkZeile
        breit={breit}
        href="/lohn"
        icon={Wallet}
        label="Lohn"
        wert={daten && daten.lohn_neu > 0 ? `${daten.lohn_neu} neu` : null}
        wertRot
      />
    </ZeilenRahmen>
  );
}

/** Melden + Meine Anfragen + Links. `breit` (Laptop): Karten wie im
 *  Dashboard (Karte: Titel mit Icon, rechts der Text-Link), Anfragen und
 *  Links nebeneinander. Sonst (Handy): Mini-Label + gruppierte Liste wie
 *  die anderen Handy-Seiten (ferien-mobil). */
export function KontoHub({ breit = false }: { breit?: boolean }) {
  const { daten, fehler } = useKontoUebersicht();

  const alleAnfragen = (
    <TextLink href={ALLE_ANFRAGEN_HREF} className={breit ? "text-xs font-medium text-muted-foreground" : "text-[13px] text-muted-foreground"}>
      Alle Anfragen ›
    </TextLink>
  );

  if (breit) {
    return (
      <div className="space-y-5">
        <Karte titel="Melden" icon={Plus} rechts={<AnderesMeldenKnopf className="text-xs font-medium text-muted-foreground" />}>
          <MeldenKacheln flaeche />
        </Karte>
        <div className="grid gap-5 lg:grid-cols-2 lg:items-start">
          <Karte titel="Meine Anfragen" icon={Inbox} rechts={alleAnfragen}>
            <AnfragenKurz daten={daten} fehler={fehler} breit />
          </Karte>
          <Karte titel="Meine Zeit & Lohn" icon={Wallet}>
            <ZeitUndLohn daten={daten} breit />
          </Karte>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <Abschnitt titel="Melden">
        <MeldenKacheln />
      </Abschnitt>
      <Abschnitt titel="Meine Anfragen" rechts={alleAnfragen}>
        <AnfragenKurz daten={daten} fehler={fehler} breit={false} />
      </Abschnitt>
      <Abschnitt titel="Meine Zeit & Lohn">
        <ZeitUndLohn daten={daten} breit={false} />
      </Abschnitt>
    </div>
  );
}
