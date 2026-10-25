"use client";

// Auftrag → «Technik» → 3D-Ansicht (Leo 2026-10-25, Variante A):
// zeigt die NEUESTE 3D-Visualisierung des Auftrags eingebettet, mit
// Versionsauswahl, «Neue Version hochladen» und «Link teilen».
// Kein automatisches Generieren — eine 3D-Ansicht entsteht ausserhalb der
// App (Skill «eventline-3d-technikvisualisierung») und wird hochgeladen.
//
// Erkennung: src/lib/technik-3d.ts (HTML-Dokument am Auftrag im Ordner
// «3D», Rueckfall Namensmuster «…_3D_v<N>.html»). Ausgespielt wird wie im
// Dokumente-Tab ueber /api/visualisierung/[id] (CSP-Sandbox der Route +
// iframe-Sandbox ohne allow-same-origin). Upload = derselbe Weg wie im
// Dokumente-Tab (/api/upload prueft Typ, Groesse, Pfad, Archiv-Sperre).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchableSelect } from "@/components/searchable-select";
import { toast } from "sonner";
import { Box, Link2, Loader2, Upload } from "lucide-react";
import { validateFileList } from "@/lib/file-upload";
import { istHtml } from "@/lib/upload-regeln";
import { TOAST } from "@/lib/messages";
import { formatDateTimeFull } from "@/lib/format";
import { DREI_D_ORDNER, dreiDListe, dreiDVersion, type Visualisierung } from "@/lib/technik-3d";
import { visualisierungLinkKopieren } from "@/lib/visualisierung-teilen";

const URL_PARAM = "ansicht3d";

function versionLabel(d: Visualisierung): string {
  const v = dreiDVersion(d.name);
  return `${v !== null ? `v${v} · ` : ""}${formatDateTimeFull(d.created_at)}`;
}

export function DreiDAnsicht({ jobId, darfBearbeiten }: { jobId: string; darfBearbeiten: boolean }) {
  const supabase = useMemo(() => createClient(), []);
  const [liste, setListe] = useState<Visualisierung[] | null>(null);
  // Gewaehlte Version ueberlebt den Reload (URL, §10); leer = neueste.
  const [gewaehlt, setGewaehlt] = useState<string>(() =>
    typeof window !== "undefined" ? new URLSearchParams(window.location.search).get(URL_PARAM) ?? "" : "");
  const [hochladen, setHochladen] = useState(false);
  const [teilen, setTeilen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const laden = useCallback(async (): Promise<Visualisierung[] | null> => {
    const { data, error } = await supabase
      .from("documents")
      .select("id, name, folder, mime_type, created_at")
      .eq("job_id", jobId)
      .ilike("mime_type", "text/html%")
      .order("created_at", { ascending: false });
    if (error) {
      toast.error(`3D-Ansicht konnte nicht geladen werden: ${error.message}`);
      setListe((prev) => prev ?? []);
      return null;
    }
    const l = dreiDListe((data ?? []) as Visualisierung[]);
    setListe(l);
    return l;
  }, [supabase, jobId]);

  useEffect(() => { void laden(); }, [laden]);

  const aktuell = liste?.find((d) => d.id === gewaehlt) ?? liste?.[0] ?? null;

  function waehlen(id: string) {
    setGewaehlt(id);
    const url = new URL(window.location.href);
    // Die neueste Version braucht keinen Parameter (neue Uploads erscheinen sofort).
    if (id && id !== liste?.[0]?.id) url.searchParams.set(URL_PARAM, id);
    else url.searchParams.delete(URL_PARAM);
    window.history.replaceState(window.history.state, "", url.toString());
  }

  async function upload(files: FileList | null) {
    const file = files?.[0];
    if (!file || hochladen) return;
    if (!validateFileList([file])) return;
    if (!istHtml(file.type) || !/\.html?$/i.test(file.name)) {
      toast.error("Bitte die 3D-Visualisierung als HTML-Datei wählen (.html)");
      return;
    }
    setHochladen(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { toast.error("Nicht angemeldet"); return; }
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `jobs/${jobId}/${Date.now()}_${safeName}`;
      const formData = new FormData();
      formData.append("file", file);
      formData.append("path", path);
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const json = await res.json().catch(() => null);
      if (!json?.success) { TOAST.uploadError(json?.error ?? "Upload fehlgeschlagen"); return; }
      const { data: neu, error } = await supabase
        .from("documents")
        .insert({
          name: file.name,
          storage_path: path,
          file_size: file.size,
          mime_type: file.type,
          job_id: jobId,
          uploaded_by: user.id,
          // Fester Ordner = Erkennungsmerkmal der 3D-Ansicht (technik-3d.ts).
          folder: DREI_D_ORDNER,
        })
        .select("id")
        .single();
      if (error || !neu) {
        // Datei ohne Zeile waere verwaist — wieder entfernen.
        await supabase.storage.from("documents").remove([path]);
        TOAST.uploadError(error?.message ?? "Dokument konnte nicht gespeichert werden");
        return;
      }
      await laden();
      waehlen("");
      toast.success("Neue 3D-Version hochgeladen", { description: "Liegt auch im Dokumente-Tab im Ordner «3D»." });
    } catch {
      TOAST.uploadError("Netzwerkfehler");
    } finally {
      setHochladen(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function linkTeilen() {
    if (!aktuell || teilen) return;
    setTeilen(true);
    try {
      await visualisierungLinkKopieren(aktuell.id);
    } finally {
      setTeilen(false);
    }
  }

  const uploadKnopf = darfBearbeiten && (
    <>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={hochladen}
        className="kasten kasten-muted"
        data-tooltip="3D-Visualisierung als HTML-Datei hochladen (max. 25 MB) — landet auch im Dokumente-Tab, Ordner «3D»"
      >
        {hochladen ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
        {hochladen ? "Wird hochgeladen…" : "Neue Version hochladen"}
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".html,.htm,text/html"
        className="hidden"
        onChange={(e) => void upload(e.target.files)}
      />
    </>
  );

  return (
    <Card className="bg-card py-0">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <h4 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mr-auto">
            <Box className="h-3.5 w-3.5" />
            3D-Ansicht
          </h4>
          {liste && liste.length > 1 && aktuell && (
            <div className="w-60 max-w-full">
              <SearchableSelect
                value={aktuell.id}
                onChange={(id) => waehlen(id)}
                items={liste.map((d, i) => ({ id: d.id, label: versionLabel(d), sub: i === 0 ? "neueste" : undefined }))}
                clearable={false}
                searchable={liste.length > 8}
                placeholder="Version"
              />
            </div>
          )}
          {aktuell && (
            <button
              type="button"
              onClick={() => void linkTeilen()}
              disabled={teilen}
              className="kasten kasten-muted"
              data-tooltip="Link zum Ansehen ohne Login kopieren (90 Tage gültig)"
            >
              {teilen ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
              Link teilen
            </button>
          )}
          {aktuell && uploadKnopf}
        </div>

        {liste === null ? (
          <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground h-40">
            <Loader2 className="h-4 w-4 animate-spin" /> 3D-Ansicht wird geladen…
          </div>
        ) : !aktuell ? (
          <EmptyState
            icon={Box}
            title="Noch keine 3D-Ansicht"
            description="Eine 3D-Visualisierung entsteht ausserhalb der App (Skill «3D-Technikvisualisierung» aus den Positionen oben) und wird hier als HTML-Datei hochgeladen."
            action={uploadKnopf || undefined}
          />
        ) : (
          <>
            {/* Zusaetzlich zum CSP-Sandbox der Route: iframe-Sandbox ohne
                allow-same-origin — die Seite bleibt vom App-Ursprung getrennt. */}
            <iframe
              key={aktuell.id}
              src={`/api/visualisierung/${aktuell.id}`}
              sandbox="allow-scripts"
              allow="fullscreen"
              loading="lazy"
              title={aktuell.name}
              className="w-full h-[560px] rounded-lg border border-border bg-muted/30"
            />
            <p className="text-[11px] text-muted-foreground truncate" data-tooltip={aktuell.name}>
              {aktuell.name} · {versionLabel(aktuell)}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
