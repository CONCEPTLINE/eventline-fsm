"use client";

/**
 * FormRenderer — rendert eine FormSchema-Definition als interaktives Form.
 *
 * Verwendung:
 *   <FormRenderer schema={schema} values={values} onChange={setValues} />
 *
 * Wert-Speicherung: ein flacher Record<string, unknown> keyed by block.id.
 * Wert-Format pro Block-Typ siehe types.ts / Renderer unten.
 *
 * Validierung: validateForm(schema, values) liefert pro Block-ID einen
 * Fehler-String falls Pflicht-Feld leer oder Range invalid.
 */

import { useId } from "react";
import { Input } from "@/components/ui/input";
import { SearchableSelect } from "@/components/searchable-select";
import { Info, AlertTriangle, CheckCircle, Upload, FileText, X } from "lucide-react";
import type {
  FormSchema, FormBlock, DateRangeBlock, TimeRangeBlock,
  ToggleBlock, ToggleGroupBlock, DropdownBlock, RadioBlock,
  TextBlock, TextareaBlock, NumberBlock, EmailBlock, PhoneBlock,
  DateBlock, TimeBlock, FileUploadBlock, InfoBannerBlock,
} from "@/lib/partner-form/types";
import { groupBlocksIntoRows, colSpanClass } from "@/lib/partner-form/layout";

export type FormValues = Record<string, unknown>;

interface RendererProps {
  schema: FormSchema;
  values: FormValues;
  onChange: (next: FormValues) => void;
  /** Im Preview/Read-Only Modus sind alle Eingabe-Felder disabled. */
  readOnly?: boolean;
}

export function FormRenderer({ schema, values, onChange, readOnly = false }: RendererProps) {
  function update(blockId: string, value: unknown) {
    onChange({ ...values, [blockId]: value });
  }
  const rows = groupBlocksIntoRows(schema.blocks);

  return (
    <div className="space-y-4">
      {rows.map((r) => (
        <div key={r.startIndex} className="grid grid-cols-12 gap-3">
          {r.blocks.map((b) => (
            <div key={b.id} className={`${colSpanClass(b)} min-w-0`}>
              <BlockSwitch
                block={b}
                value={values[b.id]}
                onValue={(v) => update(b.id, v)}
                readOnly={readOnly}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

interface BlockProps<TValue = unknown> {
  block: FormBlock;
  value: TValue;
  onValue: (v: TValue) => void;
  readOnly: boolean;
}

function BlockSwitch({ block, value, onValue, readOnly }: BlockProps) {
  switch (block.type) {
    case "section-header":
      return (
        <div className="pt-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{block.title}</p>
          {block.description && <p className="text-[11px] text-muted-foreground/80 mt-0.5">{block.description}</p>}
        </div>
      );
    case "divider":
      return <hr className="border-border my-2" />;
    case "info-banner":
      return <InfoBanner block={block as InfoBannerBlock} />;
    case "markdown-text":
      // v1: keine Markdown-Library — rendern wir als pre-line whitespace,
      // sodass Absaetze respektiert werden. Spaeter (Phase 5) optional.
      return <p className="text-xs text-muted-foreground whitespace-pre-line">{(block as { text: string }).text}</p>;
    case "text":
      return <TextRow block={block as TextBlock} value={(value as string) ?? ""} onValue={onValue as (v: string) => void} readOnly={readOnly} />;
    case "textarea":
      return <TextareaRow block={block as TextareaBlock} value={(value as string) ?? ""} onValue={onValue as (v: string) => void} readOnly={readOnly} />;
    case "number":
      return <NumberRow block={block as NumberBlock} value={(value as string) ?? ""} onValue={onValue as (v: string) => void} readOnly={readOnly} />;
    case "email":
      return <SimpleInputRow block={block as EmailBlock} value={(value as string) ?? ""} onValue={onValue as (v: string) => void} type="email" inputMode="email" readOnly={readOnly} />;
    case "phone":
      return <SimpleInputRow block={block as PhoneBlock} value={(value as string) ?? ""} onValue={onValue as (v: string) => void} type="tel" inputMode="tel" sanitize={(s) => s.replace(/[^0-9+ ]/g, "")} readOnly={readOnly} />;
    case "date":
      return <SimpleInputRow block={block as DateBlock} value={(value as string) ?? ""} onValue={onValue as (v: string) => void} type="date" readOnly={readOnly} extraProps={(() => {
        const b = block as DateBlock;
        const today = todayISO();
        return {
          min: b.min === "today" ? today : b.min,
          max: b.max === "today" ? today : b.max,
        };
      })()} />;
    case "daterange":
      return <DateRangeRow block={block as DateRangeBlock} value={(value as { start?: string; end?: string }) ?? {}} onValue={onValue as (v: { start?: string; end?: string }) => void} readOnly={readOnly} />;
    case "time":
      return <SimpleInputRow block={block as TimeBlock} value={(value as string) ?? ""} onValue={onValue as (v: string) => void} type="time" readOnly={readOnly} extraProps={{ step: (block as TimeBlock).step ? String((block as TimeBlock).step! * 60) : "3600" }} />;
    case "timerange":
      return <TimeRangeRow block={block as TimeRangeBlock} value={(value as { start?: string; end?: string }) ?? {}} onValue={onValue as (v: { start?: string; end?: string }) => void} readOnly={readOnly} />;
    case "dropdown":
      return <DropdownRow block={block as DropdownBlock} value={(value as string) ?? ""} onValue={onValue as (v: string) => void} readOnly={readOnly} />;
    case "radio":
      return <RadioRow block={block as RadioBlock} value={(value as string) ?? ""} onValue={onValue as (v: string) => void} readOnly={readOnly} />;
    case "toggle":
      return <ToggleRow block={block as ToggleBlock} value={Boolean(value ?? (block as ToggleBlock).default)} onValue={onValue as (v: boolean) => void} readOnly={readOnly} />;
    case "toggle-group":
      return <ToggleGroupRow block={block as ToggleGroupBlock} value={(value as string[] | string | null) ?? ((block as ToggleGroupBlock).default ?? [])} onValue={onValue as (v: string[] | string | null) => void} readOnly={readOnly} />;
    case "file-upload":
      return <FileUploadRow block={block as FileUploadBlock} value={(value as File[]) ?? []} onValue={onValue as (v: File[]) => void} readOnly={readOnly} />;
    default:
      return (
        <p className="text-[11px] text-amber-700 dark:text-amber-300 italic">
          Unbekannter Block-Typ: {(block as { type: string }).type} (nur via JSON editierbar)
        </p>
      );
  }
}

// ============================================================
// Block-Renderer
// ============================================================

function FieldLabel({ label, required, hint }: { label: string; required?: boolean; hint?: string }) {
  return (
    <>
      <label className="text-xs font-medium">
        {label} {required && <span className="text-red-600 dark:text-red-400">*</span>}
      </label>
      {hint && <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>}
    </>
  );
}

function InfoBanner({ block }: { block: InfoBannerBlock }) {
  const tones = {
    info: { bg: "bg-blue-50 dark:bg-blue-500/15", border: "border-blue-200 dark:border-blue-500/30", text: "text-blue-800 dark:text-blue-300", Icon: Info },
    warning: { bg: "bg-amber-50 dark:bg-amber-500/15", border: "border-amber-200 dark:border-amber-500/30", text: "text-amber-800 dark:text-amber-300", Icon: AlertTriangle },
    success: { bg: "bg-green-50 dark:bg-green-500/15", border: "border-green-200 dark:border-green-500/30", text: "text-green-800 dark:text-green-300", Icon: CheckCircle },
  } as const;
  const t = tones[block.tone];
  return (
    <div className={`flex items-start gap-2 px-3 py-2 rounded-lg border ${t.bg} ${t.border} ${t.text}`}>
      <t.Icon className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <p className="text-xs whitespace-pre-line">{block.text}</p>
    </div>
  );
}

interface CommonRowProps<TBlock, TValue> {
  block: TBlock;
  value: TValue;
  onValue: (v: TValue) => void;
  readOnly: boolean;
}

function TextRow({ block, value, onValue, readOnly }: CommonRowProps<TextBlock, string>) {
  return (
    <div>
      <FieldLabel label={block.label} required={block.required} hint={block.hint} />
      <Input value={value} onChange={(e) => onValue(e.target.value)} placeholder={block.placeholder} maxLength={block.maxLength} disabled={readOnly} className="mt-1" />
    </div>
  );
}

function TextareaRow({ block, value, onValue, readOnly }: CommonRowProps<TextareaBlock, string>) {
  return (
    <div>
      <FieldLabel label={block.label} required={block.required} hint={block.hint} />
      <textarea value={value} onChange={(e) => onValue(e.target.value)} placeholder={block.placeholder} rows={block.rows ?? 3} disabled={readOnly}
        className="mt-1 w-full px-3 py-2 text-sm rounded-lg border border-border bg-card resize-none focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-50" />
    </div>
  );
}

function NumberRow({ block, value, onValue, readOnly }: CommonRowProps<NumberBlock, string>) {
  return (
    <div>
      <FieldLabel label={block.label} required={block.required} hint={block.hint} />
      <Input type="number" value={value} onChange={(e) => onValue(e.target.value)} placeholder={block.placeholder} min={block.min} max={block.max} step={block.step ?? 1} disabled={readOnly} className="mt-1" />
    </div>
  );
}

function SimpleInputRow<TBlock extends { label: string; required?: boolean; hint?: string; placeholder?: string }>({
  block, value, onValue, readOnly, type, inputMode, sanitize, extraProps,
}: CommonRowProps<TBlock, string> & {
  type: "email" | "tel" | "date" | "time";
  inputMode?: "email" | "tel";
  sanitize?: (s: string) => string;
  extraProps?: Record<string, string | undefined>;
}) {
  return (
    <div>
      <FieldLabel label={block.label} required={block.required} hint={block.hint} />
      <Input
        type={type}
        inputMode={inputMode}
        value={value}
        onChange={(e) => onValue(sanitize ? sanitize(e.target.value) : e.target.value)}
        placeholder={block.placeholder}
        disabled={readOnly}
        className="mt-1"
        {...extraProps}
      />
    </div>
  );
}

function DateRangeRow({ block, value, onValue, readOnly }: CommonRowProps<DateRangeBlock, { start?: string; end?: string }>) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel label={block.start_label} required={block.required_start} />
          <Input type="date" value={value.start ?? ""} onChange={(e) => onValue({ ...value, start: e.target.value })} disabled={readOnly} className="mt-1" />
        </div>
        <div>
          <FieldLabel label={block.end_label} required={block.required_end} hint={block.hint_end} />
          <Input type="date" value={value.end ?? ""} onChange={(e) => onValue({ ...value, end: e.target.value })} disabled={readOnly} min={value.start || undefined} className="mt-1" />
        </div>
      </div>
    </div>
  );
}

function TimeRangeRow({ block, value, onValue, readOnly }: CommonRowProps<TimeRangeBlock, { start?: string; end?: string }>) {
  const step = block.step ? String(block.step * 60) : "3600";
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <FieldLabel label={block.start_label} required={block.required} />
        <Input type="time" value={value.start ?? ""} onChange={(e) => onValue({ ...value, start: e.target.value })} disabled={readOnly} step={step} className="mt-1" />
      </div>
      <div>
        <FieldLabel label={block.end_label} required={block.required} />
        <Input type="time" value={value.end ?? ""} onChange={(e) => onValue({ ...value, end: e.target.value })} disabled={readOnly} step={step} className="mt-1" />
      </div>
    </div>
  );
}

function DropdownRow({ block, value, onValue, readOnly }: CommonRowProps<DropdownBlock, string>) {
  return (
    <div>
      <FieldLabel label={block.label} required={block.required} hint={block.hint} />
      <div className="mt-1">
        <SearchableSelect
          value={value}
          onChange={(v) => !readOnly && onValue(v)}
          items={block.options.map((o) => ({ id: o.value, label: o.label }))}
          placeholder={block.placeholder ?? "Bitte wählen…"}
          searchable={block.options.length > 8}
        />
      </div>
    </div>
  );
}

function RadioRow({ block, value, onValue, readOnly }: CommonRowProps<RadioBlock, string>) {
  const name = useId();
  // Default-Wert sicherstellen wenn noch nichts gewaehlt.
  const current = value || block.default || "";
  return (
    <div>
      <FieldLabel label={block.label} required={block.required} hint={block.hint} />
      <div className="mt-1 space-y-1">
        {block.options.map((o) => (
          <label key={o.value} className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.06] cursor-pointer">
            <input type="radio" name={name} value={o.value} checked={current === o.value} onChange={() => onValue(o.value)} disabled={readOnly} className="accent-red-500" />
            <span className="text-sm">{o.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function ToggleRow({ block, value, onValue, readOnly }: CommonRowProps<ToggleBlock, boolean>) {
  return (
    <label className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-foreground/[0.02] dark:bg-foreground/[0.04] border border-foreground/10 dark:border-foreground/15 cursor-pointer">
      <div className="min-w-0 flex-1">
        <span className="text-sm font-medium">{block.label}{block.required && <span className="text-red-600 dark:text-red-400 ml-0.5">*</span>}</span>
        {block.hint && <p className="text-[10px] text-muted-foreground mt-0.5">{block.hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        onClick={() => !readOnly && onValue(!value)}
        disabled={readOnly}
        className={`shrink-0 inline-flex h-6 w-10 items-center rounded-full transition-colors ${value ? "bg-red-500" : "bg-foreground/20 dark:bg-foreground/30"} ${readOnly ? "opacity-50 cursor-not-allowed" : ""}`}
      >
        <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transform transition-transform ${value ? "translate-x-4" : "translate-x-0.5"}`} />
      </button>
    </label>
  );
}

function ToggleGroupRow({ block, value, onValue, readOnly }: CommonRowProps<ToggleGroupBlock, string[] | string | null>) {
  const multi = block.multi !== false; // default true
  const arr = Array.isArray(value) ? value : value ? [value] : [];
  function toggle(v: string) {
    if (readOnly) return;
    if (multi) {
      const next = arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
      onValue(next);
    } else {
      // single: nochmal klicken entfernt
      onValue(arr[0] === v ? null : v);
    }
  }
  return (
    <div>
      <FieldLabel label={block.label} required={block.required} hint={block.hint} />
      <div className="mt-1.5 flex flex-wrap gap-2">
        {block.options.map((o) => {
          const active = arr.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => toggle(o.value)}
              disabled={readOnly}
              aria-pressed={active}
              className={`px-3 py-1.5 rounded-lg border-2 text-sm font-medium transition-all ${active
                ? "border-red-500 bg-red-50 dark:bg-red-500/20 text-red-700 dark:text-red-300"
                : "border-foreground/15 dark:border-foreground/20 bg-card text-foreground/70 hover:border-foreground/30"
              } ${readOnly ? "opacity-50 cursor-not-allowed" : ""}`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FileUploadRow({ block, value, onValue, readOnly }: CommonRowProps<FileUploadBlock, File[]>) {
  function add(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    if (!list) return;
    onValue([...value, ...Array.from(list)]);
    e.target.value = "";
  }
  function remove(i: number) {
    onValue(value.filter((_, idx) => idx !== i));
  }
  return (
    <div>
      <div className="flex items-center justify-between">
        <FieldLabel label={block.label} required={block.required} hint={block.hint} />
      </div>
      <label className="mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border-2 border-dashed border-foreground/20 hover:border-foreground/40 text-sm text-muted-foreground cursor-pointer">
        <Upload className="h-3.5 w-3.5" />
        Datei wählen
        <input type="file" multiple={block.multiple} accept={block.accept} onChange={add} disabled={readOnly} className="hidden" />
      </label>
      {value.length > 0 && (
        <div className="mt-2 space-y-1">
          {value.map((f, i) => (
            <div key={i} className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg border bg-foreground/[0.02] dark:bg-foreground/[0.04]">
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="text-xs truncate">{f.name}</span>
                <span className="text-[10px] text-muted-foreground shrink-0">{(f.size / 1024).toFixed(0)} KB</span>
              </div>
              <button type="button" onClick={() => remove(i)} disabled={readOnly} className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive shrink-0">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Validation
// ============================================================

export function validateForm(schema: FormSchema, values: FormValues): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const b of schema.blocks) {
    const v = values[b.id];
    switch (b.type) {
      case "text": case "textarea": case "email": case "phone": case "number":
        if (b.required && !String(v ?? "").trim()) errors[b.id] = `${b.label} ist Pflicht`;
        if (b.type === "email" && v && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v))) errors[b.id] = "Ungültige E-Mail";
        break;
      case "date":
        if (b.required && !v) errors[b.id] = `${b.label} ist Pflicht`;
        break;
      case "daterange": {
        const dv = (v as { start?: string; end?: string }) ?? {};
        if (b.required_start && !dv.start) errors[b.id] = `${b.start_label} ist Pflicht`;
        if (dv.start && dv.end && dv.end < dv.start) errors[b.id] = "Enddatum vor Startdatum";
        break;
      }
      case "time":
        if (b.required && !v) errors[b.id] = `${b.label} ist Pflicht`;
        break;
      case "timerange": {
        const tv = (v as { start?: string; end?: string }) ?? {};
        if (b.required && (!tv.start || !tv.end)) errors[b.id] = `${b.start_label}/${b.end_label} fehlen`;
        if (tv.start && tv.end && tv.end <= tv.start) errors[b.id] = "Endzeit muss nach Startzeit liegen";
        break;
      }
      case "dropdown": case "radio":
        if (b.required && !v) errors[b.id] = `${b.label} ist Pflicht`;
        break;
      case "toggle":
        if (b.required && v !== true) errors[b.id] = `${b.label} muss aktiv sein`;
        break;
      case "toggle-group": {
        const arr = Array.isArray(v) ? v : v ? [v as string] : [];
        if (b.required && arr.length === 0) errors[b.id] = `${b.label}: mindestens eine Option`;
        break;
      }
      case "file-upload": {
        const files = (v as File[]) ?? [];
        if (b.required && files.length === 0) errors[b.id] = `${b.label} ist Pflicht`;
        break;
      }
      default:
        // Display-Blocks oder unbekannte: keine Validation
        break;
    }
  }
  return errors;
}

function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
