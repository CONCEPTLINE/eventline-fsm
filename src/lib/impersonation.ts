// Impersonation-Cookie (View-As / Dev-Modus): EINE Quelle fuer den
// Cookie-Namen. Vorher war das Literal in 6 Dateien unabhaengig
// definiert (middleware, api-auth, supabase/client, drei Layouts) —
// Namens-Drift haette die Impersonation still zerlegt.

export const IMPERSONATE_COOKIE = "eventline_impersonate_user_id";

/** Cookie-Wert im Browser lesen (Client-Komponenten/Layouts). */
export function readImpersonationCookie(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(new RegExp(`(?:^|; )${IMPERSONATE_COOKIE}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}
