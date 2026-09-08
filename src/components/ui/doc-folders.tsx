"use client";

/**
 * Ordner fuer Dokumente — EINE Ebene, bewusst simpel:
 * Ein Ordner ist ein Text-Attribut pro Dokument (null/fehlend = Hauptordner).
 * Keine eigene Ordner-Tabelle — ein Ordner existiert, solange Dokumente
 * ihn tragen; frisch angelegte leere Ordner leben bis zum ersten Upload
 * nur im Client-State des Parents (extraFolders).
 *
 * Drei Bausteine, app-weit gleich (Auftrag / Projekt / Standort):
 *   <DocFolderBar>  — Chip-Leiste "Alle | Hauptordner | <Ordner…> | + Ordner"
 *   <DocFolderMove> — Verschieben-Button (FolderInput) mit Popover pro Zeile
 *   <DocFolderTag>  — kleiner muted Ordner-Chip fuer die "Alle"-Ansicht
 *
 * Aktiv-Zustand (ActiveFolder):
 *   null  = "Alle" (Default)
 *   ""    = Hauptordner (Dokumente ohne Ordner)
 *   sonst = Ordnername
 * Upload landet via folderForUpload() im aktiven Ordner; bei "Alle"
 * im Hauptordner.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Folder, FolderInput, Plus } from "lucide-react";
import { toast } from "sonner";
import { usePrompt } from "@/components/ui/use-prompt";

/** null = "Alle", "" = Hauptordner, sonst = Ordnername. */
export type ActiveFolder = string | null;

/** Ordner-Wert fuer einen Upload im aktuellen Filter ("Alle" → Hauptordner). */
export function folderForUpload(active: ActiveFolder): string | null {
  return active ? active : null;
}

/** Gehoert ein Dokument (mit seinem folder-Wert) in die aktive Ansicht? */
export function matchesFolder(
  docFolder: string | null | undefined,
  active: ActiveFolder,
): boolean {
  if (active === null) return true; // Alle
  if (active === "") return !docFolder; // Hauptordner
  return docFolder === active;
}

/**
 * Ordner-Liste (Name + Anzahl) aus den Dokumenten ableiten und mit den
 * frisch angelegten (noch leeren) Client-State-Ordnern vereinen.
 */
export function collectFolders(
  docFolders: (string | null | undefined)[],
  extraFolders: string[],
): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const f of docFolders) {
    if (!f) continue;
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  for (const e of extraFolders) {
    if (!counts.has(e)) counts.set(e, 0);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, "de"));
}

function ChipCount({ n }: { n: number }) {
  return <span className="text-[10px] opacity-60 tabular-nums">{n}</span>;
}

/* ============================================================
   DocFolderBar — Chip-Leiste ueber der Dokumentenliste
   ============================================================ */

export function DocFolderBar({
  folders,
  mainCount,
  totalCount,
  active,
  onSelect,
  onCreate,
  canCreate = true,
}: {
  folders: { name: string; count: number }[];
  /** Anzahl Dokumente ohne Ordner (Hauptordner). */
  mainCount: number;
  totalCount: number;
  active: ActiveFolder;
  onSelect: (next: ActiveFolder) => void;
  /** Parent haengt den Namen an extraFolders an + setzt ihn aktiv. */
  onCreate: (name: string) => void;
  canCreate?: boolean;
}) {
  const { prompt, PromptModalElement } = usePrompt();
  const showChips = folders.length > 0;

  // Ohne Ordner + ohne Anlege-Recht gibt es nichts zu zeigen —
  // die Leiste verschwindet komplett (kein UI-Rauschen).
  if (!showChips && !canCreate) return null;

  async function handleCreate() {
    const raw = await prompt({
      title: "Neuer Ordner",
      label: "Wie soll der Ordner heissen?",
      placeholder: "z.B. Pläne, Verträge, Fotos",
      confirmLabel: "Anlegen",
      variant: "blue",
      maxLength: 40,
    });
    if (raw === null) return;
    const name = raw.replace(/\s+/g, " ").trim();
    if (!name) return;
    // usePrompt laesst Enter am disabled-Button vorbei — Laenge hier hart gaten
    // (die Standort-API validiert das folder-Feld ebenfalls).
    if (name.length > 40) {
      toast.error("Ordnername zu lang (max. 40 Zeichen)");
      return;
    }
    const lower = name.toLowerCase();
    if (lower === "alle" || lower === "hauptordner") {
      toast.error("Dieser Name ist reserviert");
      return;
    }
    const existing = folders.find((f) => f.name.toLowerCase() === lower);
    if (existing) {
      onSelect(existing.name);
      toast(`Ordner «${existing.name}» gibt es schon — ausgewählt`);
      return;
    }
    onCreate(name);
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {showChips && (
        <>
          <button
            type="button"
            onClick={() => onSelect(null)}
            className={active === null ? "kasten-active" : "kasten-toggle-off"}
          >
            Alle
            <ChipCount n={totalCount} />
          </button>
          <button
            type="button"
            onClick={() => onSelect("")}
            className={active === "" ? "kasten-active" : "kasten-toggle-off"}
          >
            <Folder className="h-3.5 w-3.5" />
            Hauptordner
            <ChipCount n={mainCount} />
          </button>
          {folders.map((f) => (
            <button
              key={f.name}
              type="button"
              onClick={() => onSelect(f.name)}
              className={active === f.name ? "kasten-active" : "kasten-toggle-off"}
            >
              <Folder className="h-3.5 w-3.5" />
              <span className="max-w-[140px] truncate">{f.name}</span>
              <ChipCount n={f.count} />
            </button>
          ))}
        </>
      )}
      {canCreate && (
        <button
          type="button"
          onClick={handleCreate}
          className="kasten kasten-muted"
          data-tooltip="Neuen Ordner anlegen — Uploads landen im aktiven Ordner"
        >
          <Plus className="h-3.5 w-3.5" />
          Ordner
        </button>
      )}
      {PromptModalElement}
    </div>
  );
}

/* ============================================================
   DocFolderMove — Verschieben-Popover pro Dokument-Zeile
   ============================================================ */

type PopoverPos = { top?: number; bottom?: number; right: number };

export function DocFolderMove({
  folders,
  current,
  onMove,
  buttonClassName = "kasten kasten-muted",
  disabled,
}: {
  /** Vorhandene Ordner-Namen (sortiert, inkl. frisch angelegter). */
  folders: string[];
  /** Aktueller Ordner des Dokuments (null = Hauptordner). */
  current: string | null;
  onMove: (folder: string | null) => void | Promise<void>;
  /** Trigger-Optik je Kontext (Kasten-Button vs. Icon-Button). */
  buttonClassName?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<PopoverPos>({ top: 0, right: 0 });
  const [moving, setMoving] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Outside-Click / Esc / Scroll / Resize schliessen das Popover.
  // Popover haengt via Portal + position:fixed an document.body —
  // damit kein overflow-hidden-Ancestor (Standort-Card) es abschneidet.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onScrollOrResize = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open]);

  // Nichts zum Verschieben: keine Ordner vorhanden UND Doc liegt im
  // Hauptordner → Button ganz weglassen (Zeile bleibt aufgeraeumt).
  if (folders.length === 0 && !current) return null;

  function toggleOpen() {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const right = Math.max(8, window.innerWidth - rect.right);
    // Unten zu wenig Platz → nach oben aufklappen.
    if (window.innerHeight - rect.bottom < 280) {
      setPos({ bottom: window.innerHeight - rect.top + 4, right });
    } else {
      setPos({ top: rect.bottom + 4, right });
    }
    setOpen(true);
  }

  async function handleMove(target: string | null) {
    setOpen(false);
    if (target === current || moving) return;
    setMoving(true);
    try {
      await onMove(target);
    } finally {
      setMoving(false);
    }
  }

  const options: { value: string | null; label: string }[] = [
    { value: null, label: "Hauptordner" },
    ...folders.map((f) => ({ value: f, label: f })),
  ];

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggleOpen}
        disabled={disabled || moving}
        className={buttonClassName}
        data-tooltip="In Ordner verschieben"
        aria-label="In Ordner verschieben"
        aria-expanded={open}
      >
        <FolderInput className="h-3.5 w-3.5" />
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            ref={popRef}
            style={{
              position: "fixed",
              top: pos.top,
              bottom: pos.bottom,
              right: pos.right,
              zIndex: 1000,
            }}
            className="min-w-[190px] max-w-[260px] max-h-64 overflow-y-auto rounded-xl border border-border bg-popover shadow-lg py-1"
          >
            <p className="px-2.5 pt-1 pb-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
              Verschieben nach
            </p>
            {options.map((o) => {
              const isCurrent = o.value === current;
              return (
                <button
                  key={o.value === null ? " hauptordner" : o.value}
                  type="button"
                  onClick={() => handleMove(o.value)}
                  className="w-full text-left px-2.5 py-1.5 text-xs inline-flex items-center gap-1.5 hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.14]"
                >
                  <Folder
                    className={`h-3.5 w-3.5 shrink-0 ${o.value === null ? "text-muted-foreground" : "text-amber-500"}`}
                  />
                  <span className="truncate flex-1">{o.label}</span>
                  {isCurrent && <Check className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}

/* ============================================================
   DocFolderTag — kleiner Ordner-Chip in der "Alle"-Ansicht
   ============================================================ */

export function DocFolderTag({ folder }: { folder: string | null | undefined }) {
  if (!folder) return null;
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-foreground/[0.05] dark:bg-foreground/[0.12] text-[10px] text-muted-foreground max-w-[140px] shrink-0">
      <Folder className="h-2.5 w-2.5 shrink-0" />
      <span className="truncate">{folder}</span>
    </span>
  );
}
