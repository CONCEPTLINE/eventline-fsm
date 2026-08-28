// Helper zum Absichern von API-Routen.
// Pattern in jeder Route die nicht explizit oeffentlich ist:
//
//   const auth = await requireUser();
//   if (auth.error) return auth.error;
//   // ab hier ist auth.user garantiert nicht null
//
// Fuer admin-only Routen:
//
//   const auth = await requireAdmin();
//   if (auth.error) return auth.error;
//
// Ohne diese Pruefung koennte jeder mit der URL die Route triggern und
// damit z.B. Mails versenden, Daten loeschen oder Notifications anlegen
// (alle nutzen createAdminClient() der RLS umgeht).
//
// Routen die absichtlich oeffentlich sind (Customer-Confirm-Links, Cron-
// Webhooks, OAuth-Callbacks) brauchen das nicht — sie haben eigene
// Token-/Secret-Pruefung.

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { cookies } from "next/headers";

export const TRUSTED_DEVICE_COOKIE = "eventline_trusted_device";

/** SHA-256-Hash eines Tokens — Server vergleicht damit gegen die DB. Wir
 *  speichern niemals raw Tokens (nur Hashes), damit ein DB-Leak nicht
 *  alle Geraete kompromittiert. */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Normalisiert User-Agent: entfernt alle Ziffern-Sequenzen (Versionen)
 *  damit Safari 26.1 und 26.5.2 gleich hashen. */
export function normalizeUserAgent(ua: string): string {
  return ua.replace(/[\d.]+/g, "").replace(/\s+/g, " ").trim();
}

/** SHA-256(normalisierter UA + user_id) — stabiler Device-Fingerprint.
 *  Ueberlebt Browser-Version-Bumps, damit User bei Cookie-Verlust nicht
 *  einen neuen Approval-Loop durchlaufen muessen (Match gegen bereits
 *  approved-Row via device_fingerprint). */
export function deviceFingerprint(ua: string | null | undefined, userId: string): string {
  return hashToken((normalizeUserAgent(ua ?? "") || "unknown") + "|" + userId);
}

export async function requireUser() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return {
      user: null,
      error: NextResponse.json(
        { success: false, error: "Nicht authentifiziert" },
        { status: 401 },
      ),
    };
  }
  return { user, error: null };
}

export async function requireAdmin() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return {
      user: null,
      error: NextResponse.json(
        { success: false, error: "Nicht authentifiziert" },
        { status: 401 },
      ),
    };
  }
  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  if (profile?.role !== "admin") {
    return {
      user: null,
      error: NextResponse.json(
        { success: false, error: "Nur fuer Administratoren" },
        { status: 403 },
      ),
    };
  }
  return { user, error: null };
}

// requirePermission(perm): nutzt die SQL-Funktion has_permission() — Admin
// passt automatisch durch (im Function definiert), andere Rollen muessen
// die Permission in ihrer roles.permissions-Liste haben.
//
// Pattern fuer API-Routen die createAdminClient() nutzen (RLS-Bypass):
//   const auth = await requirePermission("kunden:archive");
//   if (auth.error) return auth.error;
//
// Auf Routen die nur den User-Client nutzen wird die Permission ueber
// die RLS-Policy direkt geprueft — diese Helfer-Funktion ist nur noetig
// wo wir die RLS umgehen.
export async function requirePermission(perm: string) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return {
      user: null,
      error: NextResponse.json(
        { success: false, error: "Nicht authentifiziert" },
        { status: 401 },
      ),
    };
  }
  const { data, error } = await supabase.rpc("has_permission", { perm });
  if (error || data !== true) {
    return {
      user: null,
      error: NextResponse.json(
        { success: false, error: `Keine Berechtigung: ${perm}` },
        { status: 403 },
      ),
    };
  }
  return { user, error: null };
}

// =====================================================================
// requireTrustedDevice — fuer sensible Finanz-/HR-Endpoints.
// =====================================================================
//
// Pattern:
//   const auth = await requireTrustedDevice("hr:view");
//   if (auth.error) return auth.error;
//
// Pruefkette:
//   1. requirePermission(perm) — User ist authenticated + hat Permission
//   2. trusted_device-Cookie lesen + Hash gegen DB matchen
//   3. is_trusted_device(hash, user_id)-RPC liefert true?
// Wenn 2 oder 3 fehlt: 403 mit error="device_not_trusted" — UI kann
// darauf den Trust-Prompt rendern.
//
// Admin-Pass-Through: Admins muessen TROTZDEM ein trusted Device haben!
// Sonst wuerde die ganze Schicht fuer den waertvollsten Account-Typ
// nichts schuetzen — Admin-Account-Diebstahl ist die schlimmste Variante
// des Threat-Models. has_permission lasst Admin durch fuer die NORMALE
// Permission, der trusted-device-Check kommt zusaetzlich.

export async function requireTrustedDevice(perm: string) {
  const auth = await requirePermission(perm);
  if (auth.error) return auth;

  const cookieStore = await cookies();
  const cookie = cookieStore.get(TRUSTED_DEVICE_COOKIE);

  if (!cookie?.value) {
    return {
      user: null,
      error: NextResponse.json(
        { success: false, error: "device_not_trusted", message: "Dieses Geraet ist nicht als vertraut markiert." },
        { status: 403 },
      ),
    };
  }

  const admin = createAdminClient();
  const tokenHash = hashToken(cookie.value);

  const { data: trusted, error: rpcErr } = await admin.rpc("is_trusted_device", {
    p_token_hash: tokenHash,
    p_user_id: auth.user.id,
  });

  if (rpcErr || trusted !== true) {
    return {
      user: null,
      error: NextResponse.json(
        { success: false, error: "device_not_trusted", message: "Dieses Geraet ist nicht (mehr) als vertraut markiert." },
        { status: 403 },
      ),
    };
  }

  // last_seen_at bump — fire-and-forget, blockt die Antwort nicht.
  void admin
    .from("trusted_devices")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("cookie_token_hash", tokenHash)
    .eq("user_id", auth.user.id);

  return { user: auth.user, error: null };
}
