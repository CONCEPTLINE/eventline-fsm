// 2D-Aufbauplanung: der ECHTE Saalplan der Location als massstaebliche
// Unterlage, darauf werden Material und freie Objekte platziert.
// Koordinaten: PLAN-PIXEL der Unterlage (Ursprung oben links); der
// Massstab px_pro_meter macht Objekte massstabsgerecht.

/** locations.plan_unterlage */
export type PlanUnterlage = {
  /** Storage-Pfad des gerenderten Plan-Bilds (documents-Bucket). */
  path: string;
  breite_px: number;
  hoehe_px: number;
  /** Pixel pro Meter — aus der 2-Punkte-Kalibrierung. null = noch nicht kalibriert. */
  px_pro_meter: number | null;
  /** Quelldokument (Anzeigename), rein informativ. */
  quelle: string | null;
  /** Storage-Pfad des Original-PDFs (wenn die Unterlage aus einem PDF
   *  stammt) — die Auto-Kalibrierung extrahiert daraus serverseitig
   *  Text-Anker mit EXAKTEN Koordinaten (Vektor-PDF = pixelgenau). */
  quelle_pdf_path?: string | null;
};

/** Platzierung einer Material-Instanz auf dem Plan (job_material.position[i]). */
export type PlanPos = { x: number; y: number; rot: number };

/** Freies Plan-Objekt (job_plan_objekte-Row). */
export type PlanObjekt = {
  id: string;
  typ: "pa" | "stagebox" | "stativ" | "podest" | "tisch" | "text";
  label: string | null;
  x: number;
  y: number;
  rot: number;
  /** Masse in Metern (nur fuer flaechige Typen). */
  breite: number | null;
  tiefe: number | null;
};

export const OBJEKT_BIBLIOTHEK: { typ: PlanObjekt["typ"]; label: string; breite: number | null; tiefe: number | null }[] = [
  { typ: "pa", label: "PA", breite: 0.6, tiefe: 0.5 },
  { typ: "stagebox", label: "Stagebox", breite: 0.45, tiefe: 0.35 },
  { typ: "stativ", label: "Stativ", breite: 0.4, tiefe: 0.4 },
  { typ: "podest", label: "Podest", breite: 2, tiefe: 1 },
  { typ: "tisch", label: "Tisch", breite: 1.8, tiefe: 0.8 },
  { typ: "text", label: "Beschriftung", breite: null, tiefe: null },
];

/** Form-Heuristik fuer Material-Positionen (aus der Bezeichnung). */
export function materialForm(bezeichnung: string): "podest" | "licht" | "flaeche" | "stativ" | "box" {
  const b = bezeichnung.toLowerCase();
  if (/podest|b(ue|ü)hne(nelement)?|rostra/.test(b)) return "podest";
  if (/scheinwerfer|spot|licht|lampe|par\b|movinghead|profiler|fresnel/.test(b)) return "licht";
  if (/leinwand|tuch|screen|stoff|vorhang|molton/.test(b)) return "flaeche";
  if (/stativ|staender|ständer|traverse/.test(b)) return "stativ";
  return "box";
}

/** Default-Masse (Meter) je Form, wenn keine bekannt. */
export function materialMasse(
  form: ReturnType<typeof materialForm>,
  masse: { l: number | null; b: number | null; h: number | null } | null,
): { l: number; b: number } {
  const d =
    form === "podest" ? { l: 2, b: 1 }
    : form === "licht" ? { l: 0.35, b: 0.35 }
    : form === "flaeche" ? { l: 4, b: 0.12 }
    : form === "stativ" ? { l: 0.4, b: 0.4 }
    : { l: 0.6, b: 0.6 };
  return { l: masse?.l ?? d.l, b: masse?.b ?? d.b };
}
