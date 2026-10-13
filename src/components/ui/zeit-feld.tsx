"use client";

/**
 * Uhrzeit-Feld mit Zifferntastatur — ersetzt app-weit <input type="time">
 * (Handy-Politur 2026-10-14).
 *
 * Warum: type="time" oeffnet am Android-Handy statt der Tastatur einen
 * Uhr-Dialog bzw. am Samsung teils gar nichts — Leo/Mischa: «es kommt
 * einfach kein Keyboard» (z. B. Anwesenheitskalender). ZeitFeld ist ein
 * Textfeld mit inputMode="numeric": man tippt «0930» oder «930» und sieht
 * «09:30»; «9» oder «17» wird beim Verlassen zu «09:00» / «17:00».
 *
 * Wert-Vertrag wie type="time": immer "HH:MM" oder "" — nur onChange
 * liefert direkt den String statt eines Events.
 *  - Waehrend des Tippens geht onChange nur bei vier gueltigen Ziffern raus
 *    (eindeutig fertig) — keine Zwischenwerte wie «223» → 02:23, die z. B.
 *    die Benachrichtigungs-Einstellungen sofort speichern wuerden.
 *  - Beim Verlassen wird normalisiert (Stunde allein, 3 Ziffern, Raster
 *    `schrittMin`); Ungueltiges (25:00, 9:75) springt zurueck. Ein Knopf-
 *    Tipp verlaesst das Feld vor dem Klick — Speichern sieht den Wert.
 *  - Ausserhalb des Fokus zeigt das Feld immer den `value` von aussen —
 *    auch wenn der Aufrufer eine Eingabe nicht uebernimmt (z. B. Zeit ohne
 *    Datum im Ticket), wie beim alten type="time".
 */

import * as React from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Props = Omit<
  React.ComponentProps<"input">,
  "type" | "value" | "defaultValue" | "onChange" | "step" | "inputMode" | "maxLength"
> & {
  value: string;
  onChange: (wert: string) => void;
  /** Raster in Minuten (15, 60 …): beim Verlassen auf das naechste Raster runden. */
  schrittMin?: number;
  /** Ohne das <Input>-Grundstyling — nur die eigene className (z. B. FELD im Handy-Rapport). */
  eigenesStyling?: boolean;
};

/** Nur die Ziffern, hoechstens vier («09:30» → «0930»). */
function ziffern(s: string): string {
  return s.replace(/\D/g, "").slice(0, 4);
}

/** Anzeige beim Tippen: ab 3 Ziffern sind die letzten zwei die Minuten. */
function tippAnzeige(z: string): string {
  return z.length <= 2 ? z : `${z.slice(0, -2)}:${z.slice(-2)}`;
}

/**
 * Ziffern → "HH:MM" oder null. `nurStunde` erlaubt 1–2 Ziffern als volle
 * Stunde (erst beim Verlassen — beim Tippen koennte noch mehr kommen).
 */
function parse(z: string, nurStunde: boolean): string | null {
  let h: number;
  let m: number;
  if (z.length >= 3) {
    h = Number(z.slice(0, -2));
    m = Number(z.slice(-2));
  } else if (nurStunde && z.length > 0) {
    h = Number(z);
    m = 0;
  } else {
    return null;
  }
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Auf das Minuten-Raster runden, hoechstens auf den letzten Rasterpunkt des Tages. */
function aufRaster(hhmm: string, schrittMin: number): string {
  const min = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
  const letzter = Math.floor((24 * 60 - 1) / schrittMin) * schrittMin;
  const gerundet = Math.min(letzter, Math.round(min / schrittMin) * schrittMin);
  return `${String(Math.floor(gerundet / 60)).padStart(2, "0")}:${String(gerundet % 60).padStart(2, "0")}`;
}

export function ZeitFeld({
  value,
  onChange,
  schrittMin,
  eigenesStyling,
  className,
  placeholder = "hh:mm",
  onFocus,
  onBlur,
  ...rest
}: Props) {
  const [entwurf, setEntwurf] = React.useState(value);
  const [fokus, setFokus] = React.useState(false);

  // Ausserhalb des Fokus gilt der Wert von aussen (Reset, anderer Tag …).
  // Haengt auch an `fokus`: nach dem Verlassen zeigt das Feld, was der
  // Aufrufer tatsaechlich uebernommen hat, nicht nur das Getippte.
  React.useEffect(() => {
    if (!fokus) setEntwurf(value);
  }, [value, fokus]);

  function aendern(e: React.ChangeEvent<HTMLInputElement>) {
    const roh = e.target.value;
    // Loeschen: so stehen lassen, wie getippt — sonst springt der
    // Doppelpunkt beim Zuruecksetzen hin und her («09:3» → «0:93»).
    // inputType statt Laengenvergleich: Ueberschreiben der markierten
    // Zeit mit einer Ziffer ist kuerzer, aber kein Loeschen.
    const loeschen = (e.nativeEvent as InputEvent).inputType?.startsWith("delete") ?? false;
    if (loeschen) {
      setEntwurf(roh.replace(/[^\d:]/g, ""));
    } else {
      setEntwurf(tippAnzeige(ziffern(roh)));
    }
    const z = ziffern(roh);
    const zeit = z.length === 4 ? parse(z, false) : null;
    if (zeit && zeit !== value) onChange(zeit);
  }

  function verlassen(e: React.FocusEvent<HTMLInputElement>) {
    setFokus(false);
    const z = ziffern(entwurf);
    if (z === "") {
      setEntwurf("");
      if (value !== "") onChange("");
    } else {
      let zeit = parse(z, true);
      if (zeit && schrittMin) zeit = aufRaster(zeit, schrittMin);
      if (zeit) {
        setEntwurf(zeit);
        if (zeit !== value) onChange(zeit);
      } else {
        setEntwurf(value);
      }
    }
    onBlur?.(e);
  }

  const props = {
    ...rest,
    type: "text",
    inputMode: "numeric" as const,
    autoComplete: "off",
    enterKeyHint: "next" as const,
    maxLength: 5,
    pattern: "[0-2][0-9]:[0-5][0-9]",
    placeholder,
    value: entwurf,
    onChange: aendern,
    onFocus: (e: React.FocusEvent<HTMLInputElement>) => {
      setFokus(true);
      // Alles markieren: Tippen ersetzt die Zeit, statt anzuhaengen.
      e.currentTarget.select();
      onFocus?.(e);
    },
    onBlur: verlassen,
  };

  if (eigenesStyling) return <input {...props} className={cn("tabular-nums", className)} />;
  return <Input {...props} className={cn("tabular-nums", className)} />;
}
