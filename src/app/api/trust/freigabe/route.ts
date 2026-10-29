// Gerätefreigabe per Knopf (Lohn-Umbau Phase 1, gilt auch für die Finanzen).
//
// GET  /api/trust/freigabe?id=<device_id>   — Anfrage ansehen (wer, welches Gerät,
//                                              gültig bis, darf ich freigeben?)
// POST /api/trust/freigabe                   — Body { id, aktion: "freigeben" | "ablehnen" }
//
// Freigeben darf nur, wer
//   - angemeldet ist (kein anonymer Mail-Link, nicht in «Ansicht als»),
//   - NICHT die Person ist, der das Gerät gehört,
//   - Admin ist oder als Vertretung eingetragen ist (lohn_einstellungen),
//   - selbst auf einem vertrauten Gerät sitzt,
// und nur, solange die Anfrage offen und jünger als 24 h ist.
// Jede Entscheidung steht im Rechte-Protokoll (permission_audit_log).
// Notweg ohne zweiten Admin: scripts/geraet-notfreigabe.mjs (Mischa).

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser, pruefeVertrautesGeraet } from "@/lib/api-auth";
import { logPermissionAudit } from "@/lib/permission-audit";
import { pruefeGeraetFreigabe } from "@/lib/lohn/zugriff";
import { anfrageAbgelaufen, anfrageGueltigBis } from "@/lib/geraete-freigabe";
import { isUuid } from "@/lib/search-escape";

type GeraetRow = {
  id: string;
  user_id: string;
  device_name: string;
  user_agent_hint: string | null;
  ip_hint: string | null;
  status: "pending" | "approved" | "revoked";
  requested_at: string;
  anfrage_gueltig_bis: string | null;
  approved_at: string | null;
  approved_by_name: string | null;
  revoked_at: string | null;
};

async function ladeAnfrage(id: string) {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("trusted_devices")
    .select("id, user_id, device_name, user_agent_hint, ip_hint, status, requested_at, anfrage_gueltig_bis, approved_at, approved_by_name, revoked_at")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return { admin, row: (data as GeraetRow | null) ?? null };
}

export async function GET(request: Request) {
  const auth = await requireUser({ wartung: "geraete" });
  if (auth.error) return auth.error;
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!isUuid(id)) return NextResponse.json({ success: false, error: "Anfrage nicht gefunden" }, { status: 404 });

  try {
    const { admin, row } = await ladeAnfrage(id);
    if (!row) return NextResponse.json({ success: false, error: "Anfrage nicht gefunden" }, { status: 404 });
    const pruef = await pruefeGeraetFreigabe(admin, auth.user.id, row.user_id);
    // Nur Freigabe-Berechtigte (oder die Person selbst) sehen die Anfrage.
    if (pruef.verboten && row.user_id !== auth.user.id) {
      return NextResponse.json({ success: false, error: pruef.verboten }, { status: 403 });
    }
    const { data: person, error: pErr } = await admin.from("profiles").select("full_name, email").eq("id", row.user_id).maybeSingle();
    if (pErr) throw new Error(pErr.message);
    const geraet = await pruefeVertrautesGeraet(auth.user.id);
    const abgelaufen = row.status === "pending" && anfrageAbgelaufen(row);
    let hinderungsgrund: string | null = pruef.verboten;
    if (!hinderungsgrund && auth.isImpersonating) hinderungsgrund = "In «Ansicht als» ist keine Freigabe möglich.";
    if (!hinderungsgrund && geraet !== "vertraut") hinderungsgrund = "Freigeben geht nur von einem eigenen vertrauten Gerät aus.";
    if (!hinderungsgrund && row.status !== "pending") hinderungsgrund = row.status === "approved" ? "Schon freigegeben." : "Widerrufen bzw. abgelehnt.";
    if (!hinderungsgrund && abgelaufen) hinderungsgrund = "Die Anfrage ist älter als 24 Stunden — bitte neu anfragen lassen.";
    return NextResponse.json({
      success: true,
      anfrage: {
        id: row.id,
        person: person?.full_name ?? person?.email ?? "?",
        email: person?.email ?? null,
        geraet: row.device_name,
        browser: row.user_agent_hint,
        ip: row.ip_hint,
        status: row.status,
        angefragt_at: row.requested_at,
        gueltig_bis: anfrageGueltigBis(row)?.toISOString() ?? null,
        abgelaufen,
        freigegeben_at: row.approved_at,
        freigegeben_von: row.approved_by_name,
      },
      darf_freigeben: hinderungsgrund === null,
      hinderungsgrund,
    });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await requireUser({ wartung: "geraete" });
  if (auth.error) return auth.error;
  if (auth.isImpersonating) {
    return NextResponse.json({ success: false, error: "In «Ansicht als» ist keine Freigabe möglich." }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as { id?: unknown; aktion?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  const aktion = body?.aktion === "ablehnen" ? "ablehnen" : body?.aktion === "freigeben" ? "freigeben" : null;
  if (!isUuid(id) || !aktion) return NextResponse.json({ success: false, error: "id und aktion nötig" }, { status: 400 });

  try {
    const { admin, row } = await ladeAnfrage(id);
    if (!row) return NextResponse.json({ success: false, error: "Anfrage nicht gefunden" }, { status: 404 });
    const pruef = await pruefeGeraetFreigabe(admin, auth.user.id, row.user_id);
    if (pruef.verboten) return NextResponse.json({ success: false, error: pruef.verboten }, { status: 403 });
    if ((await pruefeVertrautesGeraet(auth.user.id)) !== "vertraut") {
      return NextResponse.json({ success: false, error: "Freigeben geht nur von einem eigenen vertrauten Gerät aus." }, { status: 403 });
    }
    if (row.status !== "pending" || row.revoked_at) {
      return NextResponse.json({ success: false, error: "Diese Anfrage ist nicht mehr offen." }, { status: 409 });
    }
    if (aktion === "freigeben" && anfrageAbgelaufen(row)) {
      return NextResponse.json({ success: false, error: "Die Anfrage ist älter als 24 Stunden — bitte neu anfragen lassen." }, { status: 410 });
    }

    const name = pruef.freigeber?.name ?? null;
    const jetzt = new Date().toISOString();
    const update = aktion === "freigeben"
      ? {
          status: "approved",
          approved_at: jetzt,
          approved_by: auth.user.id,
          approved_by_name: name,
          approved_by_email: auth.user.email ?? null,
          freigabe_art: pruef.vertretung ? "vertretung" : "admin",
          confirm_token_hash: null,
        }
      : { status: "revoked", revoked_at: jetzt, confirm_token_hash: null };
    // Bedingt auf «noch offen» — zwei gleichzeitige Klicks entscheiden nur einmal.
    const { error, count } = await admin
      .from("trusted_devices")
      .update(update, { count: "exact" })
      .eq("id", id)
      .eq("status", "pending")
      .is("revoked_at", null);
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    if (!count) return NextResponse.json({ success: false, error: "Diese Anfrage ist nicht mehr offen." }, { status: 409 });

    await logPermissionAudit({
      actor_profile_id: auth.user.id,
      action: aktion === "freigeben" ? "device.approved" : "device.rejected",
      target_profile_id: row.user_id,
      details: { device_id: id, geraet: row.device_name, als: pruef.vertretung ? "vertretung" : "admin" },
    });
    return NextResponse.json({ success: true, status: aktion === "freigeben" ? "approved" : "revoked" });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
