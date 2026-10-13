// POST /api/technik/messwerte — Messpaket vom KI-Dienst auf dem Rig
// (docs/technik-dashboard/VERTRAG.md §2, §3 «Ingest»), alle 60 s.
//
// Anmeldung wie alle Rig-Schnittstellen: Bearer KI_SYNC_TOKEN (rigAuthFehler,
// 503 ohne Secret, 401 bei falschem Token). Hoechstens 64 KiB, sonst 413.
// Strenge Validierung (lib/technik-dashboard/paket.ts), unbekannte Felder
// fallen weg. Idempotent je Minute: technik_messwerte (quelle, minute) wird
// upgesertet; dasselbe Paket zweimal erzeugt keine doppelten Ereignisse, weil
// diese aus dem Vergleich mit dem gespeicherten Stand entstehen.
//
// Antwort (§2.5): { success: true, steuerung: { luefter_profil, stand } } — das
// gewuenschte Luefter-Profil fuer das Rig. Ist es nicht lesbar, fehlt `steuerung`
// (das Rig behaelt dann sein aktives Profil).

import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { logError } from "@/lib/log";
import { rigAuthFehler } from "@/lib/ki/rig-auth";
import { TECHNIK_PAKET_MAX_BYTES, type TechnikQuelle } from "@/lib/technik-dashboard/konstanten";
import { kiMinutenwerte, leiteEreignisseAb, lesePaket, nasMinutenwerte } from "@/lib/technik-dashboard/paket";
import { ladeSteuerung, steuerungFuersRig } from "@/lib/technik-dashboard/steuerung";
import type { KiPaket, PaketV1, RigPaket, SteuerungRig } from "@/lib/technik-dashboard/typen";

export const dynamic = "force-dynamic";

function minuteVon(iso: string): string {
  const ms = Date.parse(iso);
  return new Date(Math.floor(ms / 60_000) * 60_000).toISOString();
}

type StandZeile = { quelle: TechnikQuelle; werte: unknown; gemessen_am: string };

async function speicherePaket(paket: PaketV1, jetzt: Date): Promise<void> {
  const admin = createAdminClient();
  const jetztIso = jetzt.toISOString();

  const { data: vorherDaten, error: vorherFehler } = await admin
    .from("technik_stand")
    .select("quelle, werte, gemessen_am");
  if (vorherFehler) throw new Error(`technik_stand lesen: ${vorherFehler.message}`);
  const vorher = new Map(((vorherDaten ?? []) as StandZeile[]).map((z) => [z.quelle, z]));
  const istNeuer = (q: TechnikQuelle, am: string) => {
    const v = vorher.get(q);
    return !v || Date.parse(am) >= Date.parse(v.gemessen_am);
  };
  const istEchtNeuer = (q: TechnikQuelle, am: string) => {
    const v = vorher.get(q);
    return !v || Date.parse(am) > Date.parse(v.gemessen_am);
  };

  // 1. Minutenwerte (vor dem Stand-Update, weil «NAS neu» gegen den alten Stand prueft)
  const minuten: Array<{ quelle: TechnikQuelle; minute: string; werte: Record<string, number> }> = [];
  if (paket.rig?.minute && Object.keys(paket.rig.minute).length > 0) {
    minuten.push({ quelle: "rig", minute: minuteVon(paket.rig.gemessen_am), werte: paket.rig.minute });
  }
  if (paket.ki) {
    const w = kiMinutenwerte(paket.ki, paket.gesendet_am);
    if (Object.keys(w).length > 0) minuten.push({ quelle: "ki", minute: minuteVon(paket.gesendet_am), werte: w });
  }
  if (paket.nas && istEchtNeuer("nas", paket.nas.gemessen_am)) {
    const w = nasMinutenwerte(paket.nas);
    if (Object.keys(w).length > 0) minuten.push({ quelle: "nas", minute: minuteVon(paket.nas.gemessen_am), werte: w });
  }
  if (minuten.length > 0) {
    const { error } = await admin.from("technik_messwerte").upsert(minuten, { onConflict: "quelle,minute" });
    if (error) throw new Error(`technik_messwerte: ${error.message}`);
  }

  // 2. Stand je Block — ein verspaetetes aelteres Paket ueberschreibt nie einen neueren Stand.
  const stand: Array<StandZeile & { empfangen_am: string }> = [];
  const rigNeu: RigPaket | undefined = paket.rig && istNeuer("rig", paket.rig.gemessen_am) ? paket.rig : undefined;
  const kiNeu: KiPaket | undefined = paket.ki && istNeuer("ki", paket.gesendet_am) ? paket.ki : undefined;
  if (rigNeu) stand.push({ quelle: "rig", werte: rigNeu, gemessen_am: rigNeu.gemessen_am, empfangen_am: jetztIso });
  if (kiNeu) stand.push({ quelle: "ki", werte: kiNeu, gemessen_am: paket.gesendet_am, empfangen_am: jetztIso });
  if (paket.nas && istNeuer("nas", paket.nas.gemessen_am)) {
    stand.push({ quelle: "nas", werte: paket.nas, gemessen_am: paket.nas.gemessen_am, empfangen_am: jetztIso });
  }
  if (stand.length > 0) {
    const { error } = await admin.from("technik_stand").upsert(stand, { onConflict: "quelle" });
    if (error) throw new Error(`technik_stand: ${error.message}`);
  }

  // 3. Ereignisse aus dem Vergleich alt/neu (Texte nur aus Vorlagen des FSM)
  const ereignisse = leiteEreignisseAb(
    {
      rig: (vorher.get("rig")?.werte as RigPaket | undefined) ?? null,
      ki: (vorher.get("ki")?.werte as KiPaket | undefined) ?? null,
    },
    { rig: rigNeu, ki: kiNeu },
  );
  if (ereignisse.length > 0) {
    const { error } = await admin.from("technik_ereignisse").insert(ereignisse);
    if (error) throw new Error(`technik_ereignisse: ${error.message}`);
  }
}

export async function POST(request: Request) {
  const auth = rigAuthFehler(request);
  if (auth) return auth;

  const laenge = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(laenge) && laenge > TECHNIK_PAKET_MAX_BYTES) {
    return NextResponse.json({ success: false, error: "zu_gross" }, { status: 413 });
  }
  const typ = request.headers.get("content-type") ?? "";
  if (!typ.toLowerCase().includes("application/json")) {
    return NextResponse.json({ success: false, error: "content_type" }, { status: 415 });
  }

  let roh: unknown;
  try {
    const puffer = await request.arrayBuffer();
    if (puffer.byteLength > TECHNIK_PAKET_MAX_BYTES) {
      return NextResponse.json({ success: false, error: "zu_gross" }, { status: 413 });
    }
    roh = JSON.parse(new TextDecoder().decode(puffer));
  } catch {
    return NextResponse.json({ success: false, error: "json" }, { status: 400 });
  }

  const jetzt = new Date();
  const gelesen = lesePaket(roh, jetzt.getTime());
  if ("fehler" in gelesen) {
    return NextResponse.json({ success: false, error: gelesen.fehler }, { status: 400 });
  }

  try {
    const [, steuerung] = await Promise.all([
      speicherePaket(gelesen.paket, jetzt),
      ladeSteuerung(createAdminClient()).then(steuerungFuersRig, (e: unknown): SteuerungRig | null => {
        logError("technik.messwerte.steuerung", e);
        return null;
      }),
    ]);
    return NextResponse.json(steuerung ? { success: true, steuerung } : { success: true });
  } catch (e) {
    logError("technik.messwerte", e);
    return NextResponse.json({ success: false, error: "Speichern fehlgeschlagen" }, { status: 500 });
  }
}
