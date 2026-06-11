import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/api-auth";
import { notifySystem } from "@/lib/notification-service";

// POST: Notification fuer einen oder mehrere User / Rollen anlegen.
//
// Admin-only: Phishing-Schutz. Nur Admins koennen via dieser Route
// In-App-Notifications mit beliebigem Title/Link an User schicken.
//
// Geht durch den NotificationService — damit werden auch hier
// user_notification_settings.channels respektiert (User der den
// 'system'-Typ ausgeschaltet hat bekommt keine).
//
// Payload-Optionen (mind. EINE der drei muss gesetzt sein):
//   - userIds:     string[] | string  — gezielte User
//   - targetRoles: string[]           — alle aktiven User mit diesen Rollen
//   - targetAll:   boolean            — alle aktiven User (Broadcast)
export async function POST(request: NextRequest) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const { userIds, targetRoles, targetAll, title, message, link } = await request.json();

  if (!title) {
    return NextResponse.json({ success: false, error: "title ist erforderlich" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const recipientSet = new Set<string>();

  if (userIds) {
    const ids = Array.isArray(userIds) ? userIds : [userIds];
    for (const id of ids) recipientSet.add(id);
  }
  if (Array.isArray(targetRoles) && targetRoles.length > 0) {
    const { data } = await supabase
      .from("profiles")
      .select("id")
      .in("role", targetRoles)
      .eq("is_active", true);
    for (const p of data ?? []) recipientSet.add(p.id);
  }
  if (targetAll === true) {
    const { data } = await supabase
      .from("profiles")
      .select("id")
      .eq("is_active", true);
    for (const p of data ?? []) recipientSet.add(p.id);
  }

  if (recipientSet.size === 0) {
    return NextResponse.json({ success: false, error: "Keine Empfaenger" }, { status: 400 });
  }

  await notifySystem(supabase, {
    recipients: Array.from(recipientSet),
    title,
    message: message || null,
    link: link || null,
  });

  return NextResponse.json({ success: true, sent: recipientSet.size });
}
