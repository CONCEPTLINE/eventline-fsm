// POST /api/flow/saetze — Stundensätze je Person von Trust flow ins ERP
// (aud «erp-saetze», Migration 377: personal_saetze).
//
// Körper: { "ausweis": "<JWS>" } — Ausweis wie A1 (EdDSA, 60 s, jti einmalig) mit
//   saetze: [{ erp_profil_id, gueltig_ab: "YYYY-MM-DD", kosten_chf_h, netto_chf_h }]
//   1–50 Einträge; Zahlen ≥ 0 mit höchstens 2 Nachkommastellen oder null (kein
//   Stundensatz, z. B. Provisionslohn; Migration 383); je Person und
//   Datum höchstens einmal. Jede Person muss ein internes ERP-Profil sein
//   (kein Partner-/Lieferanten-Zugang), sonst 422 und nichts wird gespeichert.
// Speichern: je (Person, gueltig_ab) ein Eintrag — neu oder überschrieben, wenn
// sich ein Satz geändert hat. Wiederholen ist sicher.
// Antwort: { ok: true, gespeichert, unveraendert }.
// Die Sätze dienen nur Kostenrechnungen im ERP; der Lohn wird in Trust flow gerechnet.

import { NextResponse } from "next/server";
import { flowAufruf, flowNichtEingerichtet, leseKoerper, zuGross } from "@/lib/flow/server";
import { saetzeSpeichern } from "@/lib/flow/daten";
import { AUSWEIS_MAX_ZEICHEN } from "@/lib/flow/ausweis";
import { pruefeSaetzeClaims } from "@/lib/flow/regeln";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const aus = flowNichtEingerichtet();
  if (aus) return aus;
  const text = await leseKoerper(request, AUSWEIS_MAX_ZEICHEN + 1_000);
  if (text === null) return zuGross();
  let token: string | null = null;
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === "object" && !Array.isArray(v) && typeof (v as Record<string, unknown>).ausweis === "string") {
      token = ((v as Record<string, unknown>).ausweis as string).trim();
    }
  } catch {
    token = null;
  }
  if (!token) {
    return NextResponse.json(
      { success: false, code: "koerper_ungueltig", error: "Körper ist kein JSON { ausweis }." },
      { status: 400, headers: { "Cache-Control": "no-store" } },
    );
  }
  return flowAufruf({
    aud: "erp-saetze",
    token,
    pruefe: (ausweis) => pruefeSaetzeClaims(ausweis.claims),
    ausfuehren: (admin, saetze) => saetzeSpeichern(admin, saetze),
  });
}
