"use client";

/**
 * GoalTracker — Team-Vertriebsziel oben in /vertrieb.
 *
 * Zeigt: Period + Target + Progress (Anzahl Leads mit step>=2 deren
 * datum_kontakt in der Period liegt) als Bar.
 *
 * Admin: kann ein Ziel anlegen/aendern via Inline-Form.
 * Nicht-Admin: read-only.
 *
 * Datenmodell: vertrieb_team_goal (siehe Migration 142).
 *  Bei mehreren ueberlappenden Periodien zeigt die UI das zuletzt
 *  aktualisierte (= ORDER BY updated_at DESC LIMIT 1).
 */

import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import { Target, Pencil, X, Check } from "lucide-react";
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
}

export function GoalTracker({ contacts, isAdmin }: Props) {
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

  // Bearbeitete Leads in der Periode: step >= 2 UND datum_kontakt im Range.
  const progress = useMemo(() => {
    if (!goal) return 0;
    return contacts.reduce((n, c) => {
      if ((c.step || 1) < 2) return n;
      if (!c.datum_kontakt) return n;
      if (c.datum_kontakt < goal.start_date) return n;
      if (c.datum_kontakt > goal.end_date) return n;
      return n + 1;
    }, 0);
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

  // Empty-State: kein Ziel definiert.
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

  if (!goal) return null;
  const pct = Math.min(100, Math.round((progress / goal.target_count) * 100));
  const onTrack = pct >= 100;
  const fmt = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(y, m - 1, d, 12).toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit", year: "numeric" });
  };

  return (
    <Card className="bg-card">
      <CardContent className="p-3 space-y-2">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 text-sm">
            <Target className="h-4 w-4 text-red-500" />
            <span className="font-semibold">Vertriebsziel</span>
            <span className="text-muted-foreground">{fmt(goal.start_date)} – {fmt(goal.end_date)}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm tabular-nums">
              <strong className={onTrack ? "text-green-600 dark:text-green-400" : ""}>{progress}</strong>
              <span className="text-muted-foreground"> / {goal.target_count} bearbeitet</span>
            </span>
            {isAdmin && (
              <button type="button" onClick={startEdit} className="icon-btn icon-btn-muted" aria-label="Ziel bearbeiten" data-tooltip="Ziel bearbeiten">
                <Pencil className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
        <div className="h-2 rounded-full bg-foreground/[0.08] dark:bg-foreground/[0.12] overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${onTrack ? "bg-green-500" : "bg-red-500"}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
