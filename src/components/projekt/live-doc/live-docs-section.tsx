"use client";

/**
 * LiveDocsSection — Liste der Live-Dokumente eines Projekts im Tab
 * "Dokumente & Historie" (oberhalb der Datei-Uploads).
 * "+ Live-Dokument" legt eine Zeile an und springt direkt in den Editor.
 * Loeschen: Schreibberechtigte (RLS pdocs_delete), mit useConfirm.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { useConfirm } from "@/components/ui/use-confirm";
import { toast } from "sonner";
import { FileText, Plus, Trash2, Loader2, Users } from "lucide-react";

type LiveDoc = {
  id: string;
  title: string;
  updated_at: string;
  updater?: { full_name: string | null } | null;
};

function fmtRel(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return "gerade eben";
  if (min < 60) return `vor ${min} Min.`;
  const h = Math.floor(min / 60);
  if (h < 24) return `vor ${h} Std.`;
  return new Date(iso).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich", day: "2-digit", month: "2-digit", year: "numeric" });
}

export function LiveDocsSection({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const supabase = useMemo(() => createClient(), []);
  const router = useRouter();
  const { confirm, ConfirmModalElement } = useConfirm();
  const [docs, setDocs] = useState<LiveDoc[] | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("project_docs")
      .select("id, title, updated_at, updater:profiles!project_docs_updated_by_fkey(full_name)")
      .eq("project_id", projectId)
      .order("updated_at", { ascending: false });
    if (error) {
      toast.error("Live-Dokumente konnten nicht geladen werden");
      setDocs([]);
      return;
    }
    setDocs((data ?? []) as unknown as LiveDoc[]);
  }, [supabase, projectId]);

  useEffect(() => { load(); }, [load]);

  async function createDoc() {
    if (creating) return;
    setCreating(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setCreating(false); return; }
    const { data, error } = await supabase
      .from("project_docs")
      .insert({ project_id: projectId, title: "Neues Dokument", created_by: user.id, updated_by: user.id })
      .select("id")
      .single();
    setCreating(false);
    if (error || !data) {
      toast.error("Dokument konnte nicht erstellt werden" + (error ? ": " + error.message : ""));
      return;
    }
    router.push(`/projekte/${projectId}/dok/${data.id}`);
  }

  async function deleteDoc(d: LiveDoc) {
    const ok = await confirm({
      title: "Live-Dokument löschen?",
      message: `«${d.title}» wird mitsamt Verlauf gelöscht.`,
      confirmLabel: "Löschen",
      variant: "red",
    });
    if (!ok) return;
    const { error } = await supabase.from("project_docs").delete().eq("id", d.id);
    if (error) {
      toast.error("Löschen fehlgeschlagen: " + error.message);
      return;
    }
    toast.success("Dokument gelöscht");
    load();
  }

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            Live-Dokumente
            {docs && <span className="text-[10px] font-normal text-muted-foreground">({docs.length})</span>}
          </h3>
          {canEdit && (
            <button type="button" onClick={createDoc} disabled={creating} className="kasten kasten-red">
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />} Live-Dokument
            </button>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground mb-2">
          Gemeinsam bearbeiten — alle Eingeloggten schreiben gleichzeitig, ohne Hin- und Herschicken.
        </p>
        {docs === null ? (
          <div className="py-6 text-center text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin inline mr-2" />Laden…</div>
        ) : docs.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">Noch keine Live-Dokumente.</p>
        ) : (
          <ul className="space-y-1.5">
            {docs.map((d) => (
              <li key={d.id} className="rounded-xl border border-border flex items-center gap-2 pr-2 card-hover">
                <button
                  type="button"
                  onClick={() => router.push(`/projekte/${projectId}/dok/${d.id}`)}
                  className="flex-1 min-w-0 text-left flex items-center gap-2.5 px-3 py-2"
                >
                  <span className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: "rgba(47,84,150,0.12)" }}>
                    <FileText className="h-4 w-4" style={{ color: "#2F5496" }} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium truncate">{d.title}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {fmtRel(d.updated_at)}{d.updater?.full_name ? ` · ${d.updater.full_name}` : ""}
                    </span>
                  </span>
                </button>
                {canEdit && (
                  <button
                    type="button"
                    onClick={() => deleteDoc(d)}
                    className="p-1.5 rounded-md text-muted-foreground hover:text-red-600 hover:bg-red-500/10"
                    data-tooltip="Löschen"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {ConfirmModalElement}
      </CardContent>
    </Card>
  );
}
