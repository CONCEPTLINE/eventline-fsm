// POST /api/inbound/mail — Resend-Webhook (email.received) fuer die
// Auftrags-Mailadresse auftrag@in.eventline-basel.com: weitergeleitete
// Kunden-Mails landen automatisch im Eingang des passenden Auftrags und
// werden sofort von der KI verarbeitet.
//
// Ablauf:
//  1. Svix-Signatur pruefen (RESEND_WEBHOOK_SECRET, whsec_…) — sonst 401.
//  2. Mail-Inhalt via Resend-API nachladen (Webhook liefert nur Metadaten).
//  3. Auftrag zuordnen: Auftragsnummer (26xxx / INT-26xxx) in Betreff oder
//     Text → sonst KI-Abgleich gegen offene Auftraege → sonst Benachrich-
//     tigung an alle Admins ("bitte manuell ablegen"); die Mail bleibt im
//     Resend-Posteingang erhalten.
//  4. Text als Eingang-Element (created_by NULL, absender gesetzt) +
//     PDF-/Bild-Anhaenge als Datei-Elemente in den Storage.
//  5. verarbeiteEingangItem() pro Element (gleiche Logik wie in der App).
//
// Immer 200 fuer verarbeitete/entschieden-unzuordenbare Mails (Resend soll
// nicht endlos retryen); 401/500 nur bei Signaturfehler/Infrastrukturfehler.

import { NextRequest, NextResponse } from "next/server";
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { aiAvailable, structuredCall } from "@/lib/ai/anthropic";
import { verarbeiteEingangItem } from "@/lib/ai/eingang-verarbeitung";
import { notifySystem } from "@/lib/notification-service";

export const maxDuration = 300;

const MAX_ANHAENGE = 5;

// ── Svix-Signatur (Resend-Webhooks) ──────────────────────────────
function verifySvix(secret: string, id: string, timestamp: string, payload: string, signatureHeader: string): boolean {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signed = createHmac("sha256", key).update(`${id}.${timestamp}.${payload}`).digest("base64");
  // Header: "v1,<sig> v1,<sig2> …"
  for (const part of signatureHeader.split(" ")) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    const a = Buffer.from(signed);
    const b = Buffer.from(sig);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

type MatchErgebnis = { job_id: string | null };

// Anthropic-Vision akzeptiert nur diese Bild-Typen.
const VISION_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Signatur-Grafiken (Logos, Banner, Icons) gehoeren NICHT in den Auftrag.
 *  Die KI schaut das Bild kurz an; wenn sie nicht kann (kein Key, Zeitbudget
 *  aufgebraucht, Fehler, exotischer Typ), gilt die Fallback-Regel: nur ECHTE
 *  Anhaenge behalten (content_disposition 'attachment'), eingebettete
 *  Inline-Bilder verwerfen. */
async function bildBehalten(opts: {
  disposition: string | null | undefined;
  mediaType: string;
  bin: ArrayBuffer;
  zeitOk: boolean;
}): Promise<boolean> {
  const { disposition, mediaType, bin, zeitOk } = opts;
  // Mini-Grafiken unter 10 KB inline = praktisch immer Icons/Logos.
  if (disposition === "inline" && bin.byteLength < 10_000) return false;
  if (aiAvailable() && zeitOk && VISION_TYPES.has(mediaType) && bin.byteLength < 4_500_000) {
    try {
      const erg = await structuredCall<{ relevant: boolean }>({
        system:
          "Du beurteilst EIN Bild aus einer E-Mail an eine Veranstaltungstechnik-Firma. " +
          "Relevant sind inhaltliche Anhaenge: Fotos vom Ort/Material, Screenshots, Plaene, Skizzen, Dokumente, Offerten. " +
          "NICHT relevant ist Signatur- und Layout-Deko: Firmenlogos, Banner, Schriftzuege, Icons, Social-Media-Grafiken.",
        content: [
          { type: "text", text: "Beurteile dieses Bild:" },
          { type: "image", source: { type: "base64", media_type: mediaType as "image/jpeg", data: Buffer.from(bin).toString("base64") } },
        ],
        toolName: "bild_beurteilen",
        toolDescription: "Meldet, ob das Bild ein inhaltlich relevanter Anhang ist.",
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["relevant"],
          properties: {
            relevant: { type: "boolean", description: "true = inhaltlich relevanter Anhang, false = Signatur-/Layout-Deko" },
          },
        },
      });
      return erg.relevant;
    } catch {
      /* faellt auf die Disposition-Regel zurueck */
    }
  }
  return disposition !== "inline";
}

export async function POST(req: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Webhook nicht konfiguriert" }, { status: 503 });
  }
  const payload = await req.text();
  const svixId = req.headers.get("svix-id") ?? "";
  const svixTs = req.headers.get("svix-timestamp") ?? "";
  const svixSig = req.headers.get("svix-signature") ?? "";
  if (!svixId || !svixTs || !svixSig || !verifySvix(secret, svixId, svixTs, payload, svixSig)) {
    return NextResponse.json({ error: "Ungültige Signatur" }, { status: 401 });
  }

  let event: { type?: string; data?: { email_id?: string } };
  try {
    event = JSON.parse(payload);
  } catch {
    return NextResponse.json({ error: "Ungültiges Payload" }, { status: 400 });
  }
  if (event.type !== "email.received" || !event.data?.email_id) {
    return NextResponse.json({ ok: true, skipped: event.type });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return NextResponse.json({ error: "Resend-Key fehlt" }, { status: 503 });

  // Idempotenz: Resend wiederholt Webhooks bei Timeouts — dieselbe Mail
  // darf nur EINMAL Eingang-Elemente erzeugen (Vorfall: 3x identische
  // Mails in INT-26309).
  const adminEarly = createAdminClient();
  const { data: schonDa } = await adminEarly
    .from("job_inbox_items")
    .select("id")
    .eq("resend_email_id", event.data.email_id)
    .limit(1)
    .maybeSingle();
  if (schonDa) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  // ── 2. Vollstaendige Mail nachladen ────────────────────────────
  const mailRes = await fetch(`https://api.resend.com/emails/receiving/${event.data.email_id}`, {
    headers: { Authorization: `Bearer ${resendKey}` },
  });
  if (!mailRes.ok) {
    return NextResponse.json({ error: "Mail nicht abrufbar: HTTP " + mailRes.status }, { status: 500 });
  }
  const mail = (await mailRes.json()) as {
    id?: string;
    from: string;
    subject: string | null;
    text: string | null;
    html: string | null;
    attachments?: { id: string; filename: string | null; content_type: string | null; content_disposition?: string | null }[];
  };
  const subject = mail.subject ?? "";
  // Text bevorzugt; HTML grob enttaggt als Fallback.
  const text = mail.text ?? (mail.html ? mail.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "");

  const admin = adminEarly;

  // ── 3. Auftrag zuordnen ────────────────────────────────────────
  let jobId: string | null = null;
  // Nur echte EVENTLINE-Auftragsnummern (26xxx) — das breitere 2\d{4}
  // hatte in einem Mailverlauf die Fremdzahl "25013" gegriffen.
  const nummern = [...`${subject}\n${text}`.matchAll(/\b(?:INT[-\s]?)?(26\d{3})\b/gi)].map((m) => Number(m[1]));
  for (const nr of [...new Set(nummern)]) {
    const { data } = await admin
      .from("jobs")
      .select("id")
      .eq("job_number", nr)
      .not("is_deleted", "is", true)
      .maybeSingle();
    if (data) { jobId = data.id; break; }
  }

  if (!jobId && aiAvailable()) {
    // KI-Abgleich gegen laufende Auftraege (Kunde/Titel/Datum).
    const { data: kandidaten } = await admin
      .from("jobs")
      .select("id, job_number, title, start_date, customer:customers(name, email)")
      .in("status", ["offen", "partner_anfrage"])
      .not("is_deleted", "is", true)
      .order("start_date", { ascending: true })
      .limit(100);
    if (kandidaten?.length) {
      try {
        const liste = kandidaten.map((k) => {
          const c = Array.isArray(k.customer) ? k.customer[0] : k.customer;
          return `${k.id} | INT-${k.job_number} | ${k.title} | Kunde: ${c?.name ?? "?"} (${c?.email ?? "-"}) | ${k.start_date ?? "?"}`;
        }).join("\n");
        const match = await structuredCall<MatchErgebnis>({
          system:
            "Du ordnest eine weitergeleitete Kunden-Mail einem laufenden Veranstaltungstechnik-Auftrag von EVENTLINE (Basel) zu. " +
            "Gib die job_id aus der Liste NUR zurück, wenn die Zuordnung EINDEUTIG ist (Kunde/Absender, Eventname, Datum passen). " +
            "Im Zweifel null — falsche Zuordnung ist schlimmer als keine.",
          content: [{ type: "text", text: `AUFTRAEGE (id | nummer | titel | kunde | datum):\n${liste}\n\nMAIL:\nVon: ${mail.from}\nBetreff: ${subject}\n\n${text.slice(0, 4000)}` }],
          toolName: "zuordnung",
          toolDescription: "Gibt die eindeutig passende job_id oder null zurueck.",
          schema: {
            type: "object", additionalProperties: false, required: ["job_id"],
            properties: { job_id: { type: ["string", "null"], description: "id aus der Liste oder null" } },
          },
          maxTokens: 300,
        });
        if (match.job_id && kandidaten.some((k) => k.id === match.job_id)) jobId = match.job_id;
      } catch {
        /* KI-Zuordnung optional — faellt auf Admin-Benachrichtigung zurueck */
      }
    }
  }

  if (!jobId) {
    // Kein Auftrag gefunden → Admins informieren, Mail bleibt bei Resend.
    const { data: admins } = await admin.from("profiles").select("id").eq("role", "admin").eq("is_active", true);
    if (admins?.length) {
      await notifySystem(admin, {
        recipients: admins.map((a) => a.id),
        title: "Auftrags-Mail konnte nicht zugeordnet werden",
        message: `Von ${mail.from} · «${subject || "(kein Betreff)"}» — bitte mit Auftragsnummer im Betreff erneut weiterleiten oder manuell im Eingang ablegen.`,
        link: null,
      });
    }
    return NextResponse.json({ ok: true, matched: false });
  }

  // Transparenz: Admins erfahren IMMER, wohin eine Mail gelegt wurde —
  // sonst wirkt eine korrekt zugeordnete Mail wie "nicht erkannt"
  // (Vorfall Fw:Offerte → INT-26309, Leo suchte vergeblich).
  {
    const { data: zielJob } = await admin.from("jobs").select("job_number, title").eq("id", jobId).maybeSingle();
    const { data: adminsOk } = await admin.from("profiles").select("id").eq("role", "admin").eq("is_active", true);
    if (adminsOk?.length) {
      await notifySystem(admin, {
        recipients: adminsOk.map((a) => a.id),
        title: `Auftrags-Mail abgelegt: INT-${zielJob?.job_number ?? "?"}`,
        message: `Von ${mail.from} · «${subject || "(kein Betreff)"}» → ${zielJob?.title ?? ""} (Eingang)`,
        link: `/auftraege/${jobId}?tab=eingang`,
      });
    }
  }

  // ── 4. Eingang-Elemente anlegen ────────────────────────────────
  const startZeit = Date.now();
  const itemIds: string[] = [];
  const inhalt = `Von: ${mail.from}\nBetreff: ${subject || "(kein Betreff)"}\n\n${text}`.slice(0, 50000);
  const { data: textItem, error: insErr } = await admin
    .from("job_inbox_items")
    .insert({ job_id: jobId, kind: "text", content: inhalt, absender: mail.from, created_by: null, resend_email_id: event.data.email_id })
    .select("id")
    .single();
  if (insErr || !textItem) {
    return NextResponse.json({ error: "Eingang-Insert fehlgeschlagen" }, { status: 500 });
  }
  itemIds.push(textItem.id);

  const lesbar = (mail.attachments ?? []).filter((a) => {
    const t = a.content_type ?? "";
    return t.startsWith("image/") || t === "application/pdf";
  }).slice(0, MAX_ANHAENGE);
  // Duplikat-Schutz: dieselbe Datei (Inhalt-Hash) wird pro Auftrag nur
  // EINMAL abgelegt — innerhalb der Mail (Outlook haengt eingebettete
  // Bilder doppelt an) UND ueber Mails hinweg (Weiterleitungs-Ketten
  // bringen die gleichen JPEGs/PDFs mit jeder Mail erneut mit).
  const anhangHashes = new Set<string>();
  for (const a of lesbar) {
    try {
      const meta = await fetch(`https://api.resend.com/emails/receiving/${event.data.email_id}/attachments/${a.id}`, {
        headers: { Authorization: `Bearer ${resendKey}` },
      }).then((r) => r.json()) as { download_url?: string };
      if (!meta.download_url) continue;
      const bin = await fetch(meta.download_url).then((r) => r.arrayBuffer());
      const hash = createHash("sha1").update(Buffer.from(bin)).digest("hex");
      if (anhangHashes.has(hash)) continue;
      anhangHashes.add(hash);
      const { data: schonDa } = await admin
        .from("job_inbox_items")
        .select("id")
        .eq("job_id", jobId)
        .eq("inhalt_hash", hash)
        .limit(1);
      if (schonDa?.length) continue;
      const istBild = (a.content_type ?? "").startsWith("image/");
      if (istBild) {
        const behalten = await bildBehalten({
          disposition: a.content_disposition,
          mediaType: a.content_type ?? "",
          bin,
          zeitOk: Date.now() - startZeit < 200_000,
        });
        if (!behalten) continue;
      }
      const safe = (a.filename ?? "anhang").replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `auftraege/${jobId}/eingang/mail_${Date.now()}_${safe}`;
      const { error: upErr } = await admin.storage
        .from("documents")
        .upload(path, Buffer.from(bin), { contentType: a.content_type ?? "application/octet-stream" });
      if (upErr) continue;
      const { data: fileItem } = await admin
        .from("job_inbox_items")
        .insert({ job_id: jobId, kind: "datei", file_path: path, file_name: a.filename ?? safe, mime_type: a.content_type, absender: mail.from, created_by: null, resend_email_id: event.data.email_id, inhalt_hash: hash })
        .select("id")
        .single();
      if (fileItem) itemIds.push(fileItem.id);
      // Zusaetzlich als Dokument am Auftrag registrieren (gleiche Storage-
      // Datei, zweite Referenz) — Anhaenge gehoeren in den Dokumente-Tab.
      await admin.from("documents").insert({
        name: a.filename ?? safe,
        storage_path: path,
        file_size: bin.byteLength,
        mime_type: a.content_type,
        job_id: jobId,
        uploaded_by: null,
      });
    } catch {
      /* Einzel-Anhang-Fehler blockiert die Mail nicht */
    }
  }

  // ── 5. KI-Verarbeitung (sequentiell — Zusammenfassung baut aufeinander auf) ──
  let verarbeitet = 0;
  if (aiAvailable()) {
    for (const itemId of itemIds) {
      // Zeitbudget: Vercel killt die Funktion hart bei maxDuration — dann
      // blieben ALLE restlichen Elemente kommentarlos auf 'neu' haengen
      // (Vorfall Fw:Offerte/INT-26309). Kontrolliert abbrechen ist sauber:
      // der Rest verarbeitet sich beim naechsten Oeffnen des Eingang-Tabs.
      if (Date.now() - startZeit > 220_000) break;
      try {
        await verarbeiteEingangItem({ admin, jobId, itemId, actorUserId: null });
        verarbeitet++;
      } catch {
        /* Element steht auf 'fehler' — Retry-Knopf in der App */
      }
    }
  }

  return NextResponse.json({ ok: true, matched: true, items: itemIds.length, verarbeitet });
}
