// Finanzen Welle 1 — EINZIGER Supabase-Client mit Schema `finanzen`.
//
// Das Schema ist in PostgREST exponiert, aber anon/authenticated haben
// keine USAGE darauf (Migration 326). Nur service_role kommt hinein — und
// service_role gibt es nur serverseitig. Diese Datei ist der einzige Ort
// im Code, der einen Client auf dieses Schema erzeugt (Isolations-Test
// src/lib/finanzen/isolation.test.ts prüft das per Import-Graph + Grep).
//
// Nur in Server-Code verwenden (Routen, Cron, lib/finanzen). Nie an den
// Browser, nie in Client-Komponenten importieren.

import { createClient } from "@supabase/supabase-js";

export const FINANZEN_SCHEMA = "finanzen";

function erzeugeClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    db: { schema: FINANZEN_SCHEMA },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export type FinanzenClient = ReturnType<typeof erzeugeClient>;

/** EINZIGER Supabase-Client mit Schema finanzen (service_role). Nur in
 *  Server-Code (Routen, Cron, lib/finanzen). Nie an den Browser.
 *  Für public.profiles weiterhin createAdminClient(). */
export function finanzenDb(): FinanzenClient {
  return erzeugeClient();
}
