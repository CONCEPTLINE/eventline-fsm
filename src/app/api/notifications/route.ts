import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/api-auth";
import { notifySystem } from "@/lib/notification-service";

// POST: Notification an gezielte User anlegen.
//
// Admin-only: Phishing-Schutz. Nur Admins koennen via dieser Route
// In-App-Notifications mit beliebigem Title/Link an User schicken.
// Aktueller Aufrufer: /todos (Todo-Zuweisung + Erinnerung).
//
// Geht durch den NotificationService — user_notification_settings.channels
// werden respektiert (User der den 'system'-Typ ausgeschaltet hat bekommt keine).
//
// Payload:
//   - userIds: string[] | string  — gezielte User (Pflicht)
export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const { userIds, title, message, link } = await request.json();

  if (!title) {
    return NextResponse.json({ success: false, error: "title ist erforderlich" }, { status: 400 });
  }

  const ids = Array.isArray(userIds) ? userIds : userIds ? [userIds] : [];
  const recipients = Array.from(new Set(ids));

  if (recipients.length === 0) {
    return NextResponse.json({ success: false, error: "Keine Empfaenger" }, { status: 400 });
  }

  const supabase = createAdminClient();
  await notifySystem(supabase, {
    recipients,
    title,
    message: message || null,
    link: link || null,
  });

  return NextResponse.json({ success: true, sent: recipients.length });
}
