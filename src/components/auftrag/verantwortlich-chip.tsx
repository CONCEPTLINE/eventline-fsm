"use client";

// Verantwortlich-Chip im Auftrags-Kopf (Leo 2026-10-02): Avatar + Name
// der hauptverantwortlichen Person; wer bearbeiten darf, wechselt per
// Klick direkt hier. Fehlt die Person (Alt-Auftraege vor der Pflicht),
// zeigt der Chip das amber an — ein Klick, und es ist nachgeholt.

import { useEffect, useRef, useState } from "react";
import { UserX, Loader2, Check } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { PORTAL_ROLLEN_IN } from "@/lib/roles";
import { PersonAvatar } from "@/components/ui/person-avatar";

type Ma = { id: string; full_name: string };

export function VerantwortlichChip({
  jobId,
  leadId,
  leadName,
  canEdit,
  onChanged,
}: {
  jobId: string;
  leadId: string | null;
  leadName: string | null;
  canEdit: boolean;
  onChanged?: () => void | Promise<void>;
}) {
  const [offen, setOffen] = useState(false);
  const [liste, setListe] = useState<Ma[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!offen) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOffen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOffen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [offen]);

  async function oeffnen() {
    if (!canEdit) return;
    setOffen((o) => !o);
    if (liste) return;
    const { data, error } = await createClient()
      .from("profiles")
      .select("id, full_name")
      .eq("is_active", true)
      .not("role", "in", PORTAL_ROLLEN_IN)
      .order("full_name");
    if (error) {
      toast.error("Mitarbeiter konnten nicht geladen werden");
      return;
    }
    setListe(((data ?? []) as Ma[]).filter((m) => m.full_name));
  }

  async function setzen(id: string) {
    if (busy || id === leadId) { setOffen(false); return; }
    setBusy(true);
    const { error } = await createClient().from("jobs").update({ project_lead_id: id }).eq("id", jobId);
    setBusy(false);
    setOffen(false);
    if (error) {
      toast.error("Verantwortlich konnte nicht gesetzt werden: " + error.message);
      return;
    }
    toast.success("Verantwortliche Person gesetzt");
    await onChanged?.();
  }

  return (
    <div ref={boxRef} className="relative inline-flex">
      {leadId && leadName ? (
        <button
          type="button"
          onClick={oeffnen}
          disabled={!canEdit}
          className="inline-flex items-center gap-1.5 min-w-0 disabled:cursor-default"
          data-tooltip={canEdit ? "Verantwortlich — klicken zum Ändern" : "Verantwortlich"}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <PersonAvatar name={leadName} size="sm" tooltip="" />}
          <span className="truncate">{leadName}</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={oeffnen}
          disabled={!canEdit}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-medium bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300 disabled:cursor-default"
          data-tooltip={canEdit ? "Jeder Auftrag braucht eine verantwortliche Person — klicken zum Festlegen" : "Keine verantwortliche Person"}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <UserX className="h-3 w-3" />}
          Verantwortlich fehlt
        </button>
      )}
      {offen && (
        <div className="absolute z-30 left-0 top-full mt-1 w-64 max-h-72 overflow-y-auto rounded-lg border border-border bg-card shadow-lg py-1">
          {!liste ? (
            <div className="px-3 py-2 text-xs text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Lädt…
            </div>
          ) : (
            liste.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setzen(m.id)}
                onMouseEnter={() => setHoverId(m.id)}
                onMouseLeave={() => setHoverId((h) => (h === m.id ? null : h))}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground ${hoverId === m.id ? "bg-muted" : ""}`}
              >
                <PersonAvatar name={m.full_name} size="sm" tooltip="" />
                <span className="flex-1 truncate">{m.full_name}</span>
                {m.id === leadId && <Check className="h-3.5 w-3.5 text-muted-foreground" />}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
