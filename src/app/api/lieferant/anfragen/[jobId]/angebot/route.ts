// /api/lieferant/anfragen/[jobId]/angebot — Angebots-Upload des Lieferanten
// (Philippe-Mail 2026-09-24: "ich sende Euch das Angebot inkl. allem
// Material").
//
// GET  → NUR Angebote, die Portal-Konten DIESES Lieferanten hochgeladen
//        haben: Pfad jobs/<jobId>/lieferant-<lieferantId>/… im Ordner
//        «Angebote» (den Pfad vergibt ausschliesslich diese Route). Firmen-
//        Uploads im Ordner «Angebote» erscheinen hier nie.
// POST { schritt: "start", name, groesse }
//        → prueft Login, Zuweisung (angefragt) und Status und liefert eine
//          signierte Upload-URL: die Datei geht DIREKT in den Storage, an
//          Vercel vorbei (Funktionen nehmen nur ~4,5 MB Body an). Nach der
//          Antwort: verwaiste eigene Uploads (> 24 h, nie bestaetigt)
//          aufraeumen (lib/lieferant-angebot; zusaetzlich taeglich im Cron).
// POST { schritt: "fertig", pfad, name }
//        → prueft die hochgeladene Datei (Dateikopf %PDF-, Groesse <= 20 MB),
//          legt die Dokument-Zeile an (Ordner «Angebote»), Aktivitaet +
//          Benachrichtigung. Ungueltige Dateien werden wieder geloescht.

import { after, NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import https from "node:https";
import { requireLieferantPortal, logTechnik, lieferantAuftrag, sperrGrund, technikAntwortEmpfaenger } from "@/lib/technik-server";
import { angebotPraefix, angebotWaisenAufraeumen } from "@/lib/lieferant-angebot";
import { notifyTechnikAntwort } from "@/lib/notification-service";
import { logError } from "@/lib/log";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BYTES = 20 * 1024 * 1024;
const NAME_MAX = 200;

const fehler = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status });

export async function GET(_req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const gate = await requireLieferantPortal();
  if (gate.error) return gate.error;
  const { admin, lieferantId } = gate;
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return fehler("Ungültige ID");
  const zugriff = await lieferantAuftrag(admin, jobId, lieferantId);
  if (!zugriff.ok) return zugriff.antwort;

  const praefix = angebotPraefix(jobId, lieferantId);
  const { data: docs, error } = await admin
    .from("documents")
    .select("id, name, storage_path, created_at")
    .eq("job_id", jobId.toLowerCase())
    .eq("folder", "Angebote")
    .like("storage_path", `${praefix}%`)
    .order("created_at", { ascending: false });
  if (error) {
    logError("api.lieferant.anfragen.angebot.liste", error, { jobId });
    return fehler("Laden fehlgeschlagen", 500);
  }

  const angebote: { id: string; name: string; createdAt: string; url: string | null }[] = [];
  for (const d of (docs ?? []) as { id: string; name: string; storage_path: string; created_at: string }[]) {
    // Zweite Sicherung zum LIKE-Filter: exakt im eigenen Ordner, kein
    // '..' (Pfad-Ausbruch) — der Admin-Client umgeht die Storage-Regeln.
    if (typeof d.storage_path !== "string" || !d.storage_path.startsWith(praefix) || d.storage_path.includes("..")) continue;
    const { data: s } = await admin.storage.from("documents").createSignedUrl(d.storage_path, 3600);
    angebote.push({ id: d.id, name: d.name, createdAt: d.created_at, url: s?.signedUrl ?? null });
  }
  return NextResponse.json({ success: true, angebote });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const gate = await requireLieferantPortal();
  if (gate.error) return gate.error;
  const { admin, lieferantId, lieferantName, userId, userName } = gate;
  const { jobId: rohJobId } = await params;
  if (!UUID_RE.test(rohJobId)) return fehler("Ungültige ID");
  const jobId = rohJobId.toLowerCase();
  const zugriff = await lieferantAuftrag(admin, jobId, lieferantId);
  if (!zugriff.ok) return zugriff.antwort;
  if (zugriff.auftrag.gesperrt) return fehler(sperrGrund(zugriff.auftrag.job.status), 409);

  const b = ((await req.json().catch(() => null)) ?? {}) as {
    schritt?: string;
    name?: unknown;
    groesse?: unknown;
    pfad?: unknown;
  };
  const praefix = angebotPraefix(jobId, lieferantId);

  try {
    if (b.schritt === "start") {
      const name = typeof b.name === "string" ? b.name.trim() : "";
      const groesse = typeof b.groesse === "number" ? b.groesse : NaN;
      if (!name || name.length > NAME_MAX) return fehler("Ungültiger Dateiname");
      if (!/\.pdf$/i.test(name)) return fehler("Bitte ein PDF hochladen");
      if (!Number.isFinite(groesse) || groesse <= 0) return fehler("Die Datei ist leer");
      if (groesse > MAX_BYTES) return fehler("Datei zu gross (max. 20 MB)");
      const sicher = name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120);
      const pfad = `${praefix}${Date.now()}_${randomUUID().slice(0, 8)}_${/^angebot/i.test(sicher) ? sicher : `Angebot_${sicher}`}`;
      const { data, error } = await admin.storage.from("documents").createSignedUploadUrl(pfad);
      if (error || !data) throw error ?? new Error("Keine Upload-URL");
      // Abgebrochene fruehere Uploads dieses Lieferanten aufraeumen — nach der
      // Antwort, damit der Upload nicht wartet; wirft nie.
      after(() => angebotWaisenAufraeumen(admin, lieferantId));
      return NextResponse.json({ success: true, pfad: data.path, token: data.token });
    }

    if (b.schritt === "fertig") {
      const pfad = typeof b.pfad === "string" ? b.pfad : "";
      const rest = pfad.startsWith(praefix) ? pfad.slice(praefix.length) : "";
      // Nur eine Datei direkt im eigenen Ordner, kein Pfad-Ausbruch.
      if (!rest || rest.includes("/") || pfad.includes("..")) return fehler("Ungültiger Pfad");
      const anzeigeName = (typeof b.name === "string" && b.name.trim().slice(0, NAME_MAX)) || rest;

      // Doppelt gesendet (z.B. Netz-Wiederholung)? Dann ist alles schon da.
      const { data: schon, error: sErr } = await admin
        .from("documents").select("id").eq("storage_path", pfad).maybeSingle();
      if (sErr) throw sErr;
      if (schon) return NextResponse.json({ success: true });

      const storage = admin.storage.from("documents");
      const weg = async (grund: string) => {
        const { error } = await storage.remove([pfad]);
        if (error) logError("api.lieferant.anfragen.angebot.remove", error, { jobId, pfad });
        return fehler(grund);
      };
      const { data: info, error: iErr } = await storage.info(pfad);
      if (iErr || !info) return fehler("Die Datei ist nicht angekommen — bitte erneut hochladen");
      const groesse = Number(info.size ?? 0);
      if (!groesse) return weg("Die Datei ist leer");
      if (groesse > MAX_BYTES) return weg("Datei zu gross (max. 20 MB)");
      if (!(await istPdf(admin, pfad))) return weg("Das ist keine gültige PDF-Datei");

      const { error: insErr } = await admin.from("documents").insert({
        name: anzeigeName,
        storage_path: pfad,
        file_size: groesse,
        mime_type: "application/pdf",
        job_id: jobId,
        uploaded_by: userId,
        folder: "Angebote",
      });
      if (insErr) {
        await storage.remove([pfad]);
        throw insErr;
      }

      await logTechnik(admin, jobId, { id: userId, name: userName ?? lieferantName }, "angebot_hochgeladen",
        `${lieferantName} hat ein Angebot hochgeladen: ${anzeigeName}`);
      await notifyTechnikAntwort(admin, {
        recipients: await technikAntwortEmpfaenger(admin, zugriff.auftrag.job.projectLeadId, [userId]),
        jobId,
        jobTitle: zugriff.auftrag.job.title,
        lieferantName,
        was: `Angebot hochgeladen: ${anzeigeName}`,
      });
      return NextResponse.json({ success: true });
    }

    return fehler("Unbekannter Schritt");
  } catch (e) {
    logError("api.lieferant.anfragen.angebot", e, { jobId });
    return NextResponse.json({ success: false, error: "Upload fehlgeschlagen" }, { status: 500 });
  }
}

/** Dateikopf pruefen: echte PDFs beginnen mit "%PDF-". Liest nur die
 *  ersten Bytes (Range-Request auf eine kurzlebige signierte URL).
 *  Bewusst node:https statt fetch: Next.js' gepatchtes fetch laedt in der
 *  Server-Laufzeit den ganzen Body (gemessen: 10 Min. fuer 5 Bytes aus
 *  9 MB) — hier wird nach den ersten Bytes abgebrochen. */
async function istPdf(admin: SupabaseClient, pfad: string): Promise<boolean> {
  const { data } = await admin.storage.from("documents").createSignedUrl(pfad, 60);
  if (!data?.signedUrl) return false;
  try {
    return (await dateikopf(data.signedUrl, 5)).toString("latin1") === "%PDF-";
  } catch (e) {
    logError("api.lieferant.anfragen.angebot.kopf", e, { pfad });
    return false;
  }
}

function dateikopf(url: string, n: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let fertig = false;
    const erledigt = (fn: () => void) => { if (!fertig) { fertig = true; fn(); } };
    const req = https.get(url, { headers: { Range: `bytes=0-${n - 1}` } }, (res) => {
      if ((res.statusCode ?? 500) >= 400) {
        erledigt(() => reject(new Error(`HTTP ${res.statusCode}`)));
        req.destroy();
        return;
      }
      const teile: Buffer[] = [];
      let laenge = 0;
      const ende = () => erledigt(() => { req.destroy(); resolve(Buffer.concat(teile).subarray(0, n)); });
      res.on("data", (c: Buffer) => { teile.push(c); laenge += c.length; if (laenge >= n) ende(); });
      res.on("end", ende);
      res.on("error", (e) => erledigt(() => reject(e)));
    });
    req.setTimeout(15_000, () => req.destroy(new Error("Zeitüberschreitung beim Prüfen der Datei")));
    req.on("error", (e) => erledigt(() => reject(e)));
  });
}
