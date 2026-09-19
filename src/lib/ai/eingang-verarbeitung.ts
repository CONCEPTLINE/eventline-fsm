// Kern der Auftrag-Eingang-Verarbeitung — von ZWEI Aufrufern genutzt:
//  - /api/ai/eingang (User legt Element in der App ab; Auth + Sichtbarkeit
//    prueft die Route vorher unter USER-RLS)
//  - /api/inbound/mail (weitergeleitete Mail via Resend-Webhook; kein User)
// Laeuft komplett auf dem Admin-Client. Wirft bei Fehlern (nachdem das
// Element auf ai_status='fehler' gesetzt wurde) — der Aufrufer entscheidet
// ueber die Antwort.

import type { SupabaseClient } from "@supabase/supabase-js";
import type Anthropic from "@anthropic-ai/sdk";
import { structuredCall } from "@/lib/ai/anthropic";

// Supabase-Join kommt je nach Kardinalitaet als Objekt ODER Array zurueck.
function relName(v: unknown): string | null {
  const o = Array.isArray(v) ? v[0] : v;
  return o && typeof o === "object" && "name" in o ? String((o as { name: unknown }).name) : null;
}

export type DatumVorschlag = { start_datum: string; end_datum: string; grund: string };

type Ergebnis = {
  zusammenfassung: string;
  neue_zusagen: { text: string; mit_wem: string | null }[];
  erledigte_zusagen_ids: string[];
  hinfaellige_zusagen_ids: string[];
  datum_aenderung: { start_datum: string; end_datum: string | null; grund: string } | null;
};

const ERGEBNIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["zusammenfassung", "neue_zusagen", "erledigte_zusagen_ids", "hinfaellige_zusagen_ids", "datum_aenderung"],
  properties: {
    zusammenfassung: {
      type: "string",
      description:
        "KURZFASSUNG im Telegrammstil — der Leser muss in ZWEI BLICKEN erfassen, was Sache ist. " +
        "ZWINGEND: Zeile '=== OPERATIV ===' (Durchführung), dann Zeile '=== ADMINISTRATIV ===' (Geschäftliches). " +
        "Pro Kachel MAXIMAL 6 Stichpunkte, jeder genau EINE Zeile im Format '- Schlagwort: Kernaussage'. " +
        "Die Kernaussage ist ein KLARER, verständlicher Satz für jemanden, der den Vorgang nicht kennt — kurz, aber kein kryptisches Fragment. " +
        "Abkürzungen und Fachjargon aus Mails NIE unerklärt übernehmen: ausschreiben oder in Klammern erklären (z.B. 'Tech' → 'technische Probe', 'Get-in' → 'Zugang zur Location'). " +
        "Fremdsprachige Eingänge ins Deutsche übertragen. Zahlen und Fakten NUR, wenn sie wörtlich im Eingang stehen — nichts errechnen, nichts schätzen. " +
        "Wichtigstes zuoberst: aktueller Stand und was zu tun ist. Offene/zu klärende Punkte als '- OFFEN: …' — " +
        "IMMER als vollständiger, selbsterklärender Auftrag formuliert (was ist zu tun/zu klären, ggf. mit wem und bis wann), " +
        "z.B. '- OFFEN: Frau Pappenberger antworten, ob die Offerte für beide Lieferszenarien gilt' — NIE nur ein Stichwort. " +
        "KEINE Abschnitts-Titel, KEINE Detail-Aufzählungen (Stückzahlen-Listen etc. bündeln — Details bleiben im Eingang abrufbar). " +
        "Deutsch, nichts erfinden. Leere Kachel: Marker-Zeile trotzdem schreiben.",
    },
    datum_aenderung: {
      type: ["object", "null"],
      additionalProperties: false,
      required: ["start_datum", "end_datum", "grund"],
      description:
        "NUR wenn der neue Eingang EINDEUTIG ein neues/verschobenes Event-Datum fuer DIESEN Auftrag nennt — sonst null.",
      properties: {
        start_datum: { type: "string", description: "Neues Event-Startdatum als YYYY-MM-DD." },
        end_datum: { type: ["string", "null"], description: "Neues Enddatum als YYYY-MM-DD, null = gleich wie Start." },
        grund: { type: "string", description: "Ein Satz: woraus sich das neue Datum ergibt." },
      },
    },
    neue_zusagen: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "mit_wem"],
        properties: {
          text: { type: "string", description: "Die verbindliche Zusage, ein praegnanter Satz." },
          mit_wem: { type: ["string", "null"], description: "Ansprechperson beim Kunden, falls erkennbar." },
        },
      },
    },
    erledigte_zusagen_ids: { type: "array", items: { type: "string" } },
    hinfaellige_zusagen_ids: { type: "array", items: { type: "string" } },
  },
};

export async function verarbeiteEingangItem(opts: {
  admin: SupabaseClient;
  jobId: string;
  itemId: string;
  /** App-User der das Element abgelegt hat; null bei Mail-Eingang. */
  actorUserId: string | null;
}): Promise<{ neueZusagen: number; datumVorschlag: DatumVorschlag | null }> {
  const { admin, jobId, itemId, actorUserId } = opts;

  const { data: job } = await admin
    .from("jobs")
    .select("id, title, job_number, start_date, end_date, description, ai_summary, customer:customers(name), location:locations(name)")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) throw new Error("Auftrag nicht gefunden");

  const { data: item } = await admin
    .from("job_inbox_items")
    .select("id, job_id, kind, content, file_path, file_name, mime_type, absender")
    .eq("id", itemId)
    .eq("job_id", jobId)
    .maybeSingle();
  if (!item) throw new Error("Eingang-Element nicht gefunden");

  const { data: zusagen } = await admin
    .from("job_zusagen")
    .select("id, text, status, mit_wem")
    .eq("job_id", jobId)
    .order("created_at", { ascending: true });

  // ── KI-Kontext bauen ─────────────────────────────────────────
  const content: Anthropic.ContentBlockParam[] = [];
  const kontext = [
    `AUFTRAG ${job.job_number ?? ""}: ${job.title}`,
    relName(job.customer) ? `Kunde: ${relName(job.customer)}` : null,
    relName(job.location) ? `Ort: ${relName(job.location)}` : null,
    job.start_date ? `Zeitraum: ${job.start_date} bis ${job.end_date ?? "?"}` : null,
    job.description ? `Beschreibung: ${job.description}` : null,
    job.ai_summary ? `\nBISHERIGE ZUSAMMENFASSUNG:\n${job.ai_summary}` : null,
    zusagen?.length
      ? `\nBESTEHENDE ZUSAGEN (id | status | text):\n` +
        zusagen.map((z) => `${z.id} | ${z.status} | ${z.text}${z.mit_wem ? ` (mit ${z.mit_wem})` : ""}`).join("\n")
      : "\nBisher keine Zusagen erfasst.",
  ].filter(Boolean).join("\n");
  content.push({ type: "text", text: kontext });

  const herkunft = item.absender ? ` (per Mail von ${item.absender})` : "";
  if (item.kind === "text" && item.content) {
    content.push({ type: "text", text: `\nNEUER EINGANG (Text${herkunft}):\n${item.content}` });
  } else if (item.kind === "datei" && item.file_path) {
    const { data: signed } = await admin.storage.from("documents").createSignedUrl(item.file_path, 600);
    const mime = item.mime_type ?? "";
    if (signed?.signedUrl && mime.startsWith("image/")) {
      content.push({ type: "text", text: `\nNEUER EINGANG (Bild "${item.file_name}"${herkunft}):` });
      content.push({ type: "image", source: { type: "url", url: signed.signedUrl } });
    } else if (signed?.signedUrl && mime === "application/pdf") {
      content.push({ type: "text", text: `\nNEUER EINGANG (PDF "${item.file_name}"${herkunft}):` });
      content.push({ type: "document", source: { type: "url", url: signed.signedUrl } });
    } else {
      content.push({ type: "text", text: `\nNEUER EINGANG: Datei "${item.file_name}" (${mime || "unbekannter Typ"}) — Inhalt nicht lesbar, nur zur Kenntnis.` });
    }
  }

  try {
    const ergebnis = await structuredCall<Ergebnis>({
      system:
        "Du bist das Gedächtnis eines Veranstaltungstechnik-Auftrags der Firma EVENTLINE (Basel). " +
        "Du erhältst den Auftragskontext, die bisherige Zusammenfassung, die bestehenden Zusagen und EIN neues Eingang-Element " +
        "(diktierte Notiz, weitergeleitete Kunden-Mail, Screenshot, Foto oder PDF). " +
        "Aufgaben: (1) Zusammenfassung aktualisieren — strukturiert nach Schema-Vorgabe (Abschnitte in GROSSBUCHSTABEN + '- '-Stichpunkte), sachlich, nichts erfinden. " +
        "(2) NEUE verbindliche Zusagen an den Kunden extrahieren (nur echte Abmachungen, keine Vermutungen; keine Duplikate zu bestehenden — auch Formulierungs-Varianten derselben Sache sind Duplikate). " +
        "(3) Bestehende Zusagen, die laut neuem Eingang erfüllt sind, als erledigt melden; widerrufene/ersetzte als hinfällig. " +
        "(4) Schlage in datum_aenderung ein neues Event-Datum vor, wenn (a) der Eingang eine Verschiebung DIESES Auftrags nennt, ODER " +
        "(b) das bisherige Event-Datum wegfällt (Absage, Eigenregie, keine Unterstützung nötig) UND ein konkreter nächster Termin genannt wird, " +
        "auf den der Auftrag sinnvoll weiterlaufen könnte — der grund muss die Lage ehrlich beschreiben (z.B. 'bisheriges Datum entfällt; nächstes Konzert am …'). " +
        "Das Team wird IMMER GEFRAGT, bevor umdatiert wird — im Zweifel also vorschlagen. Nur bei beiläufiger Terminerwähnung ohne Bezug: null. " +
        "IDs exakt aus der Liste übernehmen. Im Zweifel lieber weniger ändern.",
      content,
      toolName: "ergebnis_speichern",
      toolDescription: "Speichert Zusammenfassung und Zusagen-Änderungen für den Auftrag.",
      schema: ERGEBNIS_SCHEMA,
    });

    const bekannteIds = new Set((zusagen ?? []).map((z) => z.id));
    const now = new Date().toISOString();

    await admin.from("jobs").update({ ai_summary: ergebnis.zusammenfassung }).eq("id", jobId);
    // Idempotente WIEDERverarbeitung: offene KI-Zusagen aus DIESEM Element
    // ersetzen statt ergaenzen (sonst Duplikat-Varianten bei jedem Retry).
    await admin
      .from("job_zusagen")
      .delete()
      .eq("job_id", jobId)
      .eq("quelle_item_id", itemId)
      .eq("created_via", "ki")
      .eq("status", "offen");
    if (ergebnis.neue_zusagen.length) {
      await admin.from("job_zusagen").insert(
        ergebnis.neue_zusagen.map((z) => ({
          job_id: jobId,
          text: z.text,
          mit_wem: z.mit_wem,
          quelle_item_id: itemId,
          created_via: "ki",
          created_by: actorUserId,
        })),
      );
    }
    for (const [ids, status] of [
      [ergebnis.erledigte_zusagen_ids, "erledigt"],
      [ergebnis.hinfaellige_zusagen_ids, "hinfaellig"],
    ] as const) {
      const valid = ids.filter((id) => bekannteIds.has(id));
      if (valid.length) {
        await admin.from("job_zusagen").update({ status, updated_at: now }).in("id", valid).eq("job_id", jobId);
      }
    }

    // Neues Event-Datum wird NIE direkt gesetzt — nur als persistenter
    // Vorschlag am Auftrag (Banner auf der Uebersicht, bis Entscheidung).
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const v = ergebnis.datum_aenderung;
    const datumVorschlag: DatumVorschlag | null = v && DATE_RE.test(v.start_datum)
      ? {
          start_datum: v.start_datum,
          end_datum: v.end_datum && DATE_RE.test(v.end_datum) ? v.end_datum : v.start_datum,
          grund: v.grund,
        }
      : null;
    if (datumVorschlag) {
      await admin
        .from("jobs")
        .update({ ai_datum_vorschlag: { ...datumVorschlag, item_id: itemId, created_at: new Date().toISOString() } })
        .eq("id", jobId);
    }

    await admin.from("job_inbox_items").update({ ai_status: "verarbeitet", ai_error: null }).eq("id", itemId);

    return { neueZusagen: ergebnis.neue_zusagen.length, datumVorschlag };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "KI-Verarbeitung fehlgeschlagen";
    await admin.from("job_inbox_items").update({ ai_status: "fehler", ai_error: msg }).eq("id", itemId);
    throw new Error(msg);
  }
}
