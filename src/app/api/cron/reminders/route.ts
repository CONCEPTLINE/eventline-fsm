import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import { logError } from "@/lib/log";
import { localDateIso, todayLocalIso } from "@/lib/swiss-time";
import { notifyTodoOverdue } from "@/lib/notification-service";
import { loadCompanySettings, formatMailFooter } from "@/lib/company-settings";
import { sendMailBatch, mailRahmen, isMailConfigured } from "@/lib/mail";

export async function GET(request: Request) {
  // Cron-Secret HARD-PFLICHT — wenn die ENV-Var fehlt, ist der Endpoint
  // sonst oeffentlich (jeder kann Reminders-Mails an alle Mitarbeiter
  // triggern). Vercel-Cron schickt den Header automatisch; ohne Secret
  // gibts auch lokal keinen Bypass mehr (vorher pruefte er auf
  // VERCEL_URL.includes("localhost") was auf Vercel nie greift, also
  // toter Code, und ohne CRON_SECRET liess er einfach durch).
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: "CRON_SECRET fehlt in der Server-Config" }, { status: 503 });
  }
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();

  // Notifications-Cleanup: alles aelter als 90 Tage wird geloescht damit
  // die Tabelle bei mehrjaehriger Nutzung nicht ungebremst waechst (vor
  // allem die Stempel-Reminder-Notifications die alle 30min entstehen).
  //
  // Batched in 5000er-Chunks: ein einziges DELETE auf 100k+ Zeilen kann
  // das pg_replication-WAL ueberlaufen lassen oder Locks fuer mehrere
  // Sekunden halten. Loop mit early-exit wenn weniger als BATCH_SIZE
  // geloescht wurden (= keine weiteren Kandidaten mehr).
  const cleanupCutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const BATCH_SIZE = 5000;
  let deletedNotifications = 0;
  for (let i = 0; i < 200; i++) { // safety-cap: max 1M rows pro Cron-Run
    const { data: batch } = await supabase
      .from("notifications")
      .select("id")
      .lt("created_at", cleanupCutoff)
      .limit(BATCH_SIZE);
    if (!batch || batch.length === 0) break;
    const ids = batch.map((r) => r.id);
    const { count } = await supabase
      .from("notifications")
      .delete({ count: "exact" })
      .in("id", ids);
    deletedNotifications += count ?? 0;
    if (batch.length < BATCH_SIZE) break;
  }

  if (!isMailConfigured()) {
    return NextResponse.json({
      success: true,
      message: "Kein RESEND_API_KEY — nur Cleanup gemacht",
      cleanup: deletedNotifications ?? 0,
    });
  }

  const company = await loadCompanySettings(supabase);

  // Morgen im Europe/Zurich-Kalender — Cron laeuft UTC, ohne Konvert
  // wuerde "morgen" zwischen 22:00-00:00 UTC schon der uebernaechste
  // ZRH-Tag sein.
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const tomorrowStr = localDateIso(tomorrow);

  // Todos finden die morgen fällig sind, noch offen, und jemandem zugewiesen
  const { data: todos } = await supabase
    .from("todos")
    .select("*, assignee:profiles!assigned_to(full_name, email)")
    .eq("status", "offen")
    .eq("due_date", tomorrowStr)
    .not("assigned_to", "is", null);

  if (!todos || todos.length === 0) {
    return NextResponse.json({ success: true, message: "Keine Erinnerungen zu senden", count: 0, cleanup: deletedNotifications ?? 0 });
  }

  // Mails als Batch (vorher seriell: N x HTTP-Latenz = Timeout-Risiko bei
  // vielen faelligen Todos).
  type TodoWithAssignee = typeof todos[number] & {
    assignee: { full_name: string; email: string } | null;
  };
  const mails = (todos as TodoWithAssignee[])
    .filter((todo) => !!todo.assignee?.email)
    .map((todo) => {
      const assignee = todo.assignee!;
      const formattedDate = new Date(todo.due_date + "T12:00:00Z").toLocaleDateString("de-CH", {
        timeZone: "Europe/Zurich", weekday: "long", day: "numeric", month: "long", year: "numeric",
      });
      return {
        to: assignee.email,
        subject: `Erinnerung: ${todo.title} – fällig morgen`,
        html: mailRahmen({
          titel: company.name,
          inhaltHtml: `
            <p style="margin:0 0 12px">Hallo ${assignee.full_name},</p>
            <p style="margin:0 0 16px">Du hast eine Aufgabe die <strong>morgen fällig</strong> ist:</p>
            <div style="background:#f5f5f5;padding:16px;border-radius:8px;border-left:4px solid #ef4444;margin:0 0 16px">
              <p style="margin:0 0 4px;font-weight:600;font-size:16px">${todo.title}</p>
              <p style="margin:0 0 4px;color:#666">Fällig: ${formattedDate}</p>
              ${todo.description ? `<p style="margin:8px 0 0;color:#666;font-size:14px">${todo.description}</p>` : ""}
            </div>
            <p style="margin:0 0 8px;color:#999;font-size:13px">
              Öffne die App um die Aufgabe zu bearbeiten.
            </p>
            <hr style="border:none;border-top:1px solid #eee;margin:16px 0"/>
            <p style="margin:0;color:#bbb;font-size:11px">${formatMailFooter(company)}</p>
          `,
        }),
        label: `${assignee.full_name}: ${todo.title}`,
        todoId: todo.id as string,
      };
    });

  const batchResult = await sendMailBatch(mails);
  const sent = batchResult.sent.map((m) => m.label);
  const failed = batchResult.failed.map((f) => f.mail.to as string);
  for (const f of batchResult.failed) {
    logError("cron.reminders.mail", f.error, { recipient: f.mail.to, todoId: f.mail.todoId });
  }

  // ─────────────────────────────────────────────────────────────────
  // Ueberfaellige Todos — Push + Bell-Notification an den Assignee.
  // Laeuft einmal pro Tag (mit dieser Cron), also automatisch idempotent:
  // pro Todo eine Notification pro Tag. Kein Mail-Versand hier — Mail
  // wuerde die Inbox bei mehreren ueberfaelligen Todos zumuellen.
  // ─────────────────────────────────────────────────────────────────
  const todayIso = todayLocalIso();
  const { data: overdue } = await supabase
    .from("todos")
    .select("id, title, due_date, assigned_to")
    .lt("due_date", todayIso)
    .neq("status", "erledigt")
    .is("deleted_at", null) // geloeschte Todos nicht mehr pingen
    .not("assigned_to", "is", null)
    .not("due_date", "is", null);

  let overdueNotified = 0;
  for (const t of (overdue ?? []) as Array<{ id: string; title: string; due_date: string; assigned_to: string }>) {
    try {
      // Tage-Differenz im Europe/Zurich-Kalender (Datum minus Datum,
      // beides als YYYY-MM-DD aus der DB).
      const [dy, dm, dd] = t.due_date.split("-").map(Number);
      const [ty, tm, td] = todayIso.split("-").map(Number);
      const dueMs = Date.UTC(dy, dm - 1, dd);
      const todayMs = Date.UTC(ty, tm - 1, td);
      const daysOverdue = Math.max(1, Math.round((todayMs - dueMs) / (24 * 60 * 60 * 1000)));
      await notifyTodoOverdue(supabase, {
        recipients: [t.assigned_to],
        todoId: t.id,
        title: t.title,
        dueDateIso: t.due_date,
        daysOverdue,
      });
      overdueNotified++;
    } catch (e) {
      logError("cron.reminders.todo-overdue", e, { todoId: t.id });
    }
  }

  return NextResponse.json({
    success: true,
    count: sent.length,
    sent,
    failed,
    overdue_notified: overdueNotified,
    cleanup: deletedNotifications ?? 0,
  });
}
