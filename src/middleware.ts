import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
// Edge-Runtime-safe: reiner Konstanten-Import, kein Node-API.
import { IMPERSONATE_COOKIE } from "@/lib/impersonation";

/**
 * Zwei Aufgaben in einer Middleware:
 *
 * 1) Cache-Control fuer authenticated App-Pages (Non-API).
 *    Verhindert dass Vercel-Edge prerendered HTML der "use client"-Pages
 *    cached und User nach Deploy die alte HTML mit alten Chunk-Hashes
 *    sehen. 'private, no-store' zwingt jeden Request zum Origin.
 *
 * 2) Read-only-Guard fuer Developer-Mode: waehrend Impersonation sind
 *    POST/PUT/PATCH/DELETE geblockt SOLANGE der Admin nicht explizit
 *    Write-Modus aktiviert hat. Zwei-Cookie-Modell:
 *      IMPERSONATE_COOKIE       → wer wird simuliert
 *      IMPERSONATE_WRITE_COOKIE → "1" wenn Bearbeitung freigegeben
 *    Default (nur IMPERSONATE_COOKIE): read-only. Der Admin sieht alles,
 *    kann aber nichts kaputt machen. Erst bewusstes Confirm im Overlay
 *    setzt das Write-Cookie und laesst Aenderungen zu.
 *
 * 3) NOTBREMSE /dev-exit: Impersonation-Cookie loeschen + redirect.
 *
 * Der matcher deckt jetzt AUCH /api/* ab (frueher ausgeschlossen), damit
 * der Write-Guard greift. Cache-Control wird nur fuer Non-API-Requests
 * gesetzt.
 */

const IMPERSONATE_WRITE_COOKIE = "eventline_impersonate_write";
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Endpoints die IMMER schreiben duerfen (auch im Read-Only-Impersonate),
// weil man ohne sie nicht mehr aus dem Modus rauskommt:
//   /api/dev/*  → toggle, impersonate start/stop, write-enable/disable
//   /api/auth/* → Login/Logout muessen immer funktionieren
const WRITE_ALLOWLIST = ["/api/dev/", "/api/auth/"];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const isApi = pathname.startsWith("/api/");

  // NOTBREMSE — /dev-exit: Impersonation-Cookies loeschen + redirect.
  // Vor allen anderen Handlern damit ein Redirect-Loop sicher aufgebrochen
  // wird. URL im Browser tippen: /dev-exit
  if (pathname === "/dev-exit") {
    const res = NextResponse.redirect(new URL("/dashboard", req.url));
    res.cookies.set(IMPERSONATE_COOKIE, "", { path: "/", maxAge: 0, expires: new Date(0) });
    res.cookies.set(IMPERSONATE_WRITE_COOKIE, "", { path: "/", maxAge: 0, expires: new Date(0) });
    return res;
  }

  // Read-Only-Guard fuer Impersonation.
  if (isApi && WRITE_METHODS.has(req.method)) {
    const impersonating = req.cookies.get(IMPERSONATE_COOKIE)?.value;
    if (impersonating) {
      const writeEnabled = req.cookies.get(IMPERSONATE_WRITE_COOKIE)?.value === "1";
      const allowed = WRITE_ALLOWLIST.some((p) => pathname.startsWith(p));
      if (!writeEnabled && !allowed) {
        return NextResponse.json(
          {
            success: false,
            error: "Nur-Lesen-Modus aktiv (Developer Mode). Bearbeitung im Overlay bestätigen um Änderungen zu erlauben.",
            code: "developer_mode_read_only",
          },
          { status: 423 }, // Locked
        );
      }
    }
  }

  const res = NextResponse.next();
  if (!isApi) {
    res.headers.set("Cache-Control", "private, no-store, must-revalidate");
  }
  return res;
}

export const config = {
  matcher: [
    // Deckt Non-API-Pages ab (fuer Cache-Control) und /api/* (fuer
    // Write-Guard). Statische Assets bleiben aussen vor.
    "/((?!_next/static|_next/image|sw\\.js|manifest\\.json|favicon\\.ico|offline|.*\\.(?:png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf)).*)",
  ],
};
