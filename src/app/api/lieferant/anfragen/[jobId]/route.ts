// /api/lieferant/anfragen/[jobId] — Technik-Review des Lieferanten (Portal).
//
// GET  → Auftrags-Kontext (Whitelist!) + Positionsgruppen + Einzelpositionen +
//        Rueckmeldungen + Kommentare + Aktivitaet + eigener Katalog +
//        Link auf die neueste 3D-Ansicht (Teilen-Link, src/lib/visualisierung-link).
// POST → { aktion: "bestaetigen", positionId }
//        { aktion: "alle_bestaetigen" }
//        { aktion: "review", positionId?, art: "empfehlung" | "problem", text, vorschlag? }
//          (vorschlag neue_position darf gruppe_id tragen: «zu Pos 02 empfohlen»)
//        { aktion: "kommentar", positionId?, reviewId?, body }
//
// Sicherheit: Zugriff NUR wenn eine job_lieferanten-Zeile den Auftrag der
// eigenen Firma zuweist UND die Anfrage gesendet ist (angefragt_at).
// Storniert/abgeschlossen: nur noch lesen (POST 409). Alles laeuft ueber
// den Admin-Client mit expliziten Selects — der Lieferant beruehrt nie
// jobs-RLS, Preise oder Dokumente.

import { NextRequest, NextResponse } from "next/server";
import {
  requireLieferantPortal, logTechnik, lieferantAuftrag, freitext, sperrGrund,
  technikAenderungenSeit, technikAntwortEmpfaenger, gruppeDesAuftrags,
} from "@/lib/technik-server";
import { notifyTechnikAntwort } from "@/lib/notification-service";
import {
  REVIEW_ART_LABEL, REVIEW_ARTEN, TECHNIK_BEZEICHNUNG_MAX, ganzeMenge, aenderungsBasis,
  type ReviewArt, type ReviewVorschlag,
} from "@/lib/technik";
import { logError } from "@/lib/log";
import { erstelleVisualisierungLink } from "@/lib/visualisierung-link";
import { neueste3d, type Visualisierung } from "@/lib/technik-3d";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fehler = (msg: string, status = 400) => NextResponse.json({ success: false, error: msg }, { status });

type Adresse = { address_street?: string | null; address_zip?: string | null; address_city?: string | null };
type Ein<T> = T | T[] | null;
interface JobZeile {
  id: string;
  title: string;
  job_number: number | null;
  start_date: string | null;
  end_date: string | null;
  guest_count: number | null;
  event_type: string | null;
  description: string | null;
  notes: string | null;
  external_address: string | null;
  project_lead_id: string | null;
  customer: Ein<{ name: string | null }>;
  location: Ein<Adresse & { name: string | null; customer: Ein<{ name: string | null }> }>;
  room: Ein<Adresse & { name: string | null }>;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const gate = await requireLieferantPortal();
  if (gate.error) return gate.error;
  const { admin, lieferantId, lieferantName } = gate;
  const { jobId } = await params;
  if (!UUID_RE.test(jobId)) return fehler("Ungültige ID");

  const zugriff = await lieferantAuftrag(admin, jobId, lieferantId);
  if (!zugriff.ok) return zugriff.antwort;
  const { auftrag } = zugriff;

  try {
    const [jobRes, anfRes, posRes, revRes, komRes, aktRes, katRes, terminRes, dreiDRes] = await Promise.all([
      // Alles zum Auftrag, was der Lieferant zur Einschaetzung braucht —
      // AUSSER Geld (keine Preise, Offerten, Rechnungen, Stunden, Dokumente).
      admin
        .from("jobs")
        .select(
          "id, title, job_number, start_date, end_date, guest_count, event_type, description, notes, external_address, project_lead_id, " +
          "customer:customers(name), " +
          "location:locations(name, address_street, address_zip, address_city, customer:customers(name)), " +
          "room:rooms(name, address_street, address_zip, address_city)",
        )
        .eq("id", jobId)
        .maybeSingle(),
      admin
        .from("job_anforderungen")
        .select("id, nummer, titel, text, zusammenhang, created_at, inhalt_geaendert_at")
        .eq("job_id", jobId)
        .order("nummer"),
      admin
        .from("job_technik_positionen")
        .select("id, gruppe_id, artikel_id, kategorie, bezeichnung, details, menge, status, quelle, bestaetigt_at, bestaetigt_by, created_at, inhalt_geaendert_at")
        .eq("job_id", jobId)
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
      admin.from("job_appointments").select("id, title, start_time, end_time").eq("job_id", jobId).order("start_time"),
      // 3D-Ansicht: HTML-Dokumente am Auftrag (Erkennung src/lib/technik-3d.ts).
      admin
        .from("documents")
        .select("id, name, folder, mime_type, created_at")
        .eq("job_id", jobId)
        .ilike("mime_type", "text/html%")
        .order("created_at", { ascending: false }),
    ]);
    const err = [jobRes, anfRes, posRes, revRes, komRes, aktRes, katRes, terminRes, dreiDRes].find((r) => r.error)?.error;
    if (err) throw err;
    const job = jobRes.data as unknown as JobZeile | null;
    if (!job) return fehler("Auftrag nicht gefunden", 404);
    const eins = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
    const loc = eins(job.location);
    const room = eins(job.room);
    const adresse = (o: { address_street?: string | null; address_zip?: string | null; address_city?: string | null } | null) =>
      o ? [o.address_street, [o.address_zip, o.address_city].filter(Boolean).join(" ")].filter(Boolean).join(", ") || null : null;
    const ort = loc
      ? { name: loc.name ?? null, adresse: adresse(loc) }
      : room
        ? { name: room.name ?? null, adresse: adresse(room) }
        : { name: null, adresse: (job.external_address ?? "").trim() || null };

    // Ansprechperson bei EVENTLINE: die Projektleitung (Name, Telefon, Mail).
    let ansprechperson: { name: string | null; telefon: string | null; email: string | null } | null = null;
    if (job.project_lead_id) {
      const { data: pl, error: plErr } = await admin
        .from("profiles").select("full_name, phone, email").eq("id", job.project_lead_id).maybeSingle();
      if (plErr) throw plErr;
      if (pl) ansprechperson = { name: pl.full_name ?? null, telefon: pl.phone ?? null, email: pl.email ?? null };
    }

    // Wer hat bestaetigt — der Lieferant selbst oder EVENTLINE?
    const positionen = (posRes.data ?? []) as {
      id: string; bestaetigt_by: string | null; [k: string]: unknown;
    }[];
    const bestaetigerIds = Array.from(new Set(positionen.map((p) => p.bestaetigt_by).filter((x): x is string => !!x)));
    const bestaetiger = new Map<string, { name: string | null; vonLieferant: boolean }>();
    if (bestaetigerIds.length) {
      const { data: pers, error: pErr } = await admin.from("profiles").select("id, full_name, lieferant_id").in("id", bestaetigerIds);
      if (pErr) throw pErr;
      for (const p of (pers ?? []) as { id: string; full_name: string | null; lieferant_id: string | null }[]) {
        bestaetiger.set(p.id, { name: p.full_name, vonLieferant: p.lieferant_id === lieferantId });
      }
    }

    // «Seit letzter Anfrage»: Bezug = vorherige Runde (ab Runde 2), sonst die
    // erste Anfrage. «Entfernt» nur, was der Lieferant gesehen hat — beim Bezug
    // oder in der laufenden Anfrage (nie gesehen = nie entfernt).
    const basis = aenderungsBasis(auftrag) ?? auftrag.angefragtAt;
    const aenderungen = await technikAenderungenSeit(admin, jobId, basis, auftrag.angefragtAt);

    // Neueste 3D-Ansicht als Teilen-Link (90 Tage, ohne Login — derselbe
    // Mechanismus wie «Link teilen» im Auftrag; Dokument loeschen = Link tot).
    const dreiD = neueste3d((dreiDRes.data ?? []) as Visualisierung[]);
    // Nur der Pfad: das Portal bettet ihn auf derselben Domain ein (CSP
    // frame-src 'self') — unabhaengig davon, auf welche Domain appUrl zeigt.
    const dreiDAnsicht = dreiD
      ? { url: new URL(erstelleVisualisierungLink(dreiD.id).url).pathname, name: dreiD.name, am: dreiD.created_at }
      : null;

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
        beschreibung: job.description,
        notizen: job.notes,
        kunde: eins(job.customer)?.name ?? eins(loc?.customer)?.name ?? null,
        ort,
        ansprechperson,
        termine: terminRes.data ?? [],
      },
      lieferant: lieferantName,
      gesperrt: auftrag.gesperrt,
      angefragtAt: auftrag.angefragtAt,
      runden: auftrag.runden,
      aenderungsBasis: basis,
      entferntSeitAnfrage: aenderungen.entfernt,
      gruppen: anfRes.data ?? [],
      dreiD: dreiDAnsicht,
      positionen: positionen.map(({ bestaetigt_by, ...p }) => {
        const b = bestaetigt_by ? bestaetiger.get(bestaetigt_by) : null;
        return { ...p, bestaetigt_von: b ? { name: b.name, vonLieferant: b.vonLieferant } : null };
      }),
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
  // Antworten gehen an die Projektleitung des Auftrags (sonst an alle mit
  // auftraege:edit) — nicht mehr an jeden Bearbeiter.
  const interne = () => technikAntwortEmpfaenger(admin, auftrag.job.projectLeadId, [userId]);

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
            // Zu welcher Positionsgruppe? Nur eine dieses Auftrags.
            let gruppeId: string | undefined;
            if (v.gruppe_id) {
              if (!UUID_RE.test(v.gruppe_id) || !(await gruppeDesAuftrags(admin, jobId, v.gruppe_id))) return fehler("Position nicht gefunden", 404);
              gruppeId = v.gruppe_id;
            }
            vorschlag = {
              typ: "neue_position",
              bezeichnung: name.wert,
              menge,
              kategorie: kat.wert ?? undefined,
              details: det.wert ?? undefined,
              artikel_id: v.artikel_id && UUID_RE.test(v.artikel_id) ? v.artikel_id : undefined,
              gruppe_id: gruppeId,
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
        // Kommentare haengen immer an einer Position oder Rueckmeldung —
        // allgemeine Kommentare zeigt keine Oberflaeche an.
        if (!b.positionId && !b.reviewId) return fehler("Kommentar braucht eine Position oder Rückmeldung");
        if (b.positionId) {
          if (!UUID_RE.test(b.positionId)) return fehler("Ungültige positionId");
          if (!(await positionDesAuftrags(b.positionId))) return fehler("Position nicht gefunden", 404);
        }
        if (b.reviewId) {
          if (!UUID_RE.test(b.reviewId)) return fehler("Ungültige reviewId");
          const { data: rev, error } = await admin
            .from("job_technik_reviews").select("id, status").eq("id", b.reviewId).eq("job_id", jobId).maybeSingle();
          if (error) throw error;
          if (!rev) return fehler("Rückmeldung nicht gefunden", 404);
          if (rev.status !== "offen") return fehler("Dieser Punkt ist bereits entschieden — bitte als Kommentar an der Position schreiben.", 409);
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
