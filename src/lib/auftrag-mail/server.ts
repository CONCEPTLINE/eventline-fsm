// Serverseitige Bausteine fuer Mails an auftrag@in.eventline-basel.com —
// geteilt vom Resend-Webhook (/api/inbound/mail) und der manuellen
// Zuordnung (/api/auftrag-mails/[id]). Alles auf dem Admin-Client; die
// Aufrufer pruefen vorher Signatur bzw. Recht.

import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "crypto";
import { aiAvailable, structuredCall } from "@/lib/ai/anthropic";
import { verarbeiteEingangItem } from "@/lib/ai/eingang-verarbeitung";
import { logError } from "@/lib/log";
import { todayLocalIso, plusTage } from "@/lib/swiss-time";
import {
  BETREFF_FENSTER_TAGE,
  betreffAussagekraeftig,
  entscheideVerlauf,
  type BekannteMail,
  type MailMerkmale,
  type VerlaufErgebnis,
} from "./verlauf";
import { abgleichVorschlaege, type Vorschlag, type VorschlagKandidat } from "./vorschlaege";

export const MAX_ANHAENGE = 5;
/** Privater Bucket fuer Anhaenge wartender Mails (Migration 349). */
export const WARTE_BUCKET = "auftrag-mails";

export type ResendMail = {
  id?: string;
  from: string;
  to?: string[] | string;
  subject: string | null;
  text: string | null;
  html: string | null;
  message_id?: string | null;
  headers?: unknown;
  attachments?: { id: string; filename: string | null; content_type: string | null; content_disposition?: string | null }[];
};

export type MailAnhang = { name: string; mime: string; disposition: string | null; bin: ArrayBuffer };

/** Gespeicherter Anhang einer wartenden Mail (auftrag_mails.anhaenge). */
export type WarteAnhang = { name: string; mime: string; disposition: string | null; pfad: string; groesse: number };

/** Mailtext: Text bevorzugt, HTML grob enttaggt als Fallback. */
export function mailText(mail: Pick<ResendMail, "text" | "html">): string {
  return mail.text ?? (mail.html ? mail.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "");
}

/** Lesbare Anhaenge (Bilder/PDF, max. 5) von Resend laden. Mini-Inline-
 *  Grafiken unter 10 KB (Signatur-Icons) werden gar nicht erst behalten. */
export async function ladeAnhaenge(emailId: string, resendKey: string, mail: ResendMail): Promise<MailAnhang[]> {
  const lesbar = (mail.attachments ?? [])
    .filter((a) => {
      const t = a.content_type ?? "";
      return t.startsWith("image/") || t === "application/pdf";
    })
    .slice(0, MAX_ANHAENGE);
  const out: MailAnhang[] = [];
  for (const a of lesbar) {
    try {
      const meta = (await fetch(`https://api.resend.com/emails/receiving/${emailId}/attachments/${a.id}`, {
        headers: { Authorization: `Bearer ${resendKey}` },
      }).then((r) => r.json())) as { download_url?: string };
      if (!meta.download_url) continue;
      const bin = await fetch(meta.download_url).then((r) => r.arrayBuffer());
      if (a.content_disposition === "inline" && bin.byteLength < 10_000) continue;
      out.push({ name: a.filename ?? "anhang", mime: a.content_type ?? "application/octet-stream", disposition: a.content_disposition ?? null, bin });
    } catch (e) {
      logError("auftrag-mail.anhang_laden", e);
    }
  }
  return out;
}

// ── Verlauf ──────────────────────────────────────────────────────

const BEKANNT_SELECT = "id, job_id, message_id, referenzen, konversation, betreff_norm, empfangen_am";

/** Schon zugeordnete Mails, die mit der neuen Mail einen Verlauf teilen
 *  koennten (Message-ID-Bezug in beide Richtungen, Outlook-Konversation,
 *  gleicher Betreff im Zeitfenster) — nur Auftraege, die es noch gibt. */
export async function findeVerlauf(admin: SupabaseClient, m: MailMerkmale, ausserId?: string): Promise<VerlaufErgebnis> {
  const basis = () => admin.from("auftrag_mails").select(BEKANNT_SELECT).not("job_id", "is", null).limit(50);
  const abfragen = [];
  if (m.referenzen.length) abfragen.push(basis().in("message_id", m.referenzen));
  if (m.messageId) abfragen.push(basis().contains("referenzen", [m.messageId]));
  if (m.konversation) abfragen.push(basis().eq("konversation", m.konversation));
  if (betreffAussagekraeftig(m.betreffNorm)) {
    const grenze = new Date(Date.now() - BETREFF_FENSTER_TAGE * 86_400_000).toISOString();
    abfragen.push(basis().eq("betreff_norm", m.betreffNorm).gte("empfangen_am", grenze));
  }
  if (!abfragen.length) return { art: "keiner" };
  const ergebnisse = await Promise.all(abfragen);
  const map = new Map<string, BekannteMail>();
  for (const r of ergebnisse) {
    if (r.error) throw new Error("Verlauf-Abfrage: " + r.error.message);
    for (const row of (r.data ?? []) as BekannteMail[]) if (row.id !== ausserId) map.set(row.id, row);
  }
  let bekannte = [...map.values()];
  const jobIds = [...new Set(bekannte.map((b) => b.job_id).filter(Boolean))] as string[];
  if (jobIds.length) {
    const { data: lebend } = await admin.from("jobs").select("id").in("id", jobIds).not("is_deleted", "is", true);
    const ok = new Set(((lebend ?? []) as { id: string }[]).map((j) => j.id));
    bekannte = bekannte.filter((b) => b.job_id && ok.has(b.job_id));
  }
  return entscheideVerlauf(m, bekannte);
}

// ── Kandidaten + KI ──────────────────────────────────────────────

type KandidatRow = {
  id: string;
  job_number: number;
  title: string | null;
  start_date: string | null;
  end_date: string | null;
  customer: { name: string | null; email: string | null } | { name: string | null; email: string | null }[] | null;
  location: { name: string | null } | { name: string | null }[] | null;
  room: { name: string | null } | { name: string | null }[] | null;
};

const eins = <T,>(v: T | T[] | null): T | null => (Array.isArray(v) ? v[0] ?? null : v);

/** Laufende Auftraege (nicht abgeschlossen/storniert, nicht geloescht),
 *  Start ab 45 Tagen zurueck oder ohne Datum. */
export async function ladeKandidaten(admin: SupabaseClient): Promise<VorschlagKandidat[]> {
  const ab = plusTage(todayLocalIso(), -45);
  const { data, error } = await admin
    .from("jobs")
    .select("id, job_number, title, start_date, end_date, customer:customers(name, email), location:locations(name), room:rooms(name)")
    .not("status", "in", "(abgeschlossen,storniert)")
    .not("is_deleted", "is", true)
    .or(`start_date.gte.${ab},start_date.is.null`)
    .order("start_date", { ascending: true, nullsFirst: false })
    .limit(200);
  if (error) throw new Error("Kandidaten: " + error.message);
  return ((data ?? []) as unknown as KandidatRow[]).map((k) => {
    const c = eins(k.customer);
    return {
      id: k.id,
      job_number: k.job_number,
      title: k.title,
      start_date: k.start_date,
      end_date: k.end_date,
      kunde: c?.name ?? null,
      kunde_email: c?.email ?? null,
      location: eins(k.location)?.name ?? null,
      raum: eins(k.room)?.name ?? null,
    };
  });
}

type KiAntwort = {
  sicherheit: "eindeutig" | "wahrscheinlich" | "unklar";
  job_id: string | null;
  kandidaten: { job_id: string; grund: string }[];
};

/** KI-Abgleich gegen laufende Auftraege. An Claude geht — wie bisher —
 *  Absender, Betreff und die ersten 4000 Zeichen Text, dazu die interne
 *  Auftragsliste (Nummer, Titel, Kunde, Location, Datum). Automatisch
 *  zugeordnet wird nur bei «eindeutig»; sonst bleiben Vorschlaege.
 *  Faellt Claude aus (Limit, Fehler), kommt { jobId: null, [] } zurueck. */
export async function kiZuordnung(
  mail: { von: string; betreff: string; text: string },
  kandidaten: VorschlagKandidat[],
): Promise<{ jobId: string | null; vorschlaege: Vorschlag[] }> {
  if (!aiAvailable() || kandidaten.length === 0) return { jobId: null, vorschlaege: [] };
  const ids = new Set(kandidaten.map((k) => k.id));
  const liste = kandidaten
    .map((k) => {
      const datum = k.start_date ? (k.end_date && k.end_date !== k.start_date ? `${k.start_date} bis ${k.end_date}` : k.start_date) : "?";
      return `${k.id} | INT-${k.job_number} | ${k.title ?? ""} | Kunde: ${k.kunde ?? "?"} (${k.kunde_email ?? "-"}) | Location: ${k.location ?? "-"}${k.raum ? ` / ${k.raum}` : ""} | ${datum}`;
    })
    .join("\n");
  try {
    const erg = await structuredCall<KiAntwort>({
      system:
        "Du ordnest eine E-Mail einem laufenden Veranstaltungstechnik-Auftrag von EVENTLINE (Basel) zu. " +
        "Die Mail wurde meist von einem EVENTLINE-Mitarbeiter weitergeleitet — der eigentliche Kunde steht dann im Text (weitergeleiteter Verlauf). " +
        "Vergleiche: Datum des Anlasses im Betreff/Text mit dem Auftragsdatum, Location/Raum, Kunde (Name, Mail-Domain), Eventname/Titel. " +
        "sicherheit = 'eindeutig' NUR wenn genau ein Auftrag passt und mindestens zwei unabhaengige Merkmale uebereinstimmen (z. B. Datum + Location oder Kunde + Eventname); dann job_id setzen. " +
        "Sonst 'wahrscheinlich' oder 'unklar' und job_id null. Falsche Zuordnung ist schlimmer als keine. " +
        "kandidaten: bis zu 3 plausible Auftraege (beste zuerst) mit kurzem deutschem Grund (z. B. 'Datum 18.12. + Stadtcasino'); leer, wenn keiner plausibel ist.",
      content: [
        {
          type: "text",
          text: `AUFTRAEGE (id | nummer | titel | kunde | location | datum):\n${liste}\n\nMAIL:\nVon: ${mail.von}\nBetreff: ${mail.betreff}\n\n${mail.text.slice(0, 4000)}`,
        },
      ],
      toolName: "zuordnung",
      toolDescription: "Meldet die Zuordnung der Mail zu einem Auftrag.",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["sicherheit", "job_id", "kandidaten"],
        properties: {
          sicherheit: { type: "string", enum: ["eindeutig", "wahrscheinlich", "unklar"] },
          job_id: { type: ["string", "null"], description: "id aus der Liste (nur bei eindeutig) oder null" },
          kandidaten: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["job_id", "grund"],
              properties: {
                job_id: { type: "string", description: "id aus der Liste" },
                grund: { type: "string", description: "kurzer Grund, max. 80 Zeichen" },
              },
            },
          },
        },
      },
      maxTokens: 800,
    });
    const vorschlaege: Vorschlag[] = (erg.kandidaten ?? [])
      .filter((k) => ids.has(k.job_id))
      .slice(0, 3)
      .map((k) => ({ job_id: k.job_id, grund: String(k.grund ?? "").slice(0, 120), quelle: "ki" as const }));
    const jobId = erg.sicherheit === "eindeutig" && erg.job_id && ids.has(erg.job_id) ? erg.job_id : null;
    return { jobId, vorschlaege };
  } catch {
    // structuredCall loggt Sperren (Limit/Zugang) selbst — Zuordnung faellt
    // auf Verlauf/Abgleich/Warten zurueck, die Mail geht nicht verloren.
    return { jobId: null, vorschlaege: [] };
  }
}

/** Deterministische Vorschlaege (ohne KI). */
export function abgleich(mail: { betreff: string; text: string }, kandidaten: VorschlagKandidat[]): Vorschlag[] {
  return abgleichVorschlaege(mail, kandidaten, todayLocalIso());
}

// ── Ablegen im Auftrag ──────────────────────────────────────────

// Anthropic-Vision akzeptiert nur diese Bild-Typen.
const VISION_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Signatur-Grafiken (Logos, Banner, Icons) gehoeren NICHT in den Auftrag.
 *  Die KI schaut das Bild kurz an; wenn sie nicht kann (kein Key, Zeitbudget
 *  aufgebraucht, Fehler, exotischer Typ), gilt die Fallback-Regel: nur ECHTE
 *  Anhaenge behalten (content_disposition 'attachment'), eingebettete
 *  Inline-Bilder verwerfen. */
async function bildBehalten(opts: { disposition: string | null; mediaType: string; bin: ArrayBuffer; zeitOk: boolean }): Promise<boolean> {
  const { disposition, mediaType, bin, zeitOk } = opts;
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

/** Legt Text + Anhaenge einer Mail im Eingang des Auftrags ab (Anhaenge
 *  zusaetzlich als Dokument). Gibt die neuen Eingang-Element-IDs zurueck.
 *  Wirft, wenn schon der Text nicht gespeichert werden kann. */
export async function legeImAuftragAb(opts: {
  admin: SupabaseClient;
  jobId: string;
  resendEmailId: string;
  von: string;
  betreff: string;
  text: string;
  anhaenge: MailAnhang[];
  startZeit: number;
}): Promise<string[]> {
  const { admin, jobId, resendEmailId, von, betreff, text, anhaenge, startZeit } = opts;
  const itemIds: string[] = [];
  const inhalt = `Von: ${von}\nBetreff: ${betreff || "(kein Betreff)"}\n\n${text}`.slice(0, 50000);
  const { data: textItem, error: insErr } = await admin
    .from("job_inbox_items")
    .insert({ job_id: jobId, kind: "text", content: inhalt, absender: von, created_by: null, resend_email_id: resendEmailId })
    .select("id")
    .single();
  if (insErr || !textItem) throw new Error("Eingang-Insert fehlgeschlagen" + (insErr ? `: ${insErr.message}` : ""));
  itemIds.push(textItem.id);

  // Duplikat-Schutz: dieselbe Datei (Inhalt-Hash) wird pro Auftrag nur
  // EINMAL abgelegt — innerhalb der Mail (Outlook haengt eingebettete
  // Bilder doppelt an) UND ueber Mails hinweg (Weiterleitungs-Ketten
  // bringen die gleichen JPEGs/PDFs mit jeder Mail erneut mit).
  const hashes = new Set<string>();
  for (const a of anhaenge) {
    try {
      const hash = createHash("sha1").update(Buffer.from(a.bin)).digest("hex");
      if (hashes.has(hash)) continue;
      hashes.add(hash);
      const { data: schonDa } = await admin.from("job_inbox_items").select("id").eq("job_id", jobId).eq("inhalt_hash", hash).limit(1);
      if (schonDa?.length) continue;
      if (a.mime.startsWith("image/")) {
        const behalten = await bildBehalten({ disposition: a.disposition, mediaType: a.mime, bin: a.bin, zeitOk: Date.now() - startZeit < 200_000 });
        if (!behalten) continue;
      }
      const safe = a.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const path = `auftraege/${jobId}/eingang/mail_${Date.now()}_${safe}`;
      const { error: upErr } = await admin.storage.from("documents").upload(path, Buffer.from(a.bin), { contentType: a.mime });
      if (upErr) {
        logError("auftrag-mail.anhang_upload", upErr.message);
        continue;
      }
      const { data: fileItem } = await admin
        .from("job_inbox_items")
        .insert({ job_id: jobId, kind: "datei", file_path: path, file_name: a.name, mime_type: a.mime, absender: von, created_by: null, resend_email_id: resendEmailId, inhalt_hash: hash })
        .select("id")
        .single();
      if (fileItem) itemIds.push(fileItem.id);
      // Zusaetzlich als Dokument am Auftrag registrieren (gleiche Storage-
      // Datei, zweite Referenz) — Anhaenge gehoeren in den Dokumente-Tab.
      await admin.from("documents").insert({ name: a.name, storage_path: path, file_size: a.bin.byteLength, mime_type: a.mime, job_id: jobId, uploaded_by: null });
    } catch (e) {
      logError("auftrag-mail.anhang_ablegen", e);
    }
  }
  return itemIds;
}

/** KI-Verarbeitung der Elemente (sequentiell — die Zusammenfassung baut
 *  aufeinander auf). Zeitbudget: Vercel killt die Funktion hart bei
 *  maxDuration; kontrolliert abbrechen ist sauber — der Rest verarbeitet
 *  sich beim naechsten Oeffnen des Eingang-Tabs. */
export async function verarbeiteElemente(admin: SupabaseClient, jobId: string, itemIds: string[], startZeit: number): Promise<number> {
  if (!aiAvailable()) return 0;
  let n = 0;
  for (const itemId of itemIds) {
    if (Date.now() - startZeit > 220_000) break;
    try {
      await verarbeiteEingangItem({ admin, jobId, itemId, actorUserId: null });
      n++;
    } catch {
      /* Element steht auf 'fehler' — Retry-Knopf in der App */
    }
  }
  return n;
}

// ── Wartende Mails ───────────────────────────────────────────────

/** Anhaenge einer wartenden Mail in den privaten Bucket legen. */
export async function speichereWarteAnhaenge(admin: SupabaseClient, mailId: string, anhaenge: MailAnhang[]): Promise<WarteAnhang[]> {
  const out: WarteAnhang[] = [];
  for (let i = 0; i < anhaenge.length; i++) {
    const a = anhaenge[i];
    const pfad = `${mailId}/${i}_${a.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const { error } = await admin.storage.from(WARTE_BUCKET).upload(pfad, Buffer.from(a.bin), { contentType: a.mime, upsert: true });
    if (error) {
      logError("auftrag-mail.warte_upload", error.message);
      continue;
    }
    out.push({ name: a.name, mime: a.mime, disposition: a.disposition, pfad, groesse: a.bin.byteLength });
  }
  return out;
}

/** Gespeicherte Anhaenge einer wartenden Mail wieder laden. */
export async function ladeWarteAnhaenge(admin: SupabaseClient, anhaenge: WarteAnhang[]): Promise<MailAnhang[]> {
  const out: MailAnhang[] = [];
  for (const a of anhaenge) {
    const { data, error } = await admin.storage.from(WARTE_BUCKET).download(a.pfad);
    if (error || !data) throw new Error(`Anhang «${a.name}» nicht lesbar`);
    out.push({ name: a.name, mime: a.mime, disposition: a.disposition, bin: await data.arrayBuffer() });
  }
  return out;
}

export async function loescheWarteAnhaenge(admin: SupabaseClient, anhaenge: WarteAnhang[]): Promise<void> {
  if (!anhaenge.length) return;
  const { error } = await admin.storage.from(WARTE_BUCKET).remove(anhaenge.map((a) => a.pfad));
  if (error) logError("auftrag-mail.warte_loeschen", error.message);
}
