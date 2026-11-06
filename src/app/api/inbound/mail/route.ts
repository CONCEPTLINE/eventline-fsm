// POST /api/inbound/mail — Resend-Webhook (email.received) fuer die
// Auftrags-Mailadresse auftrag@in.eventline-basel.com: weitergeleitete
// Kunden-Mails landen automatisch im Eingang des passenden Auftrags und
// werden sofort von der KI verarbeitet. (ablage@… ist seit 01.11.2026 in
// Trust flow: ablage@in.trust-group.ch — hier nur noch ein Hinweis an die Admins.)
//
// Ablauf (Kern in src/lib/auftrag-mail/ablauf.ts):
//  1. Svix-Signatur pruefen (RESEND_WEBHOOK_SECRET, whsec_…) — sonst 401.
//  2. Mail-Inhalt + Header via Resend-API nachladen (Webhook = Metadaten).
//  3. Sperre in auftrag_mails (UNIQUE resend_email_id): Wiederholungen
//     desselben Webhooks erzeugen weder Elemente noch Mitteilungen doppelt.
//  4. Zuordnen: Auftragsnummer → Mailverlauf (In-Reply-To/References,
//     Outlook-Thread-Index, sonst aussagekraeftiger Betreff) → KI (nur
//     eindeutig) → sonst WARTET die Mail mit Inhalt + Anhaengen unter
//     /auftraege/mails, ein Admin waehlt den Auftrag (mit Vorschlaegen).
//  5. Abgelegt: Text + PDF-/Bild-Anhaenge als Eingang-Elemente, dann
//     verarbeiteEingangItem() pro Element (gleiche Logik wie in der App).
//
// Immer 200 fuer verarbeitete/wartende/doppelte Mails (Resend soll nicht
// endlos wiederholen); 401/500 nur bei Signatur-/Infrastrukturfehler —
// dann ist die Sperre geloest und die Wiederholung arbeitet neu.

import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { notifySystem } from "@/lib/notification-service";
import { recipientsWithPermission } from "@/lib/notification-recipients";
import { logError } from "@/lib/log";
import { ordneMailZu, type Zuordnung } from "@/lib/auftrag-mail/ablauf";
import { auftragsNummernAus, mailMerkmale } from "@/lib/auftrag-mail/verlauf";
import { ablaufMailWirkung, neuerAuftragAusMail, verwerfeNeuenAblaufAuftrag } from "@/lib/ablauf/server";
import {
  abgleich,
  adressen,
  findeVerlauf,
  kiZuordnung,
  ladeAnhaenge,
  ladeKandidaten,
  legeImAuftragAb,
  mailText,
  speichereWarteAnhaenge,
  verarbeiteElemente,
  type MailAnhang,
  type ResendMail,
} from "@/lib/auftrag-mail/server";

export const maxDuration = 300;

/** Nach so langer Zeit gilt eine Sperre 'eingang' als verwaist (Funktion
 *  wurde hart beendet) — eine Wiederholung darf dann uebernehmen. */
const SPERRE_VERWAIST_MS = 10 * 60_000;

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

const VIA_TEXT: Record<Zuordnung, string> = {
  nummer: "",
  verlauf: " · erkannt am Mailverlauf",
  ki: " · von der KI zugeordnet",
  ablauf: " · neuer Auftrag aus der Mietanfrage angelegt",
};

/** Neue Adresse der Ablage (Trust flow, eigener Mail-Eingang seit 01.11.2026). */
const ABLAGE_ADRESSE_NEU = "ablage@in.trust-group.ch";

/** Mail an die alte Ablage-Adresse: nichts weiterleiten (trust one nimmt nichts mehr an), aber auch nicht still
 *  verlieren — die Admins bekommen eine Mitteilung (Typ «system») mit Absender, Betreff und der neuen Adresse. Keine
 *  automatische Antwort an den Absender (Schleifen mit Abwesenheits-Antworten). Scheitert die Meldung, wirft sie:
 *  der Webhook antwortet dann 500 und Resend wiederholt. */
async function meldeAlteAblageAdresse(
  admin: ReturnType<typeof createAdminClient>,
  absender: string,
  betreff: string,
  anhaenge: number,
): Promise<void> {
  const { data, error } = await admin.from("profiles").select("id").eq("role", "admin").eq("is_active", true);
  if (error) throw new Error(error.message);
  const recipients = ((data ?? []) as { id: string }[]).map((p) => p.id);
  if (!recipients.length) return;
  await notifySystem(admin, {
    recipients,
    title: "Mail an die alte Ablage-Adresse",
    message: `Von ${absender} · «${betreff || "(kein Betreff)"}»${anhaenge ? ` · ${anhaenge} Anhang/Anhänge` : ""} — nicht abgelegt. `
      + `Die Ablage ist in Trust flow: bitte an ${ABLAGE_ADRESSE_NEU} weiterleiten bzw. den Absender auf die neue Adresse hinweisen.`,
    link: null,
  });
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
  const emailId = event.data.email_id;

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) return NextResponse.json({ error: "Resend-Key fehlt" }, { status: 503 });

  // Idempotenz, frueher Ausstieg: Resend wiederholt Webhooks bei Timeouts
  // (Vorfall: 3x identische Mails in INT-26309). Alt-Mails vor Migration
  // 349 erkennt job_inbox_items, neue die Zeile in auftrag_mails.
  const admin = createAdminClient();
  const [{ data: schonDa }, { data: schonBekannt }] = await Promise.all([
    admin.from("job_inbox_items").select("id").eq("resend_email_id", emailId).limit(1).maybeSingle(),
    admin.from("auftrag_mails").select("id, status, updated_at").eq("resend_email_id", emailId).maybeSingle(),
  ]);
  const bekannt = schonBekannt as { id: string; status: string; updated_at: string } | null;
  if (
    schonDa ||
    (bekannt && (bekannt.status !== "eingang" || Date.now() - new Date(bekannt.updated_at).getTime() < SPERRE_VERWAIST_MS))
  ) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  // ── Vollstaendige Mail nachladen ───────────────────────────────
  const mailRes = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
    headers: { Authorization: `Bearer ${resendKey}` },
  });
  if (!mailRes.ok) {
    return NextResponse.json({ error: "Mail nicht abrufbar: HTTP " + mailRes.status }, { status: 500 });
  }
  const mail = (await mailRes.json()) as ResendMail & { created_at?: string };
  const subject = mail.subject ?? "";
  const text = mailText(mail);

  // ── Alte Ablage-Adresse (ablage@…) ─────────────────────────────
  // Die Ablage lebt seit 01.11.2026 in Trust flow mit eigenem Mail-Eingang (ablage@in.trust-group.ch); trust one nimmt
  // nichts mehr an. Kein Auftrag-Matching, keine KI, keine Weiterleitung — nur ein Hinweis an die Admins, damit nichts
  // still verloren geht.
  const empfaengerListe = ([] as string[]).concat(mail.to ?? []);
  if (empfaengerListe.some((t) => String(t).toLowerCase().includes("ablage@"))) {
    const anhaenge = (mail.attachments ?? []).filter((a) => a.content_disposition !== "inline").length;
    try {
      await meldeAlteAblageAdresse(admin, mail.from, subject, anhaenge);
    } catch (e) {
      logError("inbound.ablage.alt", e, { emailId });
      return NextResponse.json({ error: "Hinweis an die Admins fehlgeschlagen" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, ablage: "umgezogen" });
  }

  // ── Auftrags-Mail ──────────────────────────────────────────────
  const startZeit = Date.now();
  const merkmale = mailMerkmale(mail);
  const absender = mail.from;
  let anhaengeCache: MailAnhang[] | null = null;
  const anhaenge = async () => (anhaengeCache ??= await ladeAnhaenge(emailId, resendKey, mail));
  const empfaenger = () => recipientsWithPermission(admin, "auftraege:see-all");
  // Vermietungs-Ablauf (docs/barakuba/VERTRAG-ABLAUF.md): Empfaenger + Anhang-Namen fuer die Einordnung.
  const an = adressen(mail.to);
  const cc = adressen(mail.cc);
  const echteAnhaenge = (mail.attachments ?? []).filter((a) => a.content_disposition !== "inline");
  const ablaufMail = {
    von: absender,
    an,
    cc,
    betreff: subject,
    text,
    anhangNamen: echteAnhaenge.map((a) => a.filename ?? "anhang").slice(0, 20),
  };

  try {
    const erg = await ordneMailZu({
      async beanspruchen() {
        const zeile = {
          resend_email_id: emailId,
          status: "eingang",
          absender,
          betreff: subject || null,
          betreff_norm: merkmale.betreffNorm || null,
          message_id: merkmale.messageId,
          referenzen: merkmale.referenzen,
          konversation: merkmale.konversation,
          cc: cc.length ? cc : null,
          empfangen_am: mail.created_at ?? new Date().toISOString(),
        };
        const { data, error } = await admin
          .from("auftrag_mails")
          .upsert(zeile, { onConflict: "resend_email_id", ignoreDuplicates: true })
          .select("id");
        if (error) throw new Error("Sperre: " + error.message);
        if (data?.length) return { id: (data[0] as { id: string }).id };
        // Schon da: nur eine verwaiste Sperre darf uebernommen werden.
        const grenze = new Date(Date.now() - SPERRE_VERWAIST_MS).toISOString();
        const { data: alt } = await admin
          .from("auftrag_mails")
          .update({ updated_at: new Date().toISOString() })
          .eq("resend_email_id", emailId)
          .eq("status", "eingang")
          .lt("updated_at", grenze)
          .select("id");
        return alt?.length ? { id: (alt[0] as { id: string }).id } : null;
      },
      async freigeben(id) {
        await admin.from("auftrag_mails").delete().eq("id", id).eq("status", "eingang");
      },
      async nummerJob() {
        const nummern = auftragsNummernAus(`${subject}\n${text}`);
        if (!nummern.length) return null;
        const { data } = await admin.from("jobs").select("id, job_number").in("job_number", nummern).not("is_deleted", "is", true);
        const byNr = new Map(((data ?? []) as { id: string; job_number: number }[]).map((j) => [j.job_number, j.id]));
        for (const nr of nummern) {
          const hit = byNr.get(nr);
          if (hit) return hit;
        }
        return null;
      },
      verlauf: () => findeVerlauf(admin, merkmale),
      kandidaten: () => ladeKandidaten(admin),
      ki: (k) => kiZuordnung({ von: absender, betreff: subject, text }, k),
      abgleich: (k) => abgleich({ betreff: subject, text }, k),
      async ablegen(jobId) {
        return legeImAuftragAb({ admin, jobId, resendEmailId: emailId, von: absender, betreff: subject, text, anhaenge: await anhaenge(), startZeit });
      },
      async markiereZugeordnet(id, jobId, via) {
        const { error } = await admin
          .from("auftrag_mails")
          .update({ status: "zugeordnet", job_id: jobId, zuordnung: via, updated_at: new Date().toISOString() })
          .eq("id", id);
        if (error) logError("auftrag-mail.markieren", error.message);
      },
      async speichereWartend(id, vorschlaege) {
        const gespeichert = await speichereWarteAnhaenge(admin, id, await anhaenge());
        const { error } = await admin
          .from("auftrag_mails")
          .update({
            status: "wartet",
            inhalt: text.slice(0, 50000),
            anhaenge: gespeichert,
            vorschlaege,
            updated_at: new Date().toISOString(),
          })
          .eq("id", id);
        if (error) throw new Error("Wartend speichern: " + error.message);
      },
      async meldeAbgelegt(jobId, via) {
        // Transparenz: Admins erfahren IMMER, wohin eine Mail gelegt wurde
        // (Vorfall Fw:Offerte → INT-26309, Leo suchte vergeblich).
        const [{ data: zielJob }, recipients] = await Promise.all([
          admin.from("jobs").select("job_number, title").eq("id", jobId).maybeSingle(),
          empfaenger(),
        ]);
        if (!recipients.length) return;
        await notifySystem(admin, {
          recipients,
          title: `Auftrags-Mail abgelegt: INT-${zielJob?.job_number ?? "?"}`,
          message: `Von ${absender} · «${subject || "(kein Betreff)"}» → ${zielJob?.title ?? ""} (Eingang)${VIA_TEXT[via]}`,
          link: `/auftraege/${jobId}?tab=eingang`,
        });
      },
      async meldeWartet(vorschlaege) {
        const recipients = await empfaenger();
        if (!recipients.length) return;
        let tipp = "";
        if (vorschlaege[0]) {
          const { data: j } = await admin.from("jobs").select("job_number").eq("id", vorschlaege[0].job_id).maybeSingle();
          if (j?.job_number) tipp = ` Wahrscheinlich INT-${j.job_number}.`;
        }
        await notifySystem(admin, {
          recipients,
          title: "Mail wartet auf Zuordnung",
          message: `Von ${absender} · «${subject || "(kein Betreff)"}» — bitte den Auftrag wählen.${tipp}`,
          link: "/auftraege/mails",
        });
      },
      verarbeiten: (jobId, itemIds) => verarbeiteElemente(admin, jobId, itemIds, startZeit),
      // Vermietungs-Ablauf — beide werfen nie; ohne Partner-Location/Ablauf keine KI, Verhalten wie bisher.
      neuerAuftrag: (mailId) => neuerAuftragAusMail(admin, { auftragMailId: mailId, mail: ablaufMail, anhaenge }),
      async verwerfeNeuenAuftrag(jobId) {
        await verwerfeNeuenAblaufAuftrag(admin, jobId, "Ablegen gescheitert");
      },
      async nachZuordnung(jobId, mailId, via) {
        if (via === "ablauf") return; // gerade aus dieser Mail angelegt
        await ablaufMailWirkung(admin, { jobId, auftragMailId: mailId, resendEmailId: emailId, mail: ablaufMail, anhangAnzahl: echteAnhaenge.length });
      },
    });

    if (erg.ergebnis === "doppelt") return NextResponse.json({ ok: true, duplicate: true });
    if (erg.ergebnis === "wartet") return NextResponse.json({ ok: true, matched: false, wartet: true });
    return NextResponse.json({ ok: true, matched: true, via: erg.via, items: erg.items, verarbeitet: erg.verarbeitet });
  } catch (e) {
    logError("auftrag-mail.webhook", e);
    return NextResponse.json({ error: "Mail konnte nicht verarbeitet werden" }, { status: 500 });
  }
}
