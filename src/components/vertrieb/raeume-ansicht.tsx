"use client";

/**
 * Vertrieb › Räume — die Raeume, die wir als Naechstes anschreiben.
 * (Bis 29.10.2026 die ganze Seite /vertrieb, jetzt der erste Tab.)
 *
 * Bewusst einfach (Leo, 2026-10-28): eine kurze Liste, meist rund fuenf
 * Raeume. Je Raum Kontakt, Infos, PDF-Anhaenge, die Erstmail als Entwurf
 * und ein Datum mit Aufgabe — das Datum erscheint im Kalender, damit
 * niemand vergisst, was als Naechstes ansteht. Kein Projekt noetig.
 *
 * Links die Liste (naechster Schritt zuerst), rechts das Detail.
 * Gewaehlter Raum in der URL (?id=), damit Reload und Kalender-Link
 * direkt dort landen (§10).
 */

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Building2, Loader2, Plus } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { usePrompt } from "@/components/ui/use-prompt";
import { usePermissions } from "@/lib/use-permissions";
import { RaumDetail } from "@/components/vertrieb/raum-detail";
import { datumKurz, faelligkeit } from "@/lib/vertrieb-datum";
import { deleteRow } from "@/lib/db-mutations";
import { TOAST } from "@/lib/messages";
import type { VertriebRaum } from "@/types/vertrieb";

const SPALTEN = "id, name, ort, ansprechperson, email, telefon, website, infos, erstmail, datum, aufgabe, dokumente, created_at, updated_at";

const FAELLIG_STIL = {
  ueberfaellig: "text-red-700 dark:text-red-300",
  heute: "text-amber-700 dark:text-amber-300",
  spaeter: "text-indigo-700 dark:text-indigo-300",
  keins: "text-muted-foreground",
} as const;

export function RaeumeAnsicht() {
  const supabase = createClient();
  const searchParams = useSearchParams();
  const { can } = usePermissions();
  const { prompt, PromptModalElement } = usePrompt();

  const [raeume, setRaeume] = useState<VertriebRaum[]>([]);
  const [laden, setLaden] = useState(true);
  const [erstellt, setErstellt] = useState(false);
  const [gewaehlt, setGewaehlt] = useState<string | null>(searchParams.get("id"));

  useEffect(() => {
    let aktiv = true;
    void supabase
      .from("vertrieb_raeume")
      .select(SPALTEN)
      // Was als Naechstes ansteht zuerst, Raeume ohne Datum ans Ende.
      .order("datum", { ascending: true, nullsFirst: false })
      .order("name")
      .then(({ data, error }) => {
        if (!aktiv) return;
        if (error) toast.error(`Laden fehlgeschlagen: ${error.message}`);
        else setRaeume((data ?? []) as VertriebRaum[]);
        setLaden(false);
      });
    return () => { aktiv = false; };
  }, [supabase]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (gewaehlt) url.searchParams.set("id", gewaehlt);
    else url.searchParams.delete("id");
    window.history.replaceState({}, "", url.toString());
  }, [gewaehlt]);

  async function raumAnlegen() {
    const name = await prompt({
      title: "Neuer Raum",
      label: "Name des Raums",
      placeholder: "z. B. Volkshaus Basel",
      confirmLabel: "Anlegen",
      variant: "blue",
      maxLength: 120,
    });
    if (!name?.trim()) return;
    setErstellt(true);
    const { data, error } = await supabase
      .from("vertrieb_raeume").insert({ name: name.trim() }).select(SPALTEN).single();
    setErstellt(false);
    if (error || !data) { TOAST.createError(error?.message); return; }
    setRaeume((prev) => [...prev, data as VertriebRaum]);
    setGewaehlt((data as VertriebRaum).id);
  }

  const raumAendern = useCallback(async (id: string, patch: Partial<VertriebRaum>) => {
    const { error } = await supabase.from("vertrieb_raeume").update(patch).eq("id", id);
    if (error) { TOAST.supabaseError(error, "Speichern fehlgeschlagen"); return false; }
    setRaeume((prev) => {
      const neu = prev.map((r) => (r.id === id ? { ...r, ...patch } : r));
      // Datum geaendert → Reihenfolge der Liste nachziehen.
      if ("datum" in patch) {
        neu.sort((a, b) => (a.datum ?? "9999").localeCompare(b.datum ?? "9999") || a.name.localeCompare(b.name));
      }
      return neu;
    });
    return true;
  }, [supabase]);

  async function raumLoeschen(raum: VertriebRaum) {
    // Erst die Dateien, dann die Zeile — sonst bleiben verwaiste PDFs im Bucket.
    if (raum.dokumente.length) {
      const { error } = await supabase.storage.from("documents").remove(raum.dokumente.map((d) => d.path));
      if (error) { TOAST.supabaseError(error, "Anhänge konnten nicht gelöscht werden"); return; }
    }
    const res = await deleteRow("vertrieb_raeume", raum.id);
    if (!res.ok) { TOAST.deleteError(res.error); return; }
    setRaeume((prev) => prev.filter((r) => r.id !== raum.id));
    setGewaehlt(null);
    toast.success("Raum gelöscht");
  }

  const detail = raeume.find((r) => r.id === gewaehlt) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">Räume, die wir als Nächstes anschreiben</p>
        {can("vertrieb:create") && (
          <button type="button" onClick={() => void raumAnlegen()} disabled={erstellt} className="kasten kasten-blue">
            {erstellt ? <><Loader2 className="h-4 w-4 animate-spin" />Wird angelegt…</> : <><Plus className="h-4 w-4" />Neuer Raum</>}
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1 gap-3">
        {/* Liste */}
        <div className="flex w-full max-w-sm shrink-0 flex-col overflow-hidden rounded-lg border border-border bg-card">
          {laden ? (
            <div className="space-y-1 p-1">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12" />)}
            </div>
          ) : raeume.length === 0 ? (
            <EmptyState icon={Building2} title="Noch keine Räume"
                        description="Lege den ersten Raum an, den ihr anschreiben wollt." />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto p-1">
              {raeume.map((r) => {
                const f = faelligkeit(r.datum);
                const aktiv = r.id === gewaehlt;
                return (
                  <button key={r.id} type="button" onClick={() => setGewaehlt(r.id)}
                          className={`row-hover block w-full rounded-md px-2.5 py-2 text-left [--row-hover-x:0.125rem] ${aktiv ? "bg-foreground/[0.06] dark:bg-foreground/[0.12]" : ""}`}>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-semibold">{r.name}</span>
                      {r.datum && (
                        <span className={`shrink-0 text-xs font-medium ${FAELLIG_STIL[f]}`}>
                          {f === "heute" ? "Heute" : datumKurz(r.datum)}
                        </span>
                      )}
                    </div>
                    <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
                      <span className="truncate">{r.ort ?? "—"}</span>
                      {r.aufgabe && <span className={`truncate ${FAELLIG_STIL[f]}`}>{r.aufgabe}</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          {raeume.length > 0 && (
            <div className="shrink-0 border-t border-border px-2.5 py-1.5 text-[12px] text-muted-foreground">
              {raeume.length} {raeume.length === 1 ? "Raum" : "Räume"}
            </div>
          )}
        </div>

        {/* Detail */}
        <div className="min-w-0 flex-1">
          {detail ? (
            <RaumDetail
              key={detail.id}
              raum={detail}
              onAendern={(patch) => raumAendern(detail.id, patch)}
              onLoeschen={can("vertrieb:delete") ? () => raumLoeschen(detail) : null}
              darfBearbeiten={can("vertrieb:edit")}
              onSchliessen={() => setGewaehlt(null)}
            />
          ) : (
            <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border">
              <p className="text-sm text-muted-foreground">
                {raeume.length ? "Raum links auswählen" : "Noch nichts ausgewählt"}
              </p>
            </div>
          )}
        </div>
      </div>
      {PromptModalElement}
    </div>
  );
}
