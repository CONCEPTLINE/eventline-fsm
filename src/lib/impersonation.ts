// Impersonation-Cookie (View-As / Dev-Modus): EINE Quelle fuer den
// Cookie-Namen. Vorher war das Literal in 6 Dateien unabhaengig
// definiert (middleware, api-auth, supabase/client, drei Layouts) —
// Namens-Drift haette die Impersonation still zerlegt.

export const IMPERSONATE_COOKIE = "eventline_impersonate_user_id";

/** Bearbeiten-Modus der Impersonation ("1" = Schreiben freigegeben, sonst
 *  nur lesen) — gesetzt ueber /api/dev/impersonate/write (Overlay). */
export const IMPERSONATE_WRITE_COOKIE = "eventline_impersonate_write";

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/** Cookie-Wert im Browser lesen (Client-Komponenten/Layouts). */
export function readImpersonationCookie(): string | null {
  return readCookie(IMPERSONATE_COOKIE);
}

/** Bearbeiten-Modus im Browser: true nur bei Cookie-Wert "1". Ob die
 *  Impersonation selbst gilt, entscheidet der Server (resolveImpersonation). */
export function readImpersonationWriteCookie(): boolean {
  return readCookie(IMPERSONATE_WRITE_COOKIE) === "1";
}
