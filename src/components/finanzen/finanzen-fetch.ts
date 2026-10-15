"use client";

/**
 * finanzenFetch — EINZIGER Weg der Seite /finanzen zu ihren Routen.
 *
 * Faengt die Finanz-Fehler-Slugs ab (Vertrag src/lib/finanzen/types.ts):
 *   • device_not_trusted → Toast + Seite neu laden (der TrustedDeviceGate
 *     zeigt dann sein Formular).
 *   • bekannte Fach-Slugs (impersonation, protokoll_nicht_verfuegbar,
 *     sync_laeuft, bexio_scope …) → Toast mit der Server-Meldung.
 *   • alle anderen → TOAST.errorOr. Niemals still.
 * Toasts per `id` (= Slug) dedupliziert: sechs parallele Fetches, EIN Toast.
 *
 * Betraege landen nur im Rueckgabewert — nie in Toasts/Logs.
 */

import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import {
  FINANZEN_FEHLER,
  istFinanzenFehlerSlug,
  type FinanzenFetchErgebnis,
} from "@/lib/finanzen/types";

interface FehlerJson {
  success?: boolean;
  error?: unknown;
  message?: unknown;
}

export async function finanzenFetch<T>(url: string, init?: RequestInit): Promise<FinanzenFetchErgebnis<T>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, cache: "no-store" });
  } catch {
    const message = "Keine Verbindung zum Server";
    toast.error(message, { id: "finanzen-netz" });
    return { ok: false, status: 0, slug: "andere", message };
  }

  let json: FehlerJson | null = null;
  try {
    json = (await res.json()) as FehlerJson;
  } catch {
    json = null;
  }

  if (res.ok && json?.success === true) {
    return { ok: true, data: json as unknown as T };
  }

  const slug = istFinanzenFehlerSlug(json?.error) ? json.error : "andere";
  const serverText = typeof json?.message === "string" ? json.message : (typeof json?.error === "string" ? json.error : null);

  if (slug === FINANZEN_FEHLER.DEVICE_NOT_TRUSTED) {
    const message = "Dieses Gerät ist nicht mehr vertraut — Seite wird neu geladen";
    toast.error(message, { id: slug });
    if (typeof window !== "undefined") window.location.reload();
    return { ok: false, status: res.status, slug, message };
  }

  if (slug === FINANZEN_FEHLER.PROTOKOLL_NICHT_VERFUEGBAR) {
    const message = serverText ?? "Zugriffsprotokoll nicht erreichbar — Finanzen vorübergehend gesperrt.";
    toast.error(message, { id: slug });
    return { ok: false, status: res.status, slug, message };
  }

  if (slug !== "andere") {
    // Bekannter Fach-Slug (impersonation, sync_laeuft, bexio_scope, …):
    // Server-Text, dedupliziert per Slug — der Aufrufer darf mit derselben
    // id praezisieren.
    const message = serverText ?? slug;
    toast.error(message, { id: slug });
    return { ok: false, status: res.status, slug, message };
  }

  const message = serverText ?? `HTTP ${res.status}`;
  TOAST.errorOr(message);
  return { ok: false, status: res.status, slug: "andere", message };
}
