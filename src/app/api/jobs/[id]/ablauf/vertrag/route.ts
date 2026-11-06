// /api/jobs/[id]/ablauf/vertrag — Vertrag der Privatvermietung (im Namen von Basil Erny, docs/barakuba/VERTRAG-ABLAUF.md).
//
//   POST → Vertrags-PDF aus den aktuellen Ablauf-Feldern erzeugen, im Auftrag ablegen (documents, Ordner «Vertrag»,
//          jobs/{id}/vertrag/…; ersetzt einen früher erzeugten Vertrag) und auftrag_ablauf.vertrag_dokument_id setzen
//          → { success, dokumentId, url, name }. Fehlen Pflichtfelder → 409 mit Liste.
//   GET  → signierte URL des abgelegten Vertrags → { success, dokumentId, url, name } (404 ohne Vertrag).
//
// Rechte wie Aufträge: POST auftraege:edit, GET auftraege:view. auftrag_ablauf wird mit dem RLS-Client gelesen und
// geschrieben (sieht das Konto den Auftrag nicht, gibt es keinen Ablauf → 404). Datei + documents-Zeile mit dem
// Admin-Client wie die übrigen Server-Ablagen (Catering, /api/upload); archivierte Aufträge sind gesperrt (409).
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/api-auth";
import { auftragArchivSperre } from "@/lib/archiv-server";
import { logError } from "@/lib/log";
import {
  fehlendeVertragsfelder,
  legeVertragAb,
  vertragDateiname,
  vertragPdf,
} from "@/lib/ablauf/vertrag-pdf";
import { felderAusDb } from "@/lib/ablauf/schritte";

export const maxDuration = 30;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fehler = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status });
const SIGNIERT_S = 3600;

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission("auftraege:edit");
  if (auth.error) return auth.error;
  const { id: jobId } = await ctx.params;
  if (!UUID_RE.test(jobId)) return fehler("Ungültige Auftrags-ID");

  try {
    const supabase = await createClient();
    const { data: ablauf, error: aErr } = await supabase
      .from("auftrag_ablauf")
      .select("felder, uebergabe_start")
      .eq("job_id", jobId)
      .maybeSingle();
    if (aErr) throw aErr;
    if (!ablauf) return fehler("Kein Vermietungs-Ablauf zu diesem Auftrag", 404);

    const admin = createAdminClient();
    const sperre = await auftragArchivSperre(admin, jobId);
    if (sperre) return sperre;

    const { felder } = felderAusDb(ablauf.felder);
    const fehlt = fehlendeVertragsfelder(felder);
    if (fehlt.length > 0) {
      return NextResponse.json(
        { success: false, error: `Für den Vertrag fehlt noch: ${fehlt.join(", ")}`, fehlt },
        { status: 409 },
      );
    }

    const bytes = await vertragPdf(felder, { uebergabeStart: ablauf.uebergabe_start as string | null });
    const name = vertragDateiname(felder);
    const { dokumentId, pfad } = await legeVertragAb(admin, {
      jobId,
      userId: auth.user.id,
      dateiname: name,
      bytes,
      setzeVerweis: async (id) => {
        const { error } = await supabase.from("auftrag_ablauf").update({ vertrag_dokument_id: id }).eq("job_id", jobId);
        if (error) throw error;
      },
    });

    const { data: signiert, error: sErr } = await admin.storage.from("documents").createSignedUrl(pfad, SIGNIERT_S);
    if (sErr) throw sErr;
    return NextResponse.json({ success: true, dokumentId, url: signiert.signedUrl, name });
  } catch (e) {
    logError("api.jobs.ablauf.vertrag.post", e, { jobId });
    return fehler("Vertrag konnte nicht erstellt werden", 500);
  }
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission("auftraege:view");
  if (auth.error) return auth.error;
  const { id: jobId } = await ctx.params;
  if (!UUID_RE.test(jobId)) return fehler("Ungültige Auftrags-ID");

  try {
    const supabase = await createClient();
    const { data: ablauf, error: aErr } = await supabase
      .from("auftrag_ablauf")
      .select("vertrag_dokument_id")
      .eq("job_id", jobId)
      .maybeSingle();
    if (aErr) throw aErr;
    if (!ablauf) return fehler("Kein Vermietungs-Ablauf zu diesem Auftrag", 404);
    const dokumentId = ablauf.vertrag_dokument_id as string | null;
    if (!dokumentId) return fehler("Noch kein Vertrag erstellt", 404);

    const { data: dok, error: dErr } = await supabase
      .from("documents")
      .select("id, name, storage_path")
      .eq("id", dokumentId)
      .maybeSingle();
    if (dErr) throw dErr;
    if (!dok) return fehler("Vertrag nicht gefunden", 404);

    const admin = createAdminClient();
    const { data: signiert, error: sErr } = await admin.storage
      .from("documents")
      .createSignedUrl(dok.storage_path as string, SIGNIERT_S);
    if (sErr) throw sErr;
    return NextResponse.json({ success: true, dokumentId, url: signiert.signedUrl, name: dok.name });
  } catch (e) {
    logError("api.jobs.ablauf.vertrag.get", e, { jobId });
    return fehler("Vertrag konnte nicht geladen werden", 500);
  }
}
