// Lohndokumente-API.
//
// GET  /api/hr/wage-documents                    — eigene gültige Dokumente
//                                                  («Meine Lohndokumente»)
// GET  /api/hr/wage-documents?profile_id=X       — Dokumente einer Person
//      [&papierkorb=1]                             (Lohnrecht + vertrautes Gerät)
// POST /api/hr/wage-documents                    — PDF hochladen (Lohnrecht + Gerät)
//      FormData: file, profile_id, doc_type, year, period_month?, notes?, neue_fassung?
//
// Regeln (Phase 1):
//   - Gelesen wird nur über den Server (Admin-Client mit expliziter Prüfung);
//     der Browser hat keine Rechte mehr auf wage_documents (Migration 358).
//   - «Ansicht als» zeigt KEINE Lohndokumente der angesehenen Person.
//   - Hochladen überschreibt nie: jede Fassung hat einen eigenen Speicherpfad
//     (src/lib/lohn/fassung.ts). Gibt es schon eine gültige Fassung, fragt die
//     UI nach (409 requires_confirm «neue_fassung»); die bisherige bleibt.
//   - Gültig = nicht im Papierkorb und nicht durch eine neuere Fassung ersetzt.
//   - Nie für sich selbst (Vier Augen); Lohnabrechnungen nur für gesperrte Monate.

import { NextResponse } from "next/server";
import { requireUser, requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { protokolliereZugriff, geraetHashAusCookies } from "@/lib/finanzen/zugriffe";
import { ZUGRIFF_AKTION } from "@/lib/finanzen/types";
import { EIGENE_DOKUMENTE_VERBOTEN, LohnFehler, ladeArchivierteFassung, ladeGueltigeFassung, speichereFassung, type DocType } from "@/lib/lohn/fassung";
import { istMonatGesperrtDb } from "@/lib/lohn/abrechnung";
import { LOHN_RECHT } from "@/lib/lohn/zugriff";
import { isUuid } from "@/lib/search-escape";

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

const SPALTEN =
  "id, profile_id, doc_type, year, period_month, file_size, uploaded_at, uploaded_by_name, notes, source, version, archived_at, archived_by_name, archive_reason";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const profileFilter = url.searchParams.get("profile_id");
  const papierkorb = url.searchParams.get("papierkorb") === "1";

  const basis = await requireUser();
  if (basis.error) return basis.error;
  const admin = createAdminClient();

  // Eigene Dokumente: immer das ECHTE Konto. In «Ansicht als» keine
  // Lohndaten der angesehenen Person (Phase 1, Vier Augen / Ansicht als).
  if (!profileFilter || profileFilter === basis.user.id) {
    if (basis.isImpersonating) {
      return NextResponse.json({ success: true, documents: [], ansicht_als: true });
    }
    const { data, error } = await admin
      .from("wage_documents")
      .select(SPALTEN)
      .eq("profile_id", basis.user.id)
      .is("archived_at", null)
      .is("superseded_at", null)
      .order("year", { ascending: false })
      .order("period_month", { ascending: false, nullsFirst: false });
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, documents: data ?? [] });
  }

  // Fremde Person: Lohnrecht + vertrautes Gerät.
  if (!isUuid(profileFilter)) return NextResponse.json({ success: false, error: "profile_id ungültig" }, { status: 400 });
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;

  // Lese-Protokoll Lohn (fail-open). Akteur = echter User.
  await protokolliereZugriff({ actorProfileId: auth.user.id, bereich: "lohn", aktion: ZUGRIFF_AKTION.LOHN_DOKUMENTE_LISTE, zielProfileId: profileFilter, geraetHash: await geraetHashAusCookies() });

  let q = admin.from("wage_documents").select(SPALTEN).eq("profile_id", profileFilter);
  q = papierkorb ? q.not("archived_at", "is", null) : q.is("archived_at", null).is("superseded_at", null);
  const { data, error } = await q
    .order("year", { ascending: false })
    .order("period_month", { ascending: false, nullsFirst: false });
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });

  // Anzahl im Papierkorb (für den Umschalter) — in beiden Ansichten.
  const { count, error: cErr } = await admin
    .from("wage_documents")
    .select("id", { count: "exact", head: true })
    .eq("profile_id", profileFilter)
    .not("archived_at", "is", null);
  if (cErr) return NextResponse.json({ success: false, error: cErr.message }, { status: 500 });
  return NextResponse.json({ success: true, documents: data ?? [], papierkorb_anzahl: count ?? 0 });
}

export async function POST(req: Request) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;

  const form = await req.formData();
  const file = form.get("file");
  const profileId = String(form.get("profile_id") ?? "");
  const docType = String(form.get("doc_type") ?? "");
  const year = Number(form.get("year"));
  const monthRaw = form.get("period_month");
  const month = monthRaw == null || monthRaw === "" ? null : Number(monthRaw);
  const notes = form.get("notes") ? String(form.get("notes")).slice(0, 500) : null;
  const neueFassung = form.get("neue_fassung") === "true";

  if (!(file instanceof File)) return NextResponse.json({ success: false, error: "PDF fehlt" }, { status: 400 });
  if (file.type !== "application/pdf") return NextResponse.json({ success: false, error: "Nur PDF erlaubt" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ success: false, error: "Datei > 10 MB" }, { status: 400 });

  // Magic-Number-Check — Browser-MIME ist faelschbar, echte PDF beginnt mit "%PDF-".
  const headBytes = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  if (String.fromCharCode(...headBytes) !== "%PDF-") {
    return NextResponse.json({ success: false, error: "Datei ist keine gültige PDF" }, { status: 400 });
  }
  if (!isUuid(profileId)) return NextResponse.json({ success: false, error: "profile_id fehlt" }, { status: 400 });
  if (docType !== "lohnabrechnung" && docType !== "lohnausweis") return NextResponse.json({ success: false, error: "doc_type ungültig" }, { status: 400 });
  if (!Number.isInteger(year) || year < 2020 || year > 2100) return NextResponse.json({ success: false, error: "year ungültig" }, { status: 400 });
  if (docType === "lohnabrechnung") {
    if (!Number.isInteger(month) || (month as number) < 1 || (month as number) > 12) {
      return NextResponse.json({ success: false, error: "period_month (1-12) fehlt für Lohnabrechnung" }, { status: 400 });
    }
  } else if (month != null) {
    return NextResponse.json({ success: false, error: "Lohnausweis darf keinen Monat haben" }, { status: 400 });
  }

  if (profileId === auth.user.id) return NextResponse.json({ success: false, error: EIGENE_DOKUMENTE_VERBOTEN }, { status: 403 });

  const admin = createAdminClient();
  try {
    // Lohnabrechnungen nur für abgeschlossene (gesperrte) Monate — wie das
    // Erzeugen; sonst unterdrückt ein früher Upload die Abrechnung des Laufs.
    if (docType === "lohnabrechnung" && !(await istMonatGesperrtDb(admin, year, month as number))) {
      return NextResponse.json({
        success: false,
        code: "nicht_gesperrt",
        error: "Dieser Monat ist noch nicht abgeschlossen — Lohnabrechnungen erst ab dem 5. des Folgemonats (Monat gesperrt).",
      }, { status: 400 });
    }
    if (!neueFassung) {
      const vorhanden = await ladeGueltigeFassung(admin, profileId, docType as DocType, year, month);
      if (vorhanden) {
        return NextResponse.json({
          success: false,
          requires_confirm: "neue_fassung",
          error: `Für diesen Zeitraum gibt es schon ein Dokument (Fassung ${vorhanden.version}). Das neue wird eine neue Fassung, das bisherige bleibt erhalten.`,
        }, { status: 409 });
      }
      const imKorb = await ladeArchivierteFassung(admin, profileId, docType as DocType, year, month);
      if (imKorb) {
        return NextResponse.json({
          success: false,
          requires_confirm: "neue_fassung",
          error: `Für diesen Zeitraum liegt ein Dokument im Papierkorb (Fassung ${imKorb.version}). Wiederherstellen — oder das neue als neue Fassung hochladen.`,
        }, { status: 409 });
      }
    }
    const { data: me, error: meErr } = await admin.from("profiles").select("full_name").eq("id", auth.user.id).maybeSingle();
    if (meErr) throw new LohnFehler(meErr.message);
    const r = await speichereFassung(admin, {
      profileId,
      docType: docType as DocType,
      year,
      month,
      pdf: new Uint8Array(await file.arrayBuffer()),
      source: "manual",
      actorId: auth.user.id,
      actorName: (me?.full_name as string | null) ?? null,
      notes,
      nurWennKeineGueltige: !neueFassung,
    });
    if (r.modus === "vorhanden") {
      return NextResponse.json({ success: false, requires_confirm: "neue_fassung", error: "Inzwischen wurde ein Dokument für diesen Zeitraum gespeichert." }, { status: 409 });
    }
    return NextResponse.json({ success: true, id: r.id, mode: r.modus, version: r.version });
  } catch (e) {
    const status = e instanceof LohnFehler ? e.status : 500;
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status });
  }
}
