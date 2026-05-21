"use client";

/**
 * Budget-Page — Firmen-Budget pro Jahr & Kategorie.
 *
 * Datenmodell:
 *  - budget_categories: hierarchisch (parent_id), sortiert via sort_order.
 *  - budget_entries:    pro (category, fiscal_year) ein Betrag (CHF).
 *
 * Anzeige-Logik:
 *  - Top-Level mit Kindern → Summe der Kinder (read-only).
 *  - Top-Level ohne Kinder → editierbar.
 *  - Kinder                → editierbar.
 *
 * Edit-Flow:
 *  - Input ist local-state pro category_id.
 *  - onBlur → parse + POST /api/budget/entries. Erfolg = Local-State updaten.
 *  - Enter-as-Tab ist global aktiv → Save passiert beim Wechsel zum naechsten Feld.
 *
 * Year-Switcher: Pfeile + Dropdown (2020..currentYear+5). Jahres-Switch laedt
 * nur entries (Kategorien bleiben).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { TrustedDeviceGate } from "@/components/trust/trusted-device-gate";
import { SearchableSelect } from "@/components/searchable-select";
import { Card, CardContent } from "@/components/ui/card";
import { Modal } from "@/components/ui/modal";
import { Input } from "@/components/ui/input";
import {
  Wallet,
  Plus,
  ChevronLeft,
  ChevronRight,
  Archive,
  Pencil,
  Undo2,
  Eye,
  EyeOff,
} from "lucide-react";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { usePermissions } from "@/lib/use-permissions";
import { useConfirm } from "@/components/ui/use-confirm";

// =====================================================================
// Types
// =====================================================================

interface BudgetCategory {
  id: string;
  parent_id: string | null;
  name: string;
  sort_order: number;
  archived_at: string | null;
  /** Wenn gesetzt, wird Soll+Ist automatisch berechnet (kein manuelles Edit,
   *  kein Bexio-Mapping). Aktuell unterstuetzt: 'internal_labor'. */
  auto_source: string | null;
}

interface BudgetEntry {
  id: string;
  category_id: string;
  fiscal_year: number;
  amount_chf: number;
  notes: string | null;
}

interface TreeNode {
  cat: BudgetCategory;
  children: TreeNode[];
}

// =====================================================================
// Helpers
// =====================================================================

const CHF_FORMAT = new Intl.NumberFormat("de-CH", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

function formatCHF(amount: number): string {
  return `CHF ${CHF_FORMAT.format(Math.round(amount))}`;
}

/** Parse a user input string (z.B. "350'000", "350000", "350.000,50") to number.
 *  Liefert NaN wenn der String nicht parsebar ist. Leerstring → 0. */
function parseCHFInput(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  // Apostroph (Schweizer Tausendertrennzeichen) + Leerzeichen weg.
  // Komma als Dezimaltrennzeichen → Punkt.
  // Punkte als Tausendertrennzeichen sind ambivalent — wir nehmen an dass
  // ein einzelner Punkt mit max. 2 Nachkommastellen ein Dezimalpunkt ist,
  // alle anderen Punkte = Tausendertrenner.
  const cleaned = trimmed
    .replace(/['\s]/g, "")
    .replace(/,/g, ".");
  // Wenn mehrere Punkte → alle bis auf den letzten sind Tausendertrenner.
  const parts = cleaned.split(".");
  let normalized: string;
  if (parts.length <= 1) {
    normalized = cleaned;
  } else if (parts.length === 2 && parts[1].length <= 2) {
    // "1234.50" → Dezimal
    normalized = parts.join(".");
  } else {
    // "1.234.567" oder "1.234.567.89" → alle bis auf letzten = Tausendertrenner
    const last = parts.pop()!;
    if (last.length <= 2) {
      normalized = parts.join("") + "." + last;
    } else {
      normalized = parts.join("") + last;
    }
  }
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : NaN;
}

/** Baut den Kategorie-Baum aus der flachen Liste. Archivierte werden
 *  gefiltert, wenn includeArchived nicht gesetzt ist. */
function buildTree(categories: BudgetCategory[], includeArchived = false): TreeNode[] {
  const visible = includeArchived ? categories : categories.filter((c) => !c.archived_at);
  const byParent = new Map<string | null, BudgetCategory[]>();
  for (const c of visible) {
    const key = c.parent_id;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(c);
  }
  for (const arr of byParent.values()) {
    arr.sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  }
  function build(parent_id: string | null): TreeNode[] {
    return (byParent.get(parent_id) ?? []).map((cat) => ({
      cat,
      children: build(cat.id),
    }));
  }
  return build(null);
}

/** Summe einer Node — wenn Kinder vorhanden, Summe der Kinder; sonst eigener Eintrag.
 *  Sonderfall auto_source: der Auto-berechnete Wert auf dem Parent ueberschreibt
 *  die Children-Summe. Sonst wuerden Stempel-Vollkosten (Auto) + Bexio-Lohn-
 *  Buchungen (Children) doppelt zaehlen. */
function nodeTotal(node: TreeNode, entries: Map<string, number>): number {
  if (node.cat.auto_source) {
    return entries.get(node.cat.id) ?? 0;
  }
  if (node.children.length > 0) {
    return node.children.reduce((sum, c) => sum + nodeTotal(c, entries), 0);
  }
  return entries.get(node.cat.id) ?? 0;
}

// =====================================================================
// Page
// =====================================================================

const CURRENT_YEAR = new Date().getFullYear();

export default function BudgetPage() {
  const supabase = createClient();
  const { can } = usePermissions();
  const { confirm, ConfirmModalElement } = useConfirm();

  const canEdit = can("budget:edit");

  const [year, setYear] = useState<number>(CURRENT_YEAR);
  const [categories, setCategories] = useState<BudgetCategory[]>([]);
  const [entries, setEntries] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [savingCats, setSavingCats] = useState<Set<string>>(new Set());
  const [showArchived, setShowArchived] = useState(false);

  // Add-Kategorie-Modal (fuer manuelle Zusatz-Kategorien — Bexio-Konten
  // kommen via Sync, hier kann man optional eigene anlegen).
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newParentId, setNewParentId] = useState<string>(""); // "" = keine Parent
  const [creating, setCreating] = useState(false);

  // Rename-Modal
  const [renameTarget, setRenameTarget] = useState<BudgetCategory | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renaming, setRenaming] = useState(false);

  // Load Kategorien + Eintraege
  const loadCategories = useCallback(async () => {
    const res = await fetch("/api/budget/categories");
    const json = await res.json();
    if (!res.ok || !json.success) {
      toast.error(json.error || "Kategorien konnten nicht geladen werden");
      return;
    }
    setCategories(json.categories as BudgetCategory[]);
  }, []);

  const loadEntries = useCallback(async (y: number) => {
    const res = await fetch(`/api/budget/entries?year=${y}`);
    const json = await res.json();
    if (!res.ok || !json.success) {
      toast.error(json.error || "Eintraege konnten nicht geladen werden");
      return;
    }
    const map = new Map<string, number>();
    for (const e of (json.entries as BudgetEntry[]) ?? []) {
      map.set(e.category_id, Number(e.amount_chf));
    }
    setEntries(map);
  }, []);

  // Auto-Source-Werte (z.B. Personalaufwand = Termine × Vollkosten/h).
  // Werden auf den Soll-Wert der entsprechenden Kategorie ueberlagert.
  const [autoStats, setAutoStats] = useState<Map<string, number>>(new Map());
  const loadAutoStats = useCallback(async (y: number) => {
    const res = await fetch(`/api/budget/internal-stats?year=${y}`);
    const json = await res.json();
    if (!res.ok || !json.success) return;
    const map = new Map<string, number>();
    const byCat = (json.byCategoryId as Record<string, { soll_chf: number }>) ?? {};
    for (const [catId, payload] of Object.entries(byCat)) {
      map.set(catId, Number(payload.soll_chf));
    }
    setAutoStats(map);
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await Promise.all([
        loadCategories(),
        loadEntries(year),
        loadAutoStats(year),
      ]);
      setLoading(false);
    })();
  }, [loadCategories, loadEntries, loadAutoStats, year]);

  // Effektive Entries: manuelle Werte + Auto-Source-Werte ueberlagert.
  // Auto-Source ueberschreibt evtl. existierende manuelle Eintraege fuer
  // die selbe Kategorie (Auto hat Vorrang, kein doppeltes Buchen).
  const effectiveEntries = useMemo(() => {
    const merged = new Map(entries);
    for (const [catId, soll] of autoStats.entries()) {
      merged.set(catId, soll);
    }
    return merged;
  }, [entries, autoStats]);

  // Tree + Totals
  const tree = useMemo(() => buildTree(categories, showArchived), [categories, showArchived]);
  const grandTotal = useMemo(
    () => tree.reduce((sum, n) => sum + nodeTotal(n, effectiveEntries), 0),
    [tree, effectiveEntries],
  );


  // Save eines Eintrags (upsert)
  const saveEntry = useCallback(
    async (categoryId: string, amount: number): Promise<boolean> => {
      if (!canEdit) return false;
      setSavingCats((s) => new Set(s).add(categoryId));
      try {
        const res = await fetch("/api/budget/entries", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category_id: categoryId, fiscal_year: year, amount_chf: amount }),
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          toast.error(json.error || "Speichern fehlgeschlagen");
          return false;
        }
        setEntries((prev) => {
          const next = new Map(prev);
          if (amount === 0) next.delete(categoryId);
          else next.set(categoryId, amount);
          return next;
        });
        return true;
      } finally {
        setSavingCats((s) => {
          const next = new Set(s);
          next.delete(categoryId);
          return next;
        });
      }
    },
    [canEdit, year],
  );

  // Neue Kategorie anlegen
  async function handleCreate() {
    const name = newName.trim();
    if (!name) {
      TOAST.requiredField("Name");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/budget/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, parent_id: newParentId || null }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        toast.error(json.error || "Anlegen fehlgeschlagen");
        return;
      }
      toast.success("Kategorie angelegt");
      setAddModalOpen(false);
      setNewName("");
      setNewParentId("");
      await loadCategories();
    } finally {
      setCreating(false);
    }
  }

  // Rename
  async function handleRename() {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name) {
      TOAST.requiredField("Name");
      return;
    }
    if (name === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    setRenaming(true);
    try {
      const res = await fetch(`/api/budget/categories/${renameTarget.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        toast.error(json.error || "Umbenennen fehlgeschlagen");
        return;
      }
      toast.success("Umbenannt");
      setRenameTarget(null);
      await loadCategories();
    } finally {
      setRenaming(false);
    }
  }

  // Archivieren — verschiebt die Kategorie in den "Archiv anzeigen"-Modus,
  // wird in der normalen Liste nicht mehr angezeigt. Restore via Toggle.
  async function handleArchive(cat: BudgetCategory) {
    const ok = await confirm({
      title: `"${cat.name}" archivieren?`,
      message:
        "Die Kategorie verschwindet aus der Liste. Du kannst sie ueber den 'Archiv anzeigen'-Schalter wieder herholen.",
      confirmLabel: "Archivieren",
      variant: "red",
    });
    if (!ok) return;
    const res = await fetch(`/api/budget/categories/${cat.id}`, { method: "DELETE" });
    const json = await res.json();
    if (!res.ok || !json.success) {
      toast.error(json.error || "Archivieren fehlgeschlagen");
      return;
    }
    toast.success("Archiviert");
    await loadCategories();
  }

  // Wiederherstellen — setzt archived_at auf null via PATCH.
  async function handleRestore(cat: BudgetCategory) {
    const res = await fetch(`/api/budget/categories/${cat.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ archived_at: null }),
    });
    const json = await res.json();
    if (!res.ok || !json.success) {
      toast.error(json.error || "Wiederherstellen fehlgeschlagen");
      return;
    }
    toast.success("Wiederhergestellt");
    await loadCategories();
  }

  // ===================================================================
  // Render
  // ===================================================================

  return (
    <TrustedDeviceGate>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Budget</h1>
          <p className="text-sm text-muted-foreground mt-1" aria-hidden="true">&nbsp;</p>
        </div>
        <div className="flex items-center gap-2">
          <YearPicker year={year} onChange={setYear} />
          {canEdit && (
            <button
              type="button"
              onClick={() => setShowArchived((s) => !s)}
              className={showArchived ? "kasten kasten-purple" : "kasten kasten-muted"}
              data-tooltip={showArchived ? "Archivierte ausblenden" : "Archivierte anzeigen"}
              data-tooltip-side="bottom"
              data-tooltip-align="end"
            >
              {showArchived ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              Archiv
            </button>
          )}
          {canEdit && (
            <button
              type="button"
              onClick={() => {
                setNewName("");
                setNewParentId("");
                setAddModalOpen(true);
              }}
              className="kasten kasten-green"
            >
              <Plus className="h-4 w-4" />
              Kategorie
            </button>
          )}
        </div>
      </div>

      {/* Budget-Liste */}
      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="p-8 text-center text-sm text-muted-foreground">Laden ...</div>
          ) : tree.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              Noch keine Kategorien angelegt.
              {canEdit && " Klicke auf \"Kategorie\" um zu starten."}
            </div>
          ) : (
            <div className="divide-y">
              {tree.map((node) => (
                <BudgetRowGroup
                  key={node.cat.id}
                  node={node}
                  entries={effectiveEntries}
                  savingCats={savingCats}
                  canEdit={canEdit}
                  onSave={saveEntry}
                  onRename={(c) => {
                    setRenameTarget(c);
                    setRenameValue(c.name);
                  }}
                  onArchive={handleArchive}
                  onRestore={handleRestore}
                  onAddChild={(c) => {
                    setNewName("");
                    setNewParentId(c.id);
                    setAddModalOpen(true);
                  }}
                />
              ))}
              {/* Total */}
              <div className="flex items-center gap-2 px-4 py-3 bg-muted/40">
                <div className="flex-1 text-sm font-semibold">Total {year}</div>
                <div className="w-32 text-right text-base font-semibold tabular-nums">
                  {formatCHF(grandTotal)}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add-Modal */}
      <Modal
        open={addModalOpen}
        onClose={() => !creating && setAddModalOpen(false)}
        title="Neue Kategorie"
        icon={<Wallet className="h-5 w-5 text-green-600 dark:text-green-400" />}
        size="sm"
        closable={!creating}
      >
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Name</label>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="z.B. Reise & Bewirtung"
              maxLength={80}
              autoFocus
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Eltern-Kategorie (optional)
            </label>
            <SearchableSelect
              value={newParentId}
              onChange={setNewParentId}
              items={categories
                .filter((c) => !c.archived_at && !c.parent_id)
                .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
                .map((c) => ({ id: c.id, label: c.name }))}
              placeholder="— Keine (Top-Level) —"
              searchable={false}
            />
          </div>
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={() => setAddModalOpen(false)}
              disabled={creating}
              className="kasten kasten-muted flex-1"
            >
              Abbrechen
            </button>
            <button
              type="button"
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
              className="kasten kasten-green flex-1"
            >
              {creating ? "..." : "Anlegen"}
            </button>
          </div>
        </div>
      </Modal>

      {/* Rename-Modal */}
      <Modal
        open={!!renameTarget}
        onClose={() => !renaming && setRenameTarget(null)}
        title="Umbenennen"
        icon={<Pencil className="h-5 w-5 text-blue-500" />}
        size="sm"
        closable={!renaming}
      >
        <div className="space-y-3">
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            maxLength={80}
            autoFocus
          />
          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={() => setRenameTarget(null)}
              disabled={renaming}
              className="kasten kasten-muted flex-1"
            >
              Abbrechen
            </button>
            <button
              type="button"
              onClick={handleRename}
              disabled={renaming || !renameValue.trim()}
              className="kasten kasten-blue flex-1"
            >
              {renaming ? "..." : "Speichern"}
            </button>
          </div>
        </div>
      </Modal>

      {ConfirmModalElement}
    </div>
    </TrustedDeviceGate>
  );
}

// =====================================================================
// Sub-Komponente: eine Top-Level-Gruppe (Parent + Children)
// =====================================================================

function BudgetRowGroup({
  node,
  entries,
  savingCats,
  canEdit,
  onSave,
  onRename,
  onArchive,
  onRestore,
  onAddChild,
}: {
  node: TreeNode;
  entries: Map<string, number>;
  savingCats: Set<string>;
  canEdit: boolean;
  onSave: (categoryId: string, amount: number) => Promise<boolean>;
  onRename: (cat: BudgetCategory) => void;
  onArchive: (cat: BudgetCategory) => void;
  onRestore: (cat: BudgetCategory) => void;
  onAddChild: (cat: BudgetCategory) => void;
}) {
  const hasChildren = node.children.length > 0;
  const total = nodeTotal(node, entries);

  return (
    <>
      {/* Parent-Zeile */}
      <BudgetRow
        cat={node.cat}
        amount={hasChildren ? total : (entries.get(node.cat.id) ?? 0)}
        readOnly={hasChildren || !!node.cat.auto_source}
        autoSource={node.cat.auto_source}
        depth={0}
        saving={savingCats.has(node.cat.id)}
        canEdit={canEdit}
        onSave={onSave}
        onRename={onRename}
        onArchive={onArchive}
        onRestore={onRestore}
        onAddChild={canEdit ? onAddChild : undefined}
      />
      {/* Children — bei auto_source verstecken (Auto-Wert deckt sie ab). */}
      {!node.cat.auto_source && node.children.map((child) => (
        <BudgetRow
          key={child.cat.id}
          cat={child.cat}
          amount={entries.get(child.cat.id) ?? 0}
          readOnly={!!child.cat.auto_source}
          autoSource={child.cat.auto_source}
          depth={1}
          saving={savingCats.has(child.cat.id)}
          canEdit={canEdit}
          onSave={onSave}
          onRename={onRename}
          onArchive={onArchive}
          onRestore={onRestore}
        />
      ))}
    </>
  );
}

// =====================================================================
// Sub-Komponente: eine einzelne Zeile
// =====================================================================

function BudgetRow({
  cat,
  amount,
  readOnly,
  autoSource,
  depth,
  saving,
  canEdit,
  onSave,
  onRename,
  onArchive,
  onRestore,
  onAddChild,
}: {
  cat: BudgetCategory;
  amount: number;
  readOnly: boolean;
  autoSource: string | null;
  depth: 0 | 1;
  saving: boolean;
  canEdit: boolean;
  onSave: (categoryId: string, amount: number) => Promise<boolean>;
  onRename: (cat: BudgetCategory) => void;
  onArchive: (cat: BudgetCategory) => void;
  onRestore: (cat: BudgetCategory) => void;
  onAddChild?: (cat: BudgetCategory) => void;
}) {
  const isArchived = !!cat.archived_at;
  // Editierbarer Wert als lokaler String — wird erst beim Blur gespeichert.
  const initial = amount > 0 ? String(Math.round(amount)) : "";
  const [value, setValue] = useState(initial);
  const lastSavedRef = useRef(initial);
  const [hover, setHover] = useState(false);

  // Wenn der externe amount sich aendert (z.B. anderer Jahres-Switch),
  // den lokalen Wert nachziehen — aber nur wenn der User gerade nicht tippt.
  useEffect(() => {
    const next = amount > 0 ? String(Math.round(amount)) : "";
    setValue(next);
    lastSavedRef.current = next;
  }, [amount, cat.id]);

  async function handleBlur() {
    if (readOnly || !canEdit) return;
    if (value === lastSavedRef.current) return;
    const parsed = parseCHFInput(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      toast.error("Bitte einen gueltigen Betrag eingeben");
      setValue(lastSavedRef.current);
      return;
    }
    const ok = await onSave(cat.id, parsed);
    if (ok) {
      lastSavedRef.current = parsed > 0 ? String(Math.round(parsed)) : "";
      setValue(lastSavedRef.current);
    } else {
      setValue(lastSavedRef.current);
    }
  }

  // Indent: Children eingerueckt, sonst gleicher Aufbau wie Parents. Bewusst
  // KEIN └-Prefix und KEIN Lock-Icon — Hierarchie ueber Indent + Font-Weight
  // ist genug, alles weitere wird visuell zu unruhig.
  const indentClass = depth === 1 ? "pl-10" : "pl-4";
  const baseLabelClass = depth === 1 ? "text-sm text-muted-foreground" : "text-sm font-medium";
  // Archivierte Kategorien optisch zurueckgenommen: Durchgestrichen + ausgegraut.
  const labelClass = isArchived ? `${baseLabelClass} line-through opacity-60` : baseLabelClass;

  return (
    <div
      className={`flex items-center gap-2 py-2 pr-3 ${indentClass} transition-colors`}
      style={hover ? { backgroundColor: "var(--muted)" } : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      {/* Linke Spalte: Name + ggf. Auto-Badge */}
      <button
        type="button"
        onClick={() => canEdit && !isArchived && onRename(cat)}
        disabled={!canEdit || isArchived}
        className={`${labelClass} truncate text-left min-w-0 flex-1 ${canEdit && !isArchived ? "hover:underline" : "cursor-default"}`}
        data-tooltip={canEdit && !isArchived ? "Klicken zum Umbenennen" : undefined}
      >
        {cat.name}
      </button>
      {isArchived && (
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground border rounded-full px-1.5 py-0.5">
          Archiviert
        </span>
      )}
      {autoSource === "internal_labor" && (
        <span
          className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground border rounded-full px-1.5 py-0.5"
          data-tooltip="Soll = geplante Termine × Vollkosten/h · Ist = gestempelte Stunden × Vollkosten/h. Raten unter HR → Löhne, ueberschreibt Bexio-Buchungen dieser Konto-Gruppe."
        >
          Auto
        </span>
      )}

      {/* Actions — reservieren immer Platz, fade in/out (kein Layout-Shift).
          Archiviert: nur Restore-Button. Aktiv: Add-Child + Archive. */}
      {canEdit && (
        <div
          className={`flex items-center gap-0.5 transition-opacity ${hover ? "opacity-100" : "opacity-0 pointer-events-none"}`}
        >
          {isArchived ? (
            <button
              type="button"
              onClick={() => onRestore(cat)}
              className="p-1 rounded hover:bg-foreground/10 text-muted-foreground hover:text-emerald-600 dark:hover:text-emerald-400"
              data-tooltip="Wiederherstellen"
            >
              <Undo2 className="h-3.5 w-3.5" />
            </button>
          ) : (
            <>
              {onAddChild && (
                <button
                  type="button"
                  onClick={() => onAddChild(cat)}
                  className="p-1 rounded hover:bg-foreground/10 text-muted-foreground"
                  data-tooltip="Sub-Kategorie hinzufuegen"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => onArchive(cat)}
                className="p-1 rounded hover:bg-foreground/10 text-muted-foreground hover:text-red-600 dark:hover:text-red-400"
                data-tooltip="Archivieren"
              >
                <Archive className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      )}

      {/* Rechte Spalte: Soll — gleiche Breite fuer Read-only und Input. */}
      <div className="w-32 shrink-0">
        {readOnly ? (
          <div
            className="h-8 flex items-center justify-end pr-2.5 text-sm tabular-nums text-muted-foreground"
            data-tooltip={autoSource ? "Automatisch berechnet" : "Summe aus Sub-Kategorien"}
          >
            {amount > 0 ? CHF_FORMAT.format(Math.round(amount)) : "–"}
          </div>
        ) : (
          <Input
            type="text"
            inputMode="numeric"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onBlur={handleBlur}
            disabled={!canEdit || saving}
            placeholder="–"
            className="text-right tabular-nums"
          />
        )}
      </div>

    </div>
  );
}

// =====================================================================
// Sub-Komponente: Year-Picker
// =====================================================================

function YearPicker({ year, onChange }: { year: number; onChange: (y: number) => void }) {
  const min = 2020;
  const max = CURRENT_YEAR + 5;
  const items = useMemo(() => {
    const arr: { id: string; label: string }[] = [];
    for (let y = max; y >= min; y--) arr.push({ id: String(y), label: String(y) });
    return arr;
  }, [max]);

  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        onClick={() => onChange(Math.max(min, year - 1))}
        disabled={year <= min}
        className="kasten kasten-muted px-2"
        aria-label="Vorjahr"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <div className="w-24">
        <SearchableSelect
          value={String(year)}
          onChange={(v) => v && onChange(parseInt(v, 10))}
          items={items}
          searchable={false}
          clearable={false}
        />
      </div>
      <button
        type="button"
        onClick={() => onChange(Math.min(max, year + 1))}
        disabled={year >= max}
        className="kasten kasten-muted px-2"
        aria-label="Folgejahr"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}
