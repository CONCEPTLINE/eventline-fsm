import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import { Resend } from "resend";
import { requirePermission } from "@/lib/api-auth";
import { loadCompanySettings, formatMailFooter, formatMailFrom } from "@/lib/company-settings";

export async function POST(request: Request) {
  // Permission-Gate: das Anlegen von calendar_events fuer ANDERE User
  // hebelt sonst die has_permission()-RLS aus 073 aus (Service-Role-
  // Insert). Wer Termine fuer Mitarbeiter anlegen darf, hat kalender:create.
  const auth = await requirePermission("kalender:create");
  if (auth.error) return auth.error;
  const body = await request.json();
  const { job_id, profile_ids, job_title, start_date, end_date } = body as {
    job_id: string;
    profile_ids: string[];
    job_title: string;
    start_date?: string;
    end_date?: string;
  };

  if (!job_id || !profile_ids || profile_ids.length === 0) {
    return NextResponse.json({ success: false });
  }

  const supabase = createAdminClient();
  const company = await loadCompanySettings(supabase);
  const resendKey = process.env.RESEND_API_KEY;
  const resend = resendKey ? new Resend(resendKey) : null;

  // Alle Profile in EINER Query laden statt N Roundtrips
  const { data: profiles } = await supabase
    .from("profiles")
    .select("id, full_name, email")
    .in("id", profile_ids);
  if (!profiles || profiles.length === 0) {
    return NextResponse.json({ success: true, sent: [] });
  }

  // Schichten anlegen — alle Existence-Checks parallel statt seriell,
  // dann fehlende Schichten in einem Bulk-Insert.
  if (start_date) {
    const startTime = start_date.includes("T") ? start_date : `${start_date}T08:00:00`;
    const endTime = end_date
      ? (end_date.includes("T") ? end_date : `${end_date}T17:00:00`)
      : startTime.replace("T08:00", "T17:00");
    // De-Dup-Window: 13h beidseits von startTime decken den ganzen
    // Europe/Zurich-Tag ab (CET +01 / CEST +02) und sind unabhaengig
    // von Sommer/Winter. Vorher waren das `.split("T")[0] + "T00:00:00"`-
    // Strings, was den UTC-Tag traf und beim Jahres-Edge-Case Events
    // doppelt anlegte.
    const startMs = new Date(startTime).getTime();
    const dayStart = new Date(startMs - 13 * 60 * 60 * 1000).toISOString();
    const dayEnd = new Date(startMs + 13 * 60 * 60 * 1000).toISOString();

    const { data: existing } = await supabase
      .from("calendar_events")
      .select("profile_id")
      .eq("title", `Auftrag: ${job_title}`)
      .in("profile_id", profile_ids)
      .gte("start_time", dayStart)
      .lte("start_time", dayEnd);

    const haveEvent = new Set((existing ?? []).map((e) => e.profile_id));
    const toInsert = profiles
      .filter((p) => !haveEvent.has(p.id))
      .map((p) => ({
        title: `Auftrag: ${job_title}`,
        start_time: startTime,
        end_time: endTime,
        profile_id: p.id,
        color: "#3b82f6",
        created_by: auth.user.id,
        all_day: false,
      }));
    if (toInsert.length > 0) {
      await supabase.from("calendar_events").insert(toInsert);
    }
  }

  // E-Mails parallel verschicken (vorher seriell -> N x HTTP-Latenz)
  if (resend) {
    const dateStr = start_date
      ? new Date(start_date).toLocaleDateString("de-CH", {
          timeZone: "Europe/Zurich", weekday: "long", day: "numeric", month: "long", year: "numeric",
        })
      : null;

    const recipients = profiles.filter((p) => p.email);
    const results = await Promise.allSettled(
      recipients.map((profile) => resend.emails.send({
        from: formatMailFrom(company, "noreply@eventline-basel.com"),
        to: profile.email!,
        subject: `Auftrag zugeteilt: ${job_title}${dateStr ? ` – ${dateStr}` : ""}`,
        html: `
          <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto">
            <div style="background:#1a1a1a;padding:20px 24px;border-radius:12px 12px 0 0">
              <h2 style="color:white;margin:0;font-size:16px">${company.name}</h2>
            </div>
            <div style="background:white;padding:24px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px">
              <p style="margin:0 0 12px">Hallo ${profile.full_name},</p>
              <p style="margin:0 0 16px">Dir wurde ein neuer Auftrag zugeteilt:</p>
              <div style="background:#f5f5f5;padding:16px;border-radius:8px;border-left:4px solid #3b82f6;margin:0 0 16px">
                <p style="margin:0 0 4px;font-weight:600;font-size:16px">${job_title}</p>
                ${dateStr ? `<p style="margin:0;color:#666">${dateStr}</p>` : ""}
              </div>
              <p style="margin:0 0 8px;color:#999;font-size:13px">Öffne die App für weitere Details.</p>
              <hr style="border:none;border-top:1px solid #eee;margin:16px 0"/>
              <p style="margin:0;color:#bbb;font-size:11px">${formatMailFooter(company)}</p>
            </div>
          </div>
        `,
      })),
    );

    const sent = recipients
      .filter((_, i) => results[i].status === "fulfilled")
      .map((p) => p.full_name);
    return NextResponse.json({ success: true, sent });
  }

  return NextResponse.json({ success: true, sent: [] });
}
