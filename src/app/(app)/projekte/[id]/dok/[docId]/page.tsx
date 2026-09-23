"use client";

/**
 * Live-Dokument-Seite — laedt Dokument + Projekt-Beteiligung und mountet
 * den WordEditor. Schreiben duerfen (wie Migration 230/231): Admin /
 * projekte:approve / projekte:see-all / Ersteller / Projektleiter /
 * eingeloggte Mitglieder. Alle anderen Mitarbeiter lesen nur.
 * Der Editor selbst ist dynamic (Tiptap+Yjs ~ groesserer Chunk).
 */

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import dynamic from "next/dynamic";
import { createClient } from "@/lib/supabase/client";
import { usePermissions } from "@/lib/use-permissions";
import { Skeleton } from "@/components/ui/skeleton";

const WordEditor = dynamic(
  () => import("@/components/projekt/live-doc/word-editor").then((m) => m.WordEditor),
  {
    ssr: false,
    loading: () => (
      <div className="space-y-4">
        <Skeleton className="h-10" />
        <Skeleton className="mx-auto h-[70vh] w-full max-w-[794px]" />
      </div>
    ),
  },
);

type DocRow = {
  id: string;
  project_id: string;
  title: string;
  ydoc_state: string | null;
};

export default function LiveDocPage() {
  const { id, docId } = useParams();
  const projectId = id as string;
  const supabase = useMemo(() => createClient(), []);
  const { can, profile, ready } = usePermissions();

  const [doc, setDoc] = useState<DocRow | null>(null);
  const [involved, setInvolved] = useState(false);
  const [state, setState] = useState<"loading" | "ok" | "missing">("loading");

  useEffect(() => {
    if (!profile?.id) return;
    (async () => {
      const [docRes, projRes, memberRes] = await Promise.all([
        supabase.from("project_docs").select("id, project_id, title, ydoc_state").eq("id", docId as string).maybeSingle(),
        supabase.from("projects").select("assigned_to, created_by").eq("id", projectId).maybeSingle(),
        supabase.from("project_members").select("user_id").eq("project_id", projectId).eq("user_id", profile.id).maybeSingle(),
      ]);
      if (!docRes.data || docRes.data.project_id !== projectId) {
        setState("missing");
        return;
      }
      setDoc(docRes.data as DocRow);
      setInvolved(
        projRes.data?.assigned_to === profile.id ||
        projRes.data?.created_by === profile.id ||
        !!memberRes.data,
      );
      setState("ok");
    })();
  }, [supabase, docId, projectId, profile?.id]);

  if (state === "missing") {
    return <p className="text-sm text-muted-foreground py-16 text-center">Dokument nicht gefunden.</p>;
  }
  if (state === "loading" || !ready || !doc || !profile) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10" />
        <Skeleton className="mx-auto h-[70vh] w-full max-w-[794px]" />
      </div>
    );
  }

  // Admins passen via can()/hasPermission() automatisch durch — kein
  // separater role==='admin'-Check noetig.
  const canWrite =
    can("projekte:approve") || can("projekte:see-all") || involved;

  return (
    <WordEditor
      docId={doc.id}
      projectId={projectId}
      initialTitle={doc.title}
      initialState={doc.ydoc_state}
      canWrite={canWrite}
      meId={profile.id}
      meName={profile.full_name ?? "Unbekannt"}
    />
  );
}
