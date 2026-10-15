// /api/lieferant/anfragen/[jobId] — Technik-Review des Lieferanten (Portal).
//
// GET  → Auftrags-Kontext (Whitelist!) + Anforderungen + Positionen +
//        Rueckmeldungen + Kommentare + Aktivitaet + eigener Katalog.
// POST → { aktion: "bestaetigen", positionId }
//        { aktion: "alle_bestaetigen" }
//        { aktion: "review", positionId?, art: "empfehlung" | "problem", text, vorschlag? }
//        { aktion: "kommentar", positionId?, reviewId?, body }
//
// Sicherheit: Zugriff NUR wenn eine job_lieferanten-Zeile den Auftrag der
// eigenen Firma zuweist UND die Anfrage gesendet ist (angefragt_at).
// Storniert/abgeschlossen: nur noch lesen (POST 409). Alles laeuft ueber
// den Admin-Client mit expliziten Selects — der Lieferant beruehrt nie
// jobs-RLS, Preise oder Dokumente.

import { NextRequest, NextResponse } from "next/server";
import { requireLieferantPortal, logTechnik, lieferantAuftrag, freitext, sperrGrund } from "@/lib/technik-server";
import { notifyTechnikAntwort } from "@/lib/notification-service";
import { recipientsWithPermission } from "@/lib/notification-recipients";
import {
  REVIEW_ART_LABEL, REVIEW_ARTEN, TECHNIK_BEZEICHNUNG_MAX, ganzeMenge,
  type ReviewArt, type ReviewVorschlag,
} from "@/lib/technik";
import { logError } from "@/lib/log";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fehler = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status });

export async function GET(_req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const gate = await requireLieferantPortal();
  if (gate.error) return gate.error;
  const { admin, lieferantId } = gate;
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return fehler("Ungültige ID");

  const zugriff = await lieferantAuftrag(admin, jobId, lieferantId);
  if (!zugriff.ok) return zugriff.antwort;
  const { auftrag } = zugriff;

  try {
    const [jobRes, anfRes, posRes, revRes, komRes, aktRes, katRes] = await Promise.all([
      admin
        .from("jobs")
        .select("id, title, job_number, start_date, end_date, guest_count, event_type, location:locations(name)")
        .eq("id", jobId)
        .maybeSingle(),
      admin.from("job_anforderungen").select("id, text, sort").eq("job_id", jobId).order("sort").order("created_at"),
      admin
        .from("job_technik_positionen")
        .select("id, artikel_id, kategorie, bezeichnung, details, menge, status, quelle, bestaetigt_at, created_at")
        .eq("job_id", jobId)
        .order("kategorie")
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
        .limit(100),
      admin
        .from("lieferant_katalog_artikel")
        .select("id, name, hauptkategorie")
        .eq("lieferant_id", lieferantId)
        .eq("is_active", true)
        .order("hauptkategorie")
        .order("name"),
    ]);
    const err = [jobRes, anfRes, posRes, revRes, komRes, aktRes, katRes].find((r) => r.error)?.error;
    if (err) throw err;
    const job = jobRes.data;
    if (!job) return fehler("Auftrag nicht gefunden", 404);
    const loc = Array.isArray(job.location) ? job.location[0] : job.location;

    return NextResponse.json({
      success: true,
      job: {
        id: job.id,
        titel: job.title,
        jobNumber: job.job_number,
        status: auftrag.job.status,
        startDate: job.start_date,
        endDate: job.end_date,
        gaeste: job.guest_count,
        eventTyp: job.event_type,
        locationName: (loc as { name?: string } | null)?.name ?? null,
      },
      gesperrt: auftrag.gesperrt,
      angefragtAt: auftrag.angefragtAt,
      runden: auftrag.runden,
      anforderungen: anfRes.data ?? [],
      positionen: posRes.data ?? [],
      reviews: revRes.data ?? [],
      kommentare: ((komRes.data ?? []) as unknown as {
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
      aktivitaet: aktRes.data ?? [],
      katalog: katRes.data ?? [],
    });
  } catch (e) {
    logError("api.lieferant.anfragen.detail", e, { jobId });
    return NextResponse.json({ success: false, error: "Laden fehlgeschlagen" }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const gate = await requireLieferantPortal();
  if (gate.error) return gate.error;
  const { admin, lieferantId, lieferantName, userId, userName } = gate;
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return fehler("Ungültige ID");

  const zugriff = await lieferantAuftrag(admin, jobId, lieferantId);
  if (!zugriff.ok) return zugriff.antwort;
  const { auftrag } = zugriff;
  if (auftrag.gesperrt) return fehler(sperrGrund(auftrag.job.status), 409);

  const b = ((await req.json().catch(() => null)) ?? {}) as {
    aktion?: string;
    positionId?: string;
    reviewId?: string;
    art?: string;
    text?: unknown;
    body?: unknown;
    vorschlag?: ReviewVorschlag | null;
  };

  const jobTitle = auftrag.job.title;
  const actor = { id: userId, name: userName ?? lieferantName };
  const interne = () => recipientsWithPermission(admin, "auftraege:edit", { exclude: [userId] });

  /** Gehoert die Position zu DIESEM Auftrag? (sonst unsichtbarer Datenmuell) */
  async function positionDesAuftrags(positionId: string) {
    const { data, error } = await admin
      .from("job_technik_positionen")
      .select("id, bezeichnung, menge, status")
      .eq("id", positionId)
      .eq("job_id", jobId)
      .maybeSingle();
    if (error) throw error;
    return data as { id: string; bezeichnung: string; menge: number; status: string } | null;
  }

  try {
    switch (b.aktion) {
      case "bestaetigen": {
        if (!b.positionId || !UUID_RE.test(b.positionId)) return fehler("positionId nötig");
        const pos = await positionDesAuftrags(b.positionId);
        if (!pos) return fehler("Position nicht gefunden", 404);
        if (pos.status === "bestaetigt") return NextResponse.json({ success: true });
        const { error } = await admin
          .from("job_technik_positionen")
          .update({ status: "bestaetigt", bestaetigt_by: userId, bestaetigt_at: new Date().toISOString() })
          .eq("id", pos.id)
          .eq("job_id", jobId);
        if (error) throw error;
        await logTechnik(admin, jobId, actor, "position_bestaetigt", `${lieferantName} hat ${pos.menge}× ${pos.bezeichnung} bestätigt`, { position_id: pos.id });

        // Erst melden, wenn ALLES bestaetigt ist — sonst Spam.
        const { count: offenCount, error: cErr } = await admin
          .from("job_technik_positionen")
          .select("id", { count: "exact", head: true })
          .eq("job_id", jobId)
          .neq("status", "bestaetigt");
        if (cErr) throw cErr;
        if (offenCount === 0) {
          await notifyTechnikAntwort(admin, {
            recipients: await interne(),
            jobId,
            jobTitle,
            lieferantName,
            was: "hat alle Positionen bestätigt.",
          });
        }
        return NextResponse.json({ success: true, alleBestaetigt: offenCount === 0 });
      }

      case "alle_bestaetigen": {
        // EINE Aktion statt n Einzel-Requests: ein Aktivitaets-Eintrag,
        // eine Benachrichtigung, ehrliche Fehlermeldung.
        const { data, error } = await admin
          .from("job_technik_positionen")
          .update({ status: "bestaetigt", bestaetigt_by: userId, bestaetigt_at: new Date().toISOString() })
          .eq("job_id", jobId)
          .neq("status", "bestaetigt")
          .select("id");
        if (error) throw error;
        const anzahl = data?.length ?? 0;
        if (anzahl > 0) {
          await logTechnik(admin, jobId, actor, "alle_bestaetigt",
            `${lieferantName} hat ${anzahl === 1 ? "die letzte offene Position" : `alle ${anzahl} offenen Positionen`} bestätigt`);
          await notifyTechnikAntwort(admin, {
            recipients: await interne(),
            jobId,
            jobTitle,
            lieferantName,
            was: "hat alle Positionen bestätigt.",
          });
        }
        return NextResponse.json({ success: true, anzahl });
      }

      case "review": {
        const art = b.art as ReviewArt;
        if (!REVIEW_ARTEN.includes(art)) return fehler("Ungültige Art");
        const t = freitext(b.text, { feld: "Begründung", pflicht: true });
        if (t.fehler || !t.wert) return fehler(t.fehler ?? "Begründung fehlt");
        if (b.positionId) {
          if (!UUID_RE.test(b.positionId)) return fehler("Ungültige positionId");
          if (!(await positionDesAuftrags(b.positionId))) return fehler("Position nicht gefunden", 404);
        }
        let vorschlag: ReviewVorschlag | null = null;
        if (art === "empfehlung" && b.vorschlag && typeof b.vorschlag === "object") {
          const v = b.vorschlag;
          const bez = (x: unknown) => freitext(x, { feld: "Bezeichnung", pflicht: true, max: TECHNIK_BEZEICHNUNG_MAX });
          if (v.typ === "menge" && b.positionId) {
            const menge = ganzeMenge(v.menge);
            if (!menge) return fehler("Menge muss eine ganze Zahl ab 1 sein");
            vorschlag = { typ: "menge", menge };
          } else if (v.typ === "neue_position") {
            const name = bez(v.bezeichnung);
            if (name.fehler || !name.wert) return fehler(name.fehler ?? "Bezeichnung fehlt");
            const menge = ganzeMenge(v.menge);
            if (!menge) return fehler("Menge muss eine ganze Zahl ab 1 sein");
            const kat = freitext(v.kategorie, { feld: "Kategorie", max: TECHNIK_BEZEICHNUNG_MAX });
            const det = freitext(v.details, { feld: "Details" });
            if (kat.fehler || det.fehler) return fehler(kat.fehler ?? det.fehler ?? "Ungültige Angaben");
            vorschlag = {
              typ: "neue_position",
              bezeichnung: name.wert,
              menge,
              kategorie: kat.wert ?? undefined,
              details: det.wert ?? undefined,
              artikel_id: v.artikel_id && UUID_RE.test(v.artikel_id) ? v.artikel_id : undefined,
            };
          } else if (v.typ === "ersatz" && b.positionId) {
            const name = bez(v.bezeichnung);
            if (name.fehler || !name.wert) return fehler(name.fehler ?? "Bezeichnung fehlt");
            let menge: number | undefined;
            const rohMenge: unknown = v.menge;
            if (rohMenge !== undefined && rohMenge !== null && rohMenge !== "") {
              const m = ganzeMenge(rohMenge);
              if (!m) return fehler("Menge muss eine ganze Zahl ab 1 sein");
              menge = m;
            }
            const det = freitext(v.details, { feld: "Details" });
            if (det.fehler) return fehler(det.fehler);
            vorschlag = {
              typ: "ersatz",
              bezeichnung: name.wert,
              menge,
              details: det.wert ?? undefined,
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
            text: t.wert,
            vorschlag,
            created_by: userId,
          })
          .select("id")
          .single();
        if (error) throw error;
        await logTechnik(admin, jobId, actor, `review_${art}`, `${lieferantName} — ${REVIEW_ART_LABEL[art]}: «${t.wert.slice(0, 80)}»`, { review_id: neu.id });
        await notifyTechnikAntwort(admin, {
          recipients: await interne(),
          jobId,
          jobTitle,
          lieferantName,
          was: `${REVIEW_ART_LABEL[art]}: ${t.wert.slice(0, 100)}`,
        });
        return NextResponse.json({ success: true, id: neu.id });
      }

      case "kommentar": {
        const t = freitext(b.body, { feld: "Kommentar", pflicht: true });
        if (t.fehler || !t.wert) return fehler(t.fehler ?? "Kommentar fehlt");
        if (b.positionId) {
          if (!UUID_RE.test(b.positionId)) return fehler("Ungültige positionId");
          if (!(await positionDesAuftrags(b.positionId))) return fehler("Position nicht gefunden", 404);
        }
        if (b.reviewId) {
          if (!UUID_RE.test(b.reviewId)) return fehler("Ungültige reviewId");
          const { data: rev, error } = await admin
            .from("job_technik_reviews").select("id").eq("id", b.reviewId).eq("job_id", jobId).maybeSingle();
          if (error) throw error;
          if (!rev) return fehler("Rückmeldung nicht gefunden", 404);
        }
        const { error } = await admin.from("job_technik_kommentare").insert({
          job_id: jobId,
          position_id: b.positionId ?? null,
          review_id: b.reviewId ?? null,
          author_id: userId,
          body: t.wert,
        });
        if (error) throw error;
        await logTechnik(admin, jobId, actor, "kommentar", `${lieferantName} — Kommentar: «${t.wert.slice(0, 80)}»`);
        await notifyTechnikAntwort(admin, {
          recipients: await interne(),
          jobId,
          jobTitle,
          lieferantName,
          was: `Kommentar: ${t.wert.slice(0, 100)}`,
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
