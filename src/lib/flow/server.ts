import "server-only";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { ladeWartung } from "@/lib/wartung-server";
import { logError } from "@/lib/log";
import { bearbeiteFlowAufruf, type Ausgefuehrt, type FlowAntwort, type FlowLog, type FlowSpeicher } from "./aufruf";
import { AUSWEIS_MAX_ZEICHEN, ladeFlowSchluessel, type FlowAud, type FlowAusweis } from "./ausweis";
import type { RegelFehler } from "./regeln";

// Server-Teil der Trust-flow-Schnittstelle: Datenbank (flow_abrufe, Migration
// 369), Wartung, Körper lesen, Antwort. Ablauf und Regeln: aufruf.ts / regeln.ts.
// Ohne Login erreichbar (kein Cookie, kein Konto) — einzig der signierte
// Ausweis berechtigt. Service-Rolle nur hier, keine Lese-Rolle für Trust flow.

export function flowSpeicher(admin: SupabaseClient): FlowSpeicher {
  return {
    async wartungAktiv() {
      return (await ladeWartung()).bereiche.includes("lohn");
    },
    async beginne(d) {
      const { data, error } = await admin.rpc("flow_abruf_beginnen", {
        p_jti: d.jti,
        p_aud: d.aud,
        p_sub: d.sub,
        p_jahr: d.jahr,
        p_monat: d.monat,
        p_angefragt: d.angefragt,
        p_iat: new Date(d.iat * 1000).toISOString(),
        p_exp: new Date(d.exp * 1000).toISOString(),
      });
      if (error || !data) throw new Error(`Abruf konnte nicht protokolliert werden: ${error?.message ?? "keine Antwort"}`);
      const r = data as { status: string; id?: string; retry_after?: number };
      if (r.status === "ok" && r.id) return { status: "ok", id: r.id };
      if (r.status === "wiederholt") return { status: "wiederholt" };
      if (r.status === "zu_viele") return { status: "zu_viele", retryAfter: Number(r.retry_after ?? 60) };
      throw new Error(`Unerwartete Antwort von flow_abruf_beginnen: ${r.status}`);
    },
    async schliesse(id, a) {
      const { error } = await admin.rpc("flow_abruf_abschliessen", {
        p_id: id,
        p_status: a.status,
        p_geliefert: a.geliefert,
        p_antwort_sha256: a.sha256,
        p_grund: a.grund,
      });
      if (error) throw new Error(`Abruf konnte nicht abgeschlossen werden: ${error.message}`);
    },
  };
}

/** Eine Zeile im Vercel-Log je Aufruf — ohne Personen, ohne Inhalte. */
function protokolliereLog(e: FlowLog) {
  console.info(JSON.stringify({ ctx: "api.flow", ...e }));
}

function alsResponse(a: FlowAntwort): NextResponse {
  return new NextResponse(a.body, { status: a.status, headers: a.headers });
}

const fehler500 = () =>
  NextResponse.json({ success: false, code: "fehler", error: "Abruf fehlgeschlagen." }, { status: 500, headers: { "Cache-Control": "no-store" } });

/** Körper lesen mit Obergrenze (Content-Length vorab, dann tatsächliche Länge). null = zu gross. */
export async function leseKoerper(request: Request, maxZeichen: number): Promise<string | null> {
  const laenge = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(laenge) && laenge > maxZeichen * 2) return null;
  const text = await request.text();
  return text.length > maxZeichen ? null : text;
}

/** Ohne gültigen öffentlichen Schlüssel antwortet jede Route 503 — vor allem anderen (nie offen). */
export function flowNichtEingerichtet(): NextResponse | null {
  if (ladeFlowSchluessel(process.env.FLOW_ABRUF_PUBLIC_KEY)) return null;
  return NextResponse.json(
    { success: false, code: "nicht_eingerichtet", error: "Schnittstelle nicht eingerichtet." },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}

export const zuGross = () =>
  NextResponse.json({ success: false, code: "zu_gross", error: "Körper zu gross." }, { status: 413, headers: { "Cache-Control": "no-store" } });

/**
 * Ein Aufruf aus Trust flow: Ausweis → Wartung → Einmal-Schutz/Höchstzahl →
 * Claims → Ausführen → Protokoll → Antwort. Jeder unerwartete Fehler = 500 ohne Details.
 */
export async function flowAufruf<T>(args: {
  aud: FlowAud;
  token: string;
  pruefe: (ausweis: FlowAusweis) => { ok: true; anfrage: T } | RegelFehler;
  ausfuehren: (admin: SupabaseClient, anfrage: T, ausweis: FlowAusweis, abrufId: string) => Promise<Ausgefuehrt>;
}): Promise<NextResponse> {
  try {
    const admin = createAdminClient();
    const a = await bearbeiteFlowAufruf<T>({
      aud: args.aud,
      token: args.token,
      schluesselWert: process.env.FLOW_ABRUF_PUBLIC_KEY,
      speicher: flowSpeicher(admin),
      pruefe: args.pruefe,
      ausfuehren: (anfrage, ausweis, abrufId) => args.ausfuehren(admin, anfrage, ausweis, abrufId),
      log: protokolliereLog,
    });
    return alsResponse(a);
  } catch (e) {
    logError(`api.flow.${args.aud}`, e);
    return fehler500();
  }
}

/** A1-Routen: Körper = nur das JWS (Content-Type application/jose). */
export async function flowAbruf<T>(
  request: Request,
  aud: FlowAud,
  pruefe: (ausweis: FlowAusweis) => { ok: true; anfrage: T } | RegelFehler,
  ausfuehren: (admin: SupabaseClient, anfrage: T, ausweis: FlowAusweis, abrufId: string) => Promise<Ausgefuehrt>,
): Promise<NextResponse> {
  const aus = flowNichtEingerichtet();
  if (aus) return aus;
  const text = await leseKoerper(request, AUSWEIS_MAX_ZEICHEN);
  if (text === null) return zuGross();
  return flowAufruf({ aud, token: text.trim(), pruefe, ausfuehren });
}
