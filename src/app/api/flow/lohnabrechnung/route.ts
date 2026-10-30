// POST /api/flow/lohnabrechnung — Lohnabrechnung (PDF aus Bexio) je Person und
// Lohnmonat von Trust flow ins ERP (A5, aud «erp-lohnabrechnung-ablage»).
//
// Körper (JSON): { "ausweis": "<JWS>", "pdf_base64": "<Base64>" }
//   Ausweis wie A1 (EdDSA, 60 s, jti einmalig) mit erp_profil_id, jahr, monat
//   (ab 2026-12 und nach lohn_einstellungen.lauf_bis), fassung (1–99, laut
//   Trust flow) und sha256 (hex) der PDF — die PDF ist damit mit signiert.
//   PDF höchstens 2 MB.
// Ablage: eigene Fassung mit Quelle «bexio» im Bucket lohndokumente (nie
// überschreiben, eigener Pfad, Protokoll), sichtbar unter «Meine Lohndokumente»,
// Meldung an die Person ohne Beträge. Gleiche Fassung + gleiche PDF nochmals =
// «vorhanden» (Wiederholen ist sicher); gleiche Fassung mit anderer PDF oder
// ältere Fassung = 409.
// Antwort: { ok: true, modus: "abgelegt" | "vorhanden", dokument_id, erp_fassung }.

import { flowAufruf, flowNichtEingerichtet, leseKoerper, zuGross } from "@/lib/flow/server";
import { lohnabrechnungAblegen } from "@/lib/flow/daten";
import { ABLAGE_MAX_ZEICHEN, dekodierePdf, pruefeAblageClaims, pruefeAblageKoerper } from "@/lib/flow/regeln";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const aus = flowNichtEingerichtet();
  if (aus) return aus;
  const text = await leseKoerper(request, ABLAGE_MAX_ZEICHEN);
  if (text === null) return zuGross();
  const k = pruefeAblageKoerper(text);
  if (!k.ok) {
    return NextResponse.json({ success: false, code: k.code, error: k.meldung }, { status: k.status, headers: { "Cache-Control": "no-store" } });
  }
  return flowAufruf({
    aud: "erp-lohnabrechnung-ablage",
    token: k.ausweis,
    pruefe: (ausweis) => {
      const c = pruefeAblageClaims(ausweis.claims);
      if (!c.ok) return c;
      const pdf = dekodierePdf(k.pdfBase64, c.anfrage.sha256);
      if (!pdf.ok) return pdf;
      return { ok: true, anfrage: { ...c.anfrage, pdf: pdf.pdf } };
    },
    ausfuehren: (admin, anfrage, ausweis, abrufId) => lohnabrechnungAblegen(admin, anfrage, anfrage.pdf, ausweis, abrufId),
  });
}
