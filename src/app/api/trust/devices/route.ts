// GET    /api/trust/devices             — eigene Geraete-Liste (Status, Name, last_seen).
// POST   /api/trust/devices             — Vertrauens-Anfrage fuer das aktuelle Geraet
//                                         starten. Cookie wird gesetzt, Email an
//                                         admin@eventline-basel.com geschickt.
//                                         Body: { device_name: string }
// DELETE /api/trust/devices?id=...      — eigenes Geraet widerrufen.
//
// Auth: requireUser. Jeder eingeloggte Mitarbeiter kann seine eigenen
// Geraete sehen/anlegen/widerrufen.

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser, hashToken, TRUSTED_DEVICE_COOKIE } from "@/lib/api-auth";
import { Resend } from "resend";
import { logError } from "@/lib/log";

// Bestaetigungs-Mail geht IMMER an die zentrale Admin-Mailbox — siehe
// Migration 115 Kommentar fuer Begruendung.
const APPROVAL_EMAIL_RECIPIENT = "admin@eventline-basel.com";
const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export async function GET(request: Request) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const showAll = url.searchParams.get("all") === "true";
  const admin = createAdminClient();

  // Admin-Sicht: alle Geraete aller User mit Profile-Info (full_name/email).
  // Permission-Check: nur role='admin' kommt durch.
  if (showAll) {
    const { data: profile } = await admin
      .from("profiles")
      .select("role")
      .eq("id", auth.user.id)
      .single();
    if (profile?.role !== "admin") {
      return NextResponse.json({ success: false, error: "Nur Admins" }, { status: 403 });
    }
    const { data, error } = await admin
      .from("trusted_devices")
      .select("id, user_id, device_name, user_agent_hint, status, requested_at, approved_at, last_seen_at, expires_at, profiles:profiles!user_id(full_name, email)")
      .is("revoked_at", null)
      .order("last_seen_at", { ascending: false });
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, devices: data ?? [] });
  }

  // Default: eigene Geraete-Liste.
  const { data, error } = await admin
    .from("trusted_devices")
    .select("id, device_name, user_agent_hint, status, requested_at, approved_at, last_seen_at, expires_at")
    .eq("user_id", auth.user.id)
    .is("revoked_at", null)
    .order("requested_at", { ascending: false });
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, devices: data ?? [] });
}

export async function POST(request: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ success: false, error: "Ungueltiger Body" }, { status: 400 });

  const device_name = typeof body.device_name === "string" ? body.device_name.trim() : "";
  if (!device_name) return NextResponse.json({ success: false, error: "Geraete-Name fehlt" }, { status: 400 });
  if (device_name.length > 60) return NextResponse.json({ success: false, error: "Geraete-Name max. 60 Zeichen" }, { status: 400 });

  // 256-Bit Random Tokens — Cookie + Confirm-Link.
  const cookieToken = randomBytes(32).toString("base64url");
  const confirmToken = randomBytes(32).toString("base64url");
  const cookieHash = hashToken(cookieToken);
  const confirmHash = hashToken(confirmToken);

  // User-Profil fuer Email-Kontext.
  const admin = createAdminClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("full_name, email")
    .eq("id", auth.user.id)
    .maybeSingle();

  const userAgentHint = request.headers.get("user-agent")?.slice(0, 200) ?? null;
  const ipHint = (request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip"))?.split(",")[0].trim() ?? null;

  const { data: row, error: insErr } = await admin
    .from("trusted_devices")
    .insert({
      user_id: auth.user.id,
      cookie_token_hash: cookieHash,
      confirm_token_hash: confirmHash,
      device_name,
      user_agent_hint: userAgentHint,
      ip_hint: ipHint,
      status: "pending",
    })
    .select("id")
    .single();
  if (insErr || !row) {
    return NextResponse.json({ success: false, error: insErr?.message ?? "Insert fehlgeschlagen" }, { status: 500 });
  }

  // Email an Admin-Mailbox.
  if (process.env.RESEND_API_KEY) {
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const confirmUrl = `${APP_BASE_URL}/api/trust/confirm?token=${encodeURIComponent(confirmToken)}`;
      const userLabel = profile?.full_name ? `${profile.full_name} (${profile.email})` : profile?.email ?? auth.user.id;

      await resend.emails.send({
        from: "EVENTLINE <noreply@eventline-basel.com>",
        to: APPROVAL_EMAIL_RECIPIENT,
        subject: `[EVENTLINE] Neues vertrautes Geraet: ${device_name}`,
        html: `
          <div style="font-family:Inter,system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#111">
            <h2 style="margin:0 0 16px;font-size:18px">Neues vertrautes Geraet anfragen</h2>
            <p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:#444">
              <strong>${escapeHtml(userLabel)}</strong> hat angefragt, ein neues Geraet als vertraut zu markieren.
              Erst nach Bestaetigung dieses Links kann das Geraet auf Finanzen + Loehne zugreifen.
            </p>
            <table style="border-collapse:collapse;margin:16px 0;font-size:13px;color:#444">
              <tr><td style="padding:4px 12px 4px 0;color:#888">Geraete-Name</td><td><strong>${escapeHtml(device_name)}</strong></td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#888">Browser/OS</td><td>${escapeHtml(userAgentHint ?? "—")}</td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#888">IP</td><td>${escapeHtml(ipHint ?? "—")}</td></tr>
              <tr><td style="padding:4px 12px 4px 0;color:#888">Zeitpunkt</td><td>${new Date().toLocaleString("de-CH", { timeZone: "Europe/Zurich" })}</td></tr>
            </table>
            <p style="margin:24px 0">
              <a href="${confirmUrl}" style="display:inline-block;padding:10px 18px;background:#10b981;color:white;text-decoration:none;border-radius:8px;font-size:14px;font-weight:500">
                Geraet bestaetigen
              </a>
            </p>
            <p style="margin:0;font-size:12px;color:#888;line-height:1.5">
              Wenn diese Anfrage NICHT von ${escapeHtml(userLabel)} kommt: einfach diese Mail ignorieren — das Geraet bleibt blockiert
              und der Zugriff auf Finanzen/Loehne ist verweigert.
            </p>
          </div>
        `,
      });
    } catch (e) {
      logError("trust.email", e);
      // Wir blocken die Anfrage nicht wenn die Email-Versand fehlschlaegt —
      // Admin sieht die pending-Row dennoch in der Geraete-Liste und kann
      // dort approven (Mein-Konto-UI). Email ist Convenience, kein Mandat.
    }
  }

  // Cookie auf das anfragende Geraet setzen. 1 Jahr, HttpOnly, Secure-in-Prod,
  // SameSite=Lax (damit Email-Klick aus anderem Origin den Cookie nicht verliert
  // — Lax laesst Top-Level-Navigations durch).
  const res = NextResponse.json({ success: true, device_id: row.id, pending: true });
  res.cookies.set(TRUSTED_DEVICE_COOKIE, cookieToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365, // 1 Jahr
  });
  return res;
}

export async function DELETE(request: Request) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return NextResponse.json({ success: false, error: "id fehlt" }, { status: 400 });

  const admin = createAdminClient();
  // Admin darf JEDES Geraet revoken (Security-Audit-Pfad), User nur seine
  // eigenen. Erst Profile-Rolle pruefen, dann den Update auf den Owner
  // (oder beliebig wenn Admin) einschraenken.
  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", auth.user.id)
    .single();
  const isAdmin = profile?.role === "admin";

  const updateQuery = admin
    .from("trusted_devices")
    .update({ revoked_at: new Date().toISOString(), status: "revoked" })
    .eq("id", id);
  const { error } = isAdmin
    ? await updateQuery
    : await updateQuery.eq("user_id", auth.user.id);
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}

// Kleiner HTML-Escape-Helper — Resend rendert das HTML rein, daher
// jegliche User-Inputs (device_name, full_name, etc.) muessen escaped sein.
function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
