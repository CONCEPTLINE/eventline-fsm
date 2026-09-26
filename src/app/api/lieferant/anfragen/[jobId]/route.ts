// /api/lieferant/anfragen/[jobId] — Technik-Review des Lieferanten (Portal).
//
// GET  → Auftrags-Kontext (Whitelist!) + Anforderungen + Positionen +
//        Review-Punkte + Kommentare + Aktivitaet + eigener Katalog + Regeln.
// POST → { aktion: "bestaetigen", positionId }
//        { aktion: "review", positionId?, art, text, vorschlag? }
//        { aktion: "kommentar", positionId?, reviewId?, body }
//
// Sicherheit: Zugriff NUR wenn eine job_lieferanten-Zeile den Auftrag der
// eigenen Firma zuweist. Alles laeuft ueber den Admin-Client mit expliziten
// Selects — der Lieferant beruehrt nie jobs-RLS, Preise oder Dokumente.

import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireLieferantPortal, logTechnik } from "@/lib/technik-server";
import { notifyTechnikAntwort } from "@/lib/notification-service";
import { recipientsWithPermission } from "@/lib/notification-recipients";
import { REVIEW_ART_LABEL, type ReviewArt, type ReviewVorschlag } from "@/lib/technik";
import { logError } from "@/lib/log";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fehler = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status });

async function zugriff(admin: SupabaseClient, jobId: string, lieferantId: string) {
  const { data } = await admin
    .from("job_lieferanten")
    .select("id, angefragt_at")
    .eq("job_id", jobId)
    .eq("lieferant_id", lieferantId)
    .maybeSingle();
  return data as { id: string; angefragt_at: string | null } | null;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const gate = await requireLieferantPortal();
  if (gate.error) return gate.error;
  const { admin, lieferantId } = gate;
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return fehler("Ungültige ID");

  const zuw = await zugriff(admin, jobId, lieferantId);
  if (!zuw) return fehler("Kein Zugriff", 403);

  try {
    const [{ data: job }, { data: anforderungen }, { data: positionen }, { data: reviews }, { data: kommentare }, { data: aktivitaet }, { data: katalog }, { data: regeln }] = await Promise.all([
      admin
        .from("jobs")
        .select("id, title, job_number, start_date, end_date, guest_count, event_type, is_deleted, location:locations(name)")
        .eq("id", jobId)
        .maybeSingle(),
      admin.from("job_anforderungen").select("id, text, sort").eq("job_id", jobId).order("sort").order("created_at"),
      admin
        .from("job_technik_positionen")
        .select("id, anforderung_id, artikel_id, kategorie, bezeichnung, details, menge, status, quelle, bestaetigt_at, sort, created_at")
        .eq("job_id", jobId)
        .order("kategorie")
        .order("sort")
        .order("created_at"),
      admin
        .from("job_technik_reviews")
        .select("id, position_id, art, text, vorschlag, status, created_at, entschieden_at")
        .eq("job_id", jobId)
        .order("created_at"),
      admin
        .from("job_technik_kommentare")
        .select("id, position_id, review_id, body, created_at, author:profiles(full_name, role)")
        .eq("job_id", jobId)
        .order("created_at"),
      admin
        .from("job_technik_aktivitaet")
        .select("id, actor_name, aktion, beschreibung, created_at")
        .eq("job_id", jobId)
        .order("created_at", { ascending: false })
        .limit(50),
      admin
        .from("lieferant_katalog_artikel")
        .select("id, name, hauptkategorie")
        .eq("lieferant_id", lieferantId)
        .eq("is_active", true)
        .order("hauptkategorie")
        .order("name"),
      admin
        .from("lieferant_regeln")
        .select("id, art, trigger_text, hinweis, paket, is_active")
        .eq("lieferant_id", lieferantId)
        .order("created_at"),
    ]);

    if (!job || job.is_deleted) return fehler("Auftrag nicht gefunden", 404);
    const loc = Array.isArray(job.location) ? job.location[0] : job.location;

    return NextResponse.json({
      success: true,
      job: {
        id: job.id,
        titel: job.title,
        jobNumber: job.job_number,
        startDate: job.start_date,
        endDate: job.end_date,
        gaeste: job.guest_count,
        eventTyp: job.event_type,
        locationName: (loc as { name?: string } | null)?.name ?? null,
      },
      angefragtAt: zuw.angefragt_at,
      anforderungen: anforderungen ?? [],
      positionen: positionen ?? [],
      reviews: reviews ?? [],
      kommentare: ((kommentare ?? []) as unknown as {
        id: string; position_id: string | null; review_id: string | null; body: string; created_at: string;
        author: { full_name: string | null; role: string | null } | { full_name: string | null; role: string | null }[] | null;
      }[]).map((k) => {
        const a = Array.isArray(k.author) ? k.author[0] : k.author;
        return {
          id: k.id,
          position_id: k.position_id,
          review_id: k.review_id,
          body: k.body,
          created_at: k.created_at,
          author_name: a?.full_name ?? null,
          vom_lieferanten: a?.role === "lieferant",
        };
      }),
      aktivitaet: aktivitaet ?? [],
      katalog: katalog ?? [],
      regeln: regeln ?? [],
    });
  } catch (e) {
    logError("api.lieferant.anfragen.detail", e, { jobId });
    return NextResponse.json({ success: false, error: "Laden fehlgeschlagen" }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const gate = await requireLieferantPortal();
  if (gate.error) return gate.error;
  const { admin, lieferantId, userId, userName } = gate;
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return fehler("Ungültige ID");

  const zuw = await zugriff(admin, jobId, lieferantId);
  if (!zuw) return fehler("Kein Zugriff", 403);

  const b = ((await req.json().catch(() => null)) ?? {}) as {
    aktion?: string;
    positionId?: string;
    reviewId?: string;
    art?: string;
    text?: string;
    body?: string;
    vorschlag?: ReviewVorschlag | null;
  };

  const [{ data: job }, { data: firma }] = await Promise.all([
    admin.from("jobs").select("id, title, is_deleted").eq("id", jobId).maybeSingle(),
    admin.from("lieferanten").select("name").eq("id", lieferantId).maybeSingle(),
  ]);
  if (!job || job.is_deleted) return fehler("Auftrag nicht gefunden", 404);
  const lieferantName = firma?.name ?? "Lieferant";
  const actor = { id: userId, name: userName ?? lieferantName };
  const interne = () => recipientsWithPermission(admin, "auftraege:edit", { exclude: [userId] });

  try {
    switch (b.aktion) {
      case "bestaetigen": {
        if (!b.positionId || !UUID_RE.test(b.positionId)) return fehler("positionId nötig");
        const { data: pos } = await admin
          .from("job_technik_positionen")
          .select("id, bezeichnung, menge, status")
          .eq("id", b.positionId)
          .eq("job_id", jobId)
          .maybeSingle();
        if (!pos) return fehler("Position nicht gefunden", 404);
        if (pos.status === "bestaetigt") return NextResponse.json({ success: true });
        const { error } = await admin
          .from("job_technik_positionen")
          .update({ status: "bestaetigt", bestaetigt_by: userId, bestaetigt_at: new Date().toISOString() })
          .eq("id", pos.id);
        if (error) throw error;
        await logTechnik(admin, jobId, actor, "position_bestaetigt", `${lieferantName} hat ${pos.menge}× ${pos.bezeichnung} bestätigt`);

        // Erst melden, wenn ALLES bestaetigt ist — sonst Spam.
        const { count: offenCount } = await admin
          .from("job_technik_positionen")
          .select("id", { count: "exact", head: true })
          .eq("job_id", jobId)
          .neq("status", "bestaetigt");
        if (offenCount === 0) {
          await notifyTechnikAntwort(admin, {
            recipients: await interne(),
            jobId,
            jobTitle: job.title,
            lieferantName,
            was: "hat alle Positionen bestätigt.",
          });
        }
        return NextResponse.json({ success: true, alleBestaetigt: offenCount === 0 });
      }

      case "review": {
        const art = b.art as ReviewArt;
        const text = (b.text ?? "").trim();
        if (!["empfehlung", "problem", "frage"].includes(art)) return fehler("Ungültige Art");
        if (!text) return fehler("Begründung fehlt");
        if (b.positionId) {
          if (!UUID_RE.test(b.positionId)) return fehler("Ungültige positionId");
          // Position muss zu DIESEM Auftrag gehoeren — sonst entsteht
          // unsichtbarer Datenmuell (Review haengt an fremder Position).
          const { data: pos } = await admin
            .from("job_technik_positionen")
            .select("id")
            .eq("id", b.positionId)
            .eq("job_id", jobId)
            .maybeSingle();
          if (!pos) return fehler("Position nicht gefunden", 404);
        }
        let vorschlag: ReviewVorschlag | null = null;
        if (art === "empfehlung" && b.vorschlag && typeof b.vorschlag === "object") {
          const v = b.vorschlag;
          if (v.typ === "menge" && Number.isInteger(Number(v.menge)) && Number(v.menge) > 0 && b.positionId) {
            vorschlag = { typ: "menge", menge: Number(v.menge) };
          } else if (v.typ === "neue_position" && (v.bezeichnung ?? "").trim() && Number(v.menge) > 0) {
            vorschlag = {
              typ: "neue_position",
              bezeichnung: v.bezeichnung.trim(),
              menge: Number(v.menge),
              kategorie: v.kategorie?.trim() || undefined,
              details: v.details?.trim() || undefined,
              artikel_id: v.artikel_id && UUID_RE.test(v.artikel_id) ? v.artikel_id : undefined,
            };
          } else if (v.typ === "ersatz" && (v.bezeichnung ?? "").trim() && b.positionId) {
            vorschlag = {
              typ: "ersatz",
              bezeichnung: v.bezeichnung.trim(),
              menge: v.menge !== undefined && Number(v.menge) > 0 ? Number(v.menge) : undefined,
              details: v.details?.trim() || undefined,
              artikel_id: v.artikel_id && UUID_RE.test(v.artikel_id) ? v.artikel_id : undefined,
            };
          }
        }
        const { data: neu, error } = await admin
          .from("job_technik_reviews")
          .insert({
            job_id: jobId,
            position_id: b.positionId ?? null,
            art,
            text,
            vorschlag,
            created_by: userId,
          })
          .select("id")
          .single();
        if (error) throw error;
        await logTechnik(admin, jobId, actor, `review_${art}`, `${lieferantName} — ${REVIEW_ART_LABEL[art]}: «${text.slice(0, 80)}»`);
        await notifyTechnikAntwort(admin, {
          recipients: await interne(),
          jobId,
          jobTitle: job.title,
          lieferantName,
          was: `${REVIEW_ART_LABEL[art]}: ${text.slice(0, 100)}`,
        });
        return NextResponse.json({ success: true, id: neu.id });
      }

      case "kommentar": {
        const text = (b.body ?? "").trim();
        if (!text) return fehler("Kommentar fehlt");
        if (b.positionId) {
          if (!UUID_RE.test(b.positionId)) return fehler("Ungültige positionId");
          const { data: pos } = await admin
            .from("job_technik_positionen").select("id").eq("id", b.positionId).eq("job_id", jobId).maybeSingle();
          if (!pos) return fehler("Position nicht gefunden", 404);
        }
        if (b.reviewId) {
          if (!UUID_RE.test(b.reviewId)) return fehler("Ungültige reviewId");
          const { data: rev } = await admin
            .from("job_technik_reviews").select("id").eq("id", b.reviewId).eq("job_id", jobId).maybeSingle();
          if (!rev) return fehler("Review-Punkt nicht gefunden", 404);
        }
        const { error } = await admin.from("job_technik_kommentare").insert({
          job_id: jobId,
          position_id: b.positionId ?? null,
          review_id: b.reviewId ?? null,
          author_id: userId,
          body: text,
        });
        if (error) throw error;
        await logTechnik(admin, jobId, actor, "kommentar", `${lieferantName} — Kommentar: «${text.slice(0, 80)}»`);
        await notifyTechnikAntwort(admin, {
          recipients: await interne(),
          jobId,
          jobTitle: job.title,
          lieferantName,
          was: `Kommentar: ${text.slice(0, 100)}`,
        });
        return NextResponse.json({ success: true });
      }

      default:
        return fehler("Unbekannte Aktion");
    }
  } catch (e) {
    logError("api.lieferant.anfragen.post", e, { jobId, aktion: b.aktion });
    return NextResponse.json({ success: false, error: "Speichern fehlgeschlagen" }, { status: 500 });
  }
}
