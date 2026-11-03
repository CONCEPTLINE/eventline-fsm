// POST /api/tickets/notify — In-App-Notification fuer Ticket-Events.
// Events:
//   "created"          → an alle User mit 'tickets:manage' (Admin +
//                        Custom-Rollen mit dieser Permission); bei Belegen
//                        bekommt die Person «abgesprochen mit» eine eigene
//                        Nachricht (notifyBelegAbgesprochen)
//   "status_changed"   → an Ersteller (Manager hat erledigt/abgelehnt)
//
// Notifications gehen via zentralem NotificationService, der die
// per-User-Settings (user_notification_settings.channels) respektiert.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireInternal } from "@/lib/api-auth";
import {
  notifyTicketNew,
  notifyTicketDone,
  notifyTicketRejected,
  notifyBelegAbgesprochen,
} from "@/lib/notification-service";
import { personenMitRecht } from "@/lib/rechte-empfaenger";

export async function POST(request: Request) {
  const auth = await requireInternal();
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null);
  if (!body?.ticket_id || !body?.event) {
    return NextResponse.json({ success: false, error: "ticket_id + event noetig" }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: ticket } = await admin
    .from("tickets")
    .select("id, type, status, title, ticket_number, created_by, data, creator:profiles!created_by(full_name)")
    .eq("id", body.ticket_id)
    .maybeSingle();

  if (!ticket) {
    return NextResponse.json({ success: false, error: "Ticket nicht gefunden" }, { status: 404 });
  }

  type TicketRow = {
    id: string;
    type: string;
    status: string;
    title: string;
    ticket_number: number;
    created_by: string;
    data: { genehmigt_von_user_id?: unknown; betrag_chf?: unknown } | null;
    creator: { full_name: string } | { full_name: string }[] | null;
  };
  const t = ticket as unknown as TicketRow;
  const creatorName = Array.isArray(t.creator) ? t.creator[0]?.full_name : t.creator?.full_name;

  if (body.event === "created") {
    // Empfaenger = alle aktiven internen Konten mit 'tickets:manage'
    // (Admins immer, Custom-Rollen via Rollen-Matrix) — personenMitRecht.
    const manager = await personenMitRecht(admin, "tickets:manage");
    let recipientIds = manager.map((m) => m.id).filter((id) => id !== t.created_by);

    // Beleg «abgesprochen mit»: diese Person bekommt eine eigene Nachricht
    // (statt der allgemeinen), damit sie weiss, dass es um ihre Absprache geht.
    const abgesprochenMit = t.type === "beleg" ? t.data?.genehmigt_von_user_id : undefined;
    if (typeof abgesprochenMit === "string" && abgesprochenMit !== t.created_by) {
      recipientIds = recipientIds.filter((id) => id !== abgesprochenMit);
      await notifyBelegAbgesprochen(admin, {
        recipients: [abgesprochenMit],
        ticketId: t.id,
        betragChf: typeof t.data?.betrag_chf === "number" ? t.data.betrag_chf : null,
        byName: creatorName ?? "Unbekannt",
      });
    }

    await notifyTicketNew(admin, {
      recipients: recipientIds,
      ticketId: t.id,
      ticketNumber: t.ticket_number,
      ticketTitle: t.title,
      ticketType: t.type,
      byName: creatorName ?? "Unbekannt",
    });
    return NextResponse.json({ success: true, sent: recipientIds.length });
  }

  if (body.event === "status_changed") {
    const byName = (typeof body.by_name === "string" && body.by_name.trim()) ? body.by_name.trim() : "Admin";
    if (t.status === "abgelehnt") {
      await notifyTicketRejected(admin, {
        recipients: [t.created_by],
        ticketId: t.id,
        ticketNumber: t.ticket_number,
        ticketTitle: t.title,
        reason: (typeof body.note === "string" && body.note.trim()) ? body.note.trim() : "Kein Grund angegeben",
        byName,
      });
    } else {
      await notifyTicketDone(admin, {
        recipients: [t.created_by],
        ticketId: t.id,
        ticketNumber: t.ticket_number,
        ticketTitle: t.title,
        byName,
      });
    }
    return NextResponse.json({ success: true, sent: 1 });
  }

  return NextResponse.json({ success: false, error: `Unbekanntes event: ${body.event}` }, { status: 400 });
}
