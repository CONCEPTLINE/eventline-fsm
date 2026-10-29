"use client";

/**
 * Eingabe für eine Korrekturfassung (Lohn-Umbau Phase 2): Begründung (Pflicht,
 * mind. 10 Zeichen) und optional ein Auszahlungsdatum (leer = mit dem
 * nächsten Lohn). Gemeinsam genutzt von «Monats-Abrechnung erzeugen» (weitere
 * Fassung) und den Korrektur-Vorschlägen.
 */

import { useId } from "react";
import { Input } from "@/components/ui/input";
import { formatChf, formatDateFull } from "@/lib/format";

export const KORREKTUR_MIN = 10;

export function KorrekturEingabe({
  begruendung, setBegruendung, datum, setDatum, disabled,
}: {
  begruendung: string;
  setBegruendung: (v: string) => void;
  datum: string;
  setDatum: (v: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const laenge = begruendung.trim().length;
  return (
    <div className="space-y-2">
      <div className="space-y-1">
        <label htmlFor={`${id}-b`} className="text-[10px] text-muted-foreground/70 ml-1">
          Begründung (Pflicht, mind. {KORREKTUR_MIN} Zeichen)
        </label>
        <textarea
          id={`${id}-b`}
          value={begruendung}
          onChange={(e) => setBegruendung(e.target.value)}
          disabled={disabled}
          rows={3}
          maxLength={1000}
          placeholder="z. B. Nachtzuschlag 14.09. fehlte — Stempel nachträglich korrigiert"
          className="w-full px-3 py-2 text-sm rounded-lg border bg-background focus:outline-none focus:ring-2 focus:ring-ring/40 focus:border-ring resize-none"
        />
        {laenge < KORREKTUR_MIN && (
          <p className="text-[10px] text-muted-foreground ml-1">noch {KORREKTUR_MIN - laenge} Zeichen</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${id}-d`} className="text-[10px] text-muted-foreground/70 ml-1 shrink-0">Auszahlungsdatum</label>
        <Input
          id={`${id}-d`}
          type="date"
          value={datum}
          onChange={(e) => setDatum(e.target.value)}
          disabled={disabled}
          className="w-40"
        />
        <span className="text-[10px] text-muted-foreground">leer = mit dem nächsten Lohn</span>
      </div>
    </div>
  );
}

/** «Korrekturfassung 2: Nachzahlung CHF 12.35 am 07.12.2026» (negativ = Rückforderung). */
export function korrekturText(j: { fassung?: unknown; auszahlung?: unknown; auszahlungsdatum?: unknown }): string {
  const n = Number(j.auszahlung ?? 0);
  const am = typeof j.auszahlungsdatum === "string" && j.auszahlungsdatum ? ` am ${formatDateFull(j.auszahlungsdatum)}` : "";
  const was = !Number.isFinite(n) || Math.abs(n) < 0.005
    ? "keine Differenz"
    : n > 0
      ? `Nachzahlung ${formatChf(n)}${am}`
      : `Rückforderung ${formatChf(-n)}${am}`;
  return `Korrekturfassung ${j.fassung ?? "?"}: ${was}`;
}

/** Betrag mit Vorzeichen: «+CHF 12.35» / «−CHF 3.10». */
export function chfMitVorzeichen(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) < 0.005) return formatChf(0);
  return `${n > 0 ? "+" : "−"}${formatChf(Math.abs(n))}`;
}
