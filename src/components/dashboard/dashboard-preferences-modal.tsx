"use client";

/**
 * DashboardPreferencesModal — Zahnrad-Modal fuer persoenliche
 * Widget-Sichtbarkeit + Reihenfolge im Dashboard.
 *
 * Bau-Modus: Drag-and-Drop mit ECHTER 1:1 Layout-Vorschau (kein Listen-
 * Kompromiss). Das Preview-Grid nutzt die selben col-span-Klassen wie
 * das echte Dashboard — der User sieht genau, wie sein Dashboard nach
 * dem Umsortieren aussehen wird.
 *
 * Datenmodell (Server, /api/dashboard + /api/dashboard/overrides):
 *   catalog        — alle Widgets die die Registry kennt (aus /api/dashboard).
 *   visibleIds     — die aktuell sichtbaren Widgets in ihrer Anzeige-Reihenfolge.
 *   overrides      — {hidden, widget_order} aus user_dashboard_overrides.
 *
 * DnD-Architektur (v3 — 2026-09-06, nach Video-Feedback):
 *
 *   Kern-Erkenntnis: @dnd-kit's SortableContext + rectSortingStrategy
 *   berechnet transform-Deltas fuer Auto-Reflow der Kacheln WAEHREND
 *   des Drags. Bei variablen Grid-Spans (col-span-4/6/12) sind diese
 *   Deltas systematisch falsch → Kacheln landen visuell an unmoeglichen
 *   Positionen (Video: "verzerrt den Rest, ueberlappt, ragt raus").
 *
 *   Neue Loesung — Sortable-Reflow komplett abschalten, Layout beim
 *   Drop sanft ueberblenden via View-Transitions-API:
 *
 *   1. WAEHREND DRAG: Grid ist eingefroren. Keine Kachel bewegt sich.
 *      Nur der Ghost am Cursor bewegt sich (DragOverlay).
 *   2. URSPRUNGS-SLOT: bleibt sichtbar als dashed Placeholder (accent
 *      Border, Content auf 25%). User sieht klar wo's herkommt.
 *   3. HOVER-TARGET: die Kachel unter dem Cursor bekommt einen accent-
 *      Ring + subtile Fuellung — User sieht LIVE wo der Drop landet.
 *   4. BEIM DROP: `document.startViewTransition` (moderne Browser) laesst
 *      den Browser selbst den Layout-Sprung sauber animieren — inklusive
 *      variabler Spans. Fallback: hartes Umschalten (aeltere Browser).
 *      Jede Kachel bekommt einen eindeutigen `view-transition-name`
 *      damit der Browser die Kachel ueber das Reorder hinweg
 *      identifizieren und animieren kann.
 *
 *   Verwendete dnd-kit-APIs: useDraggable + useDroppable pro Kachel,
 *   KEIN SortableContext, KEIN useSortable. Das ist der Grund warum
 *   das Layout stabil bleibt: die Bibliothek fasst das Grid gar nicht
 *   an.
 *
 * Weitere UX-Details:
 *   - PointerSensor mit 6px activation-distance (Klick auf Auge-Button
 *     wird NICHT als Drag interpretiert) + KeyboardSensor fuer a11y.
 *   - Body-Attribut data-dashboard-dragging setzt globalen grabbing-
 *     Cursor waehrend Drag.
 *   - Mobile-Vorschau-Toggle zwingt alle Kacheln auf col-span-12 →
 *     zeigt effektives Mobile-Layout.
 *   - Auge-Icon auf gezogener Kachel ausgeblendet — Placeholder clean.
 *   - Auto-Save debounced 400ms, Toast bei Fehler, "Fertig" flusht
 *     pending Save im Hintergrund und schliesst sofort.
 *
 * Server-Roundtrips:
 *   - GET    /api/dashboard/overrides  (nur beim Oeffnen)
 *   - PUT    /api/dashboard/overrides  (debounced 400ms bei Aenderung)
 *   - DELETE /api/dashboard/overrides  (bei Reset)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertCircle,
  Briefcase,
  CalendarDays,
  ClipboardList,
  Clock,
  Eye,
  EyeOff,
  GripVertical,
  Handshake,
  Loader2,
  Monitor,
  PlayCircle,
  Receipt,
  RotateCcw,
  Smartphone,
  Users,
  Wallet,
} from "lucide-react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragCancelEvent,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { Modal } from "@/components/ui/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { widgetDefaultSpan } from "@/lib/dashboard-widgets";

interface CatalogItem {
  id: string;
  title: string;
  requires: string[];
}

interface PreferenceItem {
  id: string;
  title: string;
  hidden: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Wird gerufen wenn Overrides sich potenziell geaendert haben — der
   *  Parent soll dann /api/dashboard neu laden. */
  onSaved: () => void;
  /** widget_catalog aus /api/dashboard — komplette Registry. */
  catalog: CatalogItem[];
  /** widgets aus /api/dashboard — aktuell sichtbare IDs in Anzeige-Reihenfolge. */
  visibleIds: string[];
  /** Live-gemessene Karten-Hoehen (px) der aktuell gerenderten Widgets —
   *  beim Oeffnen vom Dashboard erhoben. Die Vorschau-Kacheln skalieren
   *  darauf (Preview = Endresultat), Fallback fuer ungemessene: 64px. */
  liveHeights?: Record<string, number>;
}

/** Vorschau-Hoehe einer Kachel: Live-Hoehe halbiert, geklemmt auf
 *  [72, 260]px. Min 72 damit Titelzeile + Breiten-Selector reinpassen,
 *  Max 260 damit ein Riesen-Widget die Vorschau nicht sprengt. */
function previewHeightFor(id: string, liveHeights?: Record<string, number>): number {
  const live = liveHeights?.[id];
  if (!live || live <= 0) return 64;
  return Math.round(Math.min(260, Math.max(72, live * 0.5)));
}

/** Vertikaler Abstand zwischen Vorschau-Kacheln (px) — das Preview-Grid
 *  laeuft wie das echte Dashboard als 1px-Masonry ohne row-gap. */
const PREVIEW_GAP = 8;

// ---------------------------------------------------------------------------
// Widget-Preview-Metadaten (Icons pro ID + Span-Auswahl).
// ---------------------------------------------------------------------------

const WIDGET_ICONS: Record<string, React.ReactNode> = {
  "kpi-offene-auftraege": <Briefcase className="h-4 w-4" />,
  "kpi-termine-woche": <CalendarDays className="h-4 w-4" />,
  "kpi-nicht-abgerechnet": <Receipt className="h-4 w-4" />,
  "overdue-jobs": <AlertCircle className="h-4 w-4" />,
  "zu-erledigen": <ClipboardList className="h-4 w-4" />,
  "team-status": <Users className="h-4 w-4" />,
  "anwesenheitskalender": <Users className="h-4 w-4" />,
  "ma-monat-stunden": <Clock className="h-4 w-4" />,
  "ma-prognose": <Wallet className="h-4 w-4" />,
  "ma-naechster-einsatz": <PlayCircle className="h-4 w-4" />,
  "partner-willkommen": <Handshake className="h-4 w-4" />,
};

function iconFor(id: string): React.ReactNode {
  return WIDGET_ICONS[id] ?? <ClipboardList className="h-4 w-4" />;
}

/** Numerischer Span aus State + Override + Default. Mobile-Overrides zwingen
 *  auf 12 (volle Breite) fuer die Mobil-Vorschau. */
function spanNumberFor(
  id: string,
  overrides: Record<string, number>,
  mobile: boolean,
): number {
  if (mobile) return 12;
  return overrides[id] ?? widgetDefaultSpan(id);
}

/** Fuer die Modal-Vorschau: baut die col-span-N-Klasse (ohne responsive
 *  Prefix — das Modal ist immer Desktop-simulation, Mobile wird per
 *  mobilePreview-Toggle erzwungen).
 *
 *  WICHTIG: Klassen-Strings sind LITERAL — dynamisch zusammengebaute Tailwind-
 *  Klassen wie `col-span-${n}` werden vom Compiler nicht erkannt und landen
 *  NICHT im Bundle. Deshalb ein festes Mapping. */
function spanClassFor(
  id: string,
  overrides: Record<string, number>,
  mobile: boolean,
): string {
  const n = spanNumberFor(id, overrides, mobile);
  switch (n) {
    case 4:
      return "col-span-4";
    case 6:
      return "col-span-6";
    case 8:
      return "col-span-8";
    case 12:
    default:
      return "col-span-12";
  }
}

/** Erlaubte Widget-Breiten im 12-col-Grid (auch server-seitig validiert
 *  in /api/dashboard/overrides). Reihenfolge = Anzeige-Reihenfolge im
 *  Breiten-Selector: schmal -> breit. */
const WIDTH_OPTIONS: { value: number; label: string }[] = [
  { value: 4, label: "1/3" },
  { value: 6, label: "1/2" },
  { value: 8, label: "2/3" },
  { value: 12, label: "Voll" },
];

/** Slot-Marker im gemischten Render-Array (Kacheln + leere Slots).
 *  `beforeIndex` referenziert den Index im items-Array (OHNE dragged raus-
 *  gefiltert), vor dem der Slot erscheinen soll. `items.length` = trailing
 *  slot. `span` ist die freie Breite in col-Einheiten (4/8/12 sind moeglich).
 */
interface EmptySlot {
  kind: "slot";
  beforeIndex: number;
  span: number;
  key: string;
}

/** Berechnet leere Slots in einem 12-col-Grid basierend auf der aktuellen
 *  items-Reihenfolge und den Span-Overrides. Slots zeigen wo im AKTUELLEN
 *  Layout Platz ist — die dragged Kachel bleibt sichtbar an ihrer alten
 *  Position (Placeholder), damit das Grid beim Anheben STABIL bleibt und
 *  nicht sofort nachrutscht. Der User zieht seine Kachel dann bewusst
 *  entweder auf eine andere Kachel (Swap/Move) oder in einen der wirklich
 *  freien Slots.
 *
 *  Algorithmus:
 *   - Zeilen-Position `colPos` mod 12 trackt wo wir in der aktuellen Zeile
 *     stehen.
 *   - Passt das naechste Widget nicht mehr in die Zeile → emit slot mit
 *     der restlichen Zeilenbreite, dann Zeile neu starten mit dem Widget.
 *   - Nach der Schleife: wenn die letzte Zeile nicht voll ist, emit
 *     trailing slot.
 *   - Slots mit span < 4 werden gedroppt (kein Widget kann rein).
 *
 *  `beforeIndex` bezieht sich auf den Index im uebergebenen items-Array
 *  (NICHT auf ein gefiltertes Array). Der Drop-Handler muss dann ggf.
 *  einen off-by-one Adjust machen (siehe handleDragEnd).
 */
function computeEmptySlots(
  items: PreferenceItem[],
  spanOverrides: Record<string, number>,
  mobile: boolean,
): EmptySlot[] {
  const src = items;
  const slots: EmptySlot[] = [];
  let colPos = 0;
  src.forEach((item, idx) => {
    const s = spanNumberFor(item.id, spanOverrides, mobile);
    if (colPos + s > 12) {
      // Zeile bricht ab — Rest der alten Zeile ist ein Slot.
      const gap = 12 - colPos;
      if (gap >= 4) {
        slots.push({
          kind: "slot",
          beforeIndex: idx,
          span: gap,
          key: `slot:before-${idx}`,
        });
      }
      colPos = s % 12;
      if (s === 12) colPos = 0;
    } else {
      colPos = (colPos + s) % 12;
    }
  });
  if (colPos > 0 && colPos < 12) {
    const gap = 12 - colPos;
    if (gap >= 4) {
      slots.push({
        kind: "slot",
        beforeIndex: src.length,
        span: gap,
        key: `slot:end`,
      });
    }
  }
  return slots;
}

/** Applies fn inside a View Transition if the browser supports it (Chromium,
 *  Safari 18+, Firefox 145+). Falls es nicht geht: fn direkt aufrufen. */
function withViewTransition(fn: () => void) {
  if (
    typeof document !== "undefined" &&
    "startViewTransition" in document &&
    typeof (document as unknown as { startViewTransition?: (cb: () => void) => unknown })
      .startViewTransition === "function"
  ) {
    (
      document as unknown as { startViewTransition: (cb: () => void) => unknown }
    ).startViewTransition(fn);
  } else {
    fn();
  }
}

export function DashboardPreferencesModal({
  open,
  onClose,
  onSaved,
  catalog,
  visibleIds,
  liveHeights,
}: Props) {
  const [items, setItems] = useState<PreferenceItem[]>([]);
  // spanOverrides = user-adjusted widget widths, {id: 4|6|8|12}. Fehlende IDs
  // fallen im Renderer auf widgetDefaultSpan(id) zurueck. Persistiert als
  // widget_spans in user_dashboard_overrides.
  const [spanOverrides, setSpanOverrides] = useState<Record<string, number>>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [mobilePreview, setMobilePreview] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeSize, setActiveSize] = useState<{ w: number; h: number } | null>(
    null,
  );
  const [overId, setOverId] = useState<string | null>(null);
  const dirtyRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ------------------------------------------------------------------
  // Load overrides + compose modal-set beim Oeffnen.
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoaded(false);
    dirtyRef.current = false;
    (async () => {
      try {
        const res = await fetch("/api/dashboard/overrides", { credentials: "include" });
        const json = (await res.json()) as {
          success?: boolean;
          hidden?: string[];
          widget_order?: string[];
          widget_spans?: Record<string, number>;
          error?: string;
        };
        if (cancelled) return;
        if (!json.success) {
          toast.error(json.error ?? "Einstellungen konnten nicht geladen werden");
          setItems([]);
          setSpanOverrides({});
          setLoaded(true);
          return;
        }
        const userHidden = new Set(json.hidden ?? []);
        const userOrder = json.widget_order ?? [];
        setSpanOverrides(json.widget_spans ?? {});
        const catalogById = new Map(catalog.map((c) => [c.id, c]));

        const orderedIds: string[] = [];
        const seen = new Set<string>();
        for (const id of visibleIds) {
          if (!catalogById.has(id)) continue;
          if (seen.has(id)) continue;
          seen.add(id);
          orderedIds.push(id);
        }

        const hiddenCandidates = Array.from(userHidden).filter(
          (id) => catalogById.has(id) && !seen.has(id),
        );
        const orderedHidden = [
          ...userOrder.filter((id) => hiddenCandidates.includes(id)),
          ...hiddenCandidates.filter((id) => !userOrder.includes(id)),
        ];
        for (const id of orderedHidden) {
          if (seen.has(id)) continue;
          seen.add(id);
          orderedIds.push(id);
        }

        const composed: PreferenceItem[] = orderedIds.map((id) => ({
          id,
          title: catalogById.get(id)!.title,
          hidden: userHidden.has(id),
        }));
        setItems(composed);
        setLoaded(true);
      } catch (e) {
        if (cancelled) return;
        toast.error(e instanceof Error ? e.message : "Netzwerk-Fehler");
        setItems([]);
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, catalog, visibleIds]);

  // ------------------------------------------------------------------
  // Debounced Auto-Save.
  // ------------------------------------------------------------------
  const persist = useCallback(
    async (payload: PreferenceItem[], spans: Record<string, number>) => {
      setSaving(true);
      try {
        const body = {
          hidden: payload.filter((i) => i.hidden).map((i) => i.id),
          widget_order: payload.map((i) => i.id),
          widget_spans: spans,
        };
        const res = await fetch("/api/dashboard/overrides", {
          method: "PUT",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await res.json()) as { success?: boolean; error?: string };
        if (!json.success) throw new Error(json.error ?? "Speichern fehlgeschlagen");
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Speichern fehlgeschlagen");
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const scheduleSave = useCallback(
    (nextItems: PreferenceItem[], nextSpans: Record<string, number>) => {
      dirtyRef.current = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        dirtyRef.current = false;
        void persist(nextItems, nextSpans);
      }, 400);
    },
    [persist],
  );

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  // ------------------------------------------------------------------
  // Mutations
  // ------------------------------------------------------------------
  function toggleHidden(id: string) {
    setItems((prev) => {
      const next = prev.map((it) => (it.id === id ? { ...it, hidden: !it.hidden } : it));
      scheduleSave(next, spanOverrides);
      return next;
    });
  }

  function setDraggingCursor(on: boolean) {
    if (typeof document === "undefined") return;
    if (on) document.body.setAttribute("data-dashboard-dragging", "true");
    else document.body.removeAttribute("data-dashboard-dragging");
  }

  function handleDragStart(event: DragStartEvent) {
    const id = event.active.id as string;
    setActiveId(id);
    const rect = event.active.rect.current.initial;
    if (rect) setActiveSize({ w: rect.width, h: rect.height });
    setDraggingCursor(true);
  }

  function handleDragOver(event: DragOverEvent) {
    const over = event.over;
    setOverId(over ? (over.id as string) : null);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    setDraggingCursor(false);
    if (!over || active.id === over.id) {
      setActiveId(null);
      setActiveSize(null);
      setOverId(null);
      return;
    }
    const overStr = String(over.id);
    const activeStr = String(active.id);
    // ALLE relevanten setStates (drag-cleanup + items-Reorder) MUESSEN im
    // selben withViewTransition-Callback sitzen, damit der Browser
    // beide DOM-Zustaende (mit slots + placeholder-Kachel vs. finales
    // Grid) in einem einzigen OLD/NEW-Paar snapshotted. Sonst konkurrieren
    // Slot-Verschwinden und Reorder-Animation um die view-transition
    // frame.
    withViewTransition(() => {
      setActiveId(null);
      setActiveSize(null);
      setOverId(null);
      setItems((prev) => {
        // items-Konvention: visible zuerst, hidden am Ende. Alle Sort-
        // Operationen laufen im VISIBLE-Space; hidden werden unveraendert
        // hinten angehaengt. Das matcht die Load-Reihenfolge und haelt
        // beim Drag im Modal-Grid (das nur visible zeigt) alles konsistent.
        const visible = prev.filter((i) => !i.hidden);
        const hidden = prev.filter((i) => i.hidden);
        const oldIdx = visible.findIndex((i) => i.id === activeStr);
        if (oldIdx === -1) return prev;

        let newVisible: PreferenceItem[];

        // (1) Drop auf leeren Slot: `slot:before-<N>` oder `slot:end`.
        //     beforeIndex kommt aus computeEmptySlots(visible) OHNE Dragged-
        //     Filter (Grid ist waehrend Drag stabil, dragged bleibt drin).
        //     Nach splice-out dragged muss insertAt off-by-one adjustet
        //     werden wenn oldIdx < beforeIndex — sonst landet dragged eine
        //     Position zu weit rechts.
        if (overStr.startsWith("slot:")) {
          const filtered = visible.filter((i) => i.id !== activeStr);
          let insertAt = filtered.length;
          if (overStr !== "slot:end") {
            const m = overStr.match(/^slot:before-(\d+)$/);
            if (m) {
              const parsed = parseInt(m[1], 10);
              if (Number.isFinite(parsed)) {
                const adjusted = oldIdx < parsed ? parsed - 1 : parsed;
                insertAt = Math.max(0, Math.min(filtered.length, adjusted));
              }
            }
          }
          newVisible = [...filtered];
          const moved = visible[oldIdx];
          newVisible.splice(insertAt, 0, moved);
        } else {
          // (2) Drop auf eine andere Kachel.
          const newIdx = visible.findIndex((i) => i.id === overStr);
          if (newIdx === -1) return prev;

          const draggedSpan = spanNumberFor(activeStr, spanOverrides, mobilePreview);
          const targetSpan = spanNumberFor(overStr, spanOverrides, mobilePreview);

          if (draggedSpan === targetSpan) {
            // (2a) Gleiche Groesse -> SWAP in-place (kein Shift der Nachbarn).
            newVisible = [...visible];
            const tmp = newVisible[oldIdx];
            newVisible[oldIdx] = newVisible[newIdx];
            newVisible[newIdx] = tmp;
          } else {
            // (2b) Unterschiedliche Groesse -> move-and-shift (Standard-
            //      Sortable-Semantik, weil swap zwischen z.B. 4 und 12
            //      den 12er in einen 4-col-Slot zwingen wuerde).
            newVisible = [...visible];
            const [moved] = newVisible.splice(oldIdx, 1);
            newVisible.splice(newIdx, 0, moved);
          }
        }

        const next = [...newVisible, ...hidden];
        scheduleSave(next, spanOverrides);
        return next;
      });
    });
  }

  function handleDragCancel(_event: DragCancelEvent) {
    setDraggingCursor(false);
    // View-Transition wraps das Cleanup — sonst spring der Placeholder-/
    // Slot-Zustand hart in "kein Drag" zurueck; mit VT gleitet er sanft.
    withViewTransition(() => {
      setActiveId(null);
      setActiveSize(null);
      setOverId(null);
    });
  }

  /** Setzt die Breite eines Widgets explizit (User-Klick auf Segment). Wird
   *  auch in View-Transition gepackt, damit die Kachel weich waechst/schrumpft
   *  statt harten Layout-Sprung zu machen. Default-Wert (= Registry) wird als
   *  "kein Override" gespeichert, damit spaetere Registry-Aenderungen wieder
   *  greifen. */
  function setWidgetSpan(id: string, span: number) {
    const registryDefault = widgetDefaultSpan(id);
    withViewTransition(() => {
      setSpanOverrides((prev) => {
        const next = { ...prev };
        if (span === registryDefault) delete next[id];
        else next[id] = span;
        scheduleSave(items, next);
        return next;
      });
    });
  }

  useEffect(() => {
    return () => setDraggingCursor(false);
  }, []);

  async function resetToDefault() {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/dashboard/overrides", {
        method: "DELETE",
        credentials: "include",
      });
      const json = (await res.json()) as { success?: boolean; error?: string };
      if (!json.success) throw new Error(json.error ?? "Zurücksetzen fehlgeschlagen");
      dirtyRef.current = false;
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Zurücksetzen fehlgeschlagen");
    } finally {
      setSaving(false);
    }
  }

  function handleFinish() {
    const flush = saveTimer.current !== null;
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
      dirtyRef.current = false;
    }
    onClose();
    if (flush) {
      void persist(items, spanOverrides).then(() => onSaved());
    } else {
      onSaved();
    }
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinatesShim }),
  );

  const activeItem = useMemo(
    () => (activeId ? items.find((i) => i.id === activeId) ?? null : null),
    [activeId, items],
  );

  /** Gemischtes Render-Array: gefilterte items (ohne dragged) + leere
   *  Slots dazwischen. Waehrend Drag wird die gezogene Kachel visuell
   *  KOMPLETT aus dem Grid genommen (der Ghost am Cursor ist ihre einzige
   *  Repraesentation) — damit Slots dort erscheinen koennen wo sie
   *  vorher war. Ohne Drag: einfach items.
   */
  // Visible = im Grid gerenderte Widgets. Hidden werden UNTER dem Grid als
  // Chip-Liste angezeigt (siehe HiddenSection) — genau wie im echten
  // Dashboard, wo hidden Widgets gar nicht rendern. So matcht die Modal-
  // Vorschau 1:1 was der User danach im Dashboard sieht.
  const visibleItems = useMemo(() => items.filter((i) => !i.hidden), [items]);
  const hiddenItems = useMemo(() => items.filter((i) => i.hidden), [items]);

  const renderList = useMemo<Array<PreferenceItem | EmptySlot>>(() => {
    if (!activeId) return visibleItems;
    // WICHTIG: dragged Kachel wird NICHT rausgefiltert — sie bleibt visuell
    // als Placeholder an ihrer alten Position, damit das Grid beim Anheben
    // stabil bleibt (Leo-Feedback: 'andere sachen die man gar nicht drueber
    // hovert werden reingeschoben'). Slots werden gegen das AKTUELLE Layout
    // (mit dragged drin) berechnet — sie zeigen also nur wirklich freie
    // Positionen.
    const draggedSpan = spanNumberFor(activeId, spanOverrides, mobilePreview);
    const slots = computeEmptySlots(visibleItems, spanOverrides, mobilePreview)
      .filter((s) => s.span >= draggedSpan);
    if (slots.length === 0) return visibleItems;
    // Slots werden vor `beforeIndex` im items-Array eingefuegt. Absteigend
    // sortieren damit splice-insert die noch-nicht-eingefuegten Indizes
    // nicht verschiebt.
    const sortedSlots = [...slots].sort((a, b) => b.beforeIndex - a.beforeIndex);
    const arr: Array<PreferenceItem | EmptySlot> = [...visibleItems];
    for (const slot of sortedSlots) {
      arr.splice(slot.beforeIndex, 0, slot);
    }
    return arr;
  }, [activeId, visibleItems, spanOverrides, mobilePreview]);

  return (
    <Modal open={open} onClose={handleFinish} title="Dashboard anpassen" size="4xl">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Widgets verschieben, ausblenden oder Reihenfolge ändern — nur für dich sichtbar.
        </p>
        <PreviewToggle mobile={mobilePreview} onChange={setMobilePreview} />
      </div>

      {!loaded ? (
        <div className="rounded-xl border bg-muted/30 p-3">
          <div className="grid grid-cols-12 gap-2">
            <Skeleton className="h-16 col-span-4" />
            <Skeleton className="h-16 col-span-4" />
            <Skeleton className="h-16 col-span-4" />
            <Skeleton className="h-16 col-span-12" />
            <Skeleton className="h-16 col-span-6" />
            <Skeleton className="h-16 col-span-6" />
          </div>
        </div>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground py-6 text-center">
          Keine Widgets verfuegbar.
        </p>
      ) : (
        <DndContext
          sensors={sensors}
          collisionDetection={pointerWithin}
          // Slots mounten mid-drag (nur wenn activeId gesetzt). Ohne
          // MeasuringStrategy.Always cached dnd-kit die Droppable-Rects
          // aus dem drag-start snapshot → neue Slots werden vom
          // pointerWithin collision-check nicht gesehen.
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <div
            className="rounded-xl border p-3 transition-colors duration-200"
            style={{
              backgroundColor: activeId
                ? "color-mix(in oklab, var(--accent) 5%, var(--background))"
                : "color-mix(in oklab, var(--foreground) 3%, transparent)",
              borderColor: activeId
                ? "color-mix(in oklab, var(--accent) 30%, var(--border))"
                : undefined,
            }}
          >
            {visibleItems.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-6">
                Alle Widgets sind ausgeblendet. Blende unten wieder eins ein.
              </p>
            ) : (
              // Masonry wie das echte Dashboard: 1px-Rows ohne row-gap,
              // jede Kachel spannt ihre (skalierte Live-)Hoehe + PREVIEW_GAP.
              // Preview = Endresultat — auch die Packung stimmt.
              <div className="grid grid-cols-12 gap-x-2 auto-rows-[1px]">
                {renderList.map((entry) => {
                  if ("kind" in entry && entry.kind === "slot") {
                    return (
                      <EmptySlotTile
                        key={entry.key}
                        slotId={entry.key}
                        span={entry.span}
                        isOverTarget={overId === entry.key}
                      />
                    );
                  }
                  const it = entry as PreferenceItem;
                  return (
                    <GridTile
                      key={it.id}
                      item={it}
                      spanClass={spanClassFor(it.id, spanOverrides, mobilePreview)}
                      currentSpan={spanNumberFor(it.id, spanOverrides, mobilePreview)}
                      previewHeight={previewHeightFor(it.id, liveHeights)}
                      mobilePreview={mobilePreview}
                      onToggle={() => toggleHidden(it.id)}
                      onSetSpan={(span) => setWidgetSpan(it.id, span)}
                      isDragging={activeId === it.id}
                      isOverTarget={overId === it.id && activeId !== it.id}
                      anyDragActive={activeId !== null}
                    />
                  );
                })}
              </div>
            )}
          </div>
          {hiddenItems.length > 0 && (
            <HiddenSection items={hiddenItems} onShow={(id) => toggleHidden(id)} />
          )}

          <DragOverlay zIndex={1200} dropAnimation={null}>
            {activeItem && activeSize ? (
              <TileVisual
                item={activeItem}
                style={{
                  width: activeSize.w,
                  height: activeSize.h,
                  cursor: "grabbing",
                  transform: "rotate(1.5deg)",
                  boxShadow:
                    "0 24px 48px -8px rgba(0, 0, 0, 0.35), 0 8px 16px -4px rgba(0, 0, 0, 0.2)",
                  outline: "2px solid var(--accent)",
                  outlineOffset: "-1px",
                  backgroundColor: "var(--card)",
                }}
              />
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      <div className="flex items-center justify-between gap-2 pt-3 border-t">
        <button
          type="button"
          onClick={resetToDefault}
          disabled={saving}
          className="kasten kasten-muted"
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RotateCcw className="h-3.5 w-3.5" />
          )}
          Auf Standard zurücksetzen
        </button>
        <button type="button" onClick={handleFinish} className="kasten kasten-red">
          Fertig
        </button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// TileVisual — reine Darstellungs-Kachel. Wird von GridTile und vom
// DragOverlay verwendet, damit Ghost + Original 1:1 identisch aussehen.
// ---------------------------------------------------------------------------

function TileVisual({
  item,
  style,
  className,
  toggleButton,
  widthSelector,
  contentOpacity,
}: {
  item: PreferenceItem;
  style?: React.CSSProperties;
  className?: string;
  /** Auge-Button (Ausblenden/Einblenden). Wird IM Content-Flow rechts
   *  neben dem Titel gerendert, nicht absolute am Rand — sonst ragt der
   *  Button visuell aus der Kachel raus in den Grid-Gap. */
  toggleButton?: React.ReactNode;
  /** Breiten-Segmented-Control (1/3 · 1/2 · 2/3 · Voll). Wird als kleine
   *  Toolbar am unteren Rand der Kachel gerendert. Optional damit der
   *  DragOverlay-Ghost sie weglassen kann. */
  widthSelector?: React.ReactNode;
  /** Wenn gesetzt: erzwingt Content-Opacity (Placeholder faded auf 25%). */
  contentOpacity?: number;
}) {
  const effOp =
    contentOpacity !== undefined ? contentOpacity : item.hidden ? 0.55 : 1;
  return (
    <div
      className={`relative rounded-lg border select-none overflow-hidden flex flex-col ${className ?? ""}`}
      style={{
        backgroundColor: item.hidden
          ? "color-mix(in oklab, var(--foreground) 4%, transparent)"
          : "var(--card)",
        ...style,
      }}
    >
      <div className="flex items-start gap-2 p-2.5">
        <span
          className="mt-0.5 shrink-0 text-muted-foreground/60"
          aria-hidden
          style={{ opacity: effOp }}
        >
          <GripVertical className="h-3.5 w-3.5" />
        </span>
        <div className="flex-1 min-w-0" style={{ opacity: effOp }}>
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
            <span className="text-accent shrink-0">{iconFor(item.id)}</span>
            <span className="truncate">{item.title}</span>
          </div>
          <div className="mt-1.5 h-2 rounded bg-muted-foreground/15 w-3/4" />
          <div className="mt-1 h-2 rounded bg-muted-foreground/10 w-1/2" />
        </div>
        {toggleButton && <div className="shrink-0 -mt-0.5 -mr-0.5">{toggleButton}</div>}
      </div>
      {/* mt-auto: Selector klebt am unteren Kachelrand — bei hoeheren
          Live-Proportions-Kacheln sonst oben-mittig haengend. */}
      {widthSelector && <div className="mt-auto">{widthSelector}</div>}

      {item.hidden && contentOpacity === undefined && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg"
          style={{
            backgroundColor:
              "color-mix(in oklab, var(--background) 55%, transparent)",
          }}
        >
          <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            ausgeblendet
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WidthSelector — Segmented-Control zum expliziten Setzen der Widget-Breite.
// Der User klickt 1/3, 1/2, 2/3 oder Voll und die Kachel wechselt sofort
// (mit smoothen View-Transition beim Parent). Klicks werden stopPropagated
// damit sie kein Drag ausloesen. Im Mobile-Preview versteckt (alles ist
// eh voll). Waehrend Drag versteckt (kein Konflikt).
// ---------------------------------------------------------------------------

function WidthSelector({
  current,
  onChange,
}: {
  current: number;
  onChange: (span: number) => void;
}) {
  return (
    <div
      className="flex items-center gap-1 border-t px-2 py-1.5"
      style={{
        borderColor:
          "color-mix(in oklab, var(--foreground) 8%, transparent)",
        backgroundColor:
          "color-mix(in oklab, var(--foreground) 2%, transparent)",
      }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      role="group"
      aria-label="Widget-Breite"
    >
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground shrink-0 mr-1">
        Breite
      </span>
      {WIDTH_OPTIONS.map((opt) => (
        <WidthSegment
          key={opt.value}
          active={current === opt.value}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </WidthSegment>
      ))}
    </div>
  );
}

function WidthSegment({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-pressed={active}
      className="px-1.5 py-0.5 text-[10px] font-semibold rounded transition-colors"
      style={{
        backgroundColor: active
          ? "color-mix(in oklab, var(--accent) 18%, transparent)"
          : hover
            ? "color-mix(in oklab, var(--foreground) 8%, transparent)"
            : "transparent",
        color: active ? "var(--accent)" : "var(--muted-foreground)",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// GridTile — Kachel im echten col-span-Grid. Nutzt useDraggable +
// useDroppable OHNE SortableContext → keine Auto-Reflow-Transforms
// waehrend Drag, keine Layout-Verzerrung. Grid bleibt eingefroren bis
// zum Drop, dann uebernimmt startViewTransition (Parent) das
// weiche Reorder.
// ---------------------------------------------------------------------------

function GridTile({
  item,
  spanClass,
  currentSpan,
  previewHeight,
  mobilePreview,
  onToggle,
  onSetSpan,
  isDragging,
  isOverTarget,
  anyDragActive,
}: {
  item: PreferenceItem;
  spanClass: string;
  currentSpan: number;
  /** Skalierte Live-Hoehe der Kachel (px) — Vorschau in echten Proportionen. */
  previewHeight: number;
  mobilePreview: boolean;
  onToggle: () => void;
  onSetSpan: (span: number) => void;
  isDragging: boolean;
  isOverTarget: boolean;
  anyDragActive: boolean;
}) {
  const {
    attributes,
    listeners,
    setNodeRef: setDragRef,
  } = useDraggable({ id: item.id });
  const {
    setNodeRef: setDropRef,
    isOver,
  } = useDroppable({ id: item.id });
  const [hover, setHover] = useState(false);

  const setRefs = useCallback(
    (el: HTMLDivElement | null) => {
      setDragRef(el);
      setDropRef(el);
    },
    [setDragRef, setDropRef],
  );

  // Kombinierter Over-Highlight-State: useDroppable's isOver ist zuverlaessig
  // fuer das Hover-Feedback, aber wir kombinieren es mit dem Parent-overId
  // fallback, damit auch der activeId-Fall (Kachel ueber sich selbst) OFF ist.
  const showOverRing = (isOver || isOverTarget) && !isDragging;

  const innerStyle: React.CSSProperties = {
    backgroundColor: isDragging
      ? "color-mix(in oklab, var(--accent) 6%, transparent)"
      : showOverRing
        ? "color-mix(in oklab, var(--accent) 10%, var(--card))"
        : !anyDragActive && hover
          ? "color-mix(in oklab, var(--foreground) 8%, var(--card))"
          : undefined,
    borderColor: isDragging
      ? "color-mix(in oklab, var(--accent) 55%, transparent)"
      : showOverRing
        ? "var(--accent)"
        : undefined,
    borderStyle: isDragging ? "dashed" : "solid",
    borderWidth: showOverRing ? "2px" : "1px",
    boxShadow: showOverRing
      ? "0 0 0 3px color-mix(in oklab, var(--accent) 22%, transparent)"
      : undefined,
    cursor: isDragging ? "grabbing" : "grab",
    touchAction: "none",
    // WICHTIG: transition NUR fuer Farb-/Border-States, NICHT fuer transform
    // — transform darf hier nichts machen, weil Grid nicht ge-reflow'd wird.
    // Der weiche Layout-Wechsel geschieht via startViewTransition beim Drop.
    transition:
      "background-color 140ms ease, border-color 140ms ease, box-shadow 140ms ease",
  };

  const toggleBtn = !isDragging ? (
    <button
      type="button"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={item.hidden ? "icon-btn" : "icon-btn icon-btn-green"}
      aria-label={item.hidden ? "Einblenden" : "Ausblenden"}
      data-tooltip={item.hidden ? "Einblenden" : "Ausblenden"}
      style={{ cursor: "pointer" }}
    >
      {item.hidden ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
    </button>
  ) : null;

  // WICHTIG: setNodeRef, attributes UND listeners liegen alle auf demselben
  // outer-div (kein separater absolute Handle-Layer). Der vorherige Ansatz
  // mit einer inneren absolute-inset-0-Layer war fragil, weil deren Parent
  // (h-full div in einer CSS-Grid-auto-Zelle) je nach Content 0-Hoehe
  // haben konnte → kein klickbares Feld, Drag ging gar nicht los.
  // Der Auge-Button liegt IM Content-Flow der TileVisual und stopt seinen
  // eigenen Pointer-Event → der Klick auf Auge triggert kein Drag.
  return (
    <div
      ref={setRefs}
      className={spanClass}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      {...attributes}
      {...listeners}
      // view-transition-name: Browser identifiziert die Kachel ueber das
      // Reorder hinweg und animiert automatisch von old-position zu
      // new-position (moderne Chrome/Edge/Safari 18+). Fallback: kein
      // Effekt, hartes Umschalten.
      // gridRowEnd: Masonry-Span (Hoehe + Gap) — analog MasonryCell im
      // echten Dashboard, nur mit vorberechneter Preview-Hoehe statt Messen.
      style={{
        viewTransitionName: `widget-${item.id}`,
        cursor: isDragging ? "grabbing" : "grab",
        gridRowEnd: `span ${previewHeight + PREVIEW_GAP}`,
      }}
      aria-label={`${item.title} verschieben`}
    >
      <TileVisual
        item={item}
        style={{ ...innerStyle, height: previewHeight }}
        contentOpacity={isDragging ? 0.25 : undefined}
        toggleButton={toggleBtn}
        widthSelector={
          !isDragging && !mobilePreview && !item.hidden ? (
            <WidthSelector current={currentSpan} onChange={onSetSpan} />
          ) : null
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// EmptySlotTile — droppable-Placeholder fuer eine leere Stelle im Grid.
// Nur wahrend Drag gerendert (siehe renderList in der Parent-Component).
// Zeigt eine gestrichelte "Hier ablegen"-Zone in der passenden Grid-Breite.
// Der span kommt aus der Slot-Berechnung; die col-span-Klasse ist LITERAL
// gemapped (Tailwind kompiliert keine dynamischen Klassen).
// ---------------------------------------------------------------------------

function EmptySlotTile({
  slotId,
  span,
  isOverTarget,
}: {
  slotId: string;
  span: number;
  isOverTarget: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: slotId });
  const show = isOver || isOverTarget;
  const spanClass =
    span === 4
      ? "col-span-4"
      : span === 8
        ? "col-span-8"
        : span === 6
          ? "col-span-6"
          : "col-span-12";
  return (
    <div
      ref={setNodeRef}
      className={`${spanClass} rounded-lg flex items-center justify-center transition-all duration-150`}
      style={{
        // Fester Masonry-Span analog GridTile (72px Slot-Hoehe + Gap).
        height: 72,
        gridRowEnd: `span ${72 + PREVIEW_GAP}`,
        border: show
          ? "2px dashed var(--accent)"
          : "2px dashed color-mix(in oklab, var(--foreground) 25%, transparent)",
        backgroundColor: show
          ? "color-mix(in oklab, var(--accent) 12%, transparent)"
          : "color-mix(in oklab, var(--foreground) 3%, transparent)",
      }}
      aria-label="Leere Position — hier ablegen"
    >
      <span
        className="text-[10px] font-medium uppercase tracking-wider"
        style={{
          color: show ? "var(--accent)" : "color-mix(in oklab, var(--foreground) 45%, transparent)",
        }}
      >
        + Hier ablegen
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HiddenSection — unter dem Grid: kompakte Chip-Liste der ausgeblendeten
// Widgets. Ein Klick auf ein Chip blendet das Widget wieder ein (fuegt es
// zurueck ins Grid). Frueher wurden hidden Widgets IM Grid grau-mit-
// Overlay gerendert — das kollidierte mit der Slot-Berechnung und stimmte
// nicht mit dem echten Dashboard ueberein (das hidden ganz weg-rendert).
// ---------------------------------------------------------------------------

function HiddenSection({
  items,
  onShow,
}: {
  items: PreferenceItem[];
  onShow: (id: string) => void;
}) {
  return (
    <div className="mt-3 rounded-xl border border-dashed p-2.5"
      style={{
        borderColor: "color-mix(in oklab, var(--foreground) 12%, transparent)",
        backgroundColor: "color-mix(in oklab, var(--foreground) 2%, transparent)",
      }}
    >
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 px-1">
        Ausgeblendet · Klick zum Einblenden
      </p>
      <div className="flex flex-wrap gap-1.5">
        {items.map((it) => (
          <HiddenChip key={it.id} item={it} onShow={() => onShow(it.id)} />
        ))}
      </div>
    </div>
  );
}

function HiddenChip({
  item,
  onShow,
}: {
  item: PreferenceItem;
  onShow: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onShow}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="inline-flex items-center gap-1.5 px-2 py-1 text-xs rounded-md border transition-colors"
      style={{
        backgroundColor: hover
          ? "color-mix(in oklab, var(--accent) 10%, var(--card))"
          : "var(--card)",
        borderColor: hover
          ? "var(--accent)"
          : "color-mix(in oklab, var(--foreground) 15%, transparent)",
        color: "var(--foreground)",
        cursor: "pointer",
      }}
      data-tooltip="Wieder einblenden"
    >
      <EyeOff className="h-3 w-3 text-muted-foreground" />
      <span className="text-accent">{iconFor(item.id)}</span>
      <span className="truncate max-w-40">{item.title}</span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Kleine Segmented-Control fuer Mobile/Desktop-Vorschau. State-driven Hover
// pro Segment (CLAUDE.md §3).
// ---------------------------------------------------------------------------

function PreviewToggle({
  mobile,
  onChange,
}: {
  mobile: boolean;
  onChange: (mobile: boolean) => void;
}) {
  return (
    <div
      className="inline-flex items-center rounded-lg border p-0.5"
      role="group"
      aria-label="Vorschau-Modus"
    >
      <SegBtn active={!mobile} onClick={() => onChange(false)} icon={<Monitor className="h-3.5 w-3.5" />}>
        Desktop
      </SegBtn>
      <SegBtn active={mobile} onClick={() => onChange(true)} icon={<Smartphone className="h-3.5 w-3.5" />}>
        Mobil
      </SegBtn>
    </div>
  );
}

function SegBtn({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors"
      aria-pressed={active}
      style={{
        backgroundColor: active
          ? "color-mix(in oklab, var(--foreground) 10%, transparent)"
          : hover
            ? "color-mix(in oklab, var(--foreground) 5%, transparent)"
            : "transparent",
        color: active ? "var(--foreground)" : "var(--muted-foreground)",
        fontWeight: active ? 600 : 500,
      }}
    >
      {icon}
      {children}
    </button>
  );
}

// KeyboardSensor Coordinate-Getter — flach, ohne SortableContext, weil wir
// den Sort selbst machen. Rueckt den Fokus fuer arrow-keys um 20px in die
// Richtung — dnd-kit KeyboardSensor braucht das als "Bewegungsvorschlag"
// wenn kein SortableContext den naechsten Slot berechnet.
function sortableKeyboardCoordinatesShim(
  event: KeyboardEvent,
  args: { currentCoordinates: { x: number; y: number } },
) {
  const { currentCoordinates } = args;
  switch (event.code) {
    case "ArrowRight":
      return { x: currentCoordinates.x + 25, y: currentCoordinates.y };
    case "ArrowLeft":
      return { x: currentCoordinates.x - 25, y: currentCoordinates.y };
    case "ArrowDown":
      return { x: currentCoordinates.x, y: currentCoordinates.y + 25 };
    case "ArrowUp":
      return { x: currentCoordinates.x, y: currentCoordinates.y - 25 };
  }
  return undefined;
}
