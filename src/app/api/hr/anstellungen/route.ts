// Anstellungen (Phase 2, Migration 364) — nur was der Lohn im ERP braucht:
// Eintritt, Austritt, «ruhend» von–bis, Vertragsart (Abruf unecht/echt,
// fest), befristet bis, Pensum, AHV-Wahl unter CHF 2'500 je Jahr.
// Personalien (Adresse, IBAN, AHV-Nummer) gehören ins Backoffice.
//
// GET  /api/hr/anstellungen?profile_id=…      — Anstellungen der Person
// POST /api/hr/anstellungen                   — anlegen ({ profile_id, eintritt, … })
//                                               oder ändern ({ id, … }); begruendung
//                                               nötig, wenn abgerechnete Monate betroffen
//                                               sind (dann Antrag, Vier Augen)
//
// Zugriff: Lohnrecht + vertrautes Gerät; die eigene Anstellung ändert eine
// zweite Person (wie der eigene Lohn). Warnung bei Eintritt unter 18.

import { NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/search-escape";
import { LOHN_RECHT, pruefeLohnAenderung } from "@/lib/lohn/zugriff";
import { ladeName } from "@/lib/lohn/rechte-antraege";
import { aendereLohndaten, ANTRAG_HINWEIS_LOHN } from "@/lib/lohn/aenderungen";
import { alterWarnung } from "@/lib/lohn/hinweise";

const SPALTEN = "id, profile_id, eintritt, austritt, ruhend_von, ruhend_bis, vertragsart, befristet_bis, pensum_pct, ahv_verlangt_jahre, notiz, created_at, created_by_name, updated_at, updated_by_name";
const datum = (v: unknown): string | null | undefined =>
  v === null || v === "" ? null : typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;

export async function GET(req: Request) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  const pid = new URL(req.url).searchParams.get("profile_id") ?? "";
  if (!isUuid(pid)) return NextResponse.json({ success: false, error: "profile_id fehlt" }, { status: 400 });
  const { data, error } = await createAdminClient().from("lohn_anstellungen").select(SPALTEN).eq("profile_id", pid).order("eintritt");
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, anstellungen: data ?? [] });
}

export async function POST(req: Request) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return NextResponse.json({ success: false, error: "Body fehlt" }, { status: 400 });
  const admin = createAdminClient();

  const id = typeof b.id === "string" && isUuid(b.id) ? b.id : null;
  let alt: { profile_id: string } | null = null;
  if (id) {
    const { data, error } = await admin.from("lohn_anstellungen").select("profile_id").eq("id", id).maybeSingle();
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ success: false, error: "Anstellung nicht gefunden" }, { status: 404 });
    alt = data as { profile_id: string };
  }
  const profileId = alt?.profile_id ?? (typeof b.profile_id === "string" && isUuid(b.profile_id) ? b.profile_id : null);
  if (!profileId) return NextResponse.json({ success: false, error: "profile_id fehlt" }, { status: 400 });
  const verbot = await pruefeLohnAenderung(admin, auth.user.id, profileId).catch((e: Error) => e.message);
  if (verbot) return NextResponse.json({ success: false, error: verbot }, { status: 403 });

  const werte: Record<string, unknown> = {};
  for (const k of ["eintritt", "austritt", "ruhend_von", "ruhend_bis", "befristet_bis"] as const) {
    if (!(k in b)) continue;
    const d = datum(b[k]);
    if (d === undefined) return NextResponse.json({ success: false, error: `${k}: Datum ungültig` }, { status: 400 });
    werte[k] = d;
  }
  if ("vertragsart" in b) {
    if (!["abruf_unecht", "abruf_echt", "fest"].includes(String(b.vertragsart))) return NextResponse.json({ success: false, error: "vertragsart ungültig" }, { status: 400 });
    werte.vertragsart = b.vertragsart;
  }
  if ("pensum_pct" in b) {
    const p = b.pensum_pct == null || b.pensum_pct === "" ? null : Number(b.pensum_pct);
    if (p != null && !(p > 0 && p <= 100)) return NextResponse.json({ success: false, error: "Pensum 1–100 %" }, { status: 400 });
    werte.pensum_pct = p;
  }
  if ("ahv_verlangt_jahre" in b) {
    const j = Array.isArray(b.ahv_verlangt_jahre) ? b.ahv_verlangt_jahre.map(Number) : [];
    if (j.some((x) => !Number.isInteger(x) || x < 2020 || x > 2100)) return NextResponse.json({ success: false, error: "AHV-Jahre ungültig" }, { status: 400 });
    werte.ahv_verlangt_jahre = Array.from(new Set(j)).sort();
  }
  if ("notiz" in b) werte.notiz = typeof b.notiz === "string" ? b.notiz.trim().slice(0, 500) || null : null;
  if (!id && !werte.eintritt) return NextResponse.json({ success: false, error: "Eintritt fehlt" }, { status: 400 });

  const name = await ladeName(admin, auth.user.id);
  const { data: person } = await admin.from("profiles").select("full_name, birthdate").eq("id", profileId).maybeSingle();
  const zielName = (person?.full_name as string | null) ?? null;
  if (id) {
    werte.updated_by = auth.user.id;
    werte.updated_by_name = name;
  } else {
    werte.profile_id = profileId;
    werte.created_by = auth.user.id;
    werte.created_by_name = name;
  }
  try {
    const r = await aendereLohndaten(admin, {
      operationen: [id ? { op: "update", tabelle: "lohn_anstellungen", id, werte } : { op: "insert", tabelle: "lohn_anstellungen", werte }],
      bereich: "anstellung",
      profileId,
      zielName,
      beschreibung: `${id ? "Anstellung ändern" : "Anstellung erfassen"}: ${zielName ?? profileId}${werte.eintritt ? `, Eintritt ${werte.eintritt}` : ""}${"austritt" in werte ? `, Austritt ${werte.austritt ?? "offen"}` : ""}`,
      begruendung: typeof b.begruendung === "string" ? b.begruendung : null,
      akteurId: auth.user.id,
      akteurName: name,
    });
    const warnung = typeof werte.eintritt === "string" ? alterWarnung(person?.birthdate as string | null, werte.eintritt) : null;
    if (r.modus === "begruendung_noetig") {
      return NextResponse.json({ success: false, code: "begruendung_noetig", error: `${r.meldung}. Bitte Begründung angeben — dann wird ein Antrag gestellt.`, betrifft_ab: r.betrifftAb }, { status: 409 });
    }
    if (r.modus === "antrag") return NextResponse.json({ success: true, mode: "antrag", antrag_id: r.antragId, hinweis: ANTRAG_HINWEIS_LOHN, warnung });
    return NextResponse.json({ success: true, mode: id ? "geaendert" : "angelegt", id: r.ids[0] ?? id, warnung });
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
