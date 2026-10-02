"use client";

// Verantwortlich-Block im Auftrags-Kopf (Leo 2026-10-02): rechts neben
// Titel und Details klar abgehoben — Avatar, Name, "seit …"; Klick auf die
// Person wechselt sie (wer bearbeiten darf), "Verlauf" zeigt jeden Wechsel
// (Migration 286, per Trigger aufgezeichnet). Fehlt die Person bei einem
// aktiven Auftrag, erscheint der Block amber zum Nachholen.

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, History, Loader2, UserX } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { PORTAL_ROLLEN_IN } from "@/lib/roles";
import { PersonAvatar } from "@/components/ui/person-avatar";

type Ma = { id: string; full_name: string };
type Eintrag = {
  id: string;
  person_id: string | null;
  person_name: string | null;
  vorher_name: string | null;
  geaendert_von_name: string | null;
  created_at: string;
};

const ZRH = "Europe/Zurich";
function datum(iso: string): string {
  return new Date(iso).toLocaleDateString("de-CH", { timeZone: ZRH, day: "2-digit", month: "2-digit", year: "numeric" });
}
function datumZeit(iso: string): string {
  return new Date(iso).toLocaleString("de-CH", { timeZone: ZRH, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function VerantwortlichBlock({
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
  const [offen, setOffen] = useState<"auswahl" | "verlauf" | null>(null);
  const [liste, setListe] = useState<Ma[] | null>(null);
  const [verlauf, setVerlauf] = useState<Eintrag[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const verlaufLaden = useCallback(async () => {
    const { data, error } = await createClient()
      .from("job_verantwortlich_verlauf")
      .select("id, person_id, person_name, vorher_name, geaendert_von_name, created_at")
      .eq("job_id", jobId)
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) {
      toast.error("Verlauf konnte nicht geladen werden");
      setVerlauf([]);
      return;
    }
    setVerlauf((data ?? []) as Eintrag[]);
  }, [jobId]);

  // Neu laden, sobald die Person wechselt (auch durch andere Wege, z.B.
  // Bearbeiten-Formular → Reload der Detailseite).
  useEffect(() => {
    void verlaufLaden();
  }, [verlaufLaden, leadId]);

  useEffect(() => {
    if (!offen) return;
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOffen(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOffen(null); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [offen]);

  async function auswahlOeffnen() {
    if (!canEdit) return;
    setOffen((o) => (o === "auswahl" ? null : "auswahl"));
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
    if (busy || id === leadId) { setOffen(null); return; }
    setBusy(true);
    const { error } = await createClient().from("jobs").update({ project_lead_id: id }).eq("id", jobId);
    setBusy(false);
    setOffen(null);
    if (error) {
      toast.error("Verantwortlich konnte nicht gesetzt werden: " + error.message);
      return;
    }
    toast.success("Verantwortliche Person gesetzt");
    await onChanged?.();
    await verlaufLaden();
  }

  const aktuell = verlauf?.[0];
  const seit = aktuell && leadId && aktuell.person_id === leadId ? datum(aktuell.created_at) : null;
  const anzahl = verlauf?.length ?? 0;

  const auswahl = offen === "auswahl" && (
    <div className="absolute z-30 top-full mt-1 left-0 md:left-auto md:right-0 w-72 max-h-80 overflow-y-auto rounded-lg border border-border bg-card shadow-lg py-1">
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
            onMouseEnter={() => setHover(`ma:${m.id}`)}
            onMouseLeave={() => setHover((h) => (h === `ma:${m.id}` ? null : h))}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm text-foreground ${hover === `ma:${m.id}` ? "bg-muted" : ""}`}
          >
            <PersonAvatar name={m.full_name} size="sm" tooltip="" />
            <span className="flex-1 truncate">{m.full_name}</span>
            {m.id === leadId && <Check className="h-3.5 w-3.5 text-muted-foreground" />}
          </button>
        ))
      )}
    </div>
  );

  // Ohne Person (nur bei aktiven Auftraegen gerendert, siehe Kopf).
  if (!leadId || !leadName) {
    return (
      <div ref={boxRef} className="relative w-full md:w-64 shrink-0">
        <div className="rounded-xl border border-amber-300 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10 px-3 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">Verantwortlich</p>
          <button
            type="button"
            onClick={auswahlOeffnen}
            disabled={!canEdit || busy}
            className="mt-1.5 inline-flex items-center gap-2 text-sm font-medium text-amber-800 dark:text-amber-200 disabled:cursor-default"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserX className="h-4 w-4" />}
            {canEdit ? "Person festlegen" : "Noch niemand festgelegt"}
          </button>
        </div>
        {auswahl}
      </div>
    );
  }

  return (
    <div ref={boxRef} className="relative w-full md:w-64 shrink-0">
      <div className="rounded-xl border border-border bg-card px-3 py-2.5 shadow-sm">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Verantwortlich</span>
          <button
            type="button"
            onClick={() => setOffen((o) => (o === "verlauf" ? null : "verlauf"))}
            onMouseEnter={() => setHover("verlauf")}
            onMouseLeave={() => setHover((h) => (h === "verlauf" ? null : h))}
            className={`inline-flex items-center gap-1 text-[11px] rounded px-1 -mr-1 transition-colors ${hover === "verlauf" || offen === "verlauf" ? "text-foreground" : "text-muted-foreground"}`}
            data-tooltip="Wer war wann verantwortlich?"
          >
            <History className="h-3 w-3" />
            Verlauf{anzahl > 0 ? ` · ${anzahl}` : ""}
          </button>
        </div>
        <button
          type="button"
          onClick={auswahlOeffnen}
          disabled={!canEdit || busy}
          onMouseEnter={() => setHover("person")}
          onMouseLeave={() => setHover((h) => (h === "person" ? null : h))}
          className={`mt-1.5 -mx-1.5 w-[calc(100%+0.75rem)] flex items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition-colors disabled:cursor-default ${
            canEdit && (hover === "person" || offen === "auswahl") ? "bg-foreground/[0.05] dark:bg-foreground/[0.10]" : ""
          }`}
          data-tooltip={canEdit ? "Andere Person festlegen" : undefined}
        >
          {busy ? (
            <span className="h-7 w-7 flex items-center justify-center shrink-0"><Loader2 className="h-4 w-4 animate-spin" /></span>
          ) : (
            <PersonAvatar name={leadName} size="md" tooltip="" />
          )}
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold truncate text-foreground">{leadName}</span>
            <span className="block text-[11px] text-muted-foreground">{seit ? `seit ${seit}` : "Hauptverantwortlich"}</span>
          </span>
          {canEdit && <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
        </button>
      </div>

      {auswahl}

      {offen === "verlauf" && (
        <div className="absolute z-30 top-full mt-1 left-0 md:left-auto md:right-0 w-80 max-h-80 overflow-y-auto rounded-lg border border-border bg-card shadow-lg p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Verlauf Verantwortlich</p>
          {!verlauf ? (
            <div className="text-xs text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Lädt…
            </div>
          ) : verlauf.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Noch keine Wechsel erfasst. Zuteilungen vor dem 2.10.2026 wurden nicht aufgezeichnet.
            </p>
          ) : (
            <ol className="space-y-2.5">
              {verlauf.map((e, i) => (
                <li key={e.id} className="flex items-start gap-2.5">
                  <PersonAvatar name={e.person_name ?? "?"} size="sm" tooltip="" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">
                      {e.person_name ?? "—"}
                      {i === 0 && e.person_id === leadId && (
                        <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">aktuell</span>
                      )}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      {datumZeit(e.created_at)}
                      {e.geaendert_von_name ? ` · durch ${e.geaendert_von_name}` : ""}
                    </p>
                    {e.vorher_name && <p className="text-[11px] text-muted-foreground">vorher {e.vorher_name}</p>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}
