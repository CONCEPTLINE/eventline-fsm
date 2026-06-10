"use client";

/**
 * GoalTracker — Vertriebsziel-Cockpit mit vollem Druck-Setup.
 *
 * Vier zusammenhaengende Sektionen in einer Card:
 *  1) PACING:       Tag X / Y, Soll vs Ist, "Du bist Z hinten/vor"
 *  2) HOCHRECHNUNG: Bei aktuellem Tempo erreichst du M von N (Konsequenz)
 *  3) LEADERBOARD:  Einzel-Beitraege aller Sales-People, sortiert
 *  4) HEATMAP:      30-Tage-Grid mit Aktivitaet pro Tag, Streak-Counter
 *
 * Definition "bearbeitet": Lead mit step >= 2 und datum_kontakt
 * innerhalb der Period. Pro-Person via assigned_to.
 *
 * Admin: kann ein Ziel anlegen/aendern via Inline-Form.
 * Nicht-Admin: read-only.
 */

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { Target, Pencil, X, Check, TrendingUp, TrendingDown, Trophy, Flame } from "lucide-react";
import type { VertriebContact } from "@/types";

interface TeamGoal {
  id: string;
  start_date: string;
  end_date: string;
  target_count: number;
}

interface Props {
  contacts: VertriebContact[];
  isAdmin: boolean;
  salesPeople: { id: string; full_name: string }[];
}

export function GoalTracker({ contacts, isAdmin, salesPeople }: Props) {
  const supabase = createClient();
  const [goal, setGoal] = useState<TeamGoal | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ start_date: "", end_date: "", target_count: "" });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("vertrieb_team_goal")
        .select("id, start_date, end_date, target_count")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) setGoal(data as TeamGoal);
      setLoading(false);
    })();
  }, [supabase]);

  // Alle Counter-Berechnungen sammeln
  const stats = useMemo(() => {
    if (!goal) return null;
    const start = parseISO(goal.start_date);
    const end = parseISO(goal.end_date);
    const today = todayLocal();
    const totalDays = daysBetween(start, end) + 1;
    const daysElapsed = clamp(daysBetween(start, today) + 1, 1, totalDays);
    const daysLeft = Math.max(0, totalDays - daysElapsed);
    const isOver = today > end;
    const isFuture = today < start;

    // Pro-Tag-Aktivitaet + Pro-Person-Beitrag
    const perDay = new Map<string, number>();
    const perPerson = new Map<string, number>();
    let totalDone = 0;
    for (const c of contacts) {
      if ((c.step || 1) < 2) continue;
      if (!c.datum_kontakt) continue;
      if (c.datum_kontakt < goal.start_date || c.datum_kontakt > goal.end_date) continue;
      totalDone++;
      perDay.set(c.datum_kontakt, (perDay.get(c.datum_kontakt) ?? 0) + 1);
      if (c.assigned_to) perPerson.set(c.assigned_to, (perPerson.get(c.assigned_to) ?? 0) + 1);
    }
    const unassigned = totalDone - Array.from(perPerson.values()).reduce((a, b) => a + b, 0);

    // Pacing: Soll = anteilig zur verstrichenen Zeit
    const soll = Math.round((daysElapsed / totalDays) * goal.target_count);
    const diff = totalDone - soll; // pos = voraus, neg = hinten

    // Hochrechnung: aktuelle Rate * Gesamtdauer
    const dailyRate = totalDone / daysElapsed;
    const projected = Math.round(dailyRate * totalDays);
    const projectedShortfall = goal.target_count - projected;

    // Today: wie viele heute schon?
    const todayIso = isoOf(today);
    const todayCount = perDay.get(todayIso) ?? 0;

    // Streak: aufeinanderfolgende Tage am Ende mit Aktivitaet
    let streakActive = 0, streakNone = 0;
    let cur = isoOf(today);
    while (cur >= goal.start_date) {
      if ((perDay.get(cur) ?? 0) > 0) streakActive++;
      else break;
      cur = isoOf(addDays(parseISO(cur), -1));
    }
    if (streakActive === 0) {
      // Zaehle Tage seit letzter Aktivitaet
      cur = isoOf(today);
      while (cur >= goal.start_date && (perDay.get(cur) ?? 0) === 0) {
        streakNone++;
        cur = isoOf(addDays(parseISO(cur), -1));
      }
    }

    return {
      totalDays, daysElapsed, daysLeft, isOver, isFuture,
      totalDone, soll, diff, dailyRate, projected, projectedShortfall,
      todayCount, perDay, perPerson, unassigned, streakActive, streakNone,
      startDate: goal.start_date, endDate: goal.end_date,
    };
  }, [contacts, goal]);

  function startEdit() {
    setDraft({
      start_date: goal?.start_date ?? "",
      end_date: goal?.end_date ?? "",
      target_count: goal ? String(goal.target_count) : "",
    });
    setEditing(true);
  }

  async function save() {
    const target = Number(draft.target_count);
    if (!draft.start_date || !draft.end_date || !target || target <= 0) {
      toast.error("Start, Ende und Ziel-Anzahl ausfuellen");
      return;
    }
    if (draft.end_date < draft.start_date) {
      toast.error("Ende muss nach Start liegen");
      return;
    }
    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    const payload = {
      start_date: draft.start_date,
      end_date: draft.end_date,
      target_count: target,
      created_by: user?.id ?? null,
    };
    const res = goal
      ? await supabase.from("vertrieb_team_goal").update(payload).eq("id", goal.id).select("id, start_date, end_date, target_count").single()
      : await supabase.from("vertrieb_team_goal").insert(payload).select("id, start_date, end_date, target_count").single();
    setSaving(false);
    if (res.error || !res.data) { TOAST.supabaseError(res.error, "Ziel konnte nicht gespeichert werden"); return; }
    setGoal(res.data as TeamGoal);
    setEditing(false);
    toast.success("Vertriebsziel gespeichert");
  }

  if (loading) return null;

  if (!goal && !editing) {
    return (
      <Card className="bg-card border-dashed">
        <CardContent className="p-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Target className="h-4 w-4" />
            <span>Noch kein Vertriebsziel definiert</span>
          </div>
          {isAdmin && (
            <button type="button" onClick={startEdit} className="kasten kasten-red text-xs">
              Ziel setzen
            </button>
          )}
        </CardContent>
      </Card>
    );
  }

  if (editing) {
    return (
      <Card className="bg-card border-red-200 dark:border-red-500/30">
        <CardContent className="p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Target className="h-4 w-4 text-red-500" />
              Vertriebsziel definieren
            </div>
            <button type="button" onClick={() => setEditing(false)} className="icon-btn icon-btn-muted" aria-label="Abbrechen">
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_140px_auto] gap-2 items-end">
            <div>
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Von</label>
              <Input type="date" value={draft.start_date} onChange={(e) => setDraft({ ...draft, start_date: e.target.value })} />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Bis</label>
              <Input type="date" value={draft.end_date} onChange={(e) => setDraft({ ...draft, end_date: e.target.value })} />
            </div>
            <div>
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Ziel-Anzahl</label>
              <Input type="number" min={1} value={draft.target_count} onChange={(e) => setDraft({ ...draft, target_count: e.target.value })} placeholder="30" />
            </div>
            <button type="button" onClick={save} disabled={saving} className="kasten kasten-green h-9">
              <Check className="h-3.5 w-3.5" />
              {saving ? "Speichert…" : "Speichern"}
            </button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Zaehlt Leads die in der Periode auf Step ≥ 2 (kontaktiert) sind.
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!goal || !stats) return null;
  const behind = stats.diff < 0;
  const ahead = stats.diff > 0;
  const onTrack = stats.diff === 0;
  const accent = behind ? "red" : ahead ? "green" : "muted";

  return (
    <Card className={`bg-card ${behind ? "border-red-300 dark:border-red-500/40" : ahead ? "border-green-300 dark:border-green-500/40" : ""}`}>
      <CardContent className="p-2.5 space-y-2">
        {/* HEADER: nur Title, Periode, Status, Edit (kein Tag/Heute/Rest mehr — diese
            gehoeren thematisch in die ZEIT-Spalte unten). */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 text-xs">
            <Target className="h-3.5 w-3.5 text-red-500" />
            <span className="font-semibold">Vertriebsziel</span>
            <span className="text-muted-foreground">{fmtDate(stats.startDate)} – {fmtDate(stats.endDate)}</span>
            {stats.isOver && <span className="px-1 py-0 text-[9px] uppercase rounded bg-gray-500/20 text-gray-600 dark:text-gray-400">Beendet</span>}
            {stats.isFuture && <span className="px-1 py-0 text-[9px] uppercase rounded bg-blue-500/20 text-blue-600 dark:text-blue-400">Startet bald</span>}
          </div>
          <div className="flex items-center gap-2">
            {stats.streakActive > 1 && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0 text-[10px] font-bold rounded-full bg-orange-500/20 text-orange-600 dark:text-orange-400">
                <Flame className="h-2.5 w-2.5" />{stats.streakActive}d
              </span>
            )}
            {stats.streakNone >= 2 && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0 text-[10px] font-bold rounded-full bg-red-500/20 text-red-600 dark:text-red-400">
                {stats.streakNone}d ohne
              </span>
            )}
            {isAdmin && (
              <button type="button" onClick={startEdit} className="icon-btn icon-btn-muted" aria-label="Ziel bearbeiten" data-tooltip="Ziel bearbeiten">
                <Pencil className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>

        {/* TOP-LEVEL 2/3 + 1/3 Split: links die 3 Status-Bloecke, rechts die Rangliste */}
        <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-3 pt-1">
        {/* === LINKS 2/3: STAND | PROGNOSE | ZEIT === */}
        <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr_1fr] gap-3">
          {/* === STAND === */}
          <ThemeBlock title="Stand">
            <div className="flex items-baseline gap-1.5">
              <span className={`text-2xl font-bold tabular-nums leading-none ${behind ? "text-red-600 dark:text-red-400" : ahead ? "text-green-600 dark:text-green-400" : ""}`}>
                {stats.totalDone}
              </span>
              <span className="text-xs text-muted-foreground">/ {goal.target_count}</span>
              <span className="text-xs text-muted-foreground">·</span>
              <span className="text-xs text-muted-foreground">Soll <strong className="text-foreground tabular-nums">{stats.soll}</strong></span>
              <span className={`text-xs font-bold ml-auto ${behind ? "text-red-600 dark:text-red-400" : ahead ? "text-green-600 dark:text-green-400" : "text-muted-foreground"}`}>
                {behind && <>{Math.abs(stats.diff)} hinten</>}
                {ahead && <>+{stats.diff} voraus</>}
                {onTrack && <>auf Plan</>}
              </span>
            </div>
            <div className="relative h-2 rounded-full bg-foreground/[0.08] dark:bg-foreground/[0.12] overflow-hidden">
              <div
                className={`h-full transition-all ${behind ? "bg-red-500" : "bg-green-500"}`}
                style={{ width: `${Math.min(100, (stats.totalDone / goal.target_count) * 100)}%` }}
              />
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-foreground/70"
                style={{ left: `${Math.min(100, (stats.soll / goal.target_count) * 100)}%` }}
                data-tooltip={`Soll heute: ${stats.soll}`}
              />
            </div>
          </ThemeBlock>

          {/* === PROGNOSE === */}
          <ThemeBlock title="Prognose">
            <div className="flex items-baseline gap-1.5">
              <span className={`text-2xl font-bold tabular-nums leading-none ${stats.projected >= goal.target_count ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                {stats.projected}
              </span>
              <span className="text-xs text-muted-foreground">/ {goal.target_count}</span>
            </div>
            <div className="flex items-center gap-1 text-[10px]">
              {stats.projected >= goal.target_count
                ? <TrendingUp className="h-2.5 w-2.5 text-green-600 dark:text-green-400" />
                : <TrendingDown className="h-2.5 w-2.5 text-red-600 dark:text-red-400" />}
              <span className={stats.projectedShortfall > 0 ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}>
                {stats.projectedShortfall > 0
                  ? `Verfehlt um ${stats.projectedShortfall}`
                  : `+${Math.abs(stats.projectedShortfall)} ueber Ziel`}
              </span>
              <span className="text-muted-foreground ml-auto tabular-nums">{stats.dailyRate.toFixed(1)}/Tag</span>
            </div>
          </ThemeBlock>

          {/* === ZEIT === */}
          <ThemeBlock title="Zeit">
            <div className="flex items-baseline gap-3">
              <div className="flex items-baseline gap-1">
                <span className="text-2xl font-bold tabular-nums leading-none">{stats.daysElapsed}</span>
                <span className="text-xs text-muted-foreground">/{stats.totalDays}</span>
              </div>
              <span className="text-[10px] text-muted-foreground uppercase">Tag</span>
            </div>
            <div className="flex items-center justify-between text-[10px]">
              <span className="text-muted-foreground">
                Heute <strong className={`tabular-nums ${stats.todayCount === 0 ? "text-red-600 dark:text-red-400" : "text-foreground"}`}>{stats.todayCount}</strong>
              </span>
              <span className="text-muted-foreground">
                Rest <strong className="text-foreground tabular-nums">{stats.daysLeft}d</strong>
              </span>
            </div>
          </ThemeBlock>
        </div>

        {/* === RECHTS 1/3: RANGLISTE untereinander === */}
        <div className="lg:border-l lg:border-border/60 lg:pl-3">
          <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">Rangliste</p>
        <div className="space-y-0.5">
          {(() => {
            const rows = salesPeople.map((sp) => ({
              id: sp.id,
              name: sp.full_name.split(" ")[0],
              count: stats.perPerson.get(sp.id) ?? 0,
            })).sort((a, b) => b.count - a.count);
            const max = Math.max(1, ...rows.map((r) => r.count));
            // Bar-Style wie TrendChart/Funnel: 2px solid Border in
            // Status-Green-Farbe + transparenter Filler. Verlauf via
            // Intensity = (count/max). Min-Intensity 0.35 damit selbst
            // kleine Counts noch sichtbar gruen sind.
            const items: React.ReactNode[] = rows.map((r, idx) => {
              const ratio = max > 0 ? r.count / max : 0;
              const intensity = r.count > 0 ? 0.35 + ratio * 0.65 : 0;
              const bgAlpha = 0.08 + intensity * 0.20; // 0.08 - 0.28
              const borderAlpha = 0.30 + intensity * 0.70; // 0.30 - 1.00
              return (
                <div key={r.id} className="flex items-center gap-1.5 min-w-0">
                  {idx === 0 && r.count > 0
                    ? <Trophy className="h-3 w-3 text-yellow-500 shrink-0" />
                    : <span className="w-3 text-[9px] text-muted-foreground text-center shrink-0">{idx + 1}</span>}
                  <span className="text-[11px] font-medium truncate shrink-0 w-12">{r.name}</span>
                  <div className="flex-1 h-3 flex items-center">
                    {r.count > 0 && (
                      <div
                        className="h-3 rounded transition-all"
                        style={{
                          width: `${(r.count / max) * 100}%`,
                          minWidth: "8px",
                          backgroundColor: `rgba(0, 168, 107, ${bgAlpha})`,
                          borderColor: `rgba(0, 168, 107, ${borderAlpha})`,
                          borderWidth: "2px",
                          borderStyle: "solid",
                        }}
                      />
                    )}
                  </div>
                  <span className="text-[11px] font-bold tabular-nums shrink-0 w-5 text-right">{r.count}</span>
                </div>
              );
            });
            if (stats.unassigned > 0) {
              items.push(
                <div key="__unassigned" className="flex items-center gap-1.5 min-w-0 opacity-60">
                  <span className="w-3" />
                  <span className="text-[11px] italic truncate shrink-0 w-12">Niemand</span>
                  <div className="flex-1 h-3" />
                  <span className="text-[11px] tabular-nums shrink-0 w-5 text-right">{stats.unassigned}</span>
                </div>
              );
            }
            return items;
          })()}
        </div>
        </div>
        </div>

      </CardContent>
    </Card>
  );
}

// =================================================================
// ThemeBlock — gruppiert thematisch zusammengehoerige Infos mit
// kleinem Sub-Heading. Damit klar wird welche Zahl wozu gehoert.
// =================================================================

function ThemeBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1 min-w-0">
      <p className="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}

// =================================================================
// Date-Helpers
// =================================================================

function parseISO(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d, 12);
}
function isoOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function todayLocal(): Date {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  return d;
}
function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(d.getDate() + n);
  return r;
}
function daysBetween(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
function fmtDate(iso: string): string {
  return parseISO(iso).toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit", year: "numeric" });
}
