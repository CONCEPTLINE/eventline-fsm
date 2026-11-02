// GET/PUT /api/jobs/[id]/catering — Getränke-Catering eines Auftrags (Reiter «Catering»).
//
//   GET  → { job, karte, parameter, gespeichert }   (alles, was der Reiter zum Rechnen braucht)
//   PUT  { gaeste, aufbauMin, gesamtMin, abbauMin, vorzeitMin, pauseMin, nachzeitMin, ausschankBeginn? }
//        + anlass? (Auftraggeber/in und Adresse kommen live aus dem Auftrag, nicht aus dem Formular)
//        → rechnet serverseitig neu (Karte + Einstellungen von jetzt), speichert Eingaben UND das
//          eingefrorene Ergebnis. Die PDFs lesen später dieses Ergebnis, damit Vertrag und Mail
//          dieselben Zahlen zeigen, auch wenn sich Einstellungen später ändern.
//
// Recht: nur Admins (Einkaufspreise, Personalkosten und Gewinn sind intern). Archivierte Aufträge: nur lesen (409).
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/api-auth";
import { logError } from "@/lib/log";
import { ladeGespeichert, ladeJobKontext, ladeKarte, ladeParameter } from "@/lib/catering/daten";
import { rechneCatering, type CateringEingabe } from "@/lib/catering/rechnen";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fehler = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status });

function ganz(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: jobId } = await ctx.params;
  if (!UUID_RE.test(jobId)) return fehler("Ungültige Auftrags-ID");
  const auth = await requireAdmin();
  if (auth.error) return auth.error;
  try {
    const admin = createAdminClient();
    const job = await ladeJobKontext(admin, jobId);
    if (!job) return fehler("Auftrag nicht gefunden", 404);
    const [karte, parameter, gespeichert] = await Promise.all([ladeKarte(admin), ladeParameter(admin), ladeGespeichert(admin, jobId)]);
    return NextResponse.json({ success: true, job, karte, parameter, gespeichert });
  } catch (e) {
    logError("catering.laden", e);
    return fehler("Laden fehlgeschlagen", 500);
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id: jobId } = await ctx.params;
  if (!UUID_RE.test(jobId)) return fehler("Ungültige Auftrags-ID");
  const auth = await requireAdmin();
  if (auth.error) return auth.error;

  let b: Record<string, unknown>;
  try {
    b = (await req.json()) as Record<string, unknown>;
  } catch {
    return fehler("Ungültige Anfrage");
  }
  const gaeste = ganz(b.gaeste, 1, 5000);
  const aufbauMin = ganz(b.aufbauMin, 0, 1440);
  const gesamtMin = ganz(b.gesamtMin, 1, 2880);
  const abbauMin = ganz(b.abbauMin, 0, 1440);
  const vorzeitMin = ganz(b.vorzeitMin, 0, 1440);
  const pauseMin = ganz(b.pauseMin, 0, 1440);
  const nachzeitMin = ganz(b.nachzeitMin, 0, 1440);
  if (gaeste == null) return fehler("Anzahl Gäste: ganze Zahl von 1 bis 5000");
  if (gesamtMin == null) return fehler("Veranstaltungsdauer: ganze Minuten, mindestens 1");
  if (aufbauMin == null || abbauMin == null || vorzeitMin == null || pauseMin == null || nachzeitMin == null) {
    return fehler("Minuten müssen ganze Zahlen von 0 bis 1440 sein");
  }
  if (vorzeitMin + pauseMin + nachzeitMin > gesamtMin) {
    return fehler("Vorzeit, Pause und Nachzeit zusammen dürfen nicht länger sein als die Veranstaltung");
  }
  const beginn = typeof b.ausschankBeginn === "string" ? b.ausschankBeginn.trim().slice(0, 20) : "";
  const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const anlass = text(b.anlass, 120);

  try {
    const admin = createAdminClient();
    const job = await ladeJobKontext(admin, jobId);
    if (!job) return fehler("Auftrag nicht gefunden", 404);
    if (!job.auftraggeber) {
      return fehler("Im Auftrag fehlt die Kontaktperson (Veranstalter/in). Bitte zuerst im Auftrag eintragen.", 422);
    }
    if (job.status === "abgeschlossen" || job.status === "storniert") {
      return fehler("Der Auftrag ist archiviert und kann nur noch gelesen werden", 409);
    }
    const [karte, parameter] = await Promise.all([ladeKarte(admin), ladeParameter(admin)]);
    const eingabe: CateringEingabe = { gaeste, aufbauMin, gesamtMin, abbauMin, vorzeitMin, pauseMin, nachzeitMin };
    let ergebnis;
    try {
      ergebnis = rechneCatering(eingabe, parameter, karte);
    } catch (e) {
      return fehler(e instanceof Error ? e.message : "Berechnung nicht möglich", 422);
    }
    const { error } = await admin.from("job_catering").upsert(
      {
        job_id: jobId,
        gaeste,
        aufbau_min: aufbauMin,
        gesamt_min: gesamtMin,
        abbau_min: abbauMin,
        vorzeit_min: vorzeitMin,
        pause_min: pauseMin,
        nachzeit_min: nachzeitMin,
        ausschank_beginn: beginn || null,
        anlass: anlass || null,
        ergebnis,
        updated_by: auth.user.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "job_id" },
    );
    if (error) throw error;
    return NextResponse.json({ success: true, ergebnis });
  } catch (e) {
    logError("catering.speichern", e);
    return fehler("Speichern fehlgeschlagen", 500);
  }
}
