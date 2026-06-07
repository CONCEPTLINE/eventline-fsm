"use client";

/**
 * Visueller Form-Builder fuer das Partner-Anfrage-Schema.
 *
 * Layout — 3 Spalten:
 *   Palette (links)   |   Canvas (Mitte, live WYSIWYG)   |   Inspektor (rechts)
 *
 * Interaktion:
 *   - Palette-Buttons: Click = an aktueller Stelle einfuegen; Drag = an
 *     Drop-Zone zwischen Bloecken einfuegen.
 *   - Canvas: zeigt die Form GENAU wie der Partner sie sieht (FormRenderer
 *     read-only). Click selektiert; Hover zeigt Drag-Handle + Delete.
 *   - Drag eines Canvas-Blocks ueber eine Drop-Zone reordert.
 *   - Inspektor: Edit-Form fuer den selektierten Block (alle Properties
 *     des jeweiligen Block-Typs).
 *
 * Drag-Protokoll via dataTransfer:
 *   "move:<index>"  → Bestehender Block wird verschoben
 *   "add:<type>"    → Neuer Block wird eingefuegt
 */

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { FormRenderer } from "@/components/partner-form/form-renderer";
import {
  Trash2, GripVertical, X,
  Heading, Minus, Info, AlignLeft, Type, Hash, AtSign, Phone, Calendar,
  CalendarRange, Clock, Clock4, ChevronDown, CircleDot, ToggleLeft, ListChecks,
  Upload, MousePointer2,
} from "lucide-react";
import { KNOWN_BLOCK_TYPES, generateBlockId, type FormBlock, type FormBlockType, type BlockWidth, type DropdownOption, type FormSchema } from "@/lib/partner-form/types";
import { groupBlocksIntoRows, colSpanClass, widthOf, WIDTH_OPTIONS } from "@/lib/partner-form/layout";

// ============================================================
// Exports
// ============================================================

interface BuilderProps {
  blocks: FormBlock[];
  onChange: (next: FormBlock[]) => void;
}

export function VisualBuilder({ blocks, onChange }: BuilderProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragOverZone, setDragOverZone] = useState<number | null>(null);

  const selectedIndex = blocks.findIndex((b) => b.id === selectedId);
  const selectedBlock = selectedIndex >= 0 ? blocks[selectedIndex]! : null;

  function update(index: number, next: FormBlock) {
    const arr = blocks.map((b, i) => (i === index ? next : b));
    onChange(arr);
    if (next.id !== blocks[index]!.id) setSelectedId(next.id);
  }
  function remove(index: number) {
    onChange(blocks.filter((_, i) => i !== index));
    if (selectedIndex === index) setSelectedId(null);
  }
  function move(from: number, to: number) {
    if (from === to || from < 0 || to < 0 || from >= blocks.length) return;
    const arr = [...blocks];
    const [item] = arr.splice(from, 1);
    // Bei Move-Nach-Rechts: nach dem Splice ist `to` um 1 verschoben.
    const adjusted = to > from ? to - 1 : to;
    arr.splice(adjusted, 0, item!);
    onChange(arr);
  }
  function addAt(type: FormBlockType, atIndex: number) {
    const fresh = createDefaultBlock(type);
    const next = [...blocks];
    next.splice(atIndex, 0, fresh);
    onChange(next);
    setSelectedId(fresh.id);
  }

  function handleDrop(zoneIndex: number, e: React.DragEvent) {
    e.preventDefault();
    setDragOverZone(null);
    const data = e.dataTransfer.getData("text/plain");
    if (data.startsWith("move:")) {
      const from = Number(data.slice(5));
      move(from, zoneIndex);
    } else if (data.startsWith("add:")) {
      const type = data.slice(4) as FormBlockType;
      if (KNOWN_BLOCK_TYPES.includes(type)) addAt(type, zoneIndex);
    }
  }

  const rows = groupBlocksIntoRows(blocks);

  return (
    // 3-Spalten-Layout mit FIXER Hoehe und internem Scroll pro Spalte.
    // Sticky-Approach hat in dieser Layout-Hierarchie nicht funktioniert
    // (#app-scroll ist der Scroll-Container, irgendein Ancestor brach
    // sticky). Stattdessen: das Builder-Panel selbst ist viewport-hoch,
    // jede Spalte scrollt intern. Palette + Inspektor bleiben so
    // garantiert sichtbar — Canvas scrollt unabhaengig.
    <div className="flex flex-col lg:flex-row gap-3 lg:h-[calc(100vh-220px)] lg:min-h-[600px]">
      {/* Palette */}
      <aside className="lg:w-52 shrink-0 rounded-lg border border-border bg-card p-3 space-y-2 lg:overflow-y-auto">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Bausteine</p>
        <p className="text-[10px] text-muted-foreground/70">In die Mitte ziehen.</p>
        <div className="grid grid-cols-1 gap-1 pt-1">
          {KNOWN_BLOCK_TYPES.map((t) => (
            <PaletteItem key={t} type={t} />
          ))}
        </div>
      </aside>

      {/* Canvas — live WYSIWYG, Row-Layout mit Breite-Support, scrollt intern */}
      <main
        className="flex-1 min-w-0 rounded-lg border border-border bg-foreground/[0.015] dark:bg-foreground/[0.025] p-3 lg:overflow-y-auto"
        onClick={() => setSelectedId(null)}
      >
        <div className="max-w-3xl mx-auto">
          {blocks.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground text-xs">
              Noch keine Bausteine — Palette links benutzen.
            </div>
          ) : (
            <>
              <DropZone
                isActive={dragOverZone === 0}
                onDragOver={(e) => { e.preventDefault(); setDragOverZone(0); }}
                onDragLeave={() => setDragOverZone(null)}
                onDrop={(e) => handleDrop(0, e)}
              />
              {rows.map((r) => {
                const nextZoneIndex = r.startIndex + r.blocks.length;
                return (
                  <div key={r.startIndex}>
                    <div className="grid grid-cols-12 gap-3">
                      {r.blocks.map((b, ri) => (
                        <div key={b.id} className={`${colSpanClass(b)} min-w-0`}>
                          <CanvasBlock
                            block={b}
                            index={r.startIndex + ri}
                            selected={selectedId === b.id}
                            onSelect={() => setSelectedId(b.id)}
                            onDelete={() => remove(r.startIndex + ri)}
                          />
                        </div>
                      ))}
                    </div>
                    <DropZone
                      isActive={dragOverZone === nextZoneIndex}
                      onDragOver={(e) => { e.preventDefault(); setDragOverZone(nextZoneIndex); }}
                      onDragLeave={() => setDragOverZone(null)}
                      onDrop={(e) => handleDrop(nextZoneIndex, e)}
                    />
                  </div>
                );
              })}
            </>
          )}
        </div>
      </main>

      {/* Inspektor — scrollt intern */}
      <aside className="lg:w-80 shrink-0 rounded-lg border border-border bg-card p-3 space-y-3 lg:overflow-y-auto">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Inspektor</p>
        {!selectedBlock ? (
          <div className="py-8 text-center text-muted-foreground text-xs flex flex-col items-center gap-2">
            <MousePointer2 className="h-5 w-5 opacity-50" />
            <p>Wähle einen Block in der Mitte aus, um seine Eigenschaften zu bearbeiten.</p>
          </div>
        ) : (
          <BlockEditor block={selectedBlock} onChange={(next) => update(selectedIndex, next)} />
        )}
      </aside>
    </div>
  );
}

// ============================================================
// Palette
// ============================================================

const TYPE_META: Record<FormBlockType, { label: string; Icon: React.ComponentType<{ className?: string }> }> = {
  "section-header": { label: "Section-Header", Icon: Heading },
  "divider": { label: "Trennlinie", Icon: Minus },
  "info-banner": { label: "Info-Banner", Icon: Info },
  "markdown-text": { label: "Hinweis-Text", Icon: AlignLeft },
  "text": { label: "Text-Feld", Icon: Type },
  "textarea": { label: "Textarea", Icon: AlignLeft },
  "number": { label: "Zahl", Icon: Hash },
  "email": { label: "E-Mail", Icon: AtSign },
  "phone": { label: "Telefon", Icon: Phone },
  "date": { label: "Datum", Icon: Calendar },
  "daterange": { label: "Datum-Bereich", Icon: CalendarRange },
  "time": { label: "Uhrzeit", Icon: Clock },
  "timerange": { label: "Uhrzeit-Bereich", Icon: Clock4 },
  "dropdown": { label: "Dropdown", Icon: ChevronDown },
  "radio": { label: "Radio-Buttons", Icon: CircleDot },
  "toggle": { label: "Toggle", Icon: ToggleLeft },
  "toggle-group": { label: "Toggle-Gruppe", Icon: ListChecks },
  "file-upload": { label: "Datei-Upload", Icon: Upload },
};

function PaletteItem({ type }: { type: FormBlockType }) {
  const { label, Icon } = TYPE_META[type];
  const [hover, setHover] = useState(false);
  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.setData("text/plain", `add:${type}`); e.dataTransfer.effectAllowed = "copy"; }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-left border border-transparent transition-colors cursor-grab active:cursor-grabbing select-none"
      style={{
        background: hover ? "rgba(127,127,127,0.10)" : "transparent",
        borderColor: hover ? "rgba(127,127,127,0.20)" : "transparent",
      }}
    >
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      <span>{label}</span>
    </div>
  );
}

// ============================================================
// Canvas
// ============================================================

function CanvasBlock({ block, index, selected, onSelect, onDelete }: {
  block: FormBlock;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);

  // WICHTIG: keine Layout-Aenderung beim Hover. Border ist immer 2px
  // (transparent wenn idle), pt ist konstant — sonst zittert die ganze
  // Form beim Drueberfahren mit der Maus. Toolbar erscheint nur bei
  // Selection (= bewusster Klick).
  const borderColor = selected ? "rgb(239,68,68)" : hover ? "rgba(127,127,127,0.30)" : "transparent";

  return (
    <div
      onClick={(e) => { e.stopPropagation(); onSelect(); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      draggable
      onDragStart={(e) => {
        e.stopPropagation();
        setDragging(true);
        e.dataTransfer.setData("text/plain", `move:${index}`);
        e.dataTransfer.effectAllowed = "move";
      }}
      onDragEnd={() => setDragging(false)}
      className="relative rounded-md h-full"
      style={{
        border: `2px solid ${borderColor}`,
        background: selected ? "rgba(239,68,68,0.04)" : "transparent",
        opacity: dragging ? 0.4 : 1,
        cursor: "grab",
      }}
    >
      {selected && (
        <div className="absolute top-0 left-0 right-0 flex items-center justify-between gap-1 px-1 py-0.5 bg-red-500 text-white rounded-t-sm z-10" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1 min-w-0">
            <GripVertical className="h-3 w-3 shrink-0 opacity-70" />
            <span className="text-[9px] uppercase tracking-wider font-semibold truncate">
              {TYPE_META[block.type]?.label ?? block.type}
            </span>
          </div>
          <button
            type="button"
            onClick={onDelete}
            className="p-0.5 rounded hover:bg-red-600 shrink-0"
            title="Block löschen"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        </div>
      )}
      {/* pointer-events-none = Inputs auf Canvas sind nicht editierbar
          (sonst stiehlt jeder Klick die Selection). Canvas ist reines
          WYSIWYG-Preview. Klick auf Wrapper selektiert; Inputs werden
          via Inspektor editiert. pt ist konstant — Toolbar ueberlappt
          ggf. den oberen Rand des Inhalts, das ist OK weil sie nur bei
          Selection sichtbar wird (= bewusster Klick). */}
      <div className="pointer-events-none px-3 py-2">
        <SingleBlockPreview block={block} />
      </div>
    </div>
  );
}

function SingleBlockPreview({ block }: { block: FormBlock }) {
  const [vals, setVals] = useState<Record<string, unknown>>({});
  // WICHTIG: width-Override auf 'full'. Sonst rechnet der innere
  // FormRenderer die width nochmal an, und ein 1/4-Block wird zu
  // 1/4 × 1/4 = 1/16 der Canvas-Breite. Die echte visuelle Breite
  // wird vom AEUSSEREN Canvas-Grid (col-span-3 etc.) gesetzt.
  const fullBlock = { ...block, width: "full" as const };
  const schema: FormSchema = { version: 1, blocks: [fullBlock] };
  return <FormRenderer schema={schema} values={vals} onChange={setVals} readOnly />;
}

function DropZone({ isActive, onDragOver, onDragLeave, onDrop }: {
  isActive: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className="h-3 rounded transition-colors my-1"
      style={{
        background: isActive ? "rgb(239,68,68)" : "transparent",
        boxShadow: isActive ? "0 0 0 2px rgba(239,68,68,0.3)" : "none",
      }}
    />
  );
}

// ============================================================
// Inspektor — per-type Editor
// ============================================================

function BlockEditor({ block, onChange }: { block: FormBlock; onChange: (next: FormBlock) => void }) {
  function patchAny(key: string, value: unknown) {
    onChange({ ...(block as unknown as Record<string, unknown>), [key]: value } as unknown as FormBlock);
  }

  return (
    <div className="space-y-3 pr-1">
      <Row label="Breite">
        <WidthSelector value={widthOf(block)} onChange={(w) => patchAny("width", w === "full" ? undefined : w)} />
      </Row>

      <Row label="Block-ID" hint="a-z, 0-9, _ — Antworten sind unter dieser ID gespeichert.">
        <Input value={block.id} onChange={(e) => patchAny("id", e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))} />
      </Row>

      {block.type === "section-header" && (
        <>
          <Row label="Titel"><Input value={block.title} onChange={(e) => patchAny("title", e.target.value)} /></Row>
          <Row label="Beschreibung"><Input value={block.description ?? ""} onChange={(e) => patchAny("description", e.target.value || undefined)} /></Row>
        </>
      )}

      {block.type === "info-banner" && (
        <>
          <Row label="Stil">
            <select value={block.tone} onChange={(e) => patchAny("tone", e.target.value)} className="h-9 w-full px-3 text-sm rounded-xl border border-border bg-card">
              <option value="info">Info (blau)</option>
              <option value="warning">Warnung (gelb)</option>
              <option value="success">Erfolg (grün)</option>
            </select>
          </Row>
          <Row label="Text"><textarea value={block.text} onChange={(e) => patchAny("text", e.target.value)} rows={3} className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-card" /></Row>
        </>
      )}

      {block.type === "markdown-text" && (
        <Row label="Text"><textarea value={block.text} onChange={(e) => patchAny("text", e.target.value)} rows={3} className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-card" /></Row>
      )}

      {(block.type === "text" || block.type === "textarea" || block.type === "number" || block.type === "email" || block.type === "phone" || block.type === "date" || block.type === "time" || block.type === "dropdown" || block.type === "radio" || block.type === "toggle" || block.type === "toggle-group" || block.type === "file-upload") && (
        <>
          <Row label="Label"><Input value={(block as { label?: string }).label ?? ""} onChange={(e) => patchAny("label", e.target.value)} /></Row>
          <Row label="Hinweis-Text"><Input value={block.hint ?? ""} onChange={(e) => patchAny("hint", e.target.value || undefined)} /></Row>
          <Row label="Pflichtfeld" inline><Toggle value={Boolean((block as { required?: boolean }).required)} onChange={(v) => patchAny("required", v || undefined)} /></Row>
        </>
      )}

      {(block.type === "text" || block.type === "textarea" || block.type === "number" || block.type === "email" || block.type === "phone" || block.type === "dropdown") && (
        <Row label="Platzhalter"><Input value={(block as { placeholder?: string }).placeholder ?? ""} onChange={(e) => patchAny("placeholder", e.target.value || undefined)} /></Row>
      )}

      {block.type === "text" && (
        <Row label="Max. Länge"><Input type="number" value={(block as { maxLength?: number }).maxLength ?? ""} onChange={(e) => patchAny("maxLength", e.target.value ? Number(e.target.value) : undefined)} /></Row>
      )}
      {block.type === "textarea" && (
        <Row label="Zeilen"><Input type="number" value={(block as { rows?: number }).rows ?? 3} onChange={(e) => patchAny("rows", Number(e.target.value) || 3)} /></Row>
      )}
      {block.type === "number" && (
        <div className="grid grid-cols-3 gap-2">
          <Row label="Min"><Input type="number" value={(block as { min?: number }).min ?? ""} onChange={(e) => patchAny("min", e.target.value === "" ? undefined : Number(e.target.value))} /></Row>
          <Row label="Max"><Input type="number" value={(block as { max?: number }).max ?? ""} onChange={(e) => patchAny("max", e.target.value === "" ? undefined : Number(e.target.value))} /></Row>
          <Row label="Step"><Input type="number" value={(block as { step?: number }).step ?? 1} onChange={(e) => patchAny("step", Number(e.target.value) || 1)} /></Row>
        </div>
      )}
      {block.type === "time" && (
        <Row label="Step (Minuten)"><Input type="number" value={(block as { step?: number }).step ?? 60} onChange={(e) => patchAny("step", Number(e.target.value) || 60)} /></Row>
      )}

      {block.type === "daterange" && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Row label="Label Start"><Input value={block.start_label} onChange={(e) => patchAny("start_label", e.target.value)} /></Row>
            <Row label="Label Ende"><Input value={block.end_label} onChange={(e) => patchAny("end_label", e.target.value)} /></Row>
          </div>
          <Row label="Hinweis Ende"><Input value={block.hint_end ?? ""} onChange={(e) => patchAny("hint_end", e.target.value || undefined)} /></Row>
          <div className="grid grid-cols-2 gap-2">
            <Row label="Start Pflicht" inline><Toggle value={Boolean(block.required_start)} onChange={(v) => patchAny("required_start", v || undefined)} /></Row>
            <Row label="Ende Pflicht" inline><Toggle value={Boolean(block.required_end)} onChange={(v) => patchAny("required_end", v || undefined)} /></Row>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Row label="mapTo Start"><MapToSelect value={block.mapToStart} onChange={(v) => patchAny("mapToStart", v)} only={["start_date"]} /></Row>
            <Row label="mapTo Ende"><MapToSelect value={block.mapToEnd} onChange={(v) => patchAny("mapToEnd", v)} only={["end_date"]} /></Row>
          </div>
        </>
      )}
      {block.type === "timerange" && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <Row label="Label Start"><Input value={block.start_label} onChange={(e) => patchAny("start_label", e.target.value)} /></Row>
            <Row label="Label Ende"><Input value={block.end_label} onChange={(e) => patchAny("end_label", e.target.value)} /></Row>
          </div>
          <Row label="Step (Minuten)"><Input type="number" value={block.step ?? 60} onChange={(e) => patchAny("step", Number(e.target.value) || 60)} /></Row>
          <Row label="Pflicht" inline><Toggle value={Boolean(block.required)} onChange={(v) => patchAny("required", v || undefined)} /></Row>
        </>
      )}

      {block.type === "toggle" && (
        <Row label="Default-Wert" inline><Toggle value={Boolean(block.default)} onChange={(v) => patchAny("default", v || undefined)} /></Row>
      )}

      {(block.type === "dropdown" || block.type === "radio" || block.type === "toggle-group") && (
        <>
          <Row label="Optionen">
            <OptionsEditor options={(block as { options: DropdownOption[] }).options ?? []} onChange={(next) => patchAny("options", next)} />
          </Row>
          {block.type === "toggle-group" && (
            <Row label="Mehrfach-Auswahl" inline><Toggle value={block.multi !== false} onChange={(v) => patchAny("multi", v)} /></Row>
          )}
        </>
      )}

      {block.type === "file-upload" && (
        <>
          <Row label="Erlaubte Datei-Typen" hint="HTML accept, z.B. .pdf,.png,.jpg"><Input value={(block as { accept?: string }).accept ?? ""} onChange={(e) => patchAny("accept", e.target.value || undefined)} /></Row>
          <Row label="Mehrere erlaubt" inline><Toggle value={Boolean((block as { multiple?: boolean }).multiple)} onChange={(v) => patchAny("multiple", v || undefined)} /></Row>
        </>
      )}

      {(block.type === "text" || block.type === "textarea" || block.type === "number" || block.type === "email" || block.type === "phone" || block.type === "date") && (
        <Row label="mapTo (Job-Spalte)" hint="Wert geht direkt in die Spalte. Leer = in jobs.form_answers.">
          <MapToSelect value={(block as { mapTo?: string }).mapTo} onChange={(v) => patchAny("mapTo", v)} only={["title", "description", "start_date", "end_date", "contact_person", "contact_phone", "contact_email", "guest_count"]} />
        </Row>
      )}
    </div>
  );
}

function Row({ label, hint, inline, children }: { label: string; hint?: string; inline?: boolean; children: React.ReactNode }) {
  if (inline) {
    return (
      <div className="flex items-center justify-between gap-2 py-1">
        <div>
          <label className="text-[11px] font-medium">{label}</label>
          {hint && <p className="text-[10px] text-muted-foreground/70">{hint}</p>}
        </div>
        <div>{children}</div>
      </div>
    );
  }
  return (
    <div>
      <label className="text-[11px] font-medium text-muted-foreground">{label}</label>
      {hint && <p className="text-[10px] text-muted-foreground/70 mt-0.5">{hint}</p>}
      <div className="mt-1">{children}</div>
    </div>
  );
}

function WidthSelector({ value, onChange }: { value: BlockWidth; onChange: (v: BlockWidth) => void }) {
  return (
    <div className="grid grid-cols-6 gap-1">
      {WIDTH_OPTIONS.map((w) => (
        <button
          key={w}
          type="button"
          onClick={() => onChange(w)}
          className={`px-1 py-1 rounded text-[10px] font-medium transition-colors ${value === w
            ? "bg-red-500 text-white"
            : "bg-foreground/[0.04] dark:bg-foreground/[0.08] hover:bg-foreground/[0.08] dark:hover:bg-foreground/[0.12] text-foreground"
          }`}
          title={w === "full" ? "ganze Breite" : `${w} der Zeile`}
        >
          {w === "full" ? "voll" : w}
        </button>
      ))}
    </div>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => onChange(!value)} role="switch" aria-checked={value}
      className={`inline-flex h-5 w-9 items-center rounded-full transition-colors ${value ? "bg-red-500" : "bg-foreground/20 dark:bg-foreground/30"}`}>
      <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${value ? "translate-x-4" : "translate-x-0.5"}`} />
    </button>
  );
}

function MapToSelect({ value, onChange, only }: { value: string | undefined; onChange: (v: string | undefined) => void; only?: string[] }) {
  const ALL = ["title", "description", "start_date", "end_date", "contact_person", "contact_phone", "contact_email", "guest_count"];
  const available = only ?? ALL;
  return (
    <select value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)} className="h-9 w-full px-3 text-sm rounded-xl border border-border bg-card">
      <option value="">— kein Mapping —</option>
      {available.map((c) => <option key={c} value={c}>{c}</option>)}
    </select>
  );
}

function OptionsEditor({ options, onChange }: { options: DropdownOption[]; onChange: (next: DropdownOption[]) => void }) {
  function update(i: number, key: "value" | "label", val: string) {
    onChange(options.map((o, idx) => idx === i ? { ...o, [key]: val } : o));
  }
  function add() {
    onChange([...options, { value: `opt_${options.length + 1}`, label: `Option ${options.length + 1}` }]);
  }
  function remove(i: number) {
    onChange(options.filter((_, idx) => idx !== i));
  }
  return (
    <div className="space-y-1.5">
      {options.map((o, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_auto] gap-1.5">
          <Input value={o.label} onChange={(e) => update(i, "label", e.target.value)} placeholder="Label" />
          <Input value={o.value} onChange={(e) => update(i, "value", e.target.value.replace(/[^a-zA-Z0-9_]/g, ""))} placeholder="value" className="font-mono text-xs" />
          <button type="button" onClick={() => remove(i)} className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <button type="button" onClick={add} className="text-xs text-muted-foreground hover:text-foreground">
        + Option hinzufügen
      </button>
    </div>
  );
}

// ============================================================
// Default-Block-Factory
// ============================================================

function createDefaultBlock(type: FormBlockType): FormBlock {
  const id = generateBlockId();
  switch (type) {
    case "section-header": return { id, type, title: "Neue Sektion" };
    case "divider": return { id, type };
    case "info-banner": return { id, type, tone: "info", text: "Hinweis-Text" };
    case "markdown-text": return { id, type, text: "Hinweis-Text" };
    case "text": return { id, type, label: "Neues Text-Feld" };
    case "textarea": return { id, type, label: "Neues Textarea", rows: 3 };
    case "number": return { id, type, label: "Neue Zahl" };
    case "email": return { id, type, label: "E-Mail" };
    case "phone": return { id, type, label: "Telefon" };
    case "date": return { id, type, label: "Datum" };
    case "daterange": return { id, type, start_label: "Start", end_label: "Ende" };
    case "time": return { id, type, label: "Uhrzeit" };
    case "timerange": return { id, type, start_label: "Von", end_label: "Bis" };
    case "dropdown": return { id, type, label: "Dropdown", options: [{ value: "opt_1", label: "Option 1" }, { value: "opt_2", label: "Option 2" }] };
    case "radio": return { id, type, label: "Radio", options: [{ value: "opt_1", label: "Option 1" }, { value: "opt_2", label: "Option 2" }] };
    case "toggle": return { id, type, label: "Toggle" };
    case "toggle-group": return { id, type, label: "Toggle-Gruppe", options: [{ value: "opt_1", label: "Option 1" }, { value: "opt_2", label: "Option 2" }], multi: true };
    case "file-upload": return { id, type, label: "Anhänge", multiple: true };
  }
}
