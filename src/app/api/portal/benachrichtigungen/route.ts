// /api/portal/benachrichtigungen — Kanal-Matrix (E-Mail/Push je Ereignis)
// des Portal-Kontos fuer «Mein Konto» im Partner- und Lieferantenportal
// (gemeinsame Karte src/components/partner/partner-notifications-card.tsx).
//
// GET  → { channels, ansichtAls, name }
// POST { typ, kanal: "email" | "push", an: boolean } → { channels }
//        schaltet EINEN Schalter (Merge auf dem Server, andere Eintraege
//        bleiben), nur Ereignisse, die das Portal des Kontos anbietet.
//
// «Ansicht als»-faehig: gelesen und geschrieben wird fuer effectiveUserId —
// ein Admin im View-As sieht die Einstellungen der angesehenen Person, nicht
// seine eigenen. Schreiben geht dort nur im Bearbeiten-Modus des Overlays
// (sonst 423 — wie die Middleware fuer alle Schreibrouten) und gilt dann
// fuer die angesehene Person, wie jede andere Portal-Aktion in diesem Modus.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireUser, IMPERSONATE_WRITE_COOKIE } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { configurableNotificationEvents } from "@/lib/notification-meta";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

type Kanal = "email" | "push";
type Channels = Record<string, Partial<Record<string, boolean>>>;

const fehler = (msg: string, status: number) => NextResponse.json({ success: false, error: msg }, { status });

/** Eingeloggt, aktives Portal-Konto (Partner mit Location bzw. Lieferant
 *  einer aktiven Firma) — gleiche Bedingungen wie die Portal-APIs. */
async function portalKonto() {
  const auth = await requireUser();
  if (auth.error) return { error: auth.error } as const;
  const admin = createAdminClient();
  const { data: p, error } = await admin
    .from("profiles")
    .select("full_name, role, is_active, lieferant_id, partner_location_id")
    .eq("id", auth.effectiveUserId)
    .maybeSingle();
  if (error) {
    logError("api.portal.benachrichtigungen.profil", error);
    return { error: fehler("Laden fehlgeschlagen", 500) } as const;
  }
  let audience: "partner" | "lieferant" | null = null;
  if (p && p.is_active === true) {
    if (p.role === "partner" && p.partner_location_id) audience = "partner";
    if (p.role === "lieferant" && p.lieferant_id) {
      const { data: firma, error: fErr } = await admin
        .from("lieferanten").select("is_active").eq("id", p.lieferant_id).maybeSingle();
      if (fErr) {
        logError("api.portal.benachrichtigungen.firma", fErr);
        return { error: fehler("Laden fehlgeschlagen", 500) } as const;
      }
      if (firma?.is_active) audience = "lieferant";
    }
  }
  if (!audience) return { error: fehler("Kein Zugriff", 403) } as const;
  return {
    error: null,
    admin,
    userId: auth.effectiveUserId,
    audience,
    name: (p?.full_name as string | null) ?? null,
    ansichtAls: auth.isImpersonating,
  } as const;
}

async function ladeChannels(admin: ReturnType<typeof createAdminClient>, userId: string): Promise<Channels> {
  const { data, error } = await admin
    .from("user_notification_settings")
    .select("channels")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  const ch = data?.channels;
  return ch && typeof ch === "object" && !Array.isArray(ch) ? (ch as Channels) : {};
}

export async function GET() {
  const konto = await portalKonto();
  if (konto.error) return konto.error;
  try {
    const channels = await ladeChannels(konto.admin, konto.userId);
    return NextResponse.json(
      { success: true, channels, ansichtAls: konto.ansichtAls, name: konto.name },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    logError("api.portal.benachrichtigungen.get", e, { userId: konto.userId });
    return fehler("Laden fehlgeschlagen", 500);
  }
}

export async function POST(request: Request) {
  const konto = await portalKonto();
  if (konto.error) return konto.error;
  // Zweite Sicherung zur Middleware: in der «Ansicht als» nur mit
  // freigegebener Bearbeitung.
  if (konto.ansichtAls && (await cookies()).get(IMPERSONATE_WRITE_COOKIE)?.value !== "1") {
    return fehler("Nur-Lesen-Modus aktiv (Entwickler-Modus). Bearbeitung im Overlay bestätigen um Änderungen zu erlauben.", 423);
  }

  const b = (await request.json().catch(() => null)) as { typ?: unknown; kanal?: unknown; an?: unknown } | null;
  const typ = typeof b?.typ === "string" ? b.typ : "";
  const kanal = b?.kanal === "email" || b?.kanal === "push" ? (b.kanal as Kanal) : null;
  if (!kanal || typeof b?.an !== "boolean") return fehler("Ungültige Angaben", 400);
  if (!configurableNotificationEvents(konto.audience).some((e) => e.type === typ)) {
    return fehler("Unbekanntes Ereignis", 400);
  }

  try {
    const alt = await ladeChannels(konto.admin, konto.userId);
    const channels: Channels = { ...alt, [typ]: { ...(alt[typ] ?? {}), [kanal]: b.an } };
    const { error } = await konto.admin
      .from("user_notification_settings")
      .upsert({ user_id: konto.userId, channels }, { onConflict: "user_id" });
    if (error) throw error;
    return NextResponse.json({ success: true, channels });
  } catch (e) {
    logError("api.portal.benachrichtigungen.post", e, { userId: konto.userId, typ, kanal });
    return fehler("Speichern fehlgeschlagen", 500);
  }
}
