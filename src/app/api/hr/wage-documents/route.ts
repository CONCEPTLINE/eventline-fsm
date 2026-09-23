// Lohndokumente-API: GET listet (eigene fuer User, alle fuer Admin),
// POST nimmt PDF + Metadaten und uploaded sie in den Storage.
//
// Pfad-Schema im Storage:
//   lohndokumente/<profile_id>/<year>/<doc_type>_<period>.pdf
//
// Re-Upload (gleicher Mitarbeiter+Jahr+Typ+Monat) ueberschreibt das
// alte File und updated den DB-Row. Garantiert durch unique-constraint.

import { NextResponse } from "next/server";
import { requireUser, requirePermission } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

const BUCKET = "lohndokumente";
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

function buildStoragePath(profileId: string, docType: string, year: number, month: number | null): string {
  const period = docType === "lohnabrechnung" && month
    ? `${year}-${String(month).padStart(2, "0")}`
    : String(year);
  return `${profileId}/${year}/${docType}_${period}.pdf`;
}

export async function GET(req: Request) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const supabase = await createClient();
  const url = new URL(req.url);
  const profileFilter = url.searchParams.get("profile_id");

  // Strikte Filterung: 'Mein Konto'-Aufrufer (kein profile_id-Param)
  // bekommen IMMER nur ihre eigenen Dokumente, auch wenn sie Admin sind.
  // RLS allein liess Admins fremde Docs in 'Mein Konto' sehen
  // (Privacy-Bug: Admin sah fremde Lohnabrechnung im persoenlichen Bereich).
  // Lohn-Verwaltungs-Sicht (HR > Loehne > Lohnabrechnungen) muss explizit
  // profile_id=X uebergeben; fremde profile_ids verlangen lohn:manage
  // (Admins passen via has_permission() automatisch durch).
  let effectiveProfileId: string;
  // dev-mode: effective user
  if (!profileFilter || profileFilter === auth.effectiveUserId) {
    // dev-mode: effective user
    effectiveProfileId = auth.effectiveUserId;
  } else {
    const { data: allowed } = await supabase.rpc("has_permission", { perm: "lohn:manage" });
    if (allowed !== true) {
      return NextResponse.json({ success: false, error: "Nicht erlaubt" }, { status: 403 });
    }
    effectiveProfileId = profileFilter;
  }

  const { data, error } = await supabase
    .from("wage_documents")
    .select("id, profile_id, doc_type, year, period_month, storage_path, file_size, uploaded_at, notes, source, profile:profiles!wage_documents_profile_id_fkey(full_name)")
    .eq("profile_id", effectiveProfileId)
    .order("year", { ascending: false })
    .order("period_month", { ascending: false, nullsFirst: false });
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, documents: data ?? [] });
}

export async function POST(req: Request) {
  // Upload = Lohn-Verwaltung — lohn:manage statt hartem Admin-Check.
  const auth = await requirePermission("lohn:manage");
  if (auth.error) return auth.error;

  const form = await req.formData();
  const file = form.get("file");
  const profileId = String(form.get("profile_id") ?? "");
  const docType = String(form.get("doc_type") ?? "");
  const year = Number(form.get("year"));
  const monthRaw = form.get("period_month");
  const month = monthRaw == null || monthRaw === "" ? null : Number(monthRaw);
  const notes = form.get("notes") ? String(form.get("notes")).slice(0, 500) : null;

  if (!(file instanceof File)) return NextResponse.json({ success: false, error: "PDF fehlt" }, { status: 400 });
  if (file.type !== "application/pdf") return NextResponse.json({ success: false, error: "Nur PDF erlaubt" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ success: false, error: "Datei > 10 MB" }, { status: 400 });

  // Magic-Number-Check — Browser-MIME ist faelschbar, echte PDF beginnt
  // mit "%PDF-" in den ersten 5 Bytes.
  const headBytes = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  const magic = String.fromCharCode(...headBytes);
  if (magic !== "%PDF-") {
    return NextResponse.json({ success: false, error: "Datei ist keine gültige PDF" }, { status: 400 });
  }
  if (!profileId) return NextResponse.json({ success: false, error: "profile_id fehlt" }, { status: 400 });
  if (!["lohnabrechnung", "lohnausweis"].includes(docType)) return NextResponse.json({ success: false, error: "doc_type ungültig" }, { status: 400 });
  if (!Number.isInteger(year) || year < 2020 || year > 2100) return NextResponse.json({ success: false, error: "year ungültig" }, { status: 400 });
  if (docType === "lohnabrechnung") {
    if (!Number.isInteger(month) || (month as number) < 1 || (month as number) > 12) {
      return NextResponse.json({ success: false, error: "period_month (1-12) fehlt für Lohnabrechnung" }, { status: 400 });
    }
  } else if (month != null) {
    return NextResponse.json({ success: false, error: "Lohnausweis darf keinen Monat haben" }, { status: 400 });
  }

  const admin = createAdminClient();
  const path = buildStoragePath(profileId, docType, year, month);
  const buf = Buffer.from(await file.arrayBuffer());
  const { error: upErr } = await admin.storage.from(BUCKET).upload(path, buf, {
    contentType: "application/pdf",
    upsert: true,
  });
  if (upErr) return NextResponse.json({ success: false, error: upErr.message }, { status: 500 });

  // Upsert-Row (verhindert dass alte Row liegen bleibt wenn man re-uploaded)
  const { data: existing } = await admin
    .from("wage_documents")
    .select("id")
    .eq("profile_id", profileId)
    .eq("doc_type", docType)
    .eq("year", year)
    .eq("period_month", month ?? null)
    .maybeSingle();

  if (existing) {
    const { error } = await admin
      .from("wage_documents")
      .update({ storage_path: path, file_size: file.size, notes, uploaded_at: new Date().toISOString(), uploaded_by: auth.user.id, source: "manual" })
      .eq("id", existing.id);
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, id: existing.id, mode: "updated" });
  } else {
    const { data, error } = await admin
      .from("wage_documents")
      .insert({
        profile_id: profileId,
        doc_type: docType,
        year,
        period_month: month,
        storage_path: path,
        file_size: file.size,
        uploaded_by: auth.user.id,
        notes,
        source: "manual",
      })
      .select("id")
      .single();
    if (error || !data) return NextResponse.json({ success: false, error: error?.message ?? "insert fehlgeschlagen" }, { status: 500 });
    return NextResponse.json({ success: true, id: data.id, mode: "created" });
  }
}
