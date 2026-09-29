// Dokumenttypen der NAS-Ablage (Leo 2026-09-29): statt freiem Beschrieb
// ein gefuehrtes Schema — der Typ bestimmt, welche Zusatzangaben der
// Name braucht ("Folgefragen" als Formularfelder), und der Name wird
// DETERMINISTISCH daraus gebaut. BEWUSST OHNE KI: weder Datei-Inhalt
// noch Eingaben verlassen je das System; kein Raten, keine Ueberraschung.
//
// Namensschema:
//   <Dokument-Datum|heute> – <Typ> – <Betreff>[ – <Partei>][ – <Nr>]<.ext>
//   Typ "Sonstiges": <Datum> – <Beschrieb> – <Originalname>  (wie bisher)
//
// Wird von Client (Formular + Live-Vorschau) UND Server (Upload-Route
// baut den finalen Namen selbst — Client-Werte sind nur Eingaben)
// gleichermassen genutzt.

export interface DokTypFeld {
  /** Feld-Label, typ-spezifisch (z.B. "Versicherer" statt generisch "Partei"). */
  label: string;
  pflicht: boolean;
  placeholder?: string;
}

export interface DokTyp {
  key: string;
  label: string;
  /** Gegenpartei/Aussteller — null = Feld wird nicht angezeigt. */
  partei: DokTypFeld | null;
  /** Referenz-Nummer (Police/Vertrag/Rechnung) — null = nicht angezeigt. */
  nummer: DokTypFeld | null;
}

export const DOK_TYPEN: DokTyp[] = [
  {
    key: "versicherungspolice", label: "Versicherungspolice",
    partei: { label: "Versicherer", pflicht: true, placeholder: "z.B. AXA, Mobiliar" },
    nummer: { label: "Policen-Nr.", pflicht: false, placeholder: "optional" },
  },
  {
    key: "vertrag", label: "Vertrag",
    partei: { label: "Vertragspartner", pflicht: true, placeholder: "z.B. SCALA BASEL" },
    nummer: { label: "Vertrags-Nr.", pflicht: false, placeholder: "optional" },
  },
  {
    key: "rechnung", label: "Rechnung",
    partei: { label: "Aussteller", pflicht: true, placeholder: "z.B. Swisscom" },
    nummer: { label: "Rechnungs-Nr.", pflicht: false, placeholder: "optional" },
  },
  {
    key: "offerte", label: "Offerte",
    partei: { label: "Anbieter", pflicht: true, placeholder: "z.B. Häusler AG" },
    nummer: { label: "Offerten-Nr.", pflicht: false, placeholder: "optional" },
  },
  {
    key: "kuendigung", label: "Kündigung",
    partei: { label: "Gegenpartei", pflicht: true, placeholder: "wem/von wem gekündigt wird" },
    nummer: { label: "Referenz-Nr.", pflicht: false, placeholder: "optional" },
  },
  {
    key: "korrespondenz", label: "Korrespondenz",
    partei: { label: "Absender/Empfänger", pflicht: false, placeholder: "optional" },
    nummer: null,
  },
  {
    key: "protokoll", label: "Protokoll",
    partei: null,
    nummer: null,
  },
  {
    key: "sonstiges", label: "Sonstiges (freier Beschrieb)",
    partei: null,
    nummer: null,
  },
];

export function dokTyp(key: string | null | undefined): DokTyp | null {
  return DOK_TYPEN.find((t) => t.key === key) ?? null;
}

/** Zeichen, die in Datei-/Ordnernamen auf NAS/Windows Probleme machen. */
export function sanitizeName(s: string): string {
  return s
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Datei-Endung des Originals (inkl. Punkt), z.B. ".pdf" — leer wenn keine. */
export function extVon(originalName: string): string {
  const m = /\.[A-Za-z0-9]{1,8}$/.exec(originalName);
  return m ? m[0].toLowerCase() : "";
}

export interface NameTeile {
  typKey: string;
  betreff: string;
  partei?: string;
  nummer?: string;
  /** Datum DES DOKUMENTS (YYYY-MM-DD) — leer = Ablage-Datum (heute). */
  dokDatum?: string;
}

/** Baut den professionellen Ablage-Namen. heuteIso = Zurich-Datum. */
export function baueAblageName(t: NameTeile, originalName: string, heuteIso: string): string {
  const typ = dokTyp(t.typKey);
  const datum = /^\d{4}-\d{2}-\d{2}$/.test(t.dokDatum ?? "") ? t.dokDatum! : heuteIso;
  const ext = extVon(originalName);
  if (!typ || typ.key === "sonstiges") {
    const original = sanitizeName(originalName) || "Dokument";
    return `${datum} – ${sanitizeName(t.betreff)} – ${original}`.slice(0, 240);
  }
  const teile = [datum + " – " + typ.label, sanitizeName(t.betreff)];
  if (t.partei?.trim()) teile.push(sanitizeName(t.partei));
  if (t.nummer?.trim()) teile.push(sanitizeName(t.nummer));
  return (teile.join(" – ") + ext).slice(0, 240);
}
