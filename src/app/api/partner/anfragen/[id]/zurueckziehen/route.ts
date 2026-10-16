// POST /api/partner/anfragen/[id]/zurueckziehen — Partner zieht eine noch
// nicht bestaetigte EIGENE Anfrage zurueck (Entwurf / Anfrage). Bestaetigte
// Anfragen — auch im Aenderungsmodus — nie (409, Leo 2026-10-16).
//
// Ablauf:
//   1. requirePartnerPortal + eigene Anfrage + Recht partner:anfragen:delete
//      + nicht bestaetigt.
//   2. RPC partnerportal_zurueckziehen (Migration 345) fuehrt die bestehende
//      partner_withdraw_anfrage im Namen des Partners aus: Status-/Standort-
//      Pruefung, loescht documents-Zeilen, Termine und den Auftrag in EINER
//      Transaktion und liefert die storage_paths der Anhaenge zurueck.
//   3. Admin-Client entfernt NUR Pfade unter 'partner-anfragen/<jobId>/' aus
//      dem Bucket documents — plus verwaiste Uploads in diesem Ordner.

import { NextRequest, NextResponse } from "next/server";
import {
  requirePartnerPortal,
  eigeneAnfrageLaden,
  partnerFehler,
  partnerOrdnerAufraeumen,
  partnerRpcFehler,
} from "@/lib/partner-portal-server";
import { istBestaetigt, partnerOrdner, ZURUECKZIEHEN_BESTAETIGT } from "@/lib/partner-anfrage";
import { logError } from "@/lib/log";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePartnerPortal();
  if (gate.error) return gate.error;
  if (!gate.darf("partner:anfragen:delete")) return partnerFehler("Kein Zugriff auf diese Anfrage", 403);
  const { id } = await params;
  const geladen = await eigeneAnfrageLaden<{ partner_aenderung: unknown }>(gate, id, "partner_aenderung");
  if (!geladen.ok) return geladen.antwort;
  // Bestaetigte Anfragen (auch im Aenderungsmodus) werden nie geloescht
  // (Leo 2026-10-16) — die RPC prueft dasselbe unter Zeilensperre.
  if (istBestaetigt(geladen.job)) return partnerFehler(ZURUECKZIEHEN_BESTAETIGT, 409);
  // Klein wie job_id::text — sonst passt das Ordner-Praefix unten nicht.
  const jobId = geladen.job.id.toLowerCase();

  const { data, error } = await gate.admin.rpc("partnerportal_zurueckziehen", { p_actor: gate.userId, p_job_id: jobId });
  if (error) {
    logError("api.partner.zurueckziehen.rpc", error, { userId: gate.userId, jobId });
    const f = partnerRpcFehler(error.message, "Anfrage konnte nicht zurückgezogen werden");
    return partnerFehler(f.error, f.status);
  }

  // RPC liefert eine Zeile mit der text[]-Spalte storage_paths
  const paths = ((data as unknown as { storage_paths: string[] | null }[] | null) ?? [])[0]?.storage_paths ?? [];
  const praefix = partnerOrdner(jobId);
  const zuLoeschen = paths.filter((p) => typeof p === "string" && p.startsWith(praefix) && !p.includes(".."));
  const uebersprungen = paths.length - zuLoeschen.length;
  if (uebersprungen > 0) {
    // Anhaenge ausserhalb des Anfrage-Ordners (z. B. intern abgelegt) loescht
    // die Route bewusst nicht — nur protokollieren.
    logError("api.partner.zurueckziehen.fremde-pfade", null, { jobId, anzahl: uebersprungen });
  }

  let warnung: string | undefined;
  if (zuLoeschen.length > 0) {
    const { error: rmErr } = await gate.admin.storage.from("documents").remove(zuLoeschen);
    if (rmErr) {
      logError("api.partner.zurueckziehen.storage", rmErr, { jobId, anzahl: zuLoeschen.length });
      warnung = "Anfrage zurückgezogen, Anhänge konnten aber nicht vollständig entfernt werden";
    }
  }
  // Abgebrochene Uploads (Datei ohne Dokument-Zeile) im Anfrage-Ordner.
  await partnerOrdnerAufraeumen(gate.admin, jobId, { alle: true });

  return NextResponse.json(warnung ? { success: true, warnung } : { success: true });
}
