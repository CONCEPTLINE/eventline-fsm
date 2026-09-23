// Generische Update-Route fuer whitelisted Tabellen+Spalten — Gegenstueck
// zu /api/db/delete (siehe dort fuer die Begruendung der Server-Boundary).
// Benutzt den authenticated Supabase-Client, damit RLS-Policies weiterhin
// entscheiden ob der User die Zeile aendern darf.
//
// Body: { table: string, id: string, values: Record<string, unknown> }
//
// Wichtig: hier landen nur "kleine" Attribut-Updates ohne Workflow-Logik
// (z.B. Dokument-Ordner). Alles mit Side-Effects/Validierung hat eigene
// Routes. Spalten sind pro Tabelle whitelisted — ein Client kann also
// nicht beliebige Felder (storage_path, uploaded_by, …) umbiegen.

import { NextRequest, NextResponse } from "next/server";
import { requireUser } from "@/lib/api-auth";
import { createClient } from "@/lib/supabase/server";

const ALLOWED_UPDATES: Record<string, ReadonlySet<string>> = {
  // Dokumente: nur die Ordner-Zuordnung (doc-folders.tsx) ist frei editierbar.
  documents: new Set(["folder"]),
};

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;

  const body = await req.json().catch(() => ({}));
  const { table, id, values } = body as {
    table?: string;
    id?: string;
    values?: Record<string, unknown>;
  };
  const allowedColumns = table ? ALLOWED_UPDATES[table] : undefined;
  if (!table || !id || !allowedColumns) {
    return NextResponse.json(
      { ok: false, error: "Tabelle oder ID ungültig" },
      { status: 400 },
    );
  }
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    return NextResponse.json(
      { ok: false, error: "Spalten ungültig für diese Tabelle" },
      { status: 400 },
    );
  }
  const keys = Object.keys(values);
  if (keys.length === 0 || keys.some((k) => !allowedColumns.has(k))) {
    return NextResponse.json(
      { ok: false, error: "Spalten ungültig für diese Tabelle" },
      { status: 400 },
    );
  }

  // authenticated client → RLS-Policies entscheiden ob der User wirklich
  // aendern darf. Service-Role wird bewusst NICHT genutzt (kein Bypass).
  const supa = await createClient();
  const { error } = await supa.from(table).update(values).eq("id", id);
  if (error) {
    // RLS-Denial einheitlich uebersetzen — gleiche Logik wie /api/db/delete.
    const isPermission =
      error.code === "42501" ||
      error.code === "PGRST201" ||
      /row-level security|permission denied|insufficient[_ ]privilege/i.test(error.message || "");
    return NextResponse.json(
      { ok: false, error: isPermission ? "Keine Berechtigung für diese Aktion" : error.message },
      { status: isPermission ? 403 : 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
