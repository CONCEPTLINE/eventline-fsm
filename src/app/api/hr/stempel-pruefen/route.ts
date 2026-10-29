// «Geprüft» für sehr lange Stempel (Lohn-Umbau Phase 4).
//
// POST /api/hr/stempel-pruefen  { id }  → { success, geprueft_at, geprueft_von_name }
//
// Die Lohnverwaltung bestätigt einen abgeschlossenen Stempel über
// STEMPEL_LANG_STUNDEN als korrekt — er blockiert den Monatsabschluss dann
// nicht mehr (src/lib/lohn/stempel-pruefung.ts). Setzt geprueft_at/von/
// von_name mit dem Admin-Client (nur der Server darf, Trigger
// time_entries_lohn_felder, Migration 367). Ändert sich später Beginn/Ende,
// fällt «geprüft» in der Datenbank weg. Kein Einfluss auf den Lohn — geht
// darum auch in abgerechneten Monaten.
//
// Wer: Lohnrecht (lohn:manage) + vertrautes Gerät; den eigenen Stempel prüft
// eine zweite Person. Der Knopf sitzt in der Monatsstunden-Tabelle.

import { NextResponse } from "next/server";
import { requireTrustedDevice } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { isUuid } from "@/lib/search-escape";
import { LOHN_RECHT } from "@/lib/lohn/zugriff";
import { ladeName } from "@/lib/lohn/rechte-antraege";
import { istLangerStempel, STEMPEL_LANG_STUNDEN } from "@/lib/lohn/stempel-pruefung";

const fehler = (status: number, error: string) => NextResponse.json({ success: false, error }, { status });

export async function POST(req: Request) {
  const auth = await requireTrustedDevice(LOHN_RECHT);
  if (auth.error) return auth.error;
  if (auth.isImpersonating) return fehler(403, "In «Ansicht als» nicht möglich.");
  const b = (await req.json().catch(() => null)) as { id?: unknown } | null;
  const id = typeof b?.id === "string" && isUuid(b.id) ? b.id : null;
  if (!id) return fehler(400, "id fehlt");

  const admin = createAdminClient();
  const { data: s, error } = await admin
    .from("time_entries")
    .select("id, user_id, clock_in, clock_out, geprueft_at, geprueft_von_name")
    .eq("id", id)
    .maybeSingle();
  if (error) return fehler(500, error.message);
  if (!s) return fehler(404, "Stempel nicht gefunden (inzwischen gelöscht?)");
  if (!s.clock_out) return fehler(400, "Der Stempel läuft noch — erst das Ende setzen (per Antrag), dann prüfen.");
  if (!istLangerStempel(s.clock_in as string, s.clock_out as string)) {
    return fehler(400, `Nur Stempel über ${STEMPEL_LANG_STUNDEN} Stunden werden geprüft.`);
  }
  if (s.user_id === auth.user.id) return fehler(403, "Den eigenen Stempel prüft eine zweite Person.");
  if (s.geprueft_at) {
    return NextResponse.json({ success: true, geprueft_at: s.geprueft_at, geprueft_von_name: s.geprueft_von_name, schon: true });
  }

  const name = await ladeName(admin, auth.user.id);
  const jetzt = new Date().toISOString();
  // Nur, solange Beginn/Ende noch dem geprüften Stand entsprechen.
  const { data: neu, error: upErr } = await admin
    .from("time_entries")
    .update({ geprueft_at: jetzt, geprueft_von: auth.user.id, geprueft_von_name: name })
    .eq("id", id)
    .eq("clock_in", s.clock_in)
    .eq("clock_out", s.clock_out)
    .select("geprueft_at, geprueft_von_name");
  if (upErr) return fehler(500, upErr.message);
  if (!neu || neu.length !== 1) return fehler(409, "Der Stempel wurde inzwischen geändert — bitte neu laden.");
  return NextResponse.json({ success: true, geprueft_at: neu[0].geprueft_at, geprueft_von_name: neu[0].geprueft_von_name });
}
