"use client";

/**
 * TodoRow — eine Zeile der Todos-Liste.
 *
 * Layout (Standard-Todo-UX-Grammatik):
 *   [Checkbox]  Titel [Dringend-Chip]         [Ellipsis-Menu]
 *               [Faellig-Chip] [Assignee-Chip] [von-Chip] [Anhang]
 *
 * Klick auf Checkbox   -> toggleTodo mit Optimistic-Update
 * Klick auf Faellig-Chip -> DatePopover, sofortiges Update
 * Klick auf Titel/leer -> Row-open (Detail)
 * Ellipsis-Menu        -> Snooze / Umzuweisen / Erinnern / Loeschen
 *
 * Overdue-Erkennung ist props-getriebener via relative-date-Helper
 * (kein Client-Date-Vergleich in der Row, damit Timezone konsistent).
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check, AlertCircle, Paperclip, User as UserIcon, Calendar, MoreHorizontal,
  Trash2, Bell, Clock,
} from "lucide-react";
import { DatePopover } from "./date-popover";
import { SearchableSelect } from "@/components/searchable-select";
import { relativeDueLabel, addDaysIso, todayIso } from "@/lib/relative-date";
import type { Todo, Profile } from "@/types";

export type TodoRowData = Omit<Todo, "assignee"> & {
  // PostgREST-Embed: nur die Felder die die Row-UI wirklich braucht.
  assignee: { full_name: string } | null;
  creator: { full_name: string } | null;
  attachments: { id: string }[];
};

interface Props {
  todo: TodoRowData;
  meId: string;
  scope: "mine" | "delegated" | "all";
  profiles: Profile[];
  canRemind: boolean;
  canEditRow: boolean; // aendern (Datum, Zuweisen)
  reminded: boolean;
  onOpen: (t: TodoRowData) => void;
  onToggleComplete: (t: TodoRowData) => void;
  onDueChange: (t: TodoRowData, iso: string | null) => void;
  onAssigneeChange: (t: TodoRowData, assigneeId: string) => void;
  onRemind: (t: TodoRowData) => void;
  onDelete: (t: TodoRowData) => void;
}

/* ------------------------------------------------------------------------- */
/*  Optik von Checkbox und Dringend-Chip — exportiert, damit «Meine Todos»   */
/*  auf dem Dashboard genau gleich aussieht                                  */
/* ------------------------------------------------------------------------- */

/** Erledigt-Checkbox: Grundform und Zustaende. Die Zeile hier hovert per
 *  hover:-Klassen (gleiche Werte wie TODO_CHECKBOX_OFFEN_HOVER), das
 *  Dashboard schaltet state-driven auf TODO_CHECKBOX_OFFEN_HOVER um. */
export const TODO_CHECKBOX_BASIS = "shrink-0 h-6 w-6 rounded-lg border-2 flex items-center justify-center transition-all";
export const TODO_CHECKBOX_ERLEDIGT = "bg-green-500 border-green-500 text-white";
export const TODO_CHECKBOX_OFFEN = "border-foreground/30";
export const TODO_CHECKBOX_OFFEN_HOVER = "border-foreground/70 bg-foreground/5";

/** Chip «Dringend» hinter dem Titel (nur bei offenen Todos). */
export function DringendChip() {
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0 text-[10px] font-semibold rounded-full bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300 shrink-0">
      <AlertCircle className="h-2.5 w-2.5" />
      Dringend
    </span>
  );
}

/* ------------------------------------------------------------------------- */
/*  Ellipsis-Menu Popover                                                    */
/* ------------------------------------------------------------------------- */

function MenuPopover({
  items, children,
}: {
  items: { key: string; label: string; icon: React.ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean }[];
  children: (opts: { open: () => void; isOpen: boolean }) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const anchorRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);



  useEffect(() => {
    if (!open) return;
    function measure() {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const width = 220;
      const left = Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8);
      setPos({ top: r.bottom + 6, left, width });
    }
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const popover = open && pos && typeof document !== "undefined" ? createPortal(
    <div
      ref={popRef}
      style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width }}
      className="z-[1200] rounded-xl border border-border bg-popover shadow-lg p-1"
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          disabled={it.disabled}
          onClick={() => { setOpen(false); it.onClick(); }}
          className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-sm text-left transition-colors ${
            it.danger
              ? "text-red-700 dark:text-red-300 hover:bg-red-500/10"
              : "hover:bg-foreground/[0.06] dark:hover:bg-foreground/[0.12]"
          } disabled:opacity-40 disabled:pointer-events-none`}
        >
          {it.icon}
          <span className="flex-1">{it.label}</span>
        </button>
      ))}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <div ref={anchorRef} className="inline-flex">
        {children({ open: () => setOpen((o) => !o), isOpen: open })}
      </div>
      {popover}
    </>
  );
}

/* ------------------------------------------------------------------------- */
/*  Assignee-Popover                                                         */
/* ------------------------------------------------------------------------- */

function AssigneePopover({
  value, options, onChange, children,
}: {
  value: string;
  options: Profile[];
  onChange: (id: string) => void;
  children: (opts: { open: () => void; isOpen: boolean }) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const anchorRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);


  useEffect(() => {
    if (!open) return;
    function measure() {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const width = 260;
      const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
      setPos({ top: r.bottom + 6, left, width });
    }
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      const t = e.target as Node;
      if (anchorRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setOpen(false); }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const popover = open && pos && typeof document !== "undefined" ? createPortal(
    <div
      ref={popRef}
      style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width }}
      className="z-[1200] rounded-xl border border-border bg-popover shadow-lg p-2"
      onClick={(e) => e.stopPropagation()}
    >
      <SearchableSelect
        value={value}
        onChange={(id) => { onChange(id); setOpen(false); }}
        items={options.map((p) => ({ id: p.id, label: p.full_name }))}
        clearable={false}
        placeholder="Person auswählen ..."
      />
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <div ref={anchorRef} className="inline-flex">
        {children({ open: () => setOpen((o) => !o), isOpen: open })}
      </div>
      {popover}
    </>
  );
}

/* ------------------------------------------------------------------------- */
/*  Row                                                                      */
/* ------------------------------------------------------------------------- */

export function TodoRow({
  todo, meId, scope, profiles, canRemind, canEditRow, reminded,
  onOpen, onToggleComplete, onDueChange, onAssigneeChange, onRemind, onDelete,
}: Props) {
  // Geloeschte Todos werden in der Liste server-seitig ausgefiltert und
  // erreichen diese Component nicht mehr. Der isDeleted-Pfad ist damit
  // 2026-09 komplett rausgeflogen (siehe todos-query.ts).
  const isDone = todo.status === "erledigt";
  const isOpenStatus = todo.status === "offen";

  const dueMeta = todo.due_date ? relativeDueLabel(todo.due_date) : null;
  const overdue = isOpenStatus && dueMeta?.overdue === true;
  const attCount = todo.attachments?.length ?? 0;

  // Assignee-Chip im "An mich"-Modus verstecken (der User weiss dass er
  // der Assignee ist — Redundanz raus, Platz frei). In allen anderen
  // Modes: anzeigen.
  const showAssigneeChip = scope !== "mine";
  // Ersteller-Chip im "An mich"-Modus zeigen ("von Leo") — dort ist die
  // Zusatzinfo wertvoll. Im "Von mir delegiert"-Modus verstecken
  // (bin ja immer selbst der Ersteller).
  const showCreatorChip = scope === "mine" && todo.created_by !== meId;

  const menuItems = [
    {
      key: "snooze-morgen",
      label: "Snooze auf morgen",
      icon: <Clock className="h-4 w-4" />,
      onClick: () => onDueChange(todo, addDaysIso(todayIso(), 1)),
      disabled: !canEditRow,
    },
    {
      key: "snooze-woche",
      label: "Snooze auf nächste Woche",
      icon: <Clock className="h-4 w-4" />,
      onClick: () => onDueChange(todo, addDaysIso(todayIso(), 7)),
      disabled: !canEditRow,
    },
    ...(canRemind && isOpenStatus && todo.assigned_to
      ? [{
          key: "remind",
          label: reminded ? "Erinnerung gesendet" : "Erinnerung senden",
          icon: <Bell className="h-4 w-4" />,
          onClick: () => onRemind(todo),
          disabled: reminded,
        }]
      : []),
    {
      key: "delete",
      label: "Löschen",
      icon: <Trash2 className="h-4 w-4" />,
      onClick: () => onDelete(todo),
      danger: true,
    },
  ];

  return (
    <div
      onClick={() => onOpen(todo)}
      className={`group relative flex items-start gap-3 px-3 py-2 rounded-xl bg-card border border-border transition-colors cursor-pointer hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.06] ${
        overdue ? "border-l-[3px] border-l-red-500" : ""
      } ${isDone ? "opacity-70" : ""}`}
    >
      {/* Checkbox — Standard-Todo-UX-Grammatik: das ist die primaere
          Erledigen-Interaktion. */}
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onToggleComplete(todo); }}
        aria-label={isDone ? "Wieder öffnen" : "Als erledigt markieren"}
        className={`mt-0.5 ${TODO_CHECKBOX_BASIS} ${
          isDone
            ? TODO_CHECKBOX_ERLEDIGT
            : `${TODO_CHECKBOX_OFFEN} hover:border-foreground/70 hover:bg-foreground/5`
        }`}
      >
        {isDone && <Check className="h-4 w-4" strokeWidth={3} />}
      </button>

      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`font-medium text-sm truncate ${isDone ? "line-through text-muted-foreground" : ""}`}>
            {todo.title}
          </span>
          {todo.priority === "dringend" && isOpenStatus && <DringendChip />}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {/* Faellig-Chip mit Popover — Klick oeffnet DatePicker,
              nicht die Row (stopPropagation im Popover). */}
          {isOpenStatus && canEditRow ? (
            <DatePopover value={todo.due_date} onChange={(iso) => onDueChange(todo, iso)}>
              {({ open, isOpen }) => (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); open(); }}
                  data-tooltip={dueMeta?.tooltip ?? undefined}
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md transition-colors ${
                    isOpen
                      ? "bg-foreground/[0.08] text-foreground"
                      : overdue
                        ? "text-red-600 dark:text-red-400 font-medium hover:bg-red-500/10"
                        : "hover:bg-foreground/[0.06]"
                  }`}
                >
                  <Calendar className="h-3 w-3" />
                  {dueMeta?.label ?? "Ohne Datum"}
                </button>
              )}
            </DatePopover>
          ) : dueMeta ? (
            <span
              data-tooltip={dueMeta.tooltip}
              className={`inline-flex items-center gap-1 ${overdue ? "text-red-600 dark:text-red-400 font-medium" : ""}`}
            >
              <Calendar className="h-3 w-3" />
              {dueMeta.label}
            </span>
          ) : null}

          {/* Assignee-Chip: klickbar wenn canEditRow (nur offene Todos). */}
          {showAssigneeChip && todo.assignee && (
            isOpenStatus && canEditRow ? (
              <AssigneePopover
                value={todo.assigned_to ?? ""}
                options={profiles}
                onChange={(id) => id && onAssigneeChange(todo, id)}
              >
                {({ open, isOpen }) => (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); open(); }}
                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md transition-colors ${
                      isOpen ? "bg-foreground/[0.08] text-foreground" : "hover:bg-foreground/[0.06]"
                    }`}
                    data-tooltip="Zuweisen ..."
                  >
                    <UserIcon className="h-3 w-3" />
                    {todo.assignee?.full_name ?? ""}
                  </button>
                )}
              </AssigneePopover>
            ) : (
              <span className="inline-flex items-center gap-1">
                <UserIcon className="h-3 w-3" />
                {todo.assignee.full_name}
              </span>
            )
          )}

          {showCreatorChip && todo.creator?.full_name && (
            <span className="inline-flex items-center gap-1 text-muted-foreground/80">
              von {todo.creator.full_name}
            </span>
          )}

          {attCount > 0 && (
            <span
              className="inline-flex items-center gap-0.5"
              data-tooltip={`${attCount} Anhang${attCount === 1 ? "" : "e"}`}
            >
              <Paperclip className="h-3 w-3" />
              {attCount}
            </span>
          )}

          {isDone && todo.completed_at && (
            <span className="text-green-700 dark:text-green-400">
              Abgeschlossen: {new Date(todo.completed_at).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" })}
            </span>
          )}
        </div>
      </div>

      {/* Ellipsis-Menu — sammelt Snooze/Erinnern/Loeschen. */}
      <MenuPopover items={menuItems}>
        {({ open, isOpen }) => (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); open(); }}
            className={`shrink-0 p-1.5 rounded-lg transition-colors ${
              isOpen
                ? "bg-foreground/[0.08] text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-foreground/[0.06]"
            }`}
            aria-label="Weitere Aktionen"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        )}
      </MenuPopover>
    </div>
  );
}
