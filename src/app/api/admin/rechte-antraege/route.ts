// Rechte-Anträge (Vier Augen bei Rechten, Lohn-Umbau Phase 1, Migration 361).
//
// GET  /api/admin/rechte-antraege            — offene + zuletzt entschiedene Anträge,
//                                              je mit darf_bestaetigen/hinderungsgrund
// POST /api/admin/rechte-antraege            — Body { id, aktion: "bestaetigen" | "ablehnen" }
//
// Bestätigen darf nur ein Admin, der NICHT den Antrag gestellt hat, bei einer
// Gewährung nicht selbst die Zielperson ist, auf einem eigenen vertrauten
// Gerät, innerhalb von 24 h, nicht in «Ansicht als». Die DB-Funktion
// rechte_antrag_ausfuehren prüft Admin/Antragsteller/Ziel/Frist erneut und
// führt die Änderung aus (nur dort lassen die Trigger sie zu).
// Ablehnen (bzw. eigenen Antrag zurückziehen) darf jeder Admin.

import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, pruefeVertrautesGeraet } from "@/lib/api-auth";
import { logPermissionAudit } from "@/lib/permission-audit";
import { ladeName, rechteHinderungsgrund as hinderungsgrund } from "@/lib/lohn/rechte-antraege";
import { ROLES_TAG } from "@/lib/cached";
import { isUuid } from "@/lib/search-escape";
import { logError } from "@/lib/log";

type AntragRow = {
  id: string;
  art: "person" | "rolle_rechte" | "vertretung";
  ziel_profile_id: string | null;
  ziel_name: string | null;
  ziel_rolle: string | null;
  payload: Record<string, unknown>;
  beschreibung: string;
  gewaehrt: boolean;
  status: "offen" | "bestaetigt" | "abgelehnt";
  beantragt_von: string;
  beantragt_von_name: string | null;
  beantragt_at: string;
  gueltig_bis: string;
  entschieden_von_name: string | null;
  entschieden_at: string | null;
  notweg_grund: string | null;
};

const SPALTEN =
  "id, art, ziel_profile_id, ziel_name, ziel_rolle, payload, beschreibung, gewaehrt, status, beantragt_von, beantragt_von_name, beantragt_at, gueltig_bis, entschieden_von_name, entschieden_at, notweg_grund";

export async function GET() {
  const auth = await requireAdmin({ wartung: "rechte" });
  if (auth.error) return auth.error;
  const admin = createAdminClient();
  const [offenRes, letzteRes] = await Promise.all([
    admin.from("rechte_antraege").select(SPALTEN).eq("status", "offen").order("beantragt_at", { ascending: false }).limit(100),
    admin.from("rechte_antraege").select(SPALTEN).neq("status", "offen").order("entschieden_at", { ascending: false }).limit(20),
  ]);
  const err = offenRes.error ?? letzteRes.error;
  if (err) return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  const geraet = (await pruefeVertrautesGeraet(auth.user.id)) === "vertraut";
  const mitGrund = (rows: AntragRow[]) =>
    rows.map((a) => {
      const grund = hinderungsgrund(a, auth.user.id, geraet, auth.isImpersonating);
      return { ...a, abgelaufen: a.status === "offen" && Date.parse(a.gueltig_bis) <= Date.now(), darf_bestaetigen: grund === null, hinderungsgrund: grund, eigener: a.beantragt_von === auth.user.id };
    });
  return NextResponse.json({
    success: true,
    offen: mitGrund((offenRes.data ?? []) as AntragRow[]),
    entschieden: mitGrund((letzteRes.data ?? []) as AntragRow[]),
  });
}

export async function POST(request: Request) {
  const auth = await requireAdmin({ wartung: "rechte" });
  if (auth.error) return auth.error;
  if (auth.isImpersonating) {
    return NextResponse.json({ success: false, error: "In «Ansicht als» ist keine Entscheidung möglich." }, { status: 403 });
  }
  const body = (await request.json().catch(() => null)) as { id?: unknown; aktion?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : "";
  const aktion = body?.aktion === "bestaetigen" ? "bestaetigen" : body?.aktion === "ablehnen" ? "ablehnen" : null;
  if (!isUuid(id) || !aktion) return NextResponse.json({ success: false, error: "id und aktion nötig" }, { status: 400 });

  const admin = createAdminClient();
  const { data, error } = await admin.from("rechte_antraege").select(SPALTEN).eq("id", id).maybeSingle();
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ success: false, error: "Antrag nicht gefunden" }, { status: 404 });
  const a = data as AntragRow;
  const name = await ladeName(admin, auth.user.id);

  if (aktion === "ablehnen") {
    if (a.status !== "offen") return NextResponse.json({ success: false, error: "Antrag ist nicht mehr offen" }, { status: 409 });
    const { error: upErr, count } = await admin
      .from("rechte_antraege")
      .update({ status: "abgelehnt", entschieden_von: auth.user.id, entschieden_von_name: name, entschieden_at: new Date().toISOString() }, { count: "exact" })
      .eq("id", id)
      .eq("status", "offen");
    if (upErr) return NextResponse.json({ success: false, error: upErr.message }, { status: 500 });
    if (!count) return NextResponse.json({ success: false, error: "Antrag ist nicht mehr offen" }, { status: 409 });
    await logPermissionAudit({
      actor_profile_id: auth.user.id,
      action: "rechte.antrag_abgelehnt",
      ...(a.ziel_profile_id ? { target_profile_id: a.ziel_profile_id } : { target_role_slug: a.ziel_rolle ?? "lohn_einstellungen" }),
      details: { antrag_id: id, art: a.art, beschreibung: a.beschreibung, eigener: a.beantragt_von === auth.user.id },
    } as Parameters<typeof logPermissionAudit>[0]);
    return NextResponse.json({ success: true, status: "abgelehnt" });
  }

  const geraet = (await pruefeVertrautesGeraet(auth.user.id)) === "vertraut";
  const grund = hinderungsgrund(a, auth.user.id, geraet, false);
  if (grund) {
    const status = /Abgelaufen/.test(grund) ? 410 : /nicht mehr|Schon|Abgelehnt/.test(grund) ? 409 : 403;
    return NextResponse.json({ success: false, error: grund }, { status });
  }

  const { error: rpcErr } = await admin.rpc("rechte_antrag_ausfuehren", {
    p_id: id,
    p_bestaetiger: auth.user.id,
    p_bestaetiger_name: name,
    p_notweg_grund: null,
  });
  if (rpcErr) return NextResponse.json({ success: false, error: rpcErr.message }, { status: 400 });

  // Folgeschritte ausserhalb der DB.
  let warnung: string | undefined;
  if (a.art === "person" && a.payload?.aktivieren === true && a.ziel_profile_id) {
    const { error: banErr } = await admin.auth.admin.updateUserById(a.ziel_profile_id, { ban_duration: "none" });
    if (banErr) {
      logError("rechte.antrag.unban", banErr, { antrag: id });
      warnung = "Bestätigt, aber die Login-Sperre konnte nicht aufgehoben werden — bitte erneut reaktivieren.";
    }
  }
  if (a.art === "rolle_rechte") revalidateTag(ROLES_TAG, { expire: 0 });
  return NextResponse.json({ success: true, status: "bestaetigt", ...(warnung ? { warnung } : {}) });
}
