"use client";

/**
 * FinanzenUebersicht — laedt beim Mount parallel die sechs Finanz-Routen
 * (finanzenFetch) und haelt je Abschnitt laden | daten | fehler.
 *
 * Reihenfolge von oben: SyncKopf → Kennzahlen → UmsatzChart → OffenePosten →
 * Kreditoren → Bankkonten. Nach erfolgreichem manuellem Abgleich laedt der
 * SyncKopf alles neu (onAktualisiert). Laeuft das Step-up-Ticket ab,
 * antworten alle Fetches mit stepup_required — finanzenFetch dedupliziert den
 * Toast per id, der StepUpGate blendet die Uebersicht aus und laedt sie nach
 * der Bestaetigung neu ein (→ useEffect laedt erneut).
 */

import { useCallback, useEffect, useRef, useState } from "react";
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

  return (
    <div className="space-y-6">
      <SyncKopf abschnitt={sync} onErneut={ladeSync} onAktualisiert={ladeAlles} />
      <Kennzahlen abschnitt={kennzahlen} onErneut={ladeKennzahlen} />
      <UmsatzChart abschnitt={umsatz} onErneut={ladeUmsatz} />
      <OffenePosten abschnitt={debitoren} onErneut={ladeDebitoren} />
      <Kreditoren abschnitt={kreditoren} onErneut={ladeKreditoren} />
      <Bankkonten abschnitt={bankkonten} onErneut={ladeBankkonten} />
    </div>
  );
}

/** Sektions-Label wie Abrechnung (text-[11px] uppercase tracking-wider). */
export function SektionsLabel({ children, rechts }: { children: React.ReactNode; rechts?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</h2>
      {rechts}
    </div>
  );
}

/** Fehlerzeile eines Abschnitts: der Toast kam aus finanzenFetch, hier nur
 *  der Weg zurueck. */
export function AbschnittFehler({ onErneut }: { onErneut: () => void }) {
  return (
    <div className="rounded-xl border border-dashed bg-card px-4 py-3 flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground">Konnte nicht geladen werden.</p>
      <button type="button" onClick={onErneut} className="kasten kasten-muted">
        Erneut laden
      </button>
    </div>
  );
}
