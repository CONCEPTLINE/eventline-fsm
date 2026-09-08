"use client";

/**
 * Anwesenheitskalender (Dashboard).
 *
 * Port aus conceptline-fsm (src/components/dashboard/anwesenheit-card.tsx).
 * Sichtbar für alle mit Permission `anwesenheit:view` (per Rolle) sowie Admins.
 *
 * Grid: Zeilen = die zugeteilten Personen, Spalten = HEUTE + 6 Tage voraus
 * (heute immer ganz links, rollend). Jeder traegt in seiner eigenen Zeile
 * pro Tag ein, ob und von wann bis wann er da ist. Andere Zeilen sind
 * read-only.
 *
 * Datenmodell (existierende Tabelle `office_attendance`, erweitert um
 * from_time/to_time durch Migration 204):
 *   (user_id uuid, date date, from_time time, to_time time,
 *    start_hour smallint [legacy], end_hour smallint [legacy])
 *   Existence einer Row = anwesend. Legacy-Rows haben nur start/end_hour;
 *   die Migration hat from_time/to_time gebackfilled, das UI liest nur
 *   noch from/to. Neue Rows schreiben BEIDES (from/to + start/end_hour),
 *   damit alter Reader ebenfalls funktioniert.
 *
 * Berechtigte User werden via RPC `get_anwesenheit_users()` geladen
 * (SECURITY DEFINER — profiles-RLS erlaubt normalen Usern kein select
 * auf andere Rows).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CalendarCheck, ChevronLeft, ChevronRight, Check, Plus, X, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { todayLocalIso, weekdayForDateIso } from "@/lib/swiss-time";
import { Skeleton } from "@/components/ui/skeleton";

type Person = { id: string; full_name: string | null };
type Entry = { user_id: string; date: string; from_time: string; to_time: string };
type Day = { iso: string; weekday: number; dayLabel: string };
const DAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];

// YYYY-MM-DD + Tages-Offset -> YYYY-MM-DD (rein string-basiert, DST-immun).
function addDaysIso(iso: string, delta: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + delta));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

// Ansicht startet IMMER mit HEUTE (ganz links, Zurich-Kalender) → 7 Tage im Voraus.
// offset verschiebt das 7-Tage-Fenster in Wochenschritten.
function buildDay(iso: string): Day {
  const [, m, d] = iso.split("-").map(Number);
  // weekdayForDateIso: 0=So..6=Sa. Wir wollen 0=Mo..6=So fuer DAYS[].
  const weekday = (weekdayForDateIso(iso) + 6) % 7;
  return {
    iso,
    weekday,
    dayLabel: `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}`,
  };
}
function hm(t: string | null | undefined) {
  return (t ?? "").slice(0, 5);
}

// Leo will nur 15-Min-Schritte im UI. `step="900"` am <input type="time">
// erzwingt das im Browser-Picker, aber getippte Werte kommen trotzdem
// minutengenau durch — deshalb defensiv beim Speichern / Öffnen runden.
// Rundet auf nächste :00/:15/:30/:45 und clampt 24:00 auf 23:45.
function snapTo15(hhmm: string): string {
  if (!/^\d{2}:\d{2}$/.test(hhmm)) return hhmm;
  const h = Number(hhmm.slice(0, 2));
  const m = Number(hhmm.slice(3, 5));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const total = h * 60 + m;
  const snapped = Math.min(23 * 60 + 45, Math.max(0, Math.round(total / 15) * 15));
  const H = String(Math.floor(snapped / 60)).padStart(2, "0");
  const M = String(snapped % 60).padStart(2, "0");
  return `${H}:${M}`;
}

export function AnwesenheitskalenderCard({ className }: { className?: string }) {
  const supabase = createClient();
  const [uid, setUid] = useState<string | null>(null);
  const [meLoading, setMeLoading] = useState(true);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [week, setWeek] = useState(0);
  const [edit, setEdit] = useState<{ date: string; from: string; to: string } | null>(null);

  const days = useMemo(() => {
    const startIso = addDaysIso(todayLocalIso(), week * 7);
    return Array.from({ length: 7 }, (_, i) => buildDay(addDaysIso(startIso, i)));
  }, [week]);
  const weekStart = days[0].iso;
  const weekEnd = days[6].iso;

  // Auth-User + Berechtigten-Liste PARALLEL laden (Perf: frueher lief das
  // Widget in 3 sequentiellen Roundtrip-Stufen — getUser, DANN RPC (auf uid
  // gegated), DANN Entries (auf allowed gegated) — und wurde dadurch
  // sichtbar spaeter fertig als der Rest des Dashboards). getUser und die
  // RPC sind voneinander unabhaengig; die Entries-Query (eigener Effect
  // unten) haengt inhaltlich nur an der Woche. Alles startet jetzt im
  // selben Mount-Tick.
  //
  // getUser bleibt bewusst (statt profile.id aus usePermissions): unter
  // Dev-Mode-Impersonation waere profile.id != auth.uid(), und der Upsert
  // in save() muss mit der ECHTEN Auth-uid laufen (RLS).
  //
  // RPC get_anwesenheit_users (Migration 124): id+full_name aller aktiven
  // Nicht-Partner-Mitarbeiter mit 'anwesenheit:view'-Perm. Der User selbst
  // darf nur ins Grid wenn er selbst in der Liste ist.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [userRes, rpcRes] = await Promise.all([
        supabase.auth.getUser(),
        supabase.rpc("get_anwesenheit_users"),
      ]);
      if (cancelled) return;
      const userId = userRes.data.user?.id ?? null;
      setUid(userId);
      setMeLoading(false);
      if (rpcRes.error) {
        // Nie stiller Fehlschlag — Toast + console.error, sonst waere eine
        // kaputte Migration/RPC von aussen nicht diagnostizierbar
        // (CLAUDE.md §7). Card blendet trotzdem aus (Fallback-Verhalten).
        console.error("get_anwesenheit_users failed", rpcRes.error);
        toast.error(`Anwesenheit konnte nicht geladen werden: ${rpcRes.error.message}`);
        setAllowed(false);
        return;
      }
      // RPC koennte bei Signatur-Aenderung Object statt Array liefern —
      // Array.isArray-Guard schuetzt vor TypeError im .map().
      const list = (Array.isArray(rpcRes.data) ? (rpcRes.data as Person[]) : []).map((p) => ({
        id: p.id,
        full_name: p.full_name,
      }));
      setPeople(list);
      setAllowed(list.some((p) => p.id === userId));
    })();
    return () => { cancelled = true; };
  }, [supabase]);

  const loadEntries = useCallback(async () => {
    const { data, error } = await supabase
      .from("office_attendance")
      .select("user_id, date, from_time, to_time")
      .gte("date", weekStart)
      .lte("date", weekEnd);
    if (error) {
      // Ohne Toast wuerde die Kalender-Ansicht still leer bleiben und der
      // Nutzer denkt "niemand da". Lieber sichtbar melden.
      toast.error(`Anwesenheit konnte nicht geladen werden: ${error.message}`);
      setEntries([]);
      return;
    }
    // Legacy-Rows koennen from_time/to_time = NULL haben — filtere die raus,
    // sonst zeigt das UI "00:00–00:00". Migration 204 backfilled sie, aber
    // ein Fallback bleibt drin.
    setEntries(((data as Entry[]) ?? []).filter((e) => e.from_time && e.to_time));
  }, [supabase, weekStart, weekEnd]);

  // Entries laufen parallel zum Auth/RPC-Load (nicht mehr auf `allowed`
  // gegated — das war Stufe 3 des Wasserfalls) und neu bei Wochen-Nav.
  // Safe: die RLS-Select-Policy (Migration 123) liefert Nicht-Berechtigten
  // LEERE Rows statt eines Fehlers (kein Fehl-Toast), und gerendert wird
  // das Grid ohnehin erst bei allowed === true.
  useEffect(() => { loadEntries(); }, [loadEntries]);

  // §7: sofortiges Ladefeedback statt leerer Grid-Zelle. Solange Auth/RPC
  // laufen zeigt die Card ein Skeleton — sonst blieb bei nicht-berechtigten
  // Usern DAUERHAFT ein leerer full-width Kasten stehen (das umschliessende
  // grid rendert immer `<div class="col-span-12">…</div>`).
  if (meLoading || allowed === null) {
    return (
      <section className={cn("rounded-xl border bg-card p-3 flex flex-col gap-2", className)}>
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-40 w-full" />
      </section>
    );
  }
  // Server-side sollte das Widget bei fehlender Permission gar nicht liefern
  // (siehe /api/dashboard). Landet es trotzdem hier (Rollen-Override,
  // Registry-Drift), zeigen wir eine kompakte Not-anzeige statt eines
  // leeren Kastens — sonst wirkt der Widget-Slot "kaputt".
  if (!allowed) {
    return (
      <section className={cn("rounded-xl border bg-card p-3 flex items-center gap-2 text-sm text-muted-foreground", className)}>
        <CalendarCheck className="h-4 w-4 text-accent" />
        Anwesenheitskalender ist für dich nicht freigeschaltet.
      </section>
    );
  }

  const todayIso = todayLocalIso();
  const entryOf = (userId: string, date: string) => entries.find((e) => e.user_id === userId && e.date === date);

  async function save() {
    if (!edit || !uid) return;
    // Defensiv auf 15-Min-Raster snappen — der Browser-Picker respektiert
    // step="900", getippte Werte (Firefox / mobile Keyboards) kommen aber
    // minutengenau durch. So bleibt die DB garantiert auf :00/:15/:30/:45.
    const from = snapTo15(edit.from);
    const to = snapTo15(edit.to);
    if (to <= from) return void toast.error("Bis-Zeit muss nach Von-Zeit sein");
    // start_hour/end_hour spiegeln fuer Read-Kompat mit dem alten Widget-Code
    // (Migration 125 legt die Constraint auf 0..23 / 1..24). Wir schreiben
    // hh aus edit.from/to — end=24 vermeiden wir, indem >23:59 auf 24 mapt.
    const startH = Number(from.slice(0, 2));
    const endH = Math.min(24, Math.max(startH + 1, Math.ceil(Number(to.slice(0, 2)) + Number(to.slice(3, 5)) / 60)));
    const { error } = await supabase
      .from("office_attendance")
      .upsert(
        {
          user_id: uid,
          date: edit.date,
          from_time: from,
          to_time: to,
          start_hour: startH,
          end_hour: endH,
        },
        { onConflict: "user_id,date" },
      );
    if (error) return void toast.error(error.message);
    setEdit(null);
    loadEntries();
  }

  async function clear(date: string) {
    if (!uid) return;
    const { error } = await supabase.from("office_attendance").delete().eq("user_id", uid).eq("date", date);
    if (error) return void toast.error(error.message);
    setEdit(null);
    loadEntries();
  }

  return (
    <section className={cn("rounded-xl border bg-card p-3 flex flex-col", className)}>
      <div className="flex items-center justify-between gap-2 mb-2.5 flex-wrap shrink-0">
        <h2 className="font-heading text-base font-semibold flex items-center gap-2">
          <CalendarCheck className="h-4 w-4 text-accent" /> Anwesenheit
        </h2>
        <div className="flex items-center gap-2">
          <button onClick={() => setWeek((w) => w - 1)} className="icon-btn" aria-label="Vorherige Woche">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-xs font-medium tabular-nums min-w-[130px] text-center">
            {days[0].dayLabel} – {days[6].dayLabel}
          </span>
          <button onClick={() => setWeek((w) => w + 1)} className="icon-btn" aria-label="Nächste Woche">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {people.length === 0 ? (
        <p className="text-sm text-muted-foreground/60 py-2">
          Noch niemand zugeteilt. In Einstellungen → Rollen die Berechtigung „Anwesenheitskalender“ vergeben.
        </p>
      ) : (
        <div className="overflow-auto max-h-[46vh]">
          <table className="w-full text-sm border-separate border-spacing-0 min-w-[640px]">
            <thead>
              <tr>
                <th className="text-left font-medium text-muted-foreground px-2 py-1 sticky left-0 top-0 z-20 bg-card">
                  Person
                </th>
                {days.map((d) => {
                  const today = d.iso === todayIso;
                  return (
                    <th
                      key={d.iso}
                      className={cn("px-1 py-1 text-center font-medium w-24 sticky top-0 z-10 bg-card", today && "bg-accent/[0.07]")}
                    >
                      <span className={cn("inline-flex flex-col items-center leading-tight px-2 py-0.5 rounded-md", today && "bg-accent text-white shadow-sm")}>
                        <span>{DAYS[d.weekday]}</span>
                        <span className={cn("text-[11px] font-normal tabular-nums", today ? "text-white/90" : "text-muted-foreground")}>
                          {d.dayLabel}
                        </span>
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id} className="border-t">
                  <td className="px-2 py-1 font-medium truncate max-w-[140px] border-t sticky left-0 bg-card">
                    {p.full_name ?? "—"}
                    {p.id === uid && <span className="text-[10px] text-muted-foreground"> (du)</span>}
                  </td>
                  {days.map((d) => {
                    const date = d.iso;
                    const e = entryOf(p.id, date);
                    const mine = p.id === uid;
                    const isEditing = mine && edit?.date === date;
                    const today = date === todayIso;
                    return (
                      <td key={date} className={cn("px-1 py-0.5 text-center border-t align-middle", today && "bg-accent/[0.06]")}>
                        {isEditing ? (
                          <div className="flex flex-col items-center gap-1">
                            <div className="flex items-center gap-1">
                              <input
                                type="time"
                                step={900}
                                value={edit!.from}
                                onChange={(ev) => setEdit({ ...edit!, from: ev.target.value })}
                                className="h-6 w-[4.2rem] text-[11px] rounded border bg-background px-1"
                              />
                              <span className="text-[10px] text-muted-foreground">–</span>
                              <input
                                type="time"
                                step={900}
                                value={edit!.to}
                                onChange={(ev) => setEdit({ ...edit!, to: ev.target.value })}
                                className="h-6 w-[4.2rem] text-[11px] rounded border bg-background px-1"
                              />
                            </div>
                            <div className="flex items-center gap-1">
                              <button onClick={save} className="icon-btn icon-btn-green !h-6 !w-6" data-tooltip="Speichern" aria-label="Speichern">
                                <Check className="h-3.5 w-3.5" />
                              </button>
                              {e && (
                                <button onClick={() => clear(date)} className="icon-btn icon-btn-red !h-6 !w-6" data-tooltip="Entfernen" aria-label="Entfernen">
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              )}
                              <button onClick={() => setEdit(null)} className="icon-btn !h-6 !w-6" data-tooltip="Abbrechen" aria-label="Abbrechen">
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </div>
                        ) : e ? (
                          <button
                            disabled={!mine}
                            onClick={() => mine && setEdit({ date, from: snapTo15(hm(e.from_time)), to: snapTo15(hm(e.to_time)) })}
                            className={cn(
                              "inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium tabular-nums bg-green-500/15 text-green-700 dark:text-green-300",
                              mine && "hover:bg-green-500/25 transition-colors cursor-pointer",
                            )}
                          >
                            <Check className="h-3 w-3" /> {hm(e.from_time)}–{hm(e.to_time)}
                          </button>
                        ) : mine ? (
                          <button
                            onClick={() => setEdit({ date, from: "09:00", to: "17:00" })}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-muted-foreground border border-dashed border-border hover:border-accent hover:text-accent transition-colors"
                          >
                            <Plus className="h-3 w-3" /> Da
                          </button>
                        ) : (
                          <span className="text-muted-foreground/30">–</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
