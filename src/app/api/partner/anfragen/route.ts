// /api/partner/anfragen — «Meine Anfragen» des Partnerportals.
//
// GET  ?archiv=1&status=<status>&titel=<suche>
//      → die EIGENEN Anfragen des Standorts (src/lib/partner-anfrage.ts), mit
//        denselben Filtern wie bisher im Browser: Aktiv = offene Partner-Status
//        (immer) oder Veranstaltung heute/zukuenftig/ohne Datum; Archiv =
//        Datum vorbei. Sortierung Datum (Aktiv aufsteigend, Archiv absteigend),
//        hoechstens 100. Nur die angezeigten Felder plus Namen der
//        Verantwortlichen/Zugeteilten — nie interne Angaben, nie fremde Auftraege.
// POST { modus: "entwurf"|"senden", titel, beschreibung, start_date, end_date,
//        kontakt_person, kontakt_telefon, kontakt_email, antworten,
//        schema_snapshot, termin }
//      → legt die Anfrage am eigenen Standort an (Recht partner:anfragen:create)
//        und — falls angegeben — den ersten Termin. Zeitpunkte kommen aus dem
//        Browser mit Zeitzone (wie bisher der direkte Insert).

import { NextRequest, NextResponse } from "next/server";
import { requirePartnerPortal, partnerFehler, interneNamen } from "@/lib/partner-portal-server";
import {
  eigeneAnfrageFilter,
  istIsoZeitpunkt,
  terminPruefen,
  zugewieseneNamen,
  KURZTEXT_MAX,
  TEXT_MAX,
  PARTNER_OFFENE_STATUS,
} from "@/lib/partner-anfrage";
import { escapeLikeWildcards } from "@/lib/search-escape";
import { zuerichHeuteBeginnIso } from "@/lib/technik-server";
import { logError } from "@/lib/log";

const STATUS_FILTER = ["partner_entwurf", "partner_anfrage", "offen", "abgeschlossen", "storniert"];
const ANTWORTEN_MAX_ZEICHEN = 100_000;
const SCHEMA_MAX_ZEICHEN = 200_000;

interface ListenZeile {
  id: string;
  job_number: number | null;
  title: string;
  start_date: string | null;
  end_date: string | null;
  status: string;
  partner_response_message: string | null;
  project_lead_id: string | null;
}

export async function GET(req: NextRequest) {
  const gate = await requirePartnerPortal();
  if (gate.error) return gate.error;
  if (!gate.darfLesen) return partnerFehler("Kein Zugriff", 403);
  const { admin } = gate;

  const p = req.nextUrl.searchParams;
  const archiv = p.get("archiv") === "1";
  const status = p.get("status");
  const titel = (p.get("titel") ?? "").trim().slice(0, 200);

  try {
    // Beginn des heutigen Tages in Zuerich als Zeitpunkt (wie im Lieferanten-
    // portal) — ein Event von heute bleibt bis Mitternacht bei «Aktiv».
    const heute = zuerichHeuteBeginnIso();
    let q = admin
      .from("jobs")
      .select("id, job_number, title, start_date, end_date, status, partner_response_message, project_lead_id")
      .eq("location_id", gate.standortId)
      .not("is_deleted", "is", true);
    // Mehrere .or() verknuepft PostgREST mit UND (wie bisher im Browser).
    for (const f of eigeneAnfrageFilter(gate)) q = q.or(f);
    q = archiv
      ? q.not("start_date", "is", null).lt("start_date", heute)
      : q.or(`status.in.(${PARTNER_OFFENE_STATUS.join(",")}),start_date.is.null,start_date.gte."${heute}"`);
    if (status && STATUS_FILTER.includes(status)) q = q.eq("status", status);
    if (titel) q = q.ilike("title", `%${escapeLikeWildcards(titel)}%`);
    const { data, error } = await q.order("start_date", { ascending: !archiv, nullsFirst: false }).limit(100);
    if (error) throw error;
    const jobs = (data ?? []) as ListenZeile[];

    const ids = jobs.map((j) => j.id);
    const { data: termine, error: tErr } = ids.length
      ? await admin.from("job_appointments").select("job_id, assigned_to").in("job_id", ids).order("start_time").order("created_at")
      : { data: [], error: null };
    if (tErr) throw tErr;
    const zuteilungen = (termine ?? []) as { job_id: string; assigned_to: string | null }[];
    const namen = await interneNamen(admin, [...jobs.map((j) => j.project_lead_id), ...zuteilungen.map((t) => t.assigned_to)]);

    const anfragen = jobs.map((j) => ({
      id: j.id,
      job_number: j.job_number,
      title: j.title,
      start_date: j.start_date,
      end_date: j.end_date,
      status: j.status,
      partner_response_message: j.partner_response_message,
      verantwortlich: j.project_lead_id ? namen.get(j.project_lead_id) ?? null : null,
      zugewiesen: zugewieseneNamen(j.id, zuteilungen, namen),
    }));
    return NextResponse.json({ success: true, anfragen });
  } catch (e) {
    logError("api.partner.anfragen.liste", e);
    return partnerFehler("Anfragen konnten nicht geladen werden", 500);
  }
}

function kurztext(v: unknown): string | null | false {
  if (v == null) return null;
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (s.length > KURZTEXT_MAX) return false;
  return s || null;
}

function jsonObjekt(v: unknown, max: number): Record<string, unknown> | null | false {
  if (v == null) return null;
  if (typeof v !== "object" || Array.isArray(v)) return false;
  if (JSON.stringify(v).length > max) return false;
  return v as Record<string, unknown>;
}

export async function POST(req: NextRequest) {
  const gate = await requirePartnerPortal();
  if (gate.error) return gate.error;
  if (!gate.darf("partner:anfragen:create")) return partnerFehler("Keine Berechtigung, Anfragen zu erstellen", 403);
  const { admin } = gate;

  const b = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  if (b.modus !== "entwurf" && b.modus !== "senden") return partnerFehler("Ungültiger Modus", 400);
  const senden = b.modus === "senden";

  const titelRoh = kurztext(b.titel);
  const kontaktPerson = kurztext(b.kontakt_person);
  const kontaktTelefon = kurztext(b.kontakt_telefon);
  const kontaktEmail = kurztext(b.kontakt_email);
  if (titelRoh === false || kontaktPerson === false || kontaktTelefon === false || kontaktEmail === false) {
    return partnerFehler(`Eingabe ist zu lang (höchstens ${KURZTEXT_MAX} Zeichen)`, 400);
  }
  const beschreibung = typeof b.beschreibung === "string" ? b.beschreibung.trim() : "";
  if (beschreibung.length > TEXT_MAX) return partnerFehler("Beschreibung ist zu lang", 400);

  // Veranstaltungs-Zeitraum: der Browser schickt Zuercher Mitternacht mit
  // Zeitzone (toDbDate), wie bisher beim direkten Insert.
  if (!istIsoZeitpunkt(b.start_date)) return partnerFehler("Veranstaltungs-Startdatum fehlt", 400);
  const endDate = b.end_date == null || b.end_date === "" ? b.start_date : b.end_date;
  if (!istIsoZeitpunkt(endDate)) return partnerFehler("Ungültiges Veranstaltungs-Enddatum", 400);
  const plausibelAb = Date.parse("2020-01-01T00:00:00Z");
  if (Date.parse(b.start_date) < plausibelAb || Date.parse(endDate) < plausibelAb) {
    return partnerFehler("Datum scheint ungültig — bitte korrigieren", 400);
  }
  if (Date.parse(endDate) < Date.parse(b.start_date)) {
    return partnerFehler("Veranstaltungs-Enddatum muss am oder nach Startdatum liegen", 400);
  }

  const antworten = jsonObjekt(b.antworten, ANTWORTEN_MAX_ZEICHEN);
  if (antworten === false) return partnerFehler("Ungültige Formular-Antworten", 400);
  // Schema-Stand nur beim Absenden (Entwuerfe holen beim spaeteren Absenden
  // den dann aktuellen Stand) — wie bisher.
  const snapshot = senden ? jsonObjekt(b.schema_snapshot, SCHEMA_MAX_ZEICHEN) : null;
  if (snapshot === false || (snapshot && !Array.isArray((snapshot as { blocks?: unknown }).blocks))) {
    return partnerFehler("Ungültiger Formular-Stand", 400);
  }

  const titel = titelRoh || "Ohne Titel";
  let termin: ReturnType<typeof terminPruefen> | null = null;
  if (b.termin != null) {
    const t = b.termin as Record<string, unknown>;
    termin = terminPruefen(
      { titel, start: t.start, ende: t.ende, beschreibung: null, zeit_modus: t.zeit_modus ?? "fix" },
      { start_date: b.start_date, end_date: endDate },
    );
    if (!termin.ok) return partnerFehler(termin.fehler, 400);
    if (termin.termin.ende && Date.parse(termin.termin.ende) <= Date.parse(termin.termin.start)) {
      return partnerFehler("Termin-Endzeit muss nach der Startzeit liegen", 400);
    }
  }

  try {
    const { data: neu, error } = await admin
      .from("jobs")
      .insert({
        title: titel,
        description: beschreibung || null,
        start_date: b.start_date,
        end_date: endDate,
        status: senden ? "partner_anfrage" : "partner_entwurf",
        location_id: gate.standortId,
        contact_person: kontaktPerson,
        contact_phone: kontaktTelefon,
        contact_email: kontaktEmail,
        created_by: gate.userId,
        form_answers: antworten && Object.keys(antworten).length > 0 ? antworten : null,
        form_schema_snapshot: snapshot,
      })
      .select("id")
      .single();
    if (error || !neu) throw error ?? new Error("Anfrage ohne ID");

    let warnung: string | undefined;
    if (termin?.ok) {
      const { error: tErr } = await admin.from("job_appointments").insert({
        job_id: neu.id,
        title: termin.termin.titel,
        start_time: termin.termin.start,
        end_time: termin.termin.ende,
        description: null,
        zeit_modus: termin.termin.zeitModus,
      });
      if (tErr) {
        logError("api.partner.anfragen.anlegen.termin", tErr, { jobId: neu.id });
        warnung = "Anfrage erstellt, aber Termin konnte nicht angelegt werden — bitte auf Detail-Seite manuell hinzufügen";
      }
    }
    return NextResponse.json({ success: true, id: neu.id as string, ...(warnung ? { warnung } : {}) });
  } catch (e) {
    logError("api.partner.anfragen.anlegen", e);
    return partnerFehler("Anfrage konnte nicht erstellt werden", 500);
  }
}
