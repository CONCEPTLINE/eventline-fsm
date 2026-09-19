// POST /api/ai/frage — beantwortet eine Frage zu EINEM Auftrag aus dessen
// gesamtem Wissen: Stammdaten, Zusammenfassung, Zusagen und der komplette
// Eingang (Texte direkt; die letzten Bilder/PDFs als Anhang). Antwort mit
// Quellen-IDs, damit die UI die Belege im Eingang verlinken kann.

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
const MAX_ANHAENGE = 6; // juengste Bilder/PDFs mitgeben — Kosten/Latenz-Deckel

type Antwort = { antwort: string; quellen_item_ids: string[] };

const ANTWORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["antwort", "quellen_item_ids"],
  properties: {
    antwort: { type: "string", description: "Antwort auf Deutsch, praezise, keine Floskeln. Wenn die Info fehlt: klar sagen." },
    quellen_item_ids: { type: "array", items: { type: "string" }, description: "IDs der Eingang-Elemente, auf die sich die Antwort stuetzt." },
  },
};

export async function POST(req: NextRequest) {
  const auth = await requireUser();
  if (auth.error) return auth.error;
  if (!aiAvailable()) {
    return NextResponse.json({ success: false, error: AI_UNAVAILABLE_MSG }, { status: 503 });
  }

  let body: { job_id?: string; frage?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Ungültige Anfrage" }, { status: 400 });
  }
  const { job_id } = body;
  const frage = (body.frage ?? "").trim().slice(0, 2000);
  if (!job_id || !UUID_RE.test(job_id) || !frage) {
    return NextResponse.json({ success: false, error: "Ungültige Anfrage" }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: job } = await supabase
    .from("jobs")
    .select("id, title, job_number, start_time, end_time, description, ai_summary, customer:customers(name), location:locations(name)")
    .eq("id", job_id)
    .maybeSingle();
  if (!job) return NextResponse.json({ success: false, error: "Auftrag nicht gefunden" }, { status: 404 });

  const admin = createAdminClient();
  const [{ data: zusagen }, { data: items }] = await Promise.all([
    admin.from("job_zusagen").select("id, text, status, mit_wem, created_at").eq("job_id", job_id).order("created_at"),
    admin.from("job_inbox_items").select("id, kind, content, file_path, file_name, mime_type, created_at, author:profiles!job_inbox_items_created_by_fkey(full_name)").eq("job_id", job_id).order("created_at"),
  ]);

  const content: Anthropic.ContentBlockParam[] = [];
  const kontext = [
    `AUFTRAG ${job.job_number ?? ""}: ${job.title}`,
    relName(job.customer) ? `Kunde: ${relName(job.customer)}` : null,
    relName(job.location) ? `Ort: ${relName(job.location)}` : null,
    job.start_time ? `Zeitraum: ${job.start_time} bis ${job.end_time ?? "?"}` : null,
    job.description ? `Beschreibung: ${job.description}` : null,
    job.ai_summary ? `\nZUSAMMENFASSUNG:\n${job.ai_summary}` : null,
    zusagen?.length
      ? `\nZUSAGEN:\n` + zusagen.map((z) => `[${z.status}] ${z.text}${z.mit_wem ? ` (mit ${z.mit_wem})` : ""}`).join("\n")
      : null,
    items?.length
      ? `\nEINGANG (id | von | wann | Inhalt):\n` +
        items
          .map((i) => {
            const von = (i.author as unknown as { full_name?: string } | null)?.full_name ?? "?";
            const inhalt = i.kind === "text" ? (i.content ?? "").slice(0, 4000) : `Datei "${i.file_name}"`;
            return `${i.id} | ${von} | ${i.created_at} | ${inhalt}`;
          })
          .join("\n---\n")
      : "\nEingang ist leer.",
  ].filter(Boolean).join("\n");
  content.push({ type: "text", text: kontext });

  // Juengste lesbare Anhaenge (Bilder/PDFs) mitgeben.
  const anhaenge = (items ?? [])
    .filter((i) => i.kind === "datei" && i.file_path && ((i.mime_type ?? "").startsWith("image/") || i.mime_type === "application/pdf"))
    .slice(-MAX_ANHAENGE);
  for (const a of anhaenge) {
    const { data: signed } = await admin.storage.from("documents").createSignedUrl(a.file_path as string, 600);
    if (!signed?.signedUrl) continue;
    content.push({ type: "text", text: `\nAnhang (Eingang-ID ${a.id}, "${a.file_name}"):` });
    if ((a.mime_type ?? "").startsWith("image/")) {
      content.push({ type: "image", source: { type: "url", url: signed.signedUrl } });
    } else {
      content.push({ type: "document", source: { type: "url", url: signed.signedUrl } });
    }
  }

  content.push({ type: "text", text: `\nFRAGE: ${frage}` });

  try {
    const res = await structuredCall<Antwort>({
      system:
        "Du beantwortest Fragen zu einem Veranstaltungstechnik-Auftrag der Firma EVENTLINE (Basel) — " +
        "ausschliesslich aus dem mitgelieferten Auftragswissen (Stammdaten, Zusammenfassung, Zusagen, Eingang samt Anhängen). " +
        "Antworte auf Deutsch, präzise und knapp. Erfinde nichts: Wenn die Information nicht vorhanden ist, sag das klar. " +
        "Gib die IDs der Eingang-Elemente an, auf die du dich stützt.",
      content,
      toolName: "antwort_geben",
      toolDescription: "Gibt die Antwort samt Quellen-IDs zurueck.",
      schema: ANTWORT_SCHEMA,
      maxTokens: 2048,
    });
    const gueltig = new Set((items ?? []).map((i) => i.id));
    return NextResponse.json({
      success: true,
      antwort: res.antwort,
      quellen: res.quellen_item_ids.filter((id) => gueltig.has(id)),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "KI-Anfrage fehlgeschlagen";
    return NextResponse.json({ success: false, error: msg }, { status: 502 });
  }
}
