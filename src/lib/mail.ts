// Zentraler Mail-Versand — Skalierbarkeits-Audit 2026-09-23.
//
// Vorher baute jede Route ihren eigenen Resend-Client + HTML-Wrapper
// (dieselben ~15 Zeilen zwoelffach kopiert). Hier lebt das einmal:
//
//   sendMail({ to, subject, html, ... })  — EIN Versand-Helfer.
//     Kein RESEND_API_KEY -> { ok:false, skipped:true } statt werfen
//     (heutiges Verhalten der Routen: Key pruefen, still ueberspringen).
//     Default-Absender: formatMailFrom(company, "noreply@eventline-basel.com"),
//     wie in allen Standard-Routen — Routen mit eigenem Absender geben
//     ihn als `from` mit.
//   mailRahmen({ titel, inhaltHtml })     — EIN HTML-Rahmen (560px,
//     'Helvetica Neue'-Stack, dunkler Header + weisser Body = der
//     haeufigste Bestand). headerBg optional fuer die bestehenden
//     farbigen Header (rot=dringend, gruen=Erfolg, ...).
//   sendMailBatch(mails, { concurrency }) — Promise.allSettled in Chunks
//     statt serieller for-await-Schleifen (Cron-Timeout-Risiko).
//
// sendMail wirft NIE — Ergebnis immer als { ok, skipped?, error? }.
// Resend-API-Fehler (res.error) zaehlen einheitlich als Fehlschlag.

import type { Resend, Attachment } from "resend";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCompanySettings, formatMailFrom, type CompanySettings } from "@/lib/company-settings";

const DEFAULT_FROM_ADDRESS = "noreply@eventline-basel.com";

export interface SendMailInput {
  to: string | string[];
  subject: string;
  html: string;
  replyTo?: string | string[];
  /** Kompletter Absender-String ("Name <adresse>"). Fehlt er, greift der
   *  Default (formatMailFrom + loadCompanySettings, noreply-Adresse). */
  from?: string;
  cc?: string | string[];
  attachments?: Attachment[];
}

export interface SendMailResult {
  ok: boolean;
  /** true = RESEND_API_KEY fehlt, Versand still uebersprungen. */
  skipped?: boolean;
  error?: unknown;
}

/** true sobald ein RESEND_API_KEY konfiguriert ist — fuer Routen, die vor
 *  dem Aufbau der Mails frueh aussteigen wollen (heutiges Verhalten). */
export function isMailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

// Resend-Client einmalig + lazy (Modul-Load kostet sonst Cold-Start).
let resendClient: Resend | null = null;
async function getResend(): Promise<Resend | null> {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  if (!resendClient) {
    const { Resend } = await import("resend");
    resendClient = new Resend(key);
  }
  return resendClient;
}

// Company-Settings fuer den Default-Absender kurz cachen (60s) — ein Batch
// mit 50 Mails soll nicht 50x dieselbe Singleton-Row laden. Aenderungen am
// Firmennamen greifen nach spaetestens einer Minute.
let companyCache: { value: CompanySettings; loadedAt: number } | null = null;
const COMPANY_TTL_MS = 60_000;
async function defaultFrom(): Promise<string> {
  const now = Date.now();
  if (!companyCache || now - companyCache.loadedAt > COMPANY_TTL_MS) {
    companyCache = { value: await loadCompanySettings(createAdminClient()), loadedAt: now };
  }
  return formatMailFrom(companyCache.value, DEFAULT_FROM_ADDRESS);
}

/** Verschickt EINE Mail via Resend. Wirft nie — Fehler landen in `error`. */
export async function sendMail(input: SendMailInput): Promise<SendMailResult> {
  const resend = await getResend();
  if (!resend) return { ok: false, skipped: true };
  try {
    const from = input.from ?? (await defaultFrom());
    const res = await resend.emails.send({
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      ...(input.cc ? { cc: input.cc } : {}),
      ...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {}),
    });
    if (res.error) return { ok: false, error: res.error };
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Fehlermeldung aus einem sendMail-`error` ziehen (Error ODER Resend-
 *  ErrorResponse) — Routen haengen ihren eigenen Fallback-Text dran. */
export function mailErrorMessage(error: unknown): string | null {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return null;
}

/** Gemeinsamer HTML-Rahmen: 560px, 'Helvetica Neue'-Stack, Header-Balken +
 *  weisser Body mit Rahmen. `inhaltHtml` ist der komplette Body-Inhalt
 *  (inkl. Footer-Zeile der jeweiligen Route). */
export function mailRahmen(opts: { titel: string; inhaltHtml: string; headerBg?: string }): string {
  const bg = opts.headerBg ?? "#1a1a1a";
  return `
    <div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto">
      <div style="background:${bg};padding:20px 24px;border-radius:12px 12px 0 0">
        <h2 style="color:white;margin:0;font-size:16px">${opts.titel}</h2>
      </div>
      <div style="background:white;padding:24px;border:1px solid #e5e5e5;border-top:none;border-radius:0 0 12px 12px">
        ${opts.inhaltHtml}
      </div>
    </div>
  `;
}

/** Batch-Versand: Promise.allSettled in Chunks (default 8 parallel) statt
 *  serieller Schleifen. Extra-Felder auf den Mail-Objekten (Metadaten wie
 *  jobId/userId) bleiben erhalten und kommen in sent/failed zurueck. */
export async function sendMailBatch<T extends SendMailInput>(
  mails: T[],
  opts?: { concurrency?: number },
): Promise<{ sent: T[]; failed: { mail: T; error: unknown }[] }> {
  const concurrency = Math.max(1, opts?.concurrency ?? 8);
  const sent: T[] = [];
  const failed: { mail: T; error: unknown }[] = [];
  for (let i = 0; i < mails.length; i += concurrency) {
    const chunk = mails.slice(i, i + concurrency);
    const results = await Promise.allSettled(chunk.map((m) => sendMail(m)));
    results.forEach((r, idx) => {
      const mail = chunk[idx];
      if (r.status === "fulfilled") {
        if (r.value.ok) sent.push(mail);
        else failed.push({ mail, error: r.value.skipped ? new Error("Kein RESEND_API_KEY") : r.value.error });
      } else {
        failed.push({ mail, error: r.reason });
      }
    });
  }
  return { sent, failed };
}
