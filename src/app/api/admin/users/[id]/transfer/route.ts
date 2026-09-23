// POST /api/admin/users/[id]/transfer — Owner-Wechsel VOR User-Delete.
//
// Bestimmte cascade-destruktive FK-Bindungen (aktuell Vertriebs-Ordner)
// koennen fachlich an einen anderen User uebertragen werden. Der Admin
// waehlt im Delete-Modal pro Tabelle einen neuen Owner; dieser Endpoint
// fuehrt die UPDATEs aus. Danach ist die Cascade beim Delete leer.
//
// Body:
//   { transfers: [{ table: string, new_owner_id: string }, ...] }
//
// Sicherheit:
//   - requireAdmin (nur Admin darf User-Verwaltung).
//   - Strikte TABLE_WHITELIST: nur die zwei explizit transfer-baren
//     Tabellen. Kein Path fuer beliebige Table-Namen — das schuetzt vor
//     jeglicher Injection ueber den Body (Supabase-Client interpretiert
//     .from(x) sonst als beliebige Table).
//   - new_owner_id muss existieren + darf NICHT der zu loeschende User
//     selbst sein (sonst waere der Transfer no-op und die Cascade wieder
//     scharf).
//   - new_owner_id muss aktiv sein (deaktivierte Owner sind semantisch
//     Sondermuell — der Transfer sollte auf einen produktiven User gehen).

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/api-auth";
import { isUuid } from "@/lib/search-escape";
import { logError } from "@/lib/log";

// Whitelist. Muss synchron zu TRANSFERABLE in ../impact/route.ts bleiben —
// dort steuert es die transfer_possible-Flag im UI.
//
// Jeder Eintrag: welche Spalte referenziert den User, den wir umlenken?
const TABLE_WHITELIST: Record<string, { col: string }> = {
  vertrieb_folders: { col: "owner_id" },
  vertrieb_lead_folders: { col: "owner_id" },
};

type TransferRequest = { table: string; new_owner_id: string };

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json(
      { success: false, error: "Ungültige Profil-ID" },
      { status: 400 },
    );
  }

  const body = await request.json().catch(() => null);
  if (!body || !Array.isArray(body.transfers)) {
    return NextResponse.json(
      { success: false, error: "Body muss { transfers: [...] } enthalten" },
      { status: 400 },
    );
  }

  // Body normalisieren + validieren. Jeder Eintrag muss table + new_owner_id
  // haben; table muss in der Whitelist stehen. Formal-Check VOR jedem DB-
  // Zugriff, damit ein einziger Bad-Row den ganzen Request kippt bevor
  // irgendwas geschrieben wird (all-or-nothing).
  const raw = body.transfers as unknown[];
  const transfers: TransferRequest[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") {
      return NextResponse.json(
        { success: false, error: "Ungültiger transfer-Eintrag" },
        { status: 400 },
      );
    }
    const table = (t as Record<string, unknown>).table;
    const newOwnerId = (t as Record<string, unknown>).new_owner_id;
    if (typeof table !== "string" || !TABLE_WHITELIST[table]) {
      return NextResponse.json(
        { success: false, error: `Tabelle nicht übertragbar: ${String(table)}` },
        { status: 400 },
      );
    }
    if (typeof newOwnerId !== "string" || !isUuid(newOwnerId)) {
      return NextResponse.json(
        { success: false, error: "Ungültige new_owner_id" },
        { status: 400 },
      );
    }
    if (newOwnerId === id) {
      return NextResponse.json(
        { success: false, error: "Der neue Owner darf nicht der zu löschende User sein" },
        { status: 400 },
      );
    }
    transfers.push({ table, new_owner_id: newOwnerId });
  }

  if (transfers.length === 0) {
    return NextResponse.json(
      { success: false, error: "Keine transfers angegeben" },
      { status: 400 },
    );
  }

  const admin = createAdminClient();

  // Alle referenzierten new_owner_ids muessen als aktives Profil existieren.
  // Ein Transfer auf einen geloeschten/deaktivierten User waere fachlich
  // Sondermuell — die Ordner wuerden gleich beim naechsten Cleanup wieder
  // rausfallen.
  const uniqueOwners = Array.from(new Set(transfers.map((t) => t.new_owner_id)));
  const { data: ownerProfiles, error: ownerErr } = await admin
    .from("profiles")
    .select("id, is_active")
    .in("id", uniqueOwners);
  if (ownerErr) {
    logError("admin.users.transfer.owner_lookup", ownerErr, { userId: id });
    return NextResponse.json(
      { success: false, error: ownerErr.message },
      { status: 500 },
    );
  }
  const ownerMap = new Map<string, boolean>(
    (ownerProfiles ?? []).map((p) => [p.id, p.is_active]),
  );
  for (const oid of uniqueOwners) {
    if (!ownerMap.has(oid)) {
      return NextResponse.json(
        { success: false, error: `Neuer Owner existiert nicht: ${oid}` },
        { status: 400 },
      );
    }
    if (ownerMap.get(oid) === false) {
      return NextResponse.json(
        { success: false, error: `Neuer Owner ist deaktiviert: ${oid}` },
        { status: 400 },
      );
    }
  }

  // Transfers ausfuehren. Kein Bulk-UPDATE moeglich (unterschiedliche
  // new_owner_id pro table), aber die Updates gehen auf VERSCHIEDENE
  // Tabellen → parallel via Promise.all statt sequentiell. Nur wenn eine
  // Tabelle mehrfach im Body steht (degenerierter Client) sequentiell,
  // damit gleichzeitige Updates auf derselben Spalte nicht racen.
  // count:'exact' fuers Feedback, wie viele Zeilen wirklich umgezogen
  // wurden (kann 0 sein wenn zwischen /impact und /transfer schon
  // aufgeraeumt wurde — nicht als Fehler werten, nur reporten).
  const runUpdate = (t: TransferRequest) => {
    const def = TABLE_WHITELIST[t.table];
    return admin
      .from(t.table)
      .update({ [def.col]: t.new_owner_id }, { count: "exact" })
      .eq(def.col, id);
  };
  const results: { error: { message: string } | null; count: number | null }[] = [];
  const allDistinct = new Set(transfers.map((t) => t.table)).size === transfers.length;
  if (allDistinct) {
    results.push(...(await Promise.all(transfers.map(runUpdate))));
  } else {
    for (const t of transfers) results.push(await runUpdate(t));
  }

  const transferred: { table: string; count: number }[] = [];
  let firstError: { table: string; message: string } | null = null;
  for (let i = 0; i < transfers.length; i++) {
    const t = transfers[i];
    const { error, count } = results[i];
    if (error) {
      logError("admin.users.transfer.update", error, {
        userId: id,
        table: t.table,
        new_owner_id: t.new_owner_id,
      });
      if (!firstError) firstError = { table: t.table, message: error.message };
    } else {
      transferred.push({ table: t.table, count: count ?? 0 });
    }
  }
  if (firstError) {
    return NextResponse.json(
      {
        success: false,
        error: `Transfer für ${firstError.table} fehlgeschlagen: ${firstError.message}`,
        transferred, // was durch ist, damit der Client den Teilstand kennt
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ success: true, transferred });
}
