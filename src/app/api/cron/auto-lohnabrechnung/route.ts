// Cron: Auto-Lohnabrechnung. Laeuft taeglich und generiert 7 Tage nach
// Monatsende die PDF-Lohnabrechnung fuer alle aktiven MA die den Auto-
// Toggle an haben (employee_compensation.auto_lohnabrechnung = true).
//
// Ablauf:
//   1. Ermittle den zuletzt abgeschlossenen Monat (Europe/Zurich).
//   2. cutoff = Monatsende + 7 Tage. Ist heute < cutoff -> return.
//   3. Alle aktiven MA laden mit gueltiger comp-Row fuer den prev Month,
//      auto_lohnabrechnung=true, wage_exempt=false.
//   4. Fuer jeden pruefen ob wage_documents-Row schon existiert
//      (idempotent). Wenn nicht: /api/hr/wage-documents/generate rufen
//      mit dem CRON_SECRET als Bearer (die Route erlaubt System-Aufrufe
//      ueber den Header).
//
// Rueckgabe: JSON-Summary mit generated/skipped/failed pro MA.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { todayLocalIso } from "@/lib/swiss-time";
import { logError } from "@/lib/log";

export async function GET(request: Request) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: "CRON_SECRET fehlt in der Server-Config" }, { status: 503 });
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Prev-Month bestimmen (Europe/Zurich). todayLocalIso() liefert YYYY-MM-DD
  // im ZRH-Kalender. Wir arbeiten reine String-Arithmetik ohne UTC-Detour.
  const today = todayLocalIso(); // YYYY-MM-DD
  const [yyyy, mm] = today.split("-").map(Number);
  const prevYear = mm === 1 ? yyyy - 1 : yyyy;
  const prevMonth = mm === 1 ? 12 : mm - 1;
  // Letzter Tag des Vormonats
  const lastDay = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();
  // cutoff = letzter Tag + 7 Tage — verglichen als YYYY-MM-DD-String.
  const cutoffDate = new Date(Date.UTC(prevYear, prevMonth - 1, lastDay + 7));
  const cutoffIso = cutoffDate.toISOString().slice(0, 10);

  if (today < cutoffIso) {
    return NextResponse.json({
      skipped: true,
      reason: `today ${today} < cutoff ${cutoffIso} (Vormonat ${prevYear}-${String(prevMonth).padStart(2, "0")} + 7 Tage)`,
    });
  }

  const admin = createAdminClient();

  // Gueltige Comp-Zeilen fuer den Vormonat: effective_from <= letzter Tag
  // und (effective_to IS NULL OR effective_to >= erster Tag). Kombiniert
  // mit den Auto-Toggle-Filtern.
  const monthStart = `${prevYear}-${String(prevMonth).padStart(2, "0")}-01`;
  const { data: comps, error: compErr } = await admin
    .from("employee_compensation")
    .select("profile_id, wage_exempt, auto_lohnabrechnung")
    .lte("effective_from", monthStart)
    .or(`effective_to.is.null,effective_to.gte.${monthStart}`)
    .eq("wage_exempt", false)
    .eq("auto_lohnabrechnung", true);
  if (compErr) {
    logError("cron.auto-lohnabrechnung.load-comps", compErr);
    return NextResponse.json({ error: compErr.message }, { status: 500 });
  }

  const candidateIds = Array.from(new Set((comps ?? []).map((c) => c.profile_id as string)));
  if (candidateIds.length === 0) {
    return NextResponse.json({ ok: true, month: `${prevYear}-${String(prevMonth).padStart(2, "0")}`, candidates: 0 });
  }

  // Aktive MA-Filter
  const { data: profiles } = await admin
    .from("profiles")
    .select("id")
    .in("id", candidateIds)
    .eq("is_active", true);
  const activeIds = new Set((profiles ?? []).map((p) => p.id as string));

  // Bereits vorhandene Abrechnungen ausschliessen (idempotent — sowohl
  // auto als auch manual werden respektiert; wir ueberschreiben nichts).
  const { data: existing } = await admin
    .from("wage_documents")
    .select("profile_id")
    .eq("doc_type", "lohnabrechnung")
    .eq("year", prevYear)
    .eq("period_month", prevMonth)
    .in("profile_id", Array.from(activeIds));
  const alreadyDone = new Set((existing ?? []).map((r) => r.profile_id as string));

  const toGenerate = Array.from(activeIds).filter((id) => !alreadyDone.has(id));
  if (toGenerate.length === 0) {
    return NextResponse.json({
      ok: true,
      month: `${prevYear}-${String(prevMonth).padStart(2, "0")}`,
      candidates: activeIds.size,
      already_done: alreadyDone.size,
      generated: 0,
    });
  }

  // Sequentiell rufen — die PDF-Generation ist CPU-schwer, parallel wuerde
  // den Serverless-Worker crashen. Bulk-Route macht es genauso.
  const origin = new URL(request.url).origin;
  const results: { profile_id: string; ok: boolean; error?: string }[] = [];
  for (const profileId of toGenerate) {
    try {
      const res = await fetch(`${origin}/api/hr/wage-documents/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.CRON_SECRET}`,
        },
        body: JSON.stringify({ profile_id: profileId, year: prevYear, month: prevMonth }),
      });
      const j = await res.json().catch(() => ({}));
      if (j.success) results.push({ profile_id: profileId, ok: true });
      else results.push({ profile_id: profileId, ok: false, error: j.error ?? `HTTP ${res.status}` });
    } catch (e) {
      results.push({ profile_id: profileId, ok: false, error: e instanceof Error ? e.message : "Netzwerkfehler" });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  return NextResponse.json({
    ok: true,
    month: `${prevYear}-${String(prevMonth).padStart(2, "0")}`,
    candidates: activeIds.size,
    already_done: alreadyDone.size,
    generated: okCount,
    failed: results.length - okCount,
    results,
  });
}
