"use client";

/**
 * /projekte/neu — Neues Projekt anlegen.
 *
 * Admin: legt direkt an (Status genehmigt).
 * MA:    legt Antrag an (Status angefragt).
 *
 * Query-Params:
 *   ?parent=<uuid>  — Folgeprojekt zu einem abgeschlossenen. Titel/Ziel
 *                     werden vom Vorgänger vorbelegt und parent_project_id
 *                     wird beim Insert gesetzt.
 */

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { BackButton } from "@/components/ui/back-button";
import { SearchableSelect } from "@/components/searchable-select";
import { Loader2, Save, Target, StickyNote } from "lucide-react";
import { toast } from "sonner";
import { usePermissions } from "@/lib/use-permissions";
import { formatProjectNumber } from "@/lib/projekte-format";

interface ProfileRow { id: string; full_name: string | null }
interface ParentInfo { id: string; project_number: number | null; title: string; goal_text: string | null }

function NeuesProjektInner() {
  const router = useRouter();
  const supabase = createClient();
  const search = useSearchParams();
  const parentId = search.get("parent");
  const { role } = usePermissions();
  const isAdmin = role === "admin";

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [goalText, setGoalText] = useState("");
  const [goalDate, setGoalDate] = useState("");
  const [notes, setNotes] = useState("");
  const [hoursInput, setHoursInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [assignees, setAssignees] = useState<ProfileRow[]>([]);
  const [assignedTo, setAssignedTo] = useState<string>("");
  // Zusaetzliche Members (nur Admin): werden direkt beim Erstellen als
  // project_members inserted -> sofort eingeloggt, koennen sofort stempeln.
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [parent, setParent] = useState<ParentInfo | null>(null);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) setAssignedTo(user.id);
      if (isAdmin) {
        const { data } = await supabase
          .from("profiles")
          .select("id, full_name")
          .neq("role", "partner")
          .eq("is_active", true)
          .order("full_name");
        setAssignees((data ?? []) as ProfileRow[]);
      }
      if (parentId) {
        const { data: p } = await supabase
          .from("projects")
          .select("id, project_number, title, goal_text")
          .eq("id", parentId)
          .maybeSingle();
        if (p) {
          setParent(p as ParentInfo);
          if (!title) setTitle(`${p.title} — Folgeprojekt`);
          if (!goalText && p.goal_text) setGoalText(p.goal_text);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [supabase, isAdmin, parentId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return toast.error("Titel ist Pflicht");
    const h = parseFloat(hoursInput.replace(",", "."));
    if (!Number.isFinite(h) || h <= 0) return toast.error("Bitte eine positive Stundenzahl angeben");
    if (h > 9999) return toast.error("Stundenzahl unrealistisch (max 9999)");

    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { toast.error("Nicht angemeldet"); setSaving(false); return; }

    const payload: Record<string, unknown> = {
      title: title.trim(),
      description: description.trim() || null,
      goal_text: goalText.trim() || null,
      goal_date: goalDate || null,
      notes: notes.trim() || null,
      created_by: user.id,
      assigned_to: isAdmin && assignedTo ? assignedTo : user.id,
      parent_project_id: parent?.id ?? null,
    };
    if (isAdmin) {
      payload.status = "genehmigt";
      payload.budget_hours = h;
      payload.proposed_hours = h;
      payload.approved_by = user.id;
      payload.approved_at = new Date().toISOString();
    } else {
      // MA legt als 'entwurf' an — kann anschliessend bearbeiten und dann
      // manuell "Einreichen" druecken (setzt status -> 'angefragt').
      payload.status = "entwurf";
      payload.proposed_hours = h;
    }

    const { data, error } = await supabase.from("projects").insert(payload).select("id").single();
    if (error || !data) {
      setSaving(false);
      toast.error("Projekt konnte nicht angelegt werden: " + (error?.message ?? "?"));
      return;
    }
    // Members automatisch anlegen sobald genehmigt: der Assignee wird
    // IMMER als Member eingeloggt (damit sein Avatar in der Liste erscheint
    // und er sofort stempeln kann), plus alle vom Admin ausgewaehlten.
    if (payload.status === "genehmigt") {
      const memberSet = new Set<string>(memberIds);
      const finalAssignee = (isAdmin && assignedTo ? assignedTo : user.id);
      memberSet.add(finalAssignee);
      const memberRows = Array.from(memberSet).map((uid) => ({ project_id: data.id, user_id: uid }));
      const { error: memErr } = await supabase.from("project_members").insert(memberRows);
      if (memErr) {
        toast.error("Members konnten nicht komplett zugeteilt werden: " + memErr.message);
      }
    }
    setSaving(false);
    toast.success(isAdmin ? "Projekt angelegt" : "Als Entwurf gespeichert — jetzt einreichen zur Genehmigung");
    router.push(`/projekte/${data.id}`);
  }

  function toggleMember(uid: string) {
    setMemberIds((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid); else next.add(uid);
      return next;
    });
  }

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <BackButton fallbackHref="/projekte" size="sm" />
        <h1 className="text-xl font-semibold">
          {parent ? "Folgeprojekt anlegen" : isAdmin ? "Neues Projekt anlegen" : "Neues Projekt anfragen"}
        </h1>
      </div>

      {parent && (
        <div className="rounded-lg border bg-purple-50 dark:bg-purple-500/10 border-purple-200 dark:border-purple-500/30 p-3 text-xs text-purple-900 dark:text-purple-100">
          Folgt auf <strong>{formatProjectNumber(parent.project_number)} · {parent.title}</strong>
        </div>
      )}

      <form onSubmit={submit} className="rounded-xl border bg-card p-5 space-y-4">
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Titel *</p>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="z.B. Akquise Querfeldhalle" required autoFocus />
        </div>

        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Beschreibung</p>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Was wird konkret gemacht? Welche Schritte?" rows={4} className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40" />
        </div>

        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5"><Target className="h-3 w-3" /> Konkretes Ziel</p>
          <textarea value={goalText} onChange={(e) => setGoalText(e.target.value)} placeholder="z.B. 'Vertrag unterschrieben und erstes Event-Datum fix'" rows={2} className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40" />
          <div className="flex items-center gap-2 pt-1">
            <span className="text-[10px] text-muted-foreground/70">Deadline:</span>
            <Input type="date" value={goalDate} onChange={(e) => setGoalDate(e.target.value)} className="h-8 max-w-40" />
          </div>
        </div>

        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5"><StickyNote className="h-3 w-3" /> Notizen</p>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Gedanken, Kontakte, Zwischenstände (kann später jederzeit ergänzt werden)" rows={3} className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40" />
        </div>

        {isAdmin && (
          <>
            <div className="space-y-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Verantwortlich *</p>
              <SearchableSelect
                value={assignedTo}
                onChange={(v) => setAssignedTo(v ?? "")}
                items={assignees.map((a) => ({ id: a.id, label: a.full_name ?? "—" }))}
                placeholder="Mitarbeiter wählen"
                searchable
              />
              <p className="text-[10px] text-muted-foreground/70 ml-1">Wer trägt die Verantwortung? Kann sich selbst als Mitglied unten hinzufügen.</p>
            </div>

            <div className="space-y-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Mitglieder direkt einloggen ({memberIds.size} ausgewählt)
              </p>
              <div className="rounded-lg border border-border max-h-48 overflow-y-auto divide-y divide-border/40">
                {assignees.length === 0 ? (
                  <p className="p-3 text-xs text-muted-foreground italic">Keine Mitarbeiter verfügbar.</p>
                ) : assignees.map((a) => {
                  const checked = memberIds.has(a.id);
                  return (
                    <label
                      key={a.id}
                      className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer text-sm transition-colors ${checked ? "bg-emerald-500/[0.08]" : "hover:bg-muted/40"}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleMember(a.id)}
                        className="h-3.5 w-3.5 accent-emerald-500"
                      />
                      <span className="flex-1">{a.full_name ?? "—"}</span>
                    </label>
                  );
                })}
              </div>
              <p className="text-[10px] text-muted-foreground/70 ml-1">
                Ausgewählte Mitarbeiter sind sofort eingeloggt und können direkt Zeit stempeln. Weitere kannst du später im Detail hinzufügen.
              </p>
            </div>
          </>
        )}

        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {isAdmin ? "Budget in Stunden *" : "Gewünschtes Stunden-Budget *"}
          </p>
          <Input type="text" inputMode="decimal" value={hoursInput} onChange={(e) => setHoursInput(e.target.value)} placeholder="z.B. 20" required />
        </div>

        <div className="flex gap-3 pt-2">
          <button type="button" onClick={() => router.push(parent ? `/projekte/${parent.id}` : "/projekte")} className="kasten kasten-muted flex-1">Abbrechen</button>
          <button type="submit" disabled={saving} className="kasten kasten-red flex-1">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {saving ? "Speichert…" : isAdmin ? "Anlegen" : "Antrag stellen"}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function NeuesProjektPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-muted-foreground">Lädt…</div>}>
      <NeuesProjektInner />
    </Suspense>
  );
}
