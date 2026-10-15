// Guard + Antwort-Helfer fuer alle /api/finanzen/*-Routen (Spec B.3, Entscheid 4).
//
//   requireFinanzen()  = requireAdminTrustedDevice("finanzen:view")
//                        → Impersonations-Sperre → Geraete-Hash.
//   finanzenJson()     = NextResponse.json + Cache-Control: no-store.
//   finanzenFehler()   = { success:false, error: slug, message? } + no-store.
//   protokollFehler()  = 503 protokoll_nicht_verfuegbar (fail-closed).
//
// Pattern einer Leseroute:
//   const auth = await requireFinanzen();
//   if (auth.error) return auth.error;
//   if (!(await protokolliereZugriff({ actorProfileId: auth.user.id, bereich: "finanzen",
//         aktion: ZUGRIFF_AKTION.FINANZEN_UEBERSICHT, geraetHash: auth.geraetHash })))
//     return protokollFehler();
//   ... Daten lesen ... return finanzenJson({ success: true, ... });
//
// Welle 1 ist admin-only (Entscheid 2): der Rechte-Slug finanzen:view ist
// Dokumentation, bis requireFinanzen auf requireTrustedDevice umgestellt wird.

import { NextResponse } from "next/server";
import { requireAdminTrustedDevice } from "@/lib/api-auth";
import { geraetHashAusCookies } from "@/lib/finanzen/zugriffe";
import {
  FINANZEN_CACHE_CONTROL,
  FINANZEN_FEHLER,
  FINANZEN_PERMISSION,
  type FinanzenFehlerSlug,
} from "@/lib/finanzen/types";

type FinanzenUser = NonNullable<Awaited<ReturnType<typeof requireAdminTrustedDevice>>["user"]>;

export type RequireFinanzenOk = { user: FinanzenUser; geraetHash: string; error: null };
export type RequireFinanzenFail = { user: null; geraetHash: null; error: NextResponse };

/** requireAdminTrustedDevice("finanzen:view") → Impersonations-Sperre → Geraete-Hash. */
export async function requireFinanzen(): Promise<RequireFinanzenOk | RequireFinanzenFail> {
  // (1) Admin + Permission + vertrautes Geraet — Fehler 1:1 (401/403/503,
  //     inkl. device_not_trusted).
  const auth = await requireAdminTrustedDevice(FINANZEN_PERMISSION);
  if (auth.error) {
    auth.error.headers.set("Cache-Control", FINANZEN_CACHE_CONTROL);
    return { user: null, geraetHash: null, error: auth.error };
  }
  // (2) «Ansicht als» → Finanzen gesperrt.
  if (auth.isImpersonating) {
    return { user: null, geraetHash: null, error: finanzenFehler(FINANZEN_FEHLER.IMPERSONATION, 403, "Finanzen sind im «Ansicht als»-Modus gesperrt.") };
  }
  // (3) Geraete-Hash (fuer das Protokoll) — kann nach (1) nicht null sein;
  //     falls doch, 403.
  const geraetHash = await geraetHashAusCookies();
  if (!geraetHash) {
    return { user: null, geraetHash: null, error: finanzenFehler(FINANZEN_FEHLER.DEVICE_NOT_TRUSTED, 403, "Dieses Geraet ist nicht als vertraut markiert.") };
  }
  return { user: auth.user, geraetHash, error: null };
}

/** NextResponse.json mit Cache-Control: no-store (FINANZEN_CACHE_CONTROL). */
export function finanzenJson(body: unknown, init?: { status?: number }): NextResponse {
  const res = NextResponse.json(body, { status: init?.status ?? 200 });
  res.headers.set("Cache-Control", FINANZEN_CACHE_CONTROL);
  return res;
}

/** { success:false, error: slug, message? } + no-store. */
export function finanzenFehler(slug: FinanzenFehlerSlug | string, status: number, message?: string): NextResponse {
  return finanzenJson({ success: false, error: slug, ...(message ? { message } : {}) }, { status });
}

/** Kurzform fuer das fail-closed-Protokoll der Finanz-Routen. */
export function protokollFehler(): NextResponse {
  return finanzenFehler(
    FINANZEN_FEHLER.PROTOKOLL_NICHT_VERFUEGBAR,
    503,
    "Zugriffsprotokoll nicht erreichbar — Finanzen vorübergehend gesperrt.",
  );
}
