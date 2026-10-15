"use client";

/**
 * FinanzenUebersicht — Blick-Dashboard ohne Seiten-Scroll (Desktop).
 *
 * Laedt beim Mount parallel die sechs Finanz-Routen (finanzenFetch) und haelt
 * je Abschnitt laden | daten | fehler. Nach erfolgreichem manuellem Abgleich
 * laedt der SyncKopf alles neu (onAktualisiert). Fehler toastet finanzenFetch
 * (per id dedupliziert); der Abschnitt zeigt dann «Erneut laden».
 *
 * Raster (ab md): vier Zeilen «auto auto 1fr 1fr»
 *   A  Kopfzeile: H1 + Abgleich-Status/Knopf in EINER Linie (+ Hinweisleiste)
 *   B  vier Kennzahl-Kacheln
 *   C  Umsatz pro Monat (3) | Bankkonten (2)
 *   D  Offene Debitoren (1) | Kreditoren (1) — Listen scrollen INTERN
 * Hoehe: der Container misst beim Mount und bei resize seine Oberkante
 * (offsetTop-Kette, transform-fest wegen page-enter) und setzt
 * height = innerHeight − oben − unterer Huellen-Abstand. Unter MIN_HOEHE
 * darf die Seite scrollen. Handy (< md): gestapelt, Seite scrollt.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { todayLocalIso } from "@/lib/swiss-time";
import { finanzenFetch } from "@/components/finanzen/finanzen-fetch";
import { SyncKopf } from "@/components/finanzen/sync-kopf";
import { Kennzahlen } from "@/components/finanzen/kennzahlen";
import { UmsatzChart } from "@/components/finanzen/umsatz-chart";
import { OffenePosten } from "@/components/finanzen/offene-posten";
import { Kreditoren } from "@/components/finanzen/kreditoren";
import { Bankkonten } from "@/components/finanzen/bankkonten";
import type {
  BankkontenAntwort,
  KreditorenAntwort,
  OffenePostenAntwort,
  SyncStatusAntwort,
  UebersichtAntwort,
  UmsatzAntwort,
} from "@/lib/finanzen/types";

/** Zustand eines Abschnitts. `fehler` traegt keinen Text — der Toast kam
 *  schon aus finanzenFetch; der Abschnitt zeigt nur «Erneut laden». */
export type Abschnitt<T> =
  | { status: "laden" }
  | { status: "daten"; data: T }
  | { status: "fehler" };

const LADEN = { status: "laden" } as const;

/** Unter dieser Hoehe wird nicht mehr gequetscht — die Seite scrollt. */
const MIN_HOEHE = 520;
/** Unterer Abstand der Huelle (main md:pb-8 = 2 rem). */
const HUELLE_UNTEN = 32;
/** Raster-Zeilen: Kopf, Kacheln, zwei streckbare Zeilen. */
export const RASTER_ZEILEN = "auto auto minmax(0,1fr) minmax(0,1fr)";

/** Oberkante relativ zum Dokument ueber die offsetParent-Kette — anders als
 *  getBoundingClientRect unbeeinflusst vom translateY der page-enter-Animation. */
function offsetOben(el: HTMLElement): number {
  let y = 0;
  let n: HTMLElement | null = el;
  while (n) {
    y += n.offsetTop;
    n = n.offsetParent as HTMLElement | null;
  }
  return y;
}

export function FinanzenUebersicht() {
  const [sync, setSync] = useState<Abschnitt<SyncStatusAntwort>>(LADEN);
  const [kennzahlen, setKennzahlen] = useState<Abschnitt<UebersichtAntwort>>(LADEN);
  const [umsatz, setUmsatz] = useState<Abschnitt<UmsatzAntwort>>(LADEN);
  const [debitoren, setDebitoren] = useState<Abschnitt<OffenePostenAntwort>>(LADEN);
  const [kreditoren, setKreditoren] = useState<Abschnitt<KreditorenAntwort>>(LADEN);
  const [bankkonten, setBankkonten] = useState<Abschnitt<BankkontenAntwort>>(LADEN);
  // Jahr der Umsatz-Abfrage: laufendes Jahr im Zuerich-Kalender.
  const jahrRef = useRef(Number(todayLocalIso().slice(0, 4)));

  // Generischer Lader: ein Abschnitt, eine Route. Unmount-sicher via
  // mounted-Ref (ein spaeter Response setzt keinen State mehr).
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const lade = useCallback(async <T,>(url: string, set: (a: Abschnitt<T>) => void) => {
    set(LADEN);
    const r = await finanzenFetch<T>(url);
    if (!mounted.current) return;
    set(r.ok ? { status: "daten", data: r.data } : { status: "fehler" });
  }, []);

  const ladeSync = useCallback(() => lade<SyncStatusAntwort>("/api/finanzen/sync-status", setSync), [lade]);
  const ladeKennzahlen = useCallback(() => lade<UebersichtAntwort>("/api/finanzen/uebersicht", setKennzahlen), [lade]);
  const ladeUmsatz = useCallback(() => lade<UmsatzAntwort>(`/api/finanzen/umsatz?jahr=${jahrRef.current}`, setUmsatz), [lade]);
  const ladeDebitoren = useCallback(() => lade<OffenePostenAntwort>("/api/finanzen/offene-posten", setDebitoren), [lade]);
  const ladeKreditoren = useCallback(() => lade<KreditorenAntwort>("/api/finanzen/kreditoren", setKreditoren), [lade]);
  const ladeBankkonten = useCallback(() => lade<BankkontenAntwort>("/api/finanzen/bankkonten", setBankkonten), [lade]);

  const ladeAlles = useCallback(() => {
    void Promise.all([ladeSync(), ladeKennzahlen(), ladeUmsatz(), ladeDebitoren(), ladeKreditoren(), ladeBankkonten()]);
  }, [ladeSync, ladeKennzahlen, ladeUmsatz, ladeDebitoren, ladeKreditoren, ladeBankkonten]);

  useEffect(() => { ladeAlles(); }, [ladeAlles]);

  // Fit-to-Viewport (nur ab md): Hoehe vor dem ersten Paint setzen, bei
  // resize nachfuehren. null = Handy → gestapelt, natuerliche Hoehe.
  const rasterRef = useRef<HTMLDivElement>(null);
  const [hoehe, setHoehe] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = rasterRef.current;
    if (!el) return;
    const messen = () => {
      if (!window.matchMedia("(min-width: 768px)").matches) { setHoehe(null); return; }
      const frei = Math.floor(window.innerHeight - offsetOben(el) - HUELLE_UNTEN);
      setHoehe(Math.max(frei, MIN_HOEHE));
    };
    messen();
    window.addEventListener("resize", messen);
    return () => window.removeEventListener("resize", messen);
  }, []);

  return (
    <div
      ref={rasterRef}
      className="page-enter flex flex-col gap-3 md:grid md:min-h-0"
      style={{ gridTemplateRows: RASTER_ZEILEN, height: hoehe ? `${hoehe}px` : undefined }}
    >
      <SyncKopf
        links={<h1 className="text-2xl font-bold tracking-tight">Finanzen</h1>}
        abschnitt={sync}
        onErneut={ladeSync}
        onAktualisiert={ladeAlles}
      />
      <Kennzahlen abschnitt={kennzahlen} onErneut={ladeKennzahlen} />
      <div className="grid gap-3 min-h-0 min-w-0 md:grid-cols-[3fr_2fr]">
        <UmsatzChart abschnitt={umsatz} onErneut={ladeUmsatz} />
        <Bankkonten abschnitt={bankkonten} onErneut={ladeBankkonten} />
      </div>
      <div className="grid gap-3 min-h-0 min-w-0 md:grid-cols-2">
        <OffenePosten abschnitt={debitoren} onErneut={ladeDebitoren} />
        <Kreditoren abschnitt={kreditoren} onErneut={ladeKreditoren} />
      </div>
    </div>
  );
}

/** Sektions-Label wie Abrechnung (text-[11px] uppercase tracking-wider). */
export function SektionsLabel({ children, rechts }: { children: React.ReactNode; rechts?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 min-w-0 shrink-0">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground truncate">{children}</h2>
      {rechts}
    </div>
  );
}

/** Rahmen eines Abschnitts im Raster: Label oben, Inhalt fuellt die Zelle
 *  (min-h-0, damit Kinder intern scrollen koennen). */
export function RasterFeld({ label, rechts, children }: { label: React.ReactNode; rechts?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 min-h-0 min-w-0 md:h-full">
      <SektionsLabel rechts={rechts}>{label}</SektionsLabel>
      {children}
    </section>
  );
}

/** Leere Liste im Raster: EmptyState zentriert, Polster verkleinert, damit
 *  die Zelle bei 1366×768 nicht intern scrollt. */
export function LeerKarte({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed bg-card flex-1 min-h-0 flex items-center justify-center overflow-hidden [&>div]:py-4!">
      {children}
    </div>
  );
}

/** Fehlerzeile eines Abschnitts: der Toast kam aus finanzenFetch, hier nur
 *  der Weg zurueck. `inline` = ohne Karte (fuer die Kopfzeile). */
export function AbschnittFehler({ onErneut, inline }: { onErneut: () => void; inline?: boolean }) {
  const knopf = (
    <button type="button" onClick={onErneut} className="kasten kasten-muted">
      Erneut laden
    </button>
  );
  if (inline) {
    return (
      <div className="flex items-center gap-3">
        <p className="text-sm text-muted-foreground">Konnte nicht geladen werden.</p>
        {knopf}
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-dashed bg-card px-3 py-2 flex flex-wrap items-center justify-between gap-3 self-start">
      <p className="text-sm text-muted-foreground">Konnte nicht geladen werden.</p>
      {knopf}
    </div>
  );
}
