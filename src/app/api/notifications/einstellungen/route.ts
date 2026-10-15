// /api/notifications/einstellungen — Benachrichtigungs-Einstellungen des
// angesehenen Kontos: Kanal-Matrix (user_notification_settings.channels) und
// Stille Stunden. Eine Route fuer beide Oberflaechen:
//   - Mein Konto → Benachrichtigungen (intern, benachrichtigungen-tab.tsx)
//   - Konto-Karte im Partner- und Lieferantenportal (partner-notifications-card.tsx)
//
// GET  → { zielgruppe, channels, stille: { an, von, bis }, ansichtAls, name }
// POST { art: "kanal", typ, kanal, an }      → EIN Schalter (Merge auf dem Server)
//      { art: "alle_in_app", an }            → In-App fuer alle Ereignisse (intern)
//      { art: "stille", an?, von?, bis? }    → Stille Stunden (intern)
//      Antwort wie GET. Nur Ereignisse und Kanaele, die die Matrix der
//      Zielgruppe anbietet (notification-meta: configurableNotificationEvents,
//      SCHALTBARE_KANAELE).
//
// «Ansicht als»-faehig: gelesen und geschrieben wird fuer effectiveUserId —
// ein Admin im View-As sieht die Einstellungen der angesehenen Person, nicht
// seine eigenen. Schreiben geht dort nur im Bearbeiten-Modus des Overlays
// (sonst 423 — wie die Middleware fuer alle Schreibrouten) und gilt dann
// fuer die angesehene Person, wie jede andere Aktion in diesem Modus.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { requireUser, IMPERSONATE_WRITE_COOKIE } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  configurableNotificationEvents, SCHALTBARE_KANAELE, type NotificationChannel,
} from "@/lib/notification-meta";
import { logError } from "@/lib/log";

export const dynamic = "force-dynamic";

type Zielgruppe = "intern" | "partner" | "lieferant";
type Channels = Record<string, Partial<Record<NotificationChannel, boolean>>>;
type Admin = ReturnType<typeof createAdminClient>;

const ZEIT_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const fehler = (msg: string, status: number) => NextResponse.json({ success: false, error: msg }, { status });

/** Angesehenes Konto und seine Zielgruppe: aktive interne Mitarbeiter (Rolle
 *  ohne Portal), Partner mit Location, Lieferanten einer aktiven Firma —
 *  gleiche Bedingungen wie die Portal-APIs. */
async function konto() {
  const auth = await requireUser();
  if (auth.error) return { error: auth.error } as const;
  const admin = createAdminClient();
  const { data: p, error } = await admin
    .from("profiles")
    .select("full_name, role, is_active, lieferant_id, partner_location_id")
    .eq("id", auth.effectiveUserId)
    .maybeSingle();
  if (error) {
    logError("api.notifications.einstellungen.profil", error);
    return { error: fehler("Laden fehlgeschlagen", 500) } as const;
  }
  let zielgruppe: Zielgruppe | null = null;
  if (p && p.is_active === true) {
    if (p.role === "partner") {
      if (p.partner_location_id) zielgruppe = "partner";
    } else if (p.role === "lieferant") {
      if (p.lieferant_id) {
        const { data: firma, error: fErr } = await admin
          .from("lieferanten").select("is_active").eq("id", p.lieferant_id).maybeSingle();
        if (fErr) {
          logError("api.notifications.einstellungen.firma", fErr);
          return { error: fehler("Laden fehlgeschlagen", 500) } as const;
        }
        if (firma?.is_active) zielgruppe = "lieferant";
      }
    } else {
      const { data: rolle, error: rErr } = await admin
        .from("roles").select("is_portal").eq("slug", p.role).maybeSingle();
      if (rErr) {
        logError("api.notifications.einstellungen.rolle", rErr);
        return { error: fehler("Laden fehlgeschlagen", 500) } as const;
      }
      if (rolle && rolle.is_portal === false) zielgruppe = "intern";
    }
  }
  if (!zielgruppe) return { error: fehler("Kein Zugriff", 403) } as const;
  return {
    error: null,
    admin,
    userId: auth.effectiveUserId,
    zielgruppe,
    name: (p?.full_name as string | null) ?? null,
    ansichtAls: auth.isImpersonating,
  } as const;
}

interface Stand {
  channels: Channels;
  stille: { an: boolean; von: string; bis: string };
}

async function ladeStand(admin: Admin, userId: string): Promise<Stand> {
  const { data, error } = await admin
    .from("user_notification_settings")
    .select("channels, quiet_hours_enabled, quiet_hours_start, quiet_hours_end")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  const ch = data?.channels;
  return {
    channels: ch && typeof ch === "object" && !Array.isArray(ch) ? (ch as Channels) : {},
    stille: {
      an: data?.quiet_hours_enabled === true,
      von: String(data?.quiet_hours_start ?? "22:00").slice(0, 5),
      bis: String(data?.quiet_hours_end ?? "07:00").slice(0, 5),
    },
  };
}

function antwort(k: { zielgruppe: Zielgruppe; ansichtAls: boolean; name: string | null }, stand: Stand) {
  return NextResponse.json(
    { success: true, zielgruppe: k.zielgruppe, ...stand, ansichtAls: k.ansichtAls, name: k.name },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET() {
  const k = await konto();
  if (k.error) return k.error;
  try {
    return antwort(k, await ladeStand(k.admin, k.userId));
  } catch (e) {
    logError("api.notifications.einstellungen.get", e, { userId: k.userId });
    return fehler("Laden fehlgeschlagen", 500);
  }
}

export async function POST(request: Request) {
  const k = await konto();
  if (k.error) return k.error;
  // Zweite Sicherung zur Middleware: in der «Ansicht als» nur mit
  // freigegebener Bearbeitung.
  if (k.ansichtAls && (await cookies()).get(IMPERSONATE_WRITE_COOKIE)?.value !== "1") {
    return fehler("Nur-Lesen-Modus aktiv (Entwickler-Modus). Bearbeitung im Overlay bestätigen um Änderungen zu erlauben.", 423);
  }

  const b = ((await request.json().catch(() => null)) ?? {}) as {
    art?: unknown; typ?: unknown; kanal?: unknown; an?: unknown; von?: unknown; bis?: unknown;
  };
  const ereignisse = configurableNotificationEvents(k.zielgruppe).map((e) => e.type as string);

  try {
    const alt = await ladeStand(k.admin, k.userId);
    let zeile: Record<string, unknown>;
    if (b.art === "kanal") {
      const typ = typeof b.typ === "string" ? b.typ : "";
      const kanal = b.kanal as NotificationChannel;
      if (!ereignisse.includes(typ)) return fehler("Unbekanntes Ereignis", 400);
      if (!SCHALTBARE_KANAELE[k.zielgruppe].includes(kanal)) return fehler("Kanal nicht schaltbar", 400);
      if (typeof b.an !== "boolean") return fehler("Ungültige Angaben", 400);
      zeile = { channels: { ...alt.channels, [typ]: { ...(alt.channels[typ] ?? {}), [kanal]: b.an } } };
    } else if (b.art === "alle_in_app") {
      if (!SCHALTBARE_KANAELE[k.zielgruppe].includes("in_app")) return fehler("Kanal nicht schaltbar", 400);
      if (typeof b.an !== "boolean") return fehler("Ungültige Angaben", 400);
      const channels: Channels = { ...alt.channels };
      for (const typ of ereignisse) channels[typ] = { ...(channels[typ] ?? {}), in_app: b.an };
      zeile = { channels };
    } else if (b.art === "stille") {
      if (k.zielgruppe !== "intern") return fehler("Stille Stunden gibt es nur intern", 400);
      zeile = {};
      if (b.an !== undefined) {
        if (typeof b.an !== "boolean") return fehler("Ungültige Angaben", 400);
        zeile.quiet_hours_enabled = b.an;
      }
      for (const [feld, spalte] of [["von", "quiet_hours_start"], ["bis", "quiet_hours_end"]] as const) {
        const v = b[feld];
        if (v === undefined) continue;
        if (typeof v !== "string" || !ZEIT_RE.test(v)) return fehler("Ungültige Uhrzeit", 400);
        zeile[spalte] = `${v}:00`;
      }
      if (Object.keys(zeile).length === 0) return fehler("Ungültige Angaben", 400);
    } else {
      return fehler("Unbekannte Aktion", 400);
    }

    const { error } = await k.admin
      .from("user_notification_settings")
      .upsert({ user_id: k.userId, ...zeile }, { onConflict: "user_id" });
    if (error) throw error;
    return antwort(k, await ladeStand(k.admin, k.userId));
  } catch (e) {
    logError("api.notifications.einstellungen.post", e, { userId: k.userId, art: b.art });
    return fehler("Speichern fehlgeschlagen", 500);
  }
}
