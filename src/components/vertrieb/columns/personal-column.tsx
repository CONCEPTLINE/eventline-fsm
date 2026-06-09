"use client";

/**
 * PersonalColumn — Leads die einem User zugewiesen sind.
 *
 * Default: zeigt die eigenen Leads (assigned_to = currentUserId).
 * Admin: Person-Switcher oben (Dropdown) zum Anzeigen fremder Pipelines.
 *
 * Drop-Target: Lead aus GeneralColumn hier rein = assign an die aktuell
 * ausgewaehlte Person.
 * Drag-Source: jede Lead-Row ist draggable, kann zurueck in General
 * (= unassign) oder in eine andere personal column (= reassign, nur Admin).
 *
 * Reassign-Regel: nur Admins koennen einem Lead einen anderen Owner geben.
 * Wenn nicht-Admin einen Lead droppt der schon einem anderen gehoert,
 * blockt der Parent-Handler — wir zeigen nur die UI.
 */

import { useMemo, useState } from "react";
import { LeadRow } from "./lead-row";
import { SearchableSelect } from "@/components/searchable-select";
import { Inbox } from "lucide-react";
import type { VertriebContact } from "@/types";
import { daysSinceLastTouch } from "@/lib/vertrieb-anomaly";

interface Props {
  contacts: VertriebContact[];
  selectedId: string | null;
  onSelect: (c: VertriebContact) => void;
  /** Auf wen ist die Spalte aktuell gefiltert? Standard: currentUserId. */
  viewedUserId: string;
  setViewedUserId: (id: string) => void;
  currentUserId: string;
  isAdmin: boolean;
  salesPeople: { id: string; full_name: string }[];
  /** Drop von einem Lead in diese Spalte. Parent entscheidet ob assign
   *  erlaubt (Reassign-Regel). */
  onAssign: (leadId: string, toUserId: string) => void;
}

export function PersonalColumn({
  contacts, selectedId, onSelect, viewedUserId, setViewedUserId,
  currentUserId, isAdmin, salesPeople, onAssign,
}: Props) {
  const [dragOver, setDragOver] = useState(false);
  const nowMs = Date.now();

  const filtered = useMemo(() => {
    return contacts
      .filter((c) => c.assigned_to === viewedUserId && c.status !== "gewonnen" && c.status !== "abgesagt")
      .sort((a, b) => {
        const ad = daysSinceLastTouch(a, nowMs);
        const bd = daysSinceLastTouch(b, nowMs);
        if (ad === null && bd === null) return 0;
        if (ad === null) return 1;
        if (bd === null) return -1;
        return bd - ad;
      });
  }, [contacts, viewedUserId, nowMs]);

  const viewedName = salesPeople.find((s) => s.id === viewedUserId)?.full_name ?? "Mich";

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const data = e.dataTransfer.getData("text/plain");
    if (!data.startsWith("lead:")) return;
    const leadId = data.slice(5);
    onAssign(leadId, viewedUserId);
  }

  // Person-Switcher Items: Mich zuerst, dann alle anderen.
  const peopleOptions = useMemo(() => {
    const me = salesPeople.find((s) => s.id === currentUserId);
    const others = salesPeople.filter((s) => s.id !== currentUserId);
    const items: { id: string; label: string }[] = [];
    if (me) items.push({ id: me.id, label: `Meine (${me.full_name})` });
    items.push(...others.map((s) => ({ id: s.id, label: s.full_name })));
    return items;
  }, [salesPeople, currentUserId]);

  return (
    <div
      className={`flex flex-col h-full min-h-0 ${dragOver ? "ring-2 ring-red-500 ring-inset" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
    >
      <div className="p-2 border-b border-border space-y-1.5 shrink-0">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground px-1">
          {viewedUserId === currentUserId ? "Meine" : viewedName} · {filtered.length}
        </p>
        {/* Person-Switcher fuer Admins. Nicht-Admins sehen fix die eigene. */}
        {isAdmin && peopleOptions.length > 1 && (
          <SearchableSelect
            value={viewedUserId}
            onChange={setViewedUserId}
            items={peopleOptions}
            searchable={false}
            clearable={false}
            active={viewedUserId !== currentUserId}
          />
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-1.5 space-y-1">
        {filtered.length === 0 ? (
          <div className="text-center py-12 text-xs text-muted-foreground space-y-2">
            <Inbox className="h-6 w-6 mx-auto opacity-40" />
            <p>Leer.</p>
            <p className="text-[10px] opacity-70">Leads aus der linken Spalte hierher ziehen.</p>
          </div>
        ) : filtered.map((c) => (
          <LeadRow
            key={c.id}
            contact={c}
            selected={selectedId === c.id}
            onClick={onSelect}
            draggable
          />
        ))}
      </div>
    </div>
  );
}
