"use client";

/**
 * /projekte/neu — Neues Projekt anlegen.
 *
 * Zwei Flows je nach Rolle:
 *   - Admin: Titel + Beschreibung + Budget-Stunden direkt setzen. Projekt
 *     wird sofort auf 'genehmigt' gestellt (approved_by = self), kein
 *     Antragsloop. Optional 'assigned_to' auf einen anderen MA legen.
 *   - Non-Admin (MA): Titel + Beschreibung + Wunsch-Stunden. Wird als
 *     'angefragt' angelegt und wartet auf Admin-Genehmigung.
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { BackButton } from "@/components/ui/back-button";
import { SearchableSelect } from "@/components/searchable-select";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { usePermissions } from "@/lib/use-permissions";

interface ProfileRow { id: string; full_name: string | null }

export default function NeuesProjektPage() {
  const router = useRouter();
  const supabase = createClient();
  const { role } = usePermissions();
  const isAdmin = role === "admin";
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [hoursInput, setHoursInput] = useState("");
  // Zeitraum ist optional — ein Projekt ohne feste Planung bleibt moeglich.
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [assignees, setAssignees] = useState<ProfileRow[]>([]);
  const [assignedTo, setAssignedTo] = useState<string>("");

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
    })();
  }, [supabase, isAdmin]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return toast.error("Titel ist Pflicht");
    const h = parseFloat(hoursInput.replace(",", "."));
    if (!Number.isFinite(h) || h <= 0) {
      return toast.error("Bitte eine positive Stundenzahl angeben");
    }
    if (h > 9999) return toast.error("Stundenzahl unrealistisch (max 9999)");
    // Gleiche Regel wie der DB-Constraint projects_dates_check — hier
    // abgefangen damit der User eine lesbare Meldung bekommt statt einer
    // Postgres-Constraint-Violation.
    if (startDate && endDate && endDate < startDate) {
      return toast.error("Das Ende liegt vor dem Start");
    }

    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { toast.error("Nicht angemeldet"); setSaving(false); return; }

    const payload: Record<string, unknown> = {
      title: title.trim(),
      description: description.trim() || null,
      created_by: user.id,
      assigned_to: isAdmin && assignedTo ? assignedTo : user.id,
      // DATE-Spalten: der YYYY-MM-DD-String aus dem Input geht direkt
      // rein, kein Timezone-Cast noetig (anders als bei timestamptz).
      start_date: startDate || null,
      end_date: endDate || null,
    };
    if (isAdmin) {
      // Direkt anlegen + genehmigen. Budget = eingegebene Stunden.
      payload.status = "genehmigt";
      payload.budget_hours = h;
      payload.proposed_hours = h;
      payload.approved_by = user.id;
      payload.approved_at = new Date().toISOString();
    } else {
      payload.status = "angefragt";
      payload.proposed_hours = h;
    }

    const { data, error } = await supabase.from("projects").insert(payload).select("id").single();
    setSaving(false);
    if (error || !data) {
      toast.error("Projekt konnte nicht angelegt werden: " + (error?.message ?? "?"));
      return;
    }
    toast.success(isAdmin ? "Projekt angelegt" : "Antrag gestellt — wartet auf Genehmigung");
    router.push(`/projekte/${data.id}`);
  }

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <BackButton fallbackHref="/projekte" size="sm" />
        <h1 className="text-xl font-semibold">
          {isAdmin ? "Neues Projekt anlegen" : "Neues Projekt anfragen"}
        </h1>
      </div>

      <form onSubmit={submit} className="rounded-xl border bg-card p-5 space-y-4">
        <p className="text-xs text-muted-foreground">
          {isAdmin
            ? "Als Admin wird das Projekt direkt genehmigt und der gewählte Mitarbeiter kann sofort Zeit darauf buchen."
            : "Beschreibe kurz das Projekt und wie viele Stunden du dafür einplanst. Nach der Genehmigung durch die Geschäftsleitung kannst du deine Zeit auf das Projekt stempeln."}
        </p>

        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Titel *</p>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="z.B. Akquise Querfeldhalle Tunneldingerfeld"
            required
            autoFocus
          />
        </div>

        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Beschreibung</p>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Was wird konkret gemacht? Welche Schritte?"
            rows={5}
            className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>

        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Zeitraum</p>
          <div className="grid grid-cols-2 gap-3">
            <Input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              aria-label="Startdatum"
            />
            <Input
              type="date"
              value={endDate}
              // min verhindert im Picker schon die ungueltige Auswahl; die
              // Pruefung in submit() bleibt als Fallback fuer Tastatur-Eingabe.
              min={startDate || undefined}
              onChange={(e) => setEndDate(e.target.value)}
              aria-label="Enddatum"
            />
          </div>
          <p className="text-[10px] text-muted-foreground/70 ml-1">
            Optional. Ohne Enddatum läuft das Projekt offen weiter.
          </p>
        </div>

        {isAdmin && (
          <div className="space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Zugewiesen an *</p>
            <SearchableSelect
              value={assignedTo}
              onChange={(v) => setAssignedTo(v ?? "")}
              items={assignees.map((a) => ({ id: a.id, label: a.full_name ?? "—" }))}
              placeholder="Mitarbeiter wählen"
              searchable
            />
            <p className="text-[10px] text-muted-foreground/70 ml-1">Wer soll die Zeit buchen dürfen?</p>
          </div>
        )}

        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {isAdmin ? "Budget in Stunden *" : "Gewünschtes Stunden-Budget *"}
          </p>
          <Input
            type="text"
            inputMode="decimal"
            value={hoursInput}
            onChange={(e) => setHoursInput(e.target.value)}
            placeholder="z.B. 20"
            required
          />
          <p className="text-[10px] text-muted-foreground/70 ml-1">
            {isAdmin
              ? "Wieviele Stunden darf für dieses Projekt gebucht werden?"
              : "Wieviele Stunden brauchst du? Die Geschäftsleitung kann das anpassen bevor sie freigibt."}
          </p>
        </div>

        <div className="flex gap-3 pt-2">
          <button type="button" onClick={() => router.push("/projekte")} className="kasten kasten-muted flex-1">Abbrechen</button>
          <button type="submit" disabled={saving} className="kasten kasten-red flex-1">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {saving ? "Speichert…" : isAdmin ? "Anlegen" : "Antrag stellen"}
          </button>
        </div>
      </form>
    </div>
  );
}
