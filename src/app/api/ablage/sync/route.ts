import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { timingSafeEqual } from "crypto";

// Abhol-Schnittstelle fuer den NAS-Sync-Client (laeuft im Buero/auf dem
// UGREEN und POLLT — das NAS muss dafuer NICHT aus dem Internet
// erreichbar sein).
//
//   GET  → Liste der noch nicht abgeholten Ablagen: pro Datei eine
//          signierte Download-URL (1h) + exakter Zielordner/Dateiname
//          (inkl. Umlaute — die stehen in der DB, nicht im Storage-Key).
//          Zusaetzlich `ordner`: im FSM neu angelegte Ordner, die der
//          Client physisch auf dem NAS erstellen soll (Leo 2026-09-30).
//   POST { ids: [...], ordner: [...] } → markiert Ablagen als uebertragen
//          (synced_at, loescht Dateien aus dem Uebergabe-Bucket) bzw.
//          bestaetigt erstellte Ordner (nas_ausstehend -> false).
//
// Auth: Bearer-Token aus env ABLAGE_SYNC_TOKEN (eigenes Secret nur fuer
// diesen Client, timing-safe verglichen). Ohne konfiguriertes Secret
// antwortet die Route 503 — sie ist dann faktisch abgeschaltet.

function tokenOk(request: NextRequest): boolean | null {
  const secret = process.env.ABLAGE_SYNC_TOKEN;
  if (!secret || secret.length < 32) return null; // nicht konfiguriert
  const header = request.headers.get("authorization") ?? "";
  const angeboten = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(angeboten);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(request: NextRequest) {
  const ok = tokenOk(request);
  if (ok === null) return NextResponse.json({ success: false, error: "Sync nicht konfiguriert" }, { status: 503 });
  if (!ok) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  try {
    const admin = createAdminClient();

    // Sync-Puls fuer den UI-Countdown (Migr 280): jeder Poll stempelt
    // letzter_poll; der Client meldet sein Intervall als ?i=<sekunden>.
    const intervall = Math.min(3600, Math.max(15, parseInt(request.nextUrl.searchParams.get("i") ?? "60", 10) || 60));
    await admin.from("ablage_sync_status").upsert({ id: 1, letzter_poll: new Date().toISOString(), intervall_s: intervall });

    const { data, error } = await admin
      .from("ablage_items")
      .select("id, ordner_pfad, abgelegt_name, storage_path, file_size, mime_type")
      .is("synced_at", null)
      .neq("storage_path", "")
      .order("created_at", { ascending: true })
      .limit(100);
    if (error) throw new Error(error.message);

    const items = [];
    for (const row of data ?? []) {
      const { data: signed } = await admin.storage.from("nas-ablage").createSignedUrl(row.storage_path, 3600);
      if (!signed?.signedUrl) continue;
      items.push({
        id: row.id,
        ordner: row.ordner_pfad,
        dateiname: row.abgelegt_name,
        url: signed.signedUrl,
        file_size: row.file_size,
        mime_type: row.mime_type,
      });
    }
    // Im FSM angelegte Ordner, die auf dem NAS noch fehlen — sortiert,
    // damit Eltern vor ihren Unterordnern erstellt werden.
    const { data: ausstehend } = await admin
      .from("ablage_ordner")
      .select("pfad")
      .eq("nas_ausstehend", true)
      .order("pfad")
      .limit(200);
    const ordner = (ausstehend ?? []).map((r) => r.pfad as string);

    // Offene Umbenennungs-Auftraege fuer Bestandsdateien (Migr 278).
    const { data: ren } = await admin
      .from("ablage_renames")
      .select("pfad, neuer_name")
      .order("created_at")
      .limit(200);
    const umbenennungen = (ren ?? []).filter((r) => r.neuer_name && !String(r.neuer_name).includes("/"));

    // Offene Verschiebe-Auftraege (Migr 282): Datei -> anderer Ordner
    // bzw. Papierkorb 99_System/Papierkorb (liegt bewusst im vom Scan
    // ausgeschlossenen 99_System — taucht nie in Auswahl/Suche auf).
    const { data: mv } = await admin
      .from("ablage_moves")
      .select("pfad, ziel_ordner")
      .order("created_at")
      .limit(200);
    const verschiebungen = mv ?? [];

    // Datei-Abrufe (Migr 279): Housekeeping (aelter 1h raus) + offene
    // Abrufe mit signierter Upload-URL — der Client laedt die Datei
    // damit direkt in den Uebergabe-Bucket (kein Body-Limit im FSM).
    const stunde = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: alteAbrufe } = await admin
      .from("ablage_abrufe")
      .select("id, storage_path")
      .lt("created_at", stunde);
    if ((alteAbrufe ?? []).length > 0) {
      const altePfade = (alteAbrufe ?? []).map((r) => r.storage_path).filter(Boolean) as string[];
      if (altePfade.length > 0) await admin.storage.from("nas-ablage").remove(altePfade);
      await admin.from("ablage_abrufe").delete().in("id", (alteAbrufe ?? []).map((r) => r.id));
    }
    const { data: offeneAbrufe } = await admin
      .from("ablage_abrufe")
      .select("id, pfad")
      .eq("status", "wartet")
      .order("created_at")
      .limit(20);
    const abrufe = [];
    for (const r of offeneAbrufe ?? []) {
      const { data: up } = await admin.storage.from("nas-ablage").createSignedUploadUrl(`abrufe/${r.id}`);
      if (up?.signedUrl) abrufe.push({ id: r.id, pfad: r.pfad, url: up.signedUrl });
    }

    return NextResponse.json({ success: true, items, ordner, umbenennungen, verschiebungen, abrufe });
  } catch (e) {
    logError("ablage.sync.get", e);
    return NextResponse.json({ success: false, error: "Sync-Liste fehlgeschlagen" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const ok = tokenOk(request);
  if (ok === null) return NextResponse.json({ success: false, error: "Sync nicht konfiguriert" }, { status: 503 });
  if (!ok) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json().catch(() => null);
    const ids = Array.isArray(body?.ids) ? (body.ids as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 200) : [];
    const ordner = Array.isArray(body?.ordner) ? (body.ordner as unknown[]).filter((x): x is string => typeof x === "string").slice(0, 200) : [];
    const hatUmbenannt = Array.isArray(body?.umbenannt) && body.umbenannt.length > 0;
    const hatVerschoben = Array.isArray(body?.verschoben) && body.verschoben.length > 0;
    const hatAbrufe = Array.isArray(body?.abrufe) && body.abrufe.length > 0;
    if (ids.length === 0 && ordner.length === 0 && !hatUmbenannt && !hatVerschoben && !hatAbrufe) {
      return NextResponse.json({ success: false, error: "ids/ordner/umbenannt/verschoben/abrufe fehlt" }, { status: 400 });
    }
    const admin = createAdminClient();
    let bestaetigt = 0;
    if (ids.length > 0) {
      const { data: rows, error } = await admin
        .from("ablage_items")
        .update({ synced_at: new Date().toISOString() })
        .in("id", ids)
        .is("synced_at", null)
        .select("id, storage_path");
      if (error) throw new Error(error.message);
      bestaetigt = (rows ?? []).length;
      const pfade = (rows ?? []).map((r) => r.storage_path).filter(Boolean);
      if (pfade.length > 0) {
        // Uebergabe-Bucket aufraeumen — die Datei liegt jetzt auf dem NAS.
        const { error: remErr } = await admin.storage.from("nas-ablage").remove(pfade);
        if (remErr) logError("ablage.sync.cleanup", remErr, { anzahl: pfade.length });
      }
    }
    if (ordner.length > 0) {
      // Der Client hat diese Ordner physisch angelegt.
      const { error } = await admin
        .from("ablage_ordner")
        .update({ nas_ausstehend: false })
        .in("pfad", ordner)
        .eq("nas_ausstehend", true);
      if (error) throw new Error(error.message);
    }
    // Bestaetigte Umbenennungen: Auftrag abschliessen + Datei-Index
    // sofort nachziehen (der naechste Scan wuerde es auch heilen).
    const umbenannt = Array.isArray(body?.umbenannt)
      ? (body.umbenannt as { pfad?: unknown; neuer_pfad?: unknown }[])
          .map((u) => ({ pfad: String(u?.pfad ?? ""), neuer_pfad: String(u?.neuer_pfad ?? "") }))
          .filter((u) => u.pfad && u.neuer_pfad && !u.neuer_pfad.includes("..") && !u.neuer_pfad.startsWith("/"))
          .slice(0, 200)
      : [];
    for (const u of umbenannt) {
      await admin.from("ablage_renames").delete().eq("pfad", u.pfad);
      const neuerName = u.neuer_pfad.split("/").pop() ?? u.neuer_pfad;
      await admin
        .from("ablage_datei_index")
        .update({ pfad: u.neuer_pfad, name: neuerName, aktualisiert: new Date().toISOString() })
        .eq("pfad", u.pfad);
    }
    // Bestaetigte Verschiebungen: Auftrag schliessen + Index nachziehen.
    // Ziel im Papierkorb (99_System/...) liegt ausserhalb des Scans ->
    // Index-Zeile loeschen statt umhaengen.
    const verschoben = Array.isArray(body?.verschoben)
      ? (body.verschoben as { pfad?: unknown; neuer_pfad?: unknown }[])
          .map((u) => ({ pfad: String(u?.pfad ?? ""), neuer_pfad: String(u?.neuer_pfad ?? "") }))
          .filter((u) => u.pfad && u.neuer_pfad && !u.neuer_pfad.includes("..") && !u.neuer_pfad.startsWith("/"))
          .slice(0, 200)
      : [];
    for (const u of verschoben) {
      await admin.from("ablage_moves").delete().eq("pfad", u.pfad);
      if (u.neuer_pfad.startsWith("99_System/")) {
        await admin.from("ablage_datei_index").delete().eq("pfad", u.pfad);
      } else {
        const i = u.neuer_pfad.lastIndexOf("/");
        await admin
          .from("ablage_datei_index")
          .update({
            pfad: u.neuer_pfad,
            ordner_pfad: i === -1 ? "" : u.neuer_pfad.slice(0, i),
            name: u.neuer_pfad.split("/").pop() ?? u.neuer_pfad,
            aktualisiert: new Date().toISOString(),
          })
          .eq("pfad", u.pfad);
      }
    }
    // Abruf-Ergebnisse: Client hat die Datei hochgeladen (ok) oder
    // konnte nicht (fehler) — Status fuer das UI-Polling setzen.
    const abrufe = Array.isArray(body?.abrufe)
      ? (body.abrufe as { id?: unknown; ok?: unknown; fehler?: unknown }[])
          .map((u) => ({ id: String(u?.id ?? ""), ok: u?.ok === true, fehler: String(u?.fehler ?? "").slice(0, 200) }))
          .filter((u) => /^[0-9a-f-]{36}$/.test(u.id))
          .slice(0, 50)
      : [];
    for (const u of abrufe) {
      await admin
        .from("ablage_abrufe")
        .update(u.ok ? { status: "bereit", storage_path: `abrufe/${u.id}` } : { status: "fehler", fehler: u.fehler || "Abruf fehlgeschlagen" })
        .eq("id", u.id)
        .eq("status", "wartet");
    }
    return NextResponse.json({ success: true, bestaetigt, ordnerBestaetigt: ordner.length, umbenannt: umbenannt.length, abrufeBestaetigt: abrufe.length });
  } catch (e) {
    logError("ablage.sync.post", e);
    return NextResponse.json({ success: false, error: "Sync-Bestätigung fehlgeschlagen" }, { status: 500 });
  }
}
