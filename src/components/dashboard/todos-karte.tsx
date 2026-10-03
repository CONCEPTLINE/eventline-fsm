"use client";

// Bereich «Meine Todos»: die eigenen offenen Todos — Ueberfaelliges und
// Heutiges zuerst, direkt abhakbar. Auswahl und Reihenfolge macht
// /api/dashboard (hoechstens 6, dazu die Zaehler). Bewusst einspaltig, auch
// in voller Breite: Todos liest man von oben nach unten.
//
// Abhaken wie toggleTodo auf /todos: sofort angezeigt (optimistisch), dann
// gespeichert (status + completed_at); Toast «Erledigt» mit «Rückgängig»
// (5 s); Sidebar-Zaehler frisch; Fehler → Toast und Daten neu laden. Die
// abgehakte Zeile steht kurz durchgestrichen da und blendet nach 600 ms aus;
// Zaehler, Kopf-Satz und Session-Cache folgen sofort (todo-stand.ts,
// session-cache.ts). Checkbox, Dringend-Chip und Faelligkeit wie auf /todos
// (todo-row.tsx, relativeDueLabel). Ohne offene Todos die Ruhe-Flaeche wie
// bei «Braucht Aufmerksamkeit». Klick auf eine Todo oeffnet /todos (die
// Seite kennt keinen Deep-Link auf eine einzelne Todo).

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Calendar, Check, CheckSquare } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { relativeDueLabel, todayIso } from "@/lib/relative-date";
import {
  DringendChip,
  TODO_CHECKBOX_BASIS,
  TODO_CHECKBOX_ERLEDIGT,
  TODO_CHECKBOX_OFFEN,
  TODO_CHECKBOX_OFFEN_HOVER,
} from "@/components/todos/todo-row";
import type { TodoEintrag, TodosDaten } from "@/components/dashboard/typen";
import { Karte, KartenLink, RuheFlaeche } from "@/components/dashboard/karte";
import { todoZahlen, type TodoStatus } from "@/components/dashboard/todo-stand";
import { todoGespeichert, todoStatusSetzen, todoVerworfen } from "@/components/dashboard/session-cache";

/** Abgehakt: so lange steht die Zeile noch (600 ms durchgestrichen, dann
 *  250 ms Ausblenden) — passend zu delay-[600ms] / duration-[250ms] unten. */
const AUSBLENDEN_BIS_MS = 600 + 250;
/** Ziel aller Links der Karte: die Todo-Seite immer mit «Meine» und ohne
 *  Erledigte — sonst gewinnt dort die zuletzt gespeicherte Ansicht. */
const TODOS_HREF = "/todos?scope=mine&completed=0";

/** Todos mit laufendem Speichern — je Todo immer nur ein Schreibvorgang
 *  (Doppelklick, «Rückgängig» waehrend des Speicherns). Modulweit, weil ein
 *  Speichern den Mount der Karte ueberdauern kann. */
const speichernd = new Set<string>();

/** Status speichern wie toggleTodo auf /todos. Gibt die Fehlermeldung
 *  zurueck, null = gespeichert. */
async function speichern(id: string, status: TodoStatus): Promise<string | null> {
  try {
    const { error } = await createClient()
      .from("todos")
      .update({ status, completed_at: status === "erledigt" ? new Date().toISOString() : null })
      .eq("id", id);
    return error ? error.message : null;
  } catch (e) {
    return e instanceof Error ? e.message : "Netzwerk-Fehler";
  }
}

/** Sidebar-Zaehler (use-nav-counts.tsx) sofort auffrischen — dasselbe
 *  Signal wie ein Realtime-Event auf todos (die Tabelle sendet selbst keine). */
function navZaehlerAuffrischen(): void {
  window.dispatchEvent(new Event("realtime:todos"));
}

/** Abhaken bzw. (waehrend sie noch durchgestrichen steht) wieder oeffnen. */
async function umschalten(t: TodoEintrag, neuLaden: () => void): Promise<void> {
  if (speichernd.has(t.id)) return;
  speichernd.add(t.id);
  const neu: TodoStatus = t.status === "offen" ? "erledigt" : "offen";
  todoStatusSetzen(t.id, neu, false);
  const start = Date.now();
  const fehler = await speichern(t.id, neu);
  speichernd.delete(t.id);
  if (fehler !== null) {
    toast.error("Konnte nicht aktualisiert werden: " + fehler);
    todoVerworfen(t.id, t.status);
    neuLaden();
    return;
  }
  todoGespeichert(t.id);
  navZaehlerAuffrischen();
  // Langsames Netz: war die Zeile schon ausgeblendet, bevor das Speichern
  // bestaetigt war, kann das Nachruecken eine veraltete Liste geholt haben —
  // dann jetzt (nach der Bestaetigung) noch einmal laden.
  if (neu === "erledigt" && Date.now() - start > AUSBLENDEN_BIS_MS) neuLaden();
  if (neu === "erledigt") {
    toast.success("Erledigt", {
      action: { label: "Rückgängig", onClick: () => void rueckgaengig(t.id) },
      duration: 5000,
    });
  }
}

/** «Rückgängig» im Toast — wie auf /todos erst speichern, dann zeigen. Die
 *  Karte kann laengst weg sein: alles laeuft ueber den Session-Cache, die
 *  gerade sichtbare Seite holt die Todo zurueck. */
async function rueckgaengig(id: string): Promise<void> {
  if (speichernd.has(id)) return;
  speichernd.add(id);
  const fehler = await speichern(id, "offen");
  speichernd.delete(id);
  if (fehler !== null) {
    toast.error("Rückgängig fehlgeschlagen: " + fehler);
    return;
  }
  todoStatusSetzen(id, "offen", true);
  navZaehlerAuffrischen();
}

export function TodosKarte({
  daten,
  haken,
  neuLaden,
}: {
  daten: TodosDaten;
  /** Haken der Ruhe-Flaeche gezeichnet (Auftakt). */
  haken: boolean;
  /** Dashboard-Daten still neu laden (stabil). */
  neuLaden: () => void;
}) {
  // In diesem Mount abgehakte Todos, die noch durchgestrichen stehen bzw.
  // ausblenden. Erledigte aus dem Cache (frueherer Besuch) zeigt die Karte
  // gar nicht mehr.
  const [ausblendend, setAusblendend] = useState<ReadonlySet<string>>(() => new Set());
  // Nach dem Ausblenden nachruecken lassen (siehe Effekt unten).
  const nachruecken = useRef(false);

  const abhaken = useCallback(
    (t: TodoEintrag) => {
      if (t.status === "offen") setAusblendend((s) => new Set(s).add(t.id));
      void umschalten(t, neuLaden);
    },
    [neuLaden],
  );

  const ausgeblendet = useCallback((id: string) => {
    nachruecken.current = true;
    setAusblendend((s) => {
      if (!s.has(id)) return s;
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  }, []);

  const zahlen = todoZahlen(daten);
  const zeilen = daten.eintraege.filter((t) => t.status === "offen" || ausblendend.has(t.id));
  const blendetAus = zeilen.some((t) => t.status === "erledigt");
  // Nicht gelieferte offene Todos (mehr als 6) — bleibt beim Abhaken gleich.
  const weitere = Math.max(0, daten.offen - daten.eintraege.length);
  const heute = todayIso();

  // Nachruecken: gibt es mehr offene Todos, als geliefert wurden, laedt die
  // Karte nach dem Ausblenden still neu, damit die naechste in die Liste
  // rueckt — erst wenn keine Zeile mehr ausblendet (die neue Antwort bringt
  // abgehakte nicht mehr; eine halb ausgeblendete verschwaende sonst).
  useEffect(() => {
    if (!nachruecken.current || blendetAus) return;
    nachruecken.current = false;
    if (daten.offen > daten.eintraege.length) neuLaden();
  }, [blendetAus, daten, neuLaden]);

  return (
    <Karte
      titel="Meine Todos"
      icon={CheckSquare}
      rechts={
        zahlen.offen > 0 ? <span className="text-xs text-muted-foreground tabular-nums">{zahlen.offen} offen</span> : undefined
      }
    >
      {zeilen.length === 0 && zahlen.offen === 0 ? (
        <RuheFlaeche titel="Keine offenen Todos" haken={haken}>
          Etwas festzuhalten? <KartenLink href={TODOS_HREF}>Todo erfassen</KartenLink>
        </RuheFlaeche>
      ) : (
        <>
          {/* flex-1: die Liste waechst mit der Reihenhoehe, die Fusszeile bleibt unten. */}
          <div className="flex flex-1 flex-col">
            {zeilen.map((t, i) => (
              <TodoZeile
                key={t.id}
                todo={t}
                erste={i === 0}
                heute={heute}
                onAbhaken={abhaken}
                onAusgeblendet={ausgeblendet}
              />
            ))}
          </div>
          <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span className="tabular-nums">{weitere > 0 ? `+${weitere} weitere` : null}</span>
            <KartenLink href={TODOS_HREF}>Alle Todos</KartenLink>
          </div>
        </>
      )}
    </Karte>
  );
}

function TodoZeile({
  todo,
  erste,
  heute,
  onAbhaken,
  onAusgeblendet,
}: {
  todo: TodoEintrag;
  erste: boolean;
  /** Heute (Zurich, YYYY-MM-DD) — einmal je Render der Karte. */
  heute: string;
  onAbhaken: (t: TodoEintrag) => void;
  onAusgeblendet: (id: string) => void;
}) {
  const erledigt = todo.status === "erledigt";
  // Abgehakt: nach dem Ausblenden aus der Liste nehmen. Wieder geoeffnet
  // (Klick, Rückgängig) bricht das ab.
  useEffect(() => {
    if (!erledigt) return;
    const uhr = window.setTimeout(() => onAusgeblendet(todo.id), AUSBLENDEN_BIS_MS);
    return () => window.clearTimeout(uhr);
  }, [erledigt, onAusgeblendet, todo.id]);

  const faellig = todo.due_date ? relativeDueLabel(todo.due_date, heute) : null;
  // Faelligkeit wie auf /todos (relativeDueLabel); ueberfaellig rot, heute amber.
  const ton = erledigt
    ? "text-muted-foreground"
    : faellig?.overdue
      ? "font-medium text-red-600 dark:text-red-400"
      : faellig?.today
        ? "font-medium text-amber-700 dark:text-amber-300"
        : "text-muted-foreground";

  return (
    // Ausblenden: Hoehe (Grid-Zeile 1fr → 0fr) und Deckkraft — erst nach
    // 600 ms, dann in 250 ms; reduzierte Bewegung: ohne Animation, nach
    // derselben Zeit weg. Wieder geoeffnet: sofort zurueck.
    <div
      className={cn(
        "grid transition-[grid-template-rows,opacity] duration-[250ms] ease-out motion-reduce:duration-0",
        erledigt && "delay-[600ms]",
      )}
      style={{ gridTemplateRows: erledigt ? "0fr" : "1fr", opacity: erledigt ? 0 : 1 }}
    >
      <div className="min-h-0 overflow-hidden">
        <div className={cn("row-hover flex items-center gap-3 px-0.5 py-2.5", !erste && "border-t")}>
          <TodoCheckbox erledigt={erledigt} onClick={() => onAbhaken(todo)} />
          <Link href={TODOS_HREF} className="flex min-w-0 flex-1 items-center gap-2">
            <span className={cn("min-w-0 truncate text-sm", erledigt && "text-muted-foreground line-through")}>
              {todo.title}
            </span>
            {todo.priority === "dringend" && !erledigt && <DringendChip />}
            {faellig && (
              <span data-tooltip={faellig.tooltip} className={cn("ml-auto inline-flex shrink-0 items-center gap-1 text-xs", ton)}>
                <Calendar className="h-3 w-3" aria-hidden />
                {faellig.label}
              </span>
            )}
          </Link>
        </div>
      </div>
    </div>
  );
}

/** Erledigt-Checkbox in der Optik von /todos (todo-row.tsx); Hover
 *  state-driven (Projekt-Regel) statt hover:-Klassen. */
function TodoCheckbox({ erledigt, onClick }: { erledigt: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      // Doppelklick (zweiter Klick, detail > 1) ignorieren — sonst oeffnet er
      // die eben abgehakte Todo bei schnellem Netz gleich wieder.
      onClick={(e) => { if (e.detail > 1) return; onClick(); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label={erledigt ? "Wieder öffnen" : "Als erledigt markieren"}
      className={cn(
        TODO_CHECKBOX_BASIS,
        erledigt ? TODO_CHECKBOX_ERLEDIGT : hover ? TODO_CHECKBOX_OFFEN_HOVER : TODO_CHECKBOX_OFFEN,
      )}
    >
      {erledigt && <Check className="h-4 w-4" strokeWidth={3} aria-hidden />}
    </button>
  );
}
