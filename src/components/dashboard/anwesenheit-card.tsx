"use client";

/**
 * Bereich «Anwesenheit» (Dashboard).
 *
 * Port aus conceptline-fsm (src/components/dashboard/anwesenheit-card.tsx),
 * 2026-10-02 ins feste Dashboard uebernommen. Sichtbar fuer alle mit
 * Permission `anwesenheit:view` (per Rolle) sowie Admins.
 *
 * Raster: Zeilen = die berechtigten Personen, Spalten = HEUTE + 6 Tage voraus
 * (heute immer ganz links, rollend; Wochen-Pfeile verschieben das Fenster).
 * Jede Person traegt in ihrer eigenen Zeile ein, ob und von wann bis wann sie
 * da ist — Klick auf «+» bzw. die eigene Zeit oeffnet die Eingabe unter dem
 * Raster (das Raster selbst bleibt dabei ruhig stehen). Andere Zeilen sind
 * read-only.
 *
 * Datenmodell (Tabelle `office_attendance`, from_time/to_time seit
 * Migration 204):
 *   (user_id uuid, date date, from_time time, to_time time,
 *    start_hour smallint [legacy], end_hour smallint [legacy])
 *   Existenz einer Row = anwesend. Neue Rows schreiben BEIDES (from/to +
 *   start/end_hour), damit aelterer Lese-Code weiter funktioniert.
 *
 * Berechtigte User via RPC `get_anwesenheit_users()` (SECURITY DEFINER —
 * profiles-RLS erlaubt normalen Usern kein select auf andere Rows),
 * genehmigte Abwesenheiten via `get_anwesenheit_abwesenheiten` (Migration
 * 262). Krankheit u. ae. erscheint bewusst nur als «Abwesend».
 */

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Calendar, Check, ChevronLeft, ChevronRight, Loader2, Plus, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import { plusTage, todayLocalIso, weekdayForDateIso } from "@/lib/swiss-time";
import { Skeleton } from "@/components/ui/skeleton";
import { Karte } from "@/components/dashboard/karte";

type Person = { id: string; full_name: string | null };
type Entry = { user_id: string; date: string; from_time: string; to_time: string };
type Abwesenheit = { user_id: string; start_date: string; end_date: string; type: string };
type Day = { iso: string; weekday: number; dayLabel: string };
type Edit = { date: string; from: string; to: string };

const DAYS = ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"];
// Anzeige-Label je Abwesenheits-Typ — alles andere (z. B. krank) erscheint
// fuer die Kolleginnen und Kollegen nur als «Abwesend».
const ABWESENHEIT_LABEL: Record<string, string> = { ferien: "Ferien", militaer: "Militär" };
// Namensspalte + 7 Tage. Die Mindestbreiten (96 + 7 × 50 = 446 px) passen
// in die linke Dashboard-Spalte auch auf 1280er-Laptops ohne Querscrollen
// (kein Mini-Scroll); erst auf dem Handy scrollt das Raster in der Karte.
// Freier Platz geht zuerst an die Namen (bis 132 px), dann an die Tage.
const RASTER = "grid grid-cols-[minmax(96px,132px)_repeat(7,minmax(50px,1fr))]";

function buildDay(iso: string): Day {
  const [, m, d] = iso.split("-").map(Number);
  // weekdayForDateIso: 0=So..6=Sa. Wir wollen 0=Mo..6=So fuer DAYS[].
  const weekday = (weekdayForDateIso(iso) + 6) % 7;
  return { iso, weekday, dayLabel: `${String(d).padStart(2, "0")}.${String(m).padStart(2, "0")}` };
}

function hm(t: string | null | undefined) {
  return (t ?? "").slice(0, 5);
}

// Nur 15-Min-Schritte im UI. `step="900"` am <input type="time"> erzwingt das
// im Browser-Picker, getippte Werte kommen aber minutengenau durch — deshalb
// defensiv beim Speichern / Oeffnen runden. Clampt 24:00 auf 23:45.
function snapTo15(hhmm: string): string {
  if (!/^\d{2}:\d{2}$/.test(hhmm)) return hhmm;
  const h = Number(hhmm.slice(0, 2));
  const m = Number(hhmm.slice(3, 5));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const snapped = Math.min(23 * 60 + 45, Math.max(0, Math.round((h * 60 + m) / 15) * 15));
  return `${String(Math.floor(snapped / 60)).padStart(2, "0")}:${String(snapped % 60).padStart(2, "0")}`;
}

export function AnwesenheitskalenderCard() {
  const supabase = useMemo(() => createClient(), []);
  const [uid, setUid] = useState<string | null>(null);
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [abwesenheiten, setAbwesenheiten] = useState<Abwesenheit[]>([]);
  const [week, setWeek] = useState(0);
  const [reload, setReload] = useState(0);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [busy, setBusy] = useState<"save" | "delete" | null>(null);

  const days = useMemo(() => {
    const startIso = plusTage(todayLocalIso(), week * 7);
    return Array.from({ length: 7 }, (_, i) => buildDay(plusTage(startIso, i)));
  }, [week]);
  const weekStart = days[0].iso;
  const weekEnd = days[6].iso;

  // Auth-User + Berechtigten-Liste PARALLEL laden. getUser bleibt bewusst
  // (statt profile.id): unter Dev-Mode-Impersonation waere profile.id !=
  // auth.uid(), und der Upsert muss mit der ECHTEN Auth-uid laufen (RLS).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [userRes, rpcRes] = await Promise.all([supabase.auth.getUser(), supabase.rpc("get_anwesenheit_users")]);
      if (cancelled) return;
      const userId = userRes.data.user?.id ?? null;
      setUid(userId);
      if (rpcRes.error) {
        // Nie stiller Fehlschlag (CLAUDE.md §7).
        console.error("get_anwesenheit_users failed", rpcRes.error);
        toast.error(`Anwesenheit konnte nicht geladen werden: ${rpcRes.error.message}`);
        setAllowed(false);
        return;
      }
      // Array.isArray-Guard: RPC koennte bei Signatur-Aenderung ein Objekt liefern.
      const list = (Array.isArray(rpcRes.data) ? (rpcRes.data as Person[]) : []).map((p) => ({
        id: p.id,
        full_name: p.full_name,
      }));
      setPeople(list);
      setAllowed(list.some((p) => p.id === userId));
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase]);

  // Eintraege der Woche — parallel zum Auth/RPC-Load, neu bei Wochen-Wechsel
  // und nach Speichern/Entfernen. Die RLS liefert Nicht-Berechtigten leere
  // Rows statt eines Fehlers; gerendert wird ohnehin erst bei allowed.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [attRes, abwRes] = await Promise.all([
        supabase.from("office_attendance").select("user_id, date, from_time, to_time").gte("date", weekStart).lte("date", weekEnd),
        supabase.rpc("get_anwesenheit_abwesenheiten", { p_von: weekStart, p_bis: weekEnd }),
      ]);
      if (cancelled) return;
      if (attRes.error) {
        // Ohne Toast bliebe das Raster still leer («niemand da»).
        toast.error(`Anwesenheit konnte nicht geladen werden: ${attRes.error.message}`);
        setEntries([]);
      } else {
        // Legacy-Rows ohne from/to (vor Migration 204) nicht als 00:00–00:00 zeigen.
        setEntries(((attRes.data as Entry[]) ?? []).filter((e) => e.from_time && e.to_time));
      }
      // Abwesenheits-Fehler nicht fatal — das Raster funktioniert auch ohne.
      if (abwRes.error) console.error("get_anwesenheit_abwesenheiten failed", abwRes.error);
      setAbwesenheiten(Array.isArray(abwRes.data) ? (abwRes.data as Abwesenheit[]) : []);
    })();
    return () => {
      cancelled = true;
    };
  }, [supabase, weekStart, weekEnd, reload]);

  const todayIso = todayLocalIso();
  const entryOf = (userId: string, date: string) => entries.find((e) => e.user_id === userId && e.date === date);
  const abwesendAn = (userId: string, date: string) =>
    abwesenheiten.find((a) => a.user_id === userId && a.start_date <= date && a.end_date >= date);

  async function save() {
    if (!edit || !uid || busy) return;
    // Defensiv aufs 15-Min-Raster (getippte Werte kommen minutengenau).
    const from = snapTo15(edit.from);
    const to = snapTo15(edit.to);
    if (to <= from) return void toast.error("Bis-Zeit muss nach Von-Zeit sein");
    // start_hour/end_hour spiegeln (Read-Kompat, Constraint 0..23 / 1..24).
    const startH = Number(from.slice(0, 2));
    const endH = Math.min(24, Math.max(startH + 1, Math.ceil(Number(to.slice(0, 2)) + Number(to.slice(3, 5)) / 60)));
    setBusy("save");
    const { error } = await supabase
      .from("office_attendance")
      .upsert(
        { user_id: uid, date: edit.date, from_time: from, to_time: to, start_hour: startH, end_hour: endH },
        { onConflict: "user_id,date" },
      );
    setBusy(null);
    if (error) return void toast.error(error.message);
    setEdit(null);
    setReload((r) => r + 1);
  }

  async function clear(date: string) {
    if (!uid || busy) return;
    setBusy("delete");
    const { error } = await supabase.from("office_attendance").delete().eq("user_id", uid).eq("date", date);
    setBusy(null);
    if (error) return void toast.error(error.message);
    setEdit(null);
    setReload((r) => r + 1);
  }

  const wochenNav = (
    <div className="flex items-center gap-1 text-[13px] text-foreground/80">
      <button
        type="button"
        onClick={() => { setEdit(null); setWeek((w) => w - 1); }}
        className="icon-btn icon-btn-muted"
        aria-label="Vorherige Woche"
        data-tooltip="Vorherige Woche"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <span className="px-1 tabular-nums">
        {days[0].dayLabel} – {days[6].dayLabel}
      </span>
      <button
        type="button"
        onClick={() => { setEdit(null); setWeek((w) => w + 1); }}
        className="icon-btn icon-btn-muted"
        aria-label="Nächste Woche"
        data-tooltip="Nächste Woche"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );

  // §7: sofortiges Ladefeedback statt leerer Karte, solange Auth/RPC laufen.
  if (allowed === null) {
    return (
      <Karte titel="Anwesenheit" icon={Calendar} rechts={wochenNav}>
        <Skeleton className="h-40 w-full" />
      </Karte>
    );
  }
  // Server-seitig sollte der Bereich ohne Recht gar nicht erscheinen. Landet
  // er trotzdem hier (z. B. Dev-Mode-Impersonation), eine kurze Notiz statt
  // eines leeren Kastens.
  if (!allowed) {
    return (
      <Karte titel="Anwesenheit" icon={Calendar}>
        <p className="text-sm text-muted-foreground">Die Anwesenheit ist für dich nicht freigeschaltet.</p>
      </Karte>
    );
  }

  const editDay = edit ? days.find((d) => d.iso === edit.date) : undefined;

  return (
    <Karte titel="Anwesenheit" icon={Calendar} rechts={wochenNav}>
      {people.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Noch niemand zugeteilt. In Einstellungen → Rollen die Berechtigung «Anwesenheitskalender» vergeben.
        </p>
      ) : (
        <div className="max-h-[46vh] overflow-auto">
          <div className="min-w-[446px]">
            <div className={cn(RASTER, "sticky top-0 z-10 items-center border-b bg-card pb-2")}>
              <span className="text-xs text-muted-foreground">Person</span>
              {days.map((d) => {
                const heute = d.iso === todayIso;
                return (
                  <span
                    key={d.iso}
                    className={cn(
                      "flex flex-col items-center gap-px justify-self-center rounded-lg px-2.5 py-1",
                      heute && "bg-accent shadow-sm",
                    )}
                  >
                    <b className={cn("text-[13px] font-semibold", heute ? "text-white" : "text-foreground/80")}>{DAYS[d.weekday]}</b>
                    <span className={cn("text-[11px] tabular-nums", heute ? "text-white/85" : "text-muted-foreground")}>{d.dayLabel}</span>
                  </span>
                );
              })}
            </div>
            <div className="flex flex-col divide-y">
              {people.map((p) => {
                const mine = p.id === uid;
                return (
                  <div key={p.id} className={cn(RASTER, "items-stretch")}>
                    <span className="flex min-w-0 items-center gap-1.5 py-2.5 pr-2 text-sm">
                      <span className="truncate" data-tooltip={p.full_name ?? undefined}>{p.full_name ?? "—"}</span>
                      {mine && <span className="shrink-0 text-[11px] text-muted-foreground">(du)</span>}
                    </span>
                    {days.map((d) => {
                      const e = entryOf(p.id, d.iso);
                      const abw = e ? undefined : abwesendAn(p.id, d.iso);
                      const gewaehlt = mine && edit?.date === d.iso;
                      return (
                        <span
                          key={d.iso}
                          className={cn(
                            "flex items-center justify-center px-0.5 py-2",
                            d.iso === todayIso && "bg-accent/[0.04] dark:bg-accent/[0.09]",
                          )}
                        >
                          {e ? (
                            <Chip
                              ton="gruen"
                              gewaehlt={gewaehlt}
                              onClick={mine ? () => setEdit({ date: d.iso, from: snapTo15(hm(e.from_time)), to: snapTo15(hm(e.to_time)) }) : undefined}
                              tooltip={mine ? "Zeit ändern" : undefined}
                            >
                              <span className="flex flex-col items-center leading-tight">
                                <span>{hm(e.from_time)}</span>
                                <span>{hm(e.to_time)}</span>
                              </span>
                            </Chip>
                          ) : abw ? (
                            // Genehmigte Abwesenheit; in der eigenen Zeile
                            // trotzdem als anwesend eintragbar. Tooltip traegt
                            // das volle Label, falls die Spalte es kuerzt.
                            <Chip
                              ton="amber"
                              gewaehlt={gewaehlt}
                              onClick={mine ? () => setEdit({ date: d.iso, from: "09:00", to: "17:00" }) : undefined}
                              tooltip={
                                mine
                                  ? `${ABWESENHEIT_LABEL[abw.type] ?? "Abwesend"} – trotzdem als anwesend eintragen`
                                  : ABWESENHEIT_LABEL[abw.type] ?? "Abwesend"
                              }
                            >
                              {ABWESENHEIT_LABEL[abw.type] ?? "Abwesend"}
                            </Chip>
                          ) : mine ? (
                            <PlusKnopf gewaehlt={gewaehlt} onClick={() => setEdit({ date: d.iso, from: "09:00", to: "17:00" })} />
                          ) : (
                            <span className="text-muted-foreground/40">–</span>
                          )}
                        </span>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {edit && editDay && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-foreground/[0.04] px-3 py-2.5 dark:bg-foreground/[0.08]">
          <span className="text-sm font-semibold">
            {DAYS[editDay.weekday]} {editDay.dayLabel}.
          </span>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            von
            <input
              type="time"
              step={900}
              value={edit.from}
              onChange={(ev) => setEdit({ ...edit, from: ev.target.value })}
              className="h-8 rounded-md border bg-background px-2 text-sm text-foreground tabular-nums"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            bis
            <input
              type="time"
              step={900}
              value={edit.to}
              onChange={(ev) => setEdit({ ...edit, to: ev.target.value })}
              className="h-8 rounded-md border bg-background px-2 text-sm text-foreground tabular-nums"
            />
          </label>
          <div className="ml-auto flex items-center gap-1.5">
            {uid && entryOf(uid, edit.date) && (
              <button type="button" onClick={() => clear(edit.date)} disabled={busy !== null} className="kasten kasten-red">
                {busy === "delete" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                {busy === "delete" ? "Wird entfernt…" : "Entfernen"}
              </button>
            )}
            <button type="button" onClick={() => setEdit(null)} disabled={busy !== null} className="kasten kasten-muted">
              Abbrechen
            </button>
            <button type="button" onClick={save} disabled={busy !== null} className="kasten kasten-blue">
              {busy === "save" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              {busy === "save" ? "Wird gespeichert…" : "Speichern"}
            </button>
          </div>
        </div>
      )}
    </Karte>
  );
}

const CHIP_TON = {
  gruen: { ruhe: "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300", hover: "bg-emerald-500/25 text-emerald-800 dark:bg-emerald-500/35 dark:text-emerald-200" },
  amber: { ruhe: "bg-amber-500/15 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300", hover: "bg-amber-500/30 text-amber-900 dark:bg-amber-500/35 dark:text-amber-200" },
} as const;

/** Zeit- bzw. Abwesenheits-Chip; in der eigenen Zeile klickbar. */
function Chip({
  ton,
  gewaehlt,
  onClick,
  tooltip,
  children,
}: {
  ton: keyof typeof CHIP_TON;
  gewaehlt: boolean;
  onClick?: () => void;
  tooltip?: string;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const klasse = cn(
    "max-w-full truncate rounded-[7px] px-1.5 py-[3px] text-[11px] font-semibold tabular-nums transition-colors",
    // Hover state-driven (Projekt-Regel) — nur wenn klickbar.
    onClick && hover ? CHIP_TON[ton].hover : CHIP_TON[ton].ruhe,
    gewaehlt && "ring-2 ring-accent",
  );
  if (!onClick) return <span className={klasse} data-tooltip={tooltip}>{children}</span>;
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className={cn(klasse, "cursor-pointer")}
      data-tooltip={tooltip}
      aria-label={tooltip}
    >
      {children}
    </button>
  );
}

/** «+» in der eigenen Zeile: Anwesenheit fuer den Tag eintragen. */
function PlusKnopf({ gewaehlt, onClick }: { gewaehlt: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const aktiv = hover || gewaehlt;
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label="Anwesenheit eintragen"
      data-tooltip="Anwesenheit eintragen"
      className="inline-flex h-[26px] w-[26px] items-center justify-center rounded-[7px] border border-dashed"
      style={{
        borderWidth: 1,
        borderColor: aktiv ? "var(--accent)" : "var(--border)",
        color: aktiv ? "var(--accent)" : "var(--muted-foreground)",
        transition: "border-color 120ms, color 120ms",
      }}
    >
      <Plus className="h-3.5 w-3.5" />
    </button>
  );
}
