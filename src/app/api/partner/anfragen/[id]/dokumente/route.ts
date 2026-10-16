// /api/partner/anfragen/[id]/dokumente — Dokumente einer EIGENEN Anfrage.
//
// GET  ?dok=<id>  → signierte URL (1 h) zum Ansehen/Herunterladen — nur fuer
//                   Dokumente, die der Partner sehen darf (alles von EVENTLINE
//                   und die eigenen Anhaenge, nie Lieferanten-Dokumente).
// POST { schritt: "start", name, groesse, typ }
//        → prueft Recht (partner:anfragen:edit), Status (Entwurf/Anfrage/
//          bestaetigt), Groesse (25 MB) und Dateityp und liefert eine
//          signierte Upload-URL: die Datei geht DIREKT in den Storage, an
//          Vercel vorbei (wie das Lieferanten-Angebot). Danach werden
//          verwaiste fruehere Uploads dieser Anfrage aufgeraeumt.
// POST { schritt: "fertig", pfad, name }
//        → prueft die hochgeladene Datei (vorhanden, Groesse, Typ) und legt die
//          Dokument-Zeile an. Ungueltige Dateien werden wieder geloescht.

import { after, NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import {
  requirePartnerPortal,
  eigeneAnfrageLaden,
  anfrageDokumente,
  partnerFehler,
  partnerOrdnerAufraeumen,
} from "@/lib/partner-portal-server";
import { istNachreichbar, partnerOrdner } from "@/lib/partner-anfrage";
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MB, dateitypErlaubt } from "@/lib/upload-regeln";
import { isUuid } from "@/lib/search-escape";
import { logError } from "@/lib/log";

const NAME_MAX = 200;
const GESPERRT = "Dokumente können in diesem Status nicht mehr hinzugefügt werden";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePartnerPortal();
  if (gate.error) return gate.error;
  if (!gate.darfLesen) return partnerFehler("Kein Zugriff", 403);
  const { id } = await params;
  const dokId = req.nextUrl.searchParams.get("dok");
  if (!isUuid(dokId)) return partnerFehler("Ungültiges Dokument", 400);
  const geladen = await eigeneAnfrageLaden(gate, id);
  if (!geladen.ok) return geladen.antwort;

  try {
    const dok = (await anfrageDokumente(gate.admin, geladen.job.id)).find((d) => d.id === dokId.toLowerCase());
    if (!dok) return partnerFehler("Datei nicht verfügbar", 404);
    const { data, error } = await gate.admin.storage.from("documents").createSignedUrl(dok.storage_path, 3600);
    if (error || !data?.signedUrl) {
      logError("api.partner.dokumente.signieren", error, { jobId: geladen.job.id, dokId });
      return partnerFehler("Datei nicht verfügbar", 404);
    }
    return NextResponse.json({ success: true, url: data.signedUrl });
  } catch (e) {
    logError("api.partner.dokumente.laden", e, { jobId: geladen.job.id });
    return partnerFehler("Datei nicht verfügbar", 500);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePartnerPortal();
  if (gate.error) return gate.error;
  if (!gate.darf("partner:anfragen:edit")) return partnerFehler("Keine Berechtigung für diese Aktion", 403);
  const { id } = await params;
  const geladen = await eigeneAnfrageLaden(gate, id);
  if (!geladen.ok) return geladen.antwort;
  const jobId = geladen.job.id;
  if (!istNachreichbar(geladen.job.status)) return partnerFehler(GESPERRT, 409);
  const { admin } = gate;

  const b = ((await req.json().catch(() => null)) ?? {}) as {
    schritt?: unknown; name?: unknown; groesse?: unknown; typ?: unknown; pfad?: unknown;
  };
  const praefix = partnerOrdner(jobId);
  const storage = admin.storage.from("documents");

  try {
    if (b.schritt === "start") {
      const name = typeof b.name === "string" ? b.name.trim() : "";
      const groesse = typeof b.groesse === "number" ? b.groesse : NaN;
      const typ = typeof b.typ === "string" ? b.typ : "";
      if (!name || name.length > NAME_MAX) return partnerFehler("Ungültiger Dateiname", 400);
      if (!Number.isFinite(groesse) || groesse <= 0) return partnerFehler("Die Datei ist leer", 400);
      if (groesse > MAX_UPLOAD_BYTES) return partnerFehler(`Datei zu gross. Max ${MAX_UPLOAD_MB} MB.`, 400);
      if (!dateitypErlaubt(typ)) return partnerFehler(`Dateityp nicht erlaubt: ${typ || "unbekannt"}`, 400);
      const sicher = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
      const pfad = `${praefix}${Date.now()}_${randomUUID().slice(0, 8)}_${sicher}`;
      const { data, error } = await storage.createSignedUploadUrl(pfad);
      if (error || !data) throw error ?? new Error("Keine Upload-URL");
      // Abgebrochene fruehere Uploads dieser Anfrage aufraeumen — nach der
      // Antwort, damit der Upload nicht wartet; wirft nie.
      after(() => partnerOrdnerAufraeumen(admin, jobId));
      return NextResponse.json({ success: true, pfad: data.path, token: data.token });
    }

    if (b.schritt === "fertig") {
      const pfad = typeof b.pfad === "string" ? b.pfad : "";
      const rest = pfad.startsWith(praefix) ? pfad.slice(praefix.length) : "";
      // Nur eine Datei direkt im Anfrage-Ordner, kein Pfad-Ausbruch.
      if (!rest || rest.includes("/") || pfad.includes("..")) return partnerFehler("Ungültiger Pfad", 400);
      const anzeigeName = (typeof b.name === "string" && b.name.trim().slice(0, NAME_MAX)) || rest;

      // Doppelt gesendet (z.B. Netz-Wiederholung)? Dann ist alles schon da.
      const { data: schon, error: sErr } = await admin.from("documents").select("id").eq("storage_path", pfad).maybeSingle();
      if (sErr) throw sErr;
      if (schon) return NextResponse.json({ success: true });

      const weg = async (grund: string, status = 400) => {
        const { error } = await storage.remove([pfad]);
        if (error) logError("api.partner.dokumente.remove", error, { jobId, pfad });
        return partnerFehler(grund, status);
      };
      const { data: info, error: iErr } = await storage.info(pfad);
      if (iErr || !info) return partnerFehler("Die Datei ist nicht angekommen — bitte erneut hochladen", 400);
      const groesse = Number(info.size ?? 0);
      if (!groesse) return weg("Die Datei ist leer");
      if (groesse > MAX_UPLOAD_BYTES) return weg(`Datei zu gross. Max ${MAX_UPLOAD_MB} MB.`);
      const typ = typeof info.contentType === "string" ? info.contentType.split(";")[0].trim() : "";
      if (!dateitypErlaubt(typ)) return weg(`Dateityp nicht erlaubt: ${typ || "unbekannt"}`);

      // Status nochmals pruefen (EVENTLINE kann inzwischen abgeschlossen haben).
      const { data: offen, error: oErr } = await admin.from("jobs").select("status").eq("id", jobId).maybeSingle();
      if (oErr) throw oErr;
      if (!offen || !istNachreichbar(offen.status as string)) return weg(GESPERRT, 409);

      const { error: insErr } = await admin.from("documents").insert({
        name: anzeigeName,
        storage_path: pfad,
        file_size: groesse,
        mime_type: typ || null,
        job_id: jobId,
        uploaded_by: gate.userId,
      });
      if (insErr) {
        await storage.remove([pfad]);
        throw insErr;
      }
      return NextResponse.json({ success: true });
    }

    return partnerFehler("Unbekannter Schritt", 400);
  } catch (e) {
    logError("api.partner.dokumente.upload", e, { jobId });
    return partnerFehler("Upload fehlgeschlagen", 500);
  }
}
