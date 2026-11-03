import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { logError } from "@/lib/log";

// POST /api/time-off — Mitarbeiter meldet eine Abwesenheit (wartet auf Freigabe).
// Body: { start_date, end_date, type, note? }
// Insert via User-Client damit RLS den user_id-Match enforce'd.

interface Body {
  start_date?: unknown;
  end_date?: unknown;
  type?: unknown;
  note?: unknown;
}

// «krank» laeuft ueber /api/krank (ohne Freigabe, Migration 378).
const ALLOWED_TYPES = new Set(["ferien", "kompensation", "frei", "militaer"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ success: false, error: "Nicht authentifiziert" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as Body | null;
  const start = typeof body?.start_date === "string" ? body.start_date : "";
  const end = typeof body?.end_date === "string" ? body.end_date : "";
  const type = typeof body?.type === "string" ? body.type : "";
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : null;

  if (!DATE_RE.test(start) || !DATE_RE.test(end)) {
    return NextResponse.json({ success: false, error: "Ungültiges Datum (YYYY-MM-DD erwartet)" }, { status: 400 });
  }
  if (start > end) {
    return NextResponse.json({ success: false, error: "Start-Datum muss vor End-Datum liegen" }, { status: 400 });
  }
  if (type === "krank") {
    return NextResponse.json({ success: false, error: "Krank bitte über «Krank melden» melden" }, { status: 400 });
  }
  if (!ALLOWED_TYPES.has(type)) {
    return NextResponse.json({ success: false, error: "Ungültiger Typ" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("time_off")
    .insert({
      user_id: user.id,
      start_date: start,
      end_date: end,
      type,
      note: note && note.length > 0 ? note : null,
    })
    .select("id")
    .single();

  if (error) {
    logError("api.time-off.create", error, { userId: user.id });
    return NextResponse.json({ success: false, error: "Speichern fehlgeschlagen" }, { status: 500 });
  }

  return NextResponse.json({ success: true, id: data.id });
}
