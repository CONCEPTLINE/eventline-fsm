"use client";

import { Printer } from "lucide-react";

/**
 * PrintButton — triggert window.print(). Nutzer waehlt im Print-Dialog
 * 'Als PDF speichern' und bekommt das Report als PDF-File.
 * Green (non-destruktiv, Primaeraktion) — rot ist im Kasten-System
 * ausschliesslich destruktiven Aktionen vorbehalten.
 */
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="kasten kasten-green no-print"
      aria-label="Als PDF drucken/speichern"
    >
      <Printer className="h-4 w-4" />
      Als PDF drucken
    </button>
  );
}
