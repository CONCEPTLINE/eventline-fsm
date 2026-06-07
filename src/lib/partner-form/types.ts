/**
 * Schema-Definition fuer das konfigurierbare Partner-Anfrage-Form.
 *
 * Eine Form ist eine Liste von Blocks. Jeder Block hat einen 'type', der
 * den Renderer + Builder steuert. Block-IDs muessen unique innerhalb der
 * Form sein (werden vom Builder beim Hinzufuegen generiert; per Hand
 * via JSON-Editor moeglich).
 *
 * 'mapTo' verbindet einen Block-Wert mit einer Job-Spalte. Ohne mapTo
 * landet der Wert in jobs.form_answers[block.id] als JSON-Wert. Ein
 * Block mit mapTo='title' setzt jobs.title.
 *
 * Supported Job-Spalten fuer mapTo:
 *   title, description, start_date, end_date,
 *   contact_person, contact_phone, contact_email, guest_count
 *
 * Daterange ist Spezialfall: mapToStart + mapToEnd statt mapTo.
 *
 * Toggle-Group: multi=true → Wert ist string[], sonst Wert ist string|null.
 */

export interface FormSchema {
  version: 1;
  /** Submit-Button-Labels (mit Default-Fallbacks im Renderer). */
  submit?: {
    draft_label?: string;
    send_label?: string;
  };
  /** Erlaubt Drafts ohne Termin (= 'Anfrage senden' nur sichtbar wenn alle
   *  required Felder gefuellt und mindestens ein Termin definiert). v1
   *  hardcoded auf true im Renderer; spaeter konfigurierbar. */
  blocks: FormBlock[];
}

export type FormBlock =
  | SectionHeaderBlock
  | DividerBlock
  | InfoBannerBlock
  | MarkdownTextBlock
  | TextBlock
  | TextareaBlock
  | NumberBlock
  | EmailBlock
  | PhoneBlock
  | DateBlock
  | DateRangeBlock
  | TimeBlock
  | TimeRangeBlock
  | DropdownBlock
  | RadioBlock
  | ToggleBlock
  | ToggleGroupBlock
  | FileUploadBlock;

export type FormBlockType = FormBlock["type"];

/** Block-Vokabular fuer Builder-UI (welche Block-Typen kennt der Block-
 *  Builder). Unbekannte Typen aus dem JSON-Editor werden read-only
 *  angezeigt mit Hinweis "Edit via JSON". */
export const KNOWN_BLOCK_TYPES = [
  "section-header",
  "divider",
  "info-banner",
  "markdown-text",
  "text",
  "textarea",
  "number",
  "email",
  "phone",
  "date",
  "daterange",
  "time",
  "timerange",
  "dropdown",
  "radio",
  "toggle",
  "toggle-group",
  "file-upload",
] as const satisfies readonly FormBlockType[];

/** Breiten-Fraction eines Blocks innerhalb seiner Zeile. Bloecke mit
 *  zusammengerechneter Breite ≤ 1 landen in derselben Zeile (siehe
 *  layout.ts → groupBlocksIntoRows). */
export type BlockWidth = "1/4" | "1/3" | "1/2" | "2/3" | "3/4" | "full";

interface BlockBase {
  id: string;
  type: FormBlockType;
  /** Optional sichtbare Erklaerung unter dem Label (Hilfetext). */
  hint?: string;
  /** Spalten-Breite (default 'full'). Mehrere Bloecke in einer Zeile
   *  via Summenrechnung — siehe groupBlocksIntoRows. */
  width?: BlockWidth;
}

// ============================================================
// Display-Bloecke (kein Input, kein Wert)
// ============================================================

export interface SectionHeaderBlock extends BlockBase {
  type: "section-header";
  title: string;
  description?: string;
}

export interface DividerBlock extends BlockBase {
  type: "divider";
}

export interface InfoBannerBlock extends BlockBase {
  type: "info-banner";
  /** Tone steuert Farbe + Icon. */
  tone: "info" | "warning" | "success";
  text: string;
}

export interface MarkdownTextBlock extends BlockBase {
  type: "markdown-text";
  text: string;
}

// ============================================================
// Input-Bloecke (mit Value)
// ============================================================

type CoreColumn =
  | "title"
  | "description"
  | "start_date"
  | "end_date"
  | "contact_person"
  | "contact_phone"
  | "contact_email"
  | "guest_count";

interface InputBlockBase extends BlockBase {
  label: string;
  required?: boolean;
  /** Wenn gesetzt, landet der Wert in der Job-Spalte. Sonst in
   *  jobs.form_answers[block.id]. */
  mapTo?: CoreColumn;
}

export interface TextBlock extends InputBlockBase {
  type: "text";
  placeholder?: string;
  maxLength?: number;
}

export interface TextareaBlock extends InputBlockBase {
  type: "textarea";
  placeholder?: string;
  rows?: number;
}

export interface NumberBlock extends InputBlockBase {
  type: "number";
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
}

export interface EmailBlock extends InputBlockBase {
  type: "email";
  placeholder?: string;
}

export interface PhoneBlock extends InputBlockBase {
  type: "phone";
  placeholder?: string;
}

export interface DateBlock extends InputBlockBase {
  type: "date";
  /** Format YYYY-MM-DD ('today' = dynamisch heute) als Datum-Bound. */
  min?: string | "today";
  max?: string | "today";
}

export interface DateRangeBlock extends BlockBase {
  type: "daterange";
  start_label: string;
  end_label: string;
  required_start?: boolean;
  required_end?: boolean;
  mapToStart?: "start_date";
  mapToEnd?: "end_date";
  hint_end?: string;
}

export interface TimeBlock extends InputBlockBase {
  type: "time";
  /** Step in Minuten (default 60 = volle Stunde, 15 = Viertelstunde). */
  step?: number;
}

export interface TimeRangeBlock extends BlockBase {
  type: "timerange";
  start_label: string;
  end_label: string;
  required?: boolean;
  step?: number;
}

export interface DropdownOption {
  value: string;
  label: string;
}

export interface DropdownBlock extends InputBlockBase {
  type: "dropdown";
  options: DropdownOption[];
  placeholder?: string;
}

export interface RadioBlock extends InputBlockBase {
  type: "radio";
  options: DropdownOption[];
  /** Default-Wert (= preselected). */
  default?: string;
}

export interface ToggleBlock extends InputBlockBase {
  type: "toggle";
  default?: boolean;
}

export interface ToggleGroupBlock extends InputBlockBase {
  type: "toggle-group";
  options: DropdownOption[];
  /** Multi → mehrere gleichzeitig waehlbar (string[]). Sonst single
   *  (entweder 0 oder 1 Option aktiv, value = string|null). */
  multi?: boolean;
  default?: string[];
}

export interface FileUploadBlock extends BlockBase {
  type: "file-upload";
  label: string;
  /** Komma-Liste fuer das HTML-accept-Attribut. */
  accept?: string;
  multiple?: boolean;
  required?: boolean;
  hint?: string;
}

// ============================================================
// Helpers
// ============================================================

/** Type-Guard: liefert true wenn der Block ein Input-Block mit eigenem
 *  Wert ist (also Wert in form_answers oder mapTo). */
export function isInputBlock(b: FormBlock): boolean {
  return ![
    "section-header",
    "divider",
    "info-banner",
    "markdown-text",
  ].includes(b.type);
}

/** Generiert eine neue 8-Zeichen Block-ID. Random Base36 — kein UUID,
 *  weil short-IDs im JSON lesbarer sind. */
export function generateBlockId(): string {
  // Eindeutige genug fuer Form-interne IDs (kollidiert nur bei 1/2.8 Mrd).
  const hex = Math.floor(Math.random() * 0xffffffff).toString(36);
  return `b_${hex.padStart(7, "0").slice(0, 7)}`;
}

/** Schema-Default (leere Form mit Versions-Marker). */
export const EMPTY_SCHEMA: FormSchema = {
  version: 1,
  blocks: [],
};
