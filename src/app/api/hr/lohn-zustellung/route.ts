// Zustellung der Lohndokumente: Wahl digital/Papier und Nachweis je Dokument
// (Lohn-Umbau Phase 4, Logik src/lib/lohn/zustellung.ts).
//
// GET                       eigene Wahl («Meine»; nie in «Ansicht als»)
//                           → { wahl: {wahl, version, gewaehlt_at, quelle} | null, version_aktuell }
// GET ?profile_id=X         Lohnverwaltung (Lohnrecht + vertrautes Gerät):
//                           → { wahl, historie, zustellung: { [wage_document_id]: Nachweis },
//                               verlauf: { [wage_document_id]: Nachweise früherer Fassungen } }
// POST { wahl }             die Person selbst: «digital» (= Einwilligung, wie
//                           accept-digital) oder «papier» (Einwilligung widerrufen)
// POST { profile_id, wahl, notiz }
//                           Lohnverwaltung trägt die Wahl auf Wunsch der Person
//                           ein (quelle «lohnverwaltung», Notiz Pflicht: wie gewünscht)
// PATCH { wage_document_id, ausgedruckt: true }
//                           Lohnverwaltung: Papier-Dokument ausgedruckt (einmalig, Nachweis)

import { NextResponse } from "next/server";
import { requireUser, requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { LOHN_RECHT } from "@/lib/lohn/zugriff";
import { isUuid } from "@/lib/search-escape";
import { istIntern } from "@/lib/roles";
import { DIGITAL_EINWILLIGUNG_VERSION, ladeAktuelleWahl, ladeWahlHistorie, speichereWahl, type ZustellWahl } from "@/lib/lohn/zustellung";

const NOTIZ_MIN = 5;
const fehler = (e: unknown, status = 500) =>
  NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status });

export async function GET(req: Request) {
  const profileId = new URL(req.url).searchParams.get("profile_id");
  const admin = createAdminClient();

  if (!profileId) {
    const auth = await requireUser({ wartung: "lohn" });
    if (auth.error) return auth.error;
    if (auth.isImpersonating) return NextResponse.json({ success: true, ansicht_als: true, wahl: null, version_aktuell: DIGITAL_EINWILLIGUNG_VERSION });
    try {
      const w = await ladeAktuelleWahl(admin, auth.user.id);
      return NextResponse.json(
        { success: true, wahl: w ? { wahl: w.wahl, version: w.version, gewaehlt_at: w.gewaehlt_at, quelle: w.quelle } : null, version_aktuell: DIGITAL_EINWILLIGUNG_VERSION },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (e) {
      return fehler(e);
    }
  }

  if (!isUuid(profileId)) return NextResponse.json({ success: false, error: "profile_id ungültig" }, { status: 400 });
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  try {
    const [wahl, historie, zustellung, verlauf] = await Promise.all([
      ladeAktuelleWahl(admin, profileId),
      ladeWahlHistorie(admin, profileId),
      admin
        .from("lohn_dokument_zustellung")
        .select("wage_document_id, bereitgestellt_at, wahl, benachrichtigt_at, benachrichtigt_kanaele, erstmals_geoeffnet_at, zuletzt_geoeffnet_at, anzahl_geoeffnet, ausgedruckt_at, ausgedruckt_von_name")
        .eq("profile_id", profileId)
        .order("bereitgestellt_at", { ascending: false })
        .limit(500),
      // Nachweis früherer Fassungen (Korrekturfassung setzt zurück, Migration 367).
      admin
        .from("lohn_dokument_zustellung_verlauf")
        .select("wage_document_id, fassung, nachweis, abgeloest_at")
        .eq("profile_id", profileId)
        .order("abgeloest_at", { ascending: false })
        .limit(500),
    ]);
    if (zustellung.error) throw new Error(`Zustellnachweis konnte nicht geladen werden: ${zustellung.error.message}`);
    if (verlauf.error) throw new Error(`Nachweis-Verlauf konnte nicht geladen werden: ${verlauf.error.message}`);
    const proDokument = Object.fromEntries(((zustellung.data ?? []) as { wage_document_id: string }[]).map((z) => [z.wage_document_id, z]));
    const frueher: Record<string, { fassung: number | null; bereitgestellt_at: string | null; erstmals_geoeffnet_at: string | null; anzahl_geoeffnet: number; ausgedruckt_at: string | null }[]> = {};
    for (const v of (verlauf.data ?? []) as { wage_document_id: string; fassung: number | null; nachweis: Record<string, unknown> }[]) {
      (frueher[v.wage_document_id] ??= []).push({
        fassung: v.fassung,
        bereitgestellt_at: (v.nachweis.bereitgestellt_at as string | null) ?? null,
        erstmals_geoeffnet_at: (v.nachweis.erstmals_geoeffnet_at as string | null) ?? null,
        anzahl_geoeffnet: Number(v.nachweis.anzahl_geoeffnet ?? 0),
        ausgedruckt_at: (v.nachweis.ausgedruckt_at as string | null) ?? null,
      });
    }
    return NextResponse.json({ success: true, wahl, historie, zustellung: proDokument, verlauf: frueher }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return fehler(e);
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { wahl?: unknown; profile_id?: unknown; notiz?: unknown } | null;
  const wahl = body?.wahl;
  if (wahl !== "digital" && wahl !== "papier") return NextResponse.json({ success: false, error: "Wahl ungültig (digital oder papier)" }, { status: 400 });
  const ziel = typeof body?.profile_id === "string" ? body.profile_id : null;
  const admin = createAdminClient();

  // Die Person selbst (echtes Konto, nie «Ansicht als»).
  const basis = await requireUser({ wartung: "lohn" });
  if (basis.error) return basis.error;
  if (!ziel || ziel === basis.user.id) {
    if (basis.isImpersonating) {
      return NextResponse.json({ success: false, error: "Die Wahl trifft nur die Person selbst — nicht in «Ansicht als»." }, { status: 403 });
    }
    try {
      const { data: me } = await admin.from("profiles").select("full_name").eq("id", basis.user.id).maybeSingle();
      await speichereWahl(admin, { profileId: basis.user.id, wahl: wahl as ZustellWahl, quelle: "selbst", akteurId: basis.user.id, akteurName: (me?.full_name as string | null) ?? null });
      return NextResponse.json({ success: true });
    } catch (e) {
      return fehler(e);
    }
  }

  // Lohnverwaltung trägt die Wahl auf Wunsch ein.
  if (!isUuid(ziel)) return NextResponse.json({ success: false, error: "profile_id ungültig" }, { status: 400 });
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  const notiz = typeof body?.notiz === "string" ? body.notiz.trim().slice(0, 300) : "";
  if (notiz.length < NOTIZ_MIN) {
    return NextResponse.json({ success: false, error: `Notiz: wie hat die Person es gewünscht? (mindestens ${NOTIZ_MIN} Zeichen)` }, { status: 400 });
  }
  try {
    const { data: person, error } = await admin.from("profiles").select("id, role").eq("id", ziel).maybeSingle();
    if (error) throw new Error(error.message);
    if (!person || !istIntern(person.role as string)) return NextResponse.json({ success: false, error: "Person nicht gefunden" }, { status: 404 });
    const { data: me } = await admin.from("profiles").select("full_name").eq("id", auth.user.id).maybeSingle();
    await speichereWahl(admin, { profileId: ziel, wahl: wahl as ZustellWahl, quelle: "lohnverwaltung", akteurId: auth.user.id, akteurName: (me?.full_name as string | null) ?? null, notiz });
    return NextResponse.json({ success: true });
  } catch (e) {
    return fehler(e);
  }
}

export async function PATCH(req: Request) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  const body = (await req.json().catch(() => null)) as { wage_document_id?: unknown; ausgedruckt?: unknown } | null;
  const docId = typeof body?.wage_document_id === "string" ? body.wage_document_id : "";
  if (!isUuid(docId) || body?.ausgedruckt !== true) return NextResponse.json({ success: false, error: "wage_document_id und ausgedruckt=true nötig" }, { status: 400 });
  const admin = createAdminClient();
  try {
    const { data: doc, error } = await admin.from("wage_documents").select("id, profile_id, uploaded_at").eq("id", docId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!doc) return NextResponse.json({ success: false, error: "Nicht gefunden" }, { status: 404 });
    const { data: me } = await admin.from("profiles").select("full_name").eq("id", auth.user.id).maybeSingle();
    const jetzt = new Date().toISOString();
    const name = (me?.full_name as string | null) ?? null;
    // Bestehender Nachweis: nur setzen, wenn noch nicht abgehakt (einmalig).
    const { data: geaendert, error: uErr } = await admin
      .from("lohn_dokument_zustellung")
      .update({ ausgedruckt_at: jetzt, ausgedruckt_von_name: name })
      .eq("wage_document_id", docId)
      .is("ausgedruckt_at", null)
      .select("wage_document_id");
    if (uErr) throw new Error(uErr.message);
    if (!geaendert || geaendert.length === 0) {
      const { data: da, error: dErr } = await admin.from("lohn_dokument_zustellung").select("ausgedruckt_at").eq("wage_document_id", docId).maybeSingle();
      if (dErr) throw new Error(dErr.message);
      if (da) return NextResponse.json({ success: false, error: "Schon als ausgedruckt abgehakt" }, { status: 409 });
      // Dokument ohne Nachweis (vor Phase 4 bereitgestellt): Nachweis anlegen.
      const { error: iErr } = await admin.from("lohn_dokument_zustellung").insert({
        wage_document_id: docId,
        profile_id: doc.profile_id,
        bereitgestellt_at: doc.uploaded_at ?? jetzt,
        ausgedruckt_at: jetzt,
        ausgedruckt_von_name: name,
      });
      if (iErr) throw new Error(iErr.message);
    }
    return NextResponse.json({ success: true, ausgedruckt_at: jetzt, ausgedruckt_von_name: name });
  } catch (e) {
    return fehler(e);
  }
}
