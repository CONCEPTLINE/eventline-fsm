"use client";

/**
 * /projekte/neu — MA legt ein neues Projekt an mit Titel, Beschreibung
 * und Wunsch-Stundenzahl. Status wird auf 'angefragt' gesetzt; erst
 * nach Admin-Genehmigung mit Budget-Stunden darf gestempelt werden.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Input } from "@/components/ui/input";
import { BackButton } from "@/components/ui/back-button";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";

export default function NeuesProjektPage() {
  const router = useRouter();
  const supabase = createClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [proposedHours, setProposedHours] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return toast.error("Titel ist Pflicht");
    const proposed = parseFloat(proposedHours.replace(",", "."));
    if (!Number.isFinite(proposed) || proposed <= 0) {
      return toast.error("Bitte eine positive Stundenzahl angeben");
    }
    if (proposed > 9999) return toast.error("Stundenzahl unrealistisch (max 9999)");

    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { toast.error("Nicht angemeldet"); setSaving(false); return; }
    const { data, error } = await supabase.from("projects").insert({
      title: title.trim(),
      description: description.trim() || null,
      proposed_hours: proposed,
      status: "angefragt",
      created_by: user.id,
      assigned_to: user.id,
    }).select("id").single();
    setSaving(false);
    if (error || !data) {
      toast.error("Antrag konnte nicht erstellt werden: " + (error?.message ?? "?"));
      return;
    }
    toast.success("Antrag gestellt — wartet auf Genehmigung");
    router.push(`/projekte/${data.id}`);
  }

  return (
    <div className="max-w-2xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <BackButton fallbackHref="/projekte" size="sm" />
        <h1 className="text-xl font-semibold">Neues Projekt anfragen</h1>
      </div>

      <form onSubmit={submit} className="rounded-xl border bg-card p-5 space-y-4">
        <p className="text-xs text-muted-foreground">
          Beschreibe kurz das Projekt und wie viele Stunden du dafür einplanst. Nach der Genehmigung durch die Geschäftsleitung
          kannst du deine Zeit auf das Projekt stempeln — bis das Budget aufgebraucht ist.
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
            placeholder="Was wirst du konkret machen? Welche Schritte? Woran bist du dran?"
            rows={5}
            className="w-full px-3 py-2 text-sm rounded-lg border border-border bg-background resize-none focus:outline-none focus:ring-2 focus:ring-ring/40"
          />
        </div>

        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Gewünschtes Stunden-Budget *</p>
          <Input
            type="text"
            inputMode="decimal"
            value={proposedHours}
            onChange={(e) => setProposedHours(e.target.value)}
            placeholder="z.B. 20"
            required
          />
          <p className="text-[10px] text-muted-foreground/70 ml-1">
            Wie viele Stunden brauchst du? Die Geschäftsleitung kann das noch anpassen bevor sie freigibt.
          </p>
        </div>

        <div className="flex gap-3 pt-2">
          <button type="button" onClick={() => router.push("/projekte")} className="kasten kasten-muted flex-1">Abbrechen</button>
          <button type="submit" disabled={saving} className="kasten kasten-red flex-1">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {saving ? "Sendet…" : "Antrag stellen"}
          </button>
        </div>
      </form>
    </div>
  );
}
