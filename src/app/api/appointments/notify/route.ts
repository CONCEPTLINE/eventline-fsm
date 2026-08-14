import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import { Resend } from "resend";
import { requireUser } from "@/lib/api-auth";
import { logError } from "@/lib/log";
import { loadCompanySettings, formatMailFooter, formatMailFrom } from "@/lib/company-settings";

export async function POST(request: Request) {
  const auth = await requireUser();
  if (auth.error) return auth.error;
  const body = await request.json();
  const { appointment_id, job_id, additional_email, send_to_emails } = body;

  if (!appointment_id || !job_id) {
    return NextResponse.json({ error: "Fehlende Parameter" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const company = await loadCompanySettings(supabase);

  // Auftrag mit Kunde, Standort, Projektleiter laden
  const { data: job } = await supabase
    .from("jobs")
    .select("*, customer:customers(name, email), location:locations(name), project_lead:profiles!project_lead_id(full_name, email)")
    .eq("id", job_id)
    .single();

  if (!job) {
    return NextResponse.json({ error: "Auftrag nicht gefunden" }, { status: 404 });
  }

  // Termin laden
  const { data: appt } = await supabase
    .from("job_appointments")
    .select("*, assignee:profiles!assigned_to(full_name, email)")
    .eq("id", appointment_id)
    .single();

  if (!appt) {
    return NextResponse.json({ error: "Termin nicht gefunden" }, { status: 404 });
  }

  // Zugewiesene Techniker laden: alle die ueber job_appointments einen
  // Termin auf diesem Job haben (job_assignments wurde 2026-06-17 mit
  // Migration 164 entfernt — alle Zuweisungen leben jetzt in Terminen).
  // Dedup auf Profile-Ebene unten in der Mail-Schleife.
  const { data: apptAssignees } = await supabase
    .from("job_appointments")
    .select("profile:profiles!assigned_to(full_name, email)")
    .eq("job_id", job_id)
    .not("assigned_to", "is", null);

  // Supabase-Joins kommen nominell als Array | Objekt | null. Hier ist die
  // FK 1:1, also nur Single-Object oder null. Inline-Type dokumentiert das.
  type Joined<T> = T | null;
  const customer = job.customer as Joined<{ name: string; email: string | null }>;
  const location = job.location as Joined<{ name: string; address_street: string | null; address_zip: string | null; address_city: string | null }>;
  const projectLead = job.project_lead as Joined<{ full_name: string; email: string | null }>;
  const assignee = appt.assignee as Joined<{ full_name: string; email: string | null }>;

  const apptDate = new Date(appt.start_time).toLocaleDateString("de-CH", {
    timeZone: "Europe/Zurich", weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
  const apptTime = new Date(appt.start_time).toLocaleTimeString("de-CH", {
    timeZone: "Europe/Zurich", hour: "2-digit", minute: "2-digit",
  });

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    return NextResponse.json({ success: false, reason: "Kein RESEND_API_KEY" });
  }

  // Meeting-Link-Snippet — wird in alle Mail-Varianten optional eingebaut.
  // href/Text getrennt damit lange Teams-URLs nicht das Mail-Layout sprengen.
  const meetingBlock = appt.meeting_link
    ? `<p style="margin:0 0 4px;color:#666">🎥 <a href="${appt.meeting_link}" style="color:#3b82f6;text-decoration:underline" target="_blank" rel="noopener">Meeting beitreten</a></p>`
    : "";

  const resend = new Resend(resendKey);
  const sentTo: string[] = [];
  const failed: string[] = [];

  // Wenn send_to_emails gesetzt ist, sende NUR an diese Adressen.
  // Limit + Format-Validation gegen Spam-Missbrauch — vorher konnte ein
  // authentifizierter User beliebig viele externe Mails ueber unsere
  // Domain triggern (Resend-Quota + Reputation-Risiko).
  if (send_to_emails && Array.isArray(send_to_emails) && send_to_emails.length > 0) {
    if (send_to_emails.length > 5) {
      return NextResponse.json({ success: false, error: "Maximal 5 Empfaenger pro Aufruf" }, { status: 400 });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const invalid = send_to_emails.filter((e: unknown) => typeof e !== "string" || !emailRegex.test(e));
    if (invalid.length > 0) {
      return NextResponse.json({ success: false, error: "Ungueltige Email-Adresse(n)" }, { status: 400 });
    }
    for (const email of send_to_emails) {
      try {
        await resend.emails.send({
          from: formatMailFrom(company, "noreply@eventline-basel.com"),
          to: email,
          subject: `Terminbestätigung: ${appt.title}`,
          html: `
            <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto">
              <div style="background:#1a1a1a;padding:20px 24px;border-radius:12px 12px 0 0">
                <h2 style="color:white;margin:0;font-size:16px">${company.name}</h2>
              </div>
              <div style="background:white;padding:24px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px">
                <p style="margin:0 0 12px">Guten Tag,</p>
                <p style="margin:0 0 16px">Wir bestätigen folgenden Termin:</p>
                <div style="background:#f5f5f5;padding:16px;border-radius:8px;border-left:4px solid #3b82f6;margin:0 0 16px">
                  <p style="margin:0 0 4px;font-weight:600;font-size:16px">${appt.title}</p>
                  <p style="margin:0 0 4px;color:#666">${apptDate} um ${apptTime} Uhr</p>
                  ${location ? `<p style="margin:0 0 4px;color:#666">Standort: ${location.name}</p>` : ""}
                  ${job?.title ? `<p style="margin:0 0 4px;color:#666">Auftrag: ${job.title}</p>` : ""}
                  ${meetingBlock}
                </div>
                <p style="margin:0 0 8px;color:#999;font-size:13px">Bei Fragen erreichen Sie uns unter info@eventline-basel.com</p>
                <hr style="border:none;border-top:1px solid #eee;margin:16px 0"/>
                <p style="margin:0;color:#bbb;font-size:11px">${formatMailFooter(company)}</p>
              </div>
            </div>
          `,
        });
        sentTo.push(email);
      } catch (e) { logError("appointments.notify.mail", e, { email }); failed.push(email); }
    }
    return NextResponse.json({ success: true, sentTo, failed });
  }

  // E-Mail an Kunde
  if (customer?.email) {
    try {
      await resend.emails.send({
        from: formatMailFrom(company, "noreply@eventline-basel.com"),
        to: customer.email,
        subject: `Terminbestätigung: ${appt.title} – ${apptDate}`,
        html: `
          <div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto">
            <div style="background:#1a1a1a;padding:20px 24px;border-radius:12px 12px 0 0">
              <h2 style="color:white;margin:0;font-size:16px">${company.name}</h2>
            </div>
            <div style="background:white;padding:24px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px">
              <p style="margin:0 0 12px">Guten Tag ${customer.name},</p>
              <p style="margin:0 0 16px">Wir bestätigen Ihnen folgenden Termin:</p>
              <div style="background:#f5f5f5;padding:16px;border-radius:8px;border-left:4px solid #ef4444;margin:0 0 16px">
                <p style="margin:0 0 4px;font-weight:600;font-size:16px">${appt.title}</p>
                <p style="margin:0 0 4px;color:#666">${apptDate} um ${apptTime} Uhr</p>
                ${location ? `<p style="margin:0 0 4px;color:#666">Standort: ${location.name}</p>` : ""}
                ${assignee ? `<p style="margin:0 0 4px;color:#666">Techniker: ${assignee.full_name}</p>` : ""}
                ${meetingBlock}
              </div>
              <p style="margin:0 0 8px">Auftrag: <strong>${job.title}</strong></p>
              <p style="margin:0 0 8px;color:#999;font-size:13px">Bei Fragen erreichen Sie uns unter Tel. 055 556 62 61.</p>
              <hr style="border:none;border-top:1px solid #eee;margin:16px 0"/>
              <p style="margin:0;color:#bbb;font-size:11px">${formatMailFooter(company)}</p>
            </div>
          </div>
        `,
      });
      sentTo.push(`Kunde: ${customer.email}`);
    } catch (e) { logError("appointments.notify.customer", e, { email: customer.email }); failed.push(customer.email); }
  }

  // E-Mail an Projektleiter
  if (projectLead?.email) {
    try {
      await resend.emails.send({
        from: formatMailFrom(company, "noreply@eventline-basel.com"),
        to: projectLead.email,
        subject: `Termin: ${appt.title} – ${apptDate} (${customer?.name || "Kunde"})`,
        html: `
          <div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto">
            <div style="background:#1a1a1a;padding:20px 24px;border-radius:12px 12px 0 0">
              <h2 style="color:white;margin:0;font-size:16px">${company.name}</h2>
            </div>
            <div style="background:white;padding:24px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px">
              <p style="margin:0 0 12px">Hallo ${projectLead.full_name},</p>
              <p style="margin:0 0 16px">Termin-Benachrichtigung für deinen Auftrag:</p>
              <div style="background:#f5f5f5;padding:16px;border-radius:8px;border-left:4px solid #3b82f6;margin:0 0 16px">
                <p style="margin:0 0 4px;font-weight:600">${appt.title}</p>
                <p style="margin:0 0 4px;color:#666">${apptDate} um ${apptTime} Uhr</p>
                <p style="margin:0 0 4px;color:#666">Kunde: ${customer?.name || "-"}</p>
                ${location ? `<p style="margin:0 0 4px;color:#666">Standort: ${location.name}</p>` : ""}
                ${assignee ? `<p style="margin:0 0 4px;color:#666">Zugewiesen an: ${assignee.full_name}</p>` : ""}
                ${meetingBlock}
              </div>
              <hr style="border:none;border-top:1px solid #eee;margin:16px 0"/>
              <p style="margin:0;color:#bbb;font-size:11px">${formatMailFooter(company)}</p>
            </div>
          </div>
        `,
      });
      sentTo.push(`Projektleiter: ${projectLead.email}`);
    } catch (e) { logError("appointments.notify.projectLead", e, { email: projectLead.email }); failed.push(projectLead.email); }
  }

  // E-Mail an zugewiesenen Techniker (wenn nicht gleich Projektleiter)
  if (assignee?.email && assignee.email !== projectLead?.email) {
    try {
      await resend.emails.send({
        from: formatMailFrom(company, "noreply@eventline-basel.com"),
        to: assignee.email,
        subject: `Termin zugeteilt: ${appt.title} – ${apptDate}`,
        html: `
          <div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto">
            <div style="background:#1a1a1a;padding:20px 24px;border-radius:12px 12px 0 0">
              <h2 style="color:white;margin:0;font-size:16px">${company.name}</h2>
            </div>
            <div style="background:white;padding:24px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px">
              <p style="margin:0 0 12px">Hallo ${assignee.full_name},</p>
              <p style="margin:0 0 16px">Dir wurde folgender Termin zugeteilt:</p>
              <div style="background:#f5f5f5;padding:16px;border-radius:8px;border-left:4px solid #ef4444;margin:0 0 16px">
                <p style="margin:0 0 4px;font-weight:600">${appt.title}</p>
                <p style="margin:0 0 4px;color:#666">${apptDate} um ${apptTime} Uhr</p>
                <p style="margin:0 0 4px;color:#666">Kunde: ${customer?.name || "-"}</p>
                ${location ? `<p style="margin:0 0 4px;color:#666">Standort: ${location.name}</p>` : ""}
                ${meetingBlock}
              </div>
              <hr style="border:none;border-top:1px solid #eee;margin:16px 0"/>
              <p style="margin:0;color:#bbb;font-size:11px">${formatMailFooter(company)}</p>
            </div>
          </div>
        `,
      });
      sentTo.push(`Techniker: ${assignee.email}`);
    } catch (e) { logError("appointments.notify.assignee", e, { email: assignee.email }); failed.push(assignee.email); }
  }

  // Weitere zugewiesene Techniker — Hard-Cap bei 20 Mails pro Aufruf damit
  // ein Auftrag mit 50+ Assignments nicht in einer Aktion 50+ externe Mails
  // ausloest (Resend-Quota + Reputation-Risiko).
  const MAX_RECIPIENTS = 20;
  if (apptAssignees) {
    const seenEmails = new Set<string>();
    for (const a of apptAssignees as Array<{ profile?: { full_name: string; email: string | null } | { full_name: string; email: string | null }[] | null }>) {
      if (sentTo.length + failed.length >= MAX_RECIPIENTS) break;
      // Supabase liefert join je nach FK-Typ als Single oder Array — beides
      // normalisieren auf Single (assigned_to ist FK 1:1).
      const profile = Array.isArray(a.profile) ? a.profile[0] : a.profile;
      const techEmail = profile?.email;
      if (techEmail && !seenEmails.has(techEmail) && techEmail !== projectLead?.email && techEmail !== assignee?.email) {
        seenEmails.add(techEmail);
        try {
          await resend.emails.send({
            from: formatMailFrom(company, "noreply@eventline-basel.com"),
            to: techEmail,
            subject: `Termin: ${appt.title} – ${apptDate} (${customer?.name || ""})`,
            html: `
              <div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto">
                <div style="background:#1a1a1a;padding:20px 24px;border-radius:12px 12px 0 0">
                  <h2 style="color:white;margin:0;font-size:16px">${company.name}</h2>
                </div>
                <div style="background:white;padding:24px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px">
                  <p style="margin:0 0 12px">Hallo ${profile?.full_name ?? ""},</p>
                  <p style="margin:0 0 16px">Termin-Info für Auftrag <strong>${job.title}</strong>:</p>
                  <div style="background:#f5f5f5;padding:16px;border-radius:8px;border-left:4px solid #ef4444;margin:0 0 16px">
                    <p style="margin:0 0 4px;font-weight:600">${appt.title}</p>
                    <p style="margin:0 0 4px;color:#666">${apptDate} um ${apptTime} Uhr</p>
                    ${location ? `<p style="margin:0;color:#666">Standort: ${location.name}</p>` : ""}
                  </div>
                  <hr style="border:none;border-top:1px solid #eee;margin:16px 0"/>
                  <p style="margin:0;color:#bbb;font-size:11px">${formatMailFooter(company)}</p>
                </div>
              </div>
            `,
          });
          sentTo.push(`Techniker: ${techEmail}`);
        } catch (e) { logError("appointments.notify.tech", e, { email: techEmail }); failed.push(techEmail); }
      }
    }
  }

  // Zusätzliche E-Mail-Adresse
  if (additional_email && additional_email.includes("@")) {
    try {
      await resend.emails.send({
        from: formatMailFrom(company, "noreply@eventline-basel.com"),
        to: additional_email,
        subject: `Terminbestätigung: ${appt.title}`,
        html: `
          <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto">
            <div style="background:#1a1a1a;padding:20px 24px;border-radius:12px 12px 0 0">
              <h2 style="color:white;margin:0;font-size:16px">${company.name}</h2>
            </div>
            <div style="background:white;padding:24px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px">
              <p style="margin:0 0 12px">Guten Tag,</p>
              <p style="margin:0 0 16px">Wir bestätigen folgenden Termin:</p>
              <div style="background:#f5f5f5;padding:16px;border-radius:8px;border-left:4px solid #3b82f6;margin:0 0 16px">
                <p style="margin:0 0 4px;font-weight:600;font-size:16px">${appt.title}</p>
                <p style="margin:0 0 4px;color:#666">${apptDate} um ${apptTime} Uhr</p>
                ${location ? `<p style="margin:0 0 4px;color:#666">Standort: ${location.name}</p>` : ""}
                ${job?.title ? `<p style="margin:0;color:#666">Auftrag: ${job.title}</p>` : ""}
              </div>
              <p style="margin:0 0 8px;color:#999;font-size:13px">Bei Fragen erreichen Sie uns unter info@eventline-basel.com</p>
              <hr style="border:none;border-top:1px solid #eee;margin:16px 0"/>
              <p style="margin:0;color:#bbb;font-size:11px">${formatMailFooter(company)}</p>
            </div>
          </div>
        `,
      });
      sentTo.push(additional_email);
    } catch (e) { logError("appointments.notify.additional", e, { email: additional_email }); failed.push(additional_email); }
  }

  return NextResponse.json({ success: true, sentTo, failed });
}
