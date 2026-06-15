// POST /api/admin/users — neuen User anlegen.
// Flow: Admin gibt Email + Name + Rolle ein → Auth-User wird erstellt
// (mit Zufalls-Passwort, das der User nie sieht), Profil-Row wird angelegt,
// dann wird eine Reset-Mail an den User geschickt damit er sich selbst
// ein Passwort setzt. Der Reset-Link landet auf /passwort-reset.

import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { Resend } from "resend";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/api-auth";
import { appUrl } from "@/lib/app-url";
import { logError } from "@/lib/log";

export async function POST(request: Request) {
  try {
    // Env-Vars upfront pruefen damit ein fehlender Key sofort eine
    // klare Meldung liefert statt einem cryptic Internal Server Error.
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceKey) {
      logError("admin.users.create.env", { hasUrl: !!supabaseUrl, hasKey: !!serviceKey });
      return NextResponse.json(
        { success: false, error: "Server-Konfiguration unvollstaendig (SUPABASE-ENV fehlt)" },
        { status: 500 },
      );
    }

  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ success: false, error: "Ungueltiger Body" }, { status: 400 });

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const full_name = typeof body.full_name === "string" ? body.full_name.trim() : "";
  const requestedRole = typeof body.role === "string" ? body.role : "techniker";
  // Geburtsdatum optional (YYYY-MM-DD). Wird fuer Ferienanteil-Auto-
  // Erkennung gebraucht (<20 Jahre -> 10.64% statt 8.33%).
  const birthdate = typeof body.birthdate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.birthdate)
    ? body.birthdate
    : null;

  if (!email || !full_name) {
    return NextResponse.json({ success: false, error: "Email und Name sind Pflicht" }, { status: 400 });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ success: false, error: "Ungueltige Email-Adresse" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Pre-Check: existiert die Email schon? profiles.email hat einen
  // UNIQUE-Index, der "Wahrheits-Quelle" fuer "User existiert" ist.
  // Vorher ohne den Check gab der Auth-Trigger einen cryptic "Internal
  // Server Error" weil der INSERT in profiles wegen email-unique scheiterte.
  const { data: existing } = await admin
    .from("profiles")
    .select("id, email, is_active")
    .eq("email", email)
    .maybeSingle();
  if (existing) {
    return NextResponse.json(
      {
        success: false,
        error: `Es gibt bereits einen Benutzer mit Email ${email}${existing.is_active ? "" : " (deaktiviert)"}. Falls Passwort-Reset gewünscht, nutze den "Passwort zurücksetzen"-Knopf in der User-Liste.`,
      },
      { status: 400 },
    );
  }

  // Rolle muss in der roles-Tabelle existieren — sonst kann der User
  // spaeter nicht aufgeloest werden.
  const { data: roleRow } = await admin.from("roles").select("slug").eq("slug", requestedRole).single();
  const role = roleRow?.slug ?? "techniker";

  const created = await createAuthUser({ supabaseUrl, serviceKey, email, fullName: full_name, role, birthdate });
  if (!created.success) {
    return NextResponse.json(
      { success: false, error: created.error, debug: created.debug },
      { status: 400 },
    );
  }

  // Setup-Mail mit Reset-Link via Resend — Supabase's Default-Mailer
  // ist unzuverlaessig (Rate-Limit, Spam-Filter). Wir generieren den
  // Recovery-Link via Auth-Admin-API und schicken die Mail dann selbst
  // ueber Resend, das die App eh schon fuer Termin-Mails nutzt.
  const mail = await sendSetupMail({ supabaseUrl, serviceKey, email, fullName: full_name });

  return NextResponse.json({
    success: true,
    user_id: created.userId,
    mail_warning: mail.success ? undefined : mail.error,
  });
  } catch (err) {
    // Statt generic 500 → konkrete Meldung zurueck. Hilft beim Debugging
    // von Edge-Cases (Service-Role-Key falsch, Trigger-Konflikte, etc.)
    const message = err instanceof Error ? err.message : "Unbekannter Fehler beim Anlegen";
    logError("admin.users.create.exception", err);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

// Legt einen Auth-User per direktem Fetch gegen die Supabase Auth-Admin-
// API an. Wir umgehen das supabase-js SDK weil es im Next.js-Server-
// Runtime mit "AuthApiError: Internal Server Error" gescheitert ist,
// obwohl derselbe Payload direkt per curl funktioniert.
//
// email_confirm:true → keine Bestaetigungsmail; Random-Passwort weil
// der User sich's eh per Reset-Link selbst setzt. full_name + role
// landen via user_metadata in der raw_user_meta_data — der Postgres-
// Trigger handle_new_user() liest das aus und legt damit selbst die
// profiles-Row an. Anschliessend updaten wir das Profil idempotent
// (Sicherheits-Netz falls der Trigger die Rolle nicht uebernommen hat).
//
// Bei Fehler im Profil-Update wird der Auth-User wieder geloescht
// damit kein Zombie-Auth-User uebrigbleibt.
export async function createAuthUser(opts: {
  supabaseUrl: string;
  serviceKey: string;
  email: string;
  fullName: string;
  role: string;
  birthdate?: string | null;
}): Promise<{ success: true; userId: string } | { success: false; error: string; debug?: unknown }> {
  const { supabaseUrl, serviceKey, email, fullName, role } = opts;
  // bcrypt cap't bei 72 Bytes — laenger schickt Supabase Auth direkt mit
  // "Internal Server Error" zurueck. Eine UUID hat 36 Zeichen, das reicht
  // (~122 bits Entropie) und der User setzt sich's eh ueber den Recovery-
  // Link selber neu, dieses Passwort wird nie genutzt.
  const tempPassword = randomUUID();
  const authRes = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({
      email,
      password: tempPassword,
      email_confirm: true,
      user_metadata: { full_name: fullName, role },
    }),
  });

  if (!authRes.ok) {
    const rawBody = await authRes.text().catch(() => "");
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(rawBody) as Record<string, unknown>; } catch {}
    const msg = (parsed.msg as string | undefined)
            ?? (parsed.message as string | undefined)
            ?? (parsed.error_description as string | undefined)
            ?? rawBody
            ?? "User-Erstellung fehlgeschlagen";
    const friendlier = /already (been )?registered|already exists|duplicate|email_exists/i.test(msg)
      ? `Es gibt bereits einen Benutzer mit Email ${email}`
      : msg;
    logError("admin.users.create.auth", { status: authRes.status, body: rawBody }, { email });
    return { success: false, error: friendlier, debug: { status: authRes.status, supabase_body: parsed } };
  }

  const created = await authRes.json() as { id: string; email: string };

  // Profil idempotent nachschaerfen falls der Trigger die Rolle nicht
  // uebernommen hat. Bei Fehler den Auth-User wieder loeschen.
  const admin = createAdminClient();
  const { error: profileErr } = await admin
    .from("profiles")
    .update({
      role,
      full_name: fullName,
      is_active: true,
      // birthdate nur setzen wenn explizit angegeben — sonst NULL stehen lassen
      ...(opts.birthdate ? { birthdate: opts.birthdate } : {}),
    })
    .eq("id", created.id);
  if (profileErr) {
    await fetch(`${supabaseUrl}/auth/v1/admin/users/${created.id}`, {
      method: "DELETE",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    logError("admin.users.create.profile-update", profileErr, { email });
    return { success: false, error: profileErr.message };
  }

  return { success: true, userId: created.id };
}

// Generiert via Auth-Admin-API einen Recovery-Link und schickt eine
// Setup-Mail via Resend (zuverlaessiger als Supabase's Default-Mailer).
// Bei Fehler nur loggen — User ist im Auth-System schon angelegt, der
// Admin kann den Reset bei Bedarf ueber den "Passwort zuruecksetzen"-
// Button erneut ausloesen.
export async function sendSetupMail(opts: {
  supabaseUrl: string;
  serviceKey: string;
  email: string;
  fullName: string;
}): Promise<{ success: boolean; error?: string }> {
  const { supabaseUrl, serviceKey, email, fullName } = opts;
  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    logError("admin.users.setupmail.no-resend-key", null, { email });
    return { success: false, error: "RESEND_API_KEY fehlt" };
  }

  // Recovery-Link generieren via Auth-Admin-API (direkter fetch).
  const linkRes = await fetch(`${supabaseUrl}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    // WICHTIG: redirect_to MUSS top-level sein. Wenn man's in `options`
    // packt (wie supabase-js es kapselt), ignoriert die Auth-Admin-API
    // das stillschweigend und faellt auf site_url zurueck (=localhost).
    // Resultat waeren Reset-Links die auf localhost zeigen statt auf
    // die Vercel-URL. Zusaetzlich muss die Ziel-URL in der uri_allow_list
    // im Supabase-Auth-Config stehen.
    body: JSON.stringify({
      type: "recovery",
      email,
      redirect_to: appUrl("/passwort-reset"),
    }),
  });
  if (!linkRes.ok) {
    const body = await linkRes.text().catch(() => "");
    logError("admin.users.setupmail.link", { status: linkRes.status, body }, { email });
    return { success: false, error: `Link-Generation fehlgeschlagen: ${body}` };
  }
  const linkData = await linkRes.json() as {
    properties?: { action_link?: string };
    action_link?: string;
  };
  const actionLink = linkData.properties?.action_link ?? linkData.action_link;
  if (!actionLink) {
    logError("admin.users.setupmail.no-link", linkData, { email });
    return { success: false, error: "Kein action_link in der Antwort" };
  }

  // Mail ueber Resend schicken — gleiche Optik wie restliche App-Mails.
  const resend = new Resend(resendKey);
  try {
    await resend.emails.send({
      from: "EVENTLINE FSM <noreply@eventline-basel.com>",
      to: email,
      subject: "Willkommen bei EVENTLINE — Passwort setzen",
      html: `
        <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto">
          <div style="background:#1a1a1a;padding:20px 24px;border-radius:12px 12px 0 0">
            <h2 style="color:white;margin:0;font-size:16px">EVENTLINE GmbH</h2>
          </div>
          <div style="background:white;padding:24px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px">
            <p style="margin:0 0 12px">Hallo ${fullName},</p>
            <p style="margin:0 0 16px">Ein Admin hat dich bei EVENTLINE FSM hinzugefügt. Klicke auf den Button um dein Passwort zu setzen und dich einzuloggen:</p>
            <p style="margin:0 0 16px;text-align:center">
              <a href="${actionLink}" style="display:inline-block;background:#dc2626;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600">Passwort setzen</a>
            </p>
            <p style="margin:0 0 8px;color:#999;font-size:13px">Falls der Button nicht funktioniert, kopiere diesen Link in deinen Browser:</p>
            <p style="margin:0 0 16px;color:#666;font-size:12px;word-break:break-all">${actionLink}</p>
            <hr style="border:none;border-top:1px solid #eee;margin:16px 0"/>
            <p style="margin:0;color:#bbb;font-size:11px">EVENTLINE GmbH · St. Jakobs-Strasse 200 · CH-4052 Basel</p>
          </div>
        </div>
      `,
    });
    return { success: true };
  } catch (err) {
    logError("admin.users.setupmail.send", err, { email });
    return { success: false, error: err instanceof Error ? err.message : "Resend-Fehler" };
  }
}
