"use client";

// Folder-Picker fuer den Lead-Editor — Multi-Select Dropdown.
// Zeigt private + shared Folders als flachen Tree mit Checkbox.
// - Private Folder: 1 pro User (App-Layer erzwingt); wechseln = alte weg,
//   neue setzen.
// - Shared Folder: beliebig viele — jeder Lead kann in mehreren stehen.
// RLS: shared sind fuer alle sichtbar; private nur fuer Owner.

import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { Folder, FolderInput, FolderOpen, ChevronDown, Check, Users } from "lucide-react";
import { folderColor } from "@/components/vertrieb/folder-colors";

interface FolderRow {
  id: string;
  parent_id: string | null;
  name: string;
  color: string | null;
  is_shared: boolean;
  owner_id: string;
}

interface Props {
  leadId: string;
  onChanged?: () => void;
}

export function VertriebFolderPicker({ leadId, onChanged }: Props) {
  const supabase = createClient();
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [assigned, setAssigned] = useState<Set<string>>(new Set());
  const [userId, setUserId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    const [{ data: { user } }, foldersRes, mineRes] = await Promise.all([
      supabase.auth.getUser(),
      supabase.from("vertrieb_folders").select("id, parent_id, name, color, is_shared, owner_id").order("name"),
      supabase.from("vertrieb_lead_folders").select("folder_id").eq("lead_id", leadId),
    ]);
    setUserId(user?.id ?? null);
    setFolders((foldersRes.data ?? []) as FolderRow[]);
    const set = new Set<string>();
    for (const row of (mineRes.data ?? []) as { folder_id: string }[]) set.add(row.folder_id);
    setAssigned(set);
  }, [supabase, leadId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const flatTree = useMemo(() => {
    // Zwei Gruppen: shared (oben) + meine private. RLS filtert eh.
    const childrenBy = new Map<string | null, FolderRow[]>();
    for (const f of folders) {
      const arr = childrenBy.get(f.parent_id) ?? [];
      arr.push(f);
      childrenBy.set(f.parent_id, arr);
    }
    const out: { f: FolderRow; depth: number; group: "shared" | "private" }[] = [];
    function walk(parentId: string | null, depth: number, group: "shared" | "private") {
      const kids = (childrenBy.get(parentId) ?? []).filter((f) => (group === "shared" ? f.is_shared : !f.is_shared))
        .slice().sort((a, b) => a.name.localeCompare(b.name));
      for (const k of kids) {
        out.push({ f: k, depth, group });
        walk(k.id, depth + 1, group);
      }
    }
    walk(null, 0, "shared");
    walk(null, 0, "private");
    return out;
  }, [folders]);

  async function toggle(folderId: string) {
    if (!userId) return;
    const target = folders.find((f) => f.id === folderId);
    if (!target) return;
    setSaving(true);
    try {
      const isCurrentlyAssigned = assigned.has(folderId);
      if (isCurrentlyAssigned) {
        const { error } = await supabase
          .from("vertrieb_lead_folders")
          .delete()
          .eq("lead_id", leadId)
          .eq("folder_id", folderId);
        if (error) { toast.error("Konnte nicht entfernen: " + error.message); return; }
        toast.success(target.is_shared ? "Aus geteiltem Ordner entfernt" : "Aus Ordner entfernt");
        setAssigned((prev) => {
          const next = new Set(prev);
          next.delete(folderId);
          return next;
        });
      } else {
        if (!target.is_shared) {
          // Privat: alte private Zuweisung fuer diesen User loeschen (single-owner-Regel).
          const myOtherPrivate = folders
            .filter((f) => !f.is_shared && f.owner_id === userId && f.id !== folderId && assigned.has(f.id))
            .map((f) => f.id);
          if (myOtherPrivate.length > 0) {
            await supabase
              .from("vertrieb_lead_folders")
              .delete()
              .eq("lead_id", leadId)
              .in("folder_id", myOtherPrivate);
          }
        }
        const { error } = await supabase
          .from("vertrieb_lead_folders")
          .upsert({ lead_id: leadId, owner_id: userId, folder_id: folderId }, { onConflict: "lead_id,folder_id" });
        if (error) { toast.error("Konnte nicht verschieben: " + error.message); return; }
        toast.success(target.is_shared ? "In geteilten Ordner" : "In Ordner verschoben");
        setAssigned((prev) => {
          const next = new Set(prev);
          if (!target.is_shared) {
            // andere private raus
            for (const f of folders) {
              if (!f.is_shared && f.owner_id === userId && f.id !== folderId) next.delete(f.id);
            }
          }
          next.add(folderId);
          return next;
        });
      }
      onChanged?.();
    } finally {
      setSaving(false);
    }
  }

  // Trigger-Text: "Kein Ordner" / "Foldername" / "N Ordner"
  const assignedFolders = folders.filter((f) => assigned.has(f.id));
  const triggerLabel = assignedFolders.length === 0
    ? "Kein Ordner"
    : assignedFolders.length === 1
      ? assignedFolders[0].name
      : `${assignedFolders.length} Ordner`;
  const primaryColor = assignedFolders[0] ? folderColor(assignedFolders[0].color) : folderColor(null);
  const hasAssigned = assignedFolders.length > 0;
  const hasAnyShared = assignedFolders.some((f) => f.is_shared);

  const sharedItems = flatTree.filter((x) => x.group === "shared");
  const privateItems = flatTree.filter((x) => x.group === "private");

  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={saving}
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border bg-card text-xs font-medium hover:bg-foreground/[0.04] transition-colors disabled:opacity-50"
        data-tooltip={hasAssigned
          ? `${assignedFolders.length === 1 ? "Ordner" : "Ordner"}: ${assignedFolders.map((f) => (f.is_shared ? "🫂 " : "") + f.name).join(" · ")}`
          : "In einen Ordner verschieben"}
      >
        {hasAssigned
          ? (hasAnyShared
              ? <Users className={`h-3.5 w-3.5 ${primaryColor.icon}`} />
              : <FolderOpen className={`h-3.5 w-3.5 ${primaryColor.icon}`} />)
          : <FolderInput className="h-3.5 w-3.5 text-muted-foreground" />}
        <span className="max-w-[140px] truncate">{triggerLabel}</span>
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute z-50 mt-1 left-0 min-w-[240px] max-h-80 overflow-y-auto rounded-md border border-border bg-popover shadow-lg py-1">
          {flatTree.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-muted-foreground italic">
              Noch keine Ordner. Lege links in der Ordner-Sidebar einen an.
            </p>
          ) : (
            <>
              {sharedItems.length > 0 && (
                <>
                  <p className="px-2.5 pt-1 pb-0.5 text-[9px] font-semibold uppercase tracking-wider text-blue-700 dark:text-blue-300 flex items-center gap-1">
                    <Users className="h-2.5 w-2.5" />Geteilte Ordner (alle)
                  </p>
                  {sharedItems.map(({ f, depth }) => (
                    <PickerRow key={f.id} f={f} depth={depth} checked={assigned.has(f.id)} onToggle={() => toggle(f.id)} shared />
                  ))}
                </>
              )}
              {privateItems.length > 0 && (
                <>
                  {sharedItems.length > 0 && <div className="my-0.5 border-t border-border" />}
                  <p className="px-2.5 pt-1 pb-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Meine Ordner
                  </p>
                  {privateItems.map(({ f, depth }) => (
                    <PickerRow key={f.id} f={f} depth={depth} checked={assigned.has(f.id)} onToggle={() => toggle(f.id)} />
                  ))}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PickerRow({ f, depth, checked, onToggle, shared }: { f: FolderRow; depth: number; checked: boolean; onToggle: () => void; shared?: boolean }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full text-left px-2.5 py-1.5 text-xs inline-flex items-center gap-1.5 hover:bg-foreground/[0.06]"
      style={{ paddingLeft: `${depth * 12 + 10}px` }}
    >
      <span className={`inline-flex items-center justify-center w-3.5 h-3.5 rounded border ${checked ? "bg-blue-500 border-blue-500 text-white" : "border-border"}`}>
        {checked && <Check className="h-2.5 w-2.5" />}
      </span>
      {shared ? (
        <Users className={`h-3.5 w-3.5 ${folderColor(f.color).icon} shrink-0`} />
      ) : (
        <Folder className={`h-3.5 w-3.5 ${folderColor(f.color).icon} shrink-0`} />
      )}
      <span className="truncate">{f.name}</span>
    </button>
  );
}
