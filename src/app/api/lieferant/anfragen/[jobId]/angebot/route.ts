// /api/lieferant/anfragen/[jobId]/angebot — Angebots-Upload des Lieferanten
// (Philippe-Mail 2026-09-24: "ich sende Euch das Angebot inkl. allem
// Material").
//
// GET  → bisherige Angebote dieses Auftrags (Ordner "Angebote") mit
//        signierten Download-URLs.
// POST → multipart/form-data { file } (nur PDF, max 20 MB). Landet als
//        Dokument am Auftrag (Ordner "Angebote") — die Firma sieht es im
//        Dokumente-Tab; Aktivitaet + Benachrichtigung an die Zustaendigen.

import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireLieferantPortal, logTechnik } from "@/lib/technik-server";
import { notifyTechnikAntwort } from "@/lib/notification-service";
import { recipientsWithPermission } from "@/lib/notification-recipients";
import { logError } from "@/lib/log";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 20 * 1024 * 1024;

export const maxDuration = 60;

const fehler = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status });

async function zugriff(admin: SupabaseClient, jobId: string, lieferantId: string) {
  const { data } = await admin
    .from("job_lieferanten")
    .select("id")
    .eq("job_id", jobId)
    .eq("lieferant_id", lieferantId)
    .maybeSingle();
  return !!data;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const gate = await requireLieferantPortal();
  if (gate.error) return gate.error;
  const { admin, lieferantId } = gate;
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return fehler("Ungültige ID");
  if (!(await zugriff(admin, jobId, lieferantId))) return fehler("Kein Zugriff", 403);

  const { data: docs } = await admin
    .from("documents")
    .select("id, name, storage_path, created_at")
    .eq("job_id", jobId)
    .eq("folder", "Angebote")
    .order("created_at", { ascending: false });

  const angebote: { id: string; name: string; createdAt: string; url: string | null }[] = [];
  for (const d of (docs ?? []) as { id: string; name: string; storage_path: string; created_at: string }[]) {
    const { data: s } = await admin.storage.from("documents").createSignedUrl(d.storage_path, 3600);
    angebote.push({ id: d.id, name: d.name, createdAt: d.created_at, url: s?.signedUrl ?? null });
  }
  return NextResponse.json({ success: true, angebote });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const gate = await requireLieferantPortal();
  if (gate.error) return gate.error;
  const { admin, lieferantId, userId, userName } = gate;
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return fehler("Ungültige ID");
  if (!(await zugriff(admin, jobId, lieferantId))) return fehler("Kein Zugriff", 403);

  try {
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) return fehler("Keine Datei erhalten");
    if (file.type !== "application/pdf") return fehler("Bitte ein PDF hochladen");
    if (file.size === 0) return fehler("Die Datei ist leer");
    if (file.size > MAX_BYTES) return fehler("Datei zu gross (max. 20 MB)");

    const [{ data: job }, { data: firma }] = await Promise.all([
      admin.from("jobs").select("id, title, is_deleted").eq("id", jobId).maybeSingle(),
      admin.from("lieferanten").select("name").eq("id", lieferantId).maybeSingle(),
    ]);
    if (!job || job.is_deleted) return fehler("Auftrag nicht gefunden", 404);
    const lieferantName = firma?.name ?? "Lieferant";

    const buf = Buffer.from(await file.arrayBuffer());
    const sicher = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    // Kein doppeltes Praefix, wenn der Dateiname schon "Angebot…" heisst.
    const pfad = `jobs/${jobId}/${Date.now()}_${/^angebot/i.test(sicher) ? sicher : `Angebot_${sicher}`}`;
    const { error: upErr } = await admin.storage
      .from("documents")
      .upload(pfad, buf, { contentType: "application/pdf" });
    if (upErr) throw upErr;

    const { error: insErr } = await admin.from("documents").insert({
      name: file.name,
      storage_path: pfad,
      file_size: buf.length,
      mime_type: "application/pdf",
      job_id: jobId,
      uploaded_by: userId,
      folder: "Angebote",
    });
    if (insErr) {
      await admin.storage.from("documents").remove([pfad]);
      throw insErr;
    }

    await logTechnik(admin, jobId, { id: userId, name: userName ?? lieferantName }, "angebot_hochgeladen",
      `${lieferantName} hat ein Angebot hochgeladen: ${file.name}`);
    await notifyTechnikAntwort(admin, {
      recipients: await recipientsWithPermission(admin, "auftraege:edit", { exclude: [userId] }),
      jobId,
      jobTitle: job.title,
      lieferantName,
      was: `Angebot hochgeladen: ${file.name}`,
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    logError("api.lieferant.anfragen.angebot", e, { jobId });
    return NextResponse.json({ success: false, error: "Upload fehlgeschlagen" }, { status: 500 });
  }
}
