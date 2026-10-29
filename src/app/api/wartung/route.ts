// Wartungsmodus schalten (Einstellungen › Sicherheit), Migration 363.
//
// GET  /api/wartung  — Stand (Bereiche, Grund, seit, Ausnahmen mit Namen) und
//                      ob ich schalten darf. Nur Admins.
// POST /api/wartung  — Body { bereich, aktiv } — nur Admins auf einem
//                      vertrauten Gerät, nicht in «Ansicht als».
//
// Geschaltet wird über public.wartung_setzen (protokolliert im Rechte-
// Protokoll: wartung.an / wartung.aus). Diese Route liegt bewusst in keinem
// Wartungs-Bereich — Ausschalten geht immer. Gleiches per Skript:
// node scripts/wartung.mjs an|aus|status (Ausnahmen nur per Skript).

import { NextResponse } from "next/server";
import { requireAdmin, pruefeVertrautesGeraet } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { ladeWartungStreng, wartungCacheLeeren } from "@/lib/wartung-server";
import { istWartungBereich, type WartungStand } from "@/lib/wartung";

export const dynamic = "force-dynamic";

type Admin = Exclude<Awaited<ReturnType<typeof requireAdmin>>, { error: NextResponse }>;

async function hinderungsgrund(auth: Admin): Promise<{ text: string; geraet: boolean } | null> {
  if (auth.isImpersonating) return { text: "Nicht in «Ansicht als» — erst beenden.", geraet: false };
  if ((await pruefeVertrautesGeraet(auth.user.id)) !== "vertraut") {
    return { text: "Schalten geht nur auf einem vertrauten Gerät.", geraet: true };
  }
  return null;
}

async function antwort(stand: WartungStand, hindernis: { text: string } | null) {
  let ausnahmen: { id: string; name: string }[] = [];
  if (stand.ausnahmen.length > 0) {
    const { data, error } = await createAdminClient().from("profiles").select("id, full_name, email").in("id", stand.ausnahmen);
    if (error) return NextResponse.json({ success: false, error: `Ausnahmen konnten nicht geladen werden: ${error.message}` }, { status: 500 });
    const byId = new Map((data ?? []).map((p) => [p.id as string, ((p.full_name as string | null) ?? (p.email as string | null) ?? "?").trim()]));
    ausnahmen = stand.ausnahmen.map((id) => ({ id, name: byId.get(id) ?? "unbekanntes Konto" }));
  }
  return NextResponse.json(
    {
      success: true,
      stand: { bereiche: stand.bereiche, grund: stand.grund, seit: stand.seit, ausnahmen },
      darf_schalten: hindernis === null,
      hinderungsgrund: hindernis?.text ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET() {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  let stand: WartungStand;
  try {
    stand = await ladeWartungStreng();
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  return antwort(stand, await hinderungsgrund(auth));
}

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  const hindernis = await hinderungsgrund(auth);
  if (hindernis) {
    return NextResponse.json(
      hindernis.geraet
        ? { success: false, error: "device_not_trusted", message: hindernis.text }
        : { success: false, error: hindernis.text },
      { status: 403 },
    );
  }

  const body = (await request.json().catch(() => null)) as { bereich?: unknown; aktiv?: unknown } | null;
  if (!body || !istWartungBereich(body.bereich) || typeof body.aktiv !== "boolean") {
    return NextResponse.json({ success: false, error: "Ungültig: { bereich: lohn|rechte|geraete|finanzen, aktiv: true|false }" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: me, error: meErr } = await admin.from("profiles").select("full_name, email").eq("id", auth.user.id).maybeSingle();
  if (meErr) return NextResponse.json({ success: false, error: meErr.message }, { status: 500 });
  const name = ((me?.full_name as string | null) ?? (me?.email as string | null) ?? auth.user.email ?? "Admin").trim();

  const { error } = await admin.rpc("wartung_setzen", {
    p_an: body.aktiv ? [body.bereich] : [],
    p_aus: body.aktiv ? [] : [body.bereich],
    p_grund: null,
    p_actor: auth.user.id,
    p_actor_name: name,
  });
  wartungCacheLeeren();
  if (error) return NextResponse.json({ success: false, error: `Wartung konnte nicht geschaltet werden: ${error.message}` }, { status: 500 });

  let stand: WartungStand;
  try {
    stand = await ladeWartungStreng();
  } catch (e) {
    return NextResponse.json({ success: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
  return antwort(stand, null);
}
