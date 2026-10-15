"use client";

/**
 * finanzenFetch — EINZIGER Weg der Seite /finanzen zu ihren Routen.
 *
 * Faengt die Finanz-Fehler-Slugs ab (Vertrag src/lib/finanzen/types.ts):
 *   • Gate-Slugs (device_not_trusted | stepup_required | stepup_impersonation)
 *     → window-Event FINANZEN_GATE_EVENT (StepUpGate laedt sich neu) + Toast.
 *     device_not_trusted laedt die Seite neu (TrustedDeviceGate kennt kein
 *     Event). Toasts per `id` dedupliziert: sechs parallele Fetches, EIN Toast.
 *   • protokoll_nicht_verfuegbar (503) → Toast mit der Server-Meldung, KEIN
 *     Gate-Event (der Gate kann nichts tun — das Protokoll fehlt).
 *   • alle anderen → TOAST.errorOr. Niemals still.
 *
 * Betraege landen nur im Rueckgabewert — nie in Toasts/Logs.
 */

import { toast } from "sonner";
import { TOAST } from "@/lib/messages";
import {
  FINANZEN_FEHLER,
  FINANZEN_GATE_EVENT,
  istFinanzenFehlerSlug,
  istGateSlug,
  type FinanzenFetchErgebnis,
  type FinanzenGateEventDetail,
} from "@/lib/finanzen/types";

const GATE_TEXT: Record<string, string> = {
  [FINANZEN_FEHLER.DEVICE_NOT_TRUSTED]: "Dieses Gerät ist nicht mehr vertraut — Seite wird neu geladen",
  [FINANZEN_FEHLER.STEPUP_REQUIRED]: "Finanzen bitte erneut bestätigen",
  [FINANZEN_FEHLER.STEPUP_IMPERSONATION]: "Finanzen sind im «Ansicht als»-Modus gesperrt",
};

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

  if (istGateSlug(slug)) {
    const message = GATE_TEXT[slug] ?? serverText ?? "Finanzen bitte erneut bestätigen";
    toast.error(message, { id: slug });
    if (typeof window !== "undefined") {
      const detail: FinanzenGateEventDetail = { slug };
      window.dispatchEvent(new CustomEvent<FinanzenGateEventDetail>(FINANZEN_GATE_EVENT, { detail }));
      if (slug === FINANZEN_FEHLER.DEVICE_NOT_TRUSTED) window.location.reload();
    }
    return { ok: false, status: res.status, slug, message };
  }

  if (slug === FINANZEN_FEHLER.PROTOKOLL_NICHT_VERFUEGBAR) {
    const message = serverText ?? "Zugriffsprotokoll nicht erreichbar — Finanzen vorübergehend gesperrt.";
    toast.error(message, { id: slug });
    return { ok: false, status: res.status, slug, message };
  }

  if (slug !== "andere") {
    // Bekannter Fach-Slug (sync_laeuft, bexio_scope, …): Server-Text,
    // dedupliziert per Slug — der Aufrufer darf mit derselben id praezisieren.
    const message = serverText ?? slug;
    toast.error(message, { id: slug });
    return { ok: false, status: res.status, slug, message };
  }

  const message = serverText ?? `HTTP ${res.status}`;
  TOAST.errorOr(message);
  return { ok: false, status: res.status, slug: "andere", message };
}
