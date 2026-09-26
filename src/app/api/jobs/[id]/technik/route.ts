// POST /api/jobs/[id]/technik — alle Firmen-Mutationen der Technik-Planung
// als Aktions-Dispatcher (eine Route statt zehn Mini-Routen).
//
// { aktion: "...", ...felder } — Aktionen:
//   lieferant_setzen        { lieferantId | null }
//   anfrage_senden          {}                                → Notification an Portal-User
//   anforderung_neu         { text }
//   anforderung_edit        { id, text }
//   anforderung_loeschen    { id }
//   position_neu            { bezeichnung, menge, kategorie?, details?, artikelId?, anforderungId?, quelle? }
//   position_edit           { id, bezeichnung?, menge?, kategorie?, details? }
//   position_loeschen       { id }
//   position_bestaetigen    { id, bestaetigt }
//   review_entscheiden      { id, entscheid: "uebernehmen" | "ablehnen" }
//   kommentar_neu           { positionId?, reviewId?, body }  → Notification an Portal-User
//
// Lesen macht der Technik-Tab direkt per Client-Supabase (staff-RLS).
// Jede Aktion schreibt einen Aktivitaets-Eintrag.

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requirePermission } from "@/lib/api-auth";
import { logTechnik, actorName, lieferantPortalUserIds, zugewiesenerLieferant, jobDatumText } from "@/lib/technik-server";
import { notifyLieferantTechnikAnfrage, notifySystem } from "@/lib/notification-service";
import type { ReviewVorschlag } from "@/lib/technik";
import { logError } from "@/lib/log";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Body = {
  aktion?: string;
  id?: string;
  text?: string;
  lieferantId?: string | null;
  bezeichnung?: string;
  menge?: number;
  kategorie?: string;
  details?: string;
  artikelId?: string;
  anforderungId?: string;
  quelle?: string;
  bestaetigt?: boolean;
  entscheid?: string;
  positionId?: string;
  reviewId?: string;
  body?: string;
};

const fehler = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requirePermission("auftraege:edit");
  if (auth.error) return auth.error;
  const { id: jobId } = await params;
  if (!UUID_RE.test(jobId)) return fehler("Ungültige Auftrags-ID");

  const b = ((await request.json().catch(() => null)) ?? {}) as Body;
  const admin = createAdminClient();

  const { data: job } = await admin
    .from("jobs")
    .select("id, title, job_number, start_date, end_date, is_deleted")
    .eq("id", jobId)
    .maybeSingle();
  if (!job || job.is_deleted) return fehler("Auftrag nicht gefunden", 404);

  const actor = { id: auth.user.id, name: await actorName(admin, auth.user.id) };
  const dann = (aktion: string, beschreibung: string, meta?: Record<string, unknown>) =>
    logTechnik(admin, jobId, actor, aktion, beschreibung, meta);

  try {
    switch (b.aktion) {
      case "lieferant_setzen": {
        const bisher = await zugewiesenerLieferant(admin, jobId);
        if (!b.lieferantId) {
          if (bisher) {
            await admin.from("job_lieferanten").delete().eq("id", bisher.zuweisungId);
            await dann("lieferant_entfernt", `Lieferant «${bisher.name}» entfernt`);
          }
          return NextResponse.json({ success: true });
        }
        if (!UUID_RE.test(b.lieferantId)) return fehler("Ungültige Lieferanten-ID");
        if (bisher && bisher.lieferantId === b.lieferantId) return NextResponse.json({ success: true });
        if (bisher) await admin.from("job_lieferanten").delete().eq("id", bisher.zuweisungId);
        const { error } = await admin.from("job_lieferanten").insert({
          job_id: jobId,
          lieferant_id: b.lieferantId,
          created_by: auth.user.id,
        });
        if (error) throw error;
        const neu = await zugewiesenerLieferant(admin, jobId);
        await dann("lieferant_zugewiesen", `Lieferant «${neu?.name ?? "?"}» zugewiesen`);
        return NextResponse.json({ success: true });
      }

      case "anfrage_senden": {
        const zuw = await zugewiesenerLieferant(admin, jobId);
        if (!zuw) return fehler("Kein Lieferant zugewiesen");
        const { count } = await admin
          .from("job_technik_positionen")
          .select("id", { count: "exact", head: true })
          .eq("job_id", jobId);
        if (!count) return fehler("Noch keine Positionen erfasst");
        const { data: aktuelleRunde } = await admin
          .from("job_lieferanten")
          .select("anfrage_runden")
          .eq("id", zuw.zuweisungId)
          .maybeSingle();
        const runde = ((aktuelleRunde?.anfrage_runden as number | undefined) ?? 0) + 1;
        await admin
          .from("job_lieferanten")
          .update({ angefragt_at: new Date().toISOString(), angefragt_by: auth.user.id, anfrage_runden: runde })
          .eq("id", zuw.zuweisungId);
        const empfaenger = await lieferantPortalUserIds(admin, zuw.lieferantId);
        await notifyLieferantTechnikAnfrage(admin, {
          recipients: empfaenger,
          jobId,
          jobTitle: job.title,
          dateText: jobDatumText(job.start_date, job.end_date),
          anzahlPositionen: count,
        });
        await dann("anfrage_gesendet", `Anfrage an «${zuw.name}» gesendet — Runde ${runde} (${count} Positionen)`);
        return NextResponse.json({ success: true, empfaenger: empfaenger.length });
      }

      case "anforderung_neu": {
        const text = (b.text ?? "").trim();
        if (!text) return fehler("Text fehlt");
        const { data, error } = await admin
          .from("job_anforderungen")
          .insert({ job_id: jobId, text, created_by: auth.user.id })
          .select("id")
          .single();
        if (error) throw error;
        await dann("anforderung_neu", `Kundenwunsch erfasst: «${text.slice(0, 80)}»`);
        return NextResponse.json({ success: true, id: data.id });
      }

      case "anforderung_edit": {
        const text = (b.text ?? "").trim();
        if (!b.id || !UUID_RE.test(b.id) || !text) return fehler("id + text nötig");
        const { error } = await admin
          .from("job_anforderungen")
          .update({ text })
          .eq("id", b.id)
          .eq("job_id", jobId);
        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case "anforderung_loeschen": {
        if (!b.id || !UUID_RE.test(b.id)) return fehler("id nötig");
        const { error } = await admin.from("job_anforderungen").delete().eq("id", b.id).eq("job_id", jobId);
        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case "position_neu": {
        const bezeichnung = (b.bezeichnung ?? "").trim();
        const menge = Number(b.menge);
        if (!bezeichnung || !Number.isInteger(menge) || menge < 1) return fehler("Bezeichnung + Menge nötig");
        const quelle = b.quelle === "kunde" ? "kunde" : "eventfirma";
        const { data, error } = await admin
          .from("job_technik_positionen")
          .insert({
            job_id: jobId,
            bezeichnung,
            menge,
            kategorie: (b.kategorie ?? "").trim() || "Sonstiges",
            details: (b.details ?? "").trim() || null,
            artikel_id: b.artikelId && UUID_RE.test(b.artikelId) ? b.artikelId : null,
            anforderung_id: b.anforderungId && UUID_RE.test(b.anforderungId) ? b.anforderungId : null,
            quelle,
            created_by: auth.user.id,
          })
          .select("id")
          .single();
        if (error) throw error;
        await dann("position_neu", `Position erfasst: ${menge}× ${bezeichnung}`);
        return NextResponse.json({ success: true, id: data.id });
      }

      case "position_edit": {
        if (!b.id || !UUID_RE.test(b.id)) return fehler("id nötig");
        const patch: Record<string, unknown> = {};
        if (b.bezeichnung !== undefined) {
          const v = b.bezeichnung.trim();
          if (!v) return fehler("Bezeichnung darf nicht leer sein");
          patch.bezeichnung = v;
        }
        if (b.menge !== undefined) {
          const m = Number(b.menge);
          if (!Number.isInteger(m) || m < 1) return fehler("Ungültige Menge");
          patch.menge = m;
        }
        if (b.kategorie !== undefined) patch.kategorie = b.kategorie.trim() || "Sonstiges";
        if (b.details !== undefined) patch.details = b.details.trim() || null;
        if (Object.keys(patch).length === 0) return fehler("Nichts zu ändern");
        const { error } = await admin.from("job_technik_positionen").update(patch).eq("id", b.id).eq("job_id", jobId);
        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case "position_loeschen": {
        if (!b.id || !UUID_RE.test(b.id)) return fehler("id nötig");
        const { data: pos } = await admin
          .from("job_technik_positionen")
          .select("bezeichnung, menge")
          .eq("id", b.id)
          .eq("job_id", jobId)
          .maybeSingle();
        const { error } = await admin.from("job_technik_positionen").delete().eq("id", b.id).eq("job_id", jobId);
        if (error) throw error;
        if (pos) await dann("position_geloescht", `Position entfernt: ${pos.menge}× ${pos.bezeichnung}`);
        return NextResponse.json({ success: true });
      }

      case "position_bestaetigen": {
        if (!b.id || !UUID_RE.test(b.id)) return fehler("id nötig");
        const bestaetigt = b.bestaetigt !== false;
        const { error } = await admin
          .from("job_technik_positionen")
          .update(
            bestaetigt
              ? { status: "bestaetigt", bestaetigt_by: auth.user.id, bestaetigt_at: new Date().toISOString() }
              : { status: "geplant", bestaetigt_by: null, bestaetigt_at: null },
          )
          .eq("id", b.id)
          .eq("job_id", jobId);
        if (error) throw error;
        return NextResponse.json({ success: true });
      }

      case "review_entscheiden": {
        if (!b.id || !UUID_RE.test(b.id)) return fehler("id nötig");
        if (b.entscheid !== "uebernehmen" && b.entscheid !== "ablehnen") return fehler("entscheid nötig");
        const { data: review } = await admin
          .from("job_technik_reviews")
          .select("id, position_id, art, text, vorschlag, status")
          .eq("id", b.id)
          .eq("job_id", jobId)
          .maybeSingle();
        if (!review) return fehler("Review-Punkt nicht gefunden", 404);
        if (review.status !== "offen") return fehler("Punkt ist bereits entschieden");

        if (b.entscheid === "uebernehmen") {
          const v = review.vorschlag as ReviewVorschlag | null;
          if (v?.typ === "menge" && review.position_id) {
            const { error } = await admin
              .from("job_technik_positionen")
              .update({ menge: v.menge, status: "bestaetigt", bestaetigt_by: auth.user.id, bestaetigt_at: new Date().toISOString() })
              .eq("id", review.position_id);
            if (error) throw error;
          } else if (v?.typ === "neue_position") {
            const { error } = await admin.from("job_technik_positionen").insert({
              job_id: jobId,
              bezeichnung: v.bezeichnung,
              menge: v.menge,
              kategorie: v.kategorie?.trim() || "Sonstiges",
              details: v.details?.trim() || null,
              artikel_id: v.artikel_id ?? null,
              quelle: "lieferant",
              status: "bestaetigt",
              bestaetigt_by: auth.user.id,
              bestaetigt_at: new Date().toISOString(),
              created_by: auth.user.id,
            });
            if (error) throw error;
          } else if (v?.typ === "ersatz" && review.position_id) {
            const patch: Record<string, unknown> = {
              bezeichnung: v.bezeichnung,
              quelle: "lieferant",
              status: "bestaetigt",
              bestaetigt_by: auth.user.id,
              bestaetigt_at: new Date().toISOString(),
            };
            if (v.menge !== undefined) patch.menge = v.menge;
            if (v.details !== undefined) patch.details = v.details?.trim() || null;
            if (v.artikel_id !== undefined) patch.artikel_id = v.artikel_id ?? null;
            const { error } = await admin.from("job_technik_positionen").update(patch).eq("id", review.position_id);
            if (error) throw error;
          }
        }

        const neuerStatus = b.entscheid === "uebernehmen" ? "uebernommen" : "abgelehnt";
        const { error } = await admin
          .from("job_technik_reviews")
          .update({ status: neuerStatus, entschieden_by: auth.user.id, entschieden_at: new Date().toISOString() })
          .eq("id", review.id);
        if (error) throw error;
        await dann(
          `review_${neuerStatus}`,
          `${b.entscheid === "uebernehmen" ? "Übernommen" : "Abgelehnt"}: «${review.text.slice(0, 80)}»`,
        );

        // Lieferant in-app informieren (kein Mail-Spam).
        const zuw = await zugewiesenerLieferant(admin, jobId);
        if (zuw) {
          await notifySystem(admin, {
            recipients: await lieferantPortalUserIds(admin, zuw.lieferantId),
            title: `${b.entscheid === "uebernehmen" ? "Übernommen" : "Abgelehnt"}: ${job.title}`,
            message: review.text.slice(0, 120),
            link: `/lieferant/anfragen/${jobId}`,
          });
        }
        return NextResponse.json({ success: true });
      }

      case "kommentar_neu": {
        const text = (b.body ?? "").trim();
        if (!text) return fehler("Kommentar fehlt");
        // Ziel-IDs muessen zu DIESEM Auftrag gehoeren (sonst unsichtbarer
        // Datenmuell an fremden Positionen/Reviews).
        let positionId: string | null = null;
        if (b.positionId && UUID_RE.test(b.positionId)) {
          const { data: pos } = await admin
            .from("job_technik_positionen").select("id").eq("id", b.positionId).eq("job_id", jobId).maybeSingle();
          if (!pos) return fehler("Position nicht gefunden", 404);
          positionId = b.positionId;
        }
        let reviewId: string | null = null;
        if (b.reviewId && UUID_RE.test(b.reviewId)) {
          const { data: rev } = await admin
            .from("job_technik_reviews").select("id").eq("id", b.reviewId).eq("job_id", jobId).maybeSingle();
          if (!rev) return fehler("Review-Punkt nicht gefunden", 404);
          reviewId = b.reviewId;
        }
        const { error } = await admin.from("job_technik_kommentare").insert({
          job_id: jobId,
          position_id: positionId,
          review_id: reviewId,
          author_id: auth.user.id,
          body: text,
        });
        if (error) throw error;
        await dann("kommentar", `Kommentar: «${text.slice(0, 80)}»`);
        const zuw = await zugewiesenerLieferant(admin, jobId);
        if (zuw?.angefragtAt) {
          await notifySystem(admin, {
            recipients: await lieferantPortalUserIds(admin, zuw.lieferantId),
            title: `Antwort von EVENTLINE: ${job.title}`,
            message: text.slice(0, 120),
            link: `/lieferant/anfragen/${jobId}`,
          });
        }
        return NextResponse.json({ success: true });
      }

      default:
        return fehler("Unbekannte Aktion");
    }
  } catch (e) {
    logError("api.jobs.technik", e, { jobId, aktion: b.aktion });
    return NextResponse.json({ success: false, error: "Speichern fehlgeschlagen" }, { status: 500 });
  }
}
