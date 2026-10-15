// Guard + Antwort-Helfer fuer alle /api/finanzen/*-Routen (Spec B.3, Entscheid 4).
//
//   requireFinanzen()  = requireAdminTrustedDevice("finanzen:view")
//                        → Impersonations-Sperre → Step-up-Ticket.
//   finanzenJson()     = NextResponse.json + Cache-Control: no-store.
//   finanzenFehler()   = { success:false, error: slug, message?, grund? } + no-store.
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
import { cookies } from "next/headers";
import { requireAdminTrustedDevice } from "@/lib/api-auth";
import { pruefeStepUpTicket } from "@/lib/finanzen/stepup";
import { geraetHashAusCookies } from "@/lib/finanzen/zugriffe";
import {
  FINANZEN_CACHE_CONTROL,
  FINANZEN_FEHLER,
  FINANZEN_PERMISSION,
  STEPUP_COOKIE,
  type FinanzenFehlerSlug,
  type StepUpClaims,
  type StepUpGrund,
} from "@/lib/finanzen/types";

type FinanzenUser = NonNullable<Awaited<ReturnType<typeof requireAdminTrustedDevice>>["user"]>;

export type RequireFinanzenOk = { user: FinanzenUser; geraetHash: string; stepUp: StepUpClaims; error: null };
export type RequireFinanzenFail = { user: null; geraetHash: null; stepUp: null; error: NextResponse };

/** Vorstufe ohne Step-up-Pruefung — fuer die Freischalt-Routen selbst
 *  (passkey-challenge, passkey-verify, passwort): Guard + Impersonations-
 *  Sperre + Geraete-Hash. Das Ticket gibt es hier ja erst danach. */
export type RequireFinanzenStartOk = { user: FinanzenUser; geraetHash: string; error: null };
export type RequireFinanzenStartFail = { user: null; geraetHash: null; error: NextResponse };

function fail(error: NextResponse): RequireFinanzenFail {
  error.headers.set("Cache-Control", FINANZEN_CACHE_CONTROL);
  return { user: null, geraetHash: null, stepUp: null, error };
}

export async function requireFinanzenStart(): Promise<RequireFinanzenStartOk | RequireFinanzenStartFail> {
  // (1) Admin + Permission + vertrautes Geraet — Fehler 1:1 (401/403/503,
  //     inkl. device_not_trusted).
  const auth = await requireAdminTrustedDevice(FINANZEN_PERMISSION);
  if (auth.error) {
    auth.error.headers.set("Cache-Control", FINANZEN_CACHE_CONTROL);
    return { user: null, geraetHash: null, error: auth.error };
  }
  // (2) «Ansicht als» → Finanzen gesperrt.
  if (auth.isImpersonating) {
    return { user: null, geraetHash: null, error: finanzenFehler(FINANZEN_FEHLER.STEPUP_IMPERSONATION, 403, "Finanzen sind im «Ansicht als»-Modus gesperrt.") };
  }
  // (3) Geraete-Hash — kann nach (1) nicht null sein; falls doch, 403.
  const geraetHash = await geraetHashAusCookies();
  if (!geraetHash) {
    return { user: null, geraetHash: null, error: finanzenFehler(FINANZEN_FEHLER.DEVICE_NOT_TRUSTED, 403, "Dieses Geraet ist nicht als vertraut markiert.") };
  }
  return { user: auth.user, geraetHash, error: null };
}

/** requireAdminTrustedDevice("finanzen:view") → Impersonations-Sperre → Step-up-Ticket. */
export async function requireFinanzen(): Promise<RequireFinanzenOk | RequireFinanzenFail> {
  const start = await requireFinanzenStart();
  if (start.error) return fail(start.error);
  // (4) Step-up-Ticket aus dem Cookie (Pfad /api/finanzen).
  const store = await cookies();
  const ticket = store.get(STEPUP_COOKIE)?.value;
  const p = pruefeStepUpTicket(ticket, start.user.id, start.geraetHash);
  if (!p.ok) {
    return fail(finanzenFehler(FINANZEN_FEHLER.STEPUP_REQUIRED, 403, "Bitte Finanzen erneut bestätigen.", p.grund));
  }
  return { user: start.user, geraetHash: start.geraetHash, stepUp: p.claims, error: null };
}

/** NextResponse.json mit Cache-Control: no-store (FINANZEN_CACHE_CONTROL). */
export function finanzenJson(body: unknown, init?: { status?: number }): NextResponse {
  const res = NextResponse.json(body, { status: init?.status ?? 200 });
  res.headers.set("Cache-Control", FINANZEN_CACHE_CONTROL);
  return res;
}

/** { success:false, error: slug, message?, grund? } + no-store. */
export function finanzenFehler(slug: FinanzenFehlerSlug | string, status: number, message?: string, grund?: StepUpGrund): NextResponse {
  return finanzenJson(
    { success: false, error: slug, ...(message ? { message } : {}), ...(grund ? { grund } : {}) },
    { status },
  );
}

/** Kurzform fuer das fail-closed-Protokoll der Finanz-Routen. */
export function protokollFehler(): NextResponse {
  return finanzenFehler(
    FINANZEN_FEHLER.PROTOKOLL_NICHT_VERFUEGBAR,
    503,
    "Zugriffsprotokoll nicht erreichbar — Finanzen vorübergehend gesperrt.",
  );
}
