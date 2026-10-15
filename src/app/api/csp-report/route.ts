// /api/csp-report — Sammelpunkt fuer CSP-Verstoss-Meldungen.
//
// Der Browser POSTet hierher (CSP report-uri / report-to). Der Endpoint ist
// bewusst OEFFENTLICH + unauthentifiziert (Verstoesse kommen auch von
// ausgeloggten Nutzern) und schreibt via service_role in public.csp_reports.
// Antwortet immer 204 und schluckt Fehler — ein Report-Endpoint darf nie
// selbst Fehler werfen oder Angreifern etwas verraten. Body-Groesse ist
// gedeckelt, pro Request max. 10 Reports.

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type CspRow = {
  document_uri: string | null;
  violated_directive: string | null;
  effective_directive: string | null;
  blocked_uri: string | null;
  disposition: string | null;
  status_code: number | null;
  source_file: string | null;
  line_number: number | null;
  user_agent: string | null;
  payload: Record<string, unknown>;
};

function str(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function toRow(r: Record<string, unknown>, ua: string | null): CspRow {
  return {
    document_uri: str(r["document-uri"] ?? r["documentURL"], 1000),
    violated_directive: str(r["violated-directive"] ?? r["effectiveDirective"], 200),
    effective_directive: str(r["effective-directive"] ?? r["effectiveDirective"], 200),
    blocked_uri: str(r["blocked-uri"] ?? r["blockedURL"], 1000),
    disposition: str(r["disposition"], 50),
    status_code: num(r["status-code"] ?? r["statusCode"]),
    source_file: str(r["source-file"] ?? r["sourceFile"], 1000),
    line_number: num(r["line-number"] ?? r["lineNumber"]),
    user_agent: ua,
    payload: r,
  };
}

export async function POST(request: Request) {
  try {
    const text = await request.text();
    if (!text || text.length > 20_000) return new NextResponse(null, { status: 204 });

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return new NextResponse(null, { status: 204 });
    }

    const ua = request.headers.get("user-agent")?.slice(0, 300) ?? null;
    const raw: Record<string, unknown>[] = [];

    if (Array.isArray(body)) {
      // report-to-Format: [ { type:"csp-violation", body:{...} }, ... ]
      for (const item of body as unknown[]) {
        if (item && typeof item === "object") {
          const it = item as Record<string, unknown>;
          if (it["type"] === "csp-violation" && it["body"] && typeof it["body"] === "object") {
            raw.push(it["body"] as Record<string, unknown>);
          }
        }
      }
    } else if (body && typeof body === "object") {
      // report-uri-Format: { "csp-report": {...} }
      const obj = body as Record<string, unknown>;
      if (obj["csp-report"] && typeof obj["csp-report"] === "object") {
        raw.push(obj["csp-report"] as Record<string, unknown>);
      }
    }

    if (raw.length === 0) return new NextResponse(null, { status: 204 });

    const rows = raw.slice(0, 10).map((r) => toRow(r, ua));
    const admin = createAdminClient();
    await admin.from("csp_reports").insert(rows);
  } catch {
    // bewusst schlucken — Report-Endpoint bleibt stumm.
  }
  return new NextResponse(null, { status: 204 });
}
