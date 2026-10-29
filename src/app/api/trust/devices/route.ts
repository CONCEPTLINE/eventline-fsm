// GET    /api/trust/devices             — eigene Geraete-Liste (Status, Name, last_seen).
// GET    /api/trust/devices?all=true    — alle Geraete (nur Admins), inkl. offener Anfragen.
// POST   /api/trust/devices             — Vertrauens-Anfrage fuer das aktuelle Geraet
//                                         starten. Cookie wird gesetzt, die anderen
//                                         Admins + die Vertretung werden benachrichtigt
//                                         (Glocke + Mail an die Admin-Mailbox).
//                                         Body: { device_name: string }
// DELETE /api/trust/devices?id=...      — Geraet widerrufen (eigenes; Admins jedes).
//
// Lohn-Umbau Phase 1 (Geraetesperre, gilt auch fuer die Finanzen):
//   - KEIN Schnellweg mehr: frueher gab ein bereits freigegebenes Geraet mit
//     gleichem Browser-Typ (Fingerprint aus User-Agent) sofort Zugang. Jetzt
//     braucht jedes neue Geraet eine Freigabe.
//   - Freigabe nur per Knopf durch den ANDEREN Admin oder die Vertretung,
//     angemeldet, innerhalb von 24 h (/api/trust/freigabe, Seite /geraet-freigabe).
//     Der Link in der Mail gibt nicht schon beim Oeffnen frei.
//   - Bestehende Freigaben bleiben gueltig. Schreiben nur ueber den Server
//     (Migration 360 entzieht dem Browser die Rechte auf trusted_devices).
//   - Notweg (beide Admins ohne Geraet): scripts/geraet-notfreigabe.mjs (Mischa,
//     protokolliert).

import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser, requireInternal, hashToken, deviceFingerprint, TRUSTED_DEVICE_COOKIE } from "@/lib/api-auth";
import { logError } from "@/lib/log";
import { sendMail, mailRahmen, isMailConfigured } from "@/lib/mail";
import { logPermissionAudit } from "@/lib/permission-audit";
import { notifySystem } from "@/lib/notification-service";
import { ladeLohnEinstellungen } from "@/lib/lohn/zugriff";
import { ANFRAGE_GUELTIG_STUNDEN } from "@/lib/geraete-freigabe";

// Hinweis-Mail geht an die zentrale Admin-Mailbox (Migration 115). Sie enthaelt
// nur noch einen Link auf die Freigabe-Seite — freigegeben wird dort per Knopf.
const APPROVAL_EMAIL_RECIPIENT = "admin@eventline-basel.com";
const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";

export async function GET(request: Request) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const showAll = url.searchParams.get("all") === "true";
  const admin = createAdminClient();

  // Admin-Sicht: alle Geraete aller User mit Profile-Info (full_name/email).
  if (showAll) {
    const { data: profile, error: pErr } = await admin
      .from("profiles")
      .select("role")
      .eq("id", auth.user.id)
      .single();
    if (pErr) return NextResponse.json({ success: false, error: pErr.message }, { status: 500 });
    if (profile?.role !== "admin") {
      return NextResponse.json({ success: false, error: "Nur Admins" }, { status: 403 });
    }
    const { data, error } = await admin
      .from("trusted_devices")
      .select("id, user_id, device_name, user_agent_hint, status, requested_at, approved_at, approved_by_name, freigabe_art, anfrage_gueltig_bis, last_seen_at, expires_at, profiles:profiles!user_id(full_name, email)")
      .is("revoked_at", null)
      .order("last_seen_at", { ascending: false });
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, devices: data ?? [], me: auth.user.id });
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

/** Hoechstens so viele offene Anfragen je Person in 24 h (Glocke/Mail-Flut). */
const MAX_OFFENE_ANFRAGEN = 3;

export async function POST(request: NextRequest) {
  // Nur EVENTLINE-Konten (keine Portal-Konten) koennen Geraete anfragen.
  const auth = await requireInternal({ wartung: "geraete" });
  if (auth.error) return auth.error;
  if (auth.isImpersonating) {
    return NextResponse.json({ success: false, error: "In «Ansicht als» kann kein Gerät angefragt werden." }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ success: false, error: "Ungültiger Body" }, { status: 400 });

  const device_name = typeof body.device_name === "string" ? body.device_name.trim() : "";
  if (!device_name) return NextResponse.json({ success: false, error: "Geräte-Name fehlt" }, { status: 400 });
  if (device_name.length > 60) return NextResponse.json({ success: false, error: "Geräte-Name max. 60 Zeichen" }, { status: 400 });

  const { count: offen, error: offenErr } = await createAdminClient()
    .from("trusted_devices")
    .select("id", { count: "exact", head: true })
    .eq("user_id", auth.user.id)
    .eq("status", "pending")
    .gte("requested_at", new Date(Date.now() - ANFRAGE_GUELTIG_STUNDEN * 3600_000).toISOString());
  if (offenErr) return NextResponse.json({ success: false, error: offenErr.message }, { status: 500 });
  if ((offen ?? 0) >= MAX_OFFENE_ANFRAGEN) {
    return NextResponse.json({
      success: false,
      error: `Es sind schon ${offen} Anfragen offen — bitte warten, bis der andere Admin oder die Vertretung entschieden hat.`,
    }, { status: 429 });
  }

  // 256-Bit Random Token fuer das Cookie. Ein Bestaetigungs-Token gibt es
  // nicht mehr (Freigabe nur per Knopf mit Anmeldung).
  const cookieToken = randomBytes(32).toString("base64url");
  const cookieHash = hashToken(cookieToken);

  const admin = createAdminClient();
  const { data: profile, error: profErr } = await admin
    .from("profiles")
    .select("full_name, email")
    .eq("id", auth.user.id)
    .maybeSingle();
  if (profErr) return NextResponse.json({ success: false, error: profErr.message }, { status: 500 });

  const userAgentHint = request.headers.get("user-agent")?.slice(0, 200) ?? null;
  const ipHint = (request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip"))?.split(",")[0].trim() ?? null;
  // Fingerprint nur noch als Info (welcher Browser) — gibt KEINEN Zugang mehr.
  const fp = deviceFingerprint(userAgentHint, auth.user.id);
  const gueltigBis = new Date(Date.now() + ANFRAGE_GUELTIG_STUNDEN * 3600_000).toISOString();

  const { data: row, error: insErr } = await admin
    .from("trusted_devices")
    .insert({
      user_id: auth.user.id,
      cookie_token_hash: cookieHash,
      device_name,
      user_agent_hint: userAgentHint,
      ip_hint: ipHint,
      device_fingerprint: fp,
      status: "pending",
      anfrage_gueltig_bis: gueltigBis,
    })
    .select("id")
    .single();
  if (insErr || !row) {
    return NextResponse.json({ success: false, error: insErr?.message ?? "Insert fehlgeschlagen" }, { status: 500 });
  }

  await logPermissionAudit({
    actor_profile_id: auth.user.id,
    action: "device.requested",
    target_profile_id: auth.user.id,
    details: { device_id: row.id, geraet: device_name },
  });

  const userLabel = profile?.full_name ? `${profile.full_name} (${profile.email})` : profile?.email ?? auth.user.id;
  const freigabePfad = `/geraet-freigabe?id=${encodeURIComponent(row.id as string)}`;

  // Glocke: alle anderen Admins + die Vertretung.
  try {
    const [{ data: admins, error: aErr }, einst] = await Promise.all([
      admin.from("profiles").select("id").eq("role", "admin").eq("is_active", true),
      ladeLohnEinstellungen(admin),
    ]);
    if (aErr) throw new Error(aErr.message);
    const empfaenger = new Set<string>(((admins ?? []) as { id: string }[]).map((a) => a.id));
    if (einst.vertretungProfileId) empfaenger.add(einst.vertretungProfileId);
    empfaenger.delete(auth.user.id);
    if (empfaenger.size > 0) {
      await notifySystem(admin, {
        recipients: Array.from(empfaenger),
        title: `Gerät freigeben: ${device_name}`,
        message: `${userLabel} möchte ein neues Gerät für Finanzen und Löhne nutzen. Freigabe innerhalb von ${ANFRAGE_GUELTIG_STUNDEN} h.`,
        link: freigabePfad,
      });
    }
  } catch (e) {
    logError("trust.notify", e);
  }

  // Mail an die Admin-Mailbox: nur ein Link auf die Freigabe-Seite.
  if (isMailConfigured()) {
    const freigabeUrl = `${APP_BASE_URL}${freigabePfad}`;
    const mailRes = await sendMail({
      // Bewusst hartkodierter Absender (kein formatMailFrom) — wie bisher.
      from: "EVENTLINE <noreply@eventline-basel.com>",
      to: APPROVAL_EMAIL_RECIPIENT,
      subject: `[EVENTLINE] Neues vertrautes Gerät: ${device_name}`,
      html: mailRahmen({
        titel: "Neues vertrautes Gerät anfragen",
        inhaltHtml: `
          <p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:#444">
            <strong>${escapeHtml(userLabel)}</strong> möchte ein neues Gerät für Finanzen und Löhne nutzen.
            Freigeben kann nur der andere Admin oder die Vertretung — angemeldet in der App, per Knopf,
            innerhalb von ${ANFRAGE_GUELTIG_STUNDEN} Stunden. Das Öffnen dieses Links gibt noch nichts frei.
          </p>
          <table style="border-collapse:collapse;margin:16px 0;font-size:13px;color:#444">
            <tr><td style="padding:4px 12px 4px 0;color:#888">Geräte-Name</td><td><strong>${escapeHtml(device_name)}</strong></td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#888">Browser/OS</td><td>${escapeHtml(userAgentHint ?? "—")}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#888">IP</td><td>${escapeHtml(ipHint ?? "—")}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#888">Zeitpunkt</td><td>${new Date().toLocaleString("de-CH", { timeZone: "Europe/Zurich" })}</td></tr>
          </table>
          <p style="margin:24px 0">
            <a href="${freigabeUrl}" style="display:inline-block;padding:10px 18px;background:#111827;color:white;text-decoration:none;border-radius:8px;font-size:14px;font-weight:500">
              Anfrage in der App ansehen
            </a>
          </p>
          <p style="margin:0;font-size:12px;color:#888;line-height:1.5">
            Kommt diese Anfrage NICHT von ${escapeHtml(userLabel)}: in der App ablehnen oder ignorieren —
            ohne Freigabe bleibt das Gerät blockiert.
          </p>
        `,
      }),
    });
    if (!mailRes.ok) logError("trust.email", mailRes.error);
  }

  // Cookie auf das anfragende Geraet setzen. 1 Jahr, HttpOnly, Secure-in-Prod.
  const res = NextResponse.json({ success: true, device_id: row.id, pending: true, gueltig_bis: gueltigBis });
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
  // Admin darf JEDES Geraet widerrufen (Security-Audit-Pfad), User nur eigene.
  const { data: profile, error: pErr } = await admin
    .from("profiles")
    .select("role")
    .eq("id", auth.user.id)
    .single();
  if (pErr) return NextResponse.json({ success: false, error: pErr.message }, { status: 500 });
  const isAdmin = profile?.role === "admin";

  const updateQuery = admin
    .from("trusted_devices")
    .update({ revoked_at: new Date().toISOString(), status: "revoked" }, { count: "exact" })
    .eq("id", id);
  const { data: widerrufen, error, count } = isAdmin
    ? await updateQuery.select("user_id, device_name")
    : await updateQuery.eq("user_id", auth.user.id).select("user_id, device_name");
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  if (!count) return NextResponse.json({ success: false, error: "Gerät nicht gefunden" }, { status: 404 });
  const geraet = (widerrufen ?? [])[0] as { user_id: string; device_name: string } | undefined;
  await logPermissionAudit({
    actor_profile_id: auth.user.id,
    action: "device.revoked",
    target_profile_id: geraet?.user_id ?? auth.user.id,
    details: { device_id: id, geraet: geraet?.device_name ?? null },
  });
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
