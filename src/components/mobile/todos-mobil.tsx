"use client";

/**
 * Todos am Handy (< md). Nur «fuer mich» (assigned_to = meId) — kein
 * Segment, kein Detail-Sheet: die Hauptaktion ist Abhaken, die zweite ist
 * schnell etwas festhalten (Zeile oben → Bottom-Sheet).
 *
 * Gruppen: Ueberfaellig (rot) · Heute · Spaeter · Ohne Datum; darunter
 * «Erledigt (n)» eingeklappt (Zustand in localStorage). Abhaken ist
 * optimistisch wie todo-row.tsx; Fehler rollen zurueck + toast.
 * Realtime: Window-Event "realtime:todos" (Layout-Channel + eigene Aktionen)
 * → gebuendelt neu laden.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, CheckSquare, ChevronDown, ChevronRight, Loader2, Plus } from "lucide-react";
import { Modal } from "@/components/ui/modal";
import { EmptyState } from "@/components/ui/empty-state";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { TOAST } from "@/lib/messages";
import { formatDate } from "@/lib/format";
import { addDaysIso, bucketForDue, relativeDueLabel, todayIso, type GroupBucket } from "@/lib/relative-date";
import {
  TODO_CHECKBOX_BASIS, TODO_CHECKBOX_ERLEDIGT, TODO_CHECKBOX_OFFEN,
} from "@/components/todos/todo-row";
import type { JobPriority } from "@/types";

/** Felder, die die Handy-Zeile braucht — mehr wird nicht geladen. */
interface TodoZeile {
  id: string;
  title: string;
  status: "offen" | "erledigt";
  priority: JobPriority;
  due_date: string | null;
  completed_at: string | null;
}

const SELECT = "id, title, status, priority, due_date, completed_at";
const SEITE_OFFEN = 100;
const SEITE_ERLEDIGT = 30;
const LS_ERLEDIGT_OFFEN = "todos-mobil-erledigt-offen";
/** Wie lange die abgehakte Zeile durchgestrichen stehen bleibt, bevor sie
 *  in «Erledigt» rutscht — kurzes sichtbares Feedback statt Verschwinden. */
const AUSBLENDEN_MS = 600;

type Gruppe = "ueberfaellig" | "heute" | "spaeter" | "ohneDatum";
const GRUPPEN: { key: Gruppe; label: string }[] = [
  { key: "ueberfaellig", label: "Überfällig" },
  { key: "heute", label: "Heute" },
  { key: "spaeter", label: "Später" },
  { key: "ohneDatum", label: "Ohne Datum" },
];
function gruppeFuer(bucket: GroupBucket): Gruppe {
  if (bucket === "overdue") return "ueberfaellig";
  if (bucket === "today") return "heute";
  if (bucket === "noDate") return "ohneDatum";
  return "spaeter";
}

type FaelligWahl = "heute" | "morgen" | "woche" | "datum";

function lsErledigtOffen(): boolean {
  if (typeof window === "undefined") return false;
  try { return localStorage.getItem(LS_ERLEDIGT_OFFEN) === "1"; } catch { return false; }
}

export function TodosMobil() {
  const supabase = createClient();
  const { can, meId } = usePermissions();
  const canView = can("todos:view");
  const canCreate = can("todos:create");

  const [offen, setOffen] = useState<TodoZeile[]>([]);
  const [offenLimit, setOffenLimit] = useState(SEITE_OFFEN);
  const [offenMehr, setOffenMehr] = useState(false);
  const [erledigt, setErledigt] = useState<TodoZeile[]>([]);
  const [erledigtLimit, setErledigtLimit] = useState(SEITE_ERLEDIGT);
  const [erledigtMehr, setErledigtMehr] = useState(false);
  const [erledigtAnzahl, setErledigtAnzahl] = useState(0);
  const [erledigtOffen, setErledigtOffen] = useState<boolean>(lsErledigtOffen);
  const [laedt, setLaedt] = useState(true);
  const [mehrLaedt, setMehrLaedt] = useState(false);
  const abfrageId = useRef(0);
  /** Todos mit laufendem Speichern — ein Schreibvorgang je Todo. */
  const speichernd = useRef(new Set<string>());

  useEffect(() => {
    try { localStorage.setItem(LS_ERLEDIGT_OFFEN, erledigtOffen ? "1" : "0"); } catch {}
  }, [erledigtOffen]);

  /* --- Laden ------------------------------------------------------------ */

  const laden = useCallback(async () => {
    if (!meId) return;
    const id = ++abfrageId.current;
    const basis = () => supabase.from("todos").select(SELECT).eq("assigned_to", meId).is("deleted_at", null);
    const [offenRes, zaehlRes, erledigtRes] = await Promise.all([
      basis()
        .eq("status", "offen")
        .order("due_date", { ascending: true, nullsFirst: false })
        .order("priority", { ascending: true })
        .order("created_at", { ascending: false })
        .limit(offenLimit + 1),
      supabase.from("todos").select("id", { count: "exact", head: true })
        .eq("assigned_to", meId).eq("status", "erledigt").is("deleted_at", null),
      erledigtOffen
        ? basis()
            .eq("status", "erledigt")
            .order("completed_at", { ascending: false, nullsFirst: false })
            .order("id", { ascending: false })
            .limit(erledigtLimit + 1)
        : Promise.resolve(null),
    ]);
    if (id !== abfrageId.current) return;
    if (offenRes.error) {
      toast.error("Todos konnten nicht geladen werden: " + offenRes.error.message);
    } else {
      const zeilen = (offenRes.data ?? []) as TodoZeile[];
      setOffenMehr(zeilen.length > offenLimit);
      setOffen(zeilen.slice(0, offenLimit));
    }
    if (zaehlRes.error) {
      toast.error("Erledigte konnten nicht gezählt werden: " + zaehlRes.error.message);
    } else {
      setErledigtAnzahl(zaehlRes.count ?? 0);
    }
    if (erledigtRes) {
      if (erledigtRes.error) {
        toast.error("Erledigte konnten nicht geladen werden: " + erledigtRes.error.message);
      } else {
        const zeilen = (erledigtRes.data ?? []) as TodoZeile[];
        setErledigtMehr(zeilen.length > erledigtLimit);
        setErledigt(zeilen.slice(0, erledigtLimit));
      }
    }
    setLaedt(false);
    setMehrLaedt(false);
  }, [supabase, meId, offenLimit, erledigtLimit, erledigtOffen]);

  // Erstes Laden als Callback (nicht synchron im Effekt-Body).
  useEffect(() => {
    const t = setTimeout(() => { void laden(); }, 0);
    return () => clearTimeout(t);
  }, [laden]);

  // Realtime (Layout-Channel auf todos) + eigene Aktionen → gebuendelt neu
  // laden: 400 ms trailing, damit ein Event-Schwall eine Abfrage ergibt.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handler = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void laden(); }, 400);
    };
    window.addEventListener("realtime:todos", handler);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("realtime:todos", handler);
    };
  }, [laden]);

  /* --- Abhaken (optimistisch) ------------------------------------------- */

  async function umschalten(t: TodoZeile) {
    if (speichernd.current.has(t.id)) return;
    speichernd.current.add(t.id);
    const neu: TodoZeile["status"] = t.status === "offen" ? "erledigt" : "offen";
    const completedAt = neu === "erledigt" ? new Date().toISOString() : null;
    const geaendert: TodoZeile = { ...t, status: neu, completed_at: completedAt };

    if (neu === "erledigt") {
      // Erst durchgestrichen stehen lassen, dann nach «Erledigt» ruecken.
      // Zaehler sofort — jeder Reload nach dem Schreiben setzt den DB-Wert.
      setOffen((prev) => prev.map((x) => (x.id === t.id ? geaendert : x)));
      setErledigtAnzahl((n) => n + 1);
      setTimeout(() => {
        setOffen((prev) => prev.filter((x) => x.id !== t.id));
        setErledigt((prev) => (prev.some((x) => x.id === t.id) ? prev : [geaendert, ...prev]));
      }, AUSBLENDEN_MS);
    } else {
      setErledigt((prev) => prev.filter((x) => x.id !== t.id));
      setOffen((prev) => (prev.some((x) => x.id === t.id) ? prev : [...prev, geaendert]));
      setErledigtAnzahl((n) => Math.max(0, n - 1));
    }

    const { error } = await supabase
      .from("todos")
      .update({ status: neu, completed_at: completedAt })
      .eq("id", t.id);
    speichernd.current.delete(t.id);
    if (error) {
      toast.error("Konnte nicht aktualisiert werden: " + error.message);
      await laden();
      return;
    }
    // Nav-Zaehler + eigene Liste nachziehen (die Tabelle selbst feuert
    // zusaetzlich ueber den Layout-Channel; beides laeuft gebuendelt).
    window.dispatchEvent(new Event("realtime:todos"));
    if (neu === "erledigt") {
      toast.success("Erledigt", {
        action: { label: "Rückgängig", onClick: () => { void umschalten(geaendert); } },
        duration: 5000,
      });
    }
  }

  /* --- Neu anlegen ------------------------------------------------------ */

  const [sheetOffen, setSheetOffen] = useState(false);
  const [titel, setTitel] = useState("");
  const [faellig, setFaellig] = useState<FaelligWahl>("woche");
  const [datum, setDatum] = useState("");
  const [legtAn, setLegtAn] = useState(false);
  const titelRef = useRef<HTMLInputElement>(null);

  // Autofokus erst wenn das Sheet steht (das Modal fokussiert sonst sein X).
  useEffect(() => {
    if (!sheetOffen) return;
    const t = setTimeout(() => titelRef.current?.focus(), 40);
    return () => clearTimeout(t);
  }, [sheetOffen]);

  function sheetSchliessen() {
    if (legtAn) return;
    setSheetOffen(false);
    setTitel("");
    setFaellig("woche");
    setDatum("");
  }

  function faelligIso(): string | null {
    const heute = todayIso();
    if (faellig === "heute") return heute;
    if (faellig === "morgen") return addDaysIso(heute, 1);
    if (faellig === "woche") return addDaysIso(heute, 7);
    return datum || null;
  }

  async function anlegen() {
    const t = titel.trim();
    if (!t || legtAn || !meId) return;
    if (faellig === "datum" && !datum) { toast.error("Bitte ein Datum wählen"); return; }
    setLegtAn(true);
    // Wie der Desktop (todos/page.tsx createTodo): assigned_to = ich, Prio
    // normal, Status offen (DB-Default). Benachrichtigung entfaellt, weil der
    // Desktop sich selbst ebenfalls nicht benachrichtigt.
    const { error } = await supabase.from("todos").insert({
      title: t,
      description: null,
      priority: "normal",
      due_date: faelligIso(),
      assigned_to: meId,
      created_by: meId,
    });
    setLegtAn(false);
    if (error) { TOAST.createError(error.message); return; }
    toast.success("Todo erstellt");
    setSheetOffen(false);
    setTitel("");
    setFaellig("woche");
    setDatum("");
    window.dispatchEvent(new Event("realtime:todos"));
    await laden();
  }

  /* --- Gruppierung ------------------------------------------------------ */

  const gruppiert = useMemo(() => {
    const heute = todayIso();
    const map = new Map<Gruppe, TodoZeile[]>();
    for (const t of offen) {
      const g = gruppeFuer(bucketForDue(t.due_date, heute));
      const list = map.get(g) ?? [];
      list.push(t);
      map.set(g, list);
    }
    return GRUPPEN.map((g) => ({ ...g, zeilen: map.get(g.key) ?? [] })).filter((g) => g.zeilen.length > 0);
  }, [offen]);

  /* --- Rendering -------------------------------------------------------- */

  if (!canView) {
    return (
      <EmptyState icon={CheckSquare} title="Kein Zugriff auf Todos" description="Deine Rolle hat die Berechtigung 'todos:view' nicht." />
    );
  }

  const faelligChips: { key: FaelligWahl; label: string }[] = [
    { key: "heute", label: "Heute" },
    { key: "morgen", label: "Morgen" },
    { key: "woche", label: "7 Tage" },
    { key: "datum", label: "Datum" },
  ];

  return (
    <div className="page-enter space-y-4">
      {canCreate && meId && (
        <button
          type="button"
          onClick={() => setSheetOffen(true)}
          className="flex h-14 w-full items-center gap-3 rounded-xl border border-border bg-card px-4 text-left text-base text-muted-foreground active:bg-foreground/10"
        >
          <Plus className="h-5 w-5 shrink-0" />
          Neues Todo …
        </button>
      )}

      {laedt ? (
        <div className="space-y-2">
          <div className="shimmer h-4 w-24 rounded" />
          {[1, 2, 3, 4].map((i) => <div key={i} className="shimmer h-[60px] rounded-xl" />)}
        </div>
      ) : offen.length === 0 ? (
        <EmptyState
          icon={CheckSquare}
          title="Alles erledigt"
          description={canCreate ? "Nutze die Zeile oben, um schnell etwas festzuhalten." : undefined}
        />
      ) : (
        <div className="space-y-5">
          {gruppiert.map((g) => (
            <section key={g.key} className="space-y-2">
              <p className={`px-1 text-[12px] font-bold uppercase tracking-wider ${
                g.key === "ueberfaellig" ? "text-red-600 dark:text-red-400" : "text-muted-foreground"
              }`}>
                {g.label} · {g.zeilen.length}
              </p>
              <div className="overflow-hidden rounded-xl border border-border bg-card">
                {g.zeilen.map((t) => (
                  <Zeile key={t.id} todo={t} ueberfaellig={g.key === "ueberfaellig"} onToggle={umschalten} />
                ))}
              </div>
            </section>
          ))}
          {offenMehr && (
            <button
              type="button"
              disabled={mehrLaedt}
              onClick={() => { setMehrLaedt(true); setOffenLimit((n) => n + SEITE_OFFEN); }}
              className="kasten kasten-muted h-11 w-full text-[15px]"
            >
              {mehrLaedt ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronDown className="h-4 w-4" />}
              Mehr laden
            </button>
          )}
        </div>
      )}

      {/* Erledigt — eingeklappt, Tipp klappt auf. */}
      {!laedt && erledigtAnzahl > 0 && (
        <section className="space-y-2">
          <button
            type="button"
            onClick={() => setErledigtOffen((v) => !v)}
            aria-expanded={erledigtOffen}
            className="flex h-11 w-full items-center gap-1 px-1 text-left text-[12px] font-bold uppercase tracking-wider text-muted-foreground"
          >
            {erledigtOffen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            Erledigt ({erledigtAnzahl})
          </button>
          {erledigtOffen && (
            erledigt.length === 0 ? (
              <div className="space-y-2">
                {[1, 2].map((i) => <div key={i} className="shimmer h-[60px] rounded-xl" />)}
              </div>
            ) : (
              <>
                <div className="overflow-hidden rounded-xl border border-border bg-card">
                  {erledigt.map((t) => <Zeile key={t.id} todo={t} ueberfaellig={false} onToggle={umschalten} />)}
                </div>
                {erledigtMehr && (
                  <button
                    type="button"
                    disabled={mehrLaedt}
                    onClick={() => { setMehrLaedt(true); setErledigtLimit((n) => n + SEITE_ERLEDIGT); }}
                    className="kasten kasten-muted h-11 w-full text-[15px]"
                  >
                    {mehrLaedt ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronDown className="h-4 w-4" />}
                    Mehr laden
                  </button>
                )}
              </>
            )
          )}
        </section>
      )}

      {/* Neu-Sheet */}
      <Modal open={sheetOffen} onClose={sheetSchliessen} title="Neues Todo" sheet size="md" closable={!legtAn} bodyClassName="p-4 space-y-4">
        <input
          ref={titelRef}
          type="text"
          value={titel}
          onChange={(e) => setTitel(e.target.value)}
          placeholder="Was ist zu tun?"
          enterKeyHint="done"
          disabled={legtAn}
          onKeyDown={(e) => {
            // Enter legt an (eigener Handler, preventDefault wegen Enter=Tab).
            if (e.key !== "Enter") return;
            e.preventDefault();
            void anlegen();
          }}
          className="h-[52px] w-full rounded-xl border border-border bg-background px-4 text-base placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40"
        />
        <div className="space-y-2">
          <p className="px-1 text-[12px] font-bold uppercase tracking-wider text-muted-foreground">Fällig</p>
          <div className="grid grid-cols-4 gap-2">
            {faelligChips.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setFaellig(c.key)}
                aria-pressed={faellig === c.key}
                disabled={legtAn}
                className={`${faellig === c.key ? "kasten-active" : "kasten-toggle-off"} h-11 justify-center px-2 text-[14px]`}
              >
                {c.label}
              </button>
            ))}
          </div>
          {faellig === "datum" && (
            <input
              type="date"
              value={datum}
              min={todayIso()}
              onChange={(e) => setDatum(e.target.value)}
              disabled={legtAn}
              aria-label="Fällig am"
              className="h-12 w-full rounded-xl border border-border bg-background px-4 text-base focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          )}
        </div>
        <button
          type="button"
          onClick={() => { void anlegen(); }}
          disabled={legtAn || !titel.trim() || (faellig === "datum" && !datum)}
          className="kasten kasten-red h-[52px] w-full text-base"
        >
          {legtAn && <Loader2 className="h-4 w-4 animate-spin" />}
          {legtAn ? "Wird angelegt …" : "Anlegen"}
        </button>
      </Modal>
    </div>
  );
}

/* ------------------------------------------------------------------------- */
/*  Zeile 60 px: Checkbox (44-px-Tastflaeche, 24-px-Box) · Titel 2 Zeilen · */
/*  Faellig-Chip rechts                                                       */
/* ------------------------------------------------------------------------- */

function Zeile({ todo, ueberfaellig, onToggle }: { todo: TodoZeile; ueberfaellig: boolean; onToggle: (t: TodoZeile) => void }) {
  const erledigt = todo.status === "erledigt";
  const faellig = todo.due_date ? relativeDueLabel(todo.due_date) : null;
  const abgeschlossen = erledigt && todo.completed_at ? formatDate(todo.completed_at) : null;

  return (
    <div className={`flex min-h-[60px] items-center gap-1 border-t border-border py-2 pl-1 pr-4 first:border-t-0 ${erledigt ? "opacity-70" : ""}`}>
      <button
        type="button"
        onClick={() => onToggle(todo)}
        aria-label={erledigt ? "Wieder öffnen" : "Als erledigt markieren"}
        className="flex h-11 w-11 shrink-0 items-center justify-center"
      >
        <span className={`${TODO_CHECKBOX_BASIS} ${erledigt ? TODO_CHECKBOX_ERLEDIGT : TODO_CHECKBOX_OFFEN}`}>
          {erledigt && <Check className="h-4 w-4" strokeWidth={3} />}
        </span>
      </button>
      <div className="min-w-0 flex-1">
        <p className={`line-clamp-2 text-base font-medium leading-snug ${erledigt ? "line-through text-muted-foreground" : ""}`}>
          {todo.title}
        </p>
        {todo.priority === "dringend" && !erledigt && (
          <p className="text-[12px] font-semibold text-red-600 dark:text-red-400">Dringend</p>
        )}
      </div>
      {erledigt ? (
        abgeschlossen && <span className="shrink-0 text-[13px] tabular-nums text-muted-foreground">{abgeschlossen}</span>
      ) : faellig ? (
        <span className={`shrink-0 text-[13px] tabular-nums ${ueberfaellig ? "font-semibold text-red-600 dark:text-red-400" : "text-muted-foreground"}`}>
          {faellig.label}
        </span>
      ) : null}
    </div>
  );
}
