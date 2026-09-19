// POST /api/ai/eingang — verarbeitet EIN neues Eingang-Element eines
// Auftrags: KI liest den Inhalt (Text, Bild oder PDF via signed URL),
// aktualisiert jobs.ai_summary und pflegt die Zusagen (neue anlegen,
// bestehende als erledigt/hinfaellig markieren). Quelle wird verlinkt.
//
// Zugriff: eingeloggter Mitarbeiter, der den Auftrag sehen darf (Check
// ueber den USER-scoped Client → jobs-RLS greift); Partner haben auf
// job_inbox_items ohnehin keinen Select (Migration 232).

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireUser } from "@/lib/api-auth";
import { aiAvailable, AI_UNAVAILABLE_MSG, structuredCall } from "@/lib/ai/anthropic";
import type Anthropic from "@anthropic-ai/sdk";

// Supabase-Join kommt je nach Kardinalitaet als Objekt ODER Array zurueck.
function relName(v: unknown): string | null {
  const o = Array.isArray(v) ? v[0] : v;
  return o && typeof o === "object" && "name" in o ? String((o as { name: unknown }).name) : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
        "Aktualisierte Zusammenfassung — STRUKTURIERT, kein Fliesstext: 2-5 kurze Abschnitte. " +
        "Jeder Abschnitt: eine Titelzeile in GROSSBUCHSTABEN (z.B. ANFRAGE, TECHNIK & MATERIAL, PREISE & RABATTE, STAND, OFFENE PUNKTE), " +
        "darunter knappe Stichpunkte, jede Zeile beginnt mit '- '. Deutsch, keine Einleitung, keine Floskeln.",
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

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;
  if (!aiAvailable()) {
    return NextResponse.json({ success: false, error: AI_UNAVAILABLE_MSG }, { status: 503 });
  }

  let body: { job_id?: string; item_id?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Ungültige Anfrage" }, { status: 400 });
  }
  const { job_id, item_id } = body;
  if (!job_id || !item_id || !UUID_RE.test(job_id) || !UUID_RE.test(item_id)) {
    return NextResponse.json({ success: false, error: "Ungültige Anfrage" }, { status: 400 });
  }

  // Sichtbarkeit unter USER-RLS pruefen (kein Datenzugriff ohne Auftragsrecht).
  const supabase = await createClient();
  const { data: job } = await supabase
    .from("jobs")
    .select("id, title, job_number, start_date, end_date, description, ai_summary, customer:customers(name), location:locations(name)")
    .eq("id", job_id)
    .maybeSingle();
  if (!job) return NextResponse.json({ success: false, error: "Auftrag nicht gefunden" }, { status: 404 });

  const admin = createAdminClient();
  const { data: item } = await admin
    .from("job_inbox_items")
    .select("id, job_id, kind, content, file_path, file_name, mime_type")
    .eq("id", item_id)
    .eq("job_id", job_id)
    .maybeSingle();
  if (!item) return NextResponse.json({ success: false, error: "Eingang-Element nicht gefunden" }, { status: 404 });

  const { data: zusagen } = await admin
    .from("job_zusagen")
    .select("id, text, status, mit_wem")
    .eq("job_id", job_id)
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

  if (item.kind === "text" && item.content) {
    content.push({ type: "text", text: `\nNEUER EINGANG (Text):\n${item.content}` });
  } else if (item.kind === "datei" && item.file_path) {
    const { data: signed } = await admin.storage.from("documents").createSignedUrl(item.file_path, 600);
    const mime = item.mime_type ?? "";
    if (signed?.signedUrl && mime.startsWith("image/")) {
      content.push({ type: "text", text: `\nNEUER EINGANG (Bild "${item.file_name}"):` });
      content.push({ type: "image", source: { type: "url", url: signed.signedUrl } });
    } else if (signed?.signedUrl && mime === "application/pdf") {
      content.push({ type: "text", text: `\nNEUER EINGANG (PDF "${item.file_name}"):` });
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
        "(2) NEUE verbindliche Zusagen an den Kunden extrahieren (nur echte Abmachungen, keine Vermutungen; keine Duplikate zu bestehenden). " +
        "(3) Bestehende Zusagen, die laut neuem Eingang erfüllt sind, als erledigt melden; widerrufene/ersetzte als hinfällig. " +
        "(4) Nennt der Eingang EINDEUTIG ein neues oder verschobenes Event-Datum für DIESEN Auftrag (z.B. Konzert verschoben), " +
        "gib es in datum_aenderung an — der Auftrag wird dann automatisch umdatiert. Bei blosser Erwähnung anderer/zukünftiger Termine: null. " +
        "IDs exakt aus der Liste übernehmen. Im Zweifel lieber weniger ändern.",
      content,
      toolName: "ergebnis_speichern",
      toolDescription: "Speichert Zusammenfassung und Zusagen-Änderungen für den Auftrag.",
      schema: ERGEBNIS_SCHEMA,
    });

    const bekannteIds = new Set((zusagen ?? []).map((z) => z.id));
    const now = new Date().toISOString();

    await admin.from("jobs").update({ ai_summary: ergebnis.zusammenfassung }).eq("id", job_id);
    if (ergebnis.neue_zusagen.length) {
      await admin.from("job_zusagen").insert(
        ergebnis.neue_zusagen.map((z) => ({
          job_id,
          text: z.text,
          mit_wem: z.mit_wem,
          quelle_item_id: item_id,
          created_via: "ki",
          created_by: auth.effectiveUserId,
        })),
      );
    }
    for (const [ids, status] of [
      [ergebnis.erledigte_zusagen_ids, "erledigt"],
      [ergebnis.hinfaellige_zusagen_ids, "hinfaellig"],
    ] as const) {
      const valid = ids.filter((id) => bekannteIds.has(id));
      if (valid.length) {
        await admin.from("job_zusagen").update({ status, updated_at: now }).in("id", valid).eq("job_id", job_id);
      }
    }
    // Event-Datum umdatieren, wenn die KI ein eindeutiges neues Datum meldet.
    // Gespeichert im Format der bestehenden Werte (Mitternacht UTC).
    let datumNeu: string | null = null;
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    if (ergebnis.datum_aenderung && DATE_RE.test(ergebnis.datum_aenderung.start_datum)) {
      const start = ergebnis.datum_aenderung.start_datum;
      const end = ergebnis.datum_aenderung.end_datum && DATE_RE.test(ergebnis.datum_aenderung.end_datum)
        ? ergebnis.datum_aenderung.end_datum
        : start;
      await admin
        .from("jobs")
        .update({ start_date: `${start}T00:00:00+00:00`, end_date: `${end}T00:00:00+00:00` })
        .eq("id", job_id);
      datumNeu = start === end ? start : `${start} – ${end}`;
    }

    await admin.from("job_inbox_items").update({ ai_status: "verarbeitet", ai_error: null }).eq("id", item_id);

    return NextResponse.json({ success: true, neue_zusagen: ergebnis.neue_zusagen.length, datum_neu: datumNeu });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "KI-Verarbeitung fehlgeschlagen";
    await admin.from("job_inbox_items").update({ ai_status: "fehler", ai_error: msg }).eq("id", item_id);
    return NextResponse.json({ success: false, error: msg }, { status: 502 });
  }
}
