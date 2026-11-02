// Getränke-Catering — gemeinsame Helfer der API-Routen (nur serverseitig).
import { NextResponse } from "next/server";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Einheitliche Fehlerantwort: { success: false, error }. */
export const fehler = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status });
