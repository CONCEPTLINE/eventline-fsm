import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { istIntern } from "@/lib/roles";

// GET /api/trust-one/personen — Personenliste fuer die Ablage in Trust one
// (Bereich «EVENTLINE GmbH»). Trust one braucht sie wie frueher
// ladeAblageKontext: `mitarbeiter` = aktiv und intern (nur sie darf die KI als
// Person setzen), `namen_alle` = jeder Name (Minimierung vor Claude,
// Personalakten-Regel). Nur Name + zwei Flags, keine IDs, Mails oder Rollen.
// Auth: Bearer TRUST_ONE_API_TOKEN (in Trust one: ERP_API_TOKEN), timing-safe;
// ohne konfiguriertes Secret 503.

export const dynamic = "force-dynamic";

function tokenOk(request: Request): boolean | null {
  const secret = process.env.TRUST_ONE_API_TOKEN;
  if (!secret || secret.length < 32) return null;
  const header = request.headers.get("authorization") ?? "";
  const a = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: NextRequest) {
  const ok = tokenOk(request);
  if (ok === null) return NextResponse.json({ success: false, error: "Nicht konfiguriert" }, { status: 503 });
  if (!ok) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  try {
    // Alle Profile in Teilabfragen — PostgREST kappt still bei 1000 Zeilen.
    const admin = createAdminClient();
    const zeilen: { full_name: string | null; is_active: boolean | null; role: string | null }[] = [];
    for (let von = 0; ; von += 1000) {
      const { data, error } = await admin.from("profiles").select("full_name, is_active, role").order("id").range(von, von + 999);
      if (error) throw new Error(error.message);
      zeilen.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    const personen = zeilen
      .map((p) => ({ name: String(p.full_name ?? "").trim(), aktiv: p.is_active === true, intern: istIntern(p.role) }))
      .filter((p) => p.name);
    return NextResponse.json({ personen }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    logError("trust-one.personen", e);
    return NextResponse.json({ success: false, error: "Personen konnten nicht geladen werden" }, { status: 500 });
  }
}
