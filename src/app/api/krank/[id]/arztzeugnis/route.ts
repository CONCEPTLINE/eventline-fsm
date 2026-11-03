// /api/krank/[id]/arztzeugnis — Arztzeugnis zur Krankmeldung.
//
// POST (multipart, Feld «datei»: Foto oder PDF, max. 10 MB)
//      Nur die Person selbst. Legt die Datei im privaten Bucket
//      «arztzeugnisse» unter <user_id>/<time_off_id>/… ab (Migration 378:
//      kein direkter Zugriff fuer Clients) und merkt Pfad, Dateiname, Typ,
//      Grösse und sha256 (Migration 380, für Trust flow: /api/flow/abwesenheiten
//      und /api/flow/arztzeugnis). Ein neues Zeugnis ersetzt das alte und gilt
//      wieder als «noch nicht an Trust flow übergeben».
// GET  → { url } kurzlebige signierte URL (60 s). Nur die Person selbst,
//      ferien:approve und Admins (DSG Art. 5).

import { NextRequest, NextResponse } from "next/server";
import { requireInternal } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { ARZTZEUGNIS_BUCKET, darfArztzeugnisSehen } from "@/lib/krank-server";
import { arztzeugnisDateiname } from "@/lib/krank";
import { sha256Hex } from "@/lib/flow/regeln";

const MAX_BYTES = 10 * 1024 * 1024;
const ERLAUBT = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"]);

async function ladeKrank(admin: ReturnType<typeof createAdminClient>, id: string) {
  const { data, error } = await admin
    .from("time_off")
    .select("id, user_id, type, arztzeugnis_pfad")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data && data.type === "krank" ? data : null;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInternal();
  if (auth.error) return auth.error;
  const { id } = await params;
  const admin = createAdminClient();
  try {
    const k = await ladeKrank(admin, id);
    // Geprueft wird das ECHTE Konto (auch unter «Ansicht als»).
    if (!k || !(await darfArztzeugnisSehen(admin, auth.user.id, k.user_id as string))) {
      return NextResponse.json({ success: false, error: "Nicht gefunden" }, { status: 404 });
    }
    if (!k.arztzeugnis_pfad) return NextResponse.json({ success: false, error: "Kein Arztzeugnis hochgeladen" }, { status: 404 });
    const { data, error } = await admin.storage.from(ARZTZEUGNIS_BUCKET).createSignedUrl(k.arztzeugnis_pfad as string, 60);
    if (error || !data) throw new Error(error?.message ?? "Link fehlgeschlagen");
    return NextResponse.json({ success: true, url: data.signedUrl }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    logError("api.krank.arztzeugnis.get", e, { id });
    return NextResponse.json({ success: false, error: "Arztzeugnis konnte nicht geöffnet werden" }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireInternal();
  if (auth.error) return auth.error;
  const ich = auth.user.id;
  const { id } = await params;
  const form = await req.formData().catch(() => null);
  const datei = form?.get("datei");
  if (!(datei instanceof File)) return NextResponse.json({ success: false, error: "Datei fehlt" }, { status: 400 });
  if (datei.size > MAX_BYTES) return NextResponse.json({ success: false, error: "Datei ist grösser als 10 MB" }, { status: 400 });
  if (!ERLAUBT.has(datei.type)) return NextResponse.json({ success: false, error: "Nur Foto (JPG, PNG, HEIC) oder PDF" }, { status: 400 });

  const admin = createAdminClient();
  try {
    const k = await ladeKrank(admin, id);
    if (!k || k.user_id !== ich) return NextResponse.json({ success: false, error: "Krankmeldung nicht gefunden" }, { status: 404 });

    const endung = datei.type === "application/pdf" ? "pdf" : (datei.type.split("/")[1] ?? "jpg");
    const pfad = `${ich}/${id}/${Date.now()}.${endung}`;
    const bytes = new Uint8Array(await datei.arrayBuffer());
    const { error: upErr } = await admin.storage.from(ARZTZEUGNIS_BUCKET).upload(pfad, bytes, { contentType: datei.type, upsert: false });
    if (upErr) throw new Error(upErr.message);

    const { error: uErr } = await admin
      .from("time_off")
      .update({
        arztzeugnis_pfad: pfad,
        arztzeugnis_hochgeladen_at: new Date().toISOString(),
        arztzeugnis_dateiname: arztzeugnisDateiname(datei.name, endung),
        arztzeugnis_mime: datei.type,
        arztzeugnis_groesse: bytes.byteLength,
        arztzeugnis_sha256: sha256Hex(bytes),
        arztzeugnis_an_flow_at: null,
      })
      .eq("id", id);
    if (uErr) {
      await admin.storage.from(ARZTZEUGNIS_BUCKET).remove([pfad]);
      throw new Error(uErr.message);
    }
    // Altes Zeugnis entfernen (ersetzt) — best effort.
    if (k.arztzeugnis_pfad) await admin.storage.from(ARZTZEUGNIS_BUCKET).remove([k.arztzeugnis_pfad as string]);
    return NextResponse.json({ success: true });
  } catch (e) {
    logError("api.krank.arztzeugnis.post", e, { userId: ich, id });
    return NextResponse.json({ success: false, error: "Hochladen fehlgeschlagen" }, { status: 500 });
  }
}
