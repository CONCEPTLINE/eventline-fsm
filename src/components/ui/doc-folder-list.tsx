"use client";

/**
 * Ordnerliste links neben den Dokumenten (Optik der früheren Ablage:
 * gelbe Ordner-Symbole, gewählte Zeile grau hinterlegt, Anzahl rechts).
 * Eine Ebene wie doc-folders.tsx; jede Zeile nimmt hineingezogene Dateien an.
 *
 * Der Hauptordner erscheint nur, wenn er Dateien hat oder es noch keine
 * eigenen Ordner gibt (Wunsch 06.11.2026: leer + eigene Ordner → weg).
 */

import { useState, type DragEvent } from "react";
import { Folder, FolderOpen, Files, Plus, X } from "lucide-react";
import { usePrompt } from "@/components/ui/use-prompt";
import { NEUER_ORDNER_PROMPT, ordnerNamePruefen, type ActiveFolder } from "@/components/ui/doc-folders";

/** Enthält der Drag echte Dateien (nicht z. B. markierten Text)? */
export function istDateiDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

type Zeile = { key: string; wert: ActiveFolder; name: string; count: number; ordner: boolean };

export function DocFolderList({
  folders,
  mainCount,
  totalCount,
  active,
  onSelect,
  onCreate,
  onDelete,
  onDropFiles,
  canCreate,
}: {
  folders: { name: string; count: number }[];
  mainCount: number;
  totalCount: number;
  active: ActiveFolder;
  onSelect: (next: ActiveFolder) => void;
  onCreate: (name: string) => void;
  /** Nur leere Ordner; ohne Handler kein Löschen-Knopf. */
  onDelete?: (name: string) => void;
  /** Dateien auf eine Zeile gezogen: "" = Hauptordner, sonst Ordnername. */
  onDropFiles?: (folder: string, files: FileList) => void;
  canCreate: boolean;
}) {
  const { prompt, PromptModalElement } = usePrompt();
  const [hover, setHover] = useState<string | null>(null);
  const [dropZiel, setDropZiel] = useState<string | null>(null);

  const zeilen: Zeile[] = [{ key: "alle", wert: null, name: "Alle", count: totalCount, ordner: false }];
  if (mainCount > 0 || folders.length === 0 || active === "") {
    zeilen.push({ key: "haupt", wert: "", name: "Hauptordner", count: mainCount, ordner: false });
  }
  for (const f of folders) zeilen.push({ key: `o:${f.name}`, wert: f.name, name: f.name, count: f.count, ordner: true });

  async function anlegen() {
    const raw = await prompt({ ...NEUER_ORDNER_PROMPT });
    const name = ordnerNamePruefen(raw, folders, onSelect);
    if (name) onCreate(name);
  }

  return (
    <div className="space-y-0.5">
      <ul className="space-y-0.5">
        {zeilen.map((z) => {
          const gewaehlt = active === z.wert;
          const dropbar = !!onDropFiles && z.wert !== null && canCreate;
          const istDrop = dropZiel === z.key;
          const Icon = z.wert === null ? Files : gewaehlt ? FolderOpen : Folder;
          return (
            <li
              key={z.key}
              onMouseEnter={() => setHover(z.key)}
              onMouseLeave={() => setHover((h) => (h === z.key ? null : h))}
              onDragOver={dropbar ? (e) => { if (!istDateiDrag(e)) return; e.preventDefault(); e.stopPropagation(); setDropZiel(z.key); } : undefined}
              onDragLeave={dropbar ? () => setDropZiel((d) => (d === z.key ? null : d)) : undefined}
              onDrop={dropbar ? (e) => {
                if (!istDateiDrag(e)) return;
                e.preventDefault();
                e.stopPropagation();
                setDropZiel(null);
                if (e.dataTransfer.files.length > 0) onDropFiles!(z.wert ?? "", e.dataTransfer.files);
              } : undefined}
              className="flex items-center gap-1 rounded-lg pl-1.5 pr-1 py-1 transition-colors"
              style={{
                background: istDrop
                  ? "color-mix(in srgb, var(--accent) 14%, transparent)"
                  : gewaehlt ? "var(--muted)" : hover === z.key ? "color-mix(in srgb, var(--muted) 60%, transparent)" : undefined,
                outline: istDrop ? "1px dashed var(--accent)" : undefined,
              }}
            >
              <button
                type="button"
                onClick={() => onSelect(z.wert)}
                data-tooltip={z.name.length > 24 ? z.name : undefined}
                className="flex items-center gap-1.5 min-w-0 flex-1 text-left"
              >
                <Icon className={`h-4 w-4 shrink-0 ${z.wert === null ? "text-muted-foreground" : "text-amber-500 dark:text-amber-400"}`} />
                <span className={`truncate text-sm ${gewaehlt ? "font-medium" : ""}`}>{z.name}</span>
              </button>
              {z.ordner && z.count === 0 && onDelete && canCreate && hover === z.key ? (
                <button
                  type="button"
                  onClick={() => onDelete(z.name)}
                  className="icon-btn shrink-0 p-0.5 rounded text-muted-foreground"
                  data-tooltip="Leeren Ordner löschen"
                  aria-label={`Ordner ${z.name} löschen`}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : (
                <span className="text-[10px] text-muted-foreground tabular-nums shrink-0 px-1">{z.count}</span>
              )}
            </li>
          );
        })}
      </ul>
      {canCreate && (
        <button type="button" onClick={anlegen} className="kasten kasten-muted !py-1 !px-2 mt-1.5">
          <Plus className="h-3.5 w-3.5" /> Ordner
        </button>
      )}
      {PromptModalElement}
    </div>
  );
}
